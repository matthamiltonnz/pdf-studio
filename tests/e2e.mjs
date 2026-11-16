import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PDFDocument, PDFName } from 'pdf-lib';
import { unzipSync } from 'fflate';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'pdf-studio-e2e-'));

const server = spawn(process.execPath, [path.join(here, '..', 'scripts', 'serve.mjs')], {
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
process.on('exit', () => {
  try { server.kill(); } catch { /* ignore */ }
});
const baseUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Preview server did not start.')), 8000);
  server.stdout.on('data', (chunk) => {
    const match = String(chunk).match(/(http:\/\/127\.0\.0\.1:\d+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  server.on('exit', (code) => reject(new Error(`Preview server exited with ${code}.`)));
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const problems = [];
page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
page.on('dialog', (dialog) => dialog.accept());
page.on('request', (req) => {
  const url = req.url();
  if (!url.startsWith(baseUrl) && !url.startsWith('blob:') && !url.startsWith('data:')) problems.push(`external request: ${url}`);
});

async function saveDownload(action, name = null) {
  const [download] = await Promise.all([page.waitForEvent('download'), action()]);
  const target = path.join(tmp, name || download.suggestedFilename() || 'download.pdf');
  await download.saveAs(target);
  return target;
}
async function loadPdf(file) {
  return PDFDocument.load(await readFile(file));
}
async function pdfInfo(file) {
  const doc = await loadPdf(file);
  return doc.getPages().map((p) => {
    const size = p.getSize();
    return {
      width: Math.round(size.width),
      height: Math.round(size.height),
      rotation: ((p.getRotation().angle % 360) + 360) % 360,
    };
  });
}

async function annotationSummary(file) {
  const doc = await loadPdf(file);
  return doc.getPages().map((p) => {
    const annots = p.node.Annots();
    const list = [];
    if (!annots) return list;
    for (let i = 0; i < annots.size(); i += 1) {
      const dict = doc.context.lookup(annots.get(i));
      if (!dict || !dict.get) continue;
      const subtype = dict.get(PDFName.of('Subtype'));
      const contents = dict.get(PDFName.of('Contents'));
      const normal = dict.get(PDFName.of('AP'))?.get?.(PDFName.of('N'));
      const stream = normal ? doc.context.lookup(normal) : null;
      const fontDict = stream?.dict?.get?.(PDFName.of('Resources'))?.get?.(PDFName.of('Font'));
      const fonts = [];
      if (fontDict?.keys) {
        for (const key of fontDict.keys()) {
          const base = doc.context.lookup(fontDict.get(key))?.get?.(PDFName.of('BaseFont'));
          if (base) fonts.push(base.toString());
        }
      }
      list.push({
        subtype: subtype ? subtype.toString() : '',
        contents: contents ? contents.toString() : '',
        fonts,
      });
    }
    return list;
  });
}

async function extractText(file, pageNumber) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await readFile(file)), useSystemFonts: true }).promise;
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = content.items.map((item) => item.str).join('\n');
  await doc.destroy();
  return text;
}
function metaText() {
  return page.locator('#markup-meta').textContent();
}
async function waitForMarkup(name) {
  await page.waitForFunction((expected) => {
    const meta = document.querySelector('#markup-meta');
    return meta && meta.textContent.includes(expected);
  }, name, { timeout: 20000 });
  await page.waitForFunction(() => {
    const pageEl = document.querySelector('.page-wrap .page');
    return pageEl && !pageEl.classList.contains('is-loading');
  }, null, { timeout: 20000 });
}
async function openMarkupFile(file, { confirm = false } = {}) {
  if (await page.locator('#panel-markup').isVisible().catch(() => false)) {
    await page.click('#markup-back');
    await page.waitForTimeout(300);
    if (await page.locator('#app-confirm').isVisible().catch(() => false)) {
      await page.click('#app-confirm-ok');
    }
    await page.waitForSelector('#panel-documents:not([hidden])', { timeout: 20000 });
  }
  if (await page.locator('#split-workspace').isVisible().catch(() => false)) {
    await page.click('#split-close');
    await page.waitForSelector('#split-drop:not([hidden])', { timeout: 20000 });
  }
  await page.setInputFiles('#split-input', file);
  await page.waitForFunction(() => document.querySelectorAll('.thumb-edit').length > 0, null, { timeout: 20000 });
  await page.locator('.thumb-edit').first().click();
  await page.waitForSelector('#panel-markup:not([hidden])', { timeout: 20000 });
}

async function setPageWidth(value) {
  await page.selectOption('#page-width', value);
  await page.waitForFunction(() => {
    const pageEl = document.querySelector('.page-wrap .page');
    return pageEl && !pageEl.classList.contains('is-loading');
  }, null, { timeout: 20000 });
}

async function overlayBox(index = 0) {
  return page.locator('.page-wrap').nth(index).locator('canvas.overlay').boundingBox();
}
async function samplePage(fx, fy) {
  return page.evaluate(([x, y]) => {
    const canvas = document.querySelector('.page-wrap canvas.content');
    const ctx = canvas.getContext('2d');
    return Array.from(ctx.getImageData(
      Math.min(canvas.width - 1, Math.floor(canvas.width * x)),
      Math.min(canvas.height - 1, Math.floor(canvas.height * y)),
      1, 1,
    ).data);
  }, [fx, fy]);
}
async function scanDark(x0, y0, x1, y1) {
  return page.evaluate(([ax, ay, bx, by]) => {
    const canvas = document.querySelector('.page-wrap canvas.content');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(
      Math.floor(canvas.width * ax), Math.floor(canvas.height * ay),
      Math.max(1, Math.floor(canvas.width * (bx - ax))),
      Math.max(1, Math.floor(canvas.height * (by - ay))),
    ).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90) dark += 1;
    }
    return dark;
  }, [x0, y0, x1, y1]);
}
// ----------------------------- Documents / merge -----------------------------
await page.goto(`${baseUrl}/pdf-studio.html`, { waitUntil: 'load' });
assert.equal(await page.locator('.tab').count(), 2);
assert.equal(await page.locator('#panel-documents').isVisible(), true);
await page.setInputFiles('#split-input', [path.join(fixtures, 'alpha.pdf'), path.join(fixtures, 'beta.pdf')]);
await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 5, null, { timeout: 20000 });
assert.match(await page.locator('#split-file').textContent(), /5 pages/);

