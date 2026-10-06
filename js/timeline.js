// 타임라인: 트랙/클립 표시, 드래그 이동·트리밍, 스냅, 스크럽, 마커

import {
  state, project, on, emit, mediaRuntime, mediaById, clipEnd, clipsOnTrack, trackById, setSelection,
  beginGesture, mutateLive, endGesture, mutate, maxDurFor, projectDuration, clipById,
} from './store.js';
import { h, fmtTime, fmtTimecode, clamp, toast } from './ui.js';
import { addMediaClip, kindForMedia, addTrack } from './ops.js';
import { importFiles } from './media.js';

const PAD = 16; // 0초 왼쪽 여백(px)
const RULER_H = 28;
const TRACK_H = { video: 68, text: 38, audio: 52 };
const SNAP_PX = 9;

export class Timeline {
  constructor(root, engine, actions) {
    this.root = root;
    this.engine = engine;
    this.actions = actions; // { contextMenu(clip, x, y) }
    this.heads = h('div', { class: 'tl-heads' });
    this.headsInner = h('div', { class: 'tl-heads-inner' });
    this.heads.append(this.headsInner);
    this.scroll = h('div', { class: 'tl-scroll', tabindex: '-1' });
    this.inner = h('div', { class: 'tl-inner' });
    this.ruler = h('canvas', { class: 'tl-ruler', height: RULER_H });
    this.rulerWrap = h('div', { class: 'tl-ruler-wrap' }, this.ruler);
    this.lanes = h('div', { class: 'tl-lanes' });
    this.markers = h('div', { class: 'tl-markers' });
    this.playhead = h('div', { class: 'tl-playhead' }, h('div', { class: 'tl-playhead-head' }));
    this.snapLine = h('div', { class: 'tl-snap' });
    this.ioRange = h('div', { class: 'tl-io' });
    this.tip = h('div', { class: 'tl-tip' });
    this.dropMark = h('div', { class: 'tl-drop' });
    this.empty = h('div', { class: 'tl-empty' },
      h('div', { class: 'tl-empty-icon' }, '🎬'),
      h('div', {}, '영상·사진·음악을 여기로 끌어다 놓으세요'),
      h('div', { class: 'muted small' }, '또는 왼쪽 미디어에서 + 버튼을 누르면 순서대로 이어 붙어요'));
    this.inner.append(this.rulerWrap, this.markers, this.lanes, this.ioRange, this.snapLine, this.playhead, this.dropMark);
    this.scroll.append(this.inner, this.tip);
    root.append(this.heads, this.scroll, this.empty);

    this.scroll.addEventListener('scroll', () => {
      this.headsInner.style.transform = `translateY(${-this.scroll.scrollTop}px)`;
      this.drawRuler();
    });
    this.scroll.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.rulerWrap.addEventListener('pointerdown', (e) => this.startScrub(e));
    this.playhead.addEventListener('pointerdown', (e) => this.startScrub(e));
    this.lanes.addEventListener('pointerdown', (e) => this.onLanePointerDown(e));
    this.lanes.addEventListener('dblclick', (e) => {
      const el = e.target.closest('.clip');
      if (el) emit('clip-dblclick', el.dataset.id);
    });
    this.lanes.addEventListener('contextmenu', (e) => {
      const el = e.target.closest('.clip');
      if (!el) return;
      e.preventDefault();
      if (!state.selection.has(el.dataset.id)) setSelection([el.dataset.id]);
      this.actions.contextMenu?.(clipById(el.dataset.id), e.clientX, e.clientY);
    });
    this.setupDrop();
    new ResizeObserver(() => { this.layoutWidth(); this.drawRuler(); }).observe(this.scroll);

    on('project', ({ live } = {}) => this.render(live));
    on('selection', () => this.updateSelection());
    on('time', () => this.updatePlayhead());
    on('media-analyzed', () => this.render());
    on('zoom', () => this.render());
    on('io', () => this.updateIO());
    on('mode', () => this.render());
    this.render();
  }

