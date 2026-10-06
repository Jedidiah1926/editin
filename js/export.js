// 내보내기: 점검 → 설정 → 실시간 렌더링(MediaRecorder) → 다운로드

import { state, project, projectDuration, emit } from './store.js';
import { h, modal, toast, download, fmtTime } from './ui.js';
import { runChecks } from './smart.js';

const FORMATS = [
  { id: 'mp4', mime: ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=avc1.640028,opus', 'video/mp4;codecs=avc1,opus', 'video/mp4'], ext: 'mp4', name: 'MP4', hint: '어디서나 재생 (추천)' },
  { id: 'webm', mime: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'], ext: 'webm', name: 'WebM', hint: '웹·유튜브 업로드용' },
];

const QUALITIES = [
  { id: 'high', name: '고화질', mbps: 12 },
  { id: 'mid', name: '보통', mbps: 6 },
  { id: 'low', name: '용량 작게', mbps: 2.5 },
];

function supported(fmt) {
  if (typeof MediaRecorder === 'undefined') return null;
  return fmt.mime.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

export function openExport(engine) {
  const p = project();
  const dur = projectDuration();
  const checks = runChecks();
  const errors = checks.filter((c) => c.level === 'error');
  const formats = FORMATS.map((f) => ({ ...f, mime: supported(f) })).filter((f) => f.mime);
  const opts = {
    format: formats[0]?.id,
    quality: 'high',
    res: 1,
    range: state.inPoint != null || state.outPoint != null ? 'io' : 'all',
    name: p.name,
  };

  const checkList = h('div', { class: 'checks' });
  const renderChecks = () => {
    const list = runChecks();
    checkList.replaceChildren();
    if (!list.length) {
      checkList.append(h('div', { class: 'check-item ok' }, '✅ 문제 없이 깔끔해요! 바로 내보낼 수 있어요.'));
      return;
    }
    for (const c of list) {
      const icon = c.level === 'error' ? '⛔' : c.level === 'warn' ? '⚠️' : '💡';
      checkList.append(h('div', { class: `check-item ${c.level}` },
        h('span', {}, `${icon} ${c.msg}`),
        c.fix ? h('button', { class: 'btn small', onclick: () => { c.fix(); renderChecks(); toast('고쳤어요'); } }, c.fixLabel || '고치기') : null));
    }
  };
  renderChecks();

  if (!formats.length) {
    modal('내보내기', h('p', {}, '이 브라우저는 영상 내보내기를 지원하지 않아요. 최신 Chrome 또는 Edge를 사용해 주세요.'));
    return;
  }

  const seg = (items, key, label) => h('div', { class: 'ctl' }, h('label', {}, label), h('div', { class: 'seg' }, items.map(([v, t, hint]) => {
    const b = h('button', { class: opts[key] === v ? 'active' : '', title: hint || '', onclick: () => { opts[key] = v; b.parentNode.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b)); updateInfo(); } }, t);
    return b;
  })));

  const info = h('div', { class: 'muted small' });
  const range = () => {
    if (opts.range === 'io') return [state.inPoint ?? 0, Math.min(state.outPoint ?? dur, dur)];
    return [0, dur];
  };
  const updateInfo = () => {
    const [a, b] = range();
    const q = QUALITIES.find((x) => x.id === opts.quality);
    const mb = ((q.mbps * opts.res * opts.res + 0.16) * (b - a)) / 8;
    info.textContent = `${Math.round(p.width * opts.res)}×${Math.round(p.height * opts.res)} · ${fmtTime(b - a)} 길이 · 예상 용량 약 ${mb < 1 ? mb.toFixed(1) : Math.round(mb)}MB · 영상 길이만큼 시간이 걸려요`;
  };
  updateInfo();

  const nameInput = h('input', { class: 'text-input', value: opts.name, 'aria-label': '파일 이름' });
  nameInput.addEventListener('input', () => { opts.name = nameInput.value; });

  const body = h('div', { class: 'export' },
    h('h3', {}, '1. 내보내기 전 점검'),
    checkList,
    h('h3', {}, '2. 설정'),
    h('div', { class: 'ctl' }, h('label', {}, '파일 이름'), nameInput),
    seg(formats.map((f) => [f.id, f.name, f.hint]), 'format', '형식'),
    seg(QUALITIES.map((q) => [q.id, q.name]), 'quality', '화질'),
    seg([[1, '원본 해상도'], [2 / 3, '2/3 크기'], [0.5, '절반 크기']], 'res', '해상도'),
    state.inPoint != null || state.outPoint != null ? seg([['all', '전체'], ['io', '지정한 구간(I~O)']], 'range', '범위') : null,
    info,
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: () => close() }, '취소'),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          if (runChecks().some((c) => c.level === 'error') && !confirm('해결되지 않은 문제가 있어요. 그래도 내보낼까요?')) return;
          close();
          render(engine, opts, formats.find((f) => f.id === opts.format), range());
        },
      }, '🎬 내보내기 시작'),
    ),
  );
  const close = modal('영상 내보내기', body, { wide: true });
  if (errors.length) toast('점검 결과를 확인해 주세요', { type: 'error' });
}

