// 프로젝트 상태, 실행 취소/다시 실행, 이벤트, 자동 저장

const listeners = new Map();

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}

export function emit(evt, payload) {
  const set = listeners.get(evt);
  if (set) for (const fn of [...set]) fn(payload);
}

let idCounter = 0;
export function uid(prefix = 'c') {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export const ASPECTS = {
  '16:9': { width: 1920, height: 1080, label: '가로 16:9', hint: '유튜브 · 일반 영상' },
  '9:16': { width: 1080, height: 1920, label: '세로 9:16', hint: '쇼츠 · 릴스 · 틱톡' },
  '1:1': { width: 1080, height: 1080, label: '정사각 1:1', hint: '인스타 피드' },
  '4:5': { width: 1080, height: 1350, label: '세로 4:5', hint: '인스타 세로 피드' },
};

export function newProject() {
  return {
    version: 1,
    name: '제목 없는 프로젝트',
    aspect: '16:9',
    width: 1920,
    height: 1080,
    fps: 30,
    media: [],
    tracks: [
      { id: 't1', kind: 'text', name: '자막' },
      { id: 'v2', kind: 'video', name: '오버레이' },
      { id: 'v1', kind: 'video', name: '메인 영상', magnetic: true },
      { id: 'a1', kind: 'audio', name: '배경음악' },
      { id: 'a2', kind: 'audio', name: '효과음' },
    ],
    clips: [],
    markers: [],
    subtitleTheme: defaultSubtitleTheme(),
  };
}

/** 자막 디자인: 일반/강조 자막에 쓸 스타일(style:ID 또는 tpl:ID)과 강조 판별 규칙 */
export function defaultSubtitleTheme() {
  return {
    normal: 'style:subtitle',
    highlight: 'style:variety',
    rules: { markers: true, loud: true, exclaim: true, keywords: '' },
  };
}

export const state = {
  project: newProject(),
  selection: new Set(),
  time: 0,
  mode: 'easy', // 'easy' | 'pro'
  zoom: 80, // 초당 픽셀
  snap: true,
  inPoint: null,
  outPoint: null,
};

// 런타임 전용 미디어 정보 (URL, 썸네일, 파형) — 실행 취소 대상 아님
export const mediaRuntime = new Map();

export const project = () => state.project;

const past = [];
const future = [];
const HISTORY_LIMIT = 200;

function snapshot() {
  return JSON.stringify(state.project);
}

function pushPast(snap, label) {
  past.push({ snap, label });
  if (past.length > HISTORY_LIMIT) past.shift();
  future.length = 0;
  emit('history');
}

/** 상태 변경 + 실행 취소 기록 */
export function mutate(label, fn, source) {
  const before = snapshot();
  const result = fn(state.project);
  normalize();
  if (snapshot() !== before) {
    pushPast(before, label);
    changed(source);
  }
  return result;
}

// 드래그/슬라이더처럼 연속적인 변경: begin → live... → end
let gestureSnap = null;
export function beginGesture() {
  if (gestureSnap === null) gestureSnap = snapshot();
}
export function mutateLive(fn, source) {
  if (gestureSnap === null) gestureSnap = snapshot();
  fn(state.project);
  changed(source, true);
}
export function endGesture(label, source) {
  if (gestureSnap === null) return;
  const before = gestureSnap;
  gestureSnap = null;
  normalize();
  if (snapshot() !== before) {
    pushPast(before, label);
    changed(source);
  }
}

export function canUndo() { return past.length > 0; }
export function canRedo() { return future.length > 0; }
export function undoLabel() { return past.length ? past[past.length - 1].label : ''; }
export function redoLabel() { return future.length ? future[future.length - 1].label : ''; }

export function undo() {
  if (!past.length) return null;
  const { snap, label } = past.pop();
  future.push({ snap: snapshot(), label });
  state.project = JSON.parse(snap);
  pruneSelection();
  changed('history');
  emit('history');
  return label;
}

export function redo() {
  if (!future.length) return null;
  const { snap, label } = future.pop();
  past.push({ snap: snapshot(), label });
  state.project = JSON.parse(snap);
  pruneSelection();
  changed('history');
  emit('history');
  return label;
}

export function resetHistory() {
  past.length = 0;
  future.length = 0;
  emit('history');
}

export function loadProject(p) {
  state.project = p;
  state.selection.clear();
  state.time = 0;
  state.inPoint = null;
  state.outPoint = null;
  normalize();
  resetHistory();
  changed('load');
  emit('selection');
  emit('time');
}

function pruneSelection() {
  const ids = new Set(state.project.clips.map((c) => c.id));
  for (const id of [...state.selection]) if (!ids.has(id)) state.selection.delete(id);
  emit('selection');
}

function changed(source, live = false) {
  emit('project', { source, live });
  if (!live) scheduleSave();
}

// ---------- 조회 도우미 ----------

export const clipEnd = (c) => c.start + c.dur;
export const trackById = (id) => state.project.tracks.find((t) => t.id === id);
export const clipById = (id) => state.project.clips.find((c) => c.id === id);
export const mediaById = (id) => state.project.media.find((m) => m.id === id);
export const clipsOnTrack = (trackId) =>
  state.project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);

