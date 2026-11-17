// Service worker de l'appli Poêle : rend l'appli installable et affiche les notifications.
// Pas de mise en cache : la page est toujours chargée à jour depuis le réseau.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
// Toujours la dernière version de l'appli : on ignore le cache du navigateur pour ses propres fichiers
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "GET" && url.origin === self.location.origin) {
    e.respondWith(fetch(e.request, { cache: "no-store" }).catch(() => fetch(e.request)));
  } else {
    e.respondWith(fetch(e.request));
  }
});

// Notification envoyée par le relais Cloudflare
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { texte: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titre || "Poêle", {
    body: d.texte || "",
    icon: "icon-192.png",
    badge: "badge-96.png",   // petite icône de la barre d'état : blanche sur fond transparent
    tag: d.tag || undefined,
    renotify: !!d.tag,
    requireInteraction: !!d.urgent,
    data: { url: self.registration.scope },
  }));
});

// Appui sur la notification : ouvre (ou ramène au premier plan) l'appli
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const fenetres = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const f of fenetres) { if ("focus" in f) return f.focus(); }
    return self.clients.openWindow(e.notification.data && e.notification.data.url || "./");
  })());
});