async function render(engine, opts, fmt, [a, b]) {
  const p = project();
  const W = Math.round((p.width * opts.res) / 2) * 2;
  const H = Math.round((p.height * opts.res) / 2) * 2;
  const q = QUALITIES.find((x) => x.id === opts.quality);
  engine.pause();
  engine.exporting = true;
  engine.resize(W, H);
  if (engine.audioCtx.state === 'suspended') await engine.audioCtx.resume();

  const bar = h('div', { class: 'progress-bar' });
  const label = h('div', { class: 'progress-label' }, '준비 중…');
  let cancelled = false;
  const closeModal = modal('내보내는 중', h('div', { class: 'export-progress' },
    h('div', { class: 'progress' }, bar),
    label,
    h('p', { class: 'muted small' }, '내보내는 동안 이 탭을 열어 두세요. 다른 탭으로 이동하면 영상이 끊길 수 있어요.'),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => { cancelled = true; stop(); } }, '취소')),
  ), { locked: true });

  const stream = engine.canvas.captureStream(p.fps);
  const tracks = [...stream.getVideoTracks(), ...engine.recordDest.stream.getAudioTracks()];
  const rec = new MediaRecorder(new MediaStream(tracks), {
    mimeType: fmt.mime,
    videoBitsPerSecond: Math.round(q.mbps * 1e6 * opts.res * opts.res),
    audioBitsPerSecond: 192000,
  });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  const finish = () => new Promise((res) => { rec.onstop = res; });
  const done = finish();

  // 시작 위치로 이동 후 첫 프레임이 준비될 때까지 대기
  engine.seek(a);
  await waitReady(engine);

  const timer = setInterval(() => {
    const prog = Math.min(1, (state.time - a) / Math.max(0.01, b - a));
    bar.style.width = `${prog * 100}%`;
    label.textContent = `${Math.round(prog * 100)}% · ${fmtTime(state.time - a)} / ${fmtTime(b - a)}`;
  }, 200);

  function stop() {
    engine.onEnded = null;
    engine.stopAt = null;
    engine.pause();
    if (rec.state !== 'inactive') rec.stop();
  }

  rec.start(1000);
  engine.stopAt = b;
  engine.onEnded = () => setTimeout(stop, 120);
  engine.play();

  await done;
  clearInterval(timer);
  stream.getTracks().forEach((t) => t.stop());
  engine.exporting = false;
  engine.resize();
  engine.invalidate();
  closeModal();
  if (cancelled) { toast('내보내기를 취소했어요'); return; }
  let blob = new Blob(chunks, { type: fmt.mime.split(';')[0] });
  // 데스크톱 앱: ffmpeg로 마무리 (소리를 AAC로, 빠른 재생 시작) → 어떤 플레이어에서도 재생되는 MP4
  if (window.editinNative?.finalizeVideo && fmt.ext === 'mp4') {
    const closeFin = modal('마무리 중', h('div', { class: 'export-progress' }, h('p', {}, '어디서나 재생되도록 파일을 다듬는 중이에요…')), { locked: true });
    try {
      const out = await window.editinNative.finalizeVideo(await blob.arrayBuffer());
      if (out?.byteLength) blob = new Blob([out], { type: 'video/mp4' });
    } catch (err) {
      console.error(err);
    } finally {
      closeFin();
    }
  }
  const fname = `${(opts.name || 'video').replace(/[\\/:*?"<>|]/g, '_')}.${fmt.ext}`;
  download(blob, fname);
  emit('exported');
  let closeDone = null;
  closeDone = modal('완성! 🎉', h('div', {},
    h('p', {}, `'${fname}' 파일을 저장했어요 (${(blob.size / 1e6).toFixed(1)}MB).`),
    h('p', { class: 'muted small' }, '다운로드 폴더를 확인해 보세요.'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: () => download(blob, fname) }, '다시 저장'),
      h('button', { class: 'btn primary', onclick: () => closeDone() }, '확인'))));
}

function waitReady(engine) {
  return new Promise((res) => {
    let n = 0;
    const tick = () => {
      n++;
      const entries = engine.activeEntries(state.time);
      engine.sync(entries, state.time);
      if ((engine.isReady(entries) && n > 3) || n > 120) { engine.frame(state.time); res(); } else requestAnimationFrame(tick);
    };
    tick();
  });
}
