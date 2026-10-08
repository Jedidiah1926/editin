// editin — 앱 진입점: 레이아웃, 패널, 단축키, 온보딩, 자동 저장 복원

import {
  state, project, on, emit, mutate, undo, redo, canUndo, canRedo, undoLabel, redoLabel, setSelection, selectedClips,
  mediaRuntime, loadProject, newProject, idbGet, idbClear, saveNow, clipEnd, projectDuration, ASPECTS, clipsOnTrack,
  beginGesture, mutateLive, endGesture, clipById, trackById, scheduleSave,
} from './store.js';
import { Engine } from './engine.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { importFiles, restoreRuntime } from './media.js';
import {
  addMediaClip, addTextClip, splitAtPlayhead, deleteClips, trimToPlayhead, copyClips, pasteClips, duplicateClips, addMarker,
} from './ops.js';
import {
  silenceCut, detectSpeech, normalizeLoudness, autoEnhance, applyTransitionAll, polishEnds, fitAll, runChecks,
} from './smart.js';
import { initSubtitleUI } from './subtitle-ui.js';
import { openYouTubeImport, isSupportedUrl, updateMessage } from './youtube.js';
import { initTransformUI, toggleCrop, setCropMode, isCropMode } from './transform-ui.js';
import { fitSubtitleToFormat } from './subtitles.js';
import { cropForRatio } from './geometry.js';
import { loadTemplates } from './templates.js';
import { openExport } from './export.js';
import { TEXT_STYLES, TRANSITIONS } from './presets.js';
import { h, $, toast, modal, confirmDialog, fmtTime, fmtTimecode, fmtDur, modKey, clamp } from './ui.js';

// ---------- 레이아웃 ----------

const canvas = $('#preview');
const engine = new Engine(canvas);
const timeline = new Timeline($('#timeline'), engine, { contextMenu: clipMenu, menu });
const inspector = new Inspector($('#inspector'), engine, {
  setAspect, openSilence, deleteSelected, duplicate: () => duplicateClips([...state.selection]),
});

// ---------- 상단 바 ----------

const undoBtn = $('#undo');
const redoBtn = $('#redo');
undoBtn.onclick = doUndo;
redoBtn.onclick = doRedo;
on('history', () => {
  undoBtn.disabled = !canUndo();
  redoBtn.disabled = !canRedo();
  undoBtn.title = canUndo() ? `실행 취소: ${undoLabel()} (${modKey}+Z)` : '실행 취소';
  redoBtn.title = canRedo() ? `다시 실행: ${redoLabel()} (${modKey}+Shift+Z)` : '다시 실행';
});
emit('history');

function doUndo() {
  engine.pause(); // 재생 중에 되돌리면 화면과 소리가 어긋나므로 먼저 멈춤
  const l = undo();
  if (l) toast(`↩ 되돌림: ${l}`); else toast('더 되돌릴 작업이 없어요');
}
function doRedo() {
  engine.pause();
  const l = redo();
  if (l) toast(`↪ 다시 실행: ${l}`);
}

const saveState = $('#save-state');
on('save-state', (s) => {
  saveState.textContent = s === 'saved' ? '✓ 자동 저장됨' : '저장 중…';
  saveState.classList.toggle('pending', s !== 'saved');
});

const nameEl = $('#project-name');
nameEl.addEventListener('change', () => mutate('이름 변경', (p) => { p.name = nameEl.value.trim() || '제목 없는 프로젝트'; }));
nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameEl.blur(); e.stopPropagation(); });
on('project', () => { if (document.activeElement !== nameEl) nameEl.value = project().name; });

for (const b of document.querySelectorAll('.mode-toggle [data-mode]')) {
  b.addEventListener('click', () => setMode(b.dataset.mode));
}
function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  for (const b of document.querySelectorAll('.mode-toggle [data-mode]')) b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
  emit('mode');
  scheduleSave();
}

$('#export-btn').onclick = () => { engine.pause(); openExport(engine); };
$('#help-btn').onclick = showShortcuts;
$('#new-btn').onclick = async () => {
  if (project().clips.length && !(await confirmDialog('새 프로젝트', '지금 작업은 사라져요. 새로 시작할까요?', '새로 시작'))) return;
  await idbClear('files');
  for (const rt of mediaRuntime.values()) URL.revokeObjectURL(rt.url);
  mediaRuntime.clear();
  loadProject(newProject());
  saveNow();
  setLeftTab('media');
};

// ---------- 미리보기 / 재생 ----------