export function projectDuration() {
  let d = 0;
  for (const c of state.project.clips) d = Math.max(d, clipEnd(c));
  return d;
}

export function selectedClips() {
  return state.project.clips.filter((c) => state.selection.has(c.id));
}

export function setSelection(ids, additive = false) {
  if (!additive) state.selection.clear();
  for (const id of ids) {
    if (additive && state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
  }
  emit('selection');
}

export function setTime(t) {
  const max = Math.max(projectDuration(), 0);
  state.time = Math.max(0, Math.min(t, max));
  emit('time');
}

/** 소스 미디어의 끝을 넘지 않는 최대 타임라인 길이 */
export function maxDurFor(clip) {
  if (clip.type !== 'video' && clip.type !== 'audio') return Infinity;
  const m = mediaById(clip.mediaId);
  if (!m || typeof m.duration !== 'number' || !isFinite(m.duration)) return Infinity;
  return Math.max(0.05, (m.duration - clip.in) / clip.speed);
}

/** 자석 트랙: 빈틈 없이 앞으로 붙임 */
export function compactTrack(trackId) {
  let t = 0;
  for (const c of clipsOnTrack(trackId)) {
    c.start = round(t);
    t = c.start + c.dur;
  }
}

export function normalize() {
  const p = state.project;
  if (!p.subtitleTheme) p.subtitleTheme = defaultSubtitleTheme();
  for (const c of p.clips) {
    c.start = Math.max(0, round(c.start));
    c.dur = Math.max(0.05, round(c.dur));
    if (c.in != null) c.in = Math.max(0, round(c.in));
  }
  for (const t of p.tracks) if (t.magnetic) compactTrack(t.id);
}

export const round = (v) => Math.round(v * 1000) / 1000;

// ---------- 클립 생성 ----------

export function defaultClip(type, extra = {}) {
  return {
    id: uid('c'),
    type,
    trackId: null,
    mediaId: null,
    start: 0,
    dur: 4,
    in: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    duck: false,
    fit: 'contain',
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { filter: 'none', brightness: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 },
    motion: 'none',
    transition: { type: 'none', dur: 0.5 },
    ...extra,
  };
}

// ---------- 자동 저장 (IndexedDB) ----------

const DB_NAME = 'editin';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        // 'tpl': 자막 템플릿 — 프로젝트를 새로 만들어도 유지됨
        for (const name of ['files', 'kv', 'tpl']) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const idbPut = (store, key, val) => idb(store, 'readwrite', (s) => s.put(val, key)).catch(() => {});
export const idbGet = (store, key) => idb(store, 'readonly', (s) => s.get(key)).catch(() => undefined);
export const idbDel = (store, key) => idb(store, 'readwrite', (s) => s.delete(key)).catch(() => {});
export const idbAll = (store) => idb(store, 'readonly', (s) => s.getAll()).catch(() => []);
export const idbClear = (store) => idb(store, 'readwrite', (s) => s.clear()).catch(() => {});

let saveTimer = null;
export function scheduleSave() {
  clearTimeout(saveTimer);
  emit('save-state', 'pending');
  saveTimer = setTimeout(saveNow, 800);
}

export async function saveNow() {
  clearTimeout(saveTimer);
  await idbPut('kv', 'project', snapshot());
  await idbPut('kv', 'prefs', JSON.stringify({ mode: state.mode, zoom: state.zoom, snap: state.snap }));
  emit('save-state', 'saved');
}
