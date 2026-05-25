# capture-site

This repository is a small browser-based front end for `capture-website-cli`.

It includes a local Express server at `server.js` and a UI under `public/index.html` that lets you:
- capture one URL or a batch of URLs
- choose a named output subfolder
- save full-page JPEG screenshots
- use a 5 second delay and preload lazy content

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Start the app locally:

```bash
npm start
```

The `start` script runs `node server.js`. A `prestart` script is configured to attempt to free port `3000` before the server starts.

3. Open the browser:

```text
http://localhost:3000
```

If you want to run on a different port:

```bash
PORT=3001 npm start
```

## How to use the front end

- Enter a single URL in the "Single URL" field.
- Or paste one URL per line into the "URL list" field.
- Choose the capture mode: `Desktop` or `Mobile (375px width, full height, using mobile device emulation)`.
- Enter a relative output directory name inside the project folder (default: `screenshots`).
- Click `Capture Screenshot(s)`.

By default, screenshots are saved inside the project folder in `screenshots`.

## API endpoint

The UI sends capture requests to:

```text
POST /capture
```

The payload may include either:
- `url` — a single URL, or
- `urls` — multiple URLs separated by newlines
- `outputDir` — relative folder name for the screenshot output
- `captureMode` — `desktop` or `mobile` (375px width, full page height)

## Raw CLI usage

If you prefer the underlying CLI directly, use:

```bash
npx capture-website https://example.com --output=example.jpg
```

For a URL list file, use one command per URL, or use the built-in front end instead.

## Notes

- `npx` does not require a global install.
- The server stores per-capture logs under the chosen output folder in `logs/`.
- The app validates URLs and forces the output directory to remain inside the project folder.
