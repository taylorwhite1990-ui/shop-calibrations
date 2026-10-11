// Display: Light (the default: easiest to read in the shop), Dark, or Match
// phone. Loaded in <head>, so the page is drawn in the right colours from the
// start. The choice is kept on this device (it isn't secret, so it's kept
// before any PIN). See app.css :root[data-theme="dark"].
"use strict";

const Theme = (() => {
  const KEY = "calcheck.theme";
  const CHOICES = ["light", "dark", "auto"];
  const LABELS = { light: "Light", dark: "Dark", auto: "Match phone" };
  const phoneDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function choice() {
    let chosen = null;
    try { chosen = localStorage.getItem(KEY); } catch (e) { /* private mode: the default */ }
    return CHOICES.includes(chosen) ? chosen : "light";
  }

  function apply() {
    const c = choice();
    const dark = c === "dark" || (c === "auto" && !!phoneDark && phoneDark.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    // "only light" also stops a phone in dark mode darkening the light look itself
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = dark ? "dark" : "only light";
  }

  function set(c) {
    try { localStorage.setItem(KEY, c); } catch (e) { /* used for now, not kept */ }
    apply();
  }

  if (phoneDark && phoneDark.addEventListener) phoneDark.addEventListener("change", apply);     // (Match phone follows it)
  apply();
  return { CHOICES, LABELS, choice, set };
})();
