// Calibration Management System, mobile app: the device side of Mobile Devices > Check Out to Mobile.
// Open a check-out file, log in with a Mobile PIN, browse the tools, calibrate
// them (or add custom entries), and send the results back to the desktop.
//
// - The file is kept on the phone still locked. After the PIN, the inspector
//   stays logged in until midnight; Lock, Switch User, midnight or the file
//   expiring asks for the PIN again.
// - Every entry is saved on the phone the moment it's saved (locked with the
//   file's key), so a refresh, Lock or flat battery never loses work.
// - Send Results always carries every entry so far; the desktop adds each one
//   once, so a lost email can just be sent again. Sent entries can't be
//   changed here (corrections are made at the desktop).
"use strict";

(() => {
  const STORE_FILE = "calcheck.file";        // the locked file, as emailed
  const STORE_USER = "calcheck.lastUser";    // the name picked last time
  const STORE_TRIES = "calcheck.tries";      // wrong PINs in a row, and when
  const STORE_WORK = "calcheck.work";        // the entries made here (locked)
  const STORE_WORK_INFO = "calcheck.workInfo";   // just {session, total, unsent}: readable before the PIN
  const FREE_TRIES = 5, WAIT_SECONDS = 60;
  const APP_VERSION = "a7";                  // (shown on the login screen; the same as VERSION in sw.js)
  const STATUSES = ["Active", "Reference Only", "Damaged", "Removed from Service"];

  const app = document.getElementById("app");
  const state = { header: null, data: null, user: null, key: null, until: 0, work: null, expired: false,
                  tab: "due", search: "", category: "", formHash: null, formDirty: false };

  // ---------- storage (private mode or a full phone can refuse it) ----------
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function save(key, value) { try { localStorage.setItem(key, value); return true; } catch (e) { return false; } }
  function forget(key) { try { localStorage.removeItem(key); } catch (e) { /* nothing kept */ } }

  // ---------- building the screen (text is always set as text, never as HTML) ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "value") el.value = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const ICONS = {
    tool: ["M4 20L14 10", "M14 4v6h6", "M10 4h4M20 10v4"],
    file: ["M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z", "M14 3v5h5"],
    search: ["M20 20l-3.5-3.5", "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14"],
    back: ["M19 12H5M11 6l-6 6 6 6"],
    chev: ["M9 6l6 6-6 6"],
    clock: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M12 7v5l3 2"],
    done: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M8 12.5l2.5 2.5L16 9.5"],
    grid: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
    mail: ["M3 5h18v14H3z", "M3 7l9 6 9-6"],
  };
  function icon(name, size = 22) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
                                          "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }))
      svg.setAttribute(k, v);
    for (const d of ICONS[name]) {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      svg.append(p);
    }
    return svg;
  }

  function show(...children) {
    app.replaceChildren(...children);
    window.scrollTo(0, 0);
  }

  function toast(text) {
    const t = h("div", { class: "toast", role: "status" }, text);
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  function plural(n, word, many = word + "s") {
    return `${n} ${n === 1 ? word : many}`;
  }

  function localDay(isoMoment) {
    const d = new Date(isoMoment);
    return isNaN(d) ? "" : Dates.display(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }

  function timeText(isoMoment) {
    const d = new Date(isoMoment);
    return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function nowIso() {
    return new Date().toISOString().replace(/\.\d+Z$/, "Z");
  }

  // ---------- the work done on this device ----------
  function workInfo() {
    try { return JSON.parse(load(STORE_WORK_INFO) || "null"); } catch (e) { return null; }
  }

  // Unsent entries kept for a session (readable without the PIN: counts only)
  function unsentFor(session) {
    const info = workInfo();
    return info && info.session === session ? info.unsent : 0;
  }

  async function loadWork() {
    const text = load(STORE_WORK);
    state.work = { entries: [], sends: [] };
    if (!text) return;
    try {
      state.work = await CalCheck.unlockWork(state.key, state.header.session, text);
    } catch (e) {
      // From an older file whose results were all sent (a file with unsent
      // results can't be replaced): start afresh
    }
  }

  async function saveWork() {
    const unsent = state.work.entries.filter(e => !e.sent_at).length;
    const text = await CalCheck.lockWork(state.key, state.header.session, state.work);
    const ok = save(STORE_WORK, text) &&
      save(STORE_WORK_INFO, JSON.stringify({ session: state.header.session, total: state.work.entries.length, unsent }));
    if (!ok) alert("The device wouldn't save this (is it full?). Free some space and save again.");
    return ok;
  }

  function entriesFor(toolId) {
    return state.work.entries.filter(e => e.tool_id === toolId)
      .sort((a, b) => b.date.localeCompare(a.date) || b.saved_at.localeCompare(a.saved_at));
  }

  // A tool as it stands with this device's entries: the newest entry decides
  // its due date (as on the desktop), a custom entry can change its status
  function current(tool) {
    const mine = entriesFor(tool.tool_id);
    const latest = mine.find(e => !tool.last_date || e.date >= tool.last_date);
    const statusEntry = state.work.entries.filter(e => e.tool_id === tool.tool_id && e.kind === "custom")
      .sort((a, b) => b.saved_at.localeCompare(a.saved_at))[0];
    return {
      ...tool,
      due_date: latest ? latest.due_date : tool.due_date,
      last_date: latest ? latest.date : tool.last_date,
      status: statusEntry ? statusEntry.status : tool.status,
      done: mine.length > 0,
    };
  }

  function canChange(entry) {
    return !entry.sent_at && entry.by === state.user.username && !state.expired;
  }

  function entryResult(e) {
    if (e.kind === "custom") return "Entry";
    return e.ranges.some(r => r.result === "fail") ? "Fail" : "Pass";
  }

  // ---------- opening the file and logging in ----------
  function storedHeader() {
    const text = load(STORE_FILE);
    if (!text) return null;
    try { return CalCheck.readHeader(text); } catch (e) { forget(STORE_FILE); return null; }
  }

  function removeFile() {
    forget(STORE_FILE);
    forget(STORE_TRIES);
    forget(STORE_WORK);
    forget(STORE_WORK_INFO);
    lock();
  }

  function confirmRemove(header) {
    const unsent = unsentFor(header.session);
    return confirm(unsent
      ? `${plural(unsent, "result")} on this device haven't been sent and will be lost.\n\nRemove the file and the results anyway?`
      : "Remove the check-out file (and the results already sent) from this device?");
  }

  // ---------- staying logged in until midnight ----------
  // The file's key is kept in the browser's own database as a key the
  // browser can use but never hand out, with who unlocked it and until when.
  function idb(mode, work) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("calcheck", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("login");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("login", mode);
        const request = work(tx.objectStore("login"));
        tx.oncomplete = () => { db.close(); resolve(request.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }

  function midnightTonight() {
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  function rememberLogin() {
    return idb("readwrite", s => s.put({ key: state.key, session: state.header.session, username: state.user.username,
                                         until: state.until }, "current")).catch(() => { /* asks for the PIN next time */ });
  }

  function forgetLogin() {
    return idb("readwrite", s => s.delete("current")).catch(() => { /* nothing kept */ });
  }

  // Logs back in without the PIN if this file was unlocked earlier today.
  async function resumeLogin(header) {
    let saved;
    try { saved = await idb("readonly", s => s.get("current")); } catch (e) { return false; }
    const user = saved && header.inspectors.find(i => i.username === saved.username);
    if (!user || saved.session !== header.session || Date.now() >= saved.until) {
      if (saved) forgetLogin();
      return false;
    }
    try { state.data = await CalCheck.reopen(header, saved.key); } catch (e) { forgetLogin(); return false; }
    Object.assign(state, { header, user, key: saved.key, until: saved.until });
    await loadWork();
    return true;
  }

  function loggedInTooLong() {
    return state.data && Date.now() >= state.until;
  }

  function waitLeft() {
    let tries;
    try { tries = JSON.parse(load(STORE_TRIES) || "null"); } catch (e) { tries = null; }
    if (!tries || tries.count < FREE_TRIES) return 0;
    return Math.max(0, Math.ceil((tries.at + WAIT_SECONDS * 1000 - Date.now()) / 1000));
  }

  function wrongPin() {
    let tries;
    try { tries = JSON.parse(load(STORE_TRIES) || "null"); } catch (e) { tries = null; }
    const count = (tries ? tries.count : 0) + 1;
    save(STORE_TRIES, JSON.stringify({ count, at: Date.now() }));
  }

  function chooseFile(after) {
    const input = h("input", { type: "file", class: "hidden-input", "aria-hidden": "true", tabindex: "-1" });
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) return;
      file.text().then(text => {
        try {
          const header = CalCheck.readHeader(text);
          const old = storedHeader();
          if (old && old.session !== header.session && unsentFor(old.session))
            throw new Error(`${plural(unsentFor(old.session), "result")} from the file on this device haven't been sent. ` +
                            "Log in and use Send Results first (or remove that file to throw them away).");
          if (CalCheck.isExpired(header)) throw new Error(`That file expired on ${Dates.displayMoment(header.expires)}. Ask for a new one.`);
          if (!save(STORE_FILE, text)) throw new Error("The device wouldn't keep the file (is it in private browsing, or full?).");
          forget(STORE_TRIES);
          forgetLogin();
          after(null);
        } catch (e) {
          after(e.message);
        }
      }, () => after("The file couldn't be read."));
    });
    document.body.append(input);
    input.click();
    setTimeout(() => input.remove(), 60000);
  }

  // The blue band on the open and login screens: the app's white caliper on
  // the left, its name stacked on the right (as on the desktop's login)
  function brandHero(subtitle) {
    return h("div", { class: "hero" },
      h("div", { class: "brand" },
        h("img", { src: "mobile-logo.png", alt: "", class: "brand-logo" }),
        h("h1", { class: "brand-name" }, h("span", {}, "Calibration"), h("span", {}, "Management"), h("span", {}, "System"))),
      subtitle ? h("p", {}, subtitle) : null);
  }

  function versionLine() {
    return h("p", { class: "version" }, `Version ${APP_VERSION}`);
  }

  function openScreen(problem) {
    const header = storedHeader();
    if (header && CalCheck.isExpired(header) && !unsentFor(header.session)) {
      removeFile();
      return openScreen(`The check-out file expired on ${Dates.displayMoment(header.expires)} and was removed from this device. Ask for a new one.`);
    }
    if (header) return loginScreen(header, problem);

    show(h("div", { class: "screen" },
      brandHero("Works offline · nothing is kept until you open a check-out file"),
      h("div", { class: "panel" },
        h("h2", {}, "Open the check-out file you were emailed"),
        h("p", { class: "small" }, "Save the email's attachment to your device (Files or Downloads) first, then pick it here."),
        h("button", { class: "pick-file", onclick: () => chooseFile(openScreen) }, icon("file", 20), "Choose File"),
        problem && h("div", { class: "note bad", role: "alert" }, problem)),
      versionLine()));
  }

  function loginScreen(header, problem) {
    const last = load(STORE_USER);
    const expired = CalCheck.isExpired(header);
    const unsent = unsentFor(header.session);
    const select = h("select", { id: "who" },
      header.inspectors.length > 1 && h("option", { value: "" }, "Choose your name"),
      header.inspectors.map(i => h("option", { value: i.username, selected: i.username === last }, i.name)));
    const pin = h("input", { id: "pin", type: "password", inputmode: "numeric", autocomplete: "off", pattern: "[0-9]*", maxlength: "12" });
    const message = h("div", { role: "alert" });
    const go = h("button", { class: "btn", type: "submit" }, "Unlock");

    function say(text) {
      message.replaceChildren(text ? h("div", { class: "note bad" }, text) : "");
    }
    say(problem);

    const form = h("form", { class: "panel", onsubmit: async e => {
      e.preventDefault();
      const wait = waitLeft();
      if (wait) return say(`Too many wrong PINs. Try again in ${wait} seconds.`);
      if (!select.value) return say("Choose your name first.");
      if (!pin.value) return say("Enter your Mobile PIN.");
      go.disabled = true;
      go.textContent = "Unlocking...";
      try {
        const { data, key } = await CalCheck.unlock(header, select.value, pin.value);
        forget(STORE_TRIES);
        save(STORE_USER, select.value);
        Object.assign(state, { header, data, key, until: midnightTonight(),
                               user: header.inspectors.find(i => i.username === select.value) });
        await loadWork();
        await rememberLogin();
        if (!location.hash.startsWith("#/")) location.hash = "#/due";
        route();
      } catch (err) {
        if (err.message === "Wrong PIN.") wrongPin();
        pin.value = "";
        say(err.message);
        go.disabled = false;
        go.textContent = "Unlock";
      }
    } },
      expired
        ? h("div", { class: "note bad" },
            h("b", {}, "This check-out file has expired"),
            h("span", {}, `${plural(unsent, "result")} on this device haven't been sent. Log in and use Send Results.`))
        : h("div", { class: "note ok" },
            h("b", {}, "Check-out file on this device"),
            h("span", {}, `${plural(header.tool_count, "tool")} · checked out by ${header.checked_out_by}`),
            h("span", { class: "small" }, `Expires ${Dates.displayMoment(header.expires)} · ${header.session}`),
            unsent ? h("span", { class: "small" }, `${plural(unsent, "result")} not sent yet`) : null),
      h("label", { class: "field", for: "who" }, "Your name", select),
      h("label", { class: "field", for: "pin" }, "Mobile PIN", pin),
      message,
      go,
      h("button", { type: "button", class: "link-btn", onclick: () => chooseFile(err => err ? say(err) : openScreen()) },
        "Open a different file"),
      h("button", { type: "button", class: "link-btn danger", onclick: () => {
        if (confirmRemove(header)) { removeFile(); openScreen(); }
      } }, "Remove the file from this device"));

    show(h("div", { class: "screen" },
      brandHero("Log in with your Mobile PIN"),
      form,
      versionLine()));
    (select.value ? pin : select).focus();
  }

  function lock() {
    forgetLogin();
    Object.assign(state, { header: null, data: null, user: null, key: null, work: null, until: 0, expired: false,
                           search: "", category: "", formHash: null, formDirty: false });
  }

  function lockAndLeave(switching) {
    if (switching) forget(STORE_USER);           // (the next person picks their own name)
    lock();
    history.replaceState(null, "", location.pathname);
    openScreen();
  }

  // ---------- the tools ----------
  function rules() {
    return state.data.due_rules || { overdue_after: 14, due_soon: 14 };
  }

  function matches(tool) {
    const text = state.search.trim().toLowerCase();
    return !text || tool.tool_id.toLowerCase().includes(text) || tool.name.toLowerCase().includes(text);
  }

  function go(hash) {
    location.hash = hash;
  }

  function toolRow(tool, side) {
    const sev = Dates.severity(tool.due_date, rules());
    return h("button", { class: "row", onclick: () => go(`#/tool/${encodeURIComponent(tool.tool_id)}`) },
      h("span", { class: `dot ${sev}`, "aria-label": sev === "none" ? "No due date" : `${sev} dot` }),
      h("span", { class: "row-main" }, h("span", { class: "row-id" }, tool.tool_id), h("span", { class: "row-name" }, tool.name)),
      h("span", { class: "row-side" }, side),
      h("span", { class: "chev" }, icon("chev", 16)));
  }

  function sessionStrip() {
    const entries = state.work.entries;
    const unsent = entries.filter(e => !e.sent_at).length;
    return [
      h("div", { class: "session" },
        h("span", {}, h("b", {}, state.user.name),
          state.expired ? " · file expired: send your results" : ` · expires ${Dates.displayMoment(state.header.expires)}`),
        h("button", { onclick: () => lockAndLeave(true) }, "Switch User"),
        h("button", { onclick: () => lockAndLeave(false) }, "Lock")),
      entries.length ? h("button", { class: "send-strip", onclick: () => go("#/send") },
        h("span", {}, `${plural(entries.length, "entry", "entries")} on this device`,
          unsent ? h("b", { class: "unsent" }, ` · ${unsent} not sent`) : " · all sent"),
        h("span", { class: "send-link" }, "Send Results", icon("chev", 14))) : null,
    ];
  }

  function searchBox(placeholder, refill) {
    const input = h("input", { type: "search", placeholder, "aria-label": "Search", value: state.search });
    input.addEventListener("input", () => { state.search = input.value; refill(); });
    return h("label", { class: "search" }, icon("search", 18), input);
  }

  function tabBar() {
    const tab = (name, label, iconName) => h("button", {
      class: "tab", "aria-current": state.tab === name ? "page" : null,
      onclick: () => go(`#/${name}`) }, icon(iconName), label);
    return h("nav", { class: "tabs", "aria-label": "Tabs" },
      tab("due", "Due", "clock"), tab("completed", "Completed", "done"), tab("all", "All", "grid"));
  }

  function dueScreen() {
    const list = h("main", { class: "list" });
    const chips = h("div", { class: "chips" });
    const due = state.data.tools.map(current)
      .filter(t => ["red", "yellow"].includes(Dates.severity(t.due_date, rules())))
      .sort((a, b) => a.due_date.localeCompare(b.due_date));

    function fill() {
      const shown = due.filter(matches);
      const count = sev => shown.filter(t => Dates.severity(t.due_date, rules()) === sev).length;
      chips.replaceChildren(
        h("span", { class: "chip red" }, Dates.overdueCountText(count("red"), rules())),
        h("span", { class: "chip yellow" }, Dates.dueSoonCountText(count("yellow"), rules())));
      list.replaceChildren(...shown.map(t => {
        const sev = Dates.severity(t.due_date, rules());
        return toolRow(t, [h("b", { class: sev }, Dates.whenText(t.due_date)), `Due ${Dates.display(t.due_date)}`]);
      }));
      if (!shown.length) list.append(h("p", { class: "empty" }, state.search ? "No tools match your search" : "Nothing in this file is due or overdue"));
    }
    fill();
    show(h("div", { class: "screen" },
      h("header", { class: "bar" }, h("div", { class: "bar-row" }, h("h1", {}, "Calibrations Due")),
        searchBox("Search tool ID or description", fill)),
      sessionStrip(), chips, list, tabBar()));
  }

  function allScreen() {
    const list = h("main", { class: "list" });
    const tools = state.data.tools.map(current);
    const present = new Set(tools.map(t => t.category));
    const categories = (state.data.categories || []).filter(c => present.has(c));
    for (const c of present) if (!categories.includes(c)) categories.push(c);
    const filters = h("div", { class: "chips" });

    function fill() {
      filters.replaceChildren(...["", ...categories].map(c => h("button", {
        class: "filter", "aria-pressed": state.category === c ? "true" : "false",
        onclick: () => { state.category = c; fill(); } }, c || "All")));
      list.replaceChildren();
      for (const c of categories) {
        if (state.category && state.category !== c) continue;
        const shown = tools.filter(t => t.category === c && matches(t))
          .sort((a, b) => a.tool_id.localeCompare(b.tool_id, undefined, { numeric: true }));
        if (!shown.length) continue;
        list.append(h("h2", { class: "group" }, `${c || "No category"} · ${shown.length}`),
                    ...shown.map(t => toolRow(t, [t.done ? h("b", { class: "done-mark" }, "Done") : null, t.status])));
      }
      if (!list.children.length) list.append(h("p", { class: "empty" }, "No tools match your search"));
    }
    fill();
    show(h("div", { class: "screen" },
      h("header", { class: "bar" }, h("div", { class: "bar-row" }, h("h1", {}, "All Tools")),
        searchBox(`Search the ${state.data.tools.length} checked-out tools`, fill)),
      sessionStrip(), filters, list, tabBar()));
  }

  function entryLine(e, { withTool = false } = {}) {
    const tool = state.data.tools.find(t => t.tool_id === e.tool_id) || { name: "" };
    const result = entryResult(e);
    const what = e.kind === "custom" ? e.note.split("\n")[0] : plural(e.ranges.length, "range");
    return h("button", { class: "entry-row", onclick: () => go(`#/entry/${e.id}`) },
      h("span", { class: "entry-top" },
        h("span", { class: "row-id" }, withTool ? e.tool_id : Dates.display(e.date)),
        h("span", { class: `result ${result}` }, result)),
      h("span", { class: "row-name" }, withTool ? (e.kind === "custom" ? `${tool.name} – ${what}` : tool.name) : what),
      h("span", { class: "small" },
        [withTool ? Dates.display(e.date) : null, `${e.by_name} at ${timeText(e.saved_at)}`].filter(Boolean).join(" · "),
        e.sent_at ? h("span", { class: "tag sent" }, "Sent") : h("span", { class: "tag unsent" }, "Not sent")));
  }

  function completedScreen() {
    const list = h("main", { class: "list" });
    const summary = h("p", { class: "summary" });
    const all = [...state.work.entries].sort((a, b) => b.saved_at.localeCompare(a.saved_at));

    function fill() {
      const text = state.search.trim().toLowerCase();
      const shown = all.filter(e => !text || e.tool_id.toLowerCase().includes(text) || e.by_name.toLowerCase().includes(text) ||
                                    (state.data.tools.find(t => t.tool_id === e.tool_id) || { name: "" }).name.toLowerCase().includes(text));
      const failed = all.filter(e => entryResult(e) === "Fail").length;
      const unsent = all.filter(e => !e.sent_at).length;
      summary.replaceChildren(`On this device · ${plural(all.length, "entry", "entries")}`,
        failed ? h("span", { class: "fail-text" }, ` · ${failed} failed`) : "",
        unsent ? ` · ${unsent} not sent` : (all.length ? " · all sent" : ""));
      list.replaceChildren(...shown.map(e => entryLine(e, { withTool: true })));
      if (!shown.length) list.append(h("p", { class: "empty" }, all.length ? "No entries match your search" : "Nothing calibrated on this device yet"));
    }
    fill();
    show(h("div", { class: "screen" },
      h("header", { class: "bar" }, h("div", { class: "bar-row" }, h("h1", {}, "Completed")),
        searchBox("Search tool or inspector", fill)),
      sessionStrip(), summary, list, tabBar()));
  }

  function backButton(fallback) {
    return h("button", { class: "icon-btn plain", "aria-label": "Back", onclick: () => {
      if (history.length > 1) history.back(); else go(fallback);
    } }, icon("back"));
  }

  function toolScreen(toolId) {
    const original = state.data.tools.find(t => t.tool_id === toolId);
    if (!original) { go("#/due"); return; }
    const tool = current(original);
    const sev = Dates.severity(tool.due_date, rules());
    const fact = (label, value) => value ? h("div", { class: "fact" }, h("span", {}, label), h("span", {}, value)) : null;
    const mine = entriesFor(toolId);
    const message = h("div", { role: "alert" });

    show(h("div", { class: "screen" },
      h("header", { class: "bar" },
        backButton(`#/${state.tab}`),
        h("div", { class: "tool-head" },
          h("div", { class: "bar-row" }, h("h1", {}, tool.tool_id), h("span", { class: "badge" }, tool.status)),
          h("p", {}, tool.name))),
      h("main", { class: "body with-actions" },
        message,
        h("section", { class: `due-card ${sev}` }, h("span", { class: `dot ${sev}` }),
          tool.due_date ? h("span", {}, h("b", {}, `Due ${Dates.display(tool.due_date)}`), ` · ${Dates.whenText(tool.due_date).replace(/^Due /, "")}`)
                        : h("span", {}, "No due date")),
        mine.length ? [h("h2", {}, "On this device"), h("section", { class: "card entries" }, mine.map(e => entryLine(e)))] : null,
        h("section", { class: "card facts" },
          fact("Location / Technician", tool.location),
          fact("Interval", tool.interval),
          fact("Manufacturer / Model", [tool.manufacturer, tool.model].filter(Boolean).join(" ")),
          fact("Serial", tool.serial),
          fact("Acceptable Deviation", tool.deviation),
          fact("Parameter", tool.parameter),
          fact("Category", tool.category),
          fact("Last calibrated", Dates.display(tool.last_date))),
        h("h2", {}, "Ranges"),
        h("section", { class: "card" }, tool.ranges.length
          ? tool.ranges.map((r, i) => h("div", { class: "line" },
              h("span", { class: "line-main" }, h("span", {}, r.range || `Range ${i + 1}`), h("span", {}, r.standard ? `Standard: ${r.standard}` : "No standard set"))))
          : h("p", { class: "empty" }, "No ranges set up for this tool")),
        h("h2", {}, "Calibration history"),
        h("section", { class: "card" }, tool.history.length
          ? tool.history.map(e => h("div", { class: "line" },
              h("span", { class: "line-main" },
                h("span", {}, Dates.display(e.date)),
                h("span", {}, [e.kind === "custom" ? e.remarks || "Custom entry" : plural(e.ranges, "range"), e.by, e.cal_id].filter(Boolean).join(" · "))),
              h("span", { class: `result ${e.result}` }, e.result)))
          : h("p", { class: "empty" }, "Not calibrated yet"))),
      state.expired ? null : h("div", { class: "actions" },
        h("button", { class: "btn secondary", onclick: () => go(`#/custom/${encodeURIComponent(toolId)}`) }, "Custom Entry"),
        h("button", { class: "btn", onclick: () => {
          if (!tool.ranges.length) {
            message.replaceChildren(h("div", { class: "note bad" }, "This tool has no ranges set up, so it can't be calibrated here. Use Custom Entry, or set up its ranges at the desktop."));
            return window.scrollTo(0, 0);
          }
          go(`#/cal/${encodeURIComponent(toolId)}`);
        } }, "Calibrate"))));
  }

  // ---------- Calibrate and Custom Entry (new, or changing one not sent yet) ----------
  function startForm() {
    state.formHash = location.hash;
    state.formDirty = false;
  }

  function formHeader(title, subtitle) {
    return h("header", { class: "bar compact" },
      h("div", { class: "bar-row" },
        h("button", { class: "icon-btn plain", "aria-label": "Back", onclick: () => history.back() }, icon("back")),
        h("div", { class: "form-title" }, h("h1", {}, title), h("span", {}, subtitle))));
  }

  function dateField(label, value, { optional = false } = {}) {
    const input = h("input", { type: "date", value: value || "" });
    const field = h("label", { class: "field" }, label, input);
    if (optional) {
      const clear = h("button", { type: "button", class: "link-btn small-link", onclick: () => {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } }, "No due date");
      field.append(clear);
    }
    return { field, input };
  }

  function formError(box, text) {
    box.replaceChildren(h("div", { class: "note bad" }, text));
    box.scrollIntoView({ block: "center" });
  }

  async function storeEntry(entry, existing) {
    if (existing) Object.assign(existing, entry);
    else state.work.entries.push(entry);
    if (!await saveWork()) return false;
    state.formHash = null;
    state.formDirty = false;
    return true;
  }

  async function deleteEntry(entry) {
    if (!confirm("Delete this entry from this device?")) return;
    state.work.entries = state.work.entries.filter(e => e !== entry);
    if (await saveWork()) {
      state.formHash = null;
      state.formDirty = false;
      toast("Entry deleted");
      history.back();
    }
  }

  function calibrateScreen(original, entry) {
    const tool = current(original);
    const deviation = Rules.parseDeviation(tool.deviation);
    const rows = entry ? entry.ranges.map(r => ({ ...r }))
      : tool.ranges.map(r => ({ range: r.range, standard: r.standard, as_found: "", after_adj: "N/A", result: "none",
                                remarks: (tool.default_remarks || "").trim() }));
    const startDate = entry ? entry.date : Rules.today();
    const date = dateField("Date", startDate);
    const due = dateField("Next due", entry ? entry.due_date : Rules.dueFromInterval(startDate, tool.interval),
                          { optional: Rules.intervalIsNever(tool.interval) });
    const errors = h("div", { role: "alert" });
    let unlocked = false;

    // The due date follows the date (date + the tool's interval) unless it's been changed by hand
    let following = Rules.dueFromInterval(date.input.value, tool.interval) || null;
    date.input.addEventListener("input", () => {
      if (!Rules.parseIso(date.input.value) || following === null) return;
      if (due.input.value !== following) { following = null; return; }
      following = Rules.dueFromInterval(date.input.value, tool.interval);
      due.input.value = following;
    });

    const cards = rows.map((row, i) => {
      const saved = { as_found: row.as_found, after_adj: row.after_adj };
      const auto = { byHand: ["pass", "fail"].includes(row.result), value: null };
      const numeric = Rules.parseMeasurement(row.range) !== null;
      const rangeIn = h("input", { type: "text", value: row.range, "aria-label": "Range", disabled: true, class: "locked" });
      const stdIn = h("input", { type: "text", value: row.standard, "aria-label": "Standard used", disabled: true, class: "locked" });
      const found = h("input", { type: "text", inputmode: numeric ? "decimal" : "text", value: row.as_found, autocomplete: "off" });
      const adj = h("input", { type: "text", inputmode: numeric ? "decimal" : "text", value: row.after_adj, autocomplete: "off" });
      const remarks = h("input", { type: "text", value: row.remarks, autocomplete: "off" });
      const outNote = h("p", { class: "out-note" }, `Outside the Acceptable Deviation (${tool.deviation})`);
      const pass = h("button", { type: "button", class: "toggle pass" }, "Pass");
      const fail = h("button", { type: "button", class: "toggle fail" }, "Fail");

      function showResult() {
        pass.setAttribute("aria-pressed", String(row.result === "pass"));
        fail.setAttribute("aria-pressed", String(row.result === "fail"));
      }

      function setResult(value) {
        row.result = value;
        remarks.value = Rules.remarksForResult(remarks.value, { pass: "Pass", fail: "Fail" }[value] || "");
        showResult();
      }

      function choose(value) {
        auto.byHand = true;
        setResult(row.result === value ? "none" : value);
      }

      // Pass / Fail chosen from the readings until someone picks one themselves: the After Adj.
      // reading when there is one (adjusted back into tolerance = Pass), else the As Found
      function autoResult() {
        if (auto.byHand) return;
        const verdict = Rules.calibrationResult(rangeIn.value, found.value, adj.value, deviation);
        if (verdict === null) {
          if (auto.value && row.result === auto.value) setResult("none");
          auto.value = null;
          return;
        }
        if (row.result !== verdict) setResult(verdict);
        auto.value = verdict;
      }

      function checkTolerance() {
        const out = [found, adj].map(box => {
          const bad = Rules.outOfTolerance(rangeIn.value, box.value, deviation);
          box.classList.toggle("out", bad);
          return bad;
        });
        outNote.hidden = !out.some(Boolean);
      }

      pass.addEventListener("click", () => choose("pass"));
      fail.addEventListener("click", () => choose("fail"));
      found.addEventListener("input", () => { autoResult(); checkTolerance(); });
      adj.addEventListener("input", () => { autoResult(); checkTolerance(); });
      rangeIn.addEventListener("input", () => { autoResult(); checkTolerance(); });
      for (const [box, key] of [[found, "as_found"], [adj, "after_adj"]])     // 1.000 -> 1.000" (typed now only)
        box.addEventListener("blur", () => { if (box.value !== saved[key]) box.value = Rules.addInchMark(box.value, rangeIn.value); });
      showResult();
      checkTolerance();

      const card = h("section", { class: "card range-card" },
        h("div", { class: "range-head" }, h("label", { class: "field compact" }, "Range", rangeIn),
          h("label", { class: "field compact" }, "Standard used", stdIn)),
        h("div", { class: "pair" }, h("label", { class: "field" }, "As Found", found), h("label", { class: "field" }, "After Adj.", adj)),
        outNote,
        h("div", { class: "pair", role: "group", "aria-label": `Result for ${row.range || `range ${i + 1}`}` }, pass, fail),
        h("label", { class: "field" }, "Remarks", remarks));
      return { row, card, rangeIn, stdIn, found, adj, remarks, saved, choose };
    });

    function unlockRanges() {
      unlocked = true;
      for (const c of cards) for (const box of [c.rangeIn, c.stdIn]) { box.disabled = false; box.classList.remove("locked"); }
      editRanges.disabled = true;
      cards[0].rangeIn.focus();
    }
    const editRanges = h("button", { type: "button", class: "btn secondary slim", onclick: unlockRanges }, "Edit Range / Standard");
    const allPass = cards.length > 1 ? h("button", { type: "button", class: "btn secondary slim", onclick: () => {
      for (const c of cards) if (c.row.result !== "pass") c.choose("pass");
    } }, "✓ All Pass") : null;

    async function saveCalibration() {
      errors.replaceChildren();
      for (const c of cards)
        for (const [box, key] of [[c.found, "as_found"], [c.adj, "after_adj"]])
          if (box.value !== c.saved[key]) box.value = Rules.addInchMark(box.value, c.rangeIn.value);
      if (!Rules.parseIso(date.input.value)) return formError(errors, "Enter the date of the calibration.");
      const never = Rules.intervalIsNever(tool.interval);
      if (!(never && !due.input.value) && !Rules.parseIso(due.input.value)) return formError(errors, "Enter the next due date.");
      if (unlocked && cards.some(c => !c.rangeIn.value.trim())) return formError(errors, "Range can't be left blank.");
      if (cards.some(c => !["pass", "fail"].includes(c.row.result))) return formError(errors, "Tick Pass or Fail for every range before saving.");
      const mismatches = cards.map(c => {
        const [lead] = Rules.splitLeadingResult(c.remarks.value);
        return lead && lead !== c.row.result
          ? `${c.rangeIn.value.trim() || "This range"}: remarks say ${lead[0].toUpperCase() + lead.slice(1)} but ${c.row.result[0].toUpperCase() + c.row.result.slice(1)} is ticked`
          : null;
      }).filter(Boolean);
      if (mismatches.length && !confirm(`${mismatches.join("\n")}\n\nSave anyway?`)) return;

      const record = {
        id: entry ? entry.id : CalCheck.randomHex(8), tool_id: tool.tool_id, kind: "measurement",
        date: date.input.value, due_date: due.input.value || "",
        ranges: cards.map(c => ({ range: c.rangeIn.value.trim(), standard: c.stdIn.value.trim(), as_found: c.found.value.trim(),
                                   after_adj: c.adj.value.trim(), result: c.row.result, remarks: c.remarks.value.trim() })),
        note: "", status: "", status_before: "",
        by: entry ? entry.by : state.user.username, by_name: entry ? entry.by_name : state.user.name,
        saved_at: entry ? entry.saved_at : nowIso(), changed_at: entry ? nowIso() : null, sent_at: null,
      };
      if (await storeEntry(record, entry)) {
        toast(entry ? "Changes saved on this device" : "Calibration saved on this device");
        history.back();
      }
    }

    startForm();
    show(h("div", { class: "screen" },
      formHeader(`${entry ? "Change" : "Calibrate"} ${tool.tool_id}`, [tool.name, tool.deviation].filter(Boolean).join(" · ")),
      h("main", { class: "body with-actions", oninput: () => { state.formDirty = true; }, onclick: e => {
        if (e.target.closest(".toggle, .slim")) state.formDirty = true;
      } },
        errors,
        h("div", { class: "pair" }, date.field, due.field),
        h("p", { class: "small" }, `Inspector: ${entry ? entry.by_name : state.user.name}`),
        cards.map(c => c.card),
        h("div", { class: "pair" }, editRanges, allPass || h("span", {})),
        entry ? h("button", { type: "button", class: "link-btn danger", onclick: () => deleteEntry(entry) }, "Delete this entry") : null),
      h("div", { class: "actions single" },
        h("button", { class: "btn", onclick: saveCalibration }, entry ? "Save Changes" : "Save on this device"))));
  }

  function customScreen(original, entry) {
    const tool = current(original);
    const quick = state.data.quick_entries || [];
    const statuses = state.data.statuses || STATUSES;
    const note = h("textarea", { rows: "4" });
    note.value = entry ? entry.note : "";
    const date = dateField("Date", entry ? entry.date : Rules.today());
    const due = dateField("Next due", entry ? entry.due_date : "", { optional: true });
    const statusBefore = entry ? entry.status_before : tool.status;
    const status = h("select", {}, statuses.map(s => h("option", { value: s, selected: s === (entry ? entry.status : tool.status) }, s)));
    const errors = h("div", { role: "alert" });

    const quickButtons = quick.map(text => {
      const b = h("button", { type: "button", class: "quick" }, text);
      b.addEventListener("click", () => {
        // Replaces an empty box (or another quick entry); typed text is kept, with this on a new line
        const now = note.value.trim();
        note.value = now && !quick.includes(now) ? `${now}\n${text}` : text;
        markQuick();
      });
      return b;
    });
    function markQuick() {
      for (const b of quickButtons) b.setAttribute("aria-pressed", String(note.value.split("\n").includes(b.textContent)));
    }
    note.addEventListener("input", markQuick);
    markQuick();

    async function saveCustom() {
      errors.replaceChildren();
      if (!Rules.parseIso(date.input.value)) return formError(errors, "Enter the date of the entry.");
      if (due.input.value && !Rules.parseIso(due.input.value)) return formError(errors, "Enter a valid next due date, or tap No due date.");
      if (!note.value.trim()) return formError(errors, "Please enter some text for this entry.");
      const record = {
        id: entry ? entry.id : CalCheck.randomHex(8), tool_id: tool.tool_id, kind: "custom",
        date: date.input.value, due_date: due.input.value || "", ranges: [],
        note: note.value.trim(), status: status.value, status_before: statusBefore,
        by: entry ? entry.by : state.user.username, by_name: entry ? entry.by_name : state.user.name,
        saved_at: entry ? entry.saved_at : nowIso(), changed_at: entry ? nowIso() : null, sent_at: null,
      };
      if (await storeEntry(record, entry)) {
        toast(entry ? "Changes saved on this device" : "Entry saved on this device");
        history.back();
      }
    }

    startForm();
    show(h("div", { class: "screen" },
      formHeader(`${entry ? "Change Entry" : "Custom Entry"} · ${tool.tool_id}`, tool.name),
      h("main", { class: "body with-actions", oninput: () => { state.formDirty = true; }, onclick: e => {
        if (e.target.closest(".quick")) state.formDirty = true;
      } },
        errors,
        quick.length ? h("section", { class: "quick-list" }, h("h2", { class: "group" }, "Quick fill"), quickButtons) : null,
        h("label", { class: "field" }, "Entry", note),
        h("div", { class: "pair" }, date.field, due.field),
        h("label", { class: "field" }, "Tool status", status),
        h("p", { class: "small" }, `Inspector: ${entry ? entry.by_name : state.user.name}`),
        entry ? h("button", { type: "button", class: "link-btn danger", onclick: () => deleteEntry(entry) }, "Delete this entry") : null),
      h("div", { class: "actions single" },
        h("button", { class: "btn", onclick: saveCustom }, entry ? "Save Changes" : "Save Entry"))));
  }

  // An entry already saved: change it (if it's yours and not sent), else just show it
  function entryScreen(id) {
    const entry = state.work.entries.find(e => e.id === id);
    if (!entry) { go("#/completed"); return; }
    const tool = state.data.tools.find(t => t.tool_id === entry.tool_id);
    if (canChange(entry) && tool) return entry.kind === "custom" ? customScreen(tool, entry) : calibrateScreen(tool, entry);

    const why = entry.sent_at ? `Sent ${localDay(entry.sent_at)} at ${timeText(entry.sent_at)}: any correction is made at the desktop.`
      : entry.by !== state.user.username ? `Made by ${entry.by_name}: only they can change it.`
      : "The file has expired: entries can only be sent now.";
    const fact = (label, value) => h("div", { class: "fact" }, h("span", {}, label), h("span", {}, value || "–"));
    show(h("div", { class: "screen" },
      formHeader(`${entry.kind === "custom" ? "Entry" : "Calibration"} · ${entry.tool_id}`, tool ? tool.name : ""),
      h("main", { class: "body" },
        h("div", { class: "note info" }, why),
        h("section", { class: "card facts" },
          fact("Date", Dates.display(entry.date)), fact("Next due", entry.due_date ? Dates.display(entry.due_date) : "No due date"),
          fact("Inspector", entry.by_name), fact("Saved", timeText(entry.saved_at)),
          entry.kind === "custom" ? fact("Tool status", entry.status) : null),
        entry.kind === "custom"
          ? h("section", { class: "card note-text" }, entry.note)
          : h("section", { class: "card" }, entry.ranges.map(r => h("div", { class: "line" },
              h("span", { class: "line-main" },
                h("span", {}, `${r.range} · ${r.standard}`),
                h("span", {}, `As Found ${r.as_found || "–"} · After Adj. ${r.after_adj || "–"}${r.remarks ? ` · ${r.remarks}` : ""}`)),
              h("span", { class: `result ${r.result === "fail" ? "Fail" : "Pass"}` }, r.result === "fail" ? "Fail" : "Pass")))))));
  }

  // ---------- Send Results ----------
  function sendScreen() {
    const entries = state.work.entries;
    const failed = entries.filter(e => entryResult(e) === "Fail").length;
    const doneTools = new Set(entries.map(e => e.tool_id));
    const notDone = state.data.tools.filter(t => !doneTools.has(t.tool_id)).map(t => t.tool_id);
    const unsent = entries.filter(e => !e.sent_at).length;
    const lastSend = state.work.sends[state.work.sends.length - 1];
    const message = h("div", { role: "alert" });
    const shortName = state.user.name.replace(/[^A-Za-z0-9]/g, "") || "Inspector";

    async function makeFile() {
      const text = await CalCheck.sealResults(state.key, state.header.session, state.user.username, state.user.name,
                                              entries, APP_VERSION);
      const stamp = new Date().toTimeString().slice(0, 5).replace(":", "");
      return new File([text], `Results_${state.header.session}_${shortName}_${stamp}.txt`, { type: "text/plain" });
    }

    async function markSent(how) {
      const at = nowIso();
      for (const e of entries) e.sent_at = e.sent_at || at;
      state.work.sends.push({ at, how, count: entries.length, by: state.user.username });
      await saveWork();
      toast("Results sent");
      route();
    }

    async function share() {
      if (!entries.length) return;
      const file = await makeFile();
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: "Calibration results", text: `Calibration results ${state.header.session} from ${state.user.name}` });
          await markSent("shared");
        } catch (e) {
          if (e.name !== "AbortError")
            message.replaceChildren(h("div", { class: "note bad" }, "The device couldn't share the file. Use Save File instead, then attach it to an email."));
        }
        return;
      }
      saveFile(file);
    }

    async function saveFile(file) {
      file = file instanceof File ? file : await makeFile();
      const url = URL.createObjectURL(file);
      const a = h("a", { href: url, download: file.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (confirm(`Saved ${file.name}.\n\nAttach it to an email to the desktop. Mark these results as sent?`)) await markSent("saved");
    }

    show(h("div", { class: "screen" },
      formHeader("Send Results", `${state.header.session} · ${state.user.name}`),
      h("main", { class: "body" },
        message,
        h("section", { class: "card stats" },
          h("div", {}, h("b", {}, entries.length), h("span", {}, entries.length === 1 ? "entry" : "entries")),
          h("div", {}, h("b", { class: failed ? "fail-text" : "" }, failed), h("span", {}, "failed")),
          h("div", {}, h("b", { class: "muted" }, notDone.length), h("span", {}, "tools not done"))),
        notDone.length ? h("section", { class: "note warn" },
          h("b", {}, `${plural(notDone.length, "tool")} not done`),
          h("span", {}, `${notDone.slice(0, 12).join(" · ")}${notDone.length > 12 ? " ..." : ""} – they stay due and can go in the next check-out.`)) : null,
        h("section", { class: "card padded" },
          h("p", {}, "The results file is locked with this check-out's key, so only the desktop can read it. Email it to whoever does Check In at the computer."),
          h("p", { class: "small" }, unsent ? `${plural(unsent, "entry", "entries")} not sent yet.`
            : lastSend ? `Everything was sent at ${timeText(lastSend.at)}. Sending again is safe: the desktop adds each entry once.` : "")),
        h("button", { class: "btn wide", disabled: !entries.length, onclick: share }, icon("mail", 20), "Email Results"),
        h("button", { class: "link-btn center", disabled: !entries.length, onclick: () => saveFile() }, "Save File instead"),
        h("p", { class: "small center" }, "Opens your device's share sheet with the file attached. Your entries stay on this device until the file is removed."))));
  }

  // ---------- moving between screens (the phone's back button works) ----------
  function route() {
    if (!state.data) return openScreen();
    if (state.formHash && state.formDirty && location.hash !== state.formHash) {
      if (!confirm("Leave without saving? What you've typed will be lost.")) {
        history.pushState(null, "", state.formHash);
        return;
      }
    }
    state.formHash = null;
    state.formDirty = false;
    if (loggedInTooLong()) {
      lock();
      return openScreen();
    }
    state.expired = CalCheck.isExpired(state.header);
    if (state.expired && !state.work.entries.some(e => !e.sent_at)) {
      removeFile();
      return openScreen("The check-out file has expired and was removed from this device. Ask for a new one.");
    }
    const hash = location.hash;
    const part = prefix => decodeURIComponent(hash.slice(prefix.length));
    const tool = id => state.data.tools.find(t => t.tool_id === id);
    if (hash.startsWith("#/tool/")) return toolScreen(part("#/tool/"));
    if (hash.startsWith("#/cal/") && tool(part("#/cal/")) && !state.expired) return calibrateScreen(tool(part("#/cal/")), null);
    if (hash.startsWith("#/custom/") && tool(part("#/custom/")) && !state.expired) return customScreen(tool(part("#/custom/")), null);
    if (hash.startsWith("#/entry/")) return entryScreen(part("#/entry/"));
    if (hash === "#/send") return sendScreen();
    state.tab = hash === "#/all" ? "all" : hash === "#/completed" ? "completed" : "due";
    if (state.tab === "all") return allScreen();
    if (state.tab === "completed") return completedScreen();
    return dueScreen();
  }

  window.addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && loggedInTooLong() && !state.formDirty) { lock(); openScreen(); }      // (left open past midnight)
  });
  window.addEventListener("beforeunload", e => {
    if (state.formDirty) { e.preventDefault(); e.returnValue = ""; }
  });

  if (!window.crypto || !crypto.subtle) {
    show(h("div", { class: "screen" }, brandHero(),
      h("div", { class: "panel" }, h("div", { class: "note bad" }, "This browser can't unlock check-out files. Open the app's https:// link in Safari or Chrome."))));
    return;
  }
  if ("serviceWorker" in navigator) {
    // An update that arrives while the app is open takes over straight away:
    // reload once onto it (still logged in, so no PIN) - but never in the
    // middle of typing an entry (it's used the next time the app opens)
    const hadVersion = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadVersion && !reloading && !state.formDirty) { reloading = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js").catch(() => { /* still works while online */ });
  }

  (async () => {
    const header = storedHeader();
    if (header && (!CalCheck.isExpired(header) || unsentFor(header.session)) && await resumeLogin(header)) {
      if (location.hash.startsWith("#/")) route();
      else location.hash = "#/due";             // (shows it)
      return;
    }
    openScreen();
  })();
})();