// Reorder a page and download the merged document.
await page.locator('.thumb').first().click();
await page.click('#split-move-right');
const mergedPath = await saveDownload(() => page.click('#split-apply'));
let info = await pdfInfo(mergedPath);
assert.equal(info.length, 5);
assert.deepEqual(info.map((p) => p.width), [420, 400, 440, 400, 400]);
console.log('✓ documents merge + reorder');

// Add another PDF to the existing document.
const chooserPromise = page.waitForEvent('filechooser');
await page.click('#split-add');
const chooser = await chooserPromise;
await chooser.setFiles(path.join(fixtures, 'beta.pdf'));
await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 7, null, { timeout: 20000 });
assert.match(await page.locator('#split-file').textContent(), /7 pages/);
console.log('✓ documents add more PDFs');

// Drag and drop another PDF onto the Documents panel.
const betaBase64 = (await readFile(path.join(fixtures, 'beta.pdf'))).toString('base64');
const dropState = await page.evaluate(({ b64, name }) => {
  const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
  const file = new File([bytes], name, { type: 'application/pdf' });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  const panel = document.querySelector('#panel-documents');
  const overlay = document.querySelector('#documents-drop-overlay');
  panel.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
  const overlayVisible = Boolean(overlay && !overlay.hidden);
  panel.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
  panel.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  return { overlayVisible, overlayHidden: Boolean(overlay && overlay.hidden) };
}, { b64: betaBase64, name: 'beta.pdf' });
assert.equal(dropState.overlayVisible, true, 'the drop overlay should appear');
assert.equal(dropState.overlayHidden, true, 'the drop overlay should hide after dropping');
await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 9, null, { timeout: 20000 });
assert.match(await page.locator('#split-file').textContent(), /9 pages/);
console.log('✓ drag and drop PDFs');

