// Shop Floor Calibrations: the phone side of Check Out to Phones.
// Stage A: open a check-out file, log in with a Phone PIN, browse the tools.
// The file is kept on the phone still locked. After the PIN, the inspector
// stays logged in until midnight (a refresh or reload doesn't ask again);
// Lock, midnight or the file expiring asks for the PIN again.
"use strict";

(() => {
  const STORE_FILE = "calcheck.file";        // the locked file, as emailed
  const STORE_USER = "calcheck.lastUser";    // the name picked last time
  const STORE_TRIES = "calcheck.tries";      // wrong PINs in a row, and when
  const FREE_TRIES = 5, WAIT_SECONDS = 60;
  const APP_VERSION = "a4";                  // (shown on the login screen; the same as VERSION in sw.js)

  const app = document.getElementById("app");
  const state = { header: null, data: null, user: null, until: 0, tab: "due", search: "", category: "" };

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
    grid: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
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

  // ---------- opening the file and logging in ----------
  function storedHeader() {
    const text = load(STORE_FILE);
    if (!text) return null;
    try { return CalCheck.readHeader(text); } catch (e) { forget(STORE_FILE); return null; }
  }

  function removeFile() {
    forget(STORE_FILE);
    forget(STORE_TRIES);
    lock();
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

  function rememberLogin(key) {
    return idb("readwrite", s => s.put({ key, session: state.header.session, username: state.user.username,
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
    Object.assign(state, { header, user, until: saved.until });
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
          if (CalCheck.isExpired(header)) throw new Error(`That file expired on ${Dates.displayMoment(header.expires)}. Ask for a new one.`);
          if (!save(STORE_FILE, text)) throw new Error("The phone wouldn't keep the file (is it in private browsing, or full?).");
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

  function versionLine() {
    return h("p", { class: "version" }, `Version ${APP_VERSION}`);
  }

  function openScreen(problem) {
    const header = storedHeader();
    if (header && CalCheck.isExpired(header)) {
      forget(STORE_FILE);
      return openScreen(`The check-out file expired on ${Dates.displayMoment(header.expires)} and was removed from this phone. Ask for a new one.`);
    }
    if (header) return loginScreen(header, problem);

    show(h("div", { class: "screen" },
      h("div", { class: "hero" },
        icon("tool", 40),
        h("h1", {}, "Shop Floor Calibrations"),
        h("p", {}, "Works offline · nothing is kept until you open a check-out file")),
      h("div", { class: "panel" },
        h("h2", {}, "Open the check-out file you were emailed"),
        h("p", { class: "small" }, "Save the email's attachment to your phone (Files or Downloads) first, then pick it here."),
        h("button", { class: "pick-file", onclick: () => chooseFile(openScreen) }, icon("file", 20), "Choose File"),
        problem && h("div", { class: "note bad", role: "alert" }, problem)),
      versionLine()));
  }

  function loginScreen(header, problem) {
    const last = load(STORE_USER);
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
      if (!pin.value) return say("Enter your Phone PIN.");
      go.disabled = true;
      go.textContent = "Unlocking...";
      try {
        const { data, key } = await CalCheck.unlock(header, select.value, pin.value);
        forget(STORE_TRIES);
        save(STORE_USER, select.value);
        state.header = header;
        state.data = data;
        state.user = header.inspectors.find(i => i.username === select.value);
        state.until = midnightTonight();
        await rememberLogin(key);
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
      h("div", { class: "note ok" },
        h("b", {}, "Check-out file on this phone"),
        h("span", {}, `${header.tool_count} tool${header.tool_count === 1 ? "" : "s"} · checked out by ${header.checked_out_by}`),
        h("span", { class: "small" }, `Expires ${Dates.displayMoment(header.expires)} · ${header.session}`)),
      h("label", { class: "field", for: "who" }, "Your name", select),
      h("label", { class: "field", for: "pin" }, "Phone PIN", pin),
      message,
      go,
      h("button", { type: "button", class: "link-btn", onclick: () => chooseFile(err => err ? say(err) : openScreen()) },
        "Open a different file"),
      h("button", { type: "button", class: "link-btn danger", onclick: () => {
        if (confirm("Remove the check-out file from this phone?")) { removeFile(); openScreen(); }
      } }, "Remove the file from this phone"));

    show(h("div", { class: "screen" },
      h("div", { class: "hero" }, icon("tool", 40), h("h1", {}, "Shop Floor Calibrations"),
        h("p", {}, "Log in with your Phone PIN")),
      form,
      versionLine()));
    (select.value ? pin : select).focus();
  }

  function lock() {
    forgetLogin();
    state.header = state.data = state.user = null;
    state.until = 0;
    state.search = "";
    state.category = "";
  }

  // ---------- the tools ----------
  function rules() {
    return state.data.due_rules || { overdue_after: 14, due_soon: 14 };
  }

  function matches(tool) {
    const text = state.search.trim().toLowerCase();
    return !text || tool.tool_id.toLowerCase().includes(text) || tool.name.toLowerCase().includes(text);
  }

  function toolRow(tool, side) {
    const sev = Dates.severity(tool.due_date, rules());
    return h("button", { class: "row", onclick: () => { location.hash = `#/tool/${encodeURIComponent(tool.tool_id)}`; } },
      h("span", { class: `dot ${sev}`, "aria-label": sev === "none" ? "No due date" : `${sev} dot` }),
      h("span", { class: "row-main" }, h("span", { class: "row-id" }, tool.tool_id), h("span", { class: "row-name" }, tool.name)),
      h("span", { class: "row-side" }, side),
      h("span", { class: "chev" }, icon("chev", 16)));
  }

  function sessionStrip() {
    return h("div", { class: "session" },
      h("span", {}, h("b", {}, state.user.name), ` · ${state.data.tools.length} tools · expires ${Dates.displayMoment(state.header.expires)}`),
      h("button", { onclick: () => { lock(); location.hash = ""; openScreen(); } }, "Lock"));
  }

  function searchBox(placeholder, refill) {
    const input = h("input", { type: "search", placeholder, "aria-label": "Search", value: state.search });
    input.addEventListener("input", () => { state.search = input.value; refill(); });
    return h("label", { class: "search" }, icon("search", 18), input);
  }

  function tabBar() {
    const tab = (name, label, iconName) => h("button", {
      class: "tab", "aria-current": state.tab === name ? "page" : null,
      onclick: () => { location.hash = `#/${name}`; } }, icon(iconName), label);
    return h("nav", { class: "tabs", "aria-label": "Tabs" }, tab("due", "Due", "clock"), tab("all", "All", "grid"));
  }

  function dueScreen() {
    const list = h("main", { class: "list" });
    const chips = h("div", { class: "chips" });
    const due = state.data.tools
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
    const present = new Set(state.data.tools.map(t => t.category));
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
        const tools = state.data.tools.filter(t => t.category === c && matches(t))
          .sort((a, b) => a.tool_id.localeCompare(b.tool_id, undefined, { numeric: true }));
        if (!tools.length) continue;
        list.append(h("h2", { class: "group" }, `${c || "No category"} · ${tools.length}`),
                    ...tools.map(t => toolRow(t, t.status)));
      }
      if (!list.children.length) list.append(h("p", { class: "empty" }, "No tools match your search"));
    }
    fill();
    show(h("div", { class: "screen" },
      h("header", { class: "bar" }, h("div", { class: "bar-row" }, h("h1", {}, "All Tools")),
        searchBox(`Search the ${state.data.tools.length} checked-out tools`, fill)),
      sessionStrip(), filters, list, tabBar()));
  }

  function toolScreen(toolId) {
    const tool = state.data.tools.find(t => t.tool_id === toolId);
    if (!tool) { location.hash = "#/due"; return; }
    const sev = Dates.severity(tool.due_date, rules());
    const fact = (label, value) => value ? h("div", { class: "fact" }, h("span", {}, label), h("span", {}, value)) : null;
    const back = () => { if (history.length > 1) history.back(); else location.hash = `#/${state.tab}`; };

    show(h("div", { class: "screen" },
      h("header", { class: "bar" },
        h("button", { class: "icon-btn plain", "aria-label": "Back", onclick: back }, icon("back")),
        h("div", { class: "tool-head" },
          h("div", { class: "bar-row" }, h("h1", {}, tool.tool_id), h("span", { class: "badge" }, tool.status)),
          h("p", {}, tool.name))),
      h("main", { class: "body" },
        h("section", { class: `due-card ${sev}` }, h("span", { class: `dot ${sev}` }),
          tool.due_date ? h("span", {}, h("b", {}, `Due ${Dates.display(tool.due_date)}`), ` · ${Dates.whenText(tool.due_date).replace(/^Due /, "")}`)
                        : h("span", {}, "No due date")),
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
                h("span", {}, [e.kind === "custom" ? e.remarks || "Custom entry" : `${e.ranges} range${e.ranges === 1 ? "" : "s"}`, e.by, e.cal_id].filter(Boolean).join(" · "))),
              h("span", { class: `result ${e.result}` }, e.result)))
          : h("p", { class: "empty" }, "Not calibrated yet")))));
  }

  // ---------- moving between screens (the phone's back button works) ----------
  function route() {
    if (!state.data) return openScreen();
    if (loggedInTooLong()) {
      lock();
      return openScreen();
    }
    if (CalCheck.isExpired(state.header)) {
      lock();
      forget(STORE_FILE);
      return openScreen("The check-out file has expired and was removed from this phone. Ask for a new one.");
    }
    const hash = location.hash;
    if (hash.startsWith("#/tool/")) return toolScreen(decodeURIComponent(hash.slice(7)));
    state.tab = hash === "#/all" ? "all" : "due";
    return state.tab === "all" ? allScreen() : dueScreen();
  }

  window.addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && loggedInTooLong()) { lock(); openScreen(); }      // (left open past midnight)
  });

  if (!window.crypto || !crypto.subtle) {
    show(h("div", { class: "screen" }, h("div", { class: "hero" }, h("h1", {}, "Shop Floor Calibrations")),
      h("div", { class: "panel" }, h("div", { class: "note bad" }, "This browser can't unlock check-out files. Open the app's https:// link in Safari or Chrome."))));
    return;
  }
  if ("serviceWorker" in navigator) {
    // An update that arrives while the app is open takes over straight away:
    // reload once onto it (still logged in, so no PIN)
    const hadVersion = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadVersion && !reloading) { reloading = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js").catch(() => { /* still works while online */ });
  }

  (async () => {
    const header = storedHeader();
    if (header && !CalCheck.isExpired(header) && await resumeLogin(header)) {
      if (location.hash.startsWith("#/")) route();
      else location.hash = "#/due";             // (shows it)
      return;
    }
    openScreen();
  })();
})();
