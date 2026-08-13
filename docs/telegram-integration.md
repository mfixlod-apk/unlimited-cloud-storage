# Telegram integration

## Client choice

The app uses `teleproto`, the maintained GramJS-compatible MTProto client. It connects with `PromisedWebSockets`, which is required because a GitHub Pages application cannot open raw TCP connections.

The client is configured in [`src/telegram.ts`](../src/telegram.ts):

- five initial connection retries;
- five reconnect retries;
- four request retries;
- at most two concurrent downloads;
- a 30-second automatic flood-wait threshold;
- library logging disabled to reduce accidental exposure of session-related details;
- a single upload worker for conservative request behavior.

Keep the Telegram client as a singleton. Authentication codes and QR tokens are tied to the connected session; reconnecting during an authentication flow can invalidate them.

## API credentials

Telegram requires an `api_id` and `api_hash` before a client can connect. This project has no application-wide credentials. Users enter their own values from `my.telegram.org/apps`.

The credentials are passed to `TelegramDrive.connect()`. They are persisted only when the user enables “Keep me signed in.” Never add fallback credentials to source code, Vite environment variables, GitHub Actions, or the generated bundle.

## QR authentication

`AuthScreen` starts `TelegramDrive.loginWithQr()` with an `AbortController`.

```text
Teleproto emits token + expiry
  → TelegramDrive creates tg://login?token=<base64url token>
  → AuthScreen renders that URI with qrcode
  → user scans in Telegram Settings → Devices
  → Teleproto waits for acceptance
  → optional password callback requests Telegram 2FA password
  → authenticated StringSession is serialized
```

The QR token is displayed as a data-URL image and is not stored. Closing or switching away from the QR flow aborts token polling. Token and timeout errors are allowed to retry so Teleproto can rotate an expired QR code.

The browser build creates base64url manually from standard base64. Do not pass `"base64url"` to the browser `Buffer` polyfill: some production bundles reject that Node-specific encoding name.

The `expires` value returned by Teleproto is treated as a Unix timestamp in seconds for the UI countdown.

## Phone authentication

Phone login uses `signInUser()` callbacks:

- `phoneNumber` returns the normalized international number;
- `phoneCode` pauses the library call until the user submits the code;
- `password` pauses for Telegram two-step verification if required;
- `firstAndLastNames` rejects registration because account creation belongs in the official Telegram client.

The phone number, login code, and password stay in React memory for the active flow. They are not written to IndexedDB.

## Session restoration

After successful authentication, `client.session.save()` produces a `StringSession`. When persistence is enabled, it is stored with the API credentials in IndexedDB.

On startup:

1. load the saved connection record;
2. construct `StringSession(saved.session)`;
3. connect the client;
4. call `checkAuthorization()`;
5. continue to channel restoration only if authorized.

If restoration fails, the app disconnects and returns to credential entry with a sanitized error.

## Eligible storage channels

`listPrivateChannels()` omits Teleproto's dialog limit so the library paginates through the complete account dialog list, including archived folders. It accepts only entries where:

```text
dialog.isChannel is true
entity.broadcast is true
entity.left is not true
```

This includes private and public broadcast channels and excludes supergroups, ordinary groups, and channels the user has left. Public channels are hidden by default. In the drive, their toggle appears only inside the open channel dropdown; the full chooser has the same opt-in control. Public channels are visibly labeled and require confirmation because uploaded files may be visible to subscribers. Fetching every dialog may take longer on accounts with hundreds of conversations, but avoids silently hiding older or archived channels. Refreshing from the chooser updates the list in place instead of navigating back to the selected drive.

Only the channel ID is persisted. The current `inputEntity` is retained in memory because it contains session-specific Telegram addressing information.

The channel screen and the drive's channel dropdown can call `createPrivateChannel()`. The dropdown exposes an inline name form, so creating storage never requires leaving the drive. Creation uses Teleproto's native `createChannel()` method without `megagroup`, producing a private broadcast channel with the user-supplied title. The returned channel is converted to a `CloudChannel`, selected immediately, and persisted. Channel-limit and empty-title errors receive user-friendly messages.

## Message mapping

`toCloudItem()` ignores messages without a photo or document. Classification order is:

