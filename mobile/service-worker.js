self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open("learnalong-ai-mobile-v1").then((cache) =>
      cache.addAll(["/mobile/", "/mobile/mobile.css", "/mobile/mobile.js", "/mobile/manifest.webmanifest"])
    )
  );
});

self.addEventListener("fetch", (event) => {
  if (!event.request.url.includes("/mobile/")) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