  get zoom() { return state.zoom; }
  x(t) { return PAD + t * this.zoom; }
  t(x) { return (x - PAD) / this.zoom; }

  contentWidth() {
    const dur = Math.max(projectDuration(), 30);
    return Math.max(this.scroll.clientWidth, this.x(dur) + 400);
  }

  layoutWidth() {
    this.inner.style.width = `${this.contentWidth()}px`;
  }

  // ---------- 렌더링 ----------

  render(live = false) {
    if (live && this.tryLiveUpdate()) return;
    const p = project();
    this.layoutWidth();
    this.headsInner.replaceChildren(h('div', { class: 'tl-head-spacer', style: { height: `${RULER_H}px` } }));
    this.lanes.replaceChildren();
    this.markers.replaceChildren();
    this.laneEls = new Map();
    for (const tr of p.tracks) {
      const hgt = TRACK_H[tr.kind];
      this.headsInner.append(this.trackHead(tr, hgt));
      const lane = h('div', { class: `lane lane-${tr.kind} ${tr.hidden || tr.muted ? 'dim' : ''} ${tr.locked ? 'locked' : ''}`, 'data-track': tr.id, style: { height: `${hgt}px` } });
      this.laneEls.set(tr.id, lane);
      for (const c of clipsOnTrack(tr.id)) lane.append(this.clipEl(c, hgt));
      this.lanes.append(lane);
    }
    this.headsInner.append(h('div', { class: 'tl-add-track' },
      h('button', { class: 'btn ghost small', onclick: (e) => this.addTrackMenu(e) }, '+ 레이어 추가')));
    // 마커
    for (const mk of p.markers) {
      const m = h('div', { class: 'tl-marker', style: { left: `${this.x(mk.t)}px` }, title: mk.label || '마커 (더블클릭: 이름, 우클릭: 삭제)' }, mk.label ? h('span', {}, mk.label) : null);
      m.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.engine.seek(mk.t); });
      m.addEventListener('dblclick', () => {
        const label = prompt('마커 이름', mk.label || '');
        if (label != null) mutate('마커 이름 변경', (pp) => { pp.markers.find((x) => x.id === mk.id).label = label; });
      });
      m.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        mutate('마커 삭제', (pp) => { pp.markers = pp.markers.filter((x) => x.id !== mk.id); });
      });
      this.markers.append(m);
    }
    this.empty.style.display = p.clips.length ? 'none' : '';
    this.updatePlayhead();
    this.updateIO();
    this.drawRuler();
    this.updateSelection();
  }

  /** 드래그 중에는 바뀐 클립만 갱신 (전체 재생성 방지) */
  tryLiveUpdate() {
    const p = project();
    if (!this.laneEls || p.tracks.length !== this.laneEls.size) return false;
    const els = new Map([...this.lanes.querySelectorAll('.clip')].map((el) => [el.dataset.id, el]));
    if (els.size !== p.clips.length) return false;
    for (const c of p.clips) {
      let el = els.get(c.id);
      const lane = this.laneEls.get(c.trackId);
      if (!el || !lane) return false;
      if (el._dur !== c.dur || el._in !== c.in || el._txt !== c.text?.content || el._role !== c.text?.role) {
        const fresh = this.clipEl(c, TRACK_H[trackById(c.trackId).kind]);
        fresh.classList.toggle('selected', state.selection.has(c.id));
        el.replaceWith(fresh);
        el = fresh;
      }
      if (el.parentNode !== lane) lane.append(el);
      el.style.left = `${this.x(c.start)}px`;
    }
    this.layoutWidth();
    return true;
  }

  trackHead(tr, hgt) {
    const icon = { video: '🎞', text: 'T', audio: '♪' }[tr.kind];
    const btn = (on, label, title, fn) => h('button', { class: `th-btn ${on ? 'on' : ''}`, title, 'aria-pressed': on ? 'true' : 'false', onclick: fn }, label);
    const toggle = (key, label) => () => mutate(label, () => { tr[key] = !tr[key]; });
    const head = h('div', { class: `track-head th-${tr.kind}`, style: { height: `${hgt}px` } },
      h('span', { class: 'th-icon' }, icon),
      h('span', { class: 'th-name', title: '더블클릭하여 이름 변경' }, tr.name),
      h('span', { class: 'th-btns' },
        tr.magnetic ? h('span', { class: 'th-magnet', title: '자석 레이어: 클립이 빈틈없이 자동으로 붙어요' }, '🧲') : null,
        tr.kind !== 'audio' ? btn(tr.hidden, tr.hidden ? '🙈' : '👁', tr.hidden ? '보이기' : '숨기기', toggle('hidden', '레이어 표시 전환')) : null,
        tr.kind !== 'text' ? btn(tr.muted, tr.muted ? '🔇' : '🔊', tr.muted ? '소리 켜기' : '음소거', toggle('muted', '레이어 음소거 전환')) : null,
        btn(tr.locked, tr.locked ? '🔒' : '🔓', tr.locked ? '잠금 해제' : '잠그기 (실수로 수정 방지)', toggle('locked', '레이어 잠금 전환')),
        h('button', { class: 'th-btn th-more', title: '레이어 메뉴', 'aria-label': `${tr.name} 레이어 메뉴`, onclick: (e) => this.trackMenu(tr, e) }, '⋯'),
      ),
    );
    head.querySelector('.th-name').addEventListener('dblclick', () => this.renameTrack(tr));
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); this.trackMenu(tr, e); });
    return head;
  }

  renameTrack(tr) {
    const name = prompt('레이어 이름', tr.name);
    if (name) mutate('레이어 이름 변경', (p) => { p.tracks.find((x) => x.id === tr.id).name = name; });
  }

  /** 같은 종류 레이어끼리 순서 바꾸기 (영상은 위에 있을수록 화면 앞쪽) */
  moveTrack(tr, dir) {
    const p = project();
    const i = p.tracks.findIndex((x) => x.id === tr.id);
    const j = i + dir;
    if (j < 0 || j >= p.tracks.length || p.tracks[j].kind !== tr.kind) return false;
    mutate(dir < 0 ? '레이어 위로' : '레이어 아래로', (pp) => {
      const a = pp.tracks.findIndex((x) => x.id === tr.id);
      [pp.tracks[a], pp.tracks[a + dir]] = [pp.tracks[a + dir], pp.tracks[a]];
    });
    return true;
  }

  trackMenu(tr, e) {
    const p = project();
    const i = p.tracks.findIndex((x) => x.id === tr.id);
    const n = p.clips.filter((c) => c.trackId === tr.id).length;
    const base = ['t1', 'v1', 'a1'].includes(tr.id);
    const canUp = i > 0 && p.tracks[i - 1].kind === tr.kind;
    const canDown = i < p.tracks.length - 1 && p.tracks[i + 1].kind === tr.kind;
    const kindName = { video: '영상', text: '자막', audio: '오디오' }[tr.kind];
    this.actions.menu?.(e.clientX, e.clientY, [
      { label: '✏️ 이름 바꾸기', run: () => this.renameTrack(tr) },
      { label: tr.kind === 'video' ? '⬆ 위로 (화면 앞쪽으로)' : '⬆ 위로', disabled: !canUp, run: () => this.moveTrack(tr, -1) },
      { label: tr.kind === 'video' ? '⬇ 아래로 (화면 뒤쪽으로)' : '⬇ 아래로', disabled: !canDown, run: () => this.moveTrack(tr, 1) },
      { label: `+ ${kindName} 레이어 추가`, run: () => this.addLayer(tr.kind) },
      '-',
      {
        label: base ? '기본 레이어는 삭제할 수 없어요' : n ? `🗑 레이어 삭제 (클립 ${n}개 포함)` : '🗑 레이어 삭제',
        danger: !base, disabled: base,
        run: () => {
          mutate('레이어 삭제', (pp) => {
            pp.tracks = pp.tracks.filter((x) => x.id !== tr.id);
            pp.clips = pp.clips.filter((c) => c.trackId !== tr.id);
          });
          toast(n ? `레이어와 클립 ${n}개를 삭제했어요 (${'Ctrl'}+Z로 되돌리기)` : '레이어를 삭제했어요');
        },
      },
    ]);
  }

  addLayer(kind) {
    let t = null;
    mutate('레이어 추가', (p) => { t = addTrack(p, kind); });
    toast(`'${t.name}' 레이어를 추가했어요${kind === 'video' ? ' · 위쪽 레이어일수록 화면 앞에 보여요' : ''}`);
  }

  addTrackMenu(e) {
    this.actions.menu?.(e.clientX, e.clientY, [
      { label: '🎞 영상 레이어 (오버레이 · 화면 속 화면)', run: () => this.addLayer('video') },
      { label: 'T 자막 레이어', run: () => this.addLayer('text') },
      { label: '♪ 오디오 레이어 (음악 · 효과음)', run: () => this.addLayer('audio') },
    ]);
  }

  clipEl(c, laneH) {
    const z = this.zoom;
    const w = Math.max(2, c.dur * z);
    const m = c.mediaId ? mediaById(c.mediaId) : null;
    const rt = c.mediaId ? mediaRuntime.get(c.mediaId) : null;
    const el = h('div', {
      class: `clip clip-${c.type}`,
      'data-id': c.id,
      style: { left: `${this.x(c.start)}px`, width: `${w}px` },
      title: c.type === 'text' ? c.text.content : m?.name,
    });
    const body = h('div', { class: 'clip-body' });
    el.append(body);
    if ((c.type === 'video' || c.type === 'image') && rt?.thumbs) {
      const strip = h('div', { class: 'clip-thumbs' });
      const th = c.type === 'video' && m?.hasAudio !== false ? laneH - 22 : laneH - 6;
      const tw = (rt.thumbs.tw * th) / 48;
      const n = Math.min(300, Math.ceil(w / tw));
      strip.style.setProperty('--sprite', `url("${rt.thumbs.url}")`);
      for (let i = 0; i < n; i++) {
        const tt = (i * tw) / z;
        const src = c.in + tt * c.speed;
        const idx = isFinite(rt.thumbs.interval) ? clamp(Math.floor(src / rt.thumbs.interval), 0, rt.thumbs.count - 1) : 0;
        strip.append(h('div', {
          class: 'tile',
          style: { width: `${tw}px`, height: `${th}px`, backgroundSize: `${rt.thumbs.count * tw}px ${th}px`, backgroundPosition: `${-idx * tw}px 0` },
        }));
      }
      body.append(strip);
    }
    if ((c.type === 'video' || c.type === 'audio') && rt?.wave && m?.hasAudio !== false) {
      const total = (m.duration / c.speed) * z;
      const wave = h('div', {
        class: 'clip-wave',
        style: {
          backgroundImage: `url("${rt.wave.url}")`,
          backgroundSize: `${total}px 100%`,
          backgroundPosition: `${(-c.in / c.speed) * z}px 0`,
          opacity: Math.min(1, 0.35 + c.volume * 0.5),
        },
      });
      body.append(wave);
    }
    const label = c.type === 'text' ? c.text.content.split('\n')[0] : (m?.name || '(미디어 없음)');
    const badges = [];
    if (c.speed !== 1) badges.push(h('span', { class: 'badge' }, `${c.speed}x`));
    if (c.type === 'text' && c.text.role === 'highlight') {
      el.classList.add('clip-hl');
      badges.unshift(h('span', { class: 'badge', title: '강조 자막' }, '⭐'));
    }
    if (c.color.filter !== 'none' || c.color.brightness || c.color.contrast || c.color.saturation || c.color.temperature) badges.push(h('span', { class: 'badge', title: '색감 적용됨' }, '🎨'));
    if (c.motion !== 'none') badges.push(h('span', { class: 'badge', title: '움직임 효과' }, '↗'));
    if (c.duck) badges.push(h('span', { class: 'badge', title: '목소리 나올 때 자동으로 작아짐' }, '자동볼륨'));
    if (c.volume === 0 && c.type !== 'text' && c.type !== 'image') badges.push(h('span', { class: 'badge' }, '🔇'));
    body.append(h('div', { class: 'clip-label' }, h('span', { class: 'clip-name' }, label), ...badges));
    if (c.fadeIn > 0) body.append(h('div', { class: 'fade fade-in', style: { width: `${c.fadeIn * z}px` } }));
    if (c.fadeOut > 0) body.append(h('div', { class: 'fade fade-out', style: { width: `${c.fadeOut * z}px` } }));
    if (c.transition && c.transition.type !== 'none') {
      el.append(h('div', { class: 'clip-trans', style: { width: `${Math.min(w, c.transition.dur * z)}px` }, title: `전환 효과: ${c.transition.type}` }));
    }
    if (m && rt == null) el.classList.add('offline');
    el._dur = c.dur;
    el._in = c.in;
    el._txt = c.text?.content;
    el._role = c.text?.role;
    el.append(h('div', { class: 'handle h-l', title: '끌어서 시작 부분 다듬기' }), h('div', { class: 'handle h-r', title: '끌어서 끝 부분 다듬기' }));
    return el;
  }

  updateSelection() {
    for (const el of this.lanes.querySelectorAll('.clip')) el.classList.toggle('selected', state.selection.has(el.dataset.id));
  }

  updatePlayhead() {
    const x = this.x(state.time);
    this.playhead.style.transform = `translateX(${x}px)`;
    if (this.engine.playing && !this.dragging) {
      const sl = this.scroll.scrollLeft;
      const vw = this.scroll.clientWidth;
      if (x > sl + vw - 60) this.scroll.scrollLeft = x - 120;
      else if (x < sl) this.scroll.scrollLeft = Math.max(0, x - 120);
    }
  }

  updateIO() {
    const { inPoint, outPoint } = state;
    if (inPoint == null && outPoint == null) { this.ioRange.style.display = 'none'; return; }
    const a = inPoint ?? 0;
    const b = outPoint ?? projectDuration();
    this.ioRange.style.display = '';
    this.ioRange.style.left = `${this.x(a)}px`;
    this.ioRange.style.width = `${Math.max(0, (b - a) * this.zoom)}px`;
  }

  drawRuler() {
    const cv = this.ruler;
    const vw = this.scroll.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(vw * dpr)) {
      cv.width = Math.round(vw * dpr);
      cv.height = Math.round(RULER_H * dpr);
      cv.style.width = `${vw}px`;
      cv.style.height = `${RULER_H}px`;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, RULER_H);
    const sl = this.scroll.scrollLeft;
    const z = this.zoom;
    const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let major = steps.find((s) => s * z >= 80) || 600;
    const minor = major / (major >= 1 ? 5 : 2);
    const t0 = Math.max(0, this.t(sl) - major);
    const t1 = this.t(sl + vw) + major;
    const style = getComputedStyle(this.root);
    ctx.strokeStyle = style.getPropertyValue('--tl-tick') || '#555';
    ctx.fillStyle = style.getPropertyValue('--tl-text') || '#aaa';
    ctx.font = '11px system-ui, sans-serif';
    ctx.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(this.x(t) - sl) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, isMajor ? RULER_H - 12 : RULER_H - 5);
      if (isMajor) ctx.fillText(state.mode === 'pro' && major < 1 ? fmtTimecode(t, project().fps).slice(3) : fmtTime(t).replace(/\.0$/, ''), x + 4, 12);
    }
    ctx.stroke();
  }

  // ---------- 확대/축소 ----------

  setZoom(z, anchorClientX) {
    const old = state.zoom;
    z = clamp(z, 4, 600);
    if (z === old) return;
    const rect = this.scroll.getBoundingClientRect();
    const ax = anchorClientX != null ? anchorClientX - rect.left : this.x(state.time) - this.scroll.scrollLeft;
    const tAnchor = this.t(this.scroll.scrollLeft + ax);
    state.zoom = z;
    emit('zoom');
    this.scroll.scrollLeft = Math.max(0, this.x(tAnchor) - ax);
    this.drawRuler();
  }

  zoomToFit() {
    const dur = Math.max(projectDuration(), 5);
    this.setZoom((this.scroll.clientWidth - PAD - 60) / dur);
    this.scroll.scrollLeft = 0;
  }

  onWheel(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0025);
      this.setZoom(state.zoom * factor, e.clientX);
    } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.scroll.scrollHeight <= this.scroll.clientHeight + 2) {
      // 세로로 스크롤할 게 없으면 휠로 가로 이동
      e.preventDefault();
      this.scroll.scrollLeft += e.deltaY;
    }
  }

  // ---------- 스냅 ----------

  snapPoints(excludeIds) {
    const pts = [0, state.time];
    for (const c of project().clips) {
      if (excludeIds.has(c.id)) continue;
      pts.push(c.start, clipEnd(c));
    }
    for (const m of project().markers) pts.push(m.t);
    if (state.inPoint != null) pts.push(state.inPoint);
    if (state.outPoint != null) pts.push(state.outPoint);
    return pts;
  }

  /** times 중 하나라도 스냅 지점과 가까우면 보정값 반환 */
  snap(times, pts, disabled) {
    if (!state.snap || disabled) { this.snapLine.style.display = 'none'; return 0; }
    const thr = SNAP_PX / this.zoom;
    let best = null;
    for (const t of times) {
      for (const p of pts) {
        const d = p - t;
        if (Math.abs(d) < thr && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, p };
      }
    }
    if (best) {
      this.snapLine.style.display = 'block';
      this.snapLine.style.transform = `translateX(${this.x(best.p)}px)`;
      return best.d;
    }
    this.snapLine.style.display = 'none';
    return 0;
  }

  // ---------- 포인터 조작 ----------

  clientToTime(clientX) {
    const rect = this.scroll.getBoundingClientRect();
    return this.t(clientX - rect.left + this.scroll.scrollLeft);
  }

  startScrub(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const wasPlaying = this.engine.playing;
    if (wasPlaying) this.engine.pause();
    this.dragging = true;
    const move = (ev) => {
      let t = Math.max(0, this.clientToTime(ev.clientX));
      if (!ev.shiftKey) {
        const pts = this.snapPoints(new Set()).slice(2);
        t += this.snap([t], pts, false);
      }
      this.engine.seek(t);
    };
    move(e);
    const up = () => {
      this.dragging = false;
      this.snapLine.style.display = 'none';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  onLanePointerDown(e) {
    if (e.button !== 0) return;
    const clipDiv = e.target.closest('.clip');
    if (!clipDiv) {
      // 빈 곳 클릭: 선택 해제 + 재생 위치 이동
      setSelection([]);
      this.startScrub(e);
      return;
    }
    const c = clipById(clipDiv.dataset.id);
    if (!c) return;
    const tr = trackById(c.trackId);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive) setSelection([c.id], true);
    else if (!state.selection.has(c.id)) setSelection([c.id]);
    if (tr?.locked) { toast('잠긴 레이어예요. 🔒을 눌러 잠금을 풀어 주세요.'); return; }
    if (e.target.classList.contains('h-l')) this.startTrim(e, c, 'l');
    else if (e.target.classList.contains('h-r')) this.startTrim(e, c, 'r');
    else if (!additive) this.startMove(e, c);
  }

  startMove(e, c) {
    e.preventDefault();
    const startX = e.clientX;
    const ids = state.selection.has(c.id) ? [...state.selection] : [c.id];
    const clips = ids.map(clipById).filter((x) => x && !trackById(x.trackId)?.locked);
    const orig = new Map(clips.map((x) => [x.id, { start: x.start, trackId: x.trackId }]));
    const exclude = new Set(clips.map((x) => x.id));
    const pts = this.snapPoints(exclude);
    const kind = trackById(c.trackId).kind;
    let moved = false;
    let targetTrack = c.trackId;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 4 && Math.abs(ev.clientY - e.clientY) < 6) return;
      if (!moved) { moved = true; beginGesture(); this.dragging = true; document.body.classList.add('dragging'); }
      let dt = dx / this.zoom;
      const minStart = Math.min(...clips.map((x) => orig.get(x.id).start));
      dt = Math.max(dt, -minStart);
      const o = orig.get(c.id);
      dt += this.snap([o.start + dt, o.start + c.dur + dt], pts, ev.shiftKey);
      dt = Math.max(dt, -minStart);
      // 단일 클립은 다른 트랙(같은 종류)으로 이동 가능
      if (clips.length === 1) {
        const laneEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.lane');
        const tid = laneEl?.dataset.track;
        const tt = tid && trackById(tid);
        if (tt && tt.kind === kind && !tt.locked) targetTrack = tid;
      }
      mutateLive(() => {
        for (const x of clips) {
          x.start = orig.get(x.id).start + dt;
          if (clips.length === 1) x.trackId = targetTrack;
        }
      });
      this.showTip(ev, `${fmtTime(c.start)}${targetTrack !== orig.get(c.id).trackId ? ` · ${trackById(targetTrack).name}` : ''}`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.snapLine.style.display = 'none';
      this.hideTip();
      this.dragging = false;
      document.body.classList.remove('dragging');
      if (!moved) return;
      // 놓을 때 정리: 자석 트랙은 순서 재배치, 일반 트랙은 겹치면 다른 트랙으로
      mutateLive((p) => {
        for (const x of clips) {
          const tr = trackById(x.trackId);
          if (tr.magnetic) {
            const others = clipsOnTrack(tr.id).filter((o) => o.id !== x.id);
            const center = x.start + x.dur / 2;
            let placed = false;
            for (const o of others) {
              if (center < o.start + o.dur / 2) { x.start = o.start - 0.0005; placed = true; break; }
            }
            if (!placed) x.start = others.length ? clipEnd(others[others.length - 1]) + 1 : x.start;
          } else {
            const overlap = p.clips.some((o) => o.trackId === x.trackId && o.id !== x.id && !exclude.has(o.id) && o.start < clipEnd(x) - 1e-3 && clipEnd(o) > x.start + 1e-3);
            if (overlap) {
              let free = p.tracks.find((t) => t.kind === tr.kind && !t.magnetic && !t.locked && !p.clips.some((o) => o.trackId === t.id && o.id !== x.id && o.start < clipEnd(x) - 1e-3 && clipEnd(o) > x.start + 1e-3));
              if (!free) free = addTrack(p, tr.kind);
              x.trackId = free.id;
              toast(`겹치지 않도록 '${free.name}' 레이어로 옮겼어요`);
            }
          }
        }
      });
      endGesture('클립 이동');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  startTrim(e, c, side) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const o = { start: c.start, dur: c.dur, in: c.in };
    const tr = trackById(c.trackId);
    const neighbors = clipsOnTrack(c.trackId).filter((x) => x.id !== c.id);
    const prevEnd = tr.magnetic ? 0 : neighbors.filter((x) => clipEnd(x) <= o.start + 1e-3).reduce((m, x) => Math.max(m, clipEnd(x)), 0);
    const nextStart = tr.magnetic ? Infinity : neighbors.filter((x) => x.start >= o.start + o.dur - 1e-3).reduce((m, x) => Math.min(m, x.start), Infinity);
    const pts = this.snapPoints(new Set([c.id]));
    const isMedia = c.type === 'video' || c.type === 'audio';
    beginGesture();
    this.dragging = true;
    document.body.classList.add('dragging');
    const move = (ev) => {
      let dt = (ev.clientX - startX) / this.zoom;
      if (side === 'l') {
        dt += this.snap([o.start + dt], pts, ev.shiftKey);
        let minDt = isMedia ? -o.in / c.speed : -Infinity;
        minDt = Math.max(minDt, prevEnd - o.start);
        dt = clamp(dt, minDt, o.dur - 0.1);
        mutateLive(() => {
          c.start = o.start + dt;
          c.dur = o.dur - dt;
          if (isMedia || c.type === 'video') c.in = o.in + dt * c.speed;
        });
        this.showTip(ev, `시작 ${fmtTime(c.start)} · 길이 ${c.dur.toFixed(1)}초`);
      } else {
        dt += this.snap([o.start + o.dur + dt], pts, ev.shiftKey);
        let maxDur = Math.min(maxDurFor({ ...c, in: o.in }), nextStart - o.start);
        const nd = clamp(o.dur + dt, 0.1, maxDur);
        mutateLive(() => { c.dur = nd; });
        this.showTip(ev, `길이 ${c.dur.toFixed(1)}초${nd >= maxDur - 1e-3 && isMedia ? ' (원본 끝)' : ''}`);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.snapLine.style.display = 'none';
      this.hideTip();
      this.dragging = false;
      document.body.classList.remove('dragging');
      endGesture('클립 길이 조절');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  showTip(ev, text) {
    const rect = this.scroll.getBoundingClientRect();
    this.tip.textContent = text;
    this.tip.style.display = 'block';
    this.tip.style.left = `${ev.clientX - rect.left + this.scroll.scrollLeft + 12}px`;
    this.tip.style.top = `${ev.clientY - rect.top + this.scroll.scrollTop - 30}px`;
  }

  hideTip() { this.tip.style.display = 'none'; }

  // ---------- 끌어다 놓기 ----------

  setupDrop() {
    const lanes = this.root;
    const laneAt = (ev) => document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.lane');
    lanes.addEventListener('dragover', (ev) => {
      const types = ev.dataTransfer.types;
      if (!types.includes('application/x-editin-media') && !types.includes('Files')) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      const t = Math.max(0, this.clientToTime(ev.clientX));
      const lane = laneAt(ev);
      this.dropMark.style.display = 'block';
      this.dropMark.style.transform = `translateX(${this.x(t)}px)`;
      this.lanes.querySelectorAll('.lane.drop-target').forEach((l) => l.classList.remove('drop-target'));
      lane?.classList.add('drop-target');
    });
    lanes.addEventListener('dragleave', (ev) => {
      if (!this.root.contains(ev.relatedTarget)) this.clearDrop();
    });
    lanes.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const t = Math.max(0, this.clientToTime(ev.clientX));
      const laneTrack = laneAt(ev)?.dataset.track;
      this.clearDrop();
      const id = ev.dataTransfer.getData('application/x-editin-media');
      if (id) { this.dropMedia(id, t, laneTrack); return; }
      if (ev.dataTransfer.files.length) {
        const { added, errors } = await importFiles([...ev.dataTransfer.files]);
        errors.forEach((er) => toast(er, { type: 'error' }));
        let at = t;
        for (const m of added) {
          const c = this.dropMedia(m.id, at, laneTrack);
          if (c) at = clipEnd(c);
        }
      }
    });
  }

  dropMedia(mediaId, t, laneTrack) {
    const m = mediaById(mediaId);
    if (!m) return null;
    const kind = kindForMedia(m);
    const tr = laneTrack && trackById(laneTrack);
    const trackId = tr && tr.kind === kind && !tr.locked ? tr.id : undefined;
    return addMediaClip(mediaId, { at: t, trackId });
  }

  clearDrop() {
    this.dropMark.style.display = 'none';
    this.lanes.querySelectorAll('.lane.drop-target').forEach((l) => l.classList.remove('drop-target'));
  }
}
