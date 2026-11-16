# PDF Studio

A local-only PDF editor that ships as **one self-contained HTML file**. Merge, split, sign and mark up PDFs entirely in the browser — no server, no uploads, no accounts.

**Live:** https://matthamiltonnz.github.io/pdf-studio/  
**Repository:** https://github.com/matthamiltonnz/pdf-studio

**Deliverable:** [`dist/pdf-studio.html`](dist/pdf-studio.html) (≈2.4 MB, all libraries and the PDF.js worker inlined).

---

## Features

| Tool | What it does |
| --- | --- |
| **Merge** | Add multiple PDFs, reorder them, merge into one download. Page content, sizes, rotations and page-level annotations are preserved; document bookmarks/outlines and interactive form fields may not carry over. |
| **Split & organise** | Thumbnail view with multi-select. Rotate, reorder and delete pages, then save a copy. Extract selected pages, split every *N* pages, or create one PDF per custom range (`1-3, 4-6, 7`). Multi-file outputs download as a ZIP. |
| **Sign & mark up** | Highlight, freehand ink, text, comment boxes, rectangles, arrows, black boxes and signatures. Select annotations to move them, resize shapes/signatures, undo/redo, zoom, and export a flattened copy. Signatures can be drawn, typed or uploaded from an image and are remembered in local storage. The document workspace expands to fill the window, with **fit width**, **fit page** and fixed zoom presets. |

