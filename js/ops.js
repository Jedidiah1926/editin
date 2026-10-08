// 편집 동작: 추가, 자르기, 삭제, 복제, 붙여넣기 등 (모두 실행 취소 가능)

import {
  state, mutate, project, defaultClip, clipEnd, clipsOnTrack, trackById, mediaById, uid, setSelection,
  maxDurFor, round, emit,
} from './store.js';
import { textStyleById } from './presets.js';
import { defaultDuration } from './media.js';
import { applyRef } from './templates.js';

export function trackFor(kind, preferId) {
  const p = project();
  if (preferId) {
    const t = trackById(preferId);
    if (t && t.kind === kind) return t;
  }
  if (kind === 'video') return p.tracks.find((t) => t.id === 'v1') || p.tracks.find((t) => t.kind === 'video');
  return p.tracks.find((t) => t.kind === kind);
}

export const kindForMedia = (m) => (m.type === 'audio' ? 'audio' : 'video');

/** 트랙에서 [start, start+dur] 구간이 비어 있는지 */
function isFree(trackId, start, dur, ignoreId) {
  return !project().clips.some((c) => c.trackId === trackId && c.id !== ignoreId && c.start < start + dur - 1e-3 && clipEnd(c) > start + 1e-3);
}

/** 겹치지 않는 트랙 찾기 (없으면 새 트랙) */
function findFreeTrack(p, kind, start, dur, preferId) {
  const first = trackFor(kind, preferId);
  if (first && (first.magnetic || isFree(first.id, start, dur))) return first;
  for (const t of p.tracks) if (t.kind === kind && !t.magnetic && !t.locked && isFree(t.id, start, dur)) return t;
  return addTrack(p, kind);
}

export function addTrack(p, kind) {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1;
  const names = { video: '영상', text: '자막', audio: '오디오' };
  const t = { id: uid('t'), kind, name: `${names[kind]} ${n}` };
  // 같은 종류 트랙들 위(오디오는 아래)에 추가
  if (kind === 'audio') p.tracks.push(t);
  else {
    const idx = p.tracks.findIndex((x) => x.kind === kind);
    p.tracks.splice(Math.max(0, idx), 0, t);
  }
  return t;
}

/** 미디어를 타임라인에 추가. at 생략 시 메인 트랙 끝(자석) 또는 재생 위치 */
export function addMediaClip(mediaId, opts = {}) {
  const m = mediaById(mediaId);
  if (!m) return null;
  const kind = kindForMedia(m);
  let created = null;
  mutate(`'${m.name}' 추가`, (p) => {
    const c = defaultClip(m.type, { mediaId: m.id, dur: defaultDuration(m) });
    if (m.type === 'image') c.motion = state.mode === 'easy' ? 'zoomIn' : 'none';
    const pa = p.width / p.height;
    if (m.width && m.height && Math.abs(m.width / m.height - pa) < 0.08) c.fit = 'cover';
    // 심플 모드 숏폼: 가로 영상도 세로 화면을 꽉 채우게 (가운데 기준으로 잘림)
    if (state.mode === 'easy' && p.height > p.width && m.width > m.height && m.type !== 'audio') c.fit = 'cover';
    const tr = opts.trackId ? trackFor(kind, opts.trackId) : trackFor(kind);
    let start;
    if (opts.at != null) start = opts.at;
    else if (tr.magnetic) start = clipsOnTrack(tr.id).reduce((e, x) => Math.max(e, clipEnd(x)), 0);
    else start = state.time;
    // overlay: 메인 레이어가 아닌 빈 영상 레이어에 (없으면 새로 만듦)
    const overlayId = p.tracks.find((t) => t.kind === kind && !t.magnetic)?.id;
    const target = opts.overlay
      ? (overlayId ? findFreeTrack(p, kind, start, c.dur, overlayId) : addTrack(p, kind))
      : tr.magnetic && opts.at != null ? tr : (opts.trackId ? tr : findFreeTrack(p, kind, start, c.dur, tr.id));
    c.trackId = target.id;
    if (target.magnetic && opts.at != null) {
      // 자석 트랙: 놓은 위치의 클립 앞/뒤에 끼워 넣기
      const list = clipsOnTrack(target.id);
      let insertAt = list.reduce((e, x) => Math.max(e, clipEnd(x)), 0);
      for (const x of list) {
        if (start < x.start + x.dur / 2) { insertAt = x.start; break; }
      }
      for (const x of list) if (x.start >= insertAt - 1e-3) x.start += c.dur;
      c.start = insertAt;
    } else c.start = start;
    if (m.type === 'audio' && target.id === 'a1') {
      c.duck = true;
      c.volume = 0.6;
      c.fadeIn = 1;
      c.fadeOut = 2;
    }
    p.clips.push(c);
    created = c;
  });
  if (created) setSelection([created.id]);
  return created;
}

