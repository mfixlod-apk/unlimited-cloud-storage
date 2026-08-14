# Unlimited Cloud Storage

A browser-only personal file and media drive backed by one of your private Telegram channels. The app is a static React PWA: it has no custom backend, and file traffic goes directly between the browser and Telegram over MTProto WebSockets.

Developer documentation is indexed in [`docs/README.md`](docs/README.md).

## What works

- Bring-your-own Telegram `api_id` and `api_hash`
- Real Telegram QR login, including two-step verification
- Phone-number login fallback
- Session restore from IndexedDB
- Private broadcast-channel creation, selection, rename, and owner-confirmed deletion
- Paginated, month-groupable gallery that prefers recognizable filename dates and falls back to Telegram dates, with newest/oldest ordering, cached thumbnails, infinite scroll, and keyboard previous/next viewing
- Channel switching from the desktop sidebar and mobile drive header
- Full-history filename search and media-type filters
- Adaptive off-screen gallery unloading with a configurable 1 GB default memory budget
- Foreground **Sync now** for very large picker/directory selections, including recursive subfolders, repeatable picker batches that append while uploading, a durable metadata queue, bounded three-part Telegram uploads, a simple file-ratio ETA, pause/resume, stall detection, five-attempt retry, optional duplicate-name skipping, and date-prefixed upload names
- Exact-byte image/document storage, broad video/audio uploads, local HEIC/HEIF-to-JPEG preview fallback, progressive video/audio playback with seeking and a buffer bar, single/bulk downloads, and confirmed permanent deletion
- Gallery selection mode with select-all-visible, multi-file download, and confirmed batch deletion
- Responsive desktop/mobile UI with a safe-area-aware phone navigation bar and installable PWA shell
- Persisted light/dark appearance with a three-part, responsive product and security overview
- Separate controls for clearing thumbnails, forgetting a browser, and revoking the Telegram session

## Run locally

Requirements: Node.js 20 or newer and a modern browser with IndexedDB, WebSocket, and Web Crypto support.

```bash
npm install
npm run dev
```

Open the local address shown by Vite. Obtain personal API credentials from [my.telegram.org/apps](https://my.telegram.org/apps), then use QR login or the phone fallback.

On desktop onboarding, the compact Telegram connection form remains fixed while the wider product overview on the left scrolls independently through direct-connection, everyday-use, and session-control sections. Dark mode can be changed later in **Settings → Appearance** and is retained on this browser.

On phones, the same home page has a persistent top bar: **Log in** jumps to the Telegram form, while an authenticated session shows **Open drive**. From inside the drive, selecting the Unlimited Cloud Storage logo returns home without disconnecting Telegram or discarding the active drive state.

For QR login in the official Telegram app, open **Settings → Devices → Link Desktop Device** and scan the code shown by Unlimited Cloud Storage.

Production check:

```bash
npm run typecheck
npm run build
npm run preview
```

## Storage setup

Create a private Telegram channel from Unlimited Cloud Storage or in the official client. The chooser lists private and public broadcast channels, labels their visibility, and warns before selecting a public channel. Group chats are excluded. The selected channel's media-message history is the source of truth.

Do not use this project as the only copy of critical data. Telegram is a messaging service, not an object-storage SLA, and Telegram controls account, API, rate, and per-file limits.

## Security model

- No API credentials, sessions, phone numbers, channel IDs, or encryption keys are included in the source or build.
- “Keep me signed in” is off by default. When explicitly enabled, the API credentials and serialized Telegram session are stored only in this browser profile's IndexedDB.
- Login codes and two-step verification passwords are kept in memory only for the active authentication request.
- Thumbnail blobs are disposable IndexedDB cache entries. Original files are never stored in the service-worker cache.
- The app has no analytics and does not place secrets in URLs or logs.
- Transfers use a single upload worker and bounded download concurrency to reduce flood-wait and memory pressure.
- A restrictive Content Security Policy is included in `index.html`.

Private Telegram channels are not zero-knowledge storage. Telegram can process the uploaded content. Sensitive files should be encrypted before upload; application-managed end-to-end encryption is deliberately outside this MVP.

“Forget this browser” removes only local credentials, the session, the selected-channel reference, and cached thumbnails. “Log out of Telegram” additionally revokes this app's current Telegram authorization.

## GitHub Pages

The included workflow builds and deploys `dist/` without repository secrets. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**, then push to `main`.

Vite uses a relative base path, so both user/organization Pages and project Pages URLs work.

## Architecture

```text
GitHub Pages → static PWA shell
Browser      → React UI + IndexedDB + Teleproto
Telegram     → private channel history and file storage
```

The maintained [`teleproto`](https://docs.teleproto.dev/) MTProto client is used with its browser WebSocket transport. The PWA caches only versioned static application assets.

## Known constraints

- Video and audio first use same-origin progressive byte-range playback: the browser pulls 1 MB or less at a time, cancels abandoned Telegram requests when seeking, and manages eviction of previously buffered ranges. A playback interruption offers an explicit stream retry instead of silently loading the full file. Images and the initial compatibility fallback still use an in-memory Blob bounded by the configured memory tier: 128 MB at 256 MB, 384 MB at 512 MB, 768 MB at 1 GB, and up to 1.5 GB at 2 GB. Downloads stream directly to a chosen file in browsers with the File System Access API; other browsers use a Blob fallback and warn before very large downloads.
- Every file type can be uploaded and downloaded as a Telegram document. HEIC/HEIF images that Chrome cannot display natively are decoded to a temporary JPEG on this device; the stored original is unchanged. Other inline image/video/audio preview depends on browser container and codec support, and unsupported media remains downloadable.
- Desktop, iOS/Android browser, and installed-PWA uploads use the original picker Blob and read bounded Telegram parts rather than copying the whole file into one JavaScript buffer.
- Telegram has an album API, not a general bulk-file transfer endpoint: album members must still be uploaded separately. The app therefore retains per-file retry/accounting and keeps one file active, while allowing up to three bounded parts of that file in flight as recommended by Telegram's file API.
- Folder selection is recursive. Supporting desktop browsers are walked explicitly and enqueued in 100-file metadata batches; `webkitdirectory` browsers, including supported mobile versions, provide all descendant files with their relative paths.
- The upload button remains an **Add files** action while syncing. Repeated mobile-picker batches are serialized into the same FIFO queue, so selecting roughly 100 items at a time can build a queue of 1,000 or more without starting parallel Telegram upload workers. The practical ceiling still depends on browser/OS memory for live `File` references.
- The optional `YYYY-MM-DD__` upload prefix reads embedded capture dates from supported HEIC/HEIF, JPEG, PNG, TIFF, and AVIF images before trying a recognizable filename date and then the browser file's last-modified date. Only date fields are used; GPS metadata is not copied into the filename. Existing Telegram items are not renamed.
- Duplicate-name prevention compares normalized names already discovered in the selected channel and its local queue. It deliberately does not force a full-history scan before every upload, so an older unloaded duplicate can still exist.
- An active filename search scans remaining history pages automatically. Very large channels can therefore take time and remain subject to Telegram flood waits.
- Uploads and downloads must remain in the foreground on mobile browsers. An iOS Dynamic Island Live Activity would require a native app and would display progress only; it cannot grant a PWA background execution.
- The PWA cannot permanently enumerate an iPhone/Android photo library or wake reliably on a schedule. After reload, inaccessible unfinished entries can be dismissed and new files selected normally; dismissing removes only local queue metadata.
- Telegram flood waits, per-file limits, and account restrictions still apply.

This project is independent and is not affiliated with or endorsed by Telegram.

## License

MIT
