const CACHE_NAME = "unlimited-cloud-storage-shell-v13";
const DEVELOPMENT = new URL(self.location.href).searchParams.has("dev");
const STREAM_PATH = "/__telegram_stream__/";
const STREAM_CHUNK_SIZE = 1024 * 1024;
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./pwa-192x192.png",
  "./pwa-512x512.png",
  "./maskable-icon-512x512.png",
];

self.addEventListener("install", (event) => {
  if (DEVELOPMENT) {
    event.waitUntil(self.skipWaiting());
    return;
  }
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("unlimited-cloud-storage-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "telegram-stream-ping" && event.ports[0]) {
    event.ports[0].postMessage({ type: "telegram-stream-ready" });
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const marker = url.pathname.indexOf(STREAM_PATH);
  if (marker >= 0) {
    event.respondWith(handleTelegramStream(event, url.pathname.slice(marker + STREAM_PATH.length)));
    return;
  }

  if (DEVELOPMENT) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          }
          return response;
        })
        .catch(() => caches.match("./index.html")),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok && response.type === "basic") {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    })),
  );
});

async function handleTelegramStream(event, streamPath) {
  const [token, sizeText, extra] = streamPath.split("/");
  if (!/^[0-9a-f-]{36}$/i.test(token)) return new Response("Invalid stream", { status: 400 });
  const total = Number(sizeText);
  if (extra !== undefined || !Number.isSafeInteger(total) || total <= 0) return new Response("Invalid stream size", { status: 400 });
  const client = await self.clients.get(event.clientId || event.resultingClientId);
  if (!client) return new Response("Playback page is unavailable", { status: 410 });

  const range = event.request.headers.get("Range") || "bytes=0-";
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!match || (!match[1] && !match[2])) return rangeNotSatisfiable(total);
  let start;
  let length;
  if (!match[1]) {
    const suffixLength = Math.min(STREAM_CHUNK_SIZE, Number(match[2]));
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return rangeNotSatisfiable(total);
    start = Math.max(0, total - suffixLength);
    length = total - start;
  } else {
    start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start < 0 || start >= total) return rangeNotSatisfiable(total);
    const requestedEnd = match[2] ? Math.min(total - 1, Number(match[2])) : Math.min(total - 1, start + STREAM_CHUNK_SIZE - 1);
    if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return rangeNotSatisfiable(total);
    length = Math.min(STREAM_CHUNK_SIZE, requestedEnd - start + 1);
  }

  try {
    const result = await requestTelegramRange(client, token, start, length, event.request.signal);
    const bytes = result.bytes;
    const actualTotal = Number(result.size) || total;
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || start >= actualTotal) return rangeNotSatisfiable(actualTotal);
    const end = start + bytes.byteLength - 1;
    return new Response(bytes, {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Length": String(bytes.byteLength),
        "Content-Range": `bytes ${start}-${end}/${actualTotal}`,
        "Content-Type": result.mime || "application/octet-stream",
      },
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Telegram range failed", { status: 502 });
  }
}

function rangeNotSatisfiable(total) {
  return new Response(null, { status: 416, headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${total}` } });
}

function requestTelegramRange(client, token, start, length, signal) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const requestId = crypto.randomUUID();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      channel.port1.close();
      callback(value);
    };
    const cancelPageRequest = () => {
      client.postMessage({ type: "telegram-stream-cancel", token, requestId });
    };
    const abort = () => {
      cancelPageRequest();
      finish(reject, new DOMException("Media range cancelled", "AbortError"));
    };
    const timeout = setTimeout(() => {
      cancelPageRequest();
      finish(reject, new Error("Telegram range timed out"));
    }, 60000);
    channel.port1.onmessage = (event) => {
      event.data?.ok
        ? finish(resolve, event.data)
        : finish(reject, new Error(event.data?.error || "Telegram range failed"));
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    client.postMessage({ type: "telegram-stream-range", token, requestId, start, length }, [channel.port2]);
  });
}
