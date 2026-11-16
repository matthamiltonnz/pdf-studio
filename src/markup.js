/* Sign & mark up: page viewer, annotation tools, undo/redo and PDF export. */
import {
  $, clamp, debounce, errorMessage, baseName, confirmDialog, downloadBytes, formatBytes, isEditableTarget,
  readFileBytes, toast, withBusy,
} from './util.js';
import {
  annotationBounds, createAnnotation, drawAnnotations, hitTestAnnotation,
  moveAnnotation, resizeAnnotation, selectionHandle,
} from './annotation.js';
import { inspectPdf } from './pdf-ops.js';
import { exportAnnotatedPdf } from './pdf-export.js';
import { openWithPdfjs } from './pdfjs-loader.js';
import { openSignatureModal } from './signature.js';

const TEXT_TOOLS = new Set(['text', 'comment']);
const RECT_TOOLS = new Set(['highlight', 'rect', 'mask', 'blackbox', 'signature']);

const TOOL_DEFAULTS = {
  select: { color: '#2563eb', width: 2, opacity: 1, fontSize: 14 },
  highlight: { color: '#ffd400', width: 2, opacity: 0.35, fontSize: 14 },
  ink: { color: '#dc2626', width: 2, opacity: 1, fontSize: 14 },
  text: { color: '#111827', width: 2, opacity: 1, fontSize: 16, fontFamily: 'helvetica', fontStyle: 'normal' },
  comment: { color: '#eab308', width: 2, opacity: 1, fontSize: 14, fontFamily: 'helvetica', fontStyle: 'normal' },
  rect: { color: '#dc2626', width: 2, opacity: 1, fontSize: 14 },
  arrow: { color: '#dc2626', width: 2, opacity: 1, fontSize: 14 },
  mask: { color: '#111827', width: 2, opacity: 1, fontSize: 14 },
  blackbox: { color: '#111827', width: 2, opacity: 1, fontSize: 14 },
  signature: { color: '#111827', width: 2, opacity: 1, fontSize: 14 },
};

const state = {
  name: '',
  bytes: null,
  pdfjsDoc: null,
  pageViews: [],
  annotations: {},
  tool: 'select',
  settings: JSON.parse(JSON.stringify(TOOL_DEFAULTS)),
  selectedId: null,
  selectedPage: null,
  draft: null,
  pointer: null,
  scale: 1,
  fitMode: 'width',
  history: [],
  historyIndex: -1,
  pendingSignature: null,
  maskWarned: false,
  blackboxWarned: false,
  blackboxWarnAt: 0,
  embeddedAnnotations: 0,
  busy: false,
  textTarget: null,
  observer: null,
  initialized: false,
  renderGeneration: 0,
  renderQueue: [],
  rendering: 0,
  onDone: null,
  finishing: false,
};

export function initMarkup() {
  if (state.initialized) return;
  state.initialized = true;

  const drop = $('#markup-drop');
  const input = $('#markup-input');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });

  let dragDepth = 0;
  drop.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    drop.classList.add('is-dragover');
  });
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  drop.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) drop.classList.remove('is-dragover');
  });
  drop.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    drop.classList.remove('is-dragover');
    const file = event.dataTransfer?.files?.[0];
    if (file) await openFile(file);
  });

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (file) await openFile(file);
  });

  $('#markup-open').addEventListener('click', () => input.click());
  $('#markup-back').addEventListener('click', finishMarkup);
  $('#markup-download').addEventListener('click', downloadMarkedUp);
  $('#editable-annotations').addEventListener('change', updateMeta);
  $('#markup-undo').addEventListener('click', () => stepHistory(-1));
  $('#markup-redo').addEventListener('click', () => stepHistory(1));
  $('#markup-delete').addEventListener('click', deleteSelected);

  document.querySelectorAll('#tool-group [data-tool]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.tool === 'signature' && state.tool === 'signature') {
        beginSignature();
        return;
      }
      setTool(button.dataset.tool);
    });
  });

  $('#ann-color').addEventListener('input', (event) => {
    activeSettings().color = event.target.value;
  });
  $('#ann-size').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    if (TEXT_TOOLS.has(state.tool)) activeSettings().fontSize = value;
    else activeSettings().width = value;
    syncControls();
  });
  $('#ann-font').addEventListener('change', (event) => {
    activeSettings().fontFamily = event.target.value;
  });
  $('#ann-font-style').addEventListener('change', (event) => {
    activeSettings().fontStyle = event.target.value;
  });
  $('#ann-opacity').addEventListener('input', (event) => {
    activeSettings().opacity = Number(event.target.value) / 100;
  });

  $('#zoom-in').addEventListener('click', () => applyZoom(state.scale * 1.2, 'custom'));
  $('#zoom-out').addEventListener('click', () => applyZoom(state.scale / 1.2, 'custom'));
  $('#page-width').addEventListener('change', (event) => {
    const value = event.target.value;
    if (value === 'fit-width') applyZoom(fitWidthScale(), 'width');
    else if (value === 'fit-page') applyZoom(fitPageScale(), 'page');
    else if (value !== 'custom') applyZoom(Number(value) / 100, 'percent');
  });

  $('#page-scroll').addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', debounce(() => {
    if (!state.pdfjsDoc || (state.fitMode !== 'width' && state.fitMode !== 'page')) return;
    applyZoom(state.fitMode === 'width' ? fitWidthScale() : fitPageScale(), state.fitMode, false);
  }, 160));

  $('#text-editor-ok').addEventListener('click', commitTextEditor);
  $('#text-editor-cancel').addEventListener('click', closeTextEditor);
  $('#text-editor-input').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      commitTextEditor();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeTextEditor();
    }
  });
  document.addEventListener('keydown', onKeyDown);
  setTool('select');
}


