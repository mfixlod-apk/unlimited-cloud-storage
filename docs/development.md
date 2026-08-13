# Development guide

## Requirements

- Node.js 20 or newer; CI currently uses Node.js 22.
- npm.
- A modern browser with WebSocket, Web Crypto, IndexedDB, Blob URLs, and service-worker support.
- Personal Telegram API credentials and a private broadcast channel for live integration testing.

## Commands

```bash
npm install
npm run dev
```

Validation commands:

```bash
npm run typecheck
npm run build
npm run preview
npm audit --omit=dev
```

The service worker registers in development and production because progressive video/audio uses its same-origin byte-range bridge. A worker registered with the development query flag skips all application-shell caching. Use `npm run preview` when testing installation, offline shell behavior, cache upgrades, or GitHub Pages paths.

The Vite dev server also applies a development-only CSP transform that permits inline styles for CSS hot replacement. Production keeps `style-src 'self'` and does not include that relaxation.

## Repository layout

```text
.
├── .github/workflows/deploy-pages.yml
├── docs/
├── public/
│   ├── manifest.webmanifest
│   ├── service-worker.js
│   └── icons
├── src/
│   ├── App.tsx
│   ├── icons.tsx
│   ├── main.tsx
│   ├── storage.ts
│   ├── styles.css
│   └── telegram.ts
├── index.html
├── package.json
└── vite.config.ts
```

Generated `dist/`, `node_modules/`, TypeScript build information, and emitted Vite config files are ignored.

## Development boundaries

- Put Telegram behavior in `TelegramDrive`, not React components.
- Put IndexedDB operations in `localStore`, not `TelegramDrive` consumers.
- Keep raw Teleproto messages behind `TelegramDrive`; `CloudItem` intentionally contains only lightweight serializable metadata.
- Keep user-visible state and prompts in React.
- Keep credentials and the Telegram client out of the service worker. Its media bridge may request bounded bytes from the owning page only through a one-use-in-memory token.
- Reuse the local SVG icon system rather than adding a large component dependency for a few icons.

## Common change recipes

### Add a new file category

1. Extend `ItemKind` in `src/telegram.ts`.
2. Update `toCloudItem()` classification.
3. Add the filter and icon in `DriveScreen`.
4. Add viewer behavior if the type is previewable.
5. Verify unknown MIME types still fall back to `file`.

### Add a Telegram operation

1. Add a method to `TelegramDrive`.
2. Accept plain domain values or `CloudItem`/`CloudChannel`, not UI events.
3. Include progress and `AbortSignal` support for transfers.
4. Translate the result into an app-level type.
5. Handle errors in the UI through `friendlyError()`.
6. Review flood-wait, permission, reconnection, and cancellation behavior.

### Add persistent configuration

1. Decide whether the setting is safe to store unencrypted.
2. Add accessors to `localStore`.
3. If a new object store or schema change is needed, increment the DB version and write an upgrade path.
4. Include it in clearing behavior if appropriate.
5. Document it in `storage-and-security.md`.

### Change the PWA shell

1. Edit `public/service-worker.js`.
2. Increment `CACHE_NAME`.
3. Keep caching limited to same-origin GET requests.
4. Build and preview the production output.
5. In browser developer tools, verify Telegram requests are absent from Cache Storage.
6. Test an online load followed by an offline reload.

### Split `App.tsx`

Suggested direction:

```text
src/
├── app/App.tsx
├── auth/CredentialsScreen.tsx
├── auth/AuthScreen.tsx
├── channels/ChannelScreen.tsx
├── drive/DriveScreen.tsx
├── drive/MediaCard.tsx
├── drive/Viewer.tsx
└── settings/SettingsPanel.tsx
```

Move components without moving Telegram or IndexedDB logic into them. Preserve the top-level stage machine until a tested routing/state solution replaces it.

## Manual test matrix

There is currently no automated Telegram integration suite because it would require a real account and session. Before release, manually test:

### Authentication

- valid QR login;
- QR expiry/refresh;
- closing or switching away from an active QR flow;
- QR login with Telegram 2FA enabled;
- phone login with in-app code;
- incorrect and expired phone codes;
- incorrect 2FA password;
- invalid API ID/hash;
- reload after choosing “Keep me signed in”;
- reload with persistence disabled.

### Channels and history

- private and public broadcast channels are listed, with public channels labeled and confirmed before use;
- public channels are hidden by default and can be toggled from the chooser/sidebar;
- a newly created channel appears after refresh;
- channel creation in the app selects the new private broadcast channel;
- channel creation is available from the channel chooser;
- saved channel restoration;
- mixed photo, video, audio, document, text, and service messages;
- multiple history pages without duplicates or gaps;
- empty channel and empty search states.
- month grouping across year boundaries;
- switching between newest-first and true Telegram oldest-first pagination;
- `+` remains on the discovered-file count until history reaches the beginning;
- active search scans to the beginning and finds names outside the initially loaded pages;
- off-screen gallery chunks unmount without visible scroll jumps when returning upward;
- gallery chunk boundaries stay aligned to desktop/mobile column counts and loading placeholders fill only the incomplete tail row;

### Transfers

