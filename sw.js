// Service worker minimal : rend l'appli installable, sans mise en cache
// (la page est toujours chargée à jour depuis le réseau).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));
