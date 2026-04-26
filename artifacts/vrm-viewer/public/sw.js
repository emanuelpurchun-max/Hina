const CACHE_VERSION = "hina-v1";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./script.js",
  "./manifest.json",
  "./icon.svg",
  "./personaje.vrm",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        Promise.all(
          PRECACHE_URLS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn("[sw] precache miss:", url, err);
            }),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.pathname.endsWith("/chat")) return;

  const isCDN =
    url.hostname === "cdn.jsdelivr.net" || url.hostname === "unpkg.com";
  const isSameOrigin = url.origin === self.location.origin;

  if (!isCDN && !isSameOrigin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          if (!response || response.status !== 200) return response;
          if (response.type === "error") return response;

          const copy = response.clone();
          caches
            .open(CACHE_VERSION)
            .then((cache) => cache.put(request, copy))
            .catch(() => {});
          return response;
        })
        .catch(() => cached);
    }),
  );
});
