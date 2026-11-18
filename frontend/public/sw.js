// Mode hors-ligne de Padel Boost.
// - Pages et API (/api, lecture seule): réseau d'abord, sinon la dernière version enregistrée.
// - Fichiers de /assets (nom unique à chaque version): cache d'abord.
// Les modifications (POST, PUT…) ne passent jamais par le cache.
const SHELL = "shell-v2", ASSETS = "assets-v1", API = "api";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.add("/")).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, ASSETS, API].includes(k)).map((k) => caches.delete(k)))));
  self.clients.claim();
});

async function networkFirst(req, cacheName, fallback) {
  try {
    const res = await fetch(req);
    if (res.ok) { const copy = res.clone(); (await caches.open(cacheName)).put(fallback ?? req, copy); }
    return res;
  } catch {
    const hit = await caches.match(fallback ?? req);
    if (hit) return hit;
    throw new Error("hors ligne");
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(ASSETS).then((c) => c.put(req, copy)); }
      return res;
    })));
  } else if (url.pathname.startsWith("/api/")) {
    e.respondWith(networkFirst(req, API));
  } else if (req.mode === "navigate") {
    e.respondWith(networkFirst(req, SHELL, "/"));
  }
});

// Notifications du téléphone (envoyées par le serveur): affichées, et un toucher ouvre l'application
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Padel Boost", {
    body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", data: { url: d.url || "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).origin === location.origin);
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