// ----------------------------- Split -----------------------------
await page.goto(`${baseUrl}/pdf-studio.html`, { waitUntil: 'load' });
await page.setInputFiles('#split-input', path.join(fixtures, 'alpha.pdf'));
await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 3, null, { timeout: 20000 });
await page.waitForFunction(() => document.querySelectorAll('.thumb canvas:not([hidden])').length > 0, null, { timeout: 20000 });
assert.equal(await page.locator('.thumb').count(), 3);

// Rotate page 2, save, and check the rotation is applied.
await page.locator('.thumb').nth(1).click();
await page.click('#split-rotate-right');
await page.waitForFunction(() => document.querySelectorAll('.thumb')[1].textContent.includes('90°'));
const rotatedPath = await saveDownload(() => page.click('#split-apply'));
info = await pdfInfo(rotatedPath);
assert.deepEqual(info.map((p) => p.rotation), [0, 90, 0]);
console.log('✓ split rotate/save');

// Undo and redo the rotation.
await page.click('#split-undo');
await page.waitForFunction(() => !document.querySelectorAll('.thumb')[1].textContent.includes('90°'));
await page.click('#split-redo');
await page.waitForFunction(() => document.querySelectorAll('.thumb')[1].textContent.includes('90°'));
console.log('✓ split undo/redo');

// Reset, then move page 3 to the front and save.
await page.click('#split-reset');
await page.click('#split-select-none');
await page.locator('.thumb').nth(2).click();
await page.click('#split-move-left');
await page.click('#split-move-left');
await page.click('#split-select-none');
const reorderedPath = await saveDownload(() => page.click('#split-apply'));
info = await pdfInfo(reorderedPath);
assert.deepEqual(info.map((p) => p.width), [440, 400, 420]);
console.log('✓ split reorder');

// Delete one page, undo the delete.
await page.locator('.thumb').nth(1).click();
await page.click('#split-delete');
await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 2);
await page.click('#split-undo');
await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 3);
console.log('✓ split delete/undo');

// Extract one page.
await page.click('#split-reset');
await page.click('#split-select-none');
await page.locator('.thumb').nth(1).click();
const extractedPath = await saveDownload(() => page.click('#split-extract'));
info = await pdfInfo(extractedPath);
assert.equal(info.length, 1);
assert.deepEqual(info[0], { width: 420, height: 520, rotation: 0 });
console.log('✓ split extract');

// Split every 2 pages into a ZIP.
await page.fill('#split-every', '2');
const zipPath = await saveDownload(() => page.click('#split-every-go'));
const zipEntries = unzipSync(new Uint8Array(await readFile(zipPath)));
assert.equal(Object.keys(zipEntries).length, 2);
const chunkCounts = [];
for (const bytes of Object.values(zipEntries)) {
  chunkCounts.push((await PDFDocument.load(bytes)).getPageCount());
}
assert.deepEqual(chunkCounts.sort(), [1, 2]);
console.log('✓ split every N');

// Split by ranges into a ZIP.
await page.fill('#split-ranges', '1-2, 3');
const rangeZipPath = await saveDownload(() => page.click('#split-ranges-go'));
const rangeEntries = unzipSync(new Uint8Array(await readFile(rangeZipPath)));
assert.equal(Object.keys(rangeEntries).length, 2);
const rangeCounts = [];
for (const bytes of Object.values(rangeEntries)) rangeCounts.push((await PDFDocument.load(bytes)).getPageCount());
assert.deepEqual(rangeCounts.sort(), [1, 2]);
console.log('✓ split by ranges');
// ----------------------------- Markup -----------------------------
await openMarkupFile(path.join(fixtures, 'alpha.pdf'));
await waitForMarkup('alpha.pdf');
assert.equal(await page.locator('.page-wrap').count(), 3);
assert.match(await metaText(), /0 annotations/);

