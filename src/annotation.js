/* Annotation model, canvas rendering and hit testing.
   Coordinates are normalised to the displayed page (0..1), where the
   display box already accounts for the page's /Rotate value. */
import { clamp } from './util.js';

export const LINE_HEIGHT = 1.28;
export const COMMENT_PAD = 8;
export const TEXT_FONT = 'Helvetica, Arial, sans-serif';

let measureCtx = null;
function getMeasureContext() {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    measureCtx = canvas.getContext('2d');
  }
  return measureCtx;
}

export function measureText(text, fontSize) {
  const lines = String(text ?? '').split('\n');
  const ctx = getMeasureContext();
  ctx.font = `${fontSize}px ${TEXT_FONT}`;
  let width = 0;
  for (const line of lines) width = Math.max(width, ctx.measureText(line || ' ').width);
  const lineHeight = fontSize * LINE_HEIGHT;
  return { lines, width, lineHeight, height: Math.max(1, lines.length) * lineHeight };
}

export function createAnnotation(type, props = {}) {
  const base = {
    id: `ann_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`,
    type,
    color: '#dc2626',
    opacity: 1,
    width: 2,
    fontSize: 14,
    text: '',
  };
  return { ...base, ...props };
}

export function annotationBounds(ann, Wd, Hd) {
  const type = ann.type;
  if (type === 'highlight' || type === 'rect' || type === 'mask' || type === 'signature') {
    return { x: ann.x, y: ann.y, w: ann.w, h: ann.h };
  }
  if (type === 'text' || type === 'comment') {
    const metrics = measureText(ann.text, ann.fontSize);
    const pad = type === 'comment' ? COMMENT_PAD * 2 : 0;
    return {
      x: ann.x,
      y: ann.y,
      w: (metrics.width + pad) / Wd,
      h: (metrics.height + pad) / Hd,
    };
  }
  if (type === 'ink') {
    if (!ann.points || ann.points.length === 0) return { x: ann.x || 0, y: ann.y || 0, w: 0.01, h: 0.01 };
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of ann.points) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const padX = ann.width / 2 / Wd;
    const padY = ann.width / 2 / Hd;
    return {
      x: Math.max(0, minX - padX),
      y: Math.max(0, minY - padY),
      w: Math.min(1, maxX + padX) - Math.max(0, minX - padX),
      h: Math.min(1, maxY + padY) - Math.max(0, minY - padY),
    };
  }
  if (type === 'arrow') {
    const minX = Math.min(ann.x1, ann.x2);
    const minY = Math.min(ann.y1, ann.y2);
    const maxX = Math.max(ann.x1, ann.x2);
    const maxY = Math.max(ann.y1, ann.y2);
    const padX = ann.width / 2 / Wd;
    const padY = ann.width / 2 / Hd;
    return { x: minX - padX, y: minY - padY, w: maxX - minX + padX * 2, h: maxY - minY + padY * 2 };
  }
  return { x: ann.x || 0, y: ann.y || 0, w: 0.01, h: 0.01 };
}

const imageCache = new Map();

function getImage(src, onLoad) {
  let entry = imageCache.get(src);
  if (!entry) {
    const img = new Image();
    entry = { img, loaded: false };
    img.onload = () => {
      entry.loaded = true;
      if (onLoad) onLoad();
    };
    img.onerror = () => { entry.loaded = false; };
    img.src = src;
    imageCache.set(src, entry);
  }
  return entry.loaded ? entry.img : null;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Draw one annotation.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} ann
 * @param {number} Wd display width in PDF points (scale 1)
 * @param {number} Hd display height in PDF points (scale 1)
 * @param {number} scale current render scale
 * @param {Function} onImageLoad called when a signature image finishes loading
 */
