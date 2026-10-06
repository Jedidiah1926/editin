// 스마트 도구: 무음 자동 컷, 음량 맞추기, 원클릭 보정, 자막 일괄 입력/SRT, 내보내기 전 점검

import {
  state, project, mutate, mediaRuntime, mediaById, clipEnd, clipsOnTrack, trackById, uid, defaultClip, round,
} from './store.js';
import { textStyleById } from './presets.js';
import { trackFor } from './ops.js';

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/**
 * 말소리가 있는 구간(소스 시간)을 찾음.
 * sensitivity 0~1: 높을수록 더 많이 잘라냄
 */
export function detectSpeech(clip, { sensitivity = 0.5, minSilence = 0.5, pad = 0.15 } = {}) {
  const rt = mediaRuntime.get(clip.mediaId);
  if (!rt?.peaks) return null;
  const rate = rt.peakRate;
  const s0 = clip.in;
  const s1 = clip.in + clip.dur * clip.speed;
  const i0 = Math.max(0, Math.floor(s0 * rate));
  const i1 = Math.min(rt.peaks.length, Math.ceil(s1 * rate));
  if (i1 - i0 < rate) return null;
  const db = new Float32Array(i1 - i0);
  for (let i = i0; i < i1; i++) db[i - i0] = 20 * Math.log10(rt.peaks[i] + 1e-7);
  const sorted = Float32Array.from(db).sort();
  const floor = percentile(sorted, 0.1);
  const loud = percentile(sorted, 0.95);
  if (loud - floor < 8) return null; // 뚜렷한 무음 없음
  const thr = floor + (loud - floor) * (0.12 + 0.33 * sensitivity);
  const minRun = Math.round(minSilence * rate);
  const keep = [];
  let runStart = null;
  let segStart = 0;
  const n = db.length;
  for (let i = 0; i <= n; i++) {
    const silent = i < n && db[i] < thr;
    if (silent && runStart === null) runStart = i;
    if (!silent && runStart !== null) {
      if (i - runStart >= minRun || (runStart === 0 && i - runStart >= minRun / 2) || (i === n && i - runStart >= minRun / 2)) {
        const cutA = runStart === 0 ? 0 : runStart + pad * rate;
        const cutB = i === n ? n : i - pad * rate;
        if (cutB > cutA) {
          if (cutA > segStart) keep.push([segStart, cutA]);
          segStart = cutB;
        }
      }
      runStart = null;
    }
  }
  if (segStart < n) keep.push([segStart, n]);
  // 너무 짧은 조각(잡음) 제거
  const out = keep
    .map(([a, b]) => [s0 + a / rate, Math.min(s1, s0 + b / rate)])
    .filter(([a, b]) => b - a >= 0.25);
  return out;
}

export function silenceCut(clipIds, opts) {
  let removed = 0;
  let cuts = 0;
  let skipped = 0;
  mutate('무음 구간 자동 컷', (p) => {
    const targets = p.clips.filter((c) => clipIds.includes(c.id) && (c.type === 'video' || c.type === 'audio'));
    // 뒤쪽 클립부터 처리해야 리플이 앞 클립 계산에 영향을 주지 않음
    targets.sort((a, b) => b.start - a.start);
    for (const c of targets) {
      const ranges = detectSpeech(c, opts);
      if (!ranges || !ranges.length) { skipped++; continue; }
      const kept = ranges.reduce((s, [a, b]) => s + (b - a) / c.speed, 0);
      const diff = c.dur - kept;
      if (diff < 0.2) { skipped++; continue; }
      const tr = trackById(c.trackId);
      const oldEnd = clipEnd(c);
      p.clips = p.clips.filter((x) => x.id !== c.id);
      let t = c.start;
      ranges.forEach(([a, b], i) => {
        const nc = JSON.parse(JSON.stringify(c));
        nc.id = uid('c');
        nc.in = round(a);
        nc.dur = round((b - a) / c.speed);
        nc.start = round(t);
        if (i > 0) { nc.transition = { type: 'none', dur: 0.5 }; nc.fadeIn = 0; }
        if (i < ranges.length - 1) nc.fadeOut = 0;
        t += nc.dur;
        p.clips.push(nc);
      });
      if (!tr.magnetic) for (const o of p.clips) if (o.trackId === c.trackId && o.start >= oldEnd - 1e-3) o.start -= diff;
      removed += diff;
      cuts += ranges.length - 1;
    }
  });
  return { removed, cuts, skipped };
}