- single and multiple file upload;
- drag-and-drop upload;
- upload cancellation and retry after cancellation;
- image/video/audio preview;
- progressive video/audio startup before the full file downloads, forward/backward seeking, and the visible buffered-range bar;
- repeated long-distance seeks cancel superseded Telegram ranges and do not begin a full-file Blob load;
- MP4 playback where metadata is at the end of the file (suffix-range path);
- closing/changing a progressive preview expires its URL and does not create a Cache Storage entry;
- bridge initialization failure falls back to a Blob within the memory ceiling, while runtime playback failure offers stream retry/download without a silent full-file load;
- opening a preview during rapid scrolling pauses thumbnail work and displays its cached poster while loading;
- invalid thumbnail cache entries retry once at a larger Telegram size and then fall back cleanly to an icon;
- viewer `ArrowLeft`, `ArrowRight`, visible previous/next controls, and `Escape`;
- generic-file download;
- native save-file streaming plus the Blob download fallback;
- large preview guard and large-download warning;
- 256 MB, 512 MB, 1 GB, and 2 GB memory-limit behavior, including device-memory adjustment;
- deleting a message and confirming it disappears in Telegram;
- network loss during upload/download.

### Local data and PWA

- thumbnail cache hit after reload;
- clear thumbnails without losing the session;
- forget browser without deleting Telegram files;
- logout revokes the session in Telegram Devices;
- installability on desktop and mobile;
- same-origin assets available offline;
- Telegram requests and progressive media responses absent from service-worker caches.

### Responsive and accessibility

- widths near 390 px, 580 px, 900 px, and desktop;
- keyboard navigation through forms and primary actions;
- visible focus states;
- dialog close controls and backdrop behavior;
- reduced-motion preference;
- long filenames and long channel/account names.

## Debugging

### Connection fails immediately

Check API credential pairing, browser WebSocket restrictions, VPN/firewall behavior, and the browser console for CSP or missing-polyfill failures. Do not ask users to paste session strings into issue reports.

### QR does not refresh

Confirm the component's `AbortController` was not triggered, the same client remained connected, and Teleproto still reports token/timeouts in the form expected by `loginWithQr()`.

### History repeats or skips items

Inspect the raw page IDs and ensure `nextOffset` is calculated from all raw messages, including unsupported text/service messages.

### Thumbnail is blank

Clear the thumbnail cache, verify the message actually has a Telegram thumbnail, and test whether thumbnail index `1` remains supported after a Teleproto upgrade. Missing thumbnails should fall back to an icon rather than fail the gallery.

### Browser upload says `Cannot use [object File] as file`

Confirm `TelegramDrive.upload()` still creates the marked browser `File` clone described in `telegram-integration.md`. This compensates for Teleproto 1.228's browser-file branch ordering. Check upstream behavior after upgrading Teleproto before changing or removing the marker.

### Preview or download reports an invalid `instanceof` right-hand side

Teleproto 1.228 checks download writers against Node's unavailable browser `fs.WriteStream`. Confirm that both `teleproto-browser-fixes` registrations remain in `vite.config.ts`: one handles optimized development dependencies and one handles production builds. Restart the dev server after changing the Vite configuration so its dependency cache is regenerated. Revalidate the narrow transforms whenever Teleproto is upgraded.

### Preview reports `Bytes or str expected, not object`

Telegram file references may arrive as typed byte-array views rather than the exact `Buffer` constructor instance expected by Teleproto's serializer. Confirm the `tl/runtime/helpers.js` typed-byte transform remains enabled in both Vite transform paths, then rebuild the production bundle.

### Video reaches 100%, then reports a non-callable `instanceof`

Teleproto 1.228's custom file metadata helper incorrectly executes `attribute instanceof constructors` where `constructors` is an array. `TelegramDrive.toCloudItem()` must read `message.video.duration` or `message.audio.duration`, not `message.file.duration`. The `tl/custom/file.js` correction in `vite.config.ts` also makes the dependency getter safely test each callable constructor.

### Production works differently from development

Both environments enable the service worker, but development disables its shell cache. Production also uses relative asset paths. Unregister old service workers and clear Cache Storage when diagnosing stale resources, then increment `CACHE_NAME` for intentional shell changes. If progressive playback falls back after deployment, confirm the active worker answers the `telegram-stream-ping` handshake and that range responses are `206` with `Cache-Control: no-store`.

## Deployment

`.github/workflows/deploy-pages.yml` runs on pushes to `main` and manual dispatches:

1. check out the repository;
2. install Node.js 22 with npm caching;
3. run `npm ci`;
4. run the production build;
5. upload `dist/` as the Pages artifact;
6. deploy through GitHub Pages.

No Telegram secrets belong in the workflow. Configure the repository's Pages source as **GitHub Actions**. Because Vite uses `base: "./"`, project-site subpaths work without repository-name-specific configuration.

## Release checklist

- Update documentation for changed boundaries or limitations.
- Run type checking and the production build.
- Run the production dependency audit.
- Complete the relevant manual test matrix with a private test channel.
- Inspect `dist/index.html`, the manifest, and the served service worker.
- Check desktop and mobile layouts in a production preview.
- Confirm no credential, session, phone, or channel test values were committed.
