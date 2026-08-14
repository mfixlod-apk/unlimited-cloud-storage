# Developer documentation

This directory describes the implementation that currently exists, the decisions behind it, and the safest places to extend it. The original product brief remains in [`browser-telegram-media-drive.md`](../browser-telegram-media-drive.md).

## Reading order

1. [`architecture.md`](architecture.md) — application boundaries, runtime layers, state flow, and source map.
2. [`telegram-integration.md`](telegram-integration.md) — MTProto connection, login, channels, media operations, and Telegram-specific behavior.
3. [`storage-and-security.md`](storage-and-security.md) — IndexedDB schema, cache boundaries, session handling, CSP, and security checklist.
4. [`development.md`](development.md) — local commands, debugging, validation, deployment, and common change recipes.
5. [`decisions.md`](decisions.md) — important architectural decisions and the tradeoffs that should be reconsidered deliberately.

## Current implementation status

The MVP includes:

- runtime-supplied Telegram API credentials;
- QR authentication, phone login fallback, and Telegram two-step verification;
- serialized Telegram session restoration;
- creation, selection, rename, and confirmed owner deletion of broadcast channels;
- paginated history, local filtering/search, and thumbnail caching;
- durable sequential uploads with retry, date-prefix and duplicate-name options;
- viewing plus single/bulk downloading and confirmed single/bulk deletion of media messages;
- a responsive React UI and installable static PWA;
- GitHub Pages deployment without repository secrets.

The production build and responsive UI have been checked locally. A live Telegram login still needs to be manually exercised with a developer's own API credentials and account because credentials are intentionally absent from the repository.

## Source map

| Path | Responsibility |
| --- | --- |
| [`src/App.tsx`](../src/App.tsx) | Top-level application state machine and screen orchestration |
| [`src/screens/OnboardingScreens.tsx`](../src/screens/OnboardingScreens.tsx) | Landing, authentication, and channel-selection screens |
| [`src/screens/DriveScreen.tsx`](../src/screens/DriveScreen.tsx) | Drive workspace, gallery, transfers, viewer, and settings |
| [`src/screens/Brand.tsx`](../src/screens/Brand.tsx) | Shared application brand component |
| [`src/screens/shared.ts`](../src/screens/shared.ts) | Small UI-only formatting, error, account-name, and theme helpers |
| [`src/telegram.ts`](../src/telegram.ts) | The only Telegram/Teleproto integration boundary |
| [`src/storage.ts`](../src/storage.ts) | IndexedDB schema and local persistence operations |
| [`src/styles.css`](../src/styles.css) | Entire visual system and responsive layout |
| [`src/icons.tsx`](../src/icons.tsx) | Local SVG icon components |
| [`src/main.tsx`](../src/main.tsx) | Browser bootstrap, Buffer shim, and service-worker registration |
| [`public/service-worker.js`](../public/service-worker.js) | Same-origin application-shell cache and uncached progressive-media range bridge |
| [`public/manifest.webmanifest`](../public/manifest.webmanifest) | PWA identity, icons, scope, and display settings |
| [`vite.config.ts`](../vite.config.ts) | Relative build base, Node polyfills, and narrowly checked Teleproto browser transforms |
| [`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml) | Static GitHub Pages build and deployment |

## Documentation maintenance rule

When a change affects authentication, the IndexedDB schema, service-worker caching, Telegram message mapping, transfer memory behavior, or deployment, update the corresponding document in the same change. Those areas define the product's security and data-loss boundaries.
