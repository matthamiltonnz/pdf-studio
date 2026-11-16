/* Documents: import/merge PDFs, organise pages, launch page markup and split outputs. */
import { zipSync } from 'fflate';
import { $, baseName, downloadBytes, errorMessage, formatBytes, isPdfFile, parsePageRanges, readFileBytes, toast, withBusy } from './util.js';
import { buildPdfFromPages, buildPdfGroups, getPageRotations, inspectPdf, mergePdfBuffers } from './pdf-ops.js';
import { openWithPdfjs, renderPdfPageToCanvas } from './pdfjs-loader.js';
import { openMarkupDocument } from './markup.js';

const state = {
  name: '',
  bytes: null,
  pageCount: 0,
  pdfjsDoc: null,
  pages: [],
  selected: new Set(),
  baseRotations: [],
  lastClicked: null,
  history: [],
  historyIndex: -1,
  observer: null,
  nodeByUid: new Map(),
  renderQueue: [],
  rendering: 0,
  initialized: false,
};

export function initDocuments() {
  if (state.initialized) return;
  state.initialized = true;

  const drop = $('#split-drop');
  const input = $('#split-input');
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
    const files = event.dataTransfer?.files;
    if (files && files.length) await addFiles(files);
  });

  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length) await addFiles(files);
  });

  $('#split-add').addEventListener('click', () => input.click());

  $('#split-close').addEventListener('click', closeFile);
  $('#split-reset').addEventListener('click', resetPages);
  $('#split-select-all').addEventListener('click', () => {
    state.selected = new Set(state.pages.map((page) => page.uid));
    state.lastClicked = state.pages.length - 1;
    refreshSelection();
  });
  $('#split-select-none').addEventListener('click', () => {
    state.selected.clear();
    state.lastClicked = null;
    refreshSelection();
  });
  $('#split-rotate-left').addEventListener('click', () => rotateSelection(-90));
  $('#split-rotate-right').addEventListener('click', () => rotateSelection(90));
  $('#split-move-left').addEventListener('click', () => moveSelection(-1));
  $('#split-move-right').addEventListener('click', () => moveSelection(1));
  $('#split-delete').addEventListener('click', deleteSelection);
  $('#split-apply').addEventListener('click', saveChanges);
  $('#split-extract').addEventListener('click', extractSelected);
  $('#split-every-go').addEventListener('click', splitEvery);
  $('#split-ranges-go').addEventListener('click', splitRanges);
  $('#split-undo').addEventListener('click', () => stepHistory(-1));
  $('#split-redo').addEventListener('click', () => stepHistory(1));

  $('#split-grid').addEventListener('click', (event) => {
    const item = event.target.closest('.thumb');
    if (!item) return;
    onThumbClick(item, event.shiftKey);
  });
  $('#split-grid').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const item = event.target.closest('.thumb');
    if (!item) return;
    event.preventDefault();
    onThumbClick(item, event.shiftKey);
  });

  state.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const uid = entry.target.dataset.uid;
        const pageState = state.pages.find((page) => page.uid === uid);
        if (pageState) scheduleThumb(entry.target, pageState);
        state.observer.unobserve(entry.target);
      }
    }
  }, { rootMargin: '500px 0px' });
}
async function addFiles(files) {
  const incoming = Array.from(files || []).filter(isPdfFile);
  if (!incoming.length) {
    toast('Please choose PDF files.', 'warn');
    return;
  }
  try {
    const entries = await Promise.all(incoming.map(async (file) => ({
      bytes: await readFileBytes(file),
      name: file.name || 'document.pdf',
    })));

    let bytes;
    let name;
    if (state.bytes && state.pages.length) {
      const current = await buildPdfFromPages(state.bytes, state.pages, baseName(state.name || 'document'));
      bytes = await mergePdfBuffers([{ bytes: current }, ...entries], baseName(state.name || 'document'));
      name = `${baseName(state.name || 'document')} + ${incoming.length} file${incoming.length === 1 ? '' : 's'}.pdf`;
    } else if (entries.length === 1) {
      bytes = entries[0].bytes;
      name = entries[0].name;
    } else {
      bytes = await mergePdfBuffers(entries, 'merged');
      name = `${baseName(entries[0].name)} + ${entries.length - 1} more.pdf`;
    }

    await loadDocument(name, bytes);
    toast(
      incoming.length === 1 ? `Added ${incoming[0].name}.` : `Added ${incoming.length} PDFs.`,
      'success',
    );
  } catch (err) {
    toast(`Could not add the PDF: ${errorMessage(err)}`, 'error', 7000);
  }
}

