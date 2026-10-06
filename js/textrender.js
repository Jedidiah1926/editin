// 텍스트(자막) 그리기: 기본 스타일, 사용자 템플릿(자막 바 이미지), 등장 애니메이션

import { textStyleById } from './presets.js';
import { getTemplate } from './templates.js';
import { clamp, ease, easeOutBack } from './ui.js';

export function fadeFactor(c, local) {
  let f = 1;
  if (c.fadeIn > 0) f = Math.min(f, clamp(local / c.fadeIn, 0, 1));
  if (c.fadeOut > 0) f = Math.min(f, clamp((c.dur - local) / c.fadeOut, 0, 1));
  return f;
}

/**
 * 텍스트 클립을 ctx에 그림. 그려진 영역(bounds)을 반환, 안 그렸으면 null.
 * o.alpha: 추가 불투명도
 */
export function renderText(ctx, c, t, W, H, o = {}) {
  const tx = c.text;
  if (!tx || !tx.content) return null;
  const st = textStyleById(tx.style);
  const local = clamp(t - c.start, 0, c.dur);
  const size = Math.max(6, st.size * H * (tx.size || 1));
  const font = tx.font || st.font;
  const weight = tx.weight || st.weight;
  ctx.save();
  ctx.font = `${weight} ${size}px "${font}", "Noto Sans KR", sans-serif`;
  const spacing = (st.spacing || 0) * size;
  if ('letterSpacing' in ctx) ctx.letterSpacing = spacing ? `${spacing}px` : '0px';
  ctx.textBaseline = 'middle';
  const align = tx.align || st.align || 'center';
  ctx.textAlign = align;

  // 애니메이션
  let alpha = (c.transform?.opacity ?? 1) * (o.alpha ?? 1);
  let scale = 1;
  let dy = 0;
  let content = tx.content;
  const anim = tx.anim ?? st.anim;
  const inP = clamp(local / 0.3, 0, 1);
  const outP = clamp((c.dur - local) / 0.25, 0, 1);
  switch (anim) {
    case 'fade': alpha *= Math.min(inP, outP); break;
    case 'pop': scale = local < 0.35 ? easeOutBack(clamp(local / 0.35, 0, 1)) : 1; alpha *= Math.min(clamp(local / 0.1, 0, 1), outP); break;
    case 'slideUp': dy = (1 - ease(inP)) * H * 0.05; alpha *= Math.min(inP, outP); break;
    case 'typewriter': {
      const chars = [...content];
      const n = Math.ceil(chars.length * clamp(local / Math.min(1.5, c.dur * 0.6), 0, 1));
      content = chars.slice(0, n).join('');
      break;
    }
    default: break;
  }
  alpha *= fadeFactor(c, local);
  if (alpha <= 0.001 || !content) { ctx.restore(); return null; }

  const maxW = W * 0.88;
  const lines = wrapText(ctx, content, maxW);
  const lh = size * 1.3;
  const fullLines = anim === 'typewriter' ? wrapText(ctx, tx.content, maxW) : lines;
  let fullW = 0;
  for (const l of fullLines) fullW = Math.max(fullW, ctx.measureText(l).width);
  const th = fullLines.length * lh;
  const x = (tx.x ?? st.x) * W;
  const y = (tx.y ?? st.y) * H + dy;
  const rot = c.transform?.rotation || 0;
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  if (scale !== 1) ctx.scale(scale, scale);

  let left = align === 'left' ? 0 : align === 'right' ? -fullW : -fullW / 2;
  let padX = size * 0.45;
  let padY = size * 0.22;
  const color = tx.color || st.color;
  const bg = tx.bg !== undefined ? tx.bg : st.bg;
  let box = { x: left - padX, y: -th / 2 - padY, w: fullW + padX * 2, h: th + padY * 2 };

  const tpl = tx.template ? getTemplate(tx.template) : null;
  if (tpl?.img?.naturalWidth) {
    const bar = drawBar(ctx, tpl, left, fullW, th, size);
    box = bar.box;
    left += bar.textShift;
  } else {
    if (bg) {
      ctx.fillStyle = bg;
      roundRect(ctx, box.x, box.y, box.w, box.h, size * 0.18);
      ctx.fill();
    }
    if (st.bar) {
      ctx.fillStyle = tx.accent || st.bar;
      ctx.fillRect(box.x, box.y, size * 0.14, box.h);
    }
  }
  const hasBox = bg || tpl?.img;
  if (st.shadow && !hasBox) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = size * 0.25;
    ctx.shadowOffsetY = size * 0.05;
  }
  if (st.glow) {
    ctx.shadowColor = tx.accent || st.glow;
    ctx.shadowBlur = size * 0.6;
  }
  const stroke = tx.stroke !== undefined ? tx.stroke : st.stroke;
  const anchorX = align === 'left' ? left : align === 'right' ? left + fullW : left + fullW / 2;
  lines.forEach((line, i) => {
    const ly = -th / 2 + lh * (i + 0.5);
    if (stroke) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = size * (st.strokeW || 0.15);
      ctx.strokeStyle = stroke;
      ctx.strokeText(line, anchorX, ly);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = color;
    ctx.fillText(line, anchorX, ly);
    if (st.glow) ctx.fillText(line, anchorX, ly);
  });
  ctx.restore();
  // 회전 전 기준 중심 좌표로 영역 계산
  const cx = x + box.x + box.w / 2;
  return { id: c.id, cx, cy: y + box.y + box.h / 2, w: box.w, h: box.h, rot, kind: 'text' };
}