function cloneAnnotationMap(source) {
  const out = {};
  if (!source) return out;
  for (const [page, list] of Object.entries(source)) {
    if (!Array.isArray(list) || !list.length) continue;
    out[Number(page)] = JSON.parse(JSON.stringify(list));
  }
  return out;
}

export async function openMarkupDocument({ name, bytes, page = 1, annotations = {}, onDone } = {}) {
  if (!bytes) return;
  try {
    await inspectPdf(bytes);
    const pdfjsDoc = await openWithPdfjs(bytes);
    await mountDocument(name || 'document.pdf', bytes, pdfjsDoc, annotations);
    state.onDone = onDone || null;
    const target = state.pageViews[Math.max(0, page - 1)];
    if (target) {
      requestAnimationFrame(() => {
        const scroll = $('#page-scroll');
        scroll.scrollTop = Math.max(0, target.wrap.offsetTop - 12);
      });
    }
    window.dispatchEvent(new CustomEvent('pdfstudio:show-tab', { detail: 'markup' }));
  } catch (err) {
    toast(`Could not open the page for markup: ${errorMessage(err)}`, 'error', 7000);
    throw err;
  }
}


async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name || '') && file.type !== 'application/pdf') {
    toast('Please choose a PDF file.', 'warn');
    return;
  }
  if (annotationCount() > 0) {
    const proceed = await confirmDialog('Opening another PDF will discard your current annotations.', {
      title: 'Discard annotations?',
      okLabel: 'Discard & open',
    });
    if (!proceed) return;
  }
  try {
    const bytes = await readFileBytes(file);
    await inspectPdf(bytes);
    const pdfjsDoc = await openWithPdfjs(bytes);
    await mountDocument(file.name || 'document.pdf', bytes, pdfjsDoc);
  } catch (err) {
    toast(`Could not open the PDF: ${errorMessage(err)}`, 'error', 7000);
  }
}

async function mountDocument(name, bytes, pdfjsDoc, annotations = {}) {
  const count = pdfjsDoc.numPages;
  const pageProxies = [];
  for (let i = 1; i <= count; i += 1) pageProxies.push(await pdfjsDoc.getPage(i));

  let embeddedAnnotations = 0;
  await Promise.all(pageProxies.map(async (pageProxy) => {
    try {
      const annotations = await pageProxy.getAnnotations({ intent: 'display' });
      embeddedAnnotations += annotations.filter((ann) => !['Link', 'Widget', 'Popup'].includes(ann.subtype)).length;
    } catch {
      // Annotation metadata is optional; rendering still works without it.
    }
  }));

  if (state.pdfjsDoc) {
    state.renderGeneration += 1;
    for (const pv of state.pageViews) {
      if (pv.renderTask) {
        try { pv.renderTask.cancel(); } catch { /* ignore */ }
        pv.renderTask = null;
      }
      pv.renderQueued = false;
    }
    try { state.pdfjsDoc.destroy(); } catch { /* ignore */ }
  }
  if (state.observer) state.observer.disconnect();
  state.renderGeneration += 1;
  state.renderQueue = [];
  state.rendering = 0;

  state.name = name;
  state.bytes = bytes;
  state.pdfjsDoc = pdfjsDoc;
  state.annotations = cloneAnnotationMap(annotations);
  state.history = [];
  state.historyIndex = -1;
  state.embeddedAnnotations = embeddedAnnotations;
  state.selectedId = null;
  state.selectedPage = null;
  state.draft = null;
  state.pointer = null;
  state.textTarget = null;
  state.scale = 1;
  state.fitMode = 'width';

  const host = $('#pages');
  host.textContent = '';
  state.pageViews = pageProxies.map((page, index) => {
    const viewport = page.getViewport({ scale: 1 });
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.index = String(index);

    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `Page ${index + 1}`;

    const pageDiv = document.createElement('div');
    pageDiv.className = 'page is-loading';
    const canvas = document.createElement('canvas');
    canvas.className = 'content';
    const overlay = document.createElement('canvas');
    overlay.className = 'overlay';
    overlay.setAttribute('aria-hidden', 'true');
    pageDiv.append(canvas, overlay);
    wrap.append(label, pageDiv);
    host.appendChild(wrap);

    const pv = {
      index,
      page,
      baseW: viewport.width,
      baseH: viewport.height,
      wrap,
      pageDiv,
      canvas,
      overlay,
      renderedScale: null,
      renderTask: null,
      renderQueued: false,
      visible: false,
      error: false,
    };
    wrap._pv = pv;
    overlay.addEventListener('pointerdown', (event) => onPointerDown(event, pv));
    overlay.addEventListener('pointermove', (event) => onPointerMove(event, pv));
    overlay.addEventListener('pointerup', (event) => onPointerUp(event, pv));
    overlay.addEventListener('pointercancel', (event) => onPointerCancel(event, pv));
    return pv;
  });

  state.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const pv = entry.target._pv;
      if (!pv) continue;
      pv.visible = entry.isIntersecting;
      if (entry.isIntersecting) enqueueRender(pv);
    }
  }, { root: $('#page-scroll'), rootMargin: '700px 0px' });
  state.pageViews.forEach((pv) => state.observer.observe(pv.wrap));

  $('#markup-drop').hidden = true;
  $('#markup-workspace').hidden = false;
  $('#panel-markup').classList.add('is-open');
  if (!$('#panel-markup').hidden) document.body.classList.add('markup-editing');
  $('#page-scroll').scrollTop = 0;
  $('#page-scroll').scrollLeft = 0;
  for (const pv of state.pageViews) sizePageView(pv);
  updateMeta();
  applyZoom(fitWidthScale(), 'width', false);
  recordHistory();
  updateToolbarState();
  toast(`Opened ${name} · ${count} page${count === 1 ? '' : 's'}.`, 'success');
}
function pageViewport() {
  const scroll = $('#page-scroll');
  const styles = getComputedStyle(scroll);
  const padX = parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0');
  const padY = parseFloat(styles.paddingTop || '0') + parseFloat(styles.paddingBottom || '0');
  const width = Math.max(160, (scroll.clientWidth || window.innerWidth - 60) - padX - 8);
  const height = Math.max(200, (scroll.clientHeight || window.innerHeight - 300) - padY - 8);
  const widest = Math.max(...state.pageViews.map((pv) => pv.baseW), 400);
  const tallest = Math.max(...state.pageViews.map((pv) => pv.baseH), 500);
  return { width, height, widest, tallest };
}

