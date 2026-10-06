// 속성 패널: 쉬운 모드는 카드형 프리셋 위주, 전문가 모드는 세부 수치까지

import {
  state, project, on, emit, mutate, beginGesture, mutateLive, endGesture, selectedClips, mediaById, mediaRuntime,
  ASPECTS, maxDurFor, round,
} from './store.js';
import { FILTERS, MOTIONS, TRANSITIONS, TEXT_STYLES, TEXT_ANIMS, SPEEDS, FONT_LIST, textStyleById } from './presets.js';
import { h, fmtDur, toast } from './ui.js';
import { buildFilter } from './engine.js';
import { silenceCut, normalizeLoudness, autoEnhance } from './smart.js';

const SRC = 'inspector';

export class Inspector {
  constructor(root, engine, actions) {
    this.root = root;
    this.engine = engine;
    this.actions = actions;
    this.open = new Set(['basic', 'text', 'look', 'audio']);
    on('selection', () => this.render());
    on('mode', () => this.render());
    on('project', ({ source, live } = {}) => {
      if (source === SRC || live) return;
      this.render();
    });
    on('media-analyzed', () => this.render());
    on('clip-dblclick', () => setTimeout(() => this.root.querySelector('textarea')?.focus(), 30));
    this.render();
  }

  render() {
    const sel = selectedClips();
    const scroll = this.root.scrollTop;
    this.root.replaceChildren();
    if (sel.length === 0) this.renderProject();
    else if (sel.length > 1) this.renderMulti(sel);
    else this.renderClip(sel[0]);
    this.root.scrollTop = scroll;
  }

  // ---------- 공통 컨트롤 ----------

  section(id, title, ...children) {
    const pro = state.mode === 'pro';
    const d = h('details', { class: 'insp-sec', open: this.open.has(id) || pro ? true : null },
      h('summary', {}, title), h('div', { class: 'insp-sec-body' }, ...children));
    d.addEventListener('toggle', () => { if (d.open) this.open.add(id); else this.open.delete(id); });
    return d;
  }

  /** 슬라이더 + 숫자 입력. get/set은 클립 객체 기준 */
  slider(label, { min, max, step = 1, get, set, fmt = (v) => v, label2, reset }) {
    const ids = selectedClips().map((c) => c.id);
    const apply = (v, live) => {
      const fn = (p) => { for (const c of p.clips) if (ids.includes(c.id)) set(c, v); };
      if (live) mutateLive(fn, SRC);
      else mutate(label2 || `${label} 변경`, fn, SRC);
    };
    const v0 = get(selectedClips()[0]);
    const out = h('span', { class: 'sl-val' }, fmt(v0));
    const range = h('input', { type: 'range', min, max, step, value: v0, 'aria-label': label });
    const num = h('input', { type: 'number', class: 'num', min, max, step, value: v0, 'aria-label': `${label} 값` });
    range.addEventListener('pointerdown', () => beginGesture());
    range.addEventListener('input', () => { out.textContent = fmt(+range.value); num.value = range.value; apply(+range.value, true); });
    range.addEventListener('change', () => endGesture(label2 || `${label} 변경`, SRC));
    num.addEventListener('change', () => { range.value = num.value; out.textContent = fmt(+num.value); apply(+num.value, false); });
    const resetBtn = reset != null ? h('button', {
      class: 'icon-btn tiny', title: '기본값으로', onclick: () => { range.value = reset; num.value = reset; out.textContent = fmt(reset); apply(reset, false); },
    }, '↺') : null;
    return h('div', { class: 'ctl slider' },
      h('div', { class: 'ctl-top' }, h('label', {}, label), h('span', { class: 'ctl-right' }, state.mode === 'pro' ? num : out, resetBtn)),
      range);
  }

  cards(items, current, onPick, opts = {}) {
    return h('div', { class: `cards ${opts.cls || ''}` }, items.map((it) => h('button', {
      class: `card ${it.id === current ? 'active' : ''}`,
      title: it.desc || it.name,
      'aria-pressed': it.id === current ? 'true' : 'false',
      onclick: () => onPick(it.id),
    }, opts.render ? opts.render(it) : null, h('span', { class: 'card-name' }, it.name))));
  }

  seg(options, current, onPick) {
    return h('div', { class: 'seg' }, options.map(([v, label]) => h('button', {
      class: v === current ? 'active' : '', 'aria-pressed': v === current ? 'true' : 'false', onclick: () => onPick(v),
    }, label)));
  }

  setAll(label, fn) {
    const ids = selectedClips().map((c) => c.id);
    mutate(label, (p) => { for (const c of p.clips) if (ids.includes(c.id)) fn(c); });
    this.render();
  }