/** 소리가 있는 클립들의 음량을 비슷하게 맞춤 */
export function normalizeLoudness(clipIds) {
  let n = 0;
  mutate('음량 고르게 맞추기', (p) => {
    for (const c of p.clips) {
      if (!clipIds.includes(c.id) || (c.type !== 'video' && c.type !== 'audio') || c.duck) continue;
      const rt = mediaRuntime.get(c.mediaId);
      if (!rt?.peaks) continue;
      const i0 = Math.floor(c.in * rt.peakRate);
      const i1 = Math.min(rt.peaks.length, Math.ceil((c.in + c.dur * c.speed) * rt.peakRate));
      const arr = Array.from(rt.peaks.subarray(i0, i1)).sort((a, b) => a - b);
      const level = percentile(arr, 0.9);
      if (level < 1e-4) continue;
      c.volume = round(Math.max(0.2, Math.min(3, 0.22 / level)));
      n++;
    }
  });
  return n;
}

export function autoEnhance(clipIds) {
  mutate('원클릭 보정', (p) => {
    for (const c of p.clips) {
      if (!clipIds.includes(c.id) || (c.type !== 'video' && c.type !== 'image')) continue;
      c.color.brightness = 6;
      c.color.contrast = 12;
      c.color.saturation = 15;
      c.color.vignette = Math.max(c.color.vignette, 12);
    }
  });
}

export function applyTransitionAll(type, dur = 0.5) {
  let n = 0;
  mutate('전환 효과 일괄 적용', (p) => {
    for (const tr of p.tracks.filter((t) => t.kind === 'video')) {
      const list = clipsOnTrack(tr.id);
      list.forEach((c, i) => {
        if (i === 0) return;
        const prev = list[i - 1];
        if (Math.abs(clipEnd(prev) - c.start) > 0.05) return;
        c.transition = { type, dur: Math.min(dur, c.dur / 2, prev.dur / 2) };
        n++;
      });
    }
  });
  return n;
}

/** 시작은 페이드 인, 끝은 페이드 아웃, 음악은 영상 길이에 맞춤 */
export function polishEnds() {
  mutate('시작·끝 자연스럽게', (p) => {
    const main = clipsOnTrack('v1');
    if (main.length) {
      main[0].fadeIn = Math.max(main[0].fadeIn, Math.min(0.6, main[0].dur / 3));
      const last = main[main.length - 1];
      last.fadeOut = Math.max(last.fadeOut, Math.min(1.2, last.dur / 3));
    }
    const videoEnd = p.clips.filter((c) => c.type !== 'audio' && c.type !== 'text').reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    for (const c of p.clips) {
      if (c.type !== 'audio' || !c.duck) continue;
      if (videoEnd > 0 && clipEnd(c) > videoEnd) c.dur = Math.max(0.5, videoEnd - c.start);
      c.fadeOut = Math.max(c.fadeOut, Math.min(2.5, c.dur / 3));
      c.fadeIn = Math.max(c.fadeIn, Math.min(1, c.dur / 4));
    }
  });
}

export function fitAll(fit) {
  mutate(fit === 'cover' ? '화면 꽉 채우기' : '전체 보이기', (p) => {
    for (const c of p.clips) if (c.type === 'video' || c.type === 'image') c.fit = fit;
  });
}

// ---------- 자막 ----------

