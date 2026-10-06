// 자막 템플릿: 내가 만든 스타일 저장, 자막 바 이미지, 사진 속 자막 색감 따라하기
// 템플릿은 프로젝트와 별개로 브라우저에 보관되어 모든 프로젝트에서 다시 쓸 수 있음

import { idbPut, idbDel, idbAll, emit, uid } from './store.js';
import { textStyleById, TEXT_STYLES } from './presets.js';

const registry = new Map(); // id → { meta, img, url }
export const OVERRIDE_KEYS = ['color', 'font', 'weight', 'bg', 'stroke', 'accent', 'align'];

export const listTemplates = () => [...registry.values()].filter((r) => !r.preview).map((r) => r.meta).sort((a, b) => a.created - b.created);
export const getTemplate = (id) => registry.get(id) || null;

export async function loadTemplates() {
  const all = await idbAll('tpl');
  for (const rec of all) await register(rec);
  emit('templates');
}

async function register(rec) {
  const { image, ...meta } = rec;
  const old = registry.get(meta.id);
  if (old?.url) URL.revokeObjectURL(old.url);
  let img = null;
  let url = null;
  if (image) {
    url = URL.createObjectURL(image);
    img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
  }
  registry.set(meta.id, { meta, img, url, blob: image || null });
}

/** 저장하지 않고 미리보기용으로만 등록 */
export function setPreviewTemplate(id, meta, img) {
  if (img) registry.set(id, { meta: { ...meta, id }, img, url: null, blob: null, preview: true });
  else registry.delete(id);
}

export async function saveTemplate(rec) {
  rec.id = rec.id || uid('tp');
  rec.created = rec.created || Date.now();
  await idbPut('tpl', rec.id, rec);
  await register(rec);
  emit('templates');
  return rec.id;
}

export async function deleteTemplate(id) {
  const r = registry.get(id);
  if (r?.url) URL.revokeObjectURL(r.url);
  registry.delete(id);
  await idbDel('tpl', id);
  emit('templates');
}

// ---------- 스타일 참조 (style:기본스타일ID | tpl:템플릿ID) ----------

export function refName(ref) {
  const [kind, id] = String(ref).split(':');
  if (kind === 'tpl') return registry.get(id)?.meta.name || '삭제된 템플릿';
  return textStyleById(id).name;
}

export function refExists(ref) {
  const [kind, id] = String(ref).split(':');
  return kind === 'tpl' ? registry.has(id) : TEXT_STYLES.some((s) => s.id === id);
}

/** ref를 text 객체에 적용 (기존 꾸밈은 초기화) */
export function applyRef(text, ref, { keepPosition = false } = {}) {
  const [kind, id] = String(ref).split(':');
  for (const k of OVERRIDE_KEYS) delete text[k];
  delete text.template;
  const pos = { x: text.x, y: text.y };
  if (kind === 'tpl' && registry.has(id)) {
    const m = registry.get(id).meta;
    const st = textStyleById(m.base);
    text.style = st.id;
    for (const k of OVERRIDE_KEYS) if (m.overrides?.[k] !== undefined) text[k] = m.overrides[k];
    text.size = m.overrides?.size ?? 1;
    text.anim = m.overrides?.anim ?? st.anim;
    if (m.hasImage) text.template = m.id;
    text.x = m.x ?? st.x;
    text.y = m.y ?? st.y;
  } else {
    const st = textStyleById(id);
    text.style = st.id;
    text.size = 1;
    text.anim = st.anim;
    text.x = st.x;
    text.y = st.y;
  }
  if (keepPosition && pos.x != null) { text.x = pos.x; text.y = pos.y; }
  text.ref = refExists(ref) ? ref : `style:${text.style}`;
}

/** 텍스트 클립의 현재 모습을 템플릿으로 저장 */
export async function templateFromText(text, name) {
  const overrides = { size: text.size || 1, anim: text.anim };
  for (const k of OVERRIDE_KEYS) if (text[k] !== undefined) overrides[k] = text[k];
  const rec = { name, base: text.style, overrides, x: text.x, y: text.y, hasImage: false };
  const src = text.template && registry.get(text.template);
  if (src?.blob) {
    const imgMeta = { ...src.meta };
    delete imgMeta.id;
    delete imgMeta.created;
    Object.assign(rec, imgMeta, { name, base: text.style, overrides, x: text.x, y: text.y, hasImage: true, image: src.blob });
  }
  return saveTemplate(rec);
}