Everything happens client-side with [PDF.js](https://mozilla.github.io/pdf.js/), [pdf-lib](https://pdf-lib.js.org/) and [fflate](https://github.com/101arrowz/fflate). The page makes **no network requests** at runtime.

## Run it

### Quickest path

1. Download or copy `dist/pdf-studio.html`.
2. Double-click it (or drag it into a browser tab).
3. Drop a PDF in. It works offline.

No build step is required to use the file. The PDF.js worker is embedded as a data URL so the file also works from `file://`.

### Local development

```bash
npm install
npm run build      # writes dist/pdf-studio.html and dist/index.html
npm run preview    # serves dist/ on a local port
npm test           # Playwright end-to-end checks (build first)
```

Other scripts:

```bash
npm run fixtures   # regenerate the small PDFs used by the tests
```

## Deployment

Pushes to `main` run [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), build the single-file app with `npm run build`, and publish `dist/` to GitHub Pages. The workflow can also be started manually from the Actions tab.

Live URL: **https://matthamiltonnz.github.io/pdf-studio/**

## Hosting in Microsoft 365 / SharePoint

Because the app is a single static HTML file, you have a few options.

### Option A — SharePoint document library

1. Upload `pdf-studio.html` to a library such as **Site Assets** (or a dedicated “Tools” library).
2. Share the file with the people who need it.

Depending on tenant and library settings, SharePoint may open the HTML file in the browser or download it. If it downloads, users can simply open the downloaded file — it runs offline from their desktop. This is the lowest-effort option and keeps the tool inside M365 governance.

### Option B — Static host + SharePoint Embed web part (best in-browser experience)

1. Deploy the file to any static host — Azure Static Web Apps, Azure Blob Storage static website, GitHub Pages, Netlify, an internal IIS site, etc.
2. Add a SharePoint page and insert the **Embed** web part, pointing at the hosted `pdf-studio.html`.
3. Users get a full-page, in-browser editor inside SharePoint.

Notes for this option:

- The host must allow the page to be framed by your SharePoint tenant (no restrictive `X-Frame-Options`/`frame-ancestors`).
- The app uses inline CSS/JS, Blob/data URLs and `localStorage`. If you add a strict Content-Security-Policy, allow inline scripts/styles and `blob:`/`data:` workers. There are no external origins to allow.
- If the iframe is sandboxed, include `allow-downloads` so the generated PDFs can be saved.
- The same URL can be added as a **Teams website tab**.

### Option C — SharePoint Framework (SPFx)

If you want the editor as a native web part, wrap the built HTML/JS in an SPFx web part and ship it through your app catalog. This repository intentionally stays framework-free so the single-file build remains portable.

## Security and privacy

- **No uploads.** Files are read with the browser’s `FileReader` and processed in memory.
- **No telemetry, analytics or CDN calls.** Third-party libraries are bundled into the HTML.
- **Local storage only.** The only persisted data is the optional list of signatures (`pdf-studio:signatures:v1`). Nothing else is written to disk by the app. You can clear it from the signature dialog by using a different signature, or from the browser’s site-data settings.
- **Downloads** are produced with a Blob URL and the browser’s download flow.

## Limitations (by design)

- **Password-protected / encrypted PDFs are not supported.** Remove the password first. The app shows a clear error rather than producing a broken file.
- **Visual signatures only.** Signatures are flattened images on the page. They are not PAdES/certificate-based digital signatures and do not prove the signer’s identity cryptographically.
- **Black box is not secure redaction.** It visually covers content but leaves the underlying text and objects in the file. Use a dedicated redaction tool when content must be irrecoverably removed.
- **Text annotation font** is the built-in PDF Helvetica (WinAnsi). Western European characters are supported; other scripts are replaced with `?`. Use a drawn/typed/uploaded signature image for names in other scripts.
- **Annotations are flattened** into the downloaded PDF. They are not added as editable PDF annotation objects, so they will not appear in another app’s annotation panel.
- **Page thumbnails/annotations are not OCR’d**, and the highlight tool does not snap to text.
- **Existing form fields and annotations** are preserved and rendered, but the app does not edit form fields. Document outlines/bookmarks and interactive form fields may not survive merging or page extraction in every PDF.
- **Very large documents** can take a while to open and render. Rendering is lazy and runs in a worker where the browser allows it.
- The editor requires a modern browser (current Edge/Chrome/Firefox/Safari). CSS `color-mix()` is used for a few accent colours; browsers older than 2023 may show slightly simplified colours.
## Project layout

```
.github/workflows/
  deploy.yml          GitHub Pages build + deploy on pushes to main
src/
  index.html          markup for the three tools, help and dialogs
  styles.css          light/dark responsive UI
  main.js             tab shell
  merge.js            merge workflow
  split.js            thumbnails, page operations and split outputs
  markup.js           page viewer, annotation tools, undo/redo, export
  annotation.js       annotation model, canvas rendering, hit testing
  pdf-ops.js          pdf-lib operations: merge, copy pages, flatten annotations
  pdfjs-loader.js     PDF.js setup + inlined worker
  signature.js        draw/type/upload signature dialog
  util.js             shared helpers, downloads, ranges, toasts
scripts/
  build.mjs           bundles everything into dist/pdf-studio.html
  serve.mjs           tiny static preview server
tests/
  e2e.mjs             Playwright end-to-end checks
  make-fixtures.mjs   generates the test PDFs
  fixtures/           small generated PDFs (2–3 pages, incl. rotated pages)
dist/
  pdf-studio.html     the deliverable
  index.html          identical copy for static hosts that expect index.html
```

## Tests

`npm test` starts a local static server, launches headless Chromium, and checks:

- merging, reordering and page counts;
- split rotate → save, undo/redo, reorder, delete/undo, extract, split-every-N and range splitting (including ZIP contents);
- markup drawing, text, signatures, undo/redo and flattened export;
- page width/zoom presets (fit width, fit page, fixed percentages, custom zoom);
- exported annotations appear at the correct place when the output is reopened;
- annotation placement on pages rotated 90°, 180° and 270°;
- no console errors and no external network requests.

The fixtures are generated from code, so the tests do not depend on binary files except the small PDFs in `tests/fixtures` (regenerate with `npm run fixtures`).

## Troubleshooting

- **“Could not open the PDF: …encrypted…”** — remove the document password/open permissions, save a copy, and retry.
- **Blank page / “Rendering page…”** — some unusual PDFs use features PDF.js cannot render (for example certain JBIG2/JPX images or optional content). The rest of the document usually still works. Try a different browser or re-save the PDF.
- **Signature not visible after export** — check that it was placed inside the page bounds and that the download completed. Reopening the downloaded file in the app is the quickest verification.
- **SharePoint downloads the HTML instead of opening it** — that is a tenant/library setting. Host the file on a static site and embed it, or use the downloaded file locally.
- **Signature list does not persist** — `localStorage` can be blocked inside some iframes/private windows. The editor still works; signatures just will not be remembered between sessions.

## Credits

Bundled open-source libraries:

- [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0) — rendering and text/font handling
- [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) — document assembly and annotation flattening
- [fflate](https://github.com/101arrowz/fflate) (MIT) — ZIP output for multi-file splits

The UI and application code in this repository were written for this project. Check the licenses of the bundled libraries before redistributing.