const playBtn = $('#play');
playBtn.onclick = () => engine.toggle();
on('playstate', (pl) => {
  playBtn.textContent = pl ? '❚❚' : '▶';
  playBtn.title = pl ? '일시정지 (Space)' : '재생 (Space)';
  document.body.classList.toggle('playing', pl);
});
$('#to-start').onclick = () => engine.seek(0);
$('#to-end').onclick = () => engine.seek(projectDuration());
$('#prev-edit').onclick = () => jumpEdit(-1);
$('#next-edit').onclick = () => jumpEdit(1);
$('#safe-btn').onclick = (e) => {
  engine.overlay.safe = !engine.overlay.safe;
  e.currentTarget.setAttribute('aria-pressed', engine.overlay.safe ? 'true' : 'false');
  engine.invalidate();
};
$('#full-btn').onclick = () => {
  const stage = $('#stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen?.();
};

const timeEl = $('#time');
const durEl = $('#dur');
function updateTime() {
  const pro = state.mode === 'pro';
  timeEl.textContent = pro ? fmtTimecode(state.time, project().fps) : fmtTime(state.time);
  durEl.textContent = pro ? fmtTimecode(projectDuration(), project().fps) : fmtTime(projectDuration());
}
on('time', updateTime);
on('project', updateTime);
on('mode', updateTime);

// 미리보기 크기 맞추기
const stage = $('#stage');
initTransformUI({ stage, canvas, engine });
function fitCanvas() {
  const p = project();
  const r = stage.getBoundingClientRect();
  const s = Math.min((r.width - 16) / p.width, (r.height - 16) / p.height);
  canvas.style.width = `${Math.max(10, p.width * s)}px`;
  canvas.style.height = `${Math.max(10, p.height * s)}px`;
}
new ResizeObserver(fitCanvas).observe(stage);
on('project', fitCanvas);

// 레벨 미터
const meter = $('#meter-fill');
(function meterLoop() {
  requestAnimationFrame(meterLoop);
  if (!engine.playing) { meter.style.height = '0%'; return; }
  const db = engine.level();
  const pct = clamp((db + 48) / 48, 0, 1) * 100;
  meter.style.height = `${pct}%`;
  meter.classList.toggle('hot', db > -1);
})();

// 미리보기에서 직접 옮기기/크기 조절
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const pt = canvasPoint(e);
  const hit = engine.hitTest(pt.x, pt.y);
  if (!hit) { setSelection([]); return; }
  const c = clipById(hit.id);
  if (!c || trackById(c.trackId)?.locked) return;
  setSelection([c.id]);
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  const W = canvas.width;
  const H = canvas.height;
  const o = c.type === 'text' ? { x: c.text.x, y: c.text.y } : { x: c.transform.x, y: c.transform.y };
  let moved = false;
  const move = (ev) => {
    const q = canvasPoint(ev);
    let dx = (q.x - pt.x) / W;
    let dy = (q.y - pt.y) / H;
    if (!moved && Math.hypot(dx * W, dy * H) < 4) return;
    if (!moved) { moved = true; beginGesture(); }
    let nx = o.x + dx;
    let ny = o.y + dy;
    // 가운데 정렬 스냅
    const center = c.type === 'text' ? 0.5 : 0;
    if (!ev.shiftKey) {
      if (Math.abs(nx - center) < 0.015) nx = center;
      if (Math.abs(ny - center) < 0.015) ny = center;
    }
    mutateLive(() => {
      if (c.type === 'text') { c.text.x = nx; c.text.y = ny; } else { c.transform.x = nx; c.transform.y = ny; }
    });
  };
  const up = () => {
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    if (moved) endGesture('위치 이동');
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
});
canvas.addEventListener('dblclick', () => {
  const sel = selectedClips();
  if (sel.length !== 1) return;
  if (sel[0].type === 'text') emit('clip-dblclick', sel[0].id);
  else if (sel[0].type === 'video' || sel[0].type === 'image') toggleCrop();
});
let wheelTimer;
canvas.addEventListener('wheel', (e) => {
  const sel = selectedClips();
  if (sel.length !== 1 || sel[0].type === 'audio') return;
  e.preventDefault();
  const c = sel[0];
  const f = Math.exp(-e.deltaY * 0.0015);
  beginGesture();
  mutateLive(() => {
    if (c.type === 'text') c.text.size = clamp(c.text.size * f, 0.3, 4);
    else c.transform.scale = clamp(c.transform.scale * f, 0.1, 5);
  });
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { endGesture('크기 조절'); inspector.render(); }, 300);
}, { passive: false });

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
}

// ---------- 타임라인 도구 막대 ----------

$('#tb-split').onclick = doSplit;
$('#tb-delete').onclick = deleteSelected;
$('#tb-trim-start').onclick = () => { if (!trimToPlayhead('start')) toast('재생 위치에 클립이 없어요'); };
$('#tb-trim-end').onclick = () => { if (!trimToPlayhead('end')) toast('재생 위치에 클립이 없어요'); };
$('#tb-text').onclick = () => addTextClip(state.mode === 'easy' ? 'subtitle' : 'subtitle');
$('#tb-marker').onclick = () => addMarker(state.time);
$('#tb-layer').onclick = (e) => timeline.addTrackMenu(e);
$('#tb-snap').onclick = () => toggleSnap();
$('#tb-fit').onclick = () => timeline.zoomToFit();
const zoomRange = $('#tb-zoom');
zoomRange.addEventListener('input', () => timeline.setZoom(zoomFromSlider(+zoomRange.value)));
on('zoom', () => { zoomRange.value = sliderFromZoom(state.zoom); });
function zoomFromSlider(v) { return 4 * Math.pow(150, v / 100); }
function sliderFromZoom(z) { return (Math.log(z / 4) / Math.log(150)) * 100; }
zoomRange.value = sliderFromZoom(state.zoom);

function toggleSnap() {
  state.snap = !state.snap;
  $('#tb-snap').setAttribute('aria-pressed', state.snap ? 'true' : 'false');
  toast(state.snap ? '자석 맞춤 켬' : '자석 맞춤 끔');
  scheduleSave();
}

function doSplit() {
  const n = splitAtPlayhead();
  if (!n) toast('재생 위치(빨간 선)를 클립 위에 두고 자르세요');
}

