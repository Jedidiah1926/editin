// 재생 엔진: 시간축에 맞춰 미디어를 동기화하고 캔버스에 합성, 오디오는 WebAudio로 믹스

import {
  state, project, on, emit, mediaRuntime, mediaById, clipEnd, projectDuration, trackById, clipsOnTrack,
} from './store.js';
import { filterById } from './presets.js';
import { clamp, ease } from './ui.js';
import { renderText, fadeFactor } from './textrender.js';
import { visualLayout, hasCrop } from './geometry.js';

export { fadeFactor };

const PRELOAD = 0.8; // 다음 클립 미리 준비 (초)

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pools = new Map(); // mediaId → [element]
    this.assign = new Map(); // clipId → element
    this.images = new Map(); // mediaId → HTMLImageElement
    this.playing = false;
    this.rate = 1;
    this.dirty = true;
    this.waitFrames = 0;
    this.bounds = [];
    this.onEnded = null;
    this.stopAt = null;
    this.exporting = false;
    this.overlay = { safe: false };
    this.cropGhostId = null;
    this.hidden = h0();
    document.body.append(this.hidden);

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.audioCtx.createGain();
    this.master.connect(this.audioCtx.destination);
    this.recordDest = this.audioCtx.createMediaStreamDestination();
    this.master.connect(this.recordDest);
    this.meter = this.audioCtx.createAnalyser();
    this.meter.fftSize = 1024;
    this.master.connect(this.meter);
    this.meterBuf = new Float32Array(this.meter.fftSize);

    this.resize();
    on('project', () => { this.resize(); this.invalidate(); });
    on('time', () => { if (!this.playing) this.invalidate(); });
    on('selection', () => this.invalidate());
    on('media-analyzed', () => this.invalidate());
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  invalidate() { this.dirty = true; }

  resize(w, h) {
    const p = project();
    const W = w || p.width;
    const H = h || p.height;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      this.dirty = true;
    }
  }

  // ---------- 재생 제어 ----------

  play(rate = 1) {
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    const dur = projectDuration();
    if (dur <= 0) return;
    if (rate > 0 && state.time >= dur - 0.01) state.time = 0;
    this.rate = rate;
    this.playing = true;
    this.playStartT = state.time;
    this.playStartPerf = performance.now();
    emit('playstate', true);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.rate = 1;
    for (const el of this.assign.values()) if (!el.paused) el.pause();
    this.dirty = true;
    emit('playstate', false);
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    const was = this.playing;
    state.time = clamp(t, 0, Math.max(0, projectDuration()));
    if (was) {
      this.playStartT = state.time;
      this.playStartPerf = performance.now();
    }
    this.dirty = true;
    emit('time');
  }

  // ---------- 메인 루프 ----------

  loop(now) {
    requestAnimationFrame(this.loop);
    if (this.playing) {
      let t = this.playStartT + ((now - this.playStartPerf) / 1000) * this.rate;
      const end = this.stopAt ?? projectDuration();
      if (t >= end) {
        t = end;
        state.time = t;
        this.frame(t);
        this.pause();
        emit('time');
        const cb = this.onEnded;
        this.onEnded = null;
        cb?.();
        return;
      }
      if (t <= 0 && this.rate < 0) {
        state.time = 0;
        this.pause();
        emit('time');
        return;
      }
      state.time = t;
      emit('time');
      this.frame(t);
    } else if (this.dirty) {
      this.frame(state.time);
    }
  }

  frame(t) {
    const entries = this.activeEntries(t);
    this.sync(entries, t);
    const ready = this.isReady(entries);
    // 준비되지 않은 프레임은 그리지 않고 이전 화면 유지 (깜빡임 방지)
    if (!ready && this.waitFrames < 20) {
      this.waitFrames++;
      this.dirty = true;
      return;
    }
    this.waitFrames = 0;
    this.render(t);
    this.dirty = false;
  }

  // ---------- 활성 클립 계산 ----------

  activeEntries(t) {
    const p = project();
    const out = [];
    const seen = new Set();
    for (const c of p.clips) {
      const tr = trackById(c.trackId);
      if (!tr) continue;
      if (t >= c.start && t < clipEnd(c)) {
        out.push({ clip: c, src: srcTime(c, t), mode: 'play' });
        seen.add(c.id);
        // 전환 효과: 이전 클립의 마지막 프레임 유지
        if (c.transition && c.transition.type !== 'none' && c.transition.type !== 'fade' && t < c.start + c.transition.dur) {
          const prev = prevClip(c);
          if (prev && (prev.type === 'video' || prev.type === 'image')) {
            out.push({ clip: prev, src: prev.in + prev.dur * prev.speed - 0.04, mode: 'freeze' });
            seen.add(prev.id);
          }
        }
      }
    }
    if (this.playing && this.rate > 0) {
      for (const c of p.clips) {
        if (seen.has(c.id)) continue;
        if (c.start > t && c.start - t < PRELOAD) out.push({ clip: c, src: c.in, mode: 'prep' });
      }
    }
    return out;
  }

  // ---------- 미디어 요소 관리 ----------

  makeEl(m) {
    const rt = mediaRuntime.get(m.id);
    if (!rt) return null;
    const el = document.createElement(m.type === 'audio' ? 'audio' : 'video');
    el.preload = 'auto';
    el.playsInline = true;
    el.src = rt.url;
    el.addEventListener('seeked', () => { this.dirty = true; });
    el.addEventListener('loadeddata', () => { this.dirty = true; });
    try {
      const src = this.audioCtx.createMediaElementSource(el);
      el._gain = this.audioCtx.createGain();
      el._gain.gain.value = 0;
      src.connect(el._gain).connect(this.master);
    } catch {
      el.muted = true;
    }
    this.hidden.append(el);
    return el;
  }

  getEl(clip, srcT) {
    const m = mediaById(clip.mediaId);
    if (!m) return null;
    let pool = this.pools.get(m.id);
    if (!pool) this.pools.set(m.id, (pool = []));
    let best = null;
    let bestD = Infinity;
    for (const el of pool) {
      if (el._clip) continue;
      const d = Math.abs(el.currentTime - srcT);
      if (d < bestD) { best = el; bestD = d; }
    }
    if (!best) {
      best = this.makeEl(m);
      if (!best) return null;
      pool.push(best);
    }
    return best;
  }

  sync(entries, t) {
    const wanted = new Map();
    for (const e of entries) {
      if (e.clip.type === 'video' || e.clip.type === 'audio') wanted.set(e.clip.id, e);
    }
    for (const [id, el] of this.assign) {
      if (!wanted.has(id)) {
        if (!el.paused) el.pause();
        if (el._gain) el._gain.gain.setTargetAtTime(0, this.audioCtx.currentTime, 0.01);
        el._clip = null;
        this.assign.delete(id);
      }
    }
    const now = this.audioCtx.currentTime;
    for (const [id, e] of wanted) {
      let el = this.assign.get(id);
      if (!el) {
        el = this.getEl(e.clip, e.src);
        if (!el) continue;
        el._clip = id;
        this.assign.set(id, el);
        if (Math.abs(el.currentTime - e.src) > 0.02) el.currentTime = e.src;
      }
      const c = e.clip;
      if (e.mode === 'play' && this.playing && this.rate > 0) {
        el.playbackRate = clamp(c.speed * this.rate, 0.0625, 16);
        if (el.paused) {
          if (Math.abs(el.currentTime - e.src) > 0.08) el.currentTime = e.src;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - e.src) > 0.3 && !el.seeking) {
          el.currentTime = e.src;
        }
      } else {
        if (!el.paused) el.pause();
        const tol = e.mode === 'prep' ? 0.1 : 0.5 / project().fps;
        if (!el.seeking && Math.abs(el.currentTime - e.src) > tol) el.currentTime = e.src;
      }
      if (el._gain) {
        const g = e.mode === 'play' && this.playing && this.rate > 0 ? this.clipGain(c, t) : 0;
        el._gain.gain.setTargetAtTime(g, now, 0.015);
      }
    }
  }

  clipGain(c, t) {
    const tr = trackById(c.trackId);
    if (!tr || tr.muted) return 0;
    if (c.type === 'video') {
      const m = mediaById(c.mediaId);
      if (m && m.hasAudio === false) return 0;
    }
    let g = c.volume * fadeFactor(c, t - c.start);
    if (c.duck && voiceActive(t, c)) g *= 0.25;
    return g;
  }

  isReady(entries) {
    for (const e of entries) {
      if (e.clip.type !== 'video' || e.mode === 'prep') continue;
      const el = this.assign.get(e.clip.id);
      if (!el || el.error) continue;
      if (el.readyState < 2 || el.seeking) return false;
    }
    return true;
  }

  getImage(mediaId) {
    let img = this.images.get(mediaId);
    if (!img) {
      const rt = mediaRuntime.get(mediaId);
      if (!rt) return null;
      img = new Image();
      img.onload = () => { this.dirty = true; };
      img.src = rt.url;
      this.images.set(mediaId, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  /** 오디오 레벨 (dB) — 레벨 미터용 */
  level() {
    this.meter.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    for (const v of this.meterBuf) peak = Math.max(peak, Math.abs(v));
    return peak > 0 ? 20 * Math.log10(peak) : -100;
  }

  // ---------- 렌더링 ----------

  render(t) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    this.bounds = [];
    const tracks = project().tracks.filter((tr) => tr.kind !== 'audio' && !tr.hidden).slice().reverse();
    for (const tr of tracks) {
      const clips = clipsOnTrack(tr.id).filter((c) => t >= c.start && t < clipEnd(c));
      for (const c of clips) this.drawWithTransition(c, t, W, H);
    }
    ctx.restore();
    if (!this.exporting) this.drawOverlay(W, H);
  }

  drawWithTransition(c, t, W, H) {
    const tr = c.transition || { type: 'none' };
    const local = t - c.start;
    if (tr.type === 'none' || local >= tr.dur || c.type === 'text') {
      this.drawClip(c, t, W, H);
      return;
    }
    const p = ease(clamp(local / tr.dur, 0, 1));
    const prev = prevClip(c);
    const drawPrev = () => {
      if (prev && (prev.type === 'video' || prev.type === 'image')) this.drawClip(prev, clipEnd(prev) - 0.001, W, H, { frozen: true });
    };
    const ctx = this.ctx;
    switch (tr.type) {
      case 'fade':
        this.drawClip(c, t, W, H, { alpha: p });
        break;
      case 'dissolve':
        drawPrev();
        this.drawClip(c, t, W, H, { alpha: p });
        break;
      case 'slide':
        drawPrev();
        this.drawClip(c, t, W, H, { dx: (1 - p) * W });
        break;
      case 'zoom':
        drawPrev();
        this.drawClip(c, t, W, H, { alpha: p, scale: 1.25 - 0.25 * p });
        break;
      case 'wipe':
        drawPrev();
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W * p, H);
        ctx.clip();
        this.drawClip(c, t, W, H);
        ctx.restore();
        break;
      default:
        this.drawClip(c, t, W, H);
    }
  }

  drawClip(c, t, W, H, o = {}) {
    if (c.type === 'audio') return;
    if (c.type === 'text') { this.drawText(c, t, W, H, o); return; }
    let src = null;
    let sw = 0;
    let sh = 0;
    if (c.type === 'video') {
      const el = this.assign.get(c.id);
      if (!el || el.readyState < 2) return;
      src = el; sw = el.videoWidth; sh = el.videoHeight;
    } else if (c.type === 'image') {
      src = this.getImage(c.mediaId);
      if (!src) return;
      sw = src.naturalWidth; sh = src.naturalHeight;
    }
    if (!src || !sw || !sh) return;
    const ctx = this.ctx;
    const local = clamp(t - c.start, 0, c.dur);
    const tf = c.transform;
    const L = visualLayout(c, W, H, sw, sh, local, o);
    const alpha = tf.opacity * (o.frozen ? 1 : fadeFactor(c, local)) * (o.alpha ?? 1);
    if (alpha <= 0.001) return;
    const v = L.vis;
    if (c.fit === 'blurfill') this.drawBlurFill(src, L, W, H, alpha);
    ctx.save();
    ctx.translate(L.ax, L.ay);
    if (L.rot) ctx.rotate((L.rot * Math.PI) / 180);
    // 화면 자르기 중: 잘려 나갈 부분을 흐리게 보여줌
    if (this.cropGhostId === c.id && !this.exporting && hasCrop(c)) {
      ctx.globalAlpha = 0.28;
      ctx.drawImage(src, v.x - L.src.x * L.s, v.y - L.src.y * L.s, L.fullW, L.fullH);
    }
    ctx.globalAlpha = alpha;
    const f = buildFilter(c.color);
    if (f) ctx.filter = f;
    ctx.drawImage(src, L.src.x, L.src.y, L.src.w, L.src.h, v.x, v.y, v.w, v.h);
    ctx.filter = 'none';
    const col = c.color;
    if (col.temperature) {
      ctx.globalCompositeOperation = 'soft-light';
      const a = Math.abs(col.temperature) / 100 * 0.55;
      ctx.fillStyle = col.temperature > 0 ? `rgba(255,140,30,${a})` : `rgba(30,120,255,${a})`;
      ctx.fillRect(v.x, v.y, v.w, v.h);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (col.vignette) {
      const r = Math.hypot(v.w, v.h) / 2;
      const g = ctx.createRadialGradient(v.x + v.w / 2, v.y + v.h / 2, r * 0.35, v.x + v.w / 2, v.y + v.h / 2, r);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${(col.vignette / 100) * 0.85})`);
      ctx.fillStyle = g;
      ctx.fillRect(v.x, v.y, v.w, v.h);
    }
    ctx.restore();
    if (!o.frozen) this.bounds.push({ id: c.id, cx: L.cx, cy: L.cy, w: v.w, h: v.h, rot: L.rot, kind: 'visual', sw, sh });
  }

  /** 세로 화면용: 같은 영상을 크게 흐리게 깔아 위아래 빈 곳을 채움 (작게 그렸다 키워서 가볍게 흐림) */
  drawBlurFill(src, L, W, H, alpha) {
    if (!this.blurCanvas) this.blurCanvas = document.createElement('canvas');
    const bc = this.blurCanvas;
    const bw = Math.max(16, Math.round(W / 12));
    const bh = Math.max(16, Math.round(H / 12));
    if (bc.width !== bw || bc.height !== bh) { bc.width = bw; bc.height = bh; }
    const bctx = bc.getContext('2d');
    const cs = Math.max(bw / L.src.w, bh / L.src.h) * 1.1;
    const dw = L.src.w * cs;
    const dh = L.src.h * cs;
    bctx.filter = 'blur(2px) brightness(0.62) saturate(1.25)';
    bctx.drawImage(src, L.src.x, L.src.y, L.src.w, L.src.h, (bw - dw) / 2, (bh - dh) / 2, dw, dh);
    bctx.filter = 'none';
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bc, 0, 0, W, H);
    ctx.restore();
  }

  drawText(c, t, W, H, o = {}) {
    const b = renderText(this.ctx, c, t, W, H, o);
    if (b) this.bounds.push(b);
  }

  drawOverlay(W, H) {
    const ctx = this.ctx;
    if (this.overlay.safe) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([W * 0.01, W * 0.01]);
      ctx.lineWidth = Math.max(1, W / 800);
      ctx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9);
      ctx.strokeRect(W * 0.1, H * 0.1, W * 0.8, H * 0.8);
      ctx.beginPath();
      ctx.moveTo(W / 3, 0); ctx.lineTo(W / 3, H);
      ctx.moveTo((2 * W) / 3, 0); ctx.lineTo((2 * W) / 3, H);
      ctx.moveTo(0, H / 3); ctx.lineTo(W, H / 3);
      ctx.moveTo(0, (2 * H) / 3); ctx.lineTo(W, (2 * H) / 3);
      ctx.stroke();
      ctx.restore();
    }
  }

  hitTest(x, y) {
    for (let i = this.bounds.length - 1; i >= 0; i--) {
      const b = this.bounds[i];
      const a = (-b.rot * Math.PI) / 180;
      const dx = x - b.cx;
      const dy = y - b.cy;
      const rx = dx * Math.cos(a) - dy * Math.sin(a);
      const ry = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(rx) <= b.w / 2 && Math.abs(ry) <= b.h / 2) return b;
    }
    return null;
  }

  /** 현재 화면 스냅샷 (필터 미리보기용) */
  snapshot(width = 160) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = Math.round((width * this.canvas.height) / this.canvas.width);
    c.getContext('2d').drawImage(this.canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  }

  /** 삭제된 클립의 요소 정리 */
  gc() {
    const ids = new Set(project().clips.map((c) => c.id));
    for (const [id, el] of this.assign) {
      if (!ids.has(id)) { el.pause(); el._clip = null; this.assign.delete(id); }
    }
  }
}

function h0() {
  const d = document.createElement('div');
  d.setAttribute('aria-hidden', 'true');
  Object.assign(d.style, { position: 'fixed', width: '2px', height: '2px', overflow: 'hidden', opacity: '0', pointerEvents: 'none', left: '0', top: '0' });
  return d;
}

export function srcTime(c, t) {
  return c.in + (t - c.start) * c.speed;
}

export function prevClip(c) {
  const list = clipsOnTrack(c.trackId);
  let best = null;
  for (const o of list) {
    if (o.id === c.id) continue;
    const e = clipEnd(o);
    if (Math.abs(e - c.start) < 0.05) best = o;
  }
  return best;
}


/** 덕킹: 다른 영상/효과음에서 소리가 날 때 배경음악을 줄임 */
function voiceActive(t, self) {
  for (const c of project().clips) {
    if (c.id === self.id || c.duck) continue;
    if (c.type !== 'video' && c.type !== 'audio') continue;
    if (t < c.start || t >= clipEnd(c) || c.volume <= 0.01) continue;
    const m = mediaById(c.mediaId);
    if (!m || m.hasAudio === false) continue;
    const tr = trackById(c.trackId);
    if (tr?.muted) continue;
    const rt = mediaRuntime.get(c.mediaId);
    if (rt?.peaks) {
      const i = Math.floor(srcTime(c, t) * rt.peakRate);
      const v = rt.peaks[i] || 0;
      if (v < (rt.peakMax || 1) * 0.08) continue;
    }
    return true;
  }
  return false;
}

export function buildFilter(col) {
  if (!col) return '';
  const parts = [];
  const f = filterById(col.filter);
  if (f.css) parts.push(f.css);
  if (col.brightness) parts.push(`brightness(${1 + col.brightness / 200})`);
  if (col.contrast) parts.push(`contrast(${1 + col.contrast / 150})`);
  if (col.saturation) parts.push(`saturate(${Math.max(0, 1 + col.saturation / 100)})`);
  return parts.join(' ');
}


