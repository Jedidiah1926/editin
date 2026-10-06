// 자막 관련 화면: 자동 자막, 자막 디자인(일반/강조), 내 템플릿 만들기(자막 바 이미지 · 사진 따라하기)

import { state, project, mutate, on, selectedClips } from './store.js';
import { TEXT_STYLES, FONT_LIST, textStyleById } from './presets.js';
import {
  listTemplates, getTemplate, applyRef, refName, saveTemplate, deleteTemplate, templateFromText, setPreviewTemplate,
  fileToCanvas, analyzeImage, removeBackground, trimTransparent, suggestTextColor, suggestSlice, canvasToBlob, extractTextStyle,
} from './templates.js';
import {
  ASR_MODELS, ASR_LANGS, autoSubtitles, cancelTranscription, reclassify, scriptToSubtitles, importSRT, exportSRT,
} from './subtitles.js';
import { previewDataURL, renderText } from './textrender.js';
import { addTextClip } from './ops.js';
import { h, $, modal, toast, confirmDialog, download, fmtDur } from './ui.js';

const PREVIEW_ID = '__preview__';

export function textForRef(ref) {
  const t = { style: 'subtitle', content: '' };
  applyRef(t, ref);
  return t;
}

function refThumb(ref, sample) {
  return h('img', { class: 'ref-thumb', alt: '', src: previewDataURL(textForRef(ref), 240, 90, sample) });
}

