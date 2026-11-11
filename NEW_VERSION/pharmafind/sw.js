/* PharmaFind service worker
   - Makes the site installable (needed for the Android app).
   - App files: network first, cached copy if offline.
   - Firebase / Google / CDN traffic is never cached (live data stays live). */

const CACHE = "pharmafind-v1";
const SHELL = [
  "./", "./index.html", "./app.js", "./styles.css", "./firebase-config.js",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // Firebase, fonts, CDNs: straight to network
  if (url.pathname.startsWith("/__/")) return;             // Firebase auth helper pages

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});