assert.equal(await page.locator('#page-width').inputValue(), 'fit-width');
const fitWidthPercent = Number((await page.locator('#zoom-label').textContent()).replace('%', ''));
await setPageWidth('fit-page');
const fitPagePercent = Number((await page.locator('#zoom-label').textContent()).replace('%', ''));
assert.ok(fitWidthPercent > fitPagePercent, `fit width ${fitWidthPercent}% should be larger than fit page ${fitPagePercent}%`);
await setPageWidth('150');
assert.equal(await page.locator('#zoom-label').textContent(), '150%');
await page.click('#zoom-in');
assert.equal(await page.locator('#page-width').inputValue(), 'custom');
await setPageWidth('fit-page');
console.log('✓ page width and zoom controls');

let box = await overlayBox(0);
await page.click('[data-tool="highlight"]');
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.35);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('#markup-meta').textContent.includes('1 annotation'));
assert.match(await metaText(), /1 annotation/);

await page.click('#markup-undo');
await page.waitForFunction(() => document.querySelector('#markup-meta').textContent.includes('0 annotations'));
await page.click('#markup-redo');
await page.waitForFunction(() => document.querySelector('#markup-meta').textContent.includes('1 annotation'));
console.log('✓ markup draw/undo/redo');

await page.click('[data-tool="text"]');
await page.waitForSelector('#text-options:not([hidden])');
await page.selectOption('#ann-font', 'times');
await page.selectOption('#ann-font-style', 'bolditalic');
await page.locator('#ann-size').evaluate((el) => {
  el.value = '22';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
assert.equal(await page.locator('#size-value').textContent(), '22');
await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.62);
await page.waitForSelector('#text-editor:not([hidden])');
await page.fill('#text-editor-input', 'Reviewed locally');
await page.click('#text-editor-ok');
await page.waitForFunction(() => document.querySelector('#markup-meta').textContent.includes('2 annotations'));
console.log('✓ markup text');

await page.click('[data-tool="signature"]');
await page.waitForSelector('#sig-modal:not([hidden])');
const pad = await page.locator('#sig-pad').boundingBox();
await page.mouse.move(pad.x + pad.width * 0.15, pad.y + pad.height * 0.55);
await page.mouse.down();
await page.mouse.move(pad.x + pad.width * 0.35, pad.y + pad.height * 0.3, { steps: 8 });
await page.mouse.move(pad.x + pad.width * 0.5, pad.y + pad.height * 0.65, { steps: 8 });
await page.mouse.move(pad.x + pad.width * 0.8, pad.y + pad.height * 0.35, { steps: 8 });
await page.mouse.up();
await page.fill('#sig-name', 'Alex Morgan');
await page.click('#sig-save');
await page.waitForSelector('#sig-modal', { state: 'hidden' });
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.68);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.82, { steps: 8 });
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('#markup-meta').textContent.includes('3 annotations'));
console.log('✓ markup signature');

// Exercise the remaining native annotation types.
await page.evaluate(() => { document.querySelector('#page-scroll').scrollTop = 0; });
box = await overlayBox(0);
await page.click('[data-tool="rect"]');
await page.mouse.move(box.x + box.width * 0.06, box.y + box.height * 0.06);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.28, box.y + box.height * 0.16, { steps: 6 });
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('#markup-meta').textContent.includes('4 annotations'));

await page.click('[data-tool="ink"]');
await page.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.08);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.14, { steps: 5 });
await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.07, { steps: 5 });
await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.15, { steps: 5 });
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('#markup-meta').textContent.includes('5 annotations'));

await page.click('[data-tool="arrow"]');
await page.mouse.move(box.x + box.width * 0.64, box.y + box.height * 0.2);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.84, box.y + box.height * 0.32, { steps: 6 });
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('#markup-meta').textContent.includes('6 annotations'));

