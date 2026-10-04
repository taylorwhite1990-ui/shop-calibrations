// Keeps the app's own files on the phone so it opens with no signal.
// Raise VERSION whenever a file below changes, so phones pick up the update
// (the next time they open the app while online). app.js shows the same
// version on the login screen (APP_VERSION there: keep the two the same).
const VERSION = "calcheck-a6";
const FILES = ["./", "index.html", "app.css", "calcheck.js", "dates.js", "rules.js", "app.js", "manifest.webmanifest", "icon-256.png", "mobile-logo.png"];

// Fresh copies from the site, never the browser's short-term copies (GitHub
// lets those be reused for 10 minutes, which kept an old app.js before)
self.addEventListener("install", event => {
  event.waitUntil(caches.open(VERSION)
    .then(cache => cache.addAll(FILES.map(f => new Request(f, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// The app's own files only: from the phone first, the web when not kept
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then(found => found || fetch(event.request)));
});
