// 자막: 자동 자막(음성 인식), 줄 나누기, 강조 구간 판별, 일반/강조 디자인 적용, 대본·SRT

import {
  project, mutate, mediaRuntime, mediaById, clipEnd, defaultClip, round, trackById, uid,
} from './store.js';
import { applyRef } from './templates.js';
import { trackFor } from './ops.js';

export const ASR_MODELS = [
  { id: 'onnx-community/whisper-base', name: '빠르게', desc: '약 80MB · 빠르지만 가끔 틀려요' },
  { id: 'onnx-community/whisper-small', name: '정확하게', desc: '약 250MB · 느리지만 더 정확해요' },
];
export const ASR_LANGS = [['korean', '한국어'], ['english', '영어'], ['japanese', '일본어'], ['auto', '자동 감지']];

const SR = 16000;

/** 한국어 기준 읽기 좋은 노출 시간 (초당 약 7자) */
export function readingTime(text) {
  const n = [...text.replace(/\s/g, '')].length;
  return Math.max(1.2, Math.min(7, 0.6 + n / 7));
}

// ---------- 음성 인식 ----------

let worker = null;
let jobId = 0;
let pendingReject = null;

/** 진행 중인 받아쓰기 중단 */
export function cancelTranscription() {
  if (worker) { worker.terminate(); worker = null; }
  pendingReject?.(new Error('cancelled'));
  pendingReject = null;
}

function workerTranscribe(audio, { model, language, onStatus }) {
  if (!worker) worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    pendingReject = reject;
    const onMsg = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'status' || m.type === 'progress') onStatus?.(m);
      else if (m.type === 'result') { worker.removeEventListener('message', onMsg); resolve(m.segments); }
      else if (m.type === 'error') { worker.removeEventListener('message', onMsg); reject(new Error(m.message)); }
    };
    const onErr = (e) => { worker.removeEventListener('error', onErr); reject(new Error(e.message || '음성 인식 엔진을 불러오지 못했어요')); };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    worker.postMessage({ type: 'run', id, audio, model, language }, [audio.buffer]);
  });
}

let transcriber = workerTranscribe;
/** 테스트·다른 엔진 연결용 */
export function setTranscriber(fn) { transcriber = fn || workerTranscribe; }

async function decode16k(mediaId) {
  const rt = mediaRuntime.get(mediaId);
  if (!rt?.file) throw new Error('원본 파일을 찾을 수 없어요');
  const buf = await rt.file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, SR, SR);
  const ab = await ctx.decodeAudioData(buf);
  const out = new Float32Array(ab.length);
  for (let ch = 0; ch < ab.numberOfChannels; ch++) {
    const d = ab.getChannelData(ch);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / ab.numberOfChannels;
  }
  return out;
}