await page.click('[data-tool="comment"]');
await page.mouse.click(box.x + box.width * 0.58, box.y + box.height * 0.55);
await page.waitForSelector('#text-editor:not([hidden])');
await page.fill('#text-editor-input', 'Comment note');
await page.click('#text-editor-ok');
await page.waitForSelector('#text-editor', { state: 'hidden' });
await page.waitForFunction(() => document.querySelector('#markup-meta').textContent.includes('7 annotations'));
console.log('✓ markup rectangle/ink/arrow/comment');

const editedPath = await saveDownload(() => page.click('#markup-download'));

const edited = await loadPdf(editedPath);
assert.equal(edited.getPageCount(), 3);
const nativeAnnotations = await annotationSummary(editedPath);
assert.deepEqual(
  nativeAnnotations[0].map((ann) => ann.subtype).sort(),
  ['/FreeText', '/FreeText', '/Highlight', '/Ink', '/Line', '/Square', '/Stamp'].sort(),
);
const freeText = nativeAnnotations[0].find((ann) => ann.subtype === '/FreeText' && ann.contents.includes('Reviewed locally'));
assert.ok(freeText, 'FreeText annotation should keep its text');
assert.ok(freeText.fonts.includes('/Times-BoldItalic'), `expected Times bold italic font, got ${freeText.fonts.join(', ')}`);

await page.uncheck('#editable-annotations');
const flattenedPath = await saveDownload(() => page.click('#markup-download'), 'alpha-flattened.pdf');
const flattenedAnnotations = await annotationSummary(flattenedPath);
assert.equal(flattenedAnnotations[0].length, 0, 'flattened export should not add PDF annotation objects');
assert.equal((await loadPdf(flattenedPath)).getPageCount(), 3);
await page.check('#editable-annotations');
console.log('✓ native annotations + flattened export');

await openMarkupFile(editedPath, { confirm: true });
await waitForMarkup('alpha-edited.pdf');
assert.match(await metaText(), /7 embedded PDF annotations · read-only/);
assert.match(await metaText(), /0 annotations/);
const highlightPixel = await samplePage(0.4, 0.425);
assert.ok(highlightPixel[0] > 230 && highlightPixel[1] > 215 && highlightPixel[2] < 210, `highlight pixel was ${highlightPixel}`);
const signaturePixels = await scanDark(0.55, 0.7, 0.85, 0.8);
assert.ok(signaturePixels > 20, `expected signature pixels, found ${signaturePixels}`);
const textPixels = await scanDark(0.18, 0.6, 0.62, 0.7);
assert.ok(textPixels > 10, `expected native text pixels, found ${textPixels}`);
console.log('✓ markup export/flatten (highlight + signature)');

// ----------------------------- Rotated pages (90 / 180 / 270) -----------------------------
const rotatedFiles = [
  ['rotated.pdf', 'rotated-edited.pdf'],
  ['rotated-180.pdf', 'rotated-180-edited.pdf'],
  ['rotated-270.pdf', 'rotated-270-edited.pdf'],
];
for (const [fixture, expectedName] of rotatedFiles) {
  await openMarkupFile(path.join(fixtures, fixture));
  await waitForMarkup(fixture);
  await setPageWidth('fit-page');
  box = await overlayBox(0);
  await page.click('[data-tool="highlight"]');
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();

  await page.click('[data-tool="signature"]');
  if (await page.locator('#sig-modal').isVisible()) {
    const sigPad = await page.locator('#sig-pad').boundingBox();
    await page.mouse.move(sigPad.x + sigPad.width * 0.2, sigPad.y + sigPad.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(sigPad.x + sigPad.width * 0.45, sigPad.y + sigPad.height * 0.3, { steps: 6 });
    await page.mouse.move(sigPad.x + sigPad.width * 0.75, sigPad.y + sigPad.height * 0.6, { steps: 6 });
    await page.mouse.up();
    await page.click('#sig-save');
    await page.waitForSelector('#sig-modal', { state: 'hidden' });
  }
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.7, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('#markup-meta').textContent.includes('2 annotations'));

  const outPath = await saveDownload(() => page.click('#markup-download'));
  await openMarkupFile(outPath, { confirm: true });
  await waitForMarkup(expectedName);
  const pixel = await samplePage(0.35, 0.4);
  assert.ok(pixel[0] > 230 && pixel[1] > 215 && pixel[2] < 210, `${fixture} highlight pixel was ${pixel}`);
  const sigPixels = await scanDark(0.55, 0.58, 0.85, 0.68);
  assert.ok(sigPixels > 10, `${fixture} signature pixels: ${sigPixels}`);
  console.log(`✓ rotated page mapping (${fixture})`);
}

