// Makes the page "cross-origin isolated" so the voice model can use several CPU threads.
// GitHub Pages cannot send the required headers itself, so this service worker adds them to responses.
// Based on the well-known coi-serviceworker approach; harmless if it is not registered.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
  e.respondWith(
    fetch(r).then((res) => {
      if (res.status === 0) return res;
      const h = new Headers(res.headers);
      h.set("Cross-Origin-Embedder-Policy", "credentialless");
      h.set("Cross-Origin-Opener-Policy", "same-origin");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }).catch((err) => { console.error(err); return Response.error(); })
  );
});