function deleteSelected(ripple = false) {
  const ids = [...state.selection].filter((id) => !trackById(clipById(id)?.trackId)?.locked);
  if (!ids.length) { toast('삭제할 클립을 먼저 선택하세요'); return; }
  deleteClips(ids, ripple === true);
  toast(`클립 ${ids.length}개를 삭제했어요`, { action: { label: '되돌리기', run: doUndo } });
}

function jumpEdit(dir) {
  const pts = new Set([0, projectDuration()]);
  for (const c of project().clips) { pts.add(c.start); pts.add(clipEnd(c)); }
  for (const m of project().markers) pts.add(m.t);
  const sorted = [...pts].sort((a, b) => a - b);
  const t = state.time;
  const target = dir > 0 ? sorted.find((x) => x > t + 1e-3) : [...sorted].reverse().find((x) => x < t - 1e-3);
  if (target != null) engine.seek(target);
}

// ---------- 컨텍스트 메뉴 ----------

let menuEl = null;
function menu(x, y, items) {
  menuEl?.remove();
  menuEl = h('div', { class: 'ctx-menu', role: 'menu' }, items.map((it) => (it === '-' ? h('div', { class: 'sep' }) : h('button', {
    role: 'menuitem', class: it.danger ? 'danger' : '', disabled: it.disabled ? true : null,
    onclick: () => { menuEl.remove(); menuEl = null; it.run(); },
  }, h('span', {}, it.label), it.key ? h('kbd', {}, it.key) : null))));
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menuEl.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  setTimeout(() => document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) { menuEl.remove(); menuEl = null; } }, { once: true }));
}

function clipMenu(c, x, y) {
  const ids = [...state.selection];
  const media = c.type === 'video' || c.type === 'audio';
  menu(x, y, [
    { label: '✂️ 재생 위치에서 자르기', key: 'S', run: doSplit },
    { label: '⇤ 앞부분 잘라내기', key: 'Q', run: () => trimToPlayhead('start') },
    { label: '⇥ 뒷부분 잘라내기', key: 'W', run: () => trimToPlayhead('end') },
    '-',
    { label: '복제', key: `${modKey}+D`, run: () => duplicateClips(ids) },
    { label: '복사', key: `${modKey}+C`, run: () => { copyClips(ids); toast('복사했어요'); } },
    media ? { label: '🪄 무음 자동 컷', run: () => openSilence(ids) } : null,
    c.type === 'video' || c.type === 'image' ? { label: '✨ 원클릭 보정', run: () => autoEnhance(ids) } : null,
    '-',
    { label: '삭제', key: 'Del', danger: true, run: () => deleteSelected() },
  ].filter(Boolean));
}

// ---------- 왼쪽 패널 ----------

const leftTabs = document.querySelectorAll('[data-left-tab]');
for (const b of leftTabs) b.addEventListener('click', () => setLeftTab(b.dataset.leftTab));
function setLeftTab(id) {
  for (const b of leftTabs) b.setAttribute('aria-selected', b.dataset.leftTab === id ? 'true' : 'false');
  for (const p of document.querySelectorAll('[data-left-panel]')) p.hidden = p.dataset.leftPanel !== id;
}

// 미디어
const fileInput = h('input', { type: 'file', multiple: true, accept: 'video/*,audio/*,image/*', hidden: true });
document.body.append(fileInput);
fileInput.addEventListener('change', async () => {
  await doImport([...fileInput.files]);
  fileInput.value = '';
});
$('#import-btn').onclick = () => fileInput.click();
$('#yt-btn').onclick = () => openYouTubeImport();
// 데스크톱 앱: yt-dlp 자동 업데이트 결과 알림
if (window.editinNative?.ytdlp) {
  document.body.classList.add('is-app');
  window.editinNative.ytdlp.onStatus((s) => {
    if (s.status === 'updated' || s.status === 'error') toast(updateMessage(s), { type: s.status === 'error' ? 'error' : '' });
  });
}
// 편집기 아무 곳에서나 유튜브 링크를 붙여넣으면 바로 가져오기 창
document.addEventListener('paste', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.querySelector('.modal-back')) return;
  const text = e.clipboardData?.getData('text') || '';
  if (isSupportedUrl(text)) { e.preventDefault(); openYouTubeImport(text.trim()); }
});
$('#media-drop').onclick = () => fileInput.click();

async function doImport(files, autoAdd = state.mode === 'easy') {
  if (!files.length) return;
  const t = toast(`${files.length}개 파일 불러오는 중…`, { duration: 60000 });
  const { added, errors } = await importFiles(files);
  t();
  errors.forEach((e) => toast(e, { type: 'error', duration: 5000 }));
  if (!added.length) return;
  // 첫 영상이면 화면 비율 자동 맞춤
  const firstVideo = added.find((m) => m.type === 'video' && m.width && m.height);
  if (firstVideo && !project().formatChosen && !project().clips.some((c) => c.type === 'video')) {
    const r = firstVideo.width / firstVideo.height;
    const best = Object.entries(ASPECTS).sort((a, b) => Math.abs(a[1].width / a[1].height - r) - Math.abs(b[1].width / b[1].height - r))[0][0];
    if (best !== project().aspect) setAspect(best, true);
  }
  if (autoAdd) {
    // 심플 모드: 바로 타임라인에 순서대로 배치
    const visuals = added.filter((m) => m.type !== 'audio');
    const audios = added.filter((m) => m.type === 'audio');
    for (const m of visuals) addMediaClip(m.id);
    for (const m of audios) {
      if (visuals.length || project().clips.length) {
        const a1 = clipsOnTrack('a1');
        addMediaClip(m.id, { at: a1.length ? clipEnd(a1[a1.length - 1]) : 0, trackId: 'a1' });
      } else addMediaClip(m.id);
    }
    setSelection([]);
    toast(`${added.length}개를 타임라인에 추가했어요`);
    setTimeout(() => timeline.zoomToFit(), 50);
  } else toast(`${added.length}개 파일을 불러왔어요`);
}