function fitWidthScale() {
  const { width, widest } = pageViewport();
  return clamp(width / widest, 0.12, 6);
}

function fitPageScale() {
  const { width, height, widest, tallest } = pageViewport();
  return clamp(Math.min(width / widest, height / tallest), 0.12, 6);
}

function applyZoom(nextScale, mode = 'custom', preserveScroll = true) {
  if (!state.pageViews.length) return;
  const scroll = $('#page-scroll');
  const oldTop = scroll.scrollTop;
  const oldMax = scroll.scrollHeight - scroll.clientHeight;
  const ratio = oldMax > 0 ? oldTop / oldMax : 0;
  const oldLeft = scroll.scrollLeft;
  const oldMaxX = scroll.scrollWidth - scroll.clientWidth;
  const ratioX = oldMaxX > 0 ? oldLeft / oldMaxX : 0;

  state.scale = clamp(Number(nextScale) || 1, 0.1, 6);
  state.fitMode = mode;
  state.renderGeneration += 1;
  state.renderQueue = [];
  for (const pv of state.pageViews) {
    if (pv.renderTask) {
      try { pv.renderTask.cancel(); } catch { /* ignore */ }
      pv.renderTask = null;
    }
    pv.renderedScale = null;
    pv.renderQueued = false;
    sizePageView(pv);
  }
  $('#zoom-label').textContent = `${Math.round(state.scale * 100)}%`;
  const widthSelect = $('#page-width');
  if (mode === 'width') widthSelect.value = 'fit-width';
  else if (mode === 'page') widthSelect.value = 'fit-page';
  else if (mode === 'percent') widthSelect.value = String(Math.round(state.scale * 100));
  else widthSelect.value = 'custom';

  for (const pv of state.pageViews) {
    if (pv.visible) enqueueRender(pv);
  }
  if (preserveScroll) {
    requestAnimationFrame(() => {
      scroll.scrollTop = ratio * (scroll.scrollHeight - scroll.clientHeight);
      scroll.scrollLeft = ratioX * (scroll.scrollWidth - scroll.clientWidth);
    });
  }
}

function sizePageView(pv) {
  const width = Math.max(1, pv.baseW * state.scale);
  const height = Math.max(1, pv.baseH * state.scale);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  pv.pageDiv.style.width = `${width}px`;
  pv.pageDiv.style.height = `${height}px`;
  for (const canvas of [pv.canvas, pv.overlay]) {
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
  }
  pv.pageDiv.classList.add('is-loading');
  drawOverlay(pv);
}

function enqueueRender(pv) {
  if (pv.renderedScale === state.scale || pv.renderQueued || pv.error) return;
  pv.renderQueued = true;
  state.renderQueue.push({ pv, generation: state.renderGeneration });
  pumpRenderQueue();
}

function pumpRenderQueue() {
  while (state.rendering < 2 && state.renderQueue.length) {
    const job = state.renderQueue.shift();
    if (job.generation !== state.renderGeneration) {
      job.pv.renderQueued = false;
      continue;
    }
    state.rendering += 1;
    renderPageView(job.pv, job.generation)
      .catch(() => { /* handled inside */ })
      .finally(() => {
        state.rendering = Math.max(0, state.rendering - 1);
        pumpRenderQueue();
      });
  }
}

async function renderPageView(pv, generation) {
  pv.renderQueued = false;
  if (generation !== state.renderGeneration || !pv.wrap.isConnected) return;
  const viewport = pv.page.getViewport({ scale: state.scale });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  pv.canvas.width = Math.max(1, Math.round(viewport.width * dpr));
  pv.canvas.height = Math.max(1, Math.round(viewport.height * dpr));
  pv.canvas.style.width = `${viewport.width}px`;
  pv.canvas.style.height = `${viewport.height}px`;
  const ctx = pv.canvas.getContext('2d');
  const task = pv.page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  });
  pv.renderTask = task;
  try {
    await task.promise;
    if (generation !== state.renderGeneration) return;
    pv.renderedScale = state.scale;
    pv.pageDiv.classList.remove('is-loading');
    drawOverlay(pv);
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    if (generation !== state.renderGeneration) return;
    pv.error = true;
    pv.pageDiv.classList.remove('is-loading');
    toast(`Page ${pv.index + 1} could not be rendered.`, 'error');
  } finally {
    if (pv.renderTask === task) pv.renderTask = null;
  }
}
function activeSettings() {
  return state.settings[state.tool] || state.settings.select;
}

function annotationList(index) {
  return state.annotations[index] || [];
}

function annotationCount() {
  return Object.values(state.annotations).reduce((sum, list) => sum + list.length, 0);
}

function countRedactions() {
  return Object.values(state.annotations).reduce(
    (sum, list) => sum + list.filter((ann) => ann.type === 'mask').length,
    0,
  );
}

