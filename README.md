# Page Snapshot

Chrome extension that captures any web page exactly as you see it and gives you a shareable link.

Pages are stored as self-contained HTML (images inlined, styles captured, scripts stripped) on Cloudflare R2.

## How it works

1. Click the extension on any page
2. It clones the DOM, inlines all CSS/images, strips scripts, and gzip-compresses the result
3. The compressed snapshot is uploaded to a Cloudflare Worker which stores it in R2
4. You get a shareable link back

## Setup

### Prerequisites

- [Bun](https://bun.sh) (or Node.js)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with R2 enabled
- Google Chrome

### 1. Install dependencies

```sh
cd worker
bun install
```

### 2. Create the R2 bucket

```sh
cd worker
bunx wrangler r2 bucket create page-snapshots
```

### 3. Update the worker URL

If you're deploying your own instance, update the `API_URL` in `extension/background.js` to point to your worker:

```js
const API_URL = 'https://your-worker-name.your-subdomain.workers.dev';
```

### 4. Run the worker locally

```sh
bun run worker:dev
```

The worker starts at `http://localhost:8787`. For local development, set `API_URL` to `http://localhost:8787`.

### 5. Load the Chrome extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder

### 6. Deploy

```sh
bun run worker:deploy
```

This deploys the worker to Cloudflare. Update `API_URL` in `extension/background.js` to the deployed URL.

## Project structure

```
extension/          Chrome extension (Manifest V3)
  background.js     Service worker - handles capture + upload
  popup.html/js/css  Extension popup UI
worker/             Cloudflare Worker
  src/index.js      Upload + serve API (R2-backed)
  wrangler.toml     Wrangler config (R2 bucket binding)
```

## Features

- Full page capture with inlined images, CSS, and fonts
- Gzip compression before upload
- Configurable link expiration (never, 30 days, 7 days, 1 day)
- Snapshot history stored locally
- 50MB max upload size
