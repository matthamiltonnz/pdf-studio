/* Merge tool: file list, ordering, and output. */
import { $, baseName, errorMessage, formatBytes, downloadBytes, isPdfFile, pdfFileName, readFileBytes, toast, withBusy } from './util.js';
import { inspectPdf, mergePdfBuffers } from './pdf-ops.js';

let files = [];
let seq = 0;
let nameTouched = false;
let initialized = false;

export function initMerge() {
  if (initialized) return;
  initialized = true;

  const drop = $('#merge-drop');
  const input = $('#merge-input');
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
    const incoming = Array.from(event.dataTransfer?.files || []);
    if (incoming.length) await addFiles(incoming);
  });

  input.addEventListener('change', async () => {
    const incoming = Array.from(input.files || []);
    input.value = '';
    if (incoming.length) await addFiles(incoming);
  });

  $('#merge-add').addEventListener('click', () => input.click());
  $('#merge-clear').addEventListener('click', clearAll);
  $('#merge-go').addEventListener('click', merge);
  $('#merge-name').addEventListener('input', () => { nameTouched = true; });

  $('#merge-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const item = button.closest('.file-item');
    const index = Number(item.dataset.index);
    const action = button.dataset.action;
    if (action === 'up' && index > 0) {
      [files[index - 1], files[index]] = [files[index], files[index - 1]];
    } else if (action === 'down' && index < files.length - 1) {
      [files[index + 1], files[index]] = [files[index], files[index + 1]];
    } else if (action === 'remove') {
      files.splice(index, 1);
      if (files.length === 0) {
        clearAll();
        return;
      }
    }
    render();
  });
}

async function addFiles(incoming) {
  const pdfs = incoming.filter(isPdfFile);
  const skipped = incoming.length - pdfs.length;
  if (skipped > 0) toast(`${skipped} non-PDF file${skipped === 1 ? ' was' : 's were'} ignored.`, 'warn');

  for (const file of pdfs) {
    try {
      const bytes = await readFileBytes(file);
      const info = await inspectPdf(bytes);
      files.push({
        id: `m${seq += 1}`,
        name: file.name || `document-${files.length + 1}.pdf`,
        size: file.size || bytes.byteLength,
        bytes,
        pageCount: info.pageCount,
      });
    } catch (err) {
      toast(`${file.name}: ${errorMessage(err)}`, 'error', 6000);
    }
  }

  if (files.length && !nameTouched) {
    $('#merge-name').value = `${baseName(files[0].name)}-merged.pdf`;
  }
  render();
}

function clearAll() {
  files = [];
  nameTouched = false;
  $('#merge-name').value = 'merged.pdf';
  $('#merge-list').textContent = '';
  $('#merge-workspace').hidden = true;
  $('#merge-summary').textContent = 'No files yet';
}
function render() {
  const list = $('#merge-list');
  list.textContent = '';
  const workspace = $('#merge-workspace');
  workspace.hidden = files.length === 0;
  if (!files.length) return;

  const totalPages = files.reduce((sum, file) => sum + file.pageCount, 0);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  $('#merge-summary').textContent = `${files.length} file${files.length === 1 ? '' : 's'} · ${totalPages} page${totalPages === 1 ? '' : 's'} · ${formatBytes(totalBytes)}`;

  files.forEach((file, index) => {
    const item = document.createElement('li');
    item.className = 'file-item';
    item.dataset.index = String(index);

    const ord = document.createElement('span');
    ord.className = 'ord';
    ord.textContent = String(index + 1);

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    name.title = file.name;
    const sub = document.createElement('span');
    sub.className = 'file-sub';
    sub.textContent = `${file.pageCount} page${file.pageCount === 1 ? '' : 's'} · ${formatBytes(file.size)}`;
    meta.append(name, sub);

    const actions = document.createElement('span');
    actions.className = 'file-actions';
    actions.append(
      iconButton('↑', 'Move up', 'up', index === 0),
      iconButton('↓', 'Move down', 'down', index === files.length - 1),
      iconButton('×', 'Remove file', 'remove', false),
    );

    item.append(ord, meta, actions);
    list.appendChild(item);
  });
}

function iconButton(label, title, action, disabled) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-btn ${action}`;
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.dataset.action = action;
  button.disabled = disabled;
  return button;
}

async function merge() {
  if (!files.length) return;
  const output = pdfFileName($('#merge-name').value, 'merged.pdf');
  await withBusy($('#merge-go'), async () => {
    try {
      const bytes = await mergePdfBuffers(files, output);
      downloadBytes(bytes, output);
      toast(`Merged ${files.length} files into ${output}.`, 'success');
    } catch (err) {
      toast(`Merge failed: ${errorMessage(err)}`, 'error', 7000);
    }
  });
}