1. Telegram photo or an `image/*` MIME type → `image`;
2. Telegram video or a `video/*` MIME type → `video`;
3. Telegram audio or an `audio/*` MIME type → `audio`;
4. everything else with a document → `file`.

When Telegram does not provide a filename, the UI creates one from the kind and message ID. File sizes and dates may arrive as JavaScript numbers or Teleproto big-integer values, so `asNumber()` normalizes them.

## Pagination, search, and memory

History pages use `getMessages()` with a default limit of 100. Newest-first pagination uses the lowest raw message ID as the next `offsetId`; oldest-first pagination passes Teleproto's `reverse` option and uses the highest ID. `hasMore` remains true only when Telegram returns a full raw page. The sidebar count represents media items discovered so far and includes `+` until `hasMore` becomes false.

The offset must be based on all returned messages, not only mapped media items. Otherwise pages containing text/service messages could cause duplicates or skipped history.

An `IntersectionObserver` in `DriveScreen` requests the next page when the bottom sentinel is within 300 pixels of the viewport.

When a filename search is active, `DriveScreen` automatically requests remaining pages until the channel has been fully checked. Only matching entries render cards; nonmatching entries remain compact metadata and never allocate thumbnail Blob URLs.

`CloudItem` deliberately excludes the original Teleproto message object. Thumbnail, preview, and download operations resolve the current message by channel and ID only when needed. `TelegramDrive` keeps a bounded 300-entry LRU of recently returned messages so current-page thumbnails and clicks avoid redundant Telegram requests without allowing a 10,000-file object graph to accumulate. The gallery is split into observed chunks: chunks outside the adaptive near-viewport margin unmount cards, revoke object URLs, and preserve a measured spacer so scroll position remains stable. Each chunk is a multiple of the current responsive column count, preventing chunk boundaries from leaving artificial partial rows. The final loading row reserves missing cells with placeholders until another page fills it. The configured memory budget defaults to 1 GB and controls the prefetch margin and preview ceiling; `navigator.deviceMemory`, when available, can lower the effective budget for smaller devices.

## Thumbnails

Images and videos prefer thumbnail index `1`, a modest quality increase over Telegram's smallest thumbnail without loading each original. Media with only one usable thumbnail falls back to index `0`. If the browser cannot decode that response, the component evicts it and retries once with Telegram's largest available thumbnail; a second failure falls back to the file-type icon rather than displaying a broken-image glyph. The versioned cache key is:

```text
v3:<channel ID>:<message ID>
```

This prevents collisions between different channels whose message IDs happen to match and invalidates older low-resolution entries. Thumbnail failures are non-fatal; the card falls back to a type icon.

## Uploads

Files use a deterministic two-step Teleproto path: `client.uploadFile()` returns a Telegram `InputFile`, then `client.sendFile()` posts that handle to the selected channel:

- the original browser picker `File` is passed without cloning or base64 conversion;
- browser files are sliced into bounded upload parts instead of first being copied into one whole-file `Buffer`;
- the original size is supplied;
- browser MIME and explicit filename/video/audio attributes are retained;
- only MP4/M4V is marked as streamable, avoiding Telegram content-type errors for containers such as MKV or AVI;
- images are sent as documents so Telegram retains their original bytes and filename instead of recompressing them as chat photos;
- `workers: 1` keeps each file's upload conservative;
- the UI processes multiple selected files sequentially.

Foreground sync has no application-level selection-count cap. It persists only lightweight queue records, retains current-page `File` references, and feeds the same upload method sequentially. A two-minute no-progress watchdog aborts a stalled request. Transient failures retry up to five times with exponential backoff; detected Telegram flood waits are honored for a bounded foreground interval, and offline time does not consume retry attempts. A failed item does not block later queue entries.

Two default-off naming controls are applied only when a new queue entry is created:

- date prefixing sends `YYYY-MM-DD__original-name` using `File.lastModified`, the date made available by the system picker;
- duplicate-name prevention normalizes outgoing names with Unicode NFKC, trims them, and compares case-insensitively against discovered channel items and every local queue record for that channel.

The duplicate check is intentionally best-effort. It catches duplicates in the current selection, the persistent local queue, and history already loaded by the gallery. It does not pull the entire channel before an upload because that would make syncing a very large channel slow and flood-wait prone. It compares names rather than content hashes, so same bytes under different names are allowed and different bytes under the same name are skipped. Neither setting renames an existing Telegram message or the source file.