  // ---------- 프로젝트 (선택 없음) ----------

  renderProject() {
    const p = project();
    const nameInput = h('input', { class: 'text-input', value: p.name, 'aria-label': '프로젝트 이름' });
    nameInput.addEventListener('change', () => mutate('이름 변경', (pp) => { pp.name = nameInput.value || '제목 없는 프로젝트'; }, SRC));
    const aspects = Object.entries(ASPECTS).map(([id, a]) => ({ id, name: a.label, desc: a.hint }));
    this.root.append(
      h('div', { class: 'insp-head' }, h('div', { class: 'insp-title' }, '프로젝트 설정'), h('div', { class: 'muted small' }, '클립을 선택하면 여기에서 꾸밀 수 있어요')),
      this.section('basic', '기본',
        h('div', { class: 'ctl' }, h('label', {}, '이름'), nameInput),
        h('div', { class: 'ctl' }, h('label', {}, '화면 비율'),
          this.cards(aspects, p.aspect, (id) => this.actions.setAspect(id), {
            cls: 'aspect-cards',
            render: (it) => {
              const a = ASPECTS[it.id];
              const s = 26 / Math.max(a.width, a.height);
              return h('span', { class: 'aspect-box', style: { width: `${a.width * s}px`, height: `${a.height * s}px` } });
            },
          }),
          h('div', { class: 'muted small' }, ASPECTS[p.aspect].hint)),
        state.mode === 'pro' ? h('div', { class: 'ctl' }, h('label', {}, '프레임 레이트'),
          this.seg([[24, '24'], [25, '25'], [30, '30'], [60, '60']], p.fps, (v) => { mutate('프레임 레이트 변경', (pp) => { pp.fps = v; }); this.render(); })) : null,
        state.mode === 'pro' ? h('div', { class: 'muted small' }, `해상도 ${p.width}×${p.height}`) : null,
      ),
      this.tips(),
    );
  }

  tips() {
    const easy = state.mode === 'easy';
    const list = easy ? [
      ['✂️', '재생 위치에서 <b>S</b> 를 누르면 그 자리에서 잘려요'],
      ['🗑', '필요 없는 부분은 클릭하고 <b>Delete</b> — 빈틈은 자동으로 메워져요'],
      ['↩️', '실수해도 괜찮아요. <b>Ctrl+Z</b> 로 언제든 되돌릴 수 있어요'],
      ['🪄', '<b>스마트</b> 탭의 무음 자동 컷으로 말 없는 부분을 한 번에 정리하세요'],
      ['💾', '작업은 이 브라우저에 자동 저장돼요'],
    ] : [
      ['⌨️', '<b>?</b> 키로 전체 단축키 보기'],
      ['J K L', '셔틀 재생 · <b>I/O</b> 구간 지정 · <b>M</b> 마커'],
      ['Q W', '재생 위치 기준 앞/뒤 리플 트림'],
      ['⇧', 'Shift 드래그로 스냅 일시 해제 · Alt+휠로 확대/축소'],
    ];
    return this.section('tips', '도움말', h('ul', { class: 'tips' }, list.map(([i, t]) => h('li', {}, h('span', { class: 'tip-i' }, i), h('span', { html: t })))));
  }

  // ---------- 여러 클립 ----------