async function loadDocument(name, bytes) {
  const info = await inspectPdf(bytes);
  const rotations = await getPageRotations(bytes);
  const pdfjsDoc = await openWithPdfjs(bytes);

  if (state.pdfjsDoc) {
    try { state.pdfjsDoc.destroy(); } catch { /* ignore */ }
  }
  state.name = name;
  state.bytes = bytes;
  state.pageCount = info.pageCount;
  state.pdfjsDoc = pdfjsDoc;
  state.baseRotations = rotations;
  state.pages = rotations.map((rotation, index) => ({
    uid: `p${index}_${Math.random().toString(36).slice(2, 7)}`,
    src: index,
    rotation,
  }));
  state.selected = new Set();
  state.lastClicked = null;
  state.history = [];
  state.historyIndex = -1;
  state.nodeByUid = new Map();
  recordHistory();

  $('#split-file').textContent = '';
  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = state.name;
  nameEl.title = state.name;
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = `${state.pageCount} page${state.pageCount === 1 ? '' : 's'} · ${formatBytes(bytes.byteLength)}`;
  $('#split-file').append(nameEl, count);

  $('#split-drop').hidden = true;
  $('#split-workspace').hidden = false;
  $('#split-ranges').value = '';
  renderGrid();
  refreshSelection();
}


async function openEditor(index, button) {
  if (!state.bytes || !state.pages.length) return;
  const page = state.pages[index];
  if (!page) return;
  const base = baseName(state.name);
  try {
    await withBusy(button, async () => {
      const bytes = await buildPdfFromPages(state.bytes, state.pages, base);
      await openMarkupDocument({
        name: `${base}.pdf`,
        bytes,
        page: index + 1,
        onDone: async (annotated) => {
          try {
            if (annotated) {
              await loadDocument(state.name, annotated);
              toast('Markup saved to the document.', 'success');
            }
          } finally {
            window.dispatchEvent(new CustomEvent('pdfstudio:show-tab', { detail: 'documents' }));
          }
        },
      });
    });
  } catch (err) {
    toast(`Could not open the page for markup: ${errorMessage(err)}`, 'error', 7000);
  }
}


function closeFile() {
  if (state.pdfjsDoc) {
    try { state.pdfjsDoc.destroy(); } catch { /* ignore */ }
  }
  state.name = '';
  state.bytes = null;
  state.pageCount = 0;
  state.pdfjsDoc = null;
  state.pages = [];
  state.selected.clear();
  state.baseRotations = [];
  state.history = [];
  state.historyIndex = -1;
  state.nodeByUid.clear();
  state.renderQueue = [];
  $('#split-grid').textContent = '';
  $('#split-workspace').hidden = true;
  $('#split-drop').hidden = false;
}

function resetPages() {
  if (!state.bytes) return;
  state.pages = state.baseRotations.map((rotation, index) => ({
    uid: `p${index}_${Math.random().toString(36).slice(2, 7)}`,
    src: index,
    rotation,
  }));
  state.selected.clear();
  state.lastClicked = null;
  recordHistory();
  renderGrid();
  refreshSelection();
  toast('Page order, rotations and deletions reset.', 'success');
}

function renderGrid() {
  const grid = $('#split-grid');
  grid.textContent = '';
  state.nodeByUid.clear();
  state.renderQueue = [];
  state.rendering = 0;

  if (!state.pages.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No pages left. Use Reset pages to restore the document.';
    grid.appendChild(empty);
    return;
  }

  state.pages.forEach((page, index) => {
    const item = document.createElement('div');
    item.className = 'thumb';
    item.dataset.uid = page.uid;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-pressed', 'false');

    const box = document.createElement('div');
    box.className = 'thumb-box';
    const placeholder = document.createElement('span');
    placeholder.className = 'thumb-placeholder';
    const canvas = document.createElement('canvas');
    canvas.hidden = true;
    box.append(placeholder, canvas);

    const foot = document.createElement('div');
    foot.className = 'thumb-foot';
    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = `Page ${index + 1}`;
    const rot = document.createElement('span');
    rot.className = 'thumb-rot';
    rot.textContent = page.rotation ? `${page.rotation}°` : '';
    foot.append(num, rot);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn ghost small thumb-edit';
    edit.textContent = 'Mark up';
    edit.title = 'Open this page in the markup editor';
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      openEditor(index, edit);
    });

    item.append(box, foot, edit);
    item._canvas = canvas;
    item._placeholder = placeholder;
    item._rotation = null;
    state.nodeByUid.set(page.uid, item);
    grid.appendChild(item);
    state.observer.observe(item);
  });
}

function scheduleThumb(item, pageState) {
  if (!item || !item.isConnected) return;
  if (item._renderedRotation === pageState.rotation) return;
  item._pendingRotation = pageState.rotation;
  state.renderQueue.push({ item, pageState });
  pumpThumbs();
}