// ----------------------------- Secure redaction -----------------------------
await openMarkupFile(path.join(fixtures, 'alpha.pdf'));
await waitForMarkup('alpha.pdf');
await setPageWidth('fit-page');
box = await overlayBox(0);
await page.click('[data-tool="mask"]');
assert.equal(await page.locator('#ann-color').isDisabled(), true, 'redaction colour must stay locked to black');
await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.3);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.52, { steps: 8 });
await page.mouse.up();
await page.waitForFunction(() => {
  const text = document.querySelector('#markup-meta').textContent;
  return text.includes('1 annotation') && text.includes('redaction');
});

const redactedPromise = page.waitForEvent('download');
await page.click('#markup-download');
await page.waitForSelector('#app-confirm');
const redactionWarning = await page.locator('#app-confirm').textContent();
assert.match(redactionWarning, /Permanently remove/i);
assert.match(redactionWarning, /no longer selectable or searchable/i);
assert.match(redactionWarning, /links, form fields, existing annotations/i);
await page.click('#app-confirm-ok');
const redactedDownload = await redactedPromise;
const redactedPath = path.join(tmp, 'alpha-redacted.pdf');
await redactedDownload.saveAs(redactedPath);

const redactedDoc = await loadPdf(redactedPath);
assert.equal(redactedDoc.getPageCount(), 3);
assert.equal((await annotationSummary(redactedPath))[0].length, 0, 'redactions must not become annotation objects');
const redactedResources = redactedDoc.getPage(0).node.Resources();
assert.ok(redactedResources && redactedResources.lookup(PDFName.of('XObject')), 'redacted page should be an image');

const originalText = await extractText(path.join(fixtures, 'alpha.pdf'), 1);
assert.match(originalText, /Page 1/);
const redactedText = await extractText(redactedPath, 1);
assert.ok(!redactedText.includes('Page 1') && !redactedText.includes('PDF Studio test document'), `redacted text leaked: ${redactedText}`);
assert.match(await extractText(redactedPath, 2), /Page 2/);
console.log('✓ secure redaction removes page text');

await openMarkupFile(redactedPath, { confirm: true });
await waitForMarkup('alpha-redacted.pdf');
await setPageWidth('fit-page');
const redactedPixel = await samplePage(0.35, 0.4);
assert.ok(redactedPixel[0] < 30 && redactedPixel[1] < 30 && redactedPixel[2] < 30, `redaction pixel was ${redactedPixel}`);
console.log('✓ redacted page renders');

// ----------------------------- Visual box (colour, text remains) -----------------------------
await openMarkupFile(path.join(fixtures, 'alpha.pdf'));
await waitForMarkup('alpha.pdf');
await setPageWidth('fit-page');
box = await overlayBox(0);
await page.click('[data-tool="blackbox"]');
assert.equal(await page.locator('#ann-color').isEnabled(), true, 'box colour picker should be enabled');
await page.locator('#ann-color').evaluate((el) => {
  el.value = '#e11d48';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.3);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.52, { steps: 8 });
