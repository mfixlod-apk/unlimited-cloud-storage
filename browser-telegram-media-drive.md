# Browser-Only Telegram Media Drive

## Overview

The idea is to build a **free, open-source cloud media/file interface backed by a private Telegram channel**, with **no custom backend and no paid server**.

The application itself is a static web app hosted on **GitHub Pages**. It runs entirely in the user's browser and connects directly to Telegram using **MTProto over WebSockets**.

Telegram acts as the remote storage layer. The web app provides a cleaner interface on top of it: gallery browsing, uploads, downloads, media viewing, search, filtering, and eventually more advanced file-management features.

The key architectural goal is:

> **GitHub Pages hosts only the frontend. Telegram stores the media. The browser connects directly to Telegram.**

---

# High-Level Architecture

```text
                    GitHub Pages
                         │
                         │ serves HTML / CSS / JS
                         ▼
                ┌──────────────────┐
                │   Browser PWA    │
                │                  │
                │ Gallery / Files  │
                │ Auth / Upload    │
                │ IndexedDB cache  │
                └────────┬─────────┘
                         │
                         │ MTProto over WebSocket
                         ▼
                  Telegram servers
                         │
                         ▼
                Private Telegram
                    channel/chat
```

There is **no application backend** between the browser and Telegram.

Media traffic therefore looks like this:

```text
Upload:
Phone/Laptop Browser → Telegram

Download:
Telegram → Phone/Laptop Browser
```

GitHub Pages does **not** proxy the user's photos, videos, or files.

---

# Why GitHub Pages Works

GitHub Pages only needs to serve static files such as:

```text
dist/
├── index.html
├── assets/
│   ├── app.js
│   └── app.css
├── manifest.webmanifest
└── service-worker.js
```

That is enough because the application logic runs in JavaScript inside the browser.

GitHub Pages is therefore responsible only for delivering the application bundle.

It is **not** responsible for:

- storing media;
- maintaining a Python process;
- running Telethon;
- keeping a server session alive;
- proxying uploads;
- proxying downloads;
- maintaining a database;
- paying for file-storage bandwidth.

This is what allows the service to remain essentially **€0/month** to operate.

---

# Telegram as the Storage Layer

A private Telegram channel can be used as the application's underlying object store.

Each uploaded file corresponds to a Telegram message.

Example:

```text
Private channel

Message 1041 → IMG_2831.jpg
Message 1042 → IMG_2832.jpg
Message 1043 → vacation.mp4
Message 1044 → report.pdf
Message 1045 → archive.zip
```

The web application interprets those messages as files.

Conceptually:

```text
Telegram message ID ≈ object ID
Telegram media      ≈ blob
Telegram timestamp  ≈ creation/upload date
Telegram caption    ≈ optional metadata
```

Telegram advertises effectively unlimited cloud storage at the account level, while **per-file size limits still apply**.

The exact limits and API behavior should always be treated as Telegram-controlled constraints rather than guarantees of a general-purpose storage SLA.

---

# Why Use MTProto Instead of Only the Bot API

A simple BotFather token and the HTTP Bot API would work for some operations, but it is not the best foundation for this project.

The stronger architecture is to make the web app behave like a lightweight Telegram client using **MTProto**.

That gives the application access to things such as:

- user authorization;
- channel history;
- photos;
- videos;
- documents;
- thumbnails;
- uploads;
- downloads;
- message deletion;
- pagination;
- Telegram's native file infrastructure.

This also lets the gallery reconstruct itself from Telegram on any device.

For example:

```text
Laptop uploads IMG_9001.jpg
        ↓
Telegram stores the message
        ↓
Phone opens the web app
        ↓
App reads channel history
        ↓
IMG_9001.jpg appears
```

No custom synchronization database is required.

---

# Browser MTProto

The browser connects to Telegram directly using **MTProto over WebSockets**.

Conceptually:

```text
JavaScript application
        │
        ▼
MTProto client library
        │
        ▼
WebSocket transport
        │
        ▼
Telegram data center
```

This is the most technically significant part of the project.

A browser-compatible MTProto implementation needs to handle or provide equivalents for functionality that many Telegram libraries traditionally expect from Node.js, such as:

- WebSockets;
- cryptography;
- binary buffers;
- session serialization;
- compression;
- Telegram data-center selection;
- upload/download parts;
- reconnect logic.

Existing JavaScript Telegram client implementations prove that this architecture is possible.

A practical implementation can either:

1. use an actively maintained browser-capable MTProto library; or
2. adapt an existing JS MTProto implementation with browser shims where needed.

---

# Authentication

## API Credentials

Telegram client applications use:

```text
api_id
api_hash
```

For an open-source project, these should **not be hardcoded into the public repository**.

Instead, the application should support **bring-your-own Telegram API credentials**.

First launch could look like:

```text
┌───────────────────────────────┐
│ Connect Telegram             │
│                              │
│ API ID                       │
│ [________________________]   │
│                              │
│ API Hash                     │
│ [________________________]   │
│                              │
│          Continue            │
└───────────────────────────────┘
```

Each user can obtain their own credentials from Telegram's developer portal.

The public GitHub repository then contains no private Telegram credentials.

---

## User Login

The ideal desktop login method is **Telegram QR authentication**.

Flow:

```text
Open web app on laptop
        ↓
App displays QR code
        ↓
Scan QR using existing Telegram app
        ↓
Approve login
        ↓
Browser receives authenticated Telegram session
```

Advantages:

- no custom user database;
- no backend authentication service;
- no application password database;
- the user's Telegram account is the identity;
- avoids typing a Telegram password into the web UI in the common desktop flow.

For phone-only usage, where scanning a QR code displayed on the same phone is awkward, normal Telegram login should be available as a fallback.

---

# Session Storage

After authorization, the browser needs to retain the Telegram session.

The session can be stored locally using **IndexedDB**.

```text
Telegram authorization
        ↓
serialized session
        ↓
IndexedDB
        ↓
restored on future visits
```

Important distinction:

```text
Telegram       = source of truth for files
IndexedDB      = device-local session/cache
GitHub Pages   = frontend hosting only
```

Each device can have its own Telegram session.

For example:

```text
Laptop → local session A
Phone  → local session B
Tablet → local session C
```

Deleting browser data should remove that local session/cache without deleting the files in Telegram.

---

# Security Model

The project should assume that anything included in the public JavaScript bundle is public.

Therefore:

## Never hardcode

- Telegram `api_hash`;
- private bot tokens;
- Telegram sessions;
- user phone numbers;
- private channel identifiers that are meant to remain private;
- encryption keys.

## Avoid storing secrets in

- Git;
- JavaScript source;
- URL query parameters;
- analytics;
- application logs;
- public environment variables;
- service-worker caches.

## Local session

Telegram session material can live in IndexedDB on the user's own device.

The app should provide:

```text
Logout
Clear local session
Clear thumbnail cache
Forget API credentials
```

If stronger privacy is desired later, locally stored session material can itself be encrypted with a user-supplied passphrase.

---

# Telegram Is Not Zero-Knowledge Storage

A private Telegram channel is still Telegram cloud storage.

It should **not** be treated as client-side encrypted storage by default.

For ordinary personal media this may be acceptable.

For sensitive files, a later version could support:

```text
original file
     ↓
optional compression
     ↓
client-side encryption
     ↓
encrypted blob
     ↓
Telegram
```

For example:

```text
AES-256-GCM
```

The encryption key would remain local/user-controlled.

Telegram would then only receive encrypted blobs.

---

# Gallery

The gallery is one of the easiest and most useful interfaces to build on top of the Telegram channel.

Example UI:

```text
┌──────────────────────────────────────┐
│ My Cloud                     Upload  │
├──────────────────────────────────────┤
│ Photos   Videos   Files   All        │
│                                      │
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐    │
│ │ IMG │ │ IMG │ │ VID │ │ IMG │    │
│ └─────┘ └─────┘ └─────┘ └─────┘    │
│                                      │
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐    │
│ │ VID │ │ IMG │ │ PDF │ │ IMG │    │
│ └─────┘ └─────┘ └─────┘ └─────┘    │
└──────────────────────────────────────┘
```

Telegram messages already provide enough information to categorize many items as:

- image;
- video;
- audio;
- document;
- archive;
- generic file.