const mediaList = $('#media-list');
function renderMedia() {
  const p = project();
  mediaList.replaceChildren();
  $('#media-drop').classList.toggle('compact', p.media.length > 0);
  for (const m of p.media) {
    const rt = mediaRuntime.get(m.id);
    const used = p.clips.filter((c) => c.mediaId === m.id).length;
    const icon = { video: '🎞', audio: '♪', image: '🖼' }[m.type];
    const item = h('div', { class: `media-item ${rt ? '' : 'offline'}`, title: `${m.name}\n타임라인이나 미리보기로 끌어다 놓기 · 더블클릭 또는 + 버튼으로 추가` },
      h('div', { class: 'media-thumb', style: rt?.poster ? { backgroundImage: `url("${rt.poster}")` } : {} },
        !rt?.poster ? h('span', { class: 'media-icon' }, icon) : null,
        rt?.analyzing ? h('span', { class: 'media-busy', title: '분석 중' }) : null,
        m.type !== 'image' ? h('span', { class: 'media-dur' }, fmtDur(m.duration)) : null,
        used ? h('span', { class: 'media-used', title: `타임라인에서 ${used}번 사용 중` }, `${used}`) : null,
        m.source?.url ? h('span', { class: `media-yt src-${m.source.kind}`, title: `${m.source.channel || ''} · ${m.source.title || ''}\n${m.source.url}` }, { youtube: '▶ YT', chzzk: '치지직' }[m.source.kind] || 'WEB') : null,
        h('button', { class: 'media-add', title: '타임라인에 추가', 'aria-label': `${m.name} 타임라인에 추가`, onclick: (e) => { e.stopPropagation(); addMediaClip(m.id); } }, '+'),
      ),
      h('div', { class: 'media-name' }, h('span', {}, icon), ' ', m.name));
    item.addEventListener('dblclick', () => addMediaClip(m.id));
    item.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.media-add')) return;
      startMediaDrag(e, m, rt, icon);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      menu(e.clientX, e.clientY, [
        { label: '타임라인에 추가', run: () => addMediaClip(m.id) },
        { label: '재생 위치에 추가', run: () => addMediaClip(m.id, { at: state.time, trackId: m.type === 'audio' ? 'a1' : 'v2' }) },
        '-',
        { label: used ? `라이브러리에서 제거 (클립 ${used}개 포함)` : '라이브러리에서 제거', danger: true, run: () => removeMedia(m.id) },
      ]);
    });
    mediaList.append(item);
  }
}
on('project', ({ live } = {}) => { if (!live) renderMedia(); });
on('media-analyzed', renderMedia);

/** 미디어를 끌어서 타임라인(원하는 위치·레이어) 또는 미리보기(재생 위치의 오버레이)에 놓기 */
function startMediaDrag(e, m, rt, icon) {
  const sx = e.clientX;
  const sy = e.clientY;
  let ghost = null;
  const stageEl = $('#stage');
  const overStage = (x, y) => {
    const r = stageEl.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('keydown', esc, true);
    stageEl.classList.remove('drop-here');
    document.body.classList.remove('dragging-media');
    ghost?.remove();
    timeline.clearDrop();
  };
  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      ghost = h('div', { class: 'media-ghost' },
        rt?.poster ? h('img', { src: rt.poster, alt: '' }) : h('span', { class: 'media-ghost-icon' }, icon),
        h('span', { class: 'media-ghost-name' }, m.name));
      document.body.append(ghost);
      document.body.classList.add('dragging-media');
    }
    ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
    const onTimeline = timeline.externalHover(m.id, ev.clientX, ev.clientY);
    const onStage = !onTimeline && overStage(ev.clientX, ev.clientY);
    stageEl.classList.toggle('drop-here', onStage);
    ghost.classList.toggle('ok', onTimeline || onStage);
  };
  const up = (ev) => {
    const dragged = !!ghost;
    const onStage = dragged && overStage(ev.clientX, ev.clientY);
    const handledTimeline = dragged && timeline.externalDrop(m.id, ev.clientX, ev.clientY);
    end();
    if (!dragged || handledTimeline) return;
    if (onStage) {
      addMediaClip(m.id, { at: state.time, overlay: true });
      toast(m.type === 'audio' ? '재생 위치에 소리를 넣었어요' : '재생 위치에 겹쳐 넣었어요 (오버레이 레이어)');
    }
  };
  const esc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); end(); } };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', esc, true);
}

function removeMedia(id) {
  mutate('미디어 제거', (p) => {
    p.media = p.media.filter((m) => m.id !== id);
    p.clips = p.clips.filter((c) => c.mediaId !== id);
  });
  engine.gc();
  toast('제거했어요', { action: { label: '되돌리기', run: doUndo } });
}

