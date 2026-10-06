// 영상·사진 배치 계산: 맞춤(전체 보이기/꽉 채우기), 크기·위치·회전, 움직임 효과, 화면 자르기(크롭)

import { ease, clamp } from './ui.js';

export const NO_CROP = { l: 0, t: 0, r: 0, b: 0 };
export const MIN_KEEP = 0.05; // 자르고 남는 최소 비율

export const cropOf = (c) => c.crop || NO_CROP;
export const hasCrop = (c) => { const k = cropOf(c); return k.l + k.t + k.r + k.b > 0.0005; };

/**
 * 클립을 화면(W×H)에 그릴 위치 계산. sw/sh: 원본 크기
 * cropFit=false: 자른 부분만 가려지고 나머지는 제자리 (마스크처럼)
 * cropFit=true : 남은 부분을 기준으로 화면에 맞춤 (비율 자르기 · 검은 여백 지우기)
 */
export function visualLayout(c, W, H, sw, sh, local = 0, o = {}) {
  const k = cropOf(c);
  const cw = sw * (1 - k.l - k.r);
  const ch = sh * (1 - k.t - k.b);
  const fw = c.cropFit ? cw : sw;
  const fh = c.cropFit ? ch : sh;
  const base = c.fit === 'cover' ? Math.max(W / fw, H / fh) : Math.min(W / fw, H / fh);
  let ms = 1;
  let mx = 0;
  const mp = c.dur > 0 ? clamp(local / c.dur, 0, 1) : 0;
  switch (c.motion) {
    case 'zoomIn': ms = 1 + 0.15 * ease(mp); break;
    case 'zoomOut': ms = 1.15 - 0.15 * ease(mp); break;
    case 'panLeft': ms = 1.15; mx = (0.06 - 0.12 * ease(mp)) * W; break;
    case 'panRight': ms = 1.15; mx = (-0.06 + 0.12 * ease(mp)) * W; break;
    default: break;
  }
  const tf = c.transform;
  const s = base * tf.scale * ms * (o.scale || 1); // 원본 1px → 화면 px
  const fullW = sw * s;
  const fullH = sh * s;
  const visW = cw * s;
  const visH = ch * s;
  // 기준점(회전 중심)에서 보이는 영역 중심까지의 거리 (회전 전 좌표)
  const ox = c.cropFit ? 0 : ((k.l - k.r) / 2) * fullW;
  const oy = c.cropFit ? 0 : ((k.t - k.b) / 2) * fullH;
  const ax = W / 2 + tf.x * W + mx + (o.dx || 0);
  const ay = H / 2 + tf.y * H;
  const rot = tf.rotation || 0;
  const a = (rot * Math.PI) / 180;
  return {
    ax, ay, rot, s, fullW, fullH, base,
    vis: { x: ox - visW / 2, y: oy - visH / 2, w: visW, h: visH },
    src: { x: k.l * sw, y: k.t * sh, w: cw, h: ch },
    // 화면 기준 보이는 영역 중심
    cx: ax + ox * Math.cos(a) - oy * Math.sin(a),
    cy: ay + ox * Math.sin(a) + oy * Math.cos(a),
  };
}

/** 원본 비율 sw:sh 에서 목표 비율(ratio)만큼 가운데를 잘라내는 값 */
export function cropForRatio(sw, sh, ratio) {
  const a = sw / sh;
  if (Math.abs(a - ratio) < 0.005) return { ...NO_CROP };
  if (ratio < a) {
    const keep = ratio / a;
    return { l: (1 - keep) / 2, r: (1 - keep) / 2, t: 0, b: 0 };
  }
  const keep = a / ratio;
  return { l: 0, r: 0, t: (1 - keep) / 2, b: (1 - keep) / 2 };
}

/**
 * cropFit(남은 부분을 화면에 맞춤) 상태를 화면이 그대로 보이도록 일반 자르기로 바꿈.
 * 가장자리를 직접 끌어 자를 때, 영상이 튀지 않게 하려는 것.
 */
export function bakeCropFit(c, W, H, sw, sh) {
  if (!c.cropFit) return;
  const before = visualLayout(c, W, H, sw, sh);
  c.cropFit = false;
  const after = visualLayout(c, W, H, sw, sh);
  c.transform.scale *= before.s / after.s;
  const now = visualLayout(c, W, H, sw, sh);
  c.transform.x += (before.cx - now.cx) / W;
  c.transform.y += (before.cy - now.cy) / H;
}

/** 현재 프레임에서 검은 여백(레터박스) 찾기 → crop 값 */
export function detectBlackBars(source, sw, sh) {
  const w = 160;
  const h = Math.max(2, Math.round((w * sh) / sw));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const rowDark = (y) => { let m = 0; for (let x = 0; x < w; x++) m = Math.max(m, lum((y * w + x) * 4)); return m < 28; };
  const colDark = (x) => { let m = 0; for (let y = 0; y < h; y++) m = Math.max(m, lum((y * w + x) * 4)); return m < 28; };
  let t = 0; while (t < h / 2 && rowDark(t)) t++;
  let b = 0; while (b < h / 2 && rowDark(h - 1 - b)) b++;
  let l = 0; while (l < w / 2 && colDark(l)) l++;
  let r = 0; while (r < w / 2 && colDark(w - 1 - r)) r++;
  if (t >= h / 2 || l >= w / 2) return null; // 화면 전체가 어두움
  // 경계 1px 여유
  const f = (n, total) => (n > 1 ? (n + 0.5) / total : 0);
  return { l: f(l, w), r: f(r, w), t: f(t, h), b: f(b, h) };
}
