# Storage and security

## Security boundary

The application assumes every static source file and bundled value is public. Security depends on runtime user-supplied credentials, browser-local session material, Telegram authorization, and a private target channel—not on hiding values in frontend code.

The app does not provide end-to-end or zero-knowledge encryption. Telegram receives the original uploaded files. Users should encrypt sensitive files before upload until optional client-side encryption is designed and implemented.

## IndexedDB schema

[`src/storage.ts`](../src/storage.ts) opens database `unlimited-cloud-storage` at version `4` with four object stores. Versions 2 and 3 clear only obsolete thumbnail entries. Version 4 adds durable foreground-sync metadata while preserving connection, memory-limit, channel, and thumbnail data.

### `config`

| Key | Value | Purpose |
| --- | --- | --- |
| `connection` | `{ apiId, apiHash, session }` | Restore the Telegram client when the default-off “Keep me signed in” option is enabled |
| `channelId` | `string` | Rediscover and restore the selected broadcast channel |
| `memoryLimitMb` | `number` | User-selected gallery/preview memory budget; defaults to 1024 MB |
| `preventDuplicateNames` | `boolean` | Skip newly selected uploads whose normalized outgoing filename is already known in the selected channel/local queue; defaults to false |
| `datePrefixUploads` | `boolean` | Prefix new outgoing filenames with `YYYY-MM-DD__` from embedded image capture metadata or a recognizable filename date; supported photos without either remain unprefixed; defaults to false |
| `theme` | `"light"` or `"dark"` | Browser appearance preference; defaults to the operating-system preference until explicitly selected |

### `thumbnails`

| Key | Value | Purpose |
| --- | --- | --- |
| `v3:<channelId>:<messageId>` | `Blob` | Disposable image/video thumbnail cache; the prefix versions thumbnail quality/recovery behavior |

### `uploadQueue`

One record is keyed by a channel-scoped fingerprint made from the picker-provided relative path, filename, size, and modification time. Records contain only queue metadata, attempts, state, and batch membership. Original file bytes and `File` objects are never stored here.

### `uploadBatches`

One record per foreground selection batch stores counts, total bytes, source-date bounds, completion state, and whether the Telegram checkpoint was sent. An active batch remains recoverable after reload; completed records allow a later selection on the same browser to skip matching files.

Telegram remains authoritative for the file list. Clearing IndexedDB must never delete Telegram files.

## Schema changes

When changing the database:

1. increment the version passed to `openDB()`;
2. add an upgrade branch that preserves existing connection records unless a security change requires invalidation;
3. document the old and new stores here;
4. test upgrading an existing browser profile, not only a fresh database;
5. ensure `clearAll()` includes every new store.

Do not store Teleproto `inputEntity` objects. They contain non-plain values, may not serialize reliably, and should be reconstructed after connecting.

## Secret lifetime

| Value | Lifetime |
| --- | --- |
| API ID and hash | React memory; IndexedDB only when persistence is enabled |
| Serialized Telegram session | IndexedDB only when persistence is enabled |
| Phone number | Active React authentication state only |
| Login code | Active callback/prompt only |
| Telegram 2FA password | Active callback/prompt only |
| QR token | Active QR image/polling request only |
| Channel input entity | Active in-memory Telegram session only |
| Picker `File` objects | Active page only; repeated selections append references to the same FIFO and each reference is released after upload |
| Upload queue and batch metadata | IndexedDB until the browser is forgotten or site data is cleared |

The app intentionally has no analytics, remote logging, query-string secrets, or public build-time credential variables.

## Forgetting versus logging out

These operations must remain distinct:

- **Forget this browser** disconnects the local client and clears IndexedDB. It does not revoke the corresponding Telegram authorization on Telegram's servers.
- **Log out of Telegram** calls Teleproto's logout operation first, revoking the current authorization, then disconnects and clears IndexedDB.
- **Clear thumbnail cache** removes only thumbnail blobs. It must not remove connection or channel configuration.
- **Forget this browser** also clears upload queue and batch metadata. It never deletes files or checkpoint messages from Telegram.
- The non-sensitive appearance preference is restored after Forget/Logout cleanup so changing account state does not unexpectedly change the interface theme.

If logout cannot reach Telegram, the current code still disconnects and clears local state. The user may need to revoke the device manually from Telegram's Devices screen.

## Service-worker cache

[`public/service-worker.js`](../public/service-worker.js) currently maintains cache `unlimited-cloud-storage-shell-v8`.

It caches only same-origin GET responses:

- the application navigation shell;
- compiled JavaScript and CSS encountered by the browser;
- the manifest and icons.

It exits before calling `respondWith()` for every cross-origin request. Telegram WebSockets, direct MTProto traffic, and external sites therefore bypass the service worker.