  renderMulti(sel) {
    const media = sel.filter((c) => c.type === 'video' || c.type === 'audio');
    const visual = sel.filter((c) => c.type === 'video' || c.type === 'image');
    const ids = sel.map((c) => c.id);
    this.root.append(
      h('div', { class: 'insp-head' }, h('div', { class: 'insp-title' }, `클립 ${sel.length}개 선택됨`), h('div', { class: 'muted small' }, '아래 변경은 선택한 모든 클립에 적용돼요')),
      visual.length ? this.section('look', '필터', this.filterCards(sel[0])) : null,
      media.length ? this.section('audio', '소리',
        this.slider('볼륨', { min: 0, max: 200, get: (c) => Math.round(c.volume * 100), set: (c, v) => { c.volume = v / 100; }, fmt: (v) => `${v}%`, reset: 100 }),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => { const n = normalizeLoudness(ids); toast(n ? `${n}개 클립의 음량을 맞췄어요` : '맞출 소리가 없어요'); } }, '🔊 음량 고르게'),
          h('button', { class: 'btn', onclick: () => this.actions.openSilence(ids) }, '✂️ 무음 자동 컷'))) : null,
      visual.length ? h('div', { class: 'btn-row pad' }, h('button', { class: 'btn', onclick: () => { autoEnhance(ids); toast('선명하고 생기있게 보정했어요'); } }, '✨ 원클릭 보정')) : null,
      h('div', { class: 'btn-row pad' }, h('button', { class: 'btn danger', onclick: () => this.actions.deleteSelected() }, '선택 클립 삭제')),
    );
  }

  // ---------- 단일 클립 ----------

  renderClip(c) {
    const m = c.mediaId ? mediaById(c.mediaId) : null;
    const typeName = { video: '영상', image: '사진', audio: '오디오', text: '텍스트' }[c.type];
    this.root.append(h('div', { class: 'insp-head' },
      h('div', { class: 'insp-title' }, h('span', { class: `type-dot t-${c.type}` }), typeName, ' 클립'),
      h('div', { class: 'muted small ellipsis' }, c.type === 'text' ? `${fmtDur(c.dur)}` : `${m?.name || ''} · ${fmtDur(c.dur)}`)));

    if (c.type === 'text') this.renderText(c);
    if (c.type === 'video' || c.type === 'image') this.renderVisual(c);
    if (c.type === 'video' || c.type === 'audio') this.renderAudio(c, m);
    this.renderTiming(c);
  }

  renderText(c) {
    const ta = h('textarea', { class: 'text-input big', rows: 3, 'aria-label': '텍스트 내용', placeholder: '내용을 입력하세요 (Enter: 줄바꿈)' }, c.text.content);
    ta.addEventListener('focus', () => beginGesture());
    ta.addEventListener('input', () => mutateLive((p) => { p.clips.find((x) => x.id === c.id).text.content = ta.value; }, SRC));
    ta.addEventListener('blur', () => endGesture('텍스트 수정', SRC));
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    const styleCards = this.cards(TEXT_STYLES, c.text.style, (id) => this.setAll('텍스트 스타일 변경', (x) => {
      const st = textStyleById(id);
      x.text.style = id;
      x.text.x = st.x; x.text.y = st.y; x.text.anim = st.anim;
      delete x.text.color; delete x.text.font; delete x.text.bg; delete x.text.stroke;
    }), { cls: 'text-cards', render: (it) => h('span', { class: `text-sample ts-${it.id}` }, it.sample) });
    const st = textStyleById(c.text.style);
    const colors = ['#ffffff', '#ffe14d', '#ff5c5c', '#4fd1ff', '#7dff9b', '#ff9de2', '#111111'];
    this.root.append(
      this.section('text', '내용', ta),
      this.section('textstyle', '스타일', styleCards),
      this.section('textopt', '글자 꾸미기',
        this.slider('크기', { min: 40, max: 250, get: (x) => Math.round(x.text.size * 100), set: (x, v) => { x.text.size = v / 100; }, fmt: (v) => `${v}%`, reset: 100 }),
        h('div', { class: 'ctl' }, h('label', {}, '색상'), h('div', { class: 'swatches' },
          colors.map((col) => h('button', {
            class: `swatch ${(c.text.color || st.color) === col ? 'active' : ''}`, style: { background: col }, title: col, 'aria-label': `색상 ${col}`,
            onclick: () => this.setAll('글자 색 변경', (x) => { x.text.color = col; }),
          })),
          (() => {
            const inp = h('input', { type: 'color', value: c.text.color || st.color, title: '직접 고르기', 'aria-label': '직접 색상 선택' });
            inp.addEventListener('change', () => this.setAll('글자 색 변경', (x) => { x.text.color = inp.value; }));
            return inp;
          })())),
        h('div', { class: 'ctl' }, h('label', {}, '위치'),
          this.seg([['top', '위'], ['mid', '가운데'], ['bot', '아래']], c.text.y < 0.35 ? 'top' : c.text.y > 0.65 ? 'bot' : 'mid', (v) => this.setAll('글자 위치 변경', (x) => {
            x.text.y = v === 'top' ? 0.13 : v === 'mid' ? 0.5 : 0.87;
            if ((x.text.align || textStyleById(x.text.style).align || 'center') === 'center') x.text.x = 0.5;
          })),
          h('div', { class: 'muted small' }, '미리보기 화면에서 글자를 직접 끌어서 옮길 수도 있어요')),
        h('div', { class: 'ctl' }, h('label', {}, '등장 효과'),
          this.seg(TEXT_ANIMS.map((a) => [a.id, a.name]), c.text.anim ?? st.anim, (v) => this.setAll('등장 효과 변경', (x) => { x.text.anim = v; }))),
        state.mode === 'pro' ? h('div', { class: 'ctl' }, h('label', {}, '글꼴'), (() => {
          const s = h('select', { class: 'text-input', 'aria-label': '글꼴' }, FONT_LIST.map((f) => h('option', { value: f, selected: (c.text.font || st.font) === f ? true : null }, f)));
          s.addEventListener('change', () => this.setAll('글꼴 변경', (x) => { x.text.font = s.value; }));
          return s;
        })()) : null,
        state.mode === 'pro' ? this.slider('X 위치', { min: 0, max: 100, get: (x) => Math.round(x.text.x * 100), set: (x, v) => { x.text.x = v / 100; }, fmt: (v) => `${v}%` }) : null,
        state.mode === 'pro' ? this.slider('Y 위치', { min: 0, max: 100, get: (x) => Math.round(x.text.y * 100), set: (x, v) => { x.text.y = v / 100; }, fmt: (v) => `${v}%` }) : null,
        state.mode === 'pro' ? this.slider('회전', { min: -180, max: 180, get: (x) => x.transform.rotation, set: (x, v) => { x.transform.rotation = v; }, fmt: (v) => `${v}°`, reset: 0 }) : null,
        this.slider('불투명도', { min: 0, max: 100, get: (x) => Math.round(x.transform.opacity * 100), set: (x, v) => { x.transform.opacity = v / 100; }, fmt: (v) => `${v}%`, reset: 100 }),
      ),
    );
  }

  filterCards(c) {
    const snap = this.engine.snapshot(120);
    return this.cards(FILTERS, c.color.filter, (id) => this.setAll('필터 변경', (x) => { x.color.filter = id; }), {
      cls: 'filter-cards',
      render: (it) => h('span', { class: 'filter-thumb', style: { backgroundImage: `url(${snap})`, filter: buildFilter({ filter: it.id }) || 'none' } }),
    });
  }

  renderVisual(c) {
    const pro = state.mode === 'pro';
    const ids = [c.id];
    this.root.append(
      this.section('look', '필터', this.filterCards(c),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn small', onclick: () => { autoEnhance(ids); this.render(); toast('선명하고 생기있게 보정했어요'); } }, '✨ 원클릭 보정'))),
      this.section('color', '색 보정',
        this.slider('밝기', { min: -100, max: 100, get: (x) => x.color.brightness, set: (x, v) => { x.color.brightness = v; }, reset: 0 }),
        this.slider('대비', { min: -100, max: 100, get: (x) => x.color.contrast, set: (x, v) => { x.color.contrast = v; }, reset: 0 }),
        this.slider('채도', { min: -100, max: 100, get: (x) => x.color.saturation, set: (x, v) => { x.color.saturation = v; }, reset: 0 }),
        this.slider('색온도', { min: -100, max: 100, get: (x) => x.color.temperature, set: (x, v) => { x.color.temperature = v; }, fmt: (v) => (v > 0 ? `따뜻 ${v}` : v < 0 ? `차갑게 ${-v}` : '0'), reset: 0 }),
        this.slider('비네팅', { min: 0, max: 100, get: (x) => x.color.vignette, set: (x, v) => { x.color.vignette = v; }, reset: 0 }),
      ),
      this.section('frame', '화면',
        h('div', { class: 'ctl' }, h('label', {}, '맞춤'),
          this.seg([['contain', '전체 보이기'], ['cover', '꽉 채우기']], c.fit, (v) => this.setAll('화면 맞춤 변경', (x) => { x.fit = v; }))),
        this.slider('크기', { min: 10, max: 400, get: (x) => Math.round(x.transform.scale * 100), set: (x, v) => { x.transform.scale = v / 100; }, fmt: (v) => `${v}%`, reset: 100 }),
        pro ? this.slider('X 위치', { min: -100, max: 100, get: (x) => Math.round(x.transform.x * 100), set: (x, v) => { x.transform.x = v / 100; }, reset: 0 }) : null,
        pro ? this.slider('Y 위치', { min: -100, max: 100, get: (x) => Math.round(x.transform.y * 100), set: (x, v) => { x.transform.y = v / 100; }, reset: 0 }) : null,
        pro ? this.slider('회전', { min: -180, max: 180, get: (x) => x.transform.rotation, set: (x, v) => { x.transform.rotation = v; }, fmt: (v) => `${v}°`, reset: 0 }) : null,
        this.slider('불투명도', { min: 0, max: 100, get: (x) => Math.round(x.transform.opacity * 100), set: (x, v) => { x.transform.opacity = v / 100; }, fmt: (v) => `${v}%`, reset: 100 }),
        h('div', { class: 'muted small' }, '미리보기에서 끌어서 위치를, 휠로 크기를 바꿀 수 있어요'),
      ),
      this.section('motion', '움직임', this.cards(MOTIONS, c.motion, (id) => this.setAll('움직임 효과 변경', (x) => { x.motion = id; }), { cls: 'small-cards' })),
      this.section('trans', '들어올 때 전환',
        this.cards(TRANSITIONS, c.transition.type, (id) => this.setAll('전환 효과 변경', (x) => { x.transition = { type: id, dur: Math.min(x.transition.dur || 0.5, x.dur / 2) }; }), { cls: 'small-cards' }),
        c.transition.type !== 'none' ? this.slider('전환 길이', { min: 0.1, max: 2, step: 0.1, get: (x) => x.transition.dur, set: (x, v) => { x.transition.dur = Math.min(v, x.dur); }, fmt: (v) => `${(+v).toFixed(1)}초` }) : null,
      ),
    );
  }

  renderAudio(c, m) {
    const ids = [c.id];
    const noAudio = m && m.hasAudio === false;
    const children = noAudio ? [h('div', { class: 'muted small' }, '이 영상에는 소리가 없어요')] : [
      this.slider('볼륨', { min: 0, max: 200, get: (x) => Math.round(x.volume * 100), set: (x, v) => { x.volume = v / 100; }, fmt: (v) => `${v}%`, reset: 100 }),
      this.slider('페이드 인', { min: 0, max: 5, step: 0.1, get: (x) => x.fadeIn, set: (x, v) => { x.fadeIn = Math.min(v, x.dur); }, fmt: (v) => `${(+v).toFixed(1)}초`, reset: 0 }),
      this.slider('페이드 아웃', { min: 0, max: 5, step: 0.1, get: (x) => x.fadeOut, set: (x, v) => { x.fadeOut = Math.min(v, x.dur); }, fmt: (v) => `${(+v).toFixed(1)}초`, reset: 0 }),
      c.type === 'audio' ? h('label', { class: 'check' },
        (() => {
          const cb = h('input', { type: 'checkbox', checked: c.duck ? true : null });
          cb.addEventListener('change', () => this.setAll('자동 볼륨 전환', (x) => { x.duck = cb.checked; }));
          return cb;
        })(),
        h('span', {}, h('b', {}, '자동 볼륨'), h('span', { class: 'muted small block' }, '말소리가 나오면 이 음악을 자동으로 줄여요'))) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => this.actions.openSilence(ids) }, '✂️ 무음 자동 컷'),
        h('button', { class: 'btn small', onclick: () => { const n = normalizeLoudness(ids); this.render(); toast(n ? '음량을 적당하게 맞췄어요' : '소리를 분석하는 중이에요. 잠시 후 다시 시도하세요.'); } }, '🔊 음량 자동')),
    ];
    this.root.append(this.section('audio', '소리', ...children));
  }

  renderTiming(c) {
    const pro = state.mode === 'pro';
    const isMedia = c.type === 'video' || c.type === 'audio';
    const children = [];
    if (isMedia) {
      children.push(h('div', { class: 'ctl' }, h('label', {}, '속도'),
        this.seg(SPEEDS.map((s) => [s, `${s}x`]), c.speed, (v) => this.setAll('속도 변경', (x) => {
          const srcLen = x.dur * x.speed;
          x.speed = v;
          x.dur = round(Math.min(srcLen / v, maxDurFor(x)));
        }))));
    }
    if (!isMedia || pro) {
      children.push(this.slider('길이', {
        min: 0.2, max: isMedia ? Math.max(0.2, Math.floor(maxDurFor({ ...c, dur: 0 }) * 10) / 10) : 30, step: 0.1,
        get: (x) => +x.dur.toFixed(1), set: (x, v) => { x.dur = Math.min(v, maxDurFor(x)); }, fmt: (v) => `${(+v).toFixed(1)}초`,
      }));
    }
    if (c.type !== 'audio' && c.type !== 'video') {
      children.push(this.slider('페이드 인', { min: 0, max: 3, step: 0.1, get: (x) => x.fadeIn, set: (x, v) => { x.fadeIn = Math.min(v, x.dur); }, fmt: (v) => `${(+v).toFixed(1)}초`, reset: 0 }));
      children.push(this.slider('페이드 아웃', { min: 0, max: 3, step: 0.1, get: (x) => x.fadeOut, set: (x, v) => { x.fadeOut = Math.min(v, x.dur); }, fmt: (v) => `${(+v).toFixed(1)}초`, reset: 0 }));
    }
    children.push(h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', onclick: () => this.actions.duplicate() }, '복제'),
      h('button', { class: 'btn small danger', onclick: () => this.actions.deleteSelected() }, '삭제')));
    this.root.append(this.section('timing', '시간', ...children));
  }
}

export { emit, mediaRuntime, silenceCut };
