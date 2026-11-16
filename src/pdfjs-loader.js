/* PDF.js loading and worker setup.
   The worker source is generated into ./generated/worker.js at build time and
   inlined so that this app never needs a network request. */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import workerBase64 from './generated/worker.js';

let workerUrl = null;

function ensureWorker() {
  if (workerUrl || !workerBase64) return;
  try {
    if (location.protocol === 'file:') {
      // Chrome blocks blob: workers (and imports) from file:// pages, but data:
      // workers are allowed. This keeps double-clicking the HTML file working.
      workerUrl = `data:text/javascript;base64,${workerBase64}`;
    } else {
      const binary = atob(workerBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      workerUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  } catch (err) {
    console.warn('PDF.js worker could not be created; falling back to the main thread.', err);
  }
}

export function pdfjsVersion() {
  return pdfjsLib.version;
}

/**
 * Open a PDF with PDF.js. The bytes are copied because PDF.js may transfer the
 * underlying buffer to its worker.
 */
export async function openWithPdfjs(bytes) {
  ensureWorker();
  const data = new Uint8Array(bytes.slice(0));
  const task = pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    // Render existing form fields, stamps and links as they appear in readers.
    ...(pdfjsLib.AnnotationMode ? { annotationMode: pdfjsLib.AnnotationMode.ENABLE } : {}),
  });
  return task.promise;
}

export async function renderPdfPageToCanvas(page, canvas, {
  scale = 1,
  rotation = null,
  maxPixels = 6_000_000,
} = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport(rotation == null ? { scale } : { scale, rotation });
  const pixelWidth = Math.max(1, Math.floor(viewport.width * dpr));
  const pixelHeight = Math.max(1, Math.floor(viewport.height * dpr));

  if (pixelWidth * pixelHeight > maxPixels) {
    const factor = Math.sqrt(maxPixels / (pixelWidth * pixelHeight));
    canvas.width = Math.max(1, Math.floor(pixelWidth * factor));
    canvas.height = Math.max(1, Math.floor(pixelHeight * factor));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return viewport;
  }

  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const ctx = canvas.getContext('2d');
  const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
  await page.render({ canvasContext: ctx, viewport, transform }).promise;
  return viewport;
}