The one non-shell route is `__telegram_stream__/<random token>/<file size>`. It is created only in memory while a video/audio viewer is open. The worker validates the route and range, asks the owning browser page for at most 1 MB through a `MessageChannel`, and responds with `206 Partial Content`, `Accept-Ranges`, and `Cache-Control: no-store`. If the browser abandons a request while seeking, the request's abort signal cancels the corresponding Telegram iterator. The random token is removed and all outstanding ranges are aborted when the viewer closes or changes file. The worker has no Telegram session or IndexedDB access, and streamed bytes are never passed to `cache.put()`.

When changing shell behavior, increment `CACHE_NAME` so activation removes the previous app cache. Never add user-generated Blob URLs, progressive stream routes, API responses, Telegram hosts, or IndexedDB values to `APP_SHELL`.

## Content Security Policy

`index.html` contains a restrictive CSP:

```text
default-src 'self'
script-src 'self'
style-src 'self'
img-src 'self' data: blob:
media-src 'self' blob:
connect-src 'self' wss://*.web.telegram.org
worker-src 'self' blob:
manifest-src 'self'
font-src 'self'
frame-src 'none'
object-src 'none'
base-uri 'self'
form-action 'self'
```

`data:` is required for generated QR images; `blob:` is required for thumbnails and media previews. Network connections are restricted to same-origin traffic and Telegram's WebSocket data-center host family. Avoid introducing inline scripts or styles. GitHub Pages cannot supply arbitrary security headers, so a deployment behind another host should move this policy to an HTTP response header and add `frame-ancestors 'none'` there.

During `npm run dev`, the `development-csp` transform in `vite.config.ts` adds `'unsafe-inline'` to `style-src` because Vite injects CSS into a `<style>` element for hot replacement, and permits `ws:` for hot-module replacement. The transform runs only for Vite's `serve` command; production retains the strict policy and Telegram-only WebSocket allowlist.

## Dependency and cryptography notes

Teleproto expects Node-compatible crypto and binary APIs. Vite's Node polyfill plugin supplies them for the browser. Production builds may report a warning about `vm-browserify` containing an `eval` fallback. The CSP does not allow `unsafe-eval`; the relevant dependency catches that failure and uses its non-eval fallback. Re-test the complete login handshake whenever Teleproto or the polyfill stack changes.

HEIC/HEIF preview fallback uses `heic-to` 1.5.2 (LGPL-3.0-or-later), which bundles libheif 1.22.2. It is dynamically loaded only after native image decoding fails, uses the package's no-`unsafe-eval` CSP build, and processes the downloaded Blob locally. It does not add a network origin or weaken `script-src`. Treat every media decoder as an untrusted-file parser: keep it current, retain the preview-size ceiling, and do not persist converted JPEGs. Source and license: <https://github.com/hoppergee/heic-to>.

Capture-date naming uses `exifr` 7.1.3 (MIT) and lazy-loads it only when the setting is enabled for a supported image. The result filter includes only `DateTimeOriginal`, `CreateDate`, and `DateTimeDigitized`; modification and GPS values are not returned or used. It does not retain the parsed object, alter the original bytes, or send metadata over the network. Source and license: <https://github.com/MikeKovarik/exifr>.

`vite.config.ts` also applies narrowly checked browser corrections to known Teleproto 1.228 Node assumptions. They run during development dependency optimization and production builds, and fail the build if an upgrade changes the expected source. This avoids editing `node_modules` or installing global prototype shims.

Do not implement MTProto primitives locally. Prefer maintained library updates, review their changelogs, run dependency audits, and manually test authorization plus transfers before merging.

## Security checklist for changes

- No credentials, session strings, channel IDs, or phone numbers in source, logs, URLs, screenshots, fixtures, or CI configuration.
- New IndexedDB data is documented and removable through the appropriate settings action.
- Durable queues store metadata only; never persist thousands of original `File`/`Blob` values as a retry buffer.
- Service-worker changes still ignore cross-origin requests.
- Object URLs and abort controllers are cleaned up on unmount/cancellation.
- Destructive Telegram actions require explicit confirmation.
- Location metadata is never copied into outgoing filenames. A future location tag must be explicit opt-in, previewed before upload, coarse by default, and documented as permanently visible to Telegram/channel readers.
- Large files are not copied repeatedly or converted to base64.
- New external links use `noopener`/`noreferrer` when opened in a new tab.
- UI errors are useful but do not expose raw authentication request details.
- `npm audit --omit=dev` and the production build are checked before release.

## Threats not solved by the MVP

- A malicious browser extension or compromised browser profile can read local credentials/session data.
- Cross-device metadata does not exist beyond Telegram's native message information.
- Telegram or a party with access to the Telegram account can read unencrypted files.
- Telegram account restrictions, deletion, API changes, or rate limits can affect availability.
- The app is not an independent backup and should not hold the only copy of important data.