export function mergeRanges(ranges, gap = 1.5) {
  const s = ranges.map((r) => [...r]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + gap) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

const srcRange = (c) => [c.in, c.in + c.dur * c.speed];

/**
 * 클립들이 쓰는 원본 구간을 받아쓰기. 같은 원본은 한 번만 처리하고 결과를 캐시.
 * 반환: Map(mediaId → [{text, start, end}] 원본 시간 기준)
 */
export async function transcribeClips(clips, { model, language, onStatus }) {
  const byMedia = new Map();
  for (const c of clips) {
    if (!byMedia.has(c.mediaId)) byMedia.set(c.mediaId, []);
    byMedia.get(c.mediaId).push(srcRange(c));
  }
  const key = `${model}|${language}`;
  const jobs = [];
  for (const [mid, ranges] of byMedia) {
    const rt = mediaRuntime.get(mid);
    if (!rt) continue;
    if (!rt.asr || rt.asr.key !== key) rt.asr = { key, ranges: [], segments: [] };
    const m = mediaById(mid);
    const needed = mergeRanges(ranges.map(([a, b]) => [Math.max(0, a - 0.3), Math.min(m?.duration || b, b + 0.3)]));
    const missing = needed.filter(([a, b]) => !rt.asr.ranges.some(([x, y]) => x <= a + 0.01 && y >= b - 0.01));
    for (const r of missing) jobs.push({ mid, rt, r });
  }
  const total = jobs.reduce((s, j) => s + (j.r[1] - j.r[0]), 0);
  let done = 0;
  const audioCache = new Map();
  for (const j of jobs) {
    if (!audioCache.has(j.mid)) audioCache.set(j.mid, await decode16k(j.mid));
    const full = audioCache.get(j.mid);
    const slice = full.slice(Math.floor(j.r[0] * SR), Math.ceil(j.r[1] * SR));
    const len = j.r[1] - j.r[0];
    const segs = await transcriber(slice, {
      model,
      language,
      onStatus: (s) => {
        if (s.type === 'progress') onStatus?.({ stage: 'transcribe', progress: (done + (len * s.done) / Math.max(1, s.total)) / Math.max(0.01, total) });
        else onStatus?.(s);
      },
    });
    for (const s of segs) j.rt.asr.segments.push({ text: s.text, start: s.start + j.r[0], end: s.end + j.r[0] });
    j.rt.asr.ranges.push(j.r);
    done += len;
    onStatus?.({ stage: 'transcribe', progress: done / Math.max(0.01, total) });
  }
  const out = new Map();
  for (const mid of byMedia.keys()) {
    const rt = mediaRuntime.get(mid);
    if (rt?.asr) out.set(mid, rt.asr.segments.slice().sort((a, b) => a.start - b.start));
  }
  return out;
}

// ---------- 받아쓴 문장 → 자막 줄 ----------

const NOISE = /^[[(（【♪*].*[\])）】♪*]$|^[♪~\s.]+$/;
const HALLUCINATIONS = ['시청해주셔서 감사합니다', '구독과 좋아요', 'MBC 뉴스', '자막 제공', 'Thank you for watching'];

export function cleanText(t, { dropPeriod = true } = {}) {
  let s = String(t).replace(/\s+/g, ' ').trim();
  if (dropPeriod) s = s.replace(/[.。]+$/u, '').replace(/\.(\s)/g, '$1');
  return s;
}

/** 한 줄 최대 글자 수에 맞게 나누기 (문장부호·띄어쓰기 기준) */
export function splitLine(text, maxChars) {
  const words = text.split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const chunks = [...w].length > maxChars ? [...w].reduce((acc, ch) => {
      if (!acc.length || [...acc[acc.length - 1]].length >= maxChars) acc.push('');
      acc[acc.length - 1] += ch;
      return acc;
    }, []) : [w];
    for (const piece of chunks) {
      const next = cur ? `${cur} ${piece}` : piece;
      if ([...next].length > maxChars && cur) { lines.push(cur); cur = piece; } else cur = next;
      // 쉼표·마침표 뒤에서 자연스럽게 끊기
      if (/[,，?!？！]$/.test(cur) && [...cur].length >= maxChars * 0.55) { lines.push(cur); cur = ''; }
    }
  }
  if (cur) lines.push(cur);
  // 마지막 줄이 너무 짧으면 앞 줄에 붙이기
  if (lines.length > 1) {
    const last = lines[lines.length - 1];
    const prev = lines[lines.length - 2];
    if ([...last].length <= 3 && [...prev].length + [...last].length + 1 <= maxChars * 1.25) {
      lines.splice(lines.length - 2, 2, `${prev} ${last}`);
    }
  }
  return lines;
}