The UI does not need to expose the Telegram message model.

To the user, it should simply look like a media drive.

---

# Thumbnails

The app should not download an original multi-megabyte image or multi-gigabyte video just to render the gallery.

Instead:

```text
Fetch channel history
        ↓
Inspect media
        ↓
Request small thumbnail
        ↓
Render gallery tile
```

Thumbnails can be cached locally.

```text
Telegram
   ↓
thumbnail
   ↓
IndexedDB / browser cache
   ↓
gallery
```

This makes scrolling through thousands of media items practical.

---

# Infinite Scrolling

Telegram channel history naturally maps to pagination.

Initial load:

```text
Fetch latest 50 messages
```

Then:

```text
User scrolls near bottom
        ↓
Fetch 50 older messages
        ↓
Append them
```

The user should never need to load the full history at once.

This allows the application to work even with very large Telegram archives.

---

# Photos

Clicking an image thumbnail can open a lightbox:

```text
┌───────────────────────────────────┐
│ ×                                 │
│                                   │
│           Full image              │
│                                   │
│                                   │
│     Download       Delete         │
└───────────────────────────────────┘
```

Possible later additions:

- zoom;
- swipe between images;
- EXIF metadata;
- favorites;
- slideshow;
- album grouping.

---

# Videos

Videos can initially support:

- thumbnail;
- filename;
- duration;
- size;
- download;
- basic playback.

A first version does **not** need sophisticated streaming.

Later, Telegram's part-based file retrieval can potentially be mapped into chunked playback logic.

The important point is to avoid architectures like:

```text
Download entire 4 GB video into JS memory
        ↓
start playback
```

Instead, large media should be handled progressively/chunk-by-chunk where possible.

---

# Files

Non-media files can appear in a conventional list or grid.

Example:

```text
Files

📄 thesis.pdf                     18 MB
📦 backup.tar.zst                1.2 GB
📝 notes.txt                      42 KB
📊 results.csv                   6.3 MB
```

Actions:

```text
Download
Delete
Rename metadata
Copy information
```

Telegram remains responsible for storing the underlying media.

---

# Uploading

The upload interface can use a normal browser file picker or drag-and-drop.

```text
Select files
     ↓
browser reads file
     ↓
MTProto upload
     ↓
Telegram channel
     ↓
new message
     ↓
gallery updates
```

The UI should expose:

```text
filename
progress
uploaded bytes
total size
upload speed
cancel
retry
```

For mobile usage, the browser file picker can expose photos/videos from the phone's media library.

---

# File Metadata

The simplest system can infer most metadata directly from Telegram.

If application-specific metadata is needed, several approaches are possible.

## Option 1 — Caption metadata

Example:

```json
{
  "path": "/Photos/Kosovo/IMG_1234.jpg",
  "favorite": false,
  "album": "Kosovo 2026"
}
```

## Option 2 — Local metadata only

Store metadata in IndexedDB.

Problem:

```text
Laptop metadata ≠ Phone metadata
```

because IndexedDB is device-local.

## Option 3 — Telegram-backed metadata

Store metadata messages in Telegram itself.

This preserves cross-device behavior.

For the MVP, avoid complex metadata entirely and use Telegram's native message/media information.

---

# Folder Model

Telegram does not naturally behave like a hierarchical filesystem.

Therefore folders should initially be treated as a UI abstraction.

Potential approaches later:

```text
Albums
Tags
Virtual folders
Caption metadata
Separate channels
Telegram topics
```

A gallery-first model is easier and more natural than trying to emulate a full filesystem immediately.

---

# Search

Several forms of search can eventually exist:

```text
filename search
date filters
media type
size
caption
album/tag
```

Potential UI:

```text
Search: [ Switzerland 2026          ]

Type:
[ All ] [ Photos ] [ Videos ] [ Files ]

Date:
[ Any time ▼ ]
```

---

# Caching

IndexedDB can improve performance significantly.

Cache:

- Telegram session;
- thumbnail blobs;
- parsed media metadata;
- pagination state;
- UI preferences.

Do **not** make IndexedDB authoritative for the actual file list.

Correct model:

```text
Telegram
   │
   └── authoritative storage/history

IndexedDB
   │
   └── disposable local optimization
```