/**
 * 자막 바 이미지 그리기.
 * fit='stretch': 양 끝(둥근 모서리, 장식)은 그대로 두고 가운데만 글자 길이에 맞춰 늘림
 * fit='fixed': 이미지 비율 유지, 글자가 넘치면 전체를 키움
 */
function drawBar(ctx, tpl, left, fullW, th, size) {
  const m = tpl.meta;
  const img = tpl.img;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  let barH = (th + size * 2 * (m.padY ?? 0.5)) * (m.barScale || 1);
  let s = barH / ih;
  let barW;
  const textCenter = left + fullW / 2;
  if (m.fit === 'stretch') {
    // 글자는 늘어나는 가운데 부분에만 놓이고, 양 끝 장식은 그대로 유지
    const capL = clamp(m.sliceL ?? 0.25, 0, 0.49) * iw;
    const capR = clamp(m.sliceR ?? 0.25, 0, 0.49) * iw;
    const midW = Math.max(1, fullW + size * 2 * (m.padX ?? 0.4));
    barW = (capL + capR) * s + midW;
    const x0 = textCenter - capL * s - midW / 2 - (m.textX || 0) * barW;
    const y0 = -barH / 2 - (m.textY || 0) * barH;
    ctx.drawImage(img, 0, 0, capL, ih, x0, y0, capL * s, barH);
    ctx.drawImage(img, capL, 0, iw - capL - capR, ih, x0 + capL * s, y0, midW, barH);
    ctx.drawImage(img, iw - capR, 0, capR, ih, x0 + capL * s + midW, y0, capR * s, barH);
    return { box: { x: x0, y: y0, w: barW, h: barH }, textShift: 0 };
  }
  barW = iw * s;
  // 글자가 들어갈 영역(textW 비율)보다 길면 전체 확대
  const area = clamp(m.textW ?? 0.8, 0.2, 1);
  const needW = fullW + size * 2 * (m.padX ?? 0.5);
  if (barW * area < needW) {
    const k = needW / (barW * area);
    barW *= k;
    barH *= k;
    s *= k;
  }
  const x0 = textCenter - barW / 2 - (m.textX || 0) * barW;
  const y0 = -barH / 2 - (m.textY || 0) * barH;
  ctx.drawImage(img, x0, y0, barW, barH);
  return { box: { x: x0, y: y0, w: barW, h: barH }, textShift: 0 };
}

export function wrapText(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (ctx.measureText(para).width <= maxW) { out.push(para); continue; }
    let line = '';
    const tokens = para.split(/(\s+)/);
    for (const tok of tokens) {
      const test = line + tok;
      if (ctx.measureText(test).width <= maxW) { line = test; continue; }
      if (line.trim()) { out.push(line.trim()); line = ''; }
      // 공백 없이 긴 토큰(한국어 등)은 글자 단위로 줄바꿈
      for (const ch of tok.trimStart()) {
        if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ''; }
        line += ch;
      }
    }
    if (line.trim()) out.push(line.trim());
  }
  return out.length ? out : [''];
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 템플릿/스타일 미리보기 이미지 (카드 썸네일용) */
export function previewDataURL(text, w = 240, h = 100, sample = '자막 미리보기') {
  const c = document.createElement('canvas');
  const dpr = 2;
  c.width = w * dpr;
  c.height = h * dpr;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, c.width, c.height);
  g.addColorStop(0, '#3b4a6b');
  g.addColorStop(1, '#5d4a6e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  const st = textStyleById(text.style);
  // 글자 크기가 썸네일 높이의 약 30%가 되도록 가상 화면 높이(Hv)를 정함
  const Hv = (c.height * 0.3) / (st.size || 0.05);
  const clip = {
    id: 'preview', start: 0, dur: 10, fadeIn: 0, fadeOut: 0, transform: { opacity: 1, rotation: 0 },
    text: {
      ...text,
      content: text.content || sample,
      anim: 'none',
      size: Math.min(text.size || 1, 1.2),
      x: (text.align || st.align) === 'left' ? 0.06 : 0.5,
      y: c.height / 2 / Hv,
    },
  };
  renderText(ctx, clip, 1, c.width, Hv);
  return c.toDataURL('image/png');
}