function countBlackboxes() {
  return Object.values(state.annotations).reduce(
    (sum, list) => sum + list.filter((ann) => ann.type === 'blackbox').length,
    0,
  );
}

function findSelected() {
  if (!state.selectedId || state.selectedPage == null) return null;
  const list = annotationList(state.selectedPage);
  const ann = list.find((item) => item.id === state.selectedId);
  return ann ? { ann, list, page: state.selectedPage } : null;
}

function updateMeta() {
  const host = $('#markup-meta');
  host.textContent = '';
  if (!state.bytes) return;
  const count = annotationCount();
  const chips = [
    state.name,
    `${state.pdfjsDoc ? state.pdfjsDoc.numPages : 0} pages`,
    formatBytes(state.bytes.byteLength),
    `${count} annotation${count === 1 ? '' : 's'}`,
  ];
  for (const text of chips) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = text;
    host.appendChild(chip);
  }
  const redactions = countRedactions();
  if (redactions > 0) {
    const warn = document.createElement('span');
    warn.className = 'chip warn';
    warn.textContent = `${redactions} redaction${redactions === 1 ? '' : 's'} · page text/links/forms removed on export`;
    host.appendChild(warn);
  }
  const blackboxes = countBlackboxes();
  if (blackboxes > 0) {
    const warn = document.createElement('span');
    warn.className = 'chip warn';
    warn.textContent = `${blackboxes} box${blackboxes === 1 ? '' : 'es'} · text remains available`;
    host.appendChild(warn);
  }
  if (state.embeddedAnnotations > 0) {
    const embedded = document.createElement('span');
    embedded.className = 'chip';
    embedded.textContent = `${state.embeddedAnnotations} embedded PDF annotation${state.embeddedAnnotations === 1 ? '' : 's'} · read-only`;
    host.appendChild(embedded);
  }
  const note = document.createElement('span');
  note.className = 'chip';
  note.textContent = $('#editable-annotations')?.checked === false ? 'Flattened on download' : 'Annotations kept editable';
  host.appendChild(note);
}

function updateToolbarState() {
  const selected = Boolean(findSelected());
  $('#markup-delete').disabled = !selected;
  $('#markup-undo').disabled = state.historyIndex <= 0;
  $('#markup-redo').disabled = state.historyIndex >= state.history.length - 1;
}

function syncControls() {
  const settings = activeSettings();
  const isText = TEXT_TOOLS.has(state.tool);
  const isSelect = state.tool === 'select';
  const isSignature = state.tool === 'signature';
  const colorLocked = isSelect || isSignature || state.tool === 'mask';
  const sizeLocked = colorLocked || state.tool === 'blackbox';
  $('#size-label').textContent = isText ? 'Font size' : 'Size';
  $('#ann-size').value = String(isText ? settings.fontSize : settings.width);
  $('#size-value').textContent = String(isText ? settings.fontSize : settings.width);
  $('#ann-size').disabled = sizeLocked;
  $('#text-options').hidden = !isText;
  $('#ann-font').value = settings.fontFamily || 'helvetica';
  $('#ann-font-style').value = settings.fontStyle || 'normal';
  $('#ann-color').value = settings.color;
  $('#ann-color').disabled = colorLocked;
  $('#ann-opacity').value = String(Math.round((settings.opacity ?? 1) * 100));
  $('#ann-opacity').disabled = sizeLocked;
}

const TOOL_HINTS = {
  select: 'Click an annotation to move it. Drag the bottom-right handle to resize shapes and signatures. Press Delete to remove.',
  highlight: 'Drag across the page to highlight an area. Use the opacity slider to make it lighter or stronger.',
  ink: 'Draw freehand with the mouse, pen or finger. The Size slider controls the line thickness.',
  text: 'Click a page to type text. Press Ctrl/Cmd + Enter to add it.',
  comment: 'Click a page to add a comment box. Press Ctrl/Cmd + Enter to add it.',
  rect: 'Drag to draw a rectangle outline.',
  arrow: 'Drag from the tail to the tip of the arrow.',
  mask: 'Redact permanently removes covered content on export. The whole page is rasterised: text becomes unsearchable, links and form fields are flattened, and document outlines may be lost.',
  blackbox: 'Box only covers content visually. The text and objects underneath remain in the PDF and can still be searched or copied. Use Redact to remove them permanently.',
  signature: (toolState) => (toolState.pendingSignature
    ? 'Drag a box on the page to place your signature. Drag a larger box to make it bigger.'
    : 'Create a signature first, then drag a box on the page to place it.'),
};

function beginSignature() {
  openSignatureModal((dataUrl) => {
    state.pendingSignature = dataUrl;
    toast('Signature ready. Drag a box on the page to place it.', 'success');
    if (state.tool === 'signature') {
      $('#markup-hint').textContent = TOOL_HINTS.signature(state);
      $('#markup-hint').title = $('#markup-hint').textContent;
    }
  });
}

function warnBlackbox(placed = false) {
  const now = Date.now();
  if (!placed && state.blackboxWarnAt && now - state.blackboxWarnAt < 8000) return;
  state.blackboxWarnAt = now;
  toast(
    placed
      ? 'Box added — it only covers the content visually. The text underneath is still in the PDF and can be searched or copied. Use Redact to remove it permanently.'
      : 'Box only covers content visually. The text underneath is still in the PDF and can be searched or copied. Use Redact to remove it permanently.',
    'warn',
    6800,
  );
}