export function drawAnnotation(ctx, ann, Wd, Hd, scale, onImageLoad) {
  const W = Wd * scale;
  const H = Hd * scale;
  const px = (n) => n * W;
  const py = (n) => n * H;
  ctx.save();
  ctx.globalAlpha = clamp(ann.opacity ?? 1, 0, 1);

  if (ann.type === 'highlight') {
    ctx.globalAlpha = clamp(ann.opacity ?? 0.35, 0, 1);
    ctx.fillStyle = ann.color;
    ctx.fillRect(px(ann.x), py(ann.y), px(ann.w), py(ann.h));
  } else if (ann.type === 'rect') {
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = Math.max(1, ann.width * scale);
    ctx.strokeRect(px(ann.x), py(ann.y), px(ann.w), py(ann.h));
  } else if (ann.type === 'mask') {
    ctx.fillStyle = ann.color || '#111827';
    ctx.fillRect(px(ann.x), py(ann.y), px(ann.w), py(ann.h));
  } else if (ann.type === 'ink') {
    const points = ann.points || [];
    if (points.length > 0) {
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = Math.max(1, ann.width * scale);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(px(points[0].x), py(points[0].y));
      for (let i = 1; i < points.length; i += 1) ctx.lineTo(px(points[i].x), py(points[i].y));
      if (points.length === 1) ctx.lineTo(px(points[0].x) + 0.1, py(points[0].y) + 0.1);
      ctx.stroke();
    }
  } else if (ann.type === 'arrow') {
    const x1 = px(ann.x1), y1 = py(ann.y1), x2 = px(ann.x2), y2 = py(ann.y2);
    const thickness = Math.max(1, ann.width * scale);
    ctx.strokeStyle = ann.color;
    ctx.fillStyle = ann.color;
    ctx.lineWidth = thickness;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(9, 5 + thickness * 3);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else if (ann.type === 'text') {
    const metrics = measureText(ann.text, ann.fontSize);
    ctx.fillStyle = ann.color;
    ctx.font = `${ann.fontSize * scale}px ${TEXT_FONT}`;
    ctx.textBaseline = 'top';
    const lh = metrics.lineHeight * scale;
    metrics.lines.forEach((line, i) => {
      ctx.fillText(line, px(ann.x), py(ann.y) + i * lh);
    });
  } else if (ann.type === 'comment') {
    const metrics = measureText(ann.text, ann.fontSize);
    const pad = COMMENT_PAD * scale;
    const boxW = metrics.width * scale + pad * 2;
    const boxH = metrics.height * scale + pad * 2;
    roundRect(ctx, px(ann.x), py(ann.y), Math.max(boxW, 24), Math.max(boxH, 20), 5 * scale);
    ctx.fillStyle = 'rgba(255, 246, 196, 0.97)';
    ctx.fill();
    ctx.strokeStyle = ann.color || '#eab308';
    ctx.lineWidth = Math.max(1, 0.8 * scale);
    ctx.stroke();
    ctx.fillStyle = '#3f3a1f';
    ctx.font = `${ann.fontSize * scale}px ${TEXT_FONT}`;
    ctx.textBaseline = 'top';
    const lh = metrics.lineHeight * scale;
    metrics.lines.forEach((line, i) => {
      ctx.fillText(line, px(ann.x) + pad, py(ann.y) + pad + i * lh);
    });
  } else if (ann.type === 'signature') {
    const image = getImage(ann.src, onImageLoad);
    if (image) ctx.drawImage(image, px(ann.x), py(ann.y), px(ann.w), px(ann.h));
  }

  ctx.restore();
}

export function drawAnnotations(ctx, annotations, Wd, Hd, scale, onImageLoad) {
  for (const ann of annotations) drawAnnotation(ctx, ann, Wd, Hd, scale, onImageLoad);
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = clamp(t, 0, 1);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export function hitTestAnnotation(annotations, nx, ny, Wd, Hd) {
  const px = nx * Wd;
  const py = ny * Hd;
  for (let i = annotations.length - 1; i >= 0; i -= 1) {
    const ann = annotations[i];
    const b = annotationBounds(ann, Wd, Hd);
    const padX = 4 / Wd;
    const padY = 4 / Hd;
    const inside = nx >= b.x - padX && nx <= b.x + b.w + padX && ny >= b.y - padY && ny <= b.y + b.h + padY;
    if (!inside) continue;

    if (ann.type === 'ink') {
      const points = ann.points || [];
      const threshold = Math.max(5, ann.width / 2 + 2);
      let hit = points.length === 1
        ? Math.hypot(px - points[0].x * Wd, py - points[0].y * Hd) <= threshold
        : false;
      for (let j = 1; j < points.length && !hit; j += 1) {
        hit = distanceToSegment(px, py, points[j - 1].x * Wd, points[j - 1].y * Hd, points[j].x * Wd, points[j].y * Hd) <= threshold;
      }
      if (hit) return ann;
      continue;
    }
    if (ann.type === 'arrow') {
      const d = distanceToSegment(px, py, ann.x1 * Wd, ann.y1 * Hd, ann.x2 * Wd, ann.y2 * Hd);
      if (d <= Math.max(6, ann.width / 2 + 3)) return ann;
      continue;
    }
    return ann;
  }
  return null;
}

export function moveAnnotation(ann, dx, dy, Wd, Hd) {
  if (ann.type === 'ink') {
    const points = ann.points || [];
    if (!points.length) return;
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of points) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    dx = clamp(dx, -minX, 1 - maxX);
    dy = clamp(dy, -minY, 1 - maxY);
    for (const p of points) { p.x += dx; p.y += dy; }
    return;
  }
  if (ann.type === 'arrow') {
    const minX = Math.min(ann.x1, ann.x2);
    const maxX = Math.max(ann.x1, ann.x2);
    const minY = Math.min(ann.y1, ann.y2);
    const maxY = Math.max(ann.y1, ann.y2);
    dx = clamp(dx, -minX, 1 - maxX);
    dy = clamp(dy, -minY, 1 - maxY);
    ann.x1 += dx; ann.x2 += dx; ann.y1 += dy; ann.y2 += dy;
    return;
  }
  const b = annotationBounds(ann, Wd, Hd);
  dx = clamp(dx, -b.x, 1 - b.x - b.w);
  dy = clamp(dy, -b.y, 1 - b.y - b.h);
  ann.x = (ann.x ?? 0) + dx;
  ann.y = (ann.y ?? 0) + dy;
}

export function resizeAnnotation(ann, nx, ny, Wd, Hd, startBounds, keepAspect = false) {
  const minW = 6 / Wd;
  const minH = 6 / Hd;
  if (keepAspect && ann.aspect) {
    const targetW = Math.max(minW, nx - startBounds.x);
    const targetH = (targetW * Wd * ann.aspect) / Hd;
    ann.w = targetW;
    ann.h = Math.max(minH, targetH);
  } else {
    ann.w = Math.max(minW, nx - startBounds.x);
    ann.h = Math.max(minH, ny - startBounds.y);
  }
}

export function selectionHandle(ann, Wd, Hd) {
  const b = annotationBounds(ann, Wd, Hd);
  return { x: b.x + b.w, y: b.y + b.h, size: 10 / Wd };
}