// 텍스트
const textCards = $('#text-styles');
for (const st of TEXT_STYLES) {
  textCards.append(h('button', {
    class: 'card', title: `${st.name} 추가 (재생 위치에)`,
    onclick: () => { addTextClip(st.id); toast(`'${st.name}'를 추가했어요. 오른쪽에서 내용을 바꾸세요.`); },
  }, h('span', { class: `text-sample ts-${st.id}` }, st.sample), h('span', { class: 'card-name' }, st.name)));
}
// 스마트 도구
const smart = [
  { icon: '✂️', title: '무음 자동 컷', desc: '말이 없는 부분을 찾아 한 번에 잘라내요', run: () => openSilence(mainMediaClips()) },
  { icon: '🔊', title: '음량 고르게', desc: '클립마다 다른 소리 크기를 비슷하게 맞춰요', run: () => { const n = normalizeLoudness(project().clips.map((c) => c.id)); toast(n ? `${n}개 클립의 음량을 맞췄어요` : '맞출 소리가 없어요'); } },
  { icon: '✨', title: '원클릭 보정', desc: '모든 영상을 선명하고 생기있게', run: () => { autoEnhance(project().clips.map((c) => c.id)); toast('모든 영상을 보정했어요'); } },
  { icon: '🔀', title: '전환 효과 한 번에', desc: '모든 컷 사이에 자연스러운 전환을 넣어요', run: openTransitionAll },
  { icon: '🌅', title: '시작·끝 부드럽게', desc: '페이드 인/아웃, 음악 길이 맞춤', run: () => { polishEnds(); toast('시작과 끝을 부드럽게 다듬었어요'); } },
  { icon: '📐', title: '화면 꽉 채우기', desc: '검은 여백 없이 화면을 채워요 (세로 영상에 유용)', run: () => { fitAll('cover'); toast('화면을 꽉 채웠어요'); } },
  { icon: '🩺', title: '완성도 점검', desc: '흔한 실수를 찾아 고쳐요', run: openChecks },
];
const smartList = $('#smart-list');
for (const s of smart) {
  smartList.append(h('button', { class: 'smart-item', onclick: s.run },
    h('span', { class: 'smart-icon' }, s.icon),
    h('span', {}, h('b', {}, s.title), h('span', { class: 'muted small block' }, s.desc))));
}

/** 무음 컷 대상: 선택한 영상 → 메인 트랙 영상 → 선택한 오디오 순 */
function mainMediaClips() {
  const selVideo = selectedClips().filter((c) => c.type === 'video');
  if (selVideo.length) return selVideo.map((c) => c.id);
  const main = project().clips.filter((c) => c.type === 'video' && c.trackId === 'v1');
  if (main.length) return main.map((c) => c.id);
  const anyVideo = project().clips.filter((c) => c.type === 'video');
  if (anyVideo.length) return anyVideo.map((c) => c.id);
  return selectedClips().filter((c) => c.type === 'audio').map((c) => c.id);
}

function openSilence(ids) {
  const clips = ids.map(clipById).filter((c) => c && (c.type === 'video' || c.type === 'audio'));
  if (!clips.length) { toast('먼저 말소리가 있는 영상을 추가하세요'); return; }
  if (clips.some((c) => !mediaRuntime.get(c.mediaId)?.peaks)) {
    if (clips.every((c) => mediaRuntime.get(c.mediaId)?.analyzing)) { toast('소리를 분석하는 중이에요. 잠시 후 다시 시도하세요.'); return; }
  }
  const opts = { sensitivity: 0.5, minSilence: 0.6, pad: 0.15 };
  const preview = h('div', { class: 'silence-preview' });
  const update = () => {
    let total = 0;
    let cuts = 0;
    let ok = 0;
    for (const c of clips) {
      const r = detectSpeech(c, opts);
      if (!r) continue;
      ok++;
      const kept = r.reduce((s, [a, b]) => s + (b - a) / c.speed, 0);
      if (c.dur - kept >= 0.2) { total += c.dur - kept; cuts += Math.max(0, r.length - 1); }
    }
    preview.textContent = ok ? `약 ${fmtDur(total)} 분량의 무음을 ${cuts}군데에서 잘라내요` : '뚜렷한 무음 구간을 찾지 못했어요';
  };
  const slider = (label, key, min, max, step, fmt) => {
    const out = h('span', { class: 'sl-val' }, fmt(opts[key]));
    const r = h('input', { type: 'range', min, max, step, value: opts[key], 'aria-label': label });
    r.addEventListener('input', () => { opts[key] = +r.value; out.textContent = fmt(+r.value); update(); });
    return h('div', { class: 'ctl slider' }, h('div', { class: 'ctl-top' }, h('label', {}, label), out), r);
  };
  update();
  const close = modal('무음 자동 컷', h('div', {},
    h('p', { class: 'muted' }, `${clips.length}개 클립에서 말이 없는 구간을 찾아 잘라내고 빈틈 없이 이어 붙여요.`),
    slider('민감도', 'sensitivity', 0, 1, 0.05, (v) => (v < 0.34 ? '조금만' : v < 0.67 ? '보통' : '많이')),
    slider('이보다 긴 무음만 자르기', 'minSilence', 0.2, 2, 0.1, (v) => `${(+v).toFixed(1)}초`),
    state.mode === 'pro' ? slider('말 앞뒤 여유', 'pad', 0, 0.5, 0.05, (v) => `${(+v).toFixed(2)}초`) : null,
    preview,
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: () => close() }, '취소'),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          close();
          const r = silenceCut(clips.map((c) => c.id), opts);
          if (r.removed > 0) toast(`${fmtDur(r.removed)} 분량의 무음을 잘라냈어요`, { action: { label: '되돌리기', run: doUndo } });
          else toast('잘라낼 무음 구간이 없었어요');
        },
      }, '잘라내기'))));
}

