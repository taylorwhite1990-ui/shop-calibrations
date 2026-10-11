// Display: Light (the default: easiest to read in the shop) or Dark. Loaded
// in <head>, so the page is drawn in the right colours from the
// start. The choice is kept on this device (it isn't secret, so it's kept
// before any PIN). See app.css :root[data-theme="dark"].
//
// Phones' own "dark mode for websites" (Chrome's Darken websites, Samsung
// Internet's dark mode, ...) would otherwise darken the Light look too. They
// leave a page alone when it says it has its own dark design: index.html's
// color-scheme meta (always "light dark") and app.css's prefers-color-scheme
// block say so, whatever is chosen here. (Samsung Internet's own Dark mode
// switch darkens every site regardless: turn it off on the shop phones.)
"use strict";

const Theme = (() => {
  const KEY = "calcheck.theme";
  const CHOICES = ["light", "dark"];
  const LABELS = { light: "Light", dark: "Dark" };

  function choice() {
    let chosen = null;
    try { chosen = localStorage.getItem(KEY); } catch (e) { /* private mode: the default */ }
    return CHOICES.includes(chosen) ? chosen : "light";     // (an old "Match phone" choice: Light)
  }

  function apply() {
    document.documentElement.dataset.theme = choice();
  }

  function set(c) {
    try { localStorage.setItem(KEY, c); } catch (e) { /* used for now, not kept */ }
    apply();
  }

  apply();
  return { CHOICES, LABELS, choice, set };
})();