If IndexedDB is deleted:

```text
reload Telegram history
        ↓
reconstruct gallery
```

Nothing important should be lost.

---

# PWA

The application should be installable as a **Progressive Web App**.

That gives users:

```text
Phone home-screen icon
Standalone window
App-like navigation
Cached application shell
Fast startup
```

Example:

```text
Android / iPhone
       ↓
Add to Home Screen
       ↓
"My Cloud"
       ↓
looks and behaves like an app
```

The same codebase works on:

- phone;
- laptop;
- desktop;
- tablet.

---

# Open-Source Model

The GitHub repository can be completely public.

Example structure:

```text
channel-drive/
├── src/
│   ├── telegram/
│   │   ├── client.ts
│   │   ├── auth.ts
│   │   ├── history.ts
│   │   ├── upload.ts
│   │   ├── download.ts
│   │   └── media.ts
│   │
│   ├── storage/
│   │   ├── indexeddb.ts
│   │   └── cache.ts
│   │
│   ├── gallery/
│   │   ├── gallery.ts
│   │   ├── image-viewer.ts
│   │   └── video-viewer.ts
│   │
│   └── ui/
│
├── public/
│   ├── manifest.webmanifest
│   └── icons/
│
├── index.html
├── package.json
├── vite.config.ts
├── LICENSE
└── README.md
```

A user could either:

```bash
git clone <repo>
npm install
npm run dev
```

or simply use the hosted GitHub Pages version.

---

# Deployment

A simple deployment pipeline:

```text
git push
   ↓
GitHub Actions
   ↓
npm install
npm run build
   ↓
dist/
   ↓
GitHub Pages
```

No secrets need to be present in the GitHub Actions workflow if credentials are supplied by the user at runtime.

---

# Suggested Tech Stack

## Frontend

```text
TypeScript
React
Vite
```

React is not strictly necessary, but it makes the gallery and application state easier to manage.

Alternative:

```text
TypeScript + vanilla DOM
```

if keeping the bundle extremely small is a priority.

## Telegram

```text
Browser-capable MTProto JavaScript library
WebSocket transport
```

Potentially based on an existing maintained fork/library rather than implementing MTProto from scratch.

## Local storage

```text
IndexedDB
```

A helper such as Dexie could make IndexedDB easier to use, although native IndexedDB is sufficient.

## Styling

Any static frontend approach works:

```text
CSS
Tailwind
CSS Modules
```

There is no architectural dependency on a specific UI library.

## PWA

```text
Web App Manifest
Service Worker
```

---

# MVP

The first version should stay extremely focused.

## 1. Telegram connection

```text
api_id + api_hash
        ↓
connect to Telegram
```

## 2. Login

Prefer:

```text
QR login on desktop
```

with normal Telegram authorization as fallback.

## 3. Select storage channel

Show the user's channels and let them choose one private channel as the storage target.

Optionally allow creation instructions rather than programmatically creating it initially.

## 4. Read history

Fetch recent messages from the selected channel.

## 5. Gallery

Render:

```text
Photos
Videos
Files
```

with thumbnails.

## 6. Infinite scroll

Load older channel history as necessary.

## 7. Upload

Allow files to be uploaded directly to the selected channel.

## 8. Download/view

Support:

```text
image viewer
video download/basic player
generic file download
```

## 9. Delete

Delete the corresponding Telegram message.

## 10. Local cache

Cache thumbnails and session information in IndexedDB.

That is already a useful product.

---

# MVP User Flow

```text
Open website
     ↓
Enter Telegram API credentials
     ↓
Authenticate Telegram account
     ↓
Choose private channel
     ↓
Gallery appears
     ↓
┌───────────┬───────────┬───────────┐
│ Photos    │ Videos    │ Files     │
└───────────┴───────────┴───────────┘
     ↓
Upload / View / Download / Delete
```

Returning user:

```text
Open installed PWA
     ↓
restore local session
     ↓
read latest channel history
     ↓
show cached thumbnails immediately
     ↓
sync new messages
```

---

# Things Not to Build in V1

Avoid turning the first version into an entire Dropbox clone.

Do not initially build:

- FUSE filesystem mounting;
- automatic phone camera backup;
- end-to-end file encryption;
- >per-file-limit splitting;
- deduplication;
- sharing links;
- multi-user permissions;
- video transcoding;
- sophisticated streaming;
- server-side thumbnail generation;
- full virtual folder semantics;
- synchronization engine;
- desktop native application;
- AI image search;
- face recognition.

Those can come after the core architecture is proven.

---

# Large Files

Telegram imposes per-file limits.

A later version could support files larger than Telegram's limit by splitting them client-side:

```text
large-backup.tar.zst
        │
        ├── part-000
        ├── part-001
        ├── part-002
        └── manifest.json
```

The manifest could contain:

```json
{
  "filename": "large-backup.tar.zst",
  "size": 9123456789,
  "parts": [
    1291,
    1292,
    1293
  ],
  "sha256": "..."
}
```

Download would reverse the process:

```text
Telegram parts
      ↓
browser
      ↓
reassemble stream
      ↓
original file
```

This should be considered a later feature, not part of the initial MVP.

---

# Optional Client-Side Encryption

A privacy mode could be added later.

```text
User file
   ↓
compress
   ↓
encrypt locally
   ↓
upload ciphertext
   ↓
Telegram
```

Possible design:

```text
AES-256-GCM
Argon2/PBKDF-derived key
random nonce per object
encrypted manifest
```

Important rule:

```text
Encryption key never leaves the browser/device
```

This would make Telegram function more like an untrusted blob-storage provider.

---

# Albums

Albums can be implemented without physically reorganizing files.

For example, album information could be stored as metadata:

```json
{
  "album": "Kosovo Summer 2026",
  "items": [1021, 1024, 1032, 1041]
}
```

Then the interface can present:

```text
Albums

┌─────────────────────┐
│ Kosovo Summer 2026  │
│ 248 photos          │
└─────────────────────┘

┌─────────────────────┐
│ Switzerland         │
│ 931 photos          │
└─────────────────────┘
```

Telegram message IDs become stable references to the underlying media.

---

# Possible Future Features

Once the MVP is solid:

## Gallery improvements

- masonry layout;
- timeline by month/year;
- swipe navigation;
- image zoom;
- favorites;
- albums;
- tags;
- duplicate detection.

## File manager

- virtual directories;
- rename;
- sorting;
- file-type icons;
- bulk operations.

## Media

- video streaming;
- audio playback;
- PDF viewer;
- image metadata;
- thumbnail prefetch.

## Upload

- drag-and-drop;
- batch uploads;
- resumable uploads;
- upload queue;
- retry logic.

## Privacy

- optional client-side encryption;
- encrypted filenames;
- local passphrase;
- session lock.

## Offline/PWA

- offline cached thumbnails;
- recent-file cache;
- app installation;
- background-like queued uploads where browser capabilities permit.

## Storage management

- duplicate detection;
- hashes;
- statistics;
- estimated storage usage;
- channel migration/export.

---

# Potential UI

```text
┌────────────────────────────────────────────────┐
│ Vault                              ⬆ Upload    │
├────────────────────────────────────────────────┤
│ 🔍 Search                                      │
│                                                │
│ Gallery   Albums   Videos   Files              │
├────────────────────────────────────────────────┤
│                                                │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │
│  │        │ │        │ │   ▶    │ │        │  │
│  │ photo  │ │ photo  │ │ video  │ │ photo  │  │
│  │        │ │        │ │        │ │        │  │
│  └────────┘ └────────┘ └────────┘ └────────┘  │
│                                                │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │
│  │        │ │   ▶    │ │        │ │        │  │
│  │ photo  │ │ video  │ │ photo  │ │ photo  │  │
│  │        │ │        │ │        │ │        │  │
│  └────────┘ └────────┘ └────────┘ └────────┘  │
│                                                │
└────────────────────────────────────────────────┘
```

The application should **not look like Telegram**.

Telegram should be invisible as an implementation detail.

To the user, it should feel like:

```text
Google Photos / Drive
        +
personal cloud
        +
zero hosting bill
```

---

# Main Technical Risks

## 1. Browser MTProto integration

This is the largest initial engineering challenge.

The project depends on a reliable browser-compatible MTProto implementation.