function openTransitionAll() {
  let close;
  const body = h('div', {},
    h('p', { class: 'muted' }, '이어진 모든 컷 사이에 같은 전환 효과를 넣어요.'),
    h('div', { class: 'cards small-cards' }, TRANSITIONS.map((t) => h('button', {
      class: 'card', onclick: () => { close(); const n = applyTransitionAll(t.id); toast(n ? `${n}곳에 '${t.name}'을 적용했어요` : '이어진 컷이 없어요. 먼저 영상을 잘라보세요.'); },
    }, h('span', { class: 'card-name' }, t.name), h('span', { class: 'muted small block' }, t.desc)))));
  close = modal('전환 효과 한 번에', body);
}

function openChecks() {
  const list = h('div', { class: 'checks' });
  const render = () => {
    const items = runChecks();
    list.replaceChildren();
    if (!items.length) list.append(h('div', { class: 'check-item ok' }, '✅ 문제 없이 깔끔해요!'));
    for (const c of items) {
      const icon = c.level === 'error' ? '⛔' : c.level === 'warn' ? '⚠️' : '💡';
      list.append(h('div', { class: `check-item ${c.level}` }, h('span', {}, `${icon} ${c.msg}`),
        c.fix ? h('button', { class: 'btn small', onclick: () => { c.fix(); render(); } }, c.fixLabel || '고치기') : null));
    }
  };
  render();
  modal('완성도 점검', list);
}

// ---------- 화면 비율 ----------

function setAspect(id, auto = false) {
  const a = ASPECTS[id];
  if (!a) return;
  const label = FORMAT_OF[id] ? `${FORMAT_OF[id] === 'short' ? '숏폼' : '롱폼'} (${a.label})` : a.label;
  const fitted = [];
  mutate(FORMAT_OF[id] ? `${label}으로 변경` : '화면 비율 변경', (p) => {
    const oldRatio = p.width / p.height;
    const newRatio = a.width / a.height;
    p.aspect = id;
    p.width = a.width;
    p.height = a.height;
    if (!auto) p.formatChosen = true;
    // 자막 위치를 형식에 맞게 (숏폼은 아래쪽이 버튼·설명에 가려짐)
    for (const c of p.clips) if (c.type === 'text' && c.text.role) fitSubtitleToFormat(c.text, p);
    // 영상·사진도 새 화면에 맞춰 따라가게
    for (const c of p.clips) {
      if (c.type !== 'video' && c.type !== 'image') continue;
      const tf = c.transform;
      const fullFrame = Math.abs(tf.scale - 1) < 0.01 && Math.abs(tf.x) < 0.01 && Math.abs(tf.y) < 0.01;
      const m = p.media.find((x) => x.id === c.mediaId);
      if (c.cropRatio && Math.abs(c.cropRatio - oldRatio) < 0.01 && m?.width) {
        // 화면 비율로 잘라 둔 영상은 새 비율로 다시 자름
        const base = c.cropBase || { l: 0, t: 0, r: 0, b: 0 };
        const fx = 1 - base.l - base.r;
        const fy = 1 - base.t - base.b;
        const inner = cropForRatio(m.width * fx, m.height * fy, newRatio);
        c.crop = { l: base.l + inner.l * fx, r: base.r + inner.r * fx, t: base.t + inner.t * fy, b: base.b + inner.b * fy };
        c.cropRatio = newRatio;
        fitted.push(c.id);
      } else if (fullFrame && c.fit === 'contain' && m?.width && Math.abs(m.width / m.height - newRatio) > 0.02) {
        c.fit = 'cover';
        fitted.push(c.id);
      }
    }
  });
  if (auto) { toast(`영상에 맞춰 ${label}로 정했어요`); return; }
  toast(fitted.length ? `${label}로 바꿨어요 · 영상도 화면에 꽉 차게 맞췄어요` : `${label}로 바꿨어요`, fitted.length ? {
    action: {
      label: '원본 전체 보이기',
      run: () => mutate('전체 보이기', (p) => { for (const c of p.clips) if (fitted.includes(c.id) && !c.cropRatio) c.fit = 'contain'; }),
    },
  } : {});
}

// ---------- 롱폼 / 숏폼 ----------

const FORMAT_OF = { '16:9': 'long', '9:16': 'short' };
const formatBtns = document.querySelectorAll('[data-format]');
for (const b of formatBtns) {
  b.addEventListener('click', () => {
    const id = b.dataset.format === 'short' ? '9:16' : '16:9';
    if (project().aspect === id) return;
    setAspect(id);
  });
}
function renderFormat() {
  const f = FORMAT_OF[project().aspect];
  for (const b of formatBtns) b.setAttribute('aria-pressed', b.dataset.format === f ? 'true' : 'false');
}
on('project', renderFormat);

// ---------- 가이드 (심플 모드) ----------