// ---------- 이미지 처리 ----------

const MAX_W = 1400;

export async function fileToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, MAX_W / img.naturalWidth);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function borderStats(d, w, h) {
  const px = [];
  const push = (x, y) => { const i = (y * w + x) * 4; px.push([d[i], d[i + 1], d[i + 2], d[i + 3]]); };
  const step = Math.max(1, Math.floor(Math.max(w, h) / 200));
  for (let x = 0; x < w; x += step) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += step) { push(0, y); push(w - 1, y); }
  const avg = [0, 1, 2, 3].map((k) => px.reduce((s, p) => s + p[k], 0) / px.length);
  const sd = Math.sqrt(px.reduce((s, p) => s + dist(p, avg) ** 2, 0) / px.length);
  return { avg, sd };
}

/** 업로드한 이미지 분석: 투명 배경 여부, 단색 배경(지울 수 있음) 여부 */
export function analyzeImage(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  let transparent = 0;
  for (let i = 3; i < d.length; i += 16) if (d[i] < 250) transparent++;
  const hasAlpha = transparent > d.length / 16 * 0.02;
  const border = borderStats(d, w, h);
  return { hasAlpha, removable: !hasAlpha && border.sd < 22, border };
}

/** 가장자리와 이어진 단색 배경을 투명하게 (플러드 필) */
export function removeBackground(canvas, tolerance = 42) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const im = ctx.getImageData(0, 0, w, h);
  const d = im.data;
  const { avg } = borderStats(d, w, h);
  const seen = new Uint8Array(w * h);
  const stack = [];
  const tryPush = (x, y) => {
    const p = y * w + x;
    if (seen[p]) return;
    seen[p] = 1;
    const i = p * 4;
    if (dist([d[i], d[i + 1], d[i + 2]], avg) <= tolerance) stack.push(p);
  };
  for (let x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1); }
  for (let y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    const i = p * 4;
    // 경계에 가까운 색은 반투명으로 부드럽게
    const dd = dist([d[i], d[i + 1], d[i + 2]], avg);
    d[i + 3] = dd < tolerance * 0.6 ? 0 : Math.round(255 * ((dd - tolerance * 0.6) / (tolerance * 0.4)));
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) tryPush(x - 1, y);
    if (x < w - 1) tryPush(x + 1, y);
    if (y > 0) tryPush(x, y - 1);
    if (y < h - 1) tryPush(x, y + 1);
  }
  ctx.putImageData(im, 0, 0);
  return trimTransparent(canvas);
}

/** 투명한 여백 잘라내기 */
export function trimTransparent(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0 || (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1)) return canvas;
  const c = document.createElement('canvas');
  c.width = x1 - x0 + 1;
  c.height = y1 - y0 + 1;
  c.getContext('2d').drawImage(canvas, -x0, -y0);
  return c;
}

/** 자막 바 가운데 영역의 밝기로 어울리는 글자색 추천 */
export function suggestTextColor(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d').getImageData(Math.floor(w * 0.25), Math.floor(h * 0.25), Math.max(1, Math.floor(w * 0.5)), Math.max(1, Math.floor(h * 0.5))).data;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    n++;
  }
  const lum = n ? sum / n : 0;
  return lum > 0.58 ? '#111111' : '#ffffff';
}

/**
 * 늘릴 때 고정할 양 끝 너비(이미지 너비 대비) 찾기.
 * 가운데 세로줄과 모양·색이 같아지는 지점까지를 장식(둥근 끝, 로고 등)으로 보고 늘리지 않음.
 */
