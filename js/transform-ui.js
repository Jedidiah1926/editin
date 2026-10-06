// 미리보기 위 조작 핸들: 모서리를 끌어 크기 조절, 화면 자르기 모드에서는 가장자리를 끌어 자르기

import {
  state, project, on, emit, mutate, beginGesture, mutateLive, endGesture, clipById, mediaById, selectedClips, trackById,
} from './store.js';
import { visualLayout, bakeCropFit, cropForRatio, detectBlackBars, cropOf, hasCrop, MIN_KEEP } from './geometry.js';
import { h, toast, clamp } from './ui.js';

let engine = null;
let canvas = null;
let stage = null;
let cropMode = false;
let box = null;
let doneBtn = null;

export const isCropMode = () => cropMode;

const isVisual = (c) => c && (c.type === 'video' || c.type === 'image');

export function setCropMode(on) {
  const c = selectedClips()[0];
  if (on && (!isVisual(c) || selectedClips().length !== 1)) {
    toast('자를 영상이나 사진을 하나 선택하세요');
    return;
  }
  if (on && trackById(c.trackId)?.locked) { toast('잠긴 레이어예요'); return; }
  cropMode = !!on;
  engine.cropGhostId = cropMode ? c.id : null;
  engine.invalidate();
  emit('cropmode', cropMode);
}

export function toggleCrop() { setCropMode(!cropMode); }

function srcDims(c) {
  const m = mediaById(c.mediaId);
  if (m?.width && m?.height) return { sw: m.width, sh: m.height };
  const b = engine.bounds.find((x) => x.id === c.id);
  return b?.sw ? { sw: b.sw, sh: b.sh } : null;
}

/**
 * 비율로 가운데 자르기 (ratio=null이면 자르기 해제).
 * 검은 여백 지우기나 직접 자른 영역이 있으면 그 안에서 비율을 맞추고, 화면에 꽉 차게 배치.
 */
export function applyCropRatio(ids, ratio, label) {
  let n = 0;
  mutate(label || (ratio ? '비율로 자르기' : '자르기 해제'), (p) => {
    for (const c of p.clips) {
      if (!ids.includes(c.id) || !isVisual(c)) continue;
      if (!ratio) { delete c.crop; delete c.cropBase; delete c.cropRatio; c.cropFit = false; n++; continue; }
      const d = srcDims(c);
      if (!d) continue;
      const base = c.cropRatio ? (c.cropBase || { l: 0, t: 0, r: 0, b: 0 }) : { ...cropOf(c) };
      const bw = d.sw * (1 - base.l - base.r);
      const bh = d.sh * (1 - base.t - base.b);
      const inner = cropForRatio(bw, bh, ratio);
      const fx = 1 - base.l - base.r;
      const fy = 1 - base.t - base.b;
      c.crop = { l: base.l + inner.l * fx, r: base.r + inner.r * fx, t: base.t + inner.t * fy, b: base.b + inner.b * fy };
      c.cropBase = base;
      c.cropRatio = ratio;
      c.cropFit = true;
      c.fit = 'cover';
      c.transform.scale = 1;
      c.transform.x = 0;
      c.transform.y = 0;
      n++;
    }
  });
  return n;
}

/** 현재 화면에서 검은 여백을 찾아 잘라냄 */
export function removeBlackBars(id) {
  const c = clipById(id);
  if (!isVisual(c)) return false;
  let src = null;
  let sw = 0;
  let sh = 0;
  if (c.type === 'video') {
    const el = engine.assign.get(c.id);
    if (el && el.readyState >= 2) { src = el; sw = el.videoWidth; sh = el.videoHeight; }
  } else {
    const img = engine.getImage(c.mediaId);
    if (img) { src = img; sw = img.naturalWidth; sh = img.naturalHeight; }
  }
  if (!src) { toast('재생 위치(빨간 선)를 이 클립 위로 옮기고 다시 눌러 주세요'); return false; }
  const k = detectBlackBars(src, sw, sh);
  if (!k || k.l + k.r + k.t + k.b < 0.01) { toast('지울 검은 여백을 찾지 못했어요'); return false; }
  mutate('검은 여백 지우기', (p) => {
    const x = p.clips.find((y) => y.id === id);
    x.crop = k;
    x.cropFit = true;
    delete x.cropBase;
    delete x.cropRatio;
  });
  toast('검은 여백을 잘라냈어요');
  return true;
}

export function initTransformUI({ stage: st, canvas: cv, engine: en }) {
  stage = st;
  canvas = cv;
  engine = en;
  const layer = h('div', { class: 'tf-layer' });
  box = h('div', { class: 'tf-box' },
    ...['nw', 'ne', 'sw', 'se'].map((p) => h('div', { class: `tf-h tf-corner tf-${p}`, 'data-h': p })),
    ...['n', 's', 'e', 'w'].map((p) => h('div', { class: `tf-h tf-edge tf-${p}`, 'data-h': p })));
  doneBtn = h('div', { class: 'tf-crop-bar' },
    h('span', {}, '✂ 화면 자르기 · 가장자리를 끌어 잘라내세요'),
    h('button', { class: 'btn small', onclick: () => resetCropSelected() }, '초기화'),
    h('button', { class: 'btn small primary', onclick: () => setCropMode(false) }, '완료'));
  layer.append(box, doneBtn);
  stage.append(layer);

  box.addEventListener('pointerdown', (e) => {
    const handle = e.target.dataset?.h;
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    const c = selectedClips()[0];
    if (!c) return;
    if (cropMode && isVisual(c)) startCrop(e, c, handle);
    else if (handle.length === 2) startResize(e, c);
  });

  on('selection', () => {
    const c = selectedClips()[0];
    if (cropMode && (!c || c.id !== engine.cropGhostId || selectedClips().length !== 1)) setCropMode(false);
  });
  on('cropmode', () => { doneBtn.classList.toggle('show', cropMode); box.classList.toggle('crop', cropMode); });

  (function loop() {
    requestAnimationFrame(loop);
    place();
  })();
}

