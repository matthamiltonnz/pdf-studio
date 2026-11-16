/* Signature capture: draw, type or upload, with optional name/date caption. */
import { $, toast } from './util.js';

const STORAGE_KEY = 'pdf-studio:signatures:v1';
const PAD_W = 640;
const PAD_H = 240;
const FONTS = {
  'cursive-1': '"Snell Roundhand", "Brush Script MT", "Segoe Script", "Lucida Handwriting", cursive',
  'cursive-2': '"Edwardian Script ITC", "Apple Chancery", "Lucida Calligraphy", "Palatino Linotype", cursive',
  'cursive-3': '"Bradley Hand", "Segoe Print", "Comic Sans MS", cursive',
};

let modal;
let pad;
let ctx;
let mode = 'draw';
let drawing = false;
let hasInk = false;
let lastPoint = null;
let uploadedImage = null;
let cleanUpload = true;
let onUseCallback = null;
let initialized = false;

export function initSignatureModal() {
  if (initialized) return;
  initialized = true;
  modal = $('#sig-modal');
  pad = $('#sig-pad');
  ctx = pad.getContext('2d');

  pad.addEventListener('pointerdown', (event) => {
    if (mode !== 'draw') return;
    pad.setPointerCapture(event.pointerId);
    drawing = true;
    lastPoint = padPoint(event);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 3.1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(lastPoint.x, lastPoint.y);
    ctx.lineTo(lastPoint.x + 0.01, lastPoint.y + 0.01);
    ctx.stroke();
    hasInk = true;
  });

  pad.addEventListener('pointermove', (event) => {
    if (!drawing || mode !== 'draw') return;
    const point = padPoint(event);
    ctx.beginPath();
    ctx.moveTo(lastPoint.x, lastPoint.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPoint = point;
    hasInk = true;
  });

  const stopDrawing = () => { drawing = false; lastPoint = null; };
  pad.addEventListener('pointerup', stopDrawing);
  pad.addEventListener('pointercancel', stopDrawing);
  pad.addEventListener('pointerleave', () => { if (drawing) stopDrawing(); });
  pad.addEventListener('keydown', (event) => {
    if (event.key === ' ' || event.key === 'Enter') event.preventDefault();
  });

  document.querySelectorAll('[data-sig-mode]').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.sigMode));
  });

  $('#sig-type-name').addEventListener('input', (event) => {
    if (mode === 'type') renderTyped();
  });
  $('#sig-font').addEventListener('change', () => {
    if (mode === 'type') renderTyped();
  });

  $('#sig-upload').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      uploadedImage = await loadImageFromFile(file);
      if (mode === 'upload') renderUploaded();
    } catch (err) {
      toast(`Could not read that image: ${err.message || err}`, 'error');
    }
  });
  $('#sig-clean').addEventListener('change', (event) => {
    cleanUpload = event.target.checked;
    if (mode === 'upload' && uploadedImage) renderUploaded();
  });

  $('#sig-clear').addEventListener('click', () => {
    hasInk = false;
    clearPad();
    if (mode === 'upload') {
      uploadedImage = null;
      $('#sig-upload').value = '';
    }
    if (mode === 'type') {
      $('#sig-type-name').value = '';
      renderTyped();
    }
  });

  $('#sig-close').addEventListener('click', close);
  $('#sig-cancel').addEventListener('click', close);
  $('#sig-save').addEventListener('click', useSignature);
  modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
  document.addEventListener('keydown', (event) => {
    if (!modal.hidden && event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  });

  loadSaved();
}
function padPoint(event) {
  const rect = pad.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * pad.width,
    y: ((event.clientY - rect.top) / rect.height) * pad.height,
  };
}

function clearPad() {
  ctx.clearRect(0, 0, pad.width, pad.height);
}

