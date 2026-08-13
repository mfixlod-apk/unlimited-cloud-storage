# Architecture

## System boundary

Unlimited Cloud Storage is a static browser application. There is no application server, proxy, database service, shared API credential, or server-side session.

```text
GitHub Pages
    │ serves HTML, CSS, JavaScript, manifest, and icons
    ▼
Browser
    ├── React UI
    ├── Teleproto MTProto client
    ├── IndexedDB session/config/thumbnail cache/sync queue metadata
    └── same-origin PWA shell cache
    │
    │ MTProto over WebSocket
    ▼
Telegram
    └── private channel containing one media message per file
```

Telegram channel history is authoritative for files. IndexedDB is a disposable device-local optimization and credential/session store. The service worker caches only static same-origin application resources; its authenticated-page media bridge returns short-lived byte ranges with `no-store` and never caches them.

## Runtime layers

### UI and orchestration

[`src/App.tsx`](../src/App.tsx) owns the current application state and all screens. It deliberately does not call Teleproto directly; it calls the exported `telegramDrive` service.

The top-level `Stage` state is the application state machine:

```text
boot
  ├── no saved connection ───────────────► credentials
  ├── restored but unauthorized ─────────► auth
  └── restored and authorized
          ├── no saved usable channel ───► channels
          └── saved channel available ───► drive

credentials ─► auth ─► channels ─► drive
                                  ◄─► home
```

Important screen components:

- `LandingScreen` presents the product overview and validates the user's API ID and hash, or shows the connected-account actions when opened from the drive.
- `AuthScreen` coordinates QR, phone-code, and 2FA callbacks.
- `ChannelScreen` displays eligible broadcast channels with an opt-in public-channel toggle.
- `DriveScreen` owns lightweight history metadata, filters, month grouping, uploads, bulk selection, viewer state, and infinite scrolling.
- `SettingsPanel` exposes upload naming/duplicate preferences, the memory budget, cache clearing, device forgetting, and Telegram logout.

On mobile, the active channel switcher sits in the title/navigation row beside the current file category, above search and sort/filter tools. Sync and Settings remain compact actions in the top app bar. The switcher reuses the same channel dropdown as desktop, including inline private-channel creation and the public-channel visibility toggle.

`App` owns the `light | dark` appearance state so the same theme covers onboarding, authentication, channel choice, the drive, and overlays. The saved preference is loaded from `localStore`, applied as `data-theme` on the root document element, and reflected in the browser theme-color metadata. Theme tokens live at the top of `styles.css`; components should use those tokens rather than adding theme-specific inline values.

Desktop credential onboarding is a viewport-height split layout that deliberately gives the editorial pane more space than the compact credential form. The editorial pane is the only independently scrollable side; the form stays fixed on the right. Its content is divided into three semantic sections: the direct browser-to-Telegram path, everyday device/configuration use, and local-session control. The hero introduces that path in plain text rather than repeating it in a separate badge or callout. Below 900 px both panes return to normal document flow so phone and tablet users get one accessible page rather than nested scrolling.

`home` is also available after authentication. Clicking either in-drive logo changes only the visible application stage; it does not disconnect or revoke the Telegram client. When a selected channel exists, the mounted `DriveScreen` remains in a hidden host behind the home page so active foreground transfers, picker `File` references, viewer/gallery state, and the previous scroll position survive the round trip. Explicit **Log out** or **Sign in to another account** actions still revoke the current Telegram authorization before returning to credential entry.

On mobile the landing navigation is fixed to the viewport. Its signed-out **Log in** button scrolls to the credentials section, and its authenticated **Open drive** button returns to the preserved workspace. The same navigation and marketing content is used at desktop and phone widths; only its layout and scrolling behavior change.

The UI is currently kept in one file because the product is still small. If `App.tsx` grows substantially, split by screen while keeping orchestration in `App` and Telegram operations behind `TelegramDrive`.

### Telegram boundary

[`src/telegram.ts`](../src/telegram.ts) wraps the Teleproto client. It is responsible for:

- constructing and disconnecting a single client;
- authorization flows;
- session serialization and private channel creation;
- channel discovery and filtering;
- converting Telegram messages to `CloudItem` objects;
- paginated history reads;
- thumbnail, original-file, progressive-range, upload, and delete operations.

UI code should not import `TelegramClient`, `Api`, or other Teleproto internals. Keeping one integration boundary makes future client-library upgrades much safer.

### Local persistence

[`src/storage.ts`](../src/storage.ts) is the only IndexedDB access layer. The UI and Telegram wrapper use the exported `localStore` methods rather than opening the database independently.

### PWA boundary

[`src/main.tsx`](../src/main.tsx) registers [`public/service-worker.js`](../public/service-worker.js) in development and production. Development registration disables application-shell caching but keeps the progressive media bridge testable. The worker ignores cross-origin requests, so Telegram WebSockets cannot enter the application-shell cache. Progressive media uses a same-origin, random-token route that asks the active page for one bounded Telegram byte range and returns it with `Cache-Control: no-store`.

## Domain model

`CloudChannel` is an eligible Telegram channel:

```ts
interface CloudChannel {
  id: string;
  title: string;
  inputEntity: unknown;
  isPublic: boolean;
  canWrite: boolean;
}
```

Only `id` is persisted. `inputEntity` belongs to the active Teleproto session and is rediscovered from the user's dialogs after reconnecting.

`CloudItem` is the UI representation of a Telegram media message:

```ts
interface CloudItem {
  id: number;          // Telegram message ID
  channelId: string;
  name: string;
  kind: "image" | "video" | "audio" | "file";
  mime: string;
  size: number;
  date: Date;
  duration?: number;
}
```

There is no separate file database. The Telegram message ID functions as the object ID, and deleting an item deletes that message from Telegram. Full Teleproto message objects are deliberately not retained for every item; a single message is resolved by ID only when an operation needs its media reference.

## Data flows

### Initial restoration

```text
Read connection from IndexedDB
  → construct StringSession and TelegramClient
  → connect over WebSocket
  → checkAuthorization
  → fetch account + eligible dialogs
  → match persisted channel ID
  → load newest history page
```

### History and thumbnails

```text
getMessages(limit: 100, offsetId)
  → discard messages without supported media
  → map remaining messages to lightweight CloudItem metadata
  → window cards into near-viewport chunks
  → read each thumbnail from IndexedDB
  → download Telegram thumbnail on cache miss
  → store disposable Blob in IndexedDB
```

Off-screen chunks unmount their card and thumbnail components, revoke Blob URLs, and retain only measured spacer height plus lightweight metadata. Chunk sizes are exact multiples of the responsive column count, and incomplete loading rows receive temporary placeholders. Active search continues pagination until history is exhausted; nonmatching entries never create cards or thumbnail URLs. Reversing order restarts Telegram pagination from the oldest end instead of merely reversing the currently loaded array.

### Upload

```text
File picker, directory picker, or drop
  → optionally prefix the outgoing name with the picker-provided media date
  → optionally skip a normalized name already discovered in this channel/queue
  → fingerprint and persist lightweight queue entries
  → retain picker File references for this page lifetime only
  → upload one file at a time with bounded retries
  → uploadFile reads bounded Blob slices and returns Telegram InputFile
  → sendFile posts that unambiguous handle to the selected channel
  → release the completed File reference
  → commit a small Telegram batch-checkpoint text message
  → refresh newest history page when the queue drains
```

The queue UI keeps aggregate counters and at most six recent rows rather than rendering every selected item. This keeps 10,000-file selections from creating a 10,000-node progress panel. IndexedDB stores metadata, not original bytes. After reload, unfinished records become `needs-file`; the notice can be dismissed, which removes only those inaccessible local records and their incomplete batch metadata. **Sync now** dismisses that stale state automatically before opening a normal new picker.

Upload naming changes only the Telegram document filename at send time; it never renames the source file. The date prefix is `YYYY-MM-DD__` and uses the date exposed through the browser picker. Duplicate-name prevention uses Unicode-normalized, case-insensitive comparisons against discovered history and local queue entries. It does not force a potentially expensive full-channel scan.

### Bulk actions

Selection mode stores only Telegram message IDs in React state. **Select all visible** means all currently loaded items that match the active filter/search; it does not claim to select undiscovered history. Supporting browsers choose one destination directory and stream selected downloads into uniquely named files. Other browsers use sequential normal downloads and may require permission for multiple downloads. Batch deletion uses Telegram chunks of at most 100 message IDs, removes cached thumbnails, and always requires one destructive confirmation.

### PWA background boundary

The web app cannot promise continued transfers after iOS suspends it. A Dynamic Island surface is an iOS Live Activity supplied by a native WidgetKit/ActivityKit extension; it is a status display, not background runtime. A future native product could show progress there, but reliable background upload also needs native background-transfer and file-library code. Telegram MTProto over a page-owned WebSocket does not become a supported iOS background transfer merely by adding a Live Activity.

### View or download

```text
Telegram message ID
  → resolve one current Teleproto message on demand
  ├── video/audio preview → random same-origin URL → native Range request
  │     → service worker MessageChannel → iterDownload ≤ 1 MB → 206 response
  │     → abandoned request aborts its Telegram range during seeking
  │     → browser-managed playback buffer; explicit retry on runtime failure
  ├── image preview → collect Blob → object URL → viewer → revoke URL
  ├── normal download → collect Blob → temporary anchor
  ├── large supported-browser download → ordered chunks → chosen file
  └── large fallback download → confirm → collect Blob → temporary anchor
```

## Build architecture

Vite builds with `base: "./"`, which is necessary for GitHub project Pages and other subdirectory hosting. Teleproto expects several Node APIs, so `vite-plugin-node-polyfills` provides browser-compatible `Buffer`, `crypto`, `process`, and related modules. Narrow source transforms correct known Teleproto 1.228 browser assumptions in development and production without modifying `node_modules` or global JavaScript prototypes.

The MTProto stack creates a large JavaScript bundle. This is expected for the current architecture. Avoid splitting Teleproto carelessly: authentication and session restoration occur near startup, and a broken shim may fail only after the first network handshake.