When every member of a new batch is `done`, `writeSyncCheckpoint()` sends a text message beginning with `UCS_SYNC_V1`. `toCloudItem()` already ignores text-only messages, so checkpoints never appear in the gallery. The JSON contains aggregate non-secret audit data only. It is not a full content manifest and must never contain credentials, session strings, absolute paths, EXIF location, or original bytes.

Because browser file capabilities cannot be reconstructed after reload, incomplete records become `needs-file`. They are presented as a dismissible unfinished sync rather than a mandatory reselection flow. Dismissing removes only those local records and incomplete batch metadata; it never deletes Telegram files. Starting a new sync performs the same cleanup automatically, so stale entries cannot block a new selection. Within the same page lifetime, picker metadata remains a resume fingerprint rather than a cryptographic content hash.

Cancellation sets Teleproto's callback-specific `isCanceled` property when the `AbortSignal` fires. Test cancellation after every Teleproto upgrade because this convention is library-specific.

Teleproto 1.228's runtime checks generic objects before browser files and its `CustomBuffer` constructor recognizes only Node `buffer`/`filePath` sources. This can produce either `Cannot use [object File] as file` on desktop or `Either one of buffer or filePath should be specified` in installed iOS/Android PWAs. `vite.config.ts` corrects the low-level upload path: browser files are recognized by stable Blob capabilities (`slice()` plus a finite `size`) instead of realm-sensitive `instanceof File`, `CustomBuffer` accepts the browser source, and each Telegram part is read from a Blob slice. `TelegramDrive.upload()` deliberately calls that low-level API first with the real picker `File`; this also retains Teleproto's whole-buffer compatibility behavior if an untransformed dependency is ever loaded. The later `sendFile()` call receives only Teleproto's own `InputFile`, so its ambiguous browser-file/media conversion is bypassed on every platform. Vite uses a versioned dependency-cache directory to prevent application code from being paired with an older optimized Teleproto build. Revalidate these narrow transforms and bump that cache version after every relevant Teleproto patch change.

Teleproto 1.228's custom `File.duration`, `width`, and `height` getters also pass an array directly as the right-hand side of `instanceof`. Reading video duration after a completed upload therefore used to throw `Right-hand side of 'instanceof' is not callable`. The app reads the concrete video/audio attribute instead, and the build transform corrects the dependency getter for any future call site.

### Format support

| Category | Storage and download | In-app preview |
| --- | --- | --- |
| Images | All image files are retained as original Telegram documents | Formats decoded by the browser, commonly JPEG, PNG, GIF, WebP, SVG, and AVIF; HEIC/TIFF support varies |
| Videos | All containers can be uploaded and downloaded; common extensions and `video/*` MIME types are categorized as video | Depends on browser container and codec support; MP4/H.264 and WebM are the most portable |
| Audio | All audio files can be uploaded and downloaded; common extensions and `audio/*` MIME types are categorized as audio | Depends on browser codec support |
| Documents, archives, and other files | All binary file types are uploaded and downloaded without an `accept` filter | Generic documents deliberately use download rather than an embedded renderer |

An unsupported preview never means an unsupported stored file. The viewer reports the codec limitation and offers **Download original**. Telegram-controlled per-file and account limits still apply.

## Downloads and previews

Normal downloads use Teleproto's native in-memory result and a temporary download anchor, which hands the completed file to Chrome's standard download manager. Files above 750 MB use `showSaveFilePicker` when available and pass a custom ordered writer to `downloadMedia()`, writing Telegram chunks directly to disk without retaining the full video in memory. Browsers without a writable file handle warn before using the large in-memory fallback.

Video and audio first use progressive same-origin byte-range playback. `Viewer` creates a random, short-lived stream token; the native media element requests ranges from `__telegram_stream__/<token>/<size>`; the service worker forwards each request to the owning page over a `MessageChannel`; and `TelegramDrive.iterDownload()` fetches at most 1 MB from Telegram. Both normal and suffix ranges are supported so MP4 files whose index is stored at the end can initialize and seek. The media element uses `preload="metadata"` rather than encouraging Chrome to fetch the full resource. When seeking abandons an HTTP request, its `Request.signal` sends a request-ID cancellation message to the page and aborts Teleproto's matching `iterDownload()` signal, freeing the download slot instead of finishing an obsolete range. The native player exposes its normal seek bar, and the viewer adds a buffered-range bar. Closing or changing the file removes the token and aborts every outstanding range; no media response enters Cache Storage, and the browser controls eviction of old decoded/buffered data.