export function addTextClip(styleId, opts = {}) {
  const st = textStyleById(styleId);
  let created = null;
  mutate('텍스트 추가', (p) => {
    const dur = opts.dur || 3;
    const start = opts.at ?? state.time;
    const c = defaultClip('text', {
      dur,
      start,
      text: { content: opts.content || (st.id === 'lower' ? '이름 · 소개' : st.id === 'title' ? '제목을 입력하세요' : '여기에 내용을 입력하세요'), style: st.id, size: 1, x: st.x, y: st.y, anim: st.anim },
    });
    if (opts.ref) applyRef(c.text, opts.ref);
    const tr = findFreeTrack(p, 'text', start, dur, opts.trackId);
    c.trackId = tr.id;
    p.clips.push(c);
    created = c;
  });
  if (created) setSelection([created.id]);
  return created;
}

/** 클립을 t 위치에서 둘로 나눔. 새로 생긴 오른쪽 클립 반환 */
function splitClipAt(p, c, t) {
  if (t <= c.start + 0.03 || t >= clipEnd(c) - 0.03) return null;
  const left = t - c.start;
  const right = JSON.parse(JSON.stringify(c));
  right.id = uid('c');
  right.start = t;
  right.dur = c.dur - left;
  right.in = c.in + left * c.speed;
  right.transition = { type: 'none', dur: c.transition?.dur || 0.5 };
  right.fadeIn = 0;
  c.dur = left;
  c.fadeOut = 0;
  p.clips.push(right);
  return right;
}

/** 재생 위치에서 자르기: 선택된 클립 우선, 없으면 재생 위치에 걸친 모든 클립 */
export function splitAtPlayhead() {
  const t = state.time;
  const sel = project().clips.filter((c) => state.selection.has(c.id) && c.start < t && clipEnd(c) > t);
  const targets = sel.length ? sel : project().clips.filter((c) => c.start < t && clipEnd(c) > t && !trackById(c.trackId)?.locked);
  if (!targets.length) return 0;
  const ids = targets.map((c) => c.id);
  let n = 0;
  const newIds = [];
  mutate('자르기', (p) => {
    for (const id of ids) {
      const c = p.clips.find((x) => x.id === id);
      const r = splitClipAt(p, c, t);
      if (r) { n++; newIds.push(r.id); }
    }
  });
  if (n && sel.length) setSelection(newIds);
  return n;
}

export function deleteClips(ids, ripple = false) {
  if (!ids.length) return;
  mutate(ids.length > 1 ? `클립 ${ids.length}개 삭제` : '클립 삭제', (p) => {
    const removed = p.clips.filter((c) => ids.includes(c.id));
    p.clips = p.clips.filter((c) => !ids.includes(c.id));
    if (ripple) {
      // 같은 트랙의 뒤쪽 클립들을 당김 (뒤에서부터 처리)
      removed.sort((a, b) => b.start - a.start);
      for (const r of removed) {
        for (const c of p.clips) if (c.trackId === r.trackId && c.start >= clipEnd(r) - 1e-3) c.start -= r.dur;
      }
    }
  });
  setSelection([]);
}