export function suggestSlice(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const col = (x) => {
    let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
    for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 60))) {
      const i = (y * w + x) * 4;
      a += d[i + 3] > 128 ? 1 : 0;
      if (d[i + 3] > 128) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      else n += 0;
    }
    const rows = Math.ceil(h / Math.max(1, Math.floor(h / 60)));
    return n ? [r / n, g / n, b / n, a / rows] : [0, 0, 0, 0];
  };
  const ref = col(Math.floor(w / 2));
  const same = (c) => dist(c, ref) < 28 && Math.abs(c[3] - ref[3]) < 0.06;
  const run = Math.max(3, Math.floor(w * 0.03));
  const scan = (from, dir) => {
    for (let k = 0; k < w / 2; k++) {
      const x = from + dir * k;
      let ok = true;
      for (let j = 0; j < run && ok; j++) ok = same(col(x + dir * j));
      if (ok) return k;
    }
    return Math.floor(w * 0.25);
  };
  const minCap = Math.min(0.45, (h / w) * 0.5);
  const l = Math.min(0.45, Math.max(minCap, scan(0, 1) / w + 0.01));
  const r = Math.min(0.45, Math.max(minCap, scan(w - 1, -1) / w + 0.01));
  return { l, r };
}

export function canvasToBlob(canvas) {
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}

const hex = (c) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * 자막이 찍힌 사진(캡처)에서 글자색·테두리색·배경 박스를 추정.
 * 글자 주변을 잘라서 올릴수록 정확함.
 */
export function extractTextStyle(canvas) {
  const s = Math.min(1, 320 / canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * s));
  c.height = Math.max(1, Math.round(canvas.height * s));
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  const { width: w, height: h } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const border = borderStats(d, w, h);
  const bgc = border.avg;
  const isFg = new Uint8Array(w * h);
  const fg = [];
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (d[i + 3] < 128) continue;
    const col = [d[i], d[i + 1], d[i + 2]];
    if (dist(col, bgc) > Math.max(60, border.sd * 2.2)) { isFg[p] = 1; fg.push([p, col]); }
  }
  if (fg.length < w * h * 0.01) return null;
  // k-means (k=2), 가장 밝은 색/가장 어두운 색으로 시작
  const lum = (col) => 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2];
  let cents = [fg.reduce((a, b) => (lum(b[1]) > lum(a[1]) ? b : a))[1], fg.reduce((a, b) => (lum(b[1]) < lum(a[1]) ? b : a))[1]];
  let label = new Uint8Array(fg.length);
  for (let it = 0; it < 8; it++) {
    const sum = [[0, 0, 0, 0], [0, 0, 0, 0]];
    fg.forEach(([, col], k) => {
      const l = dist(col, cents[0]) <= dist(col, cents[1]) ? 0 : 1;
      label[k] = l;
      sum[l][0] += col[0]; sum[l][1] += col[1]; sum[l][2] += col[2]; sum[l][3]++;
    });
    cents = sum.map((sm, i) => (sm[3] ? [sm[0] / sm[3], sm[1] / sm[3], sm[2] / sm[3]] : cents[i]));
  }
  // 배경과 맞닿은 비율이 높은 쪽이 테두리
  const cnt = [0, 0];
  const edge = [0, 0];
  fg.forEach(([p], k) => {
    const l = label[k];
    cnt[l]++;
    const x = p % w;
    const y = (p - x) / w;
    if ((x > 0 && !isFg[p - 1]) || (x < w - 1 && !isFg[p + 1]) || (y > 0 && !isFg[p - w]) || (y < h - 1 && !isFg[p + w])) edge[l]++;
  });
  const ratio = [edge[0] / Math.max(1, cnt[0]), edge[1] / Math.max(1, cnt[1])];
  const bothBig = Math.min(cnt[0], cnt[1]) > fg.length * 0.12 && dist(cents[0], cents[1]) > 70;
  let fill;
  let stroke = null;
  if (bothBig) {
    const strokeIdx = ratio[0] > ratio[1] ? 0 : 1;
    stroke = hex(cents[strokeIdx]);
    fill = hex(cents[1 - strokeIdx]);
  } else {
    fill = hex(cents[cnt[0] >= cnt[1] ? 0 : 1]);
  }
  // 테두리가 단색이면 자막 박스로 판단
  const bg = border.sd < 22 && border.avg[3] > 200 ? `rgba(${bgc.slice(0, 3).map(Math.round).join(',')},0.85)` : null;
  return { color: fill, stroke, bg };
}