This should be proven first with a tiny prototype:

```text
connect
login
get current user
read channel history
download thumbnail
upload one image
```

If those operations work reliably on GitHub Pages, the rest becomes mostly normal frontend development.

---

## 2. Telegram policy/limits

Telegram is a messaging platform, not an S3 provider.

The project must account for:

- API rate limits;
- flood waits;
- per-file limits;
- possible API changes;
- account restrictions if automation is abusive;
- Telegram terms.

The application should use conservative request concurrency and gracefully handle Telegram flood-wait responses.

---

## 3. Browser memory

Large files must not be unnecessarily buffered completely in RAM.

Prefer:

```text
chunked transfer
streams where available
bounded buffers
```

---

## 4. Mobile browsers

Mobile browsers have stricter constraints around:

- background execution;
- memory;
- long uploads;
- service workers;
- file handling.

Therefore:

```text
foreground upload/download
```

should be considered the reliable baseline.

Automatic background backup can be investigated later.

---

## 5. Credentials and sessions

Open-source deployment means the code is visible to everyone.

The security model must therefore rely on:

```text
user-provided credentials
+
local-only sessions
```

and never on hidden frontend secrets.

---

# What the Project Is

A good description would be:

> A browser-only, open-source personal media drive that uses a private Telegram channel as its storage backend. The application is hosted as a static PWA on GitHub Pages and connects directly from the browser to Telegram through MTProto, requiring no custom server or monthly hosting cost.

Short version:

> **A frontend for turning your private Telegram cloud into a personal photo gallery and file drive.**

---

# What the Project Is Not

It is not:

- an official Telegram product;
- guaranteed permanent unlimited storage;
- an S3 replacement for production systems;
- a backup system that should hold the only copy of critical data;
- zero-knowledge encrypted by default;
- a backend service;
- dependent on a VPS.

It is primarily:

```text
personal cloud UI
+
Telegram-backed storage
+
free static hosting
```

---

# Recommended First Prototype

Before building the polished UI, create a bare proof-of-concept page containing only:

```text
[ Connect Telegram ]

Authenticated as: <name>

Storage channel:
[ select ]

[ Load Messages ]

Message 1034
photo.jpg
[ Thumbnail ]
[ Download ]

[ Upload File ]
```

The prototype only needs to prove six things:

1. MTProto works from the browser.
2. It works when served over GitHub Pages.
3. Telegram authorization works.
4. The session survives a page reload.
5. Channel history can be fetched.
6. Upload and download work reliably.

Once those six are proven, building the gallery is conventional frontend work.

---

# Suggested Development Order

```text
Phase 1 — Protocol proof
    ↓
Browser MTProto connection
Authentication
Read one channel
Upload/download one file

Phase 2 — Basic application
    ↓
Channel selection
History pagination
Gallery
Thumbnails
File viewer
Uploads

Phase 3 — PWA
    ↓
IndexedDB
Session persistence
Caching
Installability
Responsive mobile UI

Phase 4 — Product features
    ↓
Search
Albums
Favorites
Bulk actions
Better video support

Phase 5 — Advanced storage
    ↓
Encryption
Chunking huge files
Deduplication
Virtual folders
```

---

# Bottom Line

The project is technically feasible without paying for a VPS.

The intended final architecture is:

```text
                       €0/month infrastructure

                 ┌─────────────────────┐
                 │    GitHub Pages     │
                 │  static frontend    │
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │      Browser        │
                 │                     │
                 │ React/TS PWA        │
                 │ IndexedDB           │
                 │ MTProto client      │
                 └──────────┬──────────┘
                            │
                       WebSocket
                            │
                            ▼
                 ┌─────────────────────┐
                 │      Telegram       │
                 │                     │
                 │ private channel     │
                 │ photos/videos/files │
                 └─────────────────────┘
```

The most important architectural rule is:

> **Do not build a backend unless a later feature genuinely requires one.**

For the core product—authentication, gallery, uploads, downloads, and local caching—the browser can communicate with Telegram directly.

That keeps the project:

- cheap;
- open source;
- easy to self-host;
- available on phone and laptop;
- free to operate;
- relatively simple;
- interesting technically.