function pumpThumbs() {
  while (state.rendering < 2 && state.renderQueue.length) {
    const job = state.renderQueue.shift();
    state.rendering += 1;
    renderThumb(job.item, job.pageState)
      .catch(() => { /* broken page: leave placeholder */ })
      .finally(() => {
        state.rendering = Math.max(0, state.rendering - 1);
        pumpThumbs();
      });
  }
}

async function renderThumb(item, pageState) {
  if (!state.pdfjsDoc || !item.isConnected) return;
  const rotation = pageState.rotation;
  const page = await state.pdfjsDoc.getPage(pageState.src + 1);
  const baseViewport = page.getViewport({ scale: 1, rotation });
  const scale = Math.max(0.08, 170 / baseViewport.width);
  const canvas = item._canvas;
  await renderPdfPageToCanvas(page, canvas, { scale, rotation, maxPixels: 620_000 });
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  canvas.hidden = false;
  item._placeholder.hidden = true;
  item._renderedRotation = rotation;
  item._rotation = rotation;
}
function onThumbClick(item, shiftKey) {
  const uid = item.dataset.uid;
  const index = state.pages.findIndex((page) => page.uid === uid);
  if (index < 0) return;

  if (shiftKey && state.lastClicked != null && state.lastClicked >= 0) {
    const from = Math.min(state.lastClicked, index);
    const to = Math.max(state.lastClicked, index);
    state.selected.clear();
    for (let i = from; i <= to; i += 1) state.selected.add(state.pages[i].uid);
  } else {
    if (state.selected.has(uid)) state.selected.delete(uid);
    else state.selected.add(uid);
    state.lastClicked = index;
  }
  refreshSelection();
}

function refreshSelection() {
  for (const [uid, item] of state.nodeByUid) {
    const selected = state.selected.has(uid);
    item.classList.toggle('is-selected', selected);
    item.setAttribute('aria-pressed', String(selected));
  }
  const count = state.selected.size;
  $('#split-selection-count').textContent = count === 0
    ? 'No pages selected'
    : `${count} page${count === 1 ? '' : 's'} selected`;
  $('#split-hint').textContent = count === 0
    ? 'Click a page to select it. Shift-click to select a range.'
    : `${count} of ${state.pages.length} pages selected.`;
  updateHistoryButtons();
}

function selectedIndices() {
  const indices = [];
  state.pages.forEach((page, index) => { if (state.selected.has(page.uid)) indices.push(index); });
  return indices;
}

function requireSelection() {
  const indices = selectedIndices();
  if (!indices.length) {
    toast('Select one or more pages first.', 'warn');
    return null;
  }
  return indices;
}

function updateHistoryButtons() {
  $('#split-undo').disabled = state.historyIndex <= 0;
  $('#split-redo').disabled = state.historyIndex >= state.history.length - 1;
}

function snapshot() {
  return JSON.stringify({
    pages: state.pages,
    selected: Array.from(state.selected),
    lastClicked: state.lastClicked,
  });
}

function recordHistory() {
  const snap = snapshot();
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snap);
  if (state.history.length > 50) state.history.shift();
  state.historyIndex = state.history.length - 1;
  updateHistoryButtons();
}

function stepHistory(direction) {
  const next = state.historyIndex + direction;
  if (next < 0 || next >= state.history.length) return;
  state.historyIndex = next;
  const data = JSON.parse(state.history[next]);
  state.pages = data.pages;
  state.selected = new Set(data.selected.filter((uid) => state.pages.some((page) => page.uid === uid)));
  state.lastClicked = data.lastClicked;
  renderGrid();
  refreshSelection();
}
function rotateSelection(delta) {
  const indices = requireSelection();
  if (!indices) return;
  for (const index of indices) {
    state.pages[index].rotation = (state.pages[index].rotation + delta + 360) % 360;
  }
  recordHistory();
  renderGrid();
  refreshSelection();
}