function setTool(tool) {
  if (!TOOL_DEFAULTS[tool]) return;
  if (state.draft) cancelDraft();
  state.tool = tool;
  document.querySelectorAll('#tool-group [data-tool]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.tool === tool);
  });
  document.body.classList.toggle('tool-draw', !['select', 'text', 'comment'].includes(tool));
  document.body.classList.toggle('tool-select', tool === 'select');
  document.body.classList.toggle('tool-text', TEXT_TOOLS.has(tool));
  syncControls();
  const hint = TOOL_HINTS[tool];
  $('#markup-hint').textContent = typeof hint === 'function' ? hint(state) : hint;
  $('#markup-hint').title = $('#markup-hint').textContent;

  if (tool === 'signature' && !state.pendingSignature) beginSignature();
  if (tool === 'mask' && !state.maskWarned) {
    state.maskWarned = true;
    toast('Redaction is permanent. On export, affected pages are rasterised: text becomes unsearchable, and links, forms and annotations on those pages are removed or flattened.', 'warn', 6800);
  }
  if (tool === 'blackbox' && !state.blackboxWarned) {
    state.blackboxWarned = true;
    warnBlackbox(false);
  }
  updateToolbarState();
  if (state.pageViews.length) redrawAll();
}
function drawOverlay(pv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ctx = pv.overlay.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = pv.baseW * state.scale;
  const height = pv.baseH * state.scale;
  ctx.clearRect(0, 0, width, height);

  drawAnnotations(ctx, annotationList(pv.index), pv.baseW, pv.baseH, state.scale, () => drawOverlay(pv));

  if (state.draft && state.draft.page === pv.index) {
    if (state.draft.type === 'signature') {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(state.draft.x * width, state.draft.y * height, state.draft.w * width, state.draft.h * height);
      ctx.restore();
    } else {
      drawAnnotations(ctx, [state.draft], pv.baseW, pv.baseH, state.scale, () => drawOverlay(pv));
    }
  }

  const selected = findSelected();
  if (selected && selected.page === pv.index) {
    drawSelection(ctx, selected.ann, pv.baseW, pv.baseH, state.scale);
  }
}

function drawSelection(ctx, ann, Wd, Hd, scale) {
  const bounds = annotationBounds(ann, Wd, Hd);
  const x = bounds.x * Wd * scale;
  const y = bounds.y * Hd * scale;
  const w = bounds.w * Wd * scale;
  const h = bounds.h * Hd * scale;
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#2563eb';
  ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
  ctx.setLineDash([]);
  if (RECT_TOOLS.has(ann.type)) {
    const handle = selectionHandle(ann, Wd, Hd);
    const hx = handle.x * Wd * scale;
    const hy = handle.y * Hd * scale;
    const size = 10;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.5;
    ctx.fillRect(hx - size / 2, hy - size / 2, size, size);
    ctx.strokeRect(hx - size / 2, hy - size / 2, size, size);
  }
  ctx.restore();
}

function redrawAll() {
  for (const pv of state.pageViews) drawOverlay(pv);
}

function redrawPage(index) {
  const pv = state.pageViews[index];
  if (pv) drawOverlay(pv);
}
function normalizedPoint(event, pv) {
  const rect = pv.overlay.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    nx: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    ny: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    px: event.clientX - rect.left,
    py: event.clientY - rect.top,
  };
}

function cloneAnnotation(ann) {
  return JSON.parse(JSON.stringify(ann));
}

function selectAnnotation(ann, page) {
  const previous = findSelected();
  state.selectedId = ann ? ann.id : null;
  state.selectedPage = ann ? page : null;
  if (previous && previous.page !== page) redrawPage(previous.page);
  redrawPage(page);
  updateToolbarState();
}

function clearSelection() {
  const previous = findSelected();
  state.selectedId = null;
  state.selectedPage = null;
  if (previous) redrawPage(previous.page);
  updateToolbarState();
}

function onPointerDown(event, pv) {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  const point = normalizedPoint(event, pv);
  if (!point) return;
  if (!$('#text-editor').hidden) closeTextEditor();

  const settings = activeSettings();
  const page = pv.index;

  if (state.tool === 'select') {
    const selected = findSelected();
    if (selected && selected.page === page) {
      const bounds = annotationBounds(selected.ann, pv.baseW, pv.baseH);
      const handle = selectionHandle(selected.ann, pv.baseW, pv.baseH);
      const hx = handle.x * pv.baseW * state.scale;
      const hy = handle.y * pv.baseH * state.scale;
      if (RECT_TOOLS.has(selected.ann.type) && Math.abs(point.px - hx) <= 11 && Math.abs(point.py - hy) <= 11) {
        pv.overlay.setPointerCapture(event.pointerId);
        state.pointer = {
          mode: 'resize',
          page,
          ann: selected.ann,
          orig: cloneAnnotation(selected.ann),
          startBounds: bounds,
          start: point,
          moved: false,
        };
        event.preventDefault();
        return;
      }
    }

    const hit = hitTestAnnotation(annotationList(page), point.nx, point.ny, pv.baseW, pv.baseH);
    if (hit) {
      selectAnnotation(hit, page);
      pv.overlay.setPointerCapture(event.pointerId);
      state.pointer = {
        mode: 'move',
        page,
        ann: hit,
        orig: cloneAnnotation(hit),
        start: point,
        moved: false,
      };
      event.preventDefault();
    } else {
      clearSelection();
    }
    return;
  }

  if (TEXT_TOOLS.has(state.tool)) {
    openTextEditor(page, point, event.clientX, event.clientY);
    event.preventDefault();
    return;
  }

  if (state.tool === 'signature' && !state.pendingSignature) {
    beginSignature();
    return;
  }

  const base = {
    page,
    color: settings.color,
    opacity: settings.opacity,
    width: settings.width,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    fontStyle: settings.fontStyle,
  };
  if (RECT_TOOLS.has(state.tool)) {
    state.draft = {
      ...base,
      type: state.tool,
      x: point.nx,
      y: point.ny,
      w: 0,
      h: 0,
      ...(state.tool === 'signature' ? { src: state.pendingSignature, id: 'draft' } : {}),
    };
  } else if (state.tool === 'ink') {
    state.draft = { ...base, type: 'ink', points: [{ x: point.nx, y: point.ny }] };
  } else if (state.tool === 'arrow') {
    state.draft = { ...base, type: 'arrow', x1: point.nx, y1: point.ny, x2: point.nx, y2: point.ny };
  }
  if (!state.draft) return;
  pv.overlay.setPointerCapture(event.pointerId);
  state.pointer = { mode: 'draw', page, moved: false };
  drawOverlay(pv);
  event.preventDefault();
}