export function initSubtitleUI({ mainMediaClipIds }) {
  const design = $('#sub-design');
  const mine = $('#my-templates');

  // ---------- 자막 디자인 (일반 / 강조) ----------
  function renderDesign() {
    const th = project().subtitleTheme;
    const r = th.rules;
    const row = (key, label, desc, sample) => h('div', { class: 'design-row' },
      h('button', { class: 'design-pick', title: `${label} 바꾸기`, onclick: () => openRefPicker(`${label} 고르기`, th[key], (ref) => {
        mutate(`${label} 변경`, (p) => { p.subtitleTheme[key] = ref; });
        reapply();
      }) },
      refThumb(th[key], sample),
      h('span', { class: 'design-meta' }, h('b', {}, label), h('span', { class: 'muted small' }, `${refName(th[key])} · ${desc}`))));
    const check = (k, label) => {
      const cb = h('input', { type: 'checkbox', checked: r[k] ? true : null });
      cb.addEventListener('change', () => { mutate('강조 규칙 변경', (p) => { p.subtitleTheme.rules[k] = cb.checked; }); reapply(); });
      return h('label', { class: 'check small-check' }, cb, h('span', {}, label));
    };
    const kw = h('input', { class: 'text-input small-input', value: r.keywords || '', placeholder: '강조할 단어 (쉼표로 구분) 예: 대박, 진짜', 'aria-label': '강조 키워드' });
    kw.addEventListener('keydown', (e) => e.stopPropagation());
    kw.addEventListener('change', () => { mutate('강조 키워드 변경', (p) => { p.subtitleTheme.rules.keywords = kw.value; }); reapply(); });
    design.replaceChildren(
      row('normal', '일반 자막', '대부분의 말', '평소 자막'),
      row('highlight', '강조 자막', '하이라이트 순간', '여기가 하이라이트!'),
      h('div', { class: 'rules' },
        h('div', { class: 'muted small' }, '이럴 때 강조 자막을 써요'),
        check('markers', '마커(◆)를 찍은 곳'),
        check('loud', '목소리가 커지는 곳 (자동)'),
        check('exclaim', '느낌표(!)가 있는 말'),
        kw),
    );
  }

  /** 디자인 변경을 기존 자막에 바로 반영 */
  function reapply() {
    const has = project().clips.some((c) => c.type === 'text' && c.text.role);
    if (!has) return;
    const { total, highlights } = reclassify();
    toast(`자막 ${total}개에 적용했어요 (강조 ${highlights}개)`);
  }

  // ---------- 스타일/템플릿 고르기 ----------
  function openRefPicker(title, current, onPick) {
    let close;
    const pick = (ref) => { close(); onPick(ref); };
    const card = (ref, name, extra) => h('button', { class: `card ref-card ${ref === current ? 'active' : ''}`, onclick: () => pick(ref) },
      refThumb(ref), h('span', { class: 'card-name' }, name), extra);
    const custom = listTemplates();
    const body = h('div', { class: 'ref-picker' },
      h('h3', {}, '내 템플릿'),
      custom.length
        ? h('div', { class: 'cards ref-cards' }, custom.map((t) => card(`tpl:${t.id}`, t.name, t.hasImage ? h('span', { class: 'badge-img' }, '이미지') : null)))
        : h('p', { class: 'muted small' }, '아직 없어요. 자막 바 이미지나 자막 캡처 사진으로 만들 수 있어요.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => { close(); pickImage((f) => openBarEditor(f, (id) => onPick(`tpl:${id}`))); } }, '🖼 자막 바 이미지로 만들기'),
        h('button', { class: 'btn small', onclick: () => { close(); pickImage((f) => openPhotoStyle(f, (id) => onPick(`tpl:${id}`))); } }, '📷 사진 속 자막 따라하기')),
      h('h3', {}, '기본 스타일'),
      h('div', { class: 'cards ref-cards' }, TEXT_STYLES.map((s) => card(`style:${s.id}`, s.name))),
    );
    close = modal(title, body, { wide: true });
  }

  // ---------- 내 템플릿 목록 ----------
  function renderMine() {
    const list = listTemplates();
    mine.replaceChildren();
    if (!list.length) {
      mine.append(h('div', { class: 'tpl-empty muted small' }, '자막 바 이미지나 자막 캡처 사진을 올리면 그 모양 그대로 자막을 만들 수 있어요.'));
      return;
    }
    for (const t of list) {
      const ref = `tpl:${t.id}`;
      const item = h('div', { class: 'tpl-item' },
        h('button', { class: 'tpl-use', title: `'${t.name}'으로 재생 위치에 자막 추가`, onclick: () => { addTextClip(t.base, { ref, content: '여기에 내용을 입력하세요' }); toast(`'${t.name}' 자막을 추가했어요`); } },
          refThumb(ref), h('span', { class: 'card-name' }, t.name)),
        h('button', {
          class: 'tpl-del', title: '삭제', 'aria-label': `${t.name} 삭제`,
          onclick: async () => { if (await confirmDialog('템플릿 삭제', `'${t.name}'을 지울까요? 이미 만든 자막은 기본 모양으로 보여요.`, '삭제')) deleteTemplate(t.id); },
        }, '×'));
      mine.append(item);
    }
  }

  $('#tpl-new').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menuAt(r.left, r.bottom + 4, [
      { label: '🖼 자막 바 이미지로 만들기', run: () => pickImage((f) => openBarEditor(f)) },
      { label: '📷 사진 속 자막 따라하기', run: () => pickImage((f) => openPhotoStyle(f)) },
      { label: '💾 선택한 자막 모양 저장', run: saveSelected },
    ]);
  };

  function saveSelected() {
    const c = selectedClips().find((x) => x.type === 'text');
    if (!c) { toast('먼저 타임라인에서 자막을 하나 선택하세요'); return; }
    const name = prompt('템플릿 이름', `내 스타일 ${listTemplates().length + 1}`);
    if (!name) return;
    templateFromText(c.text, name).then(() => toast(`'${name}' 템플릿을 저장했어요`));
  }

  // ---------- 자막 바 이미지 템플릿 ----------
  function openBarEditor(file, onSaved) {
    fileToCanvas(file).then((orig) => {
      const info = analyzeImage(orig);
      let removeBg = info.removable;
      let barCanvas = null;
      let barImg = null;
      const meta = {
        name: file.name.replace(/\.[^.]+$/, '').slice(0, 20) || '자막 바',
        base: 'subtitle',
        fit: 'stretch',
        sliceL: 0.25, sliceR: 0.25,
        padX: 0.4, padY: 0.55, textX: 0, textY: 0, textW: 0.8, barScale: 1,
        x: 0.5, y: 0.86,
        overrides: { color: '#ffffff', stroke: null, size: 1, anim: 'fade', font: 'Noto Sans KR', weight: 700 },
        hasImage: true,
      };
      let sample = '자막 바에 맞춰 이렇게 나와요';
      const cv = h('canvas', { class: 'tpl-preview', width: 960, height: 400 });
      const prepare = () => {
        let c = document.createElement('canvas');
        c.width = orig.width; c.height = orig.height;
        c.getContext('2d').drawImage(orig, 0, 0);
        c = removeBg ? removeBackground(c) : (info.hasAlpha ? trimTransparent(c) : c);
        barCanvas = c;
        const sl = suggestSlice(c);
        meta.sliceL = sl.l; meta.sliceR = sl.r;
        meta.overrides.color = suggestTextColor(c);
      };
      prepare();
      const rebuild = async () => {
        barImg = new Image();
        barImg.src = barCanvas.toDataURL('image/png');
        await barImg.decode();
        colorInp.value = meta.overrides.color;
        for (const [k, el] of Object.entries(sliceInputs)) { el.value = meta[k] * 100; el.dispatchEvent(new Event('input')); }
        draw();
      };
      const draw = () => {
        setPreviewTemplate(PREVIEW_ID, meta, barImg);
        const ctx = cv.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, cv.width, cv.height);
        g.addColorStop(0, '#4a5d7e'); g.addColorStop(1, '#6e5a7c');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, cv.width, cv.height);
        const H = 540;
        const clip = {
          id: 'p', start: 0, dur: 10, fadeIn: 0, fadeOut: 0, transform: { opacity: 1, rotation: 0 },
          text: { style: meta.base, content: sample, anim: 'none', x: 0.5, y: (cv.height / 2) / H, template: PREVIEW_ID, ...meta.overrides, size: meta.overrides.size },
        };
        renderText(ctx, clip, 1, cv.width, H);
      };
      const slider = (label, get, set, min, max, step, fmt) => {
        const out = h('span', { class: 'sl-val' }, fmt(get()));
        const r = h('input', { type: 'range', min, max, step, value: get(), 'aria-label': label });
        r.addEventListener('input', () => { set(+r.value); out.textContent = fmt(+r.value); draw(); });
        return h('div', { class: 'ctl slider' }, h('div', { class: 'ctl-top' }, h('label', {}, label), out), r);
      };
      const seg = (opts, get, set) => {
        const wrap = h('div', { class: 'seg' });
        const paint = () => wrap.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', opts[i][0] === get()));
        opts.forEach(([v, l]) => wrap.append(h('button', { onclick: () => { set(v); paint(); draw(); } }, l)));
        paint();
        return wrap;
      };
      const nameInp = h('input', { class: 'text-input', value: meta.name, 'aria-label': '템플릿 이름' });
      nameInp.addEventListener('keydown', (e) => e.stopPropagation());
      const sampleInp = h('input', { class: 'text-input', value: sample, 'aria-label': '미리보기 문구' });
      sampleInp.addEventListener('keydown', (e) => e.stopPropagation());
      sampleInp.addEventListener('input', () => { sample = sampleInp.value || ' '; draw(); });
      const colorInp = h('input', { type: 'color', value: meta.overrides.color, 'aria-label': '글자색' });
      colorInp.addEventListener('input', () => { meta.overrides.color = colorInp.value; draw(); });
      const strokeCb = h('input', { type: 'checkbox' });
      strokeCb.addEventListener('change', () => { meta.overrides.stroke = strokeCb.checked ? '#000000' : null; draw(); });
      const fontSel = h('select', { class: 'text-input', 'aria-label': '글꼴' }, FONT_LIST.map((f) => h('option', { value: f }, f)));
      fontSel.addEventListener('change', () => { meta.overrides.font = fontSel.value; meta.overrides.weight = fontSel.value === 'Noto Sans KR' ? 700 : 400; draw(); });
      const bgCb = h('input', { type: 'checkbox', checked: removeBg ? true : null });
      bgCb.addEventListener('change', () => { removeBg = bgCb.checked; prepare(); rebuild(); });

      const sliceL = slider('왼쪽 장식 너비 (늘리지 않음)', () => meta.sliceL * 100, (v) => { meta.sliceL = v / 100; }, 0, 45, 1, (v) => `${Math.round(v)}%`);
      const sliceR = slider('오른쪽 장식 너비 (늘리지 않음)', () => meta.sliceR * 100, (v) => { meta.sliceR = v / 100; }, 0, 45, 1, (v) => `${Math.round(v)}%`);
      const sliceInputs = { sliceL: sliceL.querySelector('input'), sliceR: sliceR.querySelector('input') };
      const sliceSliders = h('div', { class: 'ctl-group' }, sliceL, sliceR);
      let close;
      const body = h('div', { class: 'tpl-editor' },
        cv,
        h('div', { class: 'tpl-grid' },
          h('div', {},
            h('div', { class: 'ctl' }, h('label', {}, '이름'), nameInp),
            h('div', { class: 'ctl' }, h('label', {}, '미리보기 문구'), sampleInp),
            info.hasAlpha ? null : h('label', { class: 'check' }, bgCb, h('span', {}, h('b', {}, '배경 지우기'), h('span', { class: 'muted small block' }, info.removable ? '단색 배경을 찾았어요. 자막 바만 남겨요.' : '배경이 복잡하면 잘 안 지워질 수 있어요. 투명 PNG가 가장 좋아요.'))),
            h('div', { class: 'ctl' }, h('label', {}, '글자가 길어지면'), seg([['stretch', '바를 늘리기'], ['fixed', '바 그대로 (전체 확대)']], () => meta.fit, (v) => { meta.fit = v; meta.padX = v === 'stretch' ? 0.4 : 0.5; })),
            h('div', { class: 'ctl' }, h('label', {}, '화면 위치'), seg([[0.13, '위'], [0.5, '가운데'], [0.86, '아래']], () => meta.y, (v) => { meta.y = v; })),
          ),
          h('div', {},
            h('div', { class: 'ctl' }, h('label', {}, '글자'), h('div', { class: 'row' }, colorInp, h('label', { class: 'check' }, strokeCb, h('span', {}, '테두리')), fontSel)),
            slider('글자 크기', () => meta.overrides.size * 100, (v) => { meta.overrides.size = v / 100; }, 50, 200, 5, (v) => `${Math.round(v)}%`),
            sliceSliders,
            slider('바 두께 (위아래 여백)', () => meta.padY * 100, (v) => { meta.padY = v / 100; }, 10, 200, 5, (v) => `${Math.round(v)}`),
            slider('글자 좌우 위치', () => meta.textX * 100, (v) => { meta.textX = v / 100; }, -40, 40, 1, (v) => (v === 0 ? '가운데' : v > 0 ? `오른쪽 ${v}` : `왼쪽 ${-v}`)),
            slider('글자 상하 위치', () => meta.textY * 100, (v) => { meta.textY = v / 100; }, -40, 40, 1, (v) => (v === 0 ? '가운데' : v > 0 ? `아래 ${v}` : `위 ${-v}`)),
          ),
        ),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: () => close() }, '취소'),
          h('button', {
            class: 'btn primary',
            onclick: async () => {
              const blob = await canvasToBlob(barCanvas);
              const id = await saveTemplate({ ...meta, name: nameInp.value || meta.name, image: blob });
              close();
              toast(`'${nameInp.value || meta.name}' 템플릿을 만들었어요`);
              onSaved?.(id);
            },
          }, '템플릿 저장')),
      );
      close = modal('자막 바 템플릿 만들기', body, { wide: true, onClose: () => setPreviewTemplate(PREVIEW_ID, null, null) });
      rebuild();
    }).catch(() => toast('이미지를 읽을 수 없어요', { type: 'error' }));
  }

  // ---------- 사진 속 자막 따라하기 ----------
  function openPhotoStyle(file, onSaved) {
    fileToCanvas(file).then((canvas) => {
      const st = extractTextStyle(canvas);
      if (!st) { toast('사진에서 글자를 찾지 못했어요. 자막 부분만 잘라서 올려 보세요.', { type: 'error', duration: 5000 }); return; }
      const text = { style: st.bg ? 'box' : 'subtitle', color: st.color, stroke: st.stroke, bg: st.bg, size: 1, anim: st.bg ? 'fade' : 'none' };
      if (!st.stroke && !st.bg) text.style = 'title';
      const pv = h('img', { class: 'photo-pv', alt: '' });
      const paint = () => { pv.src = previewDataURL(text, 360, 120, '이 느낌으로 자막을 만들어요'); };
      const color = (label, key) => {
        const inp = h('input', { type: 'color', value: (text[key] && text[key].startsWith('#')) ? text[key] : '#000000', 'aria-label': label });
        const cb = h('input', { type: 'checkbox', checked: text[key] ? true : null });
        const sync = () => { text[key] = cb.checked ? (key === 'bg' ? hexToRgba(inp.value, 0.85) : inp.value) : null; paint(); };
        inp.addEventListener('input', () => { cb.checked = true; sync(); });
        cb.addEventListener('change', sync);
        return h('label', { class: 'check' }, cb, inp, h('span', {}, label));
      };
      if (st.bg) text.bgHex = rgbaToHex(st.bg);
      const nameInp = h('input', { class: 'text-input', value: `따라한 자막 ${listTemplates().length + 1}`, 'aria-label': '템플릿 이름' });
      nameInp.addEventListener('keydown', (e) => e.stopPropagation());
      const fill = h('input', { type: 'color', value: st.color, 'aria-label': '글자색' });
      fill.addEventListener('input', () => { text.color = fill.value; paint(); });
      const bgCtl = color('배경 박스', 'bg');
      if (st.bg) bgCtl.querySelector('input[type=color]').value = text.bgHex;
      delete text.bgHex;
      paint();
      let close;
      close = modal('사진 속 자막 따라하기', h('div', { class: 'photo-style' },
        h('div', { class: 'photo-compare' },
          h('div', {}, h('div', { class: 'muted small' }, '올린 사진'), h('img', { class: 'photo-src', alt: '', src: canvas.toDataURL('image/jpeg', 0.85) })),
          h('div', {}, h('div', { class: 'muted small' }, '찾아낸 스타일'), pv)),
        h('p', { class: 'muted small' }, '색이 조금 다르면 아래에서 고칠 수 있어요. 글꼴 모양까지는 따라하지 못해요.'),
        h('div', { class: 'row wrap' },
          h('label', { class: 'check' }, fill, h('span', {}, '글자색')),
          color('테두리', 'stroke'),
          bgCtl),
        h('div', { class: 'ctl' }, h('label', {}, '이름'), nameInp),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: () => close() }, '취소'),
          h('button', {
            class: 'btn primary',
            onclick: async () => {
              const s0 = textStyleById(text.style);
              const id = await saveTemplate({
                name: nameInp.value || '따라한 자막', base: text.style, hasImage: false, x: s0.x, y: s0.y,
                overrides: { color: text.color, stroke: text.stroke, bg: text.bg, size: 1, anim: text.anim },
              });
              close();
              toast('템플릿을 만들었어요');
              onSaved?.(id);
            },
          }, '템플릿 저장')),
      ), { wide: true });
    }).catch(() => toast('이미지를 읽을 수 없어요', { type: 'error' }));
  }

  // ---------- 자동 자막 ----------
  function openAutoSubtitle() {
    const sel = selectedClips().filter((c) => c.type === 'video' || c.type === 'audio');
    const ids = sel.length ? sel.map((c) => c.id) : mainMediaClipIds();
    if (!ids.length) { toast('먼저 말소리가 있는 영상을 추가하세요'); return; }
    const p = project();
    const vertical = p.height > p.width;
    const opts = {
      model: ASR_MODELS[0].id, language: 'korean', maxChars: vertical ? 14 : 20, dropPeriod: true,
      replace: true,
    };
    const totalDur = ids.reduce((s, id) => s + (project().clips.find((c) => c.id === id)?.dur || 0), 0);
    const seg = (items, key) => {
      const wrap = h('div', { class: 'seg' });
      const paint = () => wrap.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', items[i][0] === opts[key]));
      items.forEach(([v, l]) => wrap.append(h('button', { onclick: () => { opts[key] = v; paint(); } }, l)));
      paint();
      return wrap;
    };
    const models = h('div', { class: 'cards model-cards' });
    const paintModels = () => {
      models.replaceChildren(...ASR_MODELS.map((m) => h('button', {
        class: `card ${opts.model === m.id ? 'active' : ''}`,
        onclick: () => { opts.model = m.id; paintModels(); },
      }, h('b', {}, m.name), h('span', { class: 'muted small' }, m.desc))));
    };
    paintModels();
    const cb = (key, label) => {
      const i = h('input', { type: 'checkbox', checked: opts[key] ? true : null });
      i.addEventListener('change', () => { opts[key] = i.checked; });
      return h('label', { class: 'check' }, i, h('span', {}, label));
    };
    const th = p.subtitleTheme;
    let close;
    close = modal('🎙 자동 자막', h('div', { class: 'auto-sub' },
      h('p', { class: 'muted' }, sel.length ? `선택한 클립 ${sel.length}개` : `메인 영상 ${ids.length}개 클립`, ` (${fmtDur(totalDur)})의 말을 받아써서 자막을 만들어요.`),
      h('div', { class: 'ctl' }, h('label', {}, '정확도'), models),
      h('div', { class: 'ctl' }, h('label', {}, '언어'), seg(ASR_LANGS, 'language')),
      h('div', { class: 'ctl' }, h('label', {}, '한 줄 최대 글자 수'), seg([[12, '12자'], [14, '14자'], [18, '18자'], [20, '20자'], [26, '26자']], 'maxChars'),
        h('div', { class: 'muted small' }, vertical ? '세로 영상은 짧게 끊는 게 잘 읽혀요' : '가로 영상은 18~20자가 적당해요')),
      cb('dropPeriod', '문장 끝 마침표 빼기'),
      cb('replace', '이전에 만든 자동 자막은 지우고 새로 만들기'),
      h('div', { class: 'design-summary' },
        h('div', {}, refThumb(th.normal, '일반'), h('span', { class: 'small' }, `일반: ${refName(th.normal)}`)),
        h('div', {}, refThumb(th.highlight, '강조!'), h('span', { class: 'small' }, `강조: ${refName(th.highlight)}`)),
        h('div', { class: 'muted small' }, '디자인과 강조 규칙은 텍스트 탭의 ‘자막 디자인’에서 바꿀 수 있어요. 나중에 바꿔도 모든 자막에 바로 반영돼요.')),
      h('p', { class: 'muted small' }, '🔒 음성은 이 컴퓨터 안에서만 처리돼요. 처음 한 번은 음성 인식 모델을 내려받아요.'),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => close() }, '취소'),
        h('button', { class: 'btn primary', onclick: () => { close(); run(ids, opts); } }, '자막 만들기')),
    ), { wide: true });
  }

  async function run(ids, opts) {
    const bar = h('div', { class: 'progress-bar' });
    const label = h('div', { class: 'progress-label' }, '음성 인식 엔진 준비 중…');
    let cancelled = false;
    const close = modal('자동 자막 만드는 중', h('div', { class: 'export-progress' },
      h('div', { class: 'progress' }, bar), label,
      h('p', { class: 'muted small' }, '영상 길이와 컴퓨터 성능에 따라 시간이 걸려요. 이 탭을 열어 두세요.'),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => { cancelled = true; cancelTranscription(); } }, '취소'))), { locked: true });
    const onStatus = (s) => {
      if (s.stage === 'download' && s.total) {
        bar.style.width = `${(s.loaded / s.total) * 100}%`;
        label.textContent = `음성 인식 모델 내려받는 중 ${(s.loaded / 1e6).toFixed(0)} / ${(s.total / 1e6).toFixed(0)}MB (처음 한 번만)`;
      } else if (s.stage === 'loading') label.textContent = '음성 인식 엔진 준비 중…';
      else if (s.stage === 'ready') { bar.style.width = '0%'; label.textContent = `받아쓰기 시작 (${s.device === 'webgpu' ? 'GPU 가속' : 'CPU'})`; }
      else if (s.stage === 'transcribe') {
        bar.style.width = `${Math.round(s.progress * 100)}%`;
        label.textContent = `받아쓰는 중… ${Math.round(s.progress * 100)}%`;
      }
    };
    try {
      const r = await autoSubtitles(ids, opts, onStatus);
      close();
      if (!r.count) toast('알아들을 수 있는 말을 찾지 못했어요');
      else toast(`자막 ${r.count}개를 만들었어요 (강조 ${r.highlights}개). 틀린 글자는 자막을 더블클릭해 고치세요.`, { duration: 6000 });
    } catch (err) {
      close();
      if (cancelled) { toast('자동 자막을 취소했어요'); return; }
      console.error(err);
      modal('자동 자막을 만들지 못했어요', h('div', {},
        h('p', {}, '음성 인식 모델을 내려받거나 실행하지 못했어요.'),
        h('ul', { class: 'muted small' },
          h('li', {}, '인터넷 연결을 확인하세요. 회사·학교 네트워크에서는 모델 다운로드(huggingface.co, cdn.jsdelivr.net)가 막혀 있을 수 있어요.'),
          h('li', {}, '최신 Chrome 또는 Edge에서 가장 잘 동작해요.'),
          h('li', {}, '대신 대본을 붙여넣거나 SRT 파일을 불러와도 같은 디자인이 적용돼요.')),
        h('p', { class: 'muted small' }, `오류: ${err.message}`)));
    }
  }

  $('#auto-sub-btn').onclick = openAutoSubtitle;

  // ---------- 대본 · SRT ----------
  $('#script-add').onclick = () => {
    const ta = $('#script');
    const r = scriptToSubtitles(ta.value, state.time);
    if (!r) { toast('자막으로 만들 문장을 입력하세요'); return; }
    ta.value = '';
    toast(`자막 ${r.count}개를 만들었어요${r.highlights ? ` (강조 ${r.highlights}개)` : ''}`);
  };
  $('#script').addEventListener('keydown', (e) => e.stopPropagation());
  const srtInput = h('input', { type: 'file', accept: '.srt,.vtt,text/plain', hidden: true });
  document.body.append(srtInput);
  srtInput.addEventListener('change', async () => {
    const f = srtInput.files[0];
    if (!f) return;
    const r = importSRT(await f.text());
    toast(r ? `자막 ${r.count}개를 불러왔어요` : '자막을 읽을 수 없어요');
    srtInput.value = '';
  });
  $('#srt-import').onclick = () => srtInput.click();
  $('#srt-export').onclick = () => {
    const s = exportSRT();
    if (!s) { toast('내보낼 자막이 없어요'); return; }
    download(new Blob([s], { type: 'text/plain' }), `${project().name}.srt`);
  };

  on('project', ({ live, source } = {}) => { if (!live && source !== 'subtitle-ui') renderDesign(); });
  on('templates', () => { renderMine(); renderDesign(); });
  renderDesign();
  renderMine();

  return { openAutoSubtitle, openRefPicker, saveSelected, openBarEditor, openPhotoStyle };
}

function pickImage(cb) {
  const inp = h('input', { type: 'file', accept: 'image/*', hidden: true });
  document.body.append(inp);
  inp.addEventListener('change', () => { if (inp.files[0]) cb(inp.files[0]); inp.remove(); });
  inp.click();
}

let menuEl = null;
function menuAt(x, y, items) {
  menuEl?.remove();
  menuEl = h('div', { class: 'ctx-menu', role: 'menu' }, items.map((it) => h('button', {
    role: 'menuitem', onclick: () => { menuEl.remove(); menuEl = null; it.run(); },
  }, h('span', {}, it.label))));
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menuEl.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  setTimeout(() => document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) { menuEl.remove(); menuEl = null; } }, { once: true }));
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function rgbaToHex(s) {
  const m = String(s).match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return '#000000';
  return `#${[m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('')}`;
}

export { getTemplate };