const STEPS = [
  { id: 'import', label: '불러오기', tip: '왼쪽 <b>미디어</b>에 영상·사진을 끌어다 놓으세요. 순서대로 타임라인에 붙어요.', tab: 'media',
    done: (p) => p.clips.some((c) => c.type === 'video' || c.type === 'image') },
  { id: 'trim', label: '다듬기', tip: '빨간 선을 원하는 곳에 두고 <b>S</b>(자르기) → 필요 없는 조각 선택 후 <b>Delete</b>. 말이 많은 영상은 <b>스마트 → 무음 자동 컷</b>!', tab: 'smart',
    done: (p) => { const v = p.clips.filter((c) => c.trackId === 'v1'); return v.some((c) => c.in > 0.05) || v.length > new Set(v.map((c) => c.mediaId)).size; } },
  { id: 'text', label: '자막', tip: '<b>텍스트 → 🎙 자동 자막</b>을 누르면 말을 받아써서 자막이 생겨요. 하이라이트는 <b>강조 자막</b>으로 자동 구분돼요.', tab: 'text',
    done: (p) => p.clips.some((c) => c.type === 'text') },
  { id: 'music', label: '음악', tip: '음악 파일을 불러오면 배경음악 트랙에 들어가요. 말할 땐 <b>자동으로 작아져요</b>.', tab: 'media',
    done: (p) => p.clips.some((c) => c.type === 'audio') },
  { id: 'export', label: '내보내기', tip: '오른쪽 위 <b>내보내기</b>를 누르면 점검 후 영상 파일로 저장돼요.', tab: null,
    done: () => exported },
];
let exported = false;
on('exported', () => { exported = true; renderGuide(); });
const guide = $('#guide');
function renderGuide() {
  const p = project();
  const cur = STEPS.findIndex((s) => !s.done(p));
  guide.replaceChildren(
    h('ol', { class: 'steps' }, STEPS.map((s, i) => h('li', {
      class: `${s.done(p) ? 'done' : ''} ${i === cur ? 'current' : ''}`,
    }, h('button', { onclick: () => { if (s.tab) setLeftTab(s.tab); else $('#export-btn').click(); showTip(s); } },
      h('span', { class: 'step-n' }, s.done(p) ? '✓' : i + 1), s.label)))),
    h('div', { class: 'guide-tip', html: cur >= 0 ? `💡 ${STEPS[cur].tip}` : '🎉 모든 단계를 마쳤어요! 더 다듬고 싶다면 전문가 모드도 써 보세요.' }),
  );
}
function showTip(s) { guide.querySelector('.guide-tip').innerHTML = `💡 ${s.tip}`; }
on('project', ({ live } = {}) => { if (!live) renderGuide(); });

// ---------- 단축키 ----------

const SHORTCUTS = [
  ['재생', [['Space', '재생 / 일시정지'], ['J / K / L', '뒤로 / 정지 / 앞으로 (여러 번: 빠르게)'], ['← / →', '1프레임 이동'], ['Shift + ← / →', '1초 이동'], ['↑ / ↓', '이전 / 다음 편집점'], ['Home / End', '처음 / 끝']]],
  ['편집', [['S', '재생 위치에서 자르기'], ['Q / W', '재생 위치 앞 / 뒤 잘라내기'], ['Delete', '삭제'], ['Shift + Delete', '삭제 후 빈틈 당기기'], [`${modKey} + D`, '복제'], [`${modKey} + C / V`, '복사 / 붙여넣기'], [`${modKey} + A`, '모두 선택'], ['T', '자막 추가']]],
  ['보기·기타', [[`${modKey} + Z`, '실행 취소'], [`${modKey} + Shift + Z`, '다시 실행'], ['+ / -', '타임라인 확대 / 축소'], ['Shift + Z', '전체 보기'], ['N', '자석 맞춤 켜기/끄기'], ['I / O / X', '구간 시작 / 끝 / 해제'], ['M', '마커 추가'], [`${modKey} + E`, '내보내기'], ['C', '화면 자르기 (크롭)'], ['?', '이 도움말']]],
];
function showShortcuts() {
  modal('단축키', h('div', { class: 'shortcuts' }, SHORTCUTS.map(([g, list]) => h('div', {},
    h('h3', {}, g), h('dl', {}, list.flatMap(([k, d]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, d)]))))), { wide: true });
}