/** 글자 수로 읽기 좋은 노출 시간 계산 (한국어 초당 약 7자) */
export function readingTime(text) {
  const n = [...text.replace(/\s/g, '')].length;
  return Math.max(1.2, Math.min(7, 0.6 + n / 7));
}

export function scriptToSubtitles(script, styleId, startAt) {
  const lines = script.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 0;
  const st = textStyleById(styleId);
  mutate(`자막 ${lines.length}줄 추가`, (p) => {
    let t = startAt;
    const tr = trackFor('text');
    for (const line of lines) {
      const dur = readingTime(line);
      const c = defaultClip('text', { start: round(t), dur: round(dur), trackId: tr.id, text: { content: line, style: st.id, size: 1, x: st.x, y: st.y, anim: st.anim } });
      // 같은 트랙에 겹치는 자막이 있으면 밀어냄
      p.clips.push(c);
      t += dur;
    }
    resolveTextOverlaps(p, tr.id);
  });
  return lines.length;
}

function resolveTextOverlaps(p, trackId) {
  const list = p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    if (list[i].start < clipEnd(prev)) list[i].start = round(clipEnd(prev));
  }
}

function parseTime(s) {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

export function importSRT(text, styleId = 'subtitle') {
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  const items = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const content = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '');
    if (content) items.push({ start: parseTime(a), end: parseTime(z), content });
  }
  if (!items.length) return 0;
  const st = textStyleById(styleId);
  mutate(`SRT 자막 ${items.length}개 불러오기`, (p) => {
    const tr = trackFor('text');
    for (const it of items) {
      p.clips.push(defaultClip('text', { start: it.start, dur: Math.max(0.2, it.end - it.start), trackId: tr.id, text: { content: it.content, style: st.id, size: 1, x: st.x, y: st.y, anim: 'none' } }));
    }
  });
  return items.length;
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

// ---------- 내보내기 전 점검 ----------

