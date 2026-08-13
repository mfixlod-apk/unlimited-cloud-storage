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
    ├── IndexedDB session/config/thumbnail cache
    └── same-origin PWA shell cache
    │
    │ MTProto over WebSocket
    ▼
Telegram
    └── private channel containing one media message per file
```

Telegram channel history is authoritative for files. IndexedDB is a disposable device-local optimization and credential/session store. The service worker caches only static same-origin application resources.

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
```

Important screen components:

- `CredentialsScreen` validates the user's API ID and hash.
- `AuthScreen` coordinates QR, phone-code, and 2FA callbacks.
- `ChannelScreen` displays eligible private channels.
- `DriveScreen` owns loaded history, filters, uploads, viewer state, and infinite scrolling.
- `SettingsPanel` exposes cache clearing, device forgetting, channel switching, and Telegram logout.

The UI is currently kept in one file because the product is still small. If `App.tsx` grows substantially, split by screen while keeping orchestration in `App` and Telegram operations behind `TelegramDrive`.

### Telegram boundary

[`src/telegram.ts`](../src/telegram.ts) wraps the Teleproto client. It is responsible for:

- constructing and disconnecting a single client;
- authorization flows;
- session serialization and private channel creation;
- channel discovery and filtering;
- converting Telegram messages to `CloudItem` objects;
- paginated history reads;
- thumbnail, original-file, upload, and delete operations.

UI code should not import `TelegramClient`, `Api`, or other Teleproto internals. Keeping one integration boundary makes future client-library upgrades much safer.

### Local persistence

[`src/storage.ts`](../src/storage.ts) is the only IndexedDB access layer. The UI and Telegram wrapper use the exported `localStore` methods rather than opening the database independently.

### PWA boundary

[`src/main.tsx`](../src/main.tsx) registers [`public/service-worker.js`](../public/service-worker.js) only for production builds. The service worker ignores cross-origin requests, so Telegram WebSockets and file traffic cannot enter the application-shell cache.

## Domain model

`CloudChannel` is an eligible Telegram channel:

```ts
interface CloudChannel {
  id: string;
  title: string;
  inputEntity: unknown;
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
  message: unknown;    // original Teleproto message used for media operations
}
```

There is no separate file database. The Telegram message ID functions as the object ID, and deleting an item deletes that message from Telegram.

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
getMessages(limit: 40, offsetId)
  → discard messages without supported media
  → map remaining messages to CloudItem
  → render cards immediately
  → read each thumbnail from IndexedDB
  → download Telegram thumbnail on cache miss
  → store disposable Blob in IndexedDB
```

### Upload

```text
File picker or drop
  → add queue entries
  → upload one file at a time
  → sendFile to selected channel
  → update progress UI
  → refresh newest history page when the queue finishes
```

### View or download

```text
Telegram media message
  → downloadMedia with an ordered chunk writer and cancellation
  ├── preview → collect Blob → object URL → viewer → revoke URL
  ├── supported browser download → write chunks to chosen file
  └── fallback download → collect Blob → temporary anchor
```

## Build architecture

Vite builds with `base: "./"`, which is necessary for GitHub project Pages and other subdirectory hosting. Teleproto expects several Node APIs, so `vite-plugin-node-polyfills` provides browser-compatible `Buffer`, `crypto`, `process`, and related modules. Narrow source transforms correct known Teleproto 1.228 browser assumptions in development and production without modifying `node_modules` or global JavaScript prototypes.

The MTProto stack creates a large JavaScript bundle. This is expected for the current architecture. Avoid splitting Teleproto carelessly: authentication and session restoration occur near startup, and a broken shim may fail only after the first network handshake.