function onPointerMove(event, pv) {
  const pointer = state.pointer;
  const draft = state.draft;
  if (!pointer && !draft) return;
  const point = normalizedPoint(event, pv);
  if (!point) return;

  if (pointer && pointer.mode === 'move') {
    const ann = pointer.ann;
    const dx = point.nx - pointer.start.nx;
    const dy = point.ny - pointer.start.ny;
    if (dx || dy) pointer.moved = true;
    Object.assign(ann, pointer.orig);
    moveAnnotation(ann, dx, dy, pv.baseW, pv.baseH);
    drawOverlay(pv);
    event.preventDefault();
    return;
  }

  if (pointer && pointer.mode === 'resize') {
    pointer.moved = true;
    resizeAnnotation(pointer.ann, point.nx, point.ny, pv.baseW, pv.baseH, pointer.startBounds, pointer.ann.type === 'signature');
    drawOverlay(pv);
    event.preventDefault();
    return;
  }

  if (draft) {
    if (draft.type === 'highlight' || draft.type === 'rect' || draft.type === 'mask' || draft.type === 'blackbox' || draft.type === 'signature') {
      draft.w = point.nx - draft.x;
      draft.h = point.ny - draft.y;
    } else if (draft.type === 'arrow') {
      draft.x2 = point.nx;
      draft.y2 = point.ny;
    } else if (draft.type === 'ink') {
      const last = draft.points[draft.points.length - 1];
      const dx = (point.nx - last.x) * pv.baseW * state.scale;
      const dy = (point.ny - last.y) * pv.baseH * state.scale;
      if (Math.hypot(dx, dy) >= 1.6) draft.points.push({ x: point.nx, y: point.ny });
    }
    if (state.pointer) state.pointer.moved = true;
    drawOverlay(pv);
    event.preventDefault();
  }
}
async function onPointerUp(event, pv) {
  const pointer = state.pointer;
  if (pointer) {
    if (pointer.moved) {
      recordHistory();
      updateMeta();
      updateToolbarState();
    }
    state.pointer = null;
    try { pv.overlay.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    if (state.draft) await finalizeDraft(pv);
    drawOverlay(pv);
    return;
  }
  if (state.draft) await finalizeDraft(pv);
}

function onPointerCancel(event, pv) {
  if (state.pointer && state.pointer.mode !== 'draw') {
    Object.assign(state.pointer.ann, state.pointer.orig);
  }
  state.pointer = null;
  state.draft = null;
  try { pv.overlay.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
  drawOverlay(pv);
}

function cancelDraft() {
  if (!state.draft) return;
  const page = state.draft.page;
  state.draft = null;
  state.pointer = null;
  redrawPage(page);
}

function normalizeDraftRect(draft) {
  if (draft.w < 0) { draft.x += draft.w; draft.w = -draft.w; }
  if (draft.h < 0) { draft.y += draft.h; draft.h = -draft.h; }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Signature image could not be loaded.'));
    image.src = src;
  });
}

async function finalizeDraft(pv) {
  const draft = state.draft;
  state.draft = null;
  state.pointer = null;
  if (!draft) return;
  const page = pv.index;
  const list = annotationList(page);
  const settings = activeSettings();
  let ann = null;

  if (draft.type === 'highlight' || draft.type === 'rect' || draft.type === 'mask' || draft.type === 'blackbox') {
    normalizeDraftRect(draft);
    if (draft.w * pv.baseW < 3 || draft.h * pv.baseH < 3) return;
    ann = createAnnotation(draft.type, {
      page,
      x: draft.x,
      y: draft.y,
      w: draft.w,
      h: draft.h,
      color: draft.color,
      opacity: draft.opacity,
      width: draft.width,
    });
  } else if (draft.type === 'arrow') {
    const dx = (draft.x2 - draft.x1) * pv.baseW;
    const dy = (draft.y2 - draft.y1) * pv.baseH;
    if (Math.hypot(dx, dy) < 6) return;
    ann = createAnnotation('arrow', {
      page,
      x1: draft.x1,
      y1: draft.y1,
      x2: draft.x2,
      y2: draft.y2,
      color: draft.color,
      opacity: draft.opacity,
      width: draft.width,
    });
  } else if (draft.type === 'ink') {
    if (!draft.points || draft.points.length === 0) return;
    ann = createAnnotation('ink', {
      page,
      points: draft.points,
      color: draft.color,
      opacity: draft.opacity,
      width: draft.width,
    });
  } else if (draft.type === 'signature') {
    normalizeDraftRect(draft);
    let widthPt = draft.w * pv.baseW;
    let heightPt = draft.h * pv.baseH;
    let aspect = 0.35;
    try {
      const image = await loadImage(draft.src);
      aspect = image.naturalHeight / image.naturalWidth || 0.35;
    } catch {
      toast('The signature could not be placed. Try creating it again.', 'error');
      return;
    }
    if (widthPt < 14 || heightPt < 10) {
      widthPt = Math.min(240, pv.baseW * 0.55);
      heightPt = widthPt * aspect;
    } else if (widthPt * aspect > heightPt) {
      widthPt = heightPt / aspect;
    } else {
      heightPt = widthPt * aspect;
    }
    const x = clamp(draft.x, 0, Math.max(0, 1 - widthPt / pv.baseW));
    const y = clamp(draft.y, 0, Math.max(0, 1 - heightPt / pv.baseH));
    ann = createAnnotation('signature', {
      page,
      x,
      y,
      w: widthPt / pv.baseW,
      h: heightPt / pv.baseH,
      src: draft.src,
      opacity: 1,
      aspect,
    });
  }

  if (!ann) return;
  list.push(ann);
  state.annotations[page] = list;
  state.selectedId = ann.id;
  state.selectedPage = page;
  recordHistory();
  updateMeta();
  updateToolbarState();
  drawOverlay(pv);
  if (ann.type === 'blackbox') warnBlackbox(true);
  if (ann.type === 'signature') setTool('select');
}