function moveSelection(direction) {
  const indices = requireSelection();
  if (!indices) return;
  const pages = state.pages;
  const selected = (page) => state.selected.has(page.uid);
  let moved = false;
  if (direction < 0) {
    for (let i = 1; i < pages.length; i += 1) {
      if (selected(pages[i]) && !selected(pages[i - 1])) {
        [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
        moved = true;
      }
    }
  } else {
    for (let i = pages.length - 2; i >= 0; i -= 1) {
      if (selected(pages[i]) && !selected(pages[i + 1])) {
        [pages[i], pages[i + 1]] = [pages[i + 1], pages[i]];
        moved = true;
      }
    }
  }
  if (!moved) {
    toast('The selected pages are already at the edge.', 'info');
    return;
  }
  recordHistory();
  renderGrid();
  refreshSelection();
}

function deleteSelection() {
  const indices = requireSelection();
  if (!indices) return;
  if (indices.length >= state.pages.length) {
    toast('Keep at least one page. Use Close to unload the document instead.', 'warn');
    return;
  }
  const remove = new Set(indices.map((index) => state.pages[index].uid));
  state.pages = state.pages.filter((page) => !remove.has(page.uid));
  state.selected.clear();
  state.lastClicked = null;
  recordHistory();
  renderGrid();
  refreshSelection();
  toast(`Removed ${indices.length} page${indices.length === 1 ? '' : 's'}.`, 'success');
}

async function saveChanges() {
  if (!state.bytes || !state.pages.length) return;
  const base = baseName(state.name);
  await withBusy($('#split-apply'), async () => {
    try {
      const bytes = await buildPdfFromPages(state.bytes, state.pages, `${base} (edited)`);
      downloadBytes(bytes, `${base}-edited.pdf`);
      toast('Saved a copy with your page changes.', 'success');
    } catch (err) {
      toast(`Could not save the PDF: ${errorMessage(err)}`, 'error', 7000);
    }
  });
}

async function extractSelected() {
  const indices = requireSelection();
  if (!indices) return;
  if (!state.bytes) return;
  const base = baseName(state.name);
  const refs = indices.map((index) => state.pages[index]);
  await withBusy($('#split-extract'), async () => {
    try {
      const bytes = await buildPdfFromPages(state.bytes, refs, `${base} (extract)`);
      const filename = refs.length === 1 ? `${base}-page-${indices[0] + 1}.pdf` : `${base}-extract.pdf`;
      downloadBytes(bytes, filename);
      toast(`Extracted ${refs.length} page${refs.length === 1 ? '' : 's'}.`, 'success');
    } catch (err) {
      toast(`Could not extract pages: ${errorMessage(err)}`, 'error', 7000);
    }
  });
}

async function splitEvery() {
  if (!state.bytes || !state.pages.length) return;
  const size = Math.floor(Number($('#split-every').value));
  if (!Number.isFinite(size) || size < 1) {
    toast('Enter a page count of 1 or more.', 'warn');
    return;
  }
  if (size >= state.pages.length) {
    toast('The document is smaller than that. Choose a smaller number.', 'warn');
    return;
  }
  const groups = [];
  for (let i = 0; i < state.pages.length; i += size) groups.push(state.pages.slice(i, i + size));
  const base = baseName(state.name);
  await withBusy($('#split-every-go'), async () => {
    try {
      const outputs = await buildPdfGroups(state.bytes, groups, base);
      if (outputs.length === 1) {
        downloadBytes(outputs[0].bytes, `${base}-pages-1-${state.pages.length}.pdf`);
      } else {
        downloadOutputs(outputs, base, `${base}-split.zip`);
      }
      toast(`Created ${outputs.length} PDFs.`, 'success');
    } catch (err) {
      toast(`Could not split the PDF: ${errorMessage(err)}`, 'error', 7000);
    }
  });
}

async function splitRanges() {
  if (!state.bytes || !state.pages.length) return;
  const parsed = parsePageRanges($('#split-ranges').value, state.pages.length);
  if (parsed.error) {
    toast(parsed.error, 'warn');
    return;
  }
  const groups = parsed.groups.map((group) => group.map((index) => state.pages[index]));
  const base = baseName(state.name);
  await withBusy($('#split-ranges-go'), async () => {
    try {
      const outputs = await buildPdfGroups(state.bytes, groups, base);
      if (outputs.length === 1) {
        const range = parsed.groups[0];
        downloadBytes(outputs[0].bytes, `${base}-pages-${range[0] + 1}-${range[range.length - 1] + 1}.pdf`);
      } else {
        downloadOutputs(outputs, base, `${base}-split.zip`);
      }
      toast(`Created ${outputs.length} PDF${outputs.length === 1 ? '' : 's'}.`, 'success');
    } catch (err) {
      toast(`Could not create the files: ${errorMessage(err)}`, 'error', 7000);
    }
  });
}

function downloadOutputs(outputs, base, zipName) {
  if (outputs.length === 1) {
    downloadBytes(outputs[0].bytes, `${base}.pdf`);
    return;
  }
  const entries = {};
  outputs.forEach((output, index) => { entries[`${base}-part${index + 1}.pdf`] = output.bytes; });
  const zipped = zipSync(entries, { level: 6 });
  downloadBytes(zipped, zipName, 'application/zip');
}