/** Q/W: 재생 위치 기준 앞부분/뒷부분 잘라내기 */
export function trimToPlayhead(side) {
  const t = state.time;
  const sel = project().clips.filter((c) => state.selection.has(c.id) && c.start < t && clipEnd(c) > t);
  let targets = sel;
  if (!targets.length) {
    const main = project().clips.filter((c) => c.trackId === 'v1' && c.start < t && clipEnd(c) > t);
    targets = main.length ? main : project().clips.filter((c) => c.start < t && clipEnd(c) > t);
  }
  if (!targets.length) return false;
  const ids = targets.map((c) => c.id);
  let newPlayhead = t;
  mutate(side === 'start' ? '앞부분 잘라내기' : '뒷부분 잘라내기', (p) => {
    for (const id of ids) {
      const c = p.clips.find((x) => x.id === id);
      const tr = trackById(c.trackId);
      if (side === 'start') {
        const cut = t - c.start;
        c.in += cut * c.speed;
        c.dur -= cut;
        if (tr?.magnetic) newPlayhead = c.start;
        else {
          // 비자석 트랙: 같은 트랙 뒤 클립도 함께 당김 (리플)
          for (const o of p.clips) if (o.trackId === c.trackId && o.id !== c.id && o.start >= clipEnd(c) + cut - 1e-3) o.start -= cut;
          newPlayhead = c.start;
        }
      } else {
        const cut = clipEnd(c) - t;
        c.dur -= cut;
        if (!tr?.magnetic) for (const o of p.clips) if (o.trackId === c.trackId && o.id !== c.id && o.start >= t + cut - 1e-3) o.start -= cut;
      }
    }
  });
  state.time = newPlayhead;
  emit('time');
  return true;
}

let clipboard = [];
export function copyClips(ids) {
  clipboard = project().clips.filter((c) => ids.includes(c.id)).map((c) => JSON.parse(JSON.stringify(c)));
  return clipboard.length;
}

export function pasteClips() {
  if (!clipboard.length) return 0;
  const minStart = Math.min(...clipboard.map((c) => c.start));
  const ids = [];
  mutate('붙여넣기', (p) => {
    for (const src of clipboard) {
      const c = JSON.parse(JSON.stringify(src));
      c.id = uid('c');
      c.start = state.time + (src.start - minStart);
      const tr = trackById(c.trackId);
      if (!tr) c.trackId = trackFor(c.type === 'audio' ? 'audio' : c.type === 'text' ? 'text' : 'video').id;
      if (!trackById(c.trackId).magnetic && !isFree(c.trackId, c.start, c.dur)) {
        c.trackId = findFreeTrack(p, trackById(c.trackId).kind, c.start, c.dur).id;
      }
      if (trackById(c.trackId).magnetic) {
        // 재생 위치의 클립 뒤에 끼워 넣기
        const list = clipsOnTrack(c.trackId);
        let insertAt = list.reduce((e, x) => Math.max(e, clipEnd(x)), 0);
        for (const x of list) if (state.time < clipEnd(x) - 1e-3) { insertAt = clipEnd(x); break; }
        for (const x of list) if (x.start >= insertAt - 1e-3) x.start += c.dur;
        c.start = insertAt;
      }
      p.clips.push(c);
      ids.push(c.id);
    }
  });
  setSelection(ids);
  return ids.length;
}

export function duplicateClips(ids) {
  const src = project().clips.filter((c) => ids.includes(c.id));
  if (!src.length) return;
  const newIds = [];
  mutate('복제', (p) => {
    for (const s of src) {
      const c = JSON.parse(JSON.stringify(s));
      c.id = uid('c');
      const tr = trackById(c.trackId);
      if (tr.magnetic) {
        for (const x of p.clips) if (x.trackId === tr.id && x.start >= clipEnd(s) - 1e-3) x.start += c.dur;
        c.start = clipEnd(s);
      } else {
        c.start = clipEnd(s);
        if (!isFree(tr.id, c.start, c.dur)) c.trackId = findFreeTrack(p, tr.kind, c.start, c.dur).id;
      }
      p.clips.push(c);
      newIds.push(c.id);
    }
  });
  setSelection(newIds);
}

export function addMarker(t, label = '') {
  mutate('마커 추가', (p) => {
    p.markers.push({ id: uid('k'), t: round(t), label });
    p.markers.sort((a, b) => a.t - b.t);
  });
}

/** 선택 클립 길이를 소스 범위 안으로 제한 */
export function clampDur(c, dur) {
  return Math.max(0.1, Math.min(dur, maxDurFor(c)));
}