/** 원본 시간 기준 문장들을 타임라인 자막(cue)으로 변환 */
export function segmentsToCues(clips, segsByMedia, { maxChars = 18, dropPeriod = true } = {}) {
  const pieces = [];
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    const segs = segsByMedia.get(c.mediaId) || [];
    const [s0, s1] = srcRange(c);
    for (const seg of segs) {
      const a = Math.max(seg.start, s0);
      const b = Math.min(seg.end, s1);
      if (b - a < 0.15) continue;
      let text = cleanText(seg.text, { dropPeriod });
      if (!text || NOISE.test(text)) continue;
      // 컷 편집으로 문장 일부만 남았으면 남은 비율만큼 글자를 자름
      const segDur = Math.max(0.01, seg.end - seg.start);
      if (a > seg.start + 0.1 || b < seg.end - 0.1) {
        const chars = [...text];
        const i0 = Math.round(((a - seg.start) / segDur) * chars.length);
        const i1 = Math.round(((b - seg.start) / segDur) * chars.length);
        text = snapWords(chars, i0, i1);
        if (!text) continue;
      }
      pieces.push({ text, start: c.start + (a - c.in) / c.speed, end: c.start + (b - c.in) / c.speed });
    }
  }
  const cues = [];
  for (const p of pieces) {
    const lines = splitLine(p.text, maxChars);
    const total = lines.reduce((s, l) => s + [...l.replace(/\s/g, '')].length, 0) || 1;
    let t = p.start;
    for (const l of lines) {
      const d = ((p.end - p.start) * [...l.replace(/\s/g, '')].length) / total;
      cues.push({ text: l, start: t, end: t + d });
      t += d;
    }
  }
  // 정리: 겹침 제거, 너무 짧은 자막 보정, 짧은 틈은 메워 깜빡임 방지, 반복 환각 제거
  cues.sort((a, b) => a.start - b.start);
  const out = [];
  for (const q of cues) {
    const prev = out[out.length - 1];
    if (prev && prev.text === q.text && q.start - prev.end < 1.5) { prev.end = Math.max(prev.end, q.end); continue; }
    if (HALLUCINATIONS.some((h) => q.text.includes(h)) && q.end - q.start < 4) {
      // 소리가 거의 없는 구간에서 나온 흔한 환각 문장은 버림
      if (voiceLevelDb(q.start, q.end) < -40) continue;
    }
    if (prev && q.start < prev.end) q.start = prev.end;
    if (q.end - q.start < 0.5) q.end = q.start + 0.5;
    out.push(q);
  }
  for (let i = 0; i < out.length - 1; i++) {
    const gap = out[i + 1].start - out[i].end;
    if (gap > 0 && gap < 0.35) out[i].end = out[i + 1].start;
    if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start;
  }
  return out.filter((q) => q.end - q.start >= 0.2).map((q) => ({ ...q, start: round(q.start), end: round(q.end) }));
}

/** 글자 위치 [i0, i1)를 가장 가까운 띄어쓰기 경계로 옮겨 단어가 잘리지 않게 함 */
function snapWords(chars, i0, i1) {
  const n = chars.length;
  const isEdge = (i) => i <= 0 || i >= n || chars[i] === ' ' || chars[i - 1] === ' ';
  const nearest = (i) => {
    i = Math.max(0, Math.min(n, i));
    for (let d = 0; d <= n; d++) {
      if (isEdge(i - d)) return Math.max(0, i - d);
      if (isEdge(i + d)) return Math.min(n, i + d);
    }
    return i;
  };
  const a = nearest(i0);
  const b = nearest(i1);
  return b > a ? chars.slice(a, b).join('').trim() : '';
}

// ---------- 강조 구간 판별 ----------

/** 타임라인 [t0, t1] 구간의 목소리 크기(dB). 배경음악(덕킹)은 제외 */
export function voiceLevelDb(t0, t1) {
  let best = -100;
  for (const c of project().clips) {
    if ((c.type !== 'video' && c.type !== 'audio') || c.duck || c.volume <= 0) continue;
    if (trackById(c.trackId)?.muted) continue;
    const a = Math.max(t0, c.start);
    const b = Math.min(t1, clipEnd(c));
    if (b - a < 0.05) continue;
    const rt = mediaRuntime.get(c.mediaId);
    if (!rt?.peaks) continue;
    const i0 = Math.floor((c.in + (a - c.start) * c.speed) * rt.peakRate);
    const i1 = Math.ceil((c.in + (b - c.start) * c.speed) * rt.peakRate);
    let sum = 0;
    let n = 0;
    for (let i = i0; i < i1 && i < rt.peaks.length; i++) { sum += rt.peaks[i] ** 2; n++; }
    if (!n) continue;
    const db = 20 * Math.log10(Math.sqrt(sum / n) * c.volume + 1e-7);
    if (db > best) best = db;
  }
  return best;
}