If progressive playback cannot be opened at all because service workers are unavailable or stale, video/audio use the complete-Blob compatibility path within the memory ceiling. Once progressive playback has started, a runtime range or decoder error never silently starts a full-file download: the viewer stops the stream and offers **Retry stream** or **Download original**. Images always use the Blob path. The effective-memory tiers allow 128 MB at 256 MB, 384 MB at 512 MB, 768 MB at 1 GB, and up to 1.5 GB at 2 GB. This retains original preview quality for files within budget instead of downsampling them. Opening the viewer pauses/aborts gallery thumbnail transfers and automatic search/history pagination so the original media request is not stuck behind stress-test traffic. A cached thumbnail is shown immediately behind the loading indicator when available. While the viewer is open, `ArrowLeft` and `ArrowRight` move through the current filtered gallery, visible buttons provide the same navigation, and `Escape` closes the viewer.

Teleproto 1.228 also assumes Node's `fs.WriteStream` constructor exists while closing every download writer. The browser `fs` polyfill intentionally does not provide that constructor, so the unguarded `instanceof` check otherwise throws `Right-hand side of 'instanceof' is not an object` for thumbnails, previews, and downloads. Its TL serializer also rejects typed byte-array views that are not instances of the exact bundled `Buffer`, producing `Bytes or str expected, not object` when serializing Telegram file references. `vite.config.ts` applies narrow source transforms that guard `WriteStream` and convert typed views to the active `Buffer`. The transforms run in both Vite's development dependency optimizer and normal production build; they do not modify `node_modules` or relax the production CSP.

Current safety guardrails:

- complete-Blob previews above the adaptive memory ceiling are disabled;
- progressive responses are capped at 1 MB, cancelled when abandoned, and explicitly marked `no-store`;
- files above 750 MB use direct-to-disk saving when supported, otherwise require confirmation;
- `AbortSignal` is used when closing a preview;
- object URLs are revoked during cleanup.

Direct-to-disk downloads are streamed and memory-bounded where the browser exposes the native save-file API. Image preview, progressive-playback fallback, and fallback download remain Blob-based. Progressive playback itself relies on service workers, HTTP range semantics, and a media container/codec the current browser can decode.

## Browser compatibility transforms

Teleproto's shared Node/browser code contains several Node assumptions in version 1.228. `vite.config.ts` narrowly corrects timer `.unref()`, typed-byte serialization, download `fs.WriteStream` checks, browser-file chunk reads, browser MIME propagation, and multi-class file-attribute lookups. The corrections run in Vite's development optimizer and production pipeline, do not edit `node_modules`, and replace the former global `Number.prototype` timer shim.

Every correction checks the exact expected source count. A changed dependency implementation therefore fails the build with an upgrade message instead of silently applying a partial patch. Recheck and preferably remove individual transforms as upstream becomes browser-safe.

History reads and media-part requests use explicit timeouts. This prevents the interface from displaying a permanent loading state when a Telegram request stops making progress. The gallery also holds an in-flight pagination lock and rejects non-advancing offsets to prevent repeated loading of the same page.

## Delete semantics

Single deletion calls `deleteMessages(channel, [messageId], { revoke: true })`. Batch deletion sends at most 100 message IDs per Telegram request. Both permanently remove the underlying Telegram channel messages, then remove their cached thumbnails, and the UI confirms before making the request.

There is no application trash or undo. Any future soft-delete feature needs Telegram-backed metadata or a second archive channel; a local-only flag would not synchronize across devices.

## Error handling

Raw Telegram errors are mapped by `friendlyError()` in `App.tsx`. Known credential, phone, code, password, flood-wait, cancellation, and network cases receive user-safe text. Avoid printing raw auth errors to the console because library errors can include sensitive request context.

When adding a Telegram operation, handle at least:

- authorization expiry;
- network disconnect/reconnect;
- `FLOOD_WAIT`;
- missing channel permission;
- deleted/unavailable media;
- cancellation;
- values represented as big integers.