/** 초보자가 흔히 놓치는 문제를 찾아 한 번에 고칠 수 있게 함 */
export function runChecks() {
  const p = project();
  const issues = [];
  const visual = p.clips.filter((c) => c.type === 'video' || c.type === 'image');
  if (!p.clips.length) {
    issues.push({ level: 'error', msg: '타임라인이 비어 있어요. 영상이나 사진을 먼저 추가하세요.' });
    return issues;
  }
  if (!visual.length) issues.push({ level: 'warn', msg: '화면에 보일 영상이나 사진이 없어요. 검은 화면으로 내보내져요.' });

  // 검은 화면 구간
  const end = p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const covered = visual.map((c) => [c.start, clipEnd(c)]).sort((a, b) => a[0] - b[0]);
  let t = 0;
  let gaps = 0;
  for (const [a, b] of covered) {
    if (a - t > 0.1) gaps++;
    t = Math.max(t, b);
  }
  if (visual.length && end - t > 0.1) gaps++;
  if (gaps) {
    issues.push({
      level: 'warn',
      msg: `화면이 검게 나오는 빈 구간이 ${gaps}곳 있어요.`,
      fixLabel: '음악·자막 길이를 영상에 맞추기',
      fix: () => mutate('빈 구간 정리', (pp) => {
        const vEnd = visual.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
        for (const c of pp.clips) {
          if ((c.type === 'audio' || c.type === 'text') && clipEnd(c) > vEnd && c.start < vEnd) c.dur = vEnd - c.start;
        }
      }),
    });
  }

  // 자막 읽기 시간
  const fast = p.clips.filter((c) => c.type === 'text' && c.dur < readingTime(c.text.content) * 0.6);
  if (fast.length) {
    issues.push({
      level: 'warn',
      msg: `읽기엔 너무 빨리 지나가는 자막이 ${fast.length}개 있어요.`,
      fixLabel: '읽기 좋은 길이로 늘리기',
      fix: () => mutate('자막 길이 조정', (pp) => {
        for (const f of fast) {
          const c = pp.clips.find((x) => x.id === f.id);
          if (c) c.dur = round(readingTime(c.text.content));
        }
        for (const tr of pp.tracks.filter((x) => x.kind === 'text')) resolveTextOverlaps(pp, tr.id);
      }),
    });
  }
  const long = p.clips.filter((c) => c.type === 'text' && c.text.content.split('\n').some((l) => [...l].length > 28) && textStyleById(c.text.style).size < 0.08);
  if (long.length) issues.push({ level: 'info', msg: `한 줄이 긴 자막이 ${long.length}개 있어요. 휴대폰에서는 두 줄로 나누면 더 잘 읽혀요.` });

  // 화면 밖 텍스트
  const off = p.clips.filter((c) => c.type === 'text' && (c.text.x < 0.04 || c.text.x > 0.96 || c.text.y < 0.04 || c.text.y > 0.96));
  if (off.length) {
    issues.push({
      level: 'warn',
      msg: `화면 가장자리에 너무 붙은 글자가 ${off.length}개 있어요. 일부 기기에서 잘릴 수 있어요.`,
      fixLabel: '안전 영역 안으로 옮기기',
      fix: () => mutate('글자 위치 보정', (pp) => {
        for (const f of off) {
          const c = pp.clips.find((x) => x.id === f.id);
          if (c) { c.text.x = Math.min(0.92, Math.max(0.08, c.text.x)); c.text.y = Math.min(0.92, Math.max(0.08, c.text.y)); }
        }
      }),
    });
  }

  // 너무 큰 소리
  const loud = p.clips.filter((c) => (c.type === 'video' || c.type === 'audio') && c.volume > 1.6);
  if (loud.length) {
    issues.push({
      level: 'warn',
      msg: `볼륨을 많이 키운 클립이 ${loud.length}개 있어요. 소리가 찢어질 수 있어요.`,
      fixLabel: '볼륨 낮추기',
      fix: () => mutate('볼륨 조정', (pp) => { for (const c of pp.clips) if (c.volume > 1.6) c.volume = 1.5; }),
    });
  }

  // 배경음악 덕킹
  const hasVoice = p.clips.some((c) => c.type === 'video' && mediaById(c.mediaId)?.hasAudio && c.volume > 0);
  const music = p.clips.filter((c) => c.type === 'audio' && !c.duck && c.volume > 0.5);
  if (hasVoice && music.length) {
    issues.push({
      level: 'info',
      msg: '배경음악이 목소리를 덮을 수 있어요.',
      fixLabel: '목소리 나올 때 음악 자동으로 줄이기',
      fix: () => mutate('자동 볼륨(덕킹) 켜기', (pp) => { for (const m of music) { const c = pp.clips.find((x) => x.id === m.id); if (c) c.duck = true; } }),
    });
  }

  // 끝 처리
  const main = clipsOnTrack('v1');
  if (main.length && main[main.length - 1].fadeOut === 0) {
    issues.push({ level: 'info', msg: '마지막 장면이 뚝 끊겨요. 끝을 부드럽게 하면 완성도가 올라가요.', fixLabel: '시작·끝 부드럽게', fix: polishEnds });
  }

  // 해상도
  const lowRes = visual.filter((c) => {
    const m = mediaById(c.mediaId);
    return m && m.height && Math.min(m.width, m.height) < Math.min(p.width, p.height) * 0.5;
  });
  if (lowRes.length) issues.push({ level: 'info', msg: `해상도가 낮은 소스가 ${lowRes.length}개 있어 흐릿하게 보일 수 있어요.` });

  // 오프라인 미디어
  const offline = p.clips.filter((c) => c.mediaId && !mediaRuntime.get(c.mediaId));
  if (offline.length) issues.push({ level: 'error', msg: `원본 파일을 찾을 수 없는 클립이 ${offline.length}개 있어요. 같은 파일을 다시 불러와 주세요.` });

  return issues;
}

export { state };