export function parseKeywords(s) {
  return String(s || '').split(/[,，\n]/).map((k) => k.trim()).filter(Boolean);
}

/**
 * 각 자막({text,start,end})이 강조 대상인지 판별하고 이유를 함께 반환
 * rules: { markers, loud, exclaim, keywords, loudDb }
 */
export function detectHighlights(cues, rules) {
  const p = project();
  const kws = parseKeywords(rules.keywords);
  const levels = rules.loud ? cues.map((q) => voiceLevelDb(q.start, q.end)) : [];
  const valid = levels.filter((v) => v > -90).sort((a, b) => a - b);
  const median = valid.length ? valid[Math.floor(valid.length / 2)] : -100;
  const loudBy = rules.loudDb ?? 5;
  return cues.map((q, i) => {
    const why = [];
    if (rules.markers && p.markers.some((m) => m.t >= q.start - 0.15 && m.t <= q.end + 0.15)) why.push('마커');
    if (rules.loud && valid.length >= 3 && levels[i] > -90 && levels[i] >= median + loudBy) why.push('큰 목소리');
    if (rules.exclaim && /[!！]/.test(q.text)) why.push('느낌표');
    const kw = kws.find((k) => q.text.includes(k));
    if (kw) why.push(`'${kw}'`);
    return why;
  });
}

// ---------- 디자인 적용 ----------

/** 자막 디자인(일반/강조)을 역할(role)이 있는 모든 자막에 다시 적용 */
export function applyTheme(label = '자막 디자인 적용') {
  let n = 0;
  mutate(label, (p) => {
    const th = p.subtitleTheme;
    for (const c of p.clips) {
      if (c.type !== 'text' || !c.text.role) continue;
      applyRef(c.text, c.text.role === 'highlight' ? th.highlight : th.normal);
      n++;
    }
  });
  return n;
}

/** 규칙으로 강조 자막을 다시 고르고 디자인 적용 */
export function reclassify() {
  const subs = project().clips.filter((c) => c.type === 'text' && c.text.role).sort((a, b) => a.start - b.start);
  const why = detectHighlights(subs.map((c) => ({ text: c.text.content, start: c.start, end: clipEnd(c) })), project().subtitleTheme.rules);
  const roleById = new Map(subs.map((c, i) => [c.id, why[i].length ? 'highlight' : 'normal']));
  let hl = 0;
  mutate('강조 자막 다시 고르기', (p) => {
    const th = p.subtitleTheme;
    for (const c of p.clips) {
      if (!roleById.has(c.id)) continue;
      c.text.role = roleById.get(c.id);
      if (c.text.role === 'highlight') hl++;
      applyRef(c.text, c.text.role === 'highlight' ? th.highlight : th.normal);
    }
  });
  return { total: subs.length, highlights: hl };
}

export function setClipRole(ids, role) {
  mutate(role === 'highlight' ? '강조 자막으로 바꾸기' : '일반 자막으로 바꾸기', (p) => {
    const th = p.subtitleTheme;
    for (const c of p.clips) {
      if (!ids.includes(c.id) || c.type !== 'text') continue;
      c.text.role = role;
      applyRef(c.text, role === 'highlight' ? th.highlight : th.normal);
    }
  });
}