let shuttle = 0;
document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (document.querySelector('.modal-back')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const fps = project().fps;
  const handled = () => e.preventDefault();

  if (mod && k === 'z' && !e.shiftKey) { handled(); doUndo(); return; }
  if ((mod && k === 'z' && e.shiftKey) || (mod && k === 'y')) { handled(); doRedo(); return; }
  if (mod && k === 'c') { const n = copyClips([...state.selection]); if (n) toast(`클립 ${n}개 복사`); handled(); return; }
  if (mod && k === 'x') { const n = copyClips([...state.selection]); if (n) deleteClips([...state.selection]); handled(); return; }
  if (mod && k === 'v') { pasteClips(); handled(); return; }
  if (mod && k === 'd') { duplicateClips([...state.selection]); handled(); return; }
  if (mod && k === 'a') { setSelection(project().clips.map((c) => c.id)); handled(); return; }
  if (mod && k === 'e') { $('#export-btn').click(); handled(); return; }
  if (mod && k === 'b') { doSplit(); handled(); return; }
  if (mod && k === 's') { saveNow(); toast('저장했어요 (작업은 자동으로도 저장돼요)'); handled(); return; }
  if (mod) return;

  switch (e.key) {
    case ' ': handled(); shuttle = 0; engine.toggle(); return;
    case 'ArrowLeft': handled(); engine.pause(); engine.seek(state.time - (e.shiftKey ? 1 : 1 / fps)); return;
    case 'ArrowRight': handled(); engine.pause(); engine.seek(state.time + (e.shiftKey ? 1 : 1 / fps)); return;
    case 'ArrowUp': handled(); jumpEdit(-1); return;
    case 'ArrowDown': handled(); jumpEdit(1); return;
    case 'Home': handled(); engine.seek(0); return;
    case 'End': handled(); engine.seek(projectDuration()); return;
    case 'Delete':
    case 'Backspace': handled(); deleteSelected(e.shiftKey); return;
    case 'Escape': if (isCropMode()) setCropMode(false); else setSelection([]); return;
    case 'Enter': if (isCropMode()) { setCropMode(false); handled(); } return;
    case '?': showShortcuts(); return;
    case '+':
    case '=': timeline.setZoom(state.zoom * 1.4); return;
    case '-':
    case '_': timeline.setZoom(state.zoom / 1.4); return;
    default: break;
  }
  switch (k) {
    case 's': doSplit(); break;
    case 'q': trimToPlayhead('start'); break;
    case 'w': trimToPlayhead('end'); break;
    case 'k': shuttle = 0; engine.pause(); break;
    case 'l': shuttle = shuttle > 0 ? Math.min(shuttle * 2, 8) : 1; engine.pause(); engine.play(shuttle); break;
    case 'j': shuttle = shuttle < 0 ? Math.max(shuttle * 2, -8) : -1; engine.pause(); engine.play(shuttle); break;
    case 'i': state.inPoint = state.time; if (state.outPoint != null && state.outPoint <= state.inPoint) state.outPoint = null; emit('io'); toast(`구간 시작 ${fmtTime(state.time)}`); break;
    case 'o': state.outPoint = state.time; if (state.inPoint != null && state.inPoint >= state.outPoint) state.inPoint = null; emit('io'); toast(`구간 끝 ${fmtTime(state.time)}`); break;
    case 'x': state.inPoint = null; state.outPoint = null; emit('io'); break;
    case 'm': addMarker(state.time); break;
    case 'n': toggleSnap(); break;
    case 'c': toggleCrop(); break;
    case 't': addTextClip('subtitle'); break;
    case 'z': if (e.shiftKey) timeline.zoomToFit(); break;
    default: return;
  }
  handled();
});

// 창 어디에나 파일 끌어다 놓기
window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); document.body.classList.add('file-over'); } });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('file-over'); });
window.addEventListener('drop', (e) => {
  document.body.classList.remove('file-over');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  doImport([...e.dataTransfer.files]);
});

// ---------- 시작 ----------

initSubtitleUI({ mainMediaClipIds: mainMediaClips });

async function boot() {
  await loadTemplates();
  const prefsRaw = await idbGet('kv', 'prefs');
  const prefs = prefsRaw ? JSON.parse(prefsRaw) : null;
  if (prefs) {
    state.zoom = prefs.zoom || state.zoom;
    state.snap = prefs.snap ?? true;
    $('#tb-snap').setAttribute('aria-pressed', state.snap ? 'true' : 'false');
  }
  setMode(prefs?.mode || 'easy');
  const saved = await idbGet('kv', 'project');
  if (saved) {
    try {
      const p = JSON.parse(saved);
      let missing = 0;
      for (const m of p.media) {
        const file = await idbGet('files', m.id);
        if (file) restoreRuntime(m, file); else missing++;
      }
      loadProject(p);
      if (p.clips.length) toast(missing ? `이전 작업을 불러왔어요 (파일 ${missing}개는 다시 불러와야 해요)` : '이전 작업을 이어서 할 수 있어요');
    } catch (err) {
      console.error(err);
    }
  }
  renderMedia();
  renderGuide();
  renderFormat();
  updateTime();
  fitCanvas();
  emit('zoom');
  if (!prefs) welcome();
}

function welcome() {
  let close;
  const pick = (mode) => { setMode(mode); close(); saveNow(); };
  close = modal('editin에 오신 걸 환영해요 👋', h('div', { class: 'welcome' },
    h('p', {}, '누구나 쉽게, 그러나 제대로. 편집 경험에 맞춰 시작해 보세요. 언제든 오른쪽 위에서 바꿀 수 있어요.'),
    h('div', { class: 'welcome-cards' },
      h('button', { class: 'welcome-card', onclick: () => pick('easy') },
        h('span', { class: 'wc-icon' }, '🌱'), h('b', {}, '심플'), h('span', { class: 'muted small' }, '편집이 처음이에요. 단계별 안내와 자동 기능으로 빠르게 완성할래요.')),
      h('button', { class: 'welcome-card', onclick: () => pick('pro') },
        h('span', { class: 'wc-icon' }, '🎛'), h('b', {}, '전문가'), h('span', { class: 'muted small' }, '편집해 봤어요. 단축키, 세부 수치, 타임코드를 쓰고 싶어요.'))),
    h('p', { class: 'muted small' }, '🔒 모든 작업은 내 컴퓨터 브라우저 안에서만 처리되고, 어디에도 업로드되지 않아요.'),
  ), { onClose: () => saveNow() });
}

boot();

// 디버깅/테스트용
window.editin = { state, engine, timeline, inspector, project, mutate, importFiles: doImport };