/* ----------------------------- Text editor ----------------------------- */
function openTextEditor(page, point, clientX, clientY) {
  const editor = $('#text-editor');
  const input = $('#text-editor-input');
  state.textTarget = { page, x: point.nx, y: point.ny, tool: state.tool };
  input.value = '';
  editor.hidden = false;
  const width = Math.min(330, window.innerWidth - 24);
  const left = clamp(clientX, 8, Math.max(8, window.innerWidth - width - 8));
  const top = clamp(clientY, 8, Math.max(8, window.innerHeight - 170));
  editor.style.left = `${left}px`;
  editor.style.top = `${top}px`;
  $('#text-editor-hint').textContent = state.tool === 'comment' ? 'Adds a comment box' : 'Adds text to the page';
  setTimeout(() => input.focus(), 20);
}

function closeTextEditor() {
  const editor = $('#text-editor');
  if (editor) editor.hidden = true;
  state.textTarget = null;
}

function commitTextEditor() {
  const target = state.textTarget;
  const input = $('#text-editor-input');
  if (!target) { closeTextEditor(); return; }
  const text = input.value.replace(/\s+$/, '');
  if (!text.trim()) { closeTextEditor(); return; }
  const settings = state.settings[target.tool];
  const ann = createAnnotation(target.tool, {
    page: target.page,
    x: target.x,
    y: target.y,
    text,
    color: settings.color,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    fontStyle: settings.fontStyle,
    opacity: settings.opacity ?? 1,
  });
  const list = annotationList(target.page);
  list.push(ann);
  state.annotations[target.page] = list;
  state.selectedId = ann.id;
  state.selectedPage = target.page;
  recordHistory();
  updateMeta();
  updateToolbarState();
  closeTextEditor();
  redrawPage(target.page);
}
function onScroll() {
  // Kept as a lightweight hook for future page-position indicators.
}

/* ----------------------------- History ----------------------------- */
function serializeState() {
  return JSON.stringify({
    annotations: state.annotations,
    selectedId: state.selectedId,
    selectedPage: state.selectedPage,
  });
}

function recordHistory() {
  const snap = serializeState();
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snap);
  if (state.history.length > 40) state.history.shift();
  state.historyIndex = state.history.length - 1;
  updateToolbarState();
}

function stepHistory(direction) {
  const next = state.historyIndex + direction;
  if (next < 0 || next >= state.history.length) return;
  state.historyIndex = next;
  try {
    const data = JSON.parse(state.history[next]);
    state.annotations = data.annotations || {};
    state.selectedId = data.selectedId || null;
    state.selectedPage = data.selectedPage ?? null;
    if (!findSelected()) {
      state.selectedId = null;
      state.selectedPage = null;
    }
  } catch {
    state.annotations = {};
  }
  updateMeta();
  updateToolbarState();
  redrawAll();
}

function deleteSelected() {
  const selected = findSelected();
  if (!selected) return;
  const index = selected.list.findIndex((item) => item.id === selected.ann.id);
  if (index >= 0) selected.list.splice(index, 1);
  if (selected.list.length === 0) delete state.annotations[selected.page];
  state.selectedId = null;
  state.selectedPage = null;
  recordHistory();
  updateMeta();
  updateToolbarState();
  redrawPage(selected.page);
}

/* ----------------------------- Keyboard ----------------------------- */
function onKeyDown(event) {
  if ($('#panel-markup').hidden) return;
  if (isEditableTarget(event.target)) return;
  if (!$('#sig-modal').hidden) return;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (mod && key === 'z') {
    event.preventDefault();
    stepHistory(event.shiftKey ? 1 : -1);
    return;
  }
  if (mod && key === 'y') {
    event.preventDefault();
    stepHistory(1);
    return;
  }
  if (event.key === 'Escape') {
    if (state.draft) { cancelDraft(); return; }
    if (state.selectedId) { clearSelection(); return; }
    closeTextEditor();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (findSelected()) {
      event.preventDefault();
      deleteSelected();
    }
    return;
  }
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    applyZoom(state.scale * 1.2, 'custom');
    return;
  }
  if (event.key === '-') {
    event.preventDefault();
    applyZoom(state.scale / 1.2, 'custom');
    return;
  }
  if (event.key === '0') {
    event.preventDefault();
    applyZoom(fitPageScale(), 'page');
    return;
  }
  if (mod || event.altKey) return;
  const map = { v: 'select', h: 'highlight', p: 'ink', t: 'text', c: 'comment', r: 'rect', a: 'arrow', m: 'mask', b: 'blackbox', s: 'signature' };
  const tool = map[key];
  if (tool) {
    event.preventDefault();
    setTool(tool);
  }
}