/** 자막을 놓을 트랙: 기본 자막 트랙에 제목 등 다른 글자가 겹치면 별도 트랙 */
function subtitleTrack(p, cues, replaceAuto) {
  const base = trackFor('text');
  const conflicts = (tid) => p.clips.some((c) => c.trackId === tid && c.type === 'text' && !(replaceAuto && c.text.auto) && !c.text.role
    && cues.some((q) => c.start < q.end && clipEnd(c) > q.start));
  if (!conflicts(base.id)) return base;
  let t = p.tracks.find((x) => x.kind === 'text' && x.subtitles);
  if (!t) {
    t = { id: uid('t'), kind: 'text', name: '자막 2', subtitles: true };
    p.tracks.splice(p.tracks.indexOf(base), 0, t);
  }
  return t;
}

/** cue 목록을 자막 클립으로 추가 (역할 판별 + 디자인 적용) */
export function addCues(cues, { label, auto = false, replaceRange = null }) {
  const p0 = project();
  const why = detectHighlights(cues, p0.subtitleTheme.rules);
  let hl = 0;
  mutate(label, (p) => {
    if (replaceRange) {
      const [a, b] = replaceRange;
      p.clips = p.clips.filter((c) => !(c.type === 'text' && c.text.auto && c.start < b && clipEnd(c) > a));
    }
    const tr = subtitleTrack(p, cues, !!replaceRange);
    const th = p.subtitleTheme;
    cues.forEach((q, i) => {
      const role = why[i].length ? 'highlight' : 'normal';
      if (role === 'highlight') hl++;
      const c = defaultClip('text', {
        start: q.start, dur: Math.max(0.2, q.end - q.start), trackId: tr.id,
        text: { content: q.text, role, auto, style: 'subtitle', size: 1 },
      });
      applyRef(c.text, role === 'highlight' ? th.highlight : th.normal);
      p.clips.push(c);
    });
    // 같은 트랙 안에서 겹치지 않게
    const list = p.clips.filter((c) => c.trackId === tr.id).sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) if (list[i].start < clipEnd(list[i - 1])) list[i].start = round(clipEnd(list[i - 1]));
  });
  return { count: cues.length, highlights: hl };
}

/** 자동 자막 전체 흐름 */
export async function autoSubtitles(clipIds, opts, onStatus) {
  const clips = project().clips.filter((c) => clipIds.includes(c.id) && (c.type === 'video' || c.type === 'audio') && mediaRuntime.get(c.mediaId));
  if (!clips.length) throw new Error('받아쓸 영상이 없어요');
  const segs = await transcribeClips(clips, { model: opts.model, language: opts.language, onStatus });
  const cues = segmentsToCues(clips, segs, { maxChars: opts.maxChars, dropPeriod: opts.dropPeriod });
  if (!cues.length) return { count: 0, highlights: 0 };
  const a = Math.min(...clips.map((c) => c.start));
  const b = Math.max(...clips.map(clipEnd));
  return addCues(cues, { label: `자동 자막 ${cues.length}개`, auto: true, replaceRange: opts.replace ? [a, b] : null });
}

// ---------- 대본 · SRT ----------

export function scriptToSubtitles(script, startAt) {
  const lines = script.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  let t = startAt;
  const cues = lines.map((text) => {
    const d = readingTime(text);
    const q = { text, start: round(t), end: round(t + d) };
    t += d;
    return q;
  });
  return addCues(cues, { label: `자막 ${lines.length}줄 추가` });
}

function parseTime(s) {
  const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +`0.${m[4]}`;
}

export function importSRT(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const content = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '');
    if (content) cues.push({ text: content, start: parseTime(a), end: Math.max(parseTime(a) + 0.2, parseTime(z)) });
  }
  if (!cues.length) return null;
  return addCues(cues, { label: `SRT 자막 ${cues.length}개 불러오기` });
}

export function exportSRT() {
  const texts = project().clips.filter((c) => c.type === 'text').sort((a, b) => a.start - b.start);
  const f = (t) => {
    const ms = Math.round(t * 1000);
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  return texts.map((c, i) => `${i + 1}\n${f(c.start)} --> ${f(clipEnd(c))}\n${c.text.content}\n`).join('\n');
}