function setMode(next) {
  mode = next;
  clearPad();
  document.querySelectorAll('[data-sig-mode]').forEach((button) => {
    const active = button.dataset.sigMode === next;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#sig-type-wrap').hidden = next !== 'type';
  $('#sig-upload-wrap').hidden = next !== 'upload';
  if (next === 'type') renderTyped();
  else if (next === 'upload') renderUploaded();
  else hasInk = false;
}

function renderTyped() {
  clearPad();
  const name = $('#sig-type-name').value.trim();
  if (!name) { hasInk = false; return; }
  const family = FONTS[$('#sig-font').value] || FONTS['cursive-1'];
  let size = 96;
  ctx.fillStyle = '#111827';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  do {
    ctx.font = `${size}px ${family}`;
    if (ctx.measureText(name).width <= PAD_W - 70) break;
    size -= 3;
  } while (size > 20);
  ctx.font = `${size}px ${family}`;
  ctx.fillText(name, PAD_W / 2, PAD_H * 0.7 + 6);
  hasInk = true;
}

function renderUploaded() {
  clearPad();
  if (!uploadedImage) { hasInk = false; return; }
  const source = cleanUpload ? cleanWhiteBackground(uploadedImage) : uploadedImage;
  const scale = Math.min((PAD_W - 60) / source.width, (PAD_H - 40) / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  ctx.drawImage(source, (PAD_W - width) / 2, (PAD_H - height) / 2, width, height);
  hasInk = true;
}

function cleanWhiteBackground(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const local = canvas.getContext('2d');
  local.drawImage(image, 0, 0);
  try {
    const data = local.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.data.length; i += 4) {
      if (data.data[i] > 238 && data.data[i + 1] > 238 && data.data[i + 2] > 238) data.data[i + 3] = 0;
    }
    local.putImageData(data, 0, 0);
  } catch {
    return image;
  }
  return canvas;
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Unsupported image format.'));
      image.src = String(reader.result);
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}
function trimCanvas(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const local = canvas.getContext('2d');
  local.drawImage(source, 0, 0);
  let minX = source.width; let minY = source.height; let maxX = -1; let maxY = -1;
  try {
    const data = local.getImageData(0, 0, source.width, source.height).data;
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        if (data[(y * source.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
  } catch {
    return canvas;
  }
  if (maxX < minX || maxY < minY) return null;
  const padding = 8;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(source.width - 1, maxX + padding);
  maxY = Math.min(source.height - 1, maxY + padding);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function composeSignature() {
  const trimmed = trimCanvas(pad);
  if (!trimmed) return null;
  const name = $('#sig-name').value.trim();
  const includeDate = $('#sig-date').checked;
  const dateText = includeDate
    ? new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
    : '';
  const caption = [name, dateText].filter(Boolean).join(' · ');

  let captionCanvas = null;
  if (caption) {
    captionCanvas = document.createElement('canvas');
    const local = captionCanvas.getContext('2d');
    const fontSize = Math.max(18, Math.round(trimmed.height * 0.13));
    local.font = `500 ${fontSize}px "Segoe UI", system-ui, -apple-system, Arial, sans-serif`;
    const width = Math.ceil(local.measureText(caption).width) + 16;
    captionCanvas.width = Math.max(width, 120);
    captionCanvas.height = Math.ceil(fontSize * 1.5);
    const c = captionCanvas.getContext('2d');
    c.font = `500 ${fontSize}px "Segoe UI", system-ui, -apple-system, Arial, sans-serif`;
    c.fillStyle = '#4b5563';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(caption, captionCanvas.width / 2, captionCanvas.height / 2);
  }

  const gap = captionCanvas ? 8 : 0;
  const out = document.createElement('canvas');
  out.width = Math.max(trimmed.width, captionCanvas ? captionCanvas.width : 0);
  out.height = trimmed.height + gap + (captionCanvas ? captionCanvas.height : 0);
  const local = out.getContext('2d');
  local.drawImage(trimmed, Math.round((out.width - trimmed.width) / 2), 0);
  if (captionCanvas) {
    local.drawImage(captionCanvas, Math.round((out.width - captionCanvas.width) / 2), trimmed.height + gap);
  }
  return { dataUrl: out.toDataURL('image/png'), width: out.width, height: out.height };
}

function useSignature() {
  if (!hasInk) {
    toast(mode === 'draw' ? 'Draw your signature first.' : mode === 'type' ? 'Type your name first.' : 'Choose a signature image first.', 'warn');
    return;
  }
  const composed = composeSignature();
  if (!composed) {
    toast('The signature looks empty. Try again.', 'warn');
    return;
  }
  saveRecent(composed.dataUrl);
  const callback = onUseCallback;
  close();
  if (callback) callback(composed.dataUrl);
}

export function openSignatureModal(onUse) {
  initSignatureModal();
  onUseCallback = onUse;
  setMode('draw');
  hasInk = false;
  clearPad();
  $('#sig-name').value = '';
  $('#sig-type-name').value = '';
  uploadedImage = null;
  $('#sig-upload').value = '';
  $('#sig-date').checked = true;
  loadSaved();
  modal.hidden = false;
  setTimeout(() => $('#sig-type-name').focus(), 30);
}

function close() {
  if (modal) modal.hidden = true;
}

function readSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

function saveRecent(dataUrl) {
  try {
    const list = [dataUrl, ...readSaved().filter((item) => item !== dataUrl)].slice(0, 6);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage may be unavailable (private mode, blocked third-party context).
  }
}

function loadSaved() {
  const host = $('#sig-saved-list');
  const wrap = $('#sig-saved');
  if (!host || !wrap) return;
  const list = readSaved();
  host.textContent = '';
  wrap.hidden = list.length === 0;
  for (const item of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = 'Use this saved signature';
    const img = document.createElement('img');
    img.src = item;
    img.alt = 'Saved signature';
    button.appendChild(img);
    button.addEventListener('click', () => {
      saveRecent(item);
      const callback = onUseCallback;
      close();
      if (callback) callback(item);
    });
    host.appendChild(button);
  }
}