/* ----------------------------- Download ----------------------------- */
async function buildRedactedPages() {
  const pages = {};
  for (const pv of state.pageViews) {
    const masks = annotationList(pv.index).filter((ann) => ann.type === 'mask');
    if (!masks.length) continue;

    const baseViewport = pv.page.getViewport({ scale: 1 });
    let scale = 2;
    const maxPixels = 16_000_000;
    if (baseViewport.width * baseViewport.height * scale * scale > maxPixels) {
      scale = Math.sqrt(maxPixels / (baseViewport.width * baseViewport.height));
    }
    scale = Math.max(0.25, scale);

    const viewport = pv.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pv.page.render({ canvasContext: ctx, viewport }).promise;

    ctx.fillStyle = '#000000';
    for (const mask of masks) {
      const bounds = annotationBounds(mask, pv.baseW, pv.baseH);
      if (bounds.w <= 0 || bounds.h <= 0) continue;
      const x = Math.floor(bounds.x * canvas.width) - 1;
      const y = Math.floor(bounds.y * canvas.height) - 1;
      const width = Math.ceil(bounds.w * canvas.width) + 2;
      const height = Math.ceil(bounds.h * canvas.height) + 2;
      ctx.fillRect(x, y, width, height);
    }

    pages[pv.index] = {
      dataUrl: canvas.toDataURL('image/jpeg', 0.95),
      width: pv.baseW,
      height: pv.baseH,
    };
    canvas.width = 1;
    canvas.height = 1;
  }
  return pages;
}

async function finishMarkup() {
  if (!state.bytes || !state.onDone || state.finishing) return;
  const done = state.onDone;
  const count = annotationCount();
  const redactions = countRedactions();

  if (redactions > 0) {
    const proceed = await confirmDialog(
      'Applying secure redaction will:\n\n'
      + '• Permanently remove the covered content from the saved PDF.\n'
      + '• Rasterise each page containing a redaction at about 144 DPI.\n'
      + '• Remove the original text from those pages, so it is no longer selectable or searchable.\n'
      + '• Flatten or remove images, links, form fields, existing annotations and other objects on those pages.\n'
      + '• Possibly drop document outlines/bookmarks.\n\n'
      + 'This cannot be undone in the saved document.',
      { title: 'Apply secure redaction?', okLabel: 'Apply and save' },
    );
    if (!proceed) return;
  }

  state.finishing = true;
  try {
    const editable = $('#editable-annotations').checked;
    const annotations = editable
      ? Array.from({ length: state.pageViews.length }, (_, index) => (
          state.annotations[index] ? JSON.parse(JSON.stringify(state.annotations[index])) : []
        ))
      : [];
    let redactedPages = {};
    let bytes = state.bytes;
    if (count > 0) {
      await withBusy($('#markup-back'), async () => {
        if (redactions > 0) {
          toast('Rasterising redacted pages…', 'info', 2400);
          redactedPages = await buildRedactedPages();
        }
        bytes = await exportAnnotatedPdf(state.bytes, state.annotations, {
          flatten: !editable,
          redactedPages,
          title: `${baseName(state.name)} (edited)`,
        });
      });
    }
    state.onDone = null;
    await done(bytes, { annotations, flattened: !editable && count > 0, redactedPages });
  } catch (err) {
    toast(`Could not save the page markup: ${errorMessage(err)}`, 'error', 7000);
  } finally {
    state.finishing = false;
  }
}


async function downloadMarkedUp() {

  if (!state.bytes) return;
  const count = annotationCount();
  const redactions = countRedactions();
  if (count === 0) {
    const proceed = await confirmDialog('There are no annotations yet. Download an unchanged copy of the PDF?', {
      title: 'Download a copy?',
      okLabel: 'Download copy',
    });
    if (!proceed) return;
  }
  if (redactions > 0) {
    const proceed = await confirmDialog(
      'Applying secure redaction will:\n\n'
      + '• Permanently remove the covered content from the downloaded PDF.\n'
      + '• Rasterise each page containing a redaction at about 144 DPI.\n'
      + '• Remove the original text from those pages, so it is no longer selectable or searchable.\n'
      + '• Flatten or remove images, links, form fields, existing annotations and other objects on those pages.\n'
      + '• Possibly drop document outlines/bookmarks.\n\n'
      + 'The original PDF on your device is unchanged, but this cannot be undone in the downloaded file.',
      { title: 'Apply secure redaction?', okLabel: 'Apply and download' },
    );
    if (!proceed) return;
  }

  const flatten = $('#editable-annotations').checked === false;
  const base = baseName(state.name);
  const filename = `${base}-edited.pdf`;
  await withBusy($('#markup-download'), async () => {
    try {
      let redactedPages = {};
      if (redactions > 0) {
        toast('Rasterising redacted pages…', 'info', 2400);
        redactedPages = await buildRedactedPages();
      }
      const bytes = await exportAnnotatedPdf(state.bytes, state.annotations, {
        flatten,
        redactedPages,
        title: `${base} (edited)`,
      });
      downloadBytes(bytes, filename);
      const redactionNote = redactions > 0
        ? ` ${redactions} secure redaction${redactions === 1 ? '' : 's'} applied.`
        : '';
      const modeNote = flatten ? ' Annotations flattened.' : ' Annotations kept editable.';
      toast(`Downloaded ${filename} with ${count} annotation${count === 1 ? '' : 's'}.${redactionNote}${modeNote}`, 'success', 6200);
    } catch (err) {
      toast(`Could not create the PDF: ${errorMessage(err)}`, 'error', 7000);
    }
  });
}







