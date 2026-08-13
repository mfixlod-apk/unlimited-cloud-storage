# Unlimited Cloud Storage

A browser-only personal file and media drive backed by one of your private Telegram channels. The app is a static React PWA: it has no custom backend, and file traffic goes directly between the browser and Telegram over MTProto WebSockets.

Developer documentation is indexed in [`docs/README.md`](docs/README.md).

## What works

- Bring-your-own Telegram `api_id` and `api_hash`
- Real Telegram QR login, including two-step verification
- Phone-number login fallback
- Session restore from IndexedDB
- Private broadcast-channel creation and selection
- Paginated, month-groupable gallery with newest/oldest ordering, cached thumbnails, infinite scroll, and keyboard previous/next viewing
- Channel switching from the desktop sidebar and mobile drive header
- Full-history filename search and media-type filters
- Adaptive off-screen gallery unloading with a configurable 1 GB default memory budget
- Foreground **Sync now** for very large picker/directory selections, with a durable metadata queue, sequential bounded-memory uploads, pause/resume, stall detection, five-attempt retry, optional duplicate-name skipping, and date-prefixed upload names
- Exact-byte image/document storage, broad video/audio uploads, progressive video/audio playback with seeking and a buffer bar, single/bulk downloads, and confirmed permanent deletion
- Gallery selection mode with select-all-visible, multi-file download, and confirmed batch deletion
- Responsive desktop/mobile UI with a safe-area-aware phone navigation bar and installable PWA shell
- Separate controls for clearing thumbnails, forgetting a browser, and revoking the Telegram session

## Run locally

Requirements: Node.js 20 or newer and a modern browser with IndexedDB, WebSocket, and Web Crypto support.

```bash
npm install
npm run dev
```

Open the local address shown by Vite. Obtain personal API credentials from [my.telegram.org/apps](https://my.telegram.org/apps), then use QR login or the phone fallback.

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
- Every file type can be uploaded and downloaded as a Telegram document. Inline image/video/audio preview depends on the browser supporting that file's container and codec; unsupported media remains downloadable.
- Desktop, iOS/Android browser, and installed-PWA uploads use the original picker Blob and read bounded Telegram parts rather than copying the whole file into one JavaScript buffer.
- The optional `YYYY-MM-DD__` upload prefix uses the date exposed by the device file picker (normally the file modification/capture date). It does not rewrite existing Telegram items or expose location metadata.
- Duplicate-name prevention compares normalized names already discovered in the selected channel and its local queue. It deliberately does not force a full-history scan before every upload, so an older unloaded duplicate can still exist.
- An active filename search scans remaining history pages automatically. Very large channels can therefore take time and remain subject to Telegram flood waits.
- Uploads and downloads must remain in the foreground on mobile browsers. An iOS Dynamic Island Live Activity would require a native app and would display progress only; it cannot grant a PWA background execution.
- The PWA cannot permanently enumerate an iPhone/Android photo library or wake reliably on a schedule. After reload, inaccessible unfinished entries can be dismissed and new files selected normally; dismissing removes only local queue metadata.
- Telegram flood waits, per-file limits, and account restrictions still apply.

This project is independent and is not affiliated with or endorsed by Telegram.

## License

MIT
