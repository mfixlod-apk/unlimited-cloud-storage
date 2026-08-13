# Architecture decisions

This file records decisions that shape the implementation. Change them when needed, but do so explicitly and update the related code and documentation together.

## 1. No application backend

**Decision:** The browser connects directly to Telegram; GitHub Pages serves only static assets.

**Why:** It preserves the project's zero-server-cost goal and avoids operating a credential-bearing proxy.

**Consequences:** Browser compatibility, WebSocket availability, memory limits, and foreground execution define what the app can do. Features that require scheduled/background work or public sharing links cannot be added honestly without reconsidering this boundary.

## 2. Runtime user-supplied API credentials

**Decision:** Never ship a shared Telegram API ID/hash. Every user supplies their own.

**Why:** A static bundle cannot protect a shared secret, and abuse would affect every user of that credential pair.

**Consequences:** Onboarding has an extra step, and restoring a Telegram session also requires retaining the credential pair locally.

## 3. Teleproto over WebSockets

**Decision:** Use the maintained `teleproto` package with `PromisedWebSockets` rather than implementing MTProto or using only the Bot API.

**Why:** User authorization, private channel history, native uploads/downloads, and QR login require a full MTProto client. Implementing Telegram cryptography and protocol state locally would be a major security risk.

**Consequences:** The frontend bundle is relatively large and requires Node compatibility shims. Library upgrades need real authentication and transfer testing.

## 4. One Telegram message equals one file

**Decision:** The selected broadcast channel's media-message history is the file database.

**Why:** It avoids a second source of truth and allows another browser/device to reconstruct the gallery.

**Consequences:** Telegram message IDs are object IDs; deletion is destructive; native captions and media metadata are the only cross-device metadata in the MVP. Folders, tags, and favorites require a future Telegram-backed metadata design.

## 5. Broadcast channels only

**Decision:** List private and public broadcast channels, but exclude supergroups and ordinary chats. Label public channels and require explicit confirmation before using one for storage.

**Why:** It avoids mixing personal storage with conversations while still exposing the account's complete channel list. Explicit labeling and confirmation reduce accidental public uploads.

**Consequences:** Users can create a channel in the app or the official Telegram client. Channel discovery paginates the complete dialog list, which can take longer for very large accounts but does not hide older or archived channels.

## 6. IndexedDB for session/configuration and thumbnails

**Decision:** Use IndexedDB rather than `localStorage`.

**Why:** IndexedDB supports structured records and Blob thumbnail caching without synchronous main-thread storage calls.

**Consequences:** Data is local to one browser profile, is readable by code executing under the same origin, and can disappear when site data is cleared. It is never authoritative for Telegram files.

## 7. Persist credentials only with explicit device persistence

**Decision:** “Keep me signed in” controls persistence of both the serialized session and API credentials.

The option is off by default so a successful login does not create a persistent bearer session unless the user explicitly chooses it.

**Why:** A session cannot be restored without the API credential pair, and storing only one provides little value.

**Consequences:** Persistent login should be used only on trusted browser profiles. Passphrase-encrypted local sessions remain a possible future feature.

## 8. Sequential uploads and bounded downloads

**Decision:** Upload selected files one at a time with one worker per file; allow at most two concurrent downloads.

**Why:** Conservative concurrency reduces flood waits, memory pressure, and mobile-browser instability.

**Consequences:** Large batches prioritize reliability over maximum throughput. Parallelism should become adaptive only after measurement across browsers and Telegram accounts.

## 9. Progressive media, bounded Blob previews, and streaming downloads

**Decision:** Serve video/audio to native media elements through a short-lived same-origin byte-range bridge capped at 1 MB per response. Use metadata-only preload and propagate abandoned HTTP-request cancellation to Telegram during seeking. Retain complete in-memory Blobs for images and initial compatibility fallback within explicit adaptive tiers—128 MB, 384 MB, 768 MB, and at most 1.5 GB—derived from the configured/effective memory budget. Never silently switch a running stream to full-file loading after a runtime error. Stream downloads to a chosen file through the File System Access API when available and use a confirmed Blob fallback elsewhere.

**Why:** Native range playback supplies the familiar seek controls and lets the browser manage buffering/eviction without downloading an entire video. Blob URLs remain a broad compatibility path, while direct chunk writes avoid buffering multi-gigabyte downloads on supporting browsers.

**Consequences:** Progressive playback requires a controlling service worker and a browser-supported media codec/container. Failure to initialize the bridge can use the bounded Blob compatibility path; a runtime stream/decoder failure requires an explicit retry or download so an unexpected full-file allocation cannot follow a seek. Firefox, Safari, and some mobile browsers may also take the Blob download fallback because native save-file support varies.

## 10. Same-origin custom service worker

**Decision:** Maintain a small service worker instead of a general runtime-caching plugin.

**Why:** The cache boundary is security-sensitive: cache the static shell, ignore every cross-origin request, and explicitly keep short-lived same-origin media ranges out of Cache Storage.

**Consequences:** Cache-version changes are manual. The worker also mediates progressive range requests through the owning authenticated page, but never receives credentials or owns a Telegram client. Developers must increment `CACHE_NAME` when shell behavior changes and test offline upgrades plus range playback.

## 11. No application-managed encryption in the MVP

**Decision:** Do not claim zero-knowledge storage or add an incomplete encryption mode.

**Why:** Correct key derivation, recovery, cross-device key handling, encrypted metadata, streaming encryption, and versioned formats need a dedicated design.

**Consequences:** Telegram can process stored files. Users must encrypt sensitive material independently. Any future encryption feature needs a documented file format and recovery story before implementation.

## 12. One-page React state machine before routing

**Decision:** Use a top-level stage union instead of a routing or global-state dependency.

**Why:** Onboarding and drive access are a short linear session-dependent flow, and URL routes must not expose authentication data.

**Consequences:** `App.tsx` is currently large. Components can be extracted later without changing the state-machine semantics.

## 13. Lightweight metadata and windowed gallery chunks

**Decision:** Retain only compact `CloudItem` metadata for discovered history, keep a bounded 300-message LRU for current work, resolve other Telegram messages by ID on demand, and unmount gallery chunks outside an adaptive near-viewport margin.

**Why:** Channels with thousands of files should remain searchable without retaining thousands of Teleproto object graphs, DOM cards, decoded thumbnails, or Blob URLs.

**Consequences:** Returning to a parked chunk may briefly reload thumbnails from IndexedDB. Active search deliberately paginates to the start of history and can take time or encounter Telegram flood waits on very large channels.

## 14. Foreground-only durable sync queue

**Decision:** `Sync now` accepts arbitrarily large picker selections without an application file-count cap, uploads sequentially with bounded retries, and persists only queue/batch metadata. Original picker files stay as page-lifetime references and are never copied into IndexedDB. Completed batches receive a small Telegram text checkpoint.

**Why:** Browser storage cannot safely duplicate a 10,000-file photo library, while iOS and other mobile browsers cannot restore picker capabilities or guarantee periodic background execution. Aggregate UI state also avoids retaining thousands of progress components.

**Consequences:** Users must keep the PWA open. Reloaded unfinished queues require the user to select those files again. Native automatic photo backup remains a separate product phase and must not be implied by the PWA UI.