await page.mouse.up();
const overlayPixel = await page.evaluate(() => {
  const canvas = document.querySelector('.page-wrap canvas.overlay');
  const ctx = canvas.getContext('2d');
  return Array.from(ctx.getImageData(Math.floor(canvas.width * 0.35), Math.floor(canvas.height * 0.4), 1, 1).data);
});
assert.ok(overlayPixel[0] > 150 && overlayPixel[1] < 100 && overlayPixel[2] < 120, `overlay box pixel was ${overlayPixel}`);
console.log('✓ box paints a solid colour in the editor');

await page.waitForFunction(() => document.querySelector('#markup-meta').textContent.includes('text remains available'));
const blackboxToast = await page.locator('#toasts').textContent();
assert.match(blackboxToast, /text underneath is still in the PDF/i);
const blackboxPath = await saveDownload(() => page.click('#markup-download'), 'alpha-blackbox.pdf');
const blackboxAnnotations = await annotationSummary(blackboxPath);
assert.equal(blackboxAnnotations[0].length, 1);
assert.equal(blackboxAnnotations[0][0].subtype, '/Square');
assert.match(blackboxAnnotations[0][0].contents, /visual only/i);
assert.match(await extractText(blackboxPath, 1), /Page 1/);

await openMarkupFile(blackboxPath, { confirm: true });
await waitForMarkup('alpha-blackbox.pdf');
await setPageWidth('fit-page');
const blackboxPixel = await samplePage(0.35, 0.4);
assert.ok(blackboxPixel[0] > 150 && blackboxPixel[1] < 100 && blackboxPixel[2] < 120, `box pixel was ${blackboxPixel}`);
console.log('✓ coloured box covers visually while text remains');

// ----------------------------- Save & return to documents -----------------------------
await openMarkupFile(path.join(fixtures, 'alpha.pdf'));
await waitForMarkup('alpha.pdf');
await setPageWidth('fit-page');
box = await overlayBox(0);
await page.click('[data-tool="highlight"]');
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.35);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45, { steps: 8 });
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('#markup-meta').textContent.includes('1 annotation'));
await page.click('#markup-back');
await page.waitForSelector('#panel-documents:not([hidden])', { timeout: 20000 });
await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 3, null, { timeout: 20000 });
const returnedPath = await saveDownload(() => page.click('#split-apply'));
const returnedAnnotations = await annotationSummary(returnedPath);
assert.ok(
  returnedAnnotations[0].some((ann) => ann.subtype === '/Highlight'),
  'markup saved from the editor should survive returning to documents',
);
console.log('✓ save markup and return to documents');


// ----------------------------- Open a specific page -----------------------------
await page.locator('.thumb-edit').nth(1).click();
await waitForMarkup('alpha.pdf');
await page.waitForFunction(() => document.querySelector('#page-scroll').scrollTop > 0, null, { timeout: 10000 });
console.log('✓ mark up opens the selected page');
await page.click('#markup-back');
await page.waitForSelector('#panel-documents:not([hidden])', { timeout: 20000 });


// ----------------------------- Offline file:// -----------------------------
const offline = await context.newPage();
const offlineProblems = [];
offline.on('console', (msg) => { if (msg.type() === 'error') offlineProblems.push(`console: ${msg.text()}`); });
offline.on('pageerror', (err) => offlineProblems.push(`pageerror: ${err.message}`));
await offline.goto(pathToFileURL(path.join(here, '..', 'dist', 'pdf-studio.html')).href, { waitUntil: 'load' });
await offline.setInputFiles('#split-input', path.join(fixtures, 'alpha.pdf'));
await offline.waitForFunction(() => document.querySelectorAll('.thumb').length === 3, null, { timeout: 20000 });
await offline.waitForFunction(() => document.querySelectorAll('.thumb canvas:not([hidden])').length > 0, null, { timeout: 20000 });
assert.deepEqual(offlineProblems, []);
console.log('✓ offline file:// worker');
await offline.close();

assert.deepEqual(problems, []);
console.log(`All checks passed. Downloads in ${tmp}`);

await browser.close();
server.kill();