function resetCropSelected() {
  const c = selectedClips()[0];
  if (c && hasCrop(c)) applyCropRatio([c.id], null, '자르기 초기화');
}

/** 선택한 클립의 그려진 영역에 맞춰 핸들 위치 갱신 */
function place() {
  const sel = selectedClips();
  const c = sel.length === 1 ? sel[0] : null;
  const b = c && engine.bounds.find((x) => x.id === c.id);
  if (!b || trackById(c.trackId)?.locked) { box.style.display = 'none'; return; }
  const cr = canvas.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const k = cr.width / canvas.width;
  let { cx, cy, w, h: hh } = b;
  let clipped = false;
  // 화면 밖으로 넘친 부분은 잘라서 핸들이 항상 보이고 잡히게 함 (회전 없을 때)
  if (!b.rot) {
    const x0 = Math.max(0, cx - w / 2);
    const x1 = Math.min(canvas.width, cx + w / 2);
    const y0 = Math.max(0, cy - hh / 2);
    const y1 = Math.min(canvas.height, cy + hh / 2);
    if (x1 > x0 && y1 > y0) {
      clipped = x1 - x0 < w - 0.5 || y1 - y0 < hh - 0.5;
      cx = (x0 + x1) / 2; cy = (y0 + y1) / 2; w = x1 - x0; hh = y1 - y0;
    }
  }
  box.style.display = 'block';
  box.style.left = `${cr.left - sr.left + cx * k}px`;
  box.style.top = `${cr.top - sr.top + cy * k}px`;
  box.style.width = `${Math.max(4, w * k)}px`;
  box.style.height = `${Math.max(4, hh * k)}px`;
  box.style.transform = `translate(-50%, -50%) rotate(${b.rot || 0}deg)`;
  box.classList.toggle('text', c.type === 'text');
  box.classList.toggle('clipped', clipped);
}

function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
}

function track(e, onMove, onEnd) {
  const move = (ev) => onMove(ev);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.classList.remove('dragging');
    onEnd();
  };
  document.body.classList.add('dragging');
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startResize(e, c) {
  const b = engine.bounds.find((x) => x.id === c.id);
  if (!b) return;
  const p0 = toCanvas(e);
  const d0 = Math.max(4, Math.hypot(p0.x - b.cx, p0.y - b.cy));
  const s0 = c.type === 'text' ? (c.text.size || 1) : c.transform.scale;
  beginGesture();
  track(e, (ev) => {
    const p = toCanvas(ev);
    const f = Math.hypot(p.x - b.cx, p.y - b.cy) / d0;
    mutateLive(() => {
      if (c.type === 'text') c.text.size = clamp(s0 * f, 0.2, 6);
      else c.transform.scale = clamp(s0 * f, 0.05, 10);
    });
  }, () => endGesture('크기 조절'));
}

function startCrop(e, c, handle) {
  const p = project();
  const W = p.width;
  const H = p.height;
  const d = srcDims(c);
  if (!d) return;
  beginGesture();
  // 남은 부분 맞춤 상태라면 화면이 그대로 보이도록 일반 자르기로 전환
  mutateLive(() => {
    bakeCropFit(c, W, H, d.sw, d.sh);
    if (!c.crop) c.crop = { l: 0, t: 0, r: 0, b: 0 };
    delete c.cropBase;
    delete c.cropRatio;
  });
  const local = state.time - c.start;
  const L = visualLayout(c, W, H, d.sw, d.sh, local);
  const k0 = { ...cropOf(c) };
  const p0 = toCanvas(e);
  const a = (-L.rot * Math.PI) / 180;
  track(e, (ev) => {
    const q = toCanvas(ev);
    const dx = q.x - p0.x;
    const dy = q.y - p0.y;
    const ux = dx * Math.cos(a) - dy * Math.sin(a);
    const uy = dx * Math.sin(a) + dy * Math.cos(a);
    mutateLive(() => {
      const k = c.crop;
      if (handle.includes('w')) k.l = clamp(k0.l + ux / L.fullW, 0, 1 - k0.r - MIN_KEEP);
      if (handle.includes('e')) k.r = clamp(k0.r - ux / L.fullW, 0, 1 - k0.l - MIN_KEEP);
      if (handle.includes('n')) k.t = clamp(k0.t + uy / L.fullH, 0, 1 - k0.b - MIN_KEEP);
      if (handle.includes('s')) k.b = clamp(k0.b - uy / L.fullH, 0, 1 - k0.t - MIN_KEEP);
    });
  }, () => endGesture('화면 자르기'));
}
