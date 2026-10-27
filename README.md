# capture-site

This repository is a small browser-based front end for `capture-website-cli`.

It includes a local Express server at `server.js` and a UI under `public/index.html` that lets you:
- capture pages from a sitemap or a manually entered URL list
- export responsive JPEG screenshots or one PDF per URL
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

The `start` script runs `node server.js` on port `3001` by default. It does not stop or replace processes used by other local tools.

3. Open the browser:

```text
http://localhost:3001
```

If you want to run on a different port:

```bash
PORT=3002 npm start
```

## How to use the front end

- Choose `Sitemap` and enter the XML sitemap index or sitemap file URL to use. The app does not select a site automatically.
- Choose `URL list` to enter one HTTP or HTTPS page URL per line. Duplicate URLs are captured only once.
- Choose `JPEG screenshots` for responsive widths and select a capture preset: `WordPress`, `Webflow`, or `Desktop Only`.
- Choose `PDF` to export one single-page PDF per URL, with selectable text. PDFs preserve the screen layout at a 2000px viewport width and include the full page.
- Enter a folder name for the output directory (default: `screenshots`).
- Click `Capture screenshots`. For sitemap sources, the app follows the sitemap index to its child sitemaps and captures each unique page URL listed in the sitemap.

By default, screenshots are saved to `Desktop/screenshots`.

## API endpoint

The UI sends capture requests to:

```text
POST /capture
```

The request payload may include:
- `captureId` — unique capture ID supplied by the UI to allow cancellation when the page unloads
- `outputDir` — relative folder name for the screenshot output
- `capturePreset` — `wordpress`, `webflow`, or `desktop-only`
- `sourceType` — `sitemap` (default) or `urls`
- `sitemapUrl` — HTTP or HTTPS sitemap index or sitemap file URL
- `urlList` — newline-separated HTTP or HTTPS page URLs when `sourceType` is `urls`
- `captureFormat` — `jpeg` (default) or `pdf`; PDF creates one document per URL

For sitemap sources, the sitemap is fetched by the server and child sitemaps must use the same origin as the sitemap URL. For URL-list sources, duplicate URLs are removed before capture.
Reloading or leaving the page cancels its active capture and clears the remaining URLs from that run.

## Raw CLI usage

If you prefer the underlying CLI directly, use:

```bash
npx --no-install capture-website https://example.com --output=example.jpg
```

For URL lists, choose `URL list` in the front end and enter one URL per line.

## Notes

- The capture CLI is installed locally with the app dependencies.
- The server stores per-capture logs under the chosen output folder in `logs/`.
- The app validates sitemap URLs and forces the output directory to remain inside your Desktop folder.

## PDF troubleshooting and verification

After changing `server.js`, stop the running server with Ctrl+C and run `npm start`
again. Node does not reload changes automatically. A server started before the PDF
changes can still produce letter-size, multiple-page PDFs even when the UI says
"one page per URL".

PDFs use Chromium's native PDF export through Puppeteer. This preserves HTML text
and links; converting a JPEG screenshot into a PDF would not preserve text. Text
inside images, canvas drawings, and video still requires OCR. Playwright also
supports native Chromium PDF export, but switching browser libraries alone does
not fix pagination.

The PDF exporter uses screen media, removes forced page breaks and named pages,
sets a zero-margin custom paper size, and measures height after lazy content and
fonts settle. It freezes the settled screen heights so viewport-height sections
do not expand to the paper height during printing. It keeps the 2000px-wide desktop viewport and checks that Chromium
actually generated one page. The capture has an overall timeout so infinite-scroll
pages cannot run forever. HTTP errors such as a 404 are reported as failures.

Run the browser regression tests with `npm test`. For an independent check of
page count and actual text extraction, install the optional Python tools in a
virtual environment:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-pdf.txt
.venv/bin/python scripts/verify_pdf.py --single-page --require-text ~/Desktop/screenshots/pdf/*.pdf
```

Add `--contains "Some expected text"` to verify specific content or
`--preview-dir /tmp/pdf-previews` to render PNG previews. The verifier exits with a
nonzero status when a requested check fails. Existing PDF files must be recaptured
after restarting the server; updating the code does not rewrite them.
