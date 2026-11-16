/* Small shared helpers. No external dependencies. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function uid(prefix = 'a') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function baseName(name) {
  return String(name || 'document').replace(/\.pdf$/i, '') || 'document';
}

export function safeFileName(name, fallback = 'document.pdf') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

export function pdfFileName(name, fallback = 'document.pdf') {
  const safe = safeFileName(name, fallback);
  return /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(filename, 'download');
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Keep the URL alive long enough for the browser to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 20_000);
}

export function downloadBytes(bytes, filename, type = 'application/pdf') {
  const blob = new Blob([bytes], { type });
  downloadBlob(blob, filename);
}

export function readFileBytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.readAsArrayBuffer(file);
  });
}

export function isPdfFile(file) {
  return /\.pdf$/i.test(file.name || '') || file.type === 'application/pdf';
}

export function toast(message, type = 'info', timeout = 4200) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const text = document.createElement('span');
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';
  close.addEventListener('click', () => remove());
  el.append(text, close);
  host.appendChild(el);

  let timer = null;
  const remove = () => {
    if (!el.isConnected) return;
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  };
  timer = setTimeout(remove, timeout);
  return remove;
}

export function errorMessage(err) {
  const raw = String(err && err.message ? err.message : err || '');
  if (/encrypted|password/i.test(raw)) {
    return 'This PDF is password-protected or encrypted. Remove the password and try again.';
  }
  if (/invalid pdf structure|no pdf header|Failed to parse/i.test(raw)) {
    return 'This file does not look like a valid PDF.';
  }
  return raw.length > 220 ? `${raw.slice(0, 217)}…` : raw || 'Something went wrong.';
}

export async function withBusy(button, fn) {
  if (!button) return fn();
  button.disabled = true;
  button.classList.add('is-busy');
  try {
    return await fn();
  } finally {
    button.classList.remove('is-busy');
    button.disabled = false;
  }
}

export function debounce(fn, delay = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function parsePageRanges(input, maxPages) {
  const text = String(input || '').trim();
  if (!text) return { error: 'Enter one or more page numbers, for example 1-3, 5.' };

  const groups = [];
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!match) return { error: `"${part}" is not a valid page or range.` };
    let from = Number(match[1]);
    let to = match[2] ? Number(match[2]) : from;
    if (from > to) [from, to] = [to, from];
    if (from < 1 || to > maxPages) {
      return { error: `Pages must be between 1 and ${maxPages}.` };
    }
    const group = [];
    for (let page = from; page <= to; page += 1) group.push(page - 1);
    groups.push(group);
  }
  if (!groups.length) return { error: 'Enter one or more page numbers, for example 1-3, 5.' };
  return { groups };
}

export function parseHexColor(hex) {
  const normalized = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

export function hexToRgb01(hex) {
  const { r, g, b } = parseHexColor(hex);
  return { red: r / 255, green: g / 255, blue: b / 255 };
}

let activeConfirm = null;

export function confirmDialog(message, {
  title = 'Please confirm',
  okLabel = 'Continue',
  cancelLabel = 'Cancel',
} = {}) {
  if (activeConfirm) {
    activeConfirm.remove();
    activeConfirm = null;
  }
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.id = 'app-confirm';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'app-confirm-title');

    const head = document.createElement('div');
    head.className = 'modal-head';
    const heading = document.createElement('h2');
    heading.id = 'app-confirm-title';
    heading.textContent = title;
    head.appendChild(heading);

    const body = document.createElement('p');
    body.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.id = 'app-confirm-cancel';
    cancel.textContent = cancelLabel;
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn primary';
    ok.id = 'app-confirm-ok';
    ok.textContent = okLabel;
    actions.append(spacer, cancel, ok);

    modal.append(head, body, actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    activeConfirm = backdrop;

    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      if (backdrop.isConnected) backdrop.remove();
      if (activeConfirm === backdrop) activeConfirm = null;
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); finish(true); }
    };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) finish(false); });
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => ok.focus(), 20);
  });
}

