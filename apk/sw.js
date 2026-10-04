/* ============================================================
   PharmaFind — sw.js   (service worker for the installable app)
   ------------------------------------------------------------
   What it does
     • Lets phones / desktops INSTALL PharmaFind as an app.
     • Keeps a copy of the app's own files so the app can still
       OPEN when the connection is bad (it then shows a clear
       "you're offline" message).

   What it deliberately does NOT do
     • It never serves an old file while you are online:
       every file is fetched from the network FIRST, and the
       saved copy is used only if the network fails. So after
       you upload new files, everyone gets them on next open.
     • It never touches Firebase, Razorpay, maps or the text
       reader — only this site's own files. Live data always
       needs the internet.

   Change CACHE (v1 → v2 …) only if you want to throw away the
   saved copies on everyone's device.
   ============================================================ */

const CACHE = "pharmafind-v1";

// The files the app needs to start. Add-ons are optional: a missing one is skipped.
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "firebase-config.js",
  "map.js", "prescription.js", "rxscan.js", "payments.js", "pwa.js",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(SHELL.map(url =>
        fetch(url, { cache: "no-store" })
          .then(res => { if(res && res.ok) return cache.put(url, res); })
          .catch(() => { /* optional file or offline — fine */ }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("pharmafind-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if(req.method !== "GET") return;                       // never touch writes
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;        // Firebase, Razorpay, CDNs: not our business

  event.respondWith(
    fetch(req)
      .then(res => {
        if(res && res.ok && res.type === "basic"){
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true })
          .then(hit => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined))
          .then(hit => hit || Response.error()))
  );
});
