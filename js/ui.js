// 작은 UI 도우미: 토스트, 모달, 시간 표기, 엘리먼트 생성

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); // CSS 변수
        else el.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

/** 00:12.4 형태 (초보자용) */
export function fmtTime(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/** 00:00:12:15 타임코드 (전문가용) */
export function fmtTimecode(t, fps = 30) {
  t = Math.max(0, t || 0);
  const totalFrames = Math.round(t * fps);
  const f = totalFrames % fps;
  const s = Math.floor(totalFrames / fps) % 60;
  const m = Math.floor(totalFrames / fps / 60) % 60;
  const hh = Math.floor(totalFrames / fps / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(m)}:${p(s)}:${p(f)}`;
}

export function fmtDur(t) {
  if (!isFinite(t)) return '';
  if (t < 60) return `${t.toFixed(1)}초`;
  const m = Math.floor(t / 60);
  return `${m}분 ${Math.round(t - m * 60)}초`;
}

let toastWrap;
export function toast(msg, opts = {}) {
  if (!toastWrap) {
    toastWrap = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastWrap);
  }
  const el = h('div', { class: `toast ${opts.type || ''}` }, h('span', {}, msg));
  if (opts.action) {
    el.append(
      h('button', {
        class: 'toast-action',
        onclick: () => {
          opts.action.run();
          close();
        },
      }, opts.action.label),
    );
  }
  toastWrap.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const close = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  };
  setTimeout(close, opts.duration || (opts.action ? 5000 : 2600));
  return close;
}

/** 모달 열기. content: Node, 반환: close 함수 */
export function modal(title, content, opts = {}) {
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !opts.locked) {
      e.stopPropagation();
      close();
    }
  };
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back && !opts.locked) close(); } },
    h('div', { class: `modal ${opts.wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' },
        h('h2', {}, title),
        opts.locked ? null : h('button', { class: 'icon-btn', title: '닫기 (Esc)', onclick: close }, '✕'),
      ),
      h('div', { class: 'modal-body' }, content),
    ),
  );
  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => back.querySelector('input,button.primary,textarea')?.focus(), 30);
  return close;
}

export function confirmDialog(title, message, okLabel = '확인') {
  return new Promise((resolve) => {
    let result = false;
    const close = modal(title, h('div', {},
      h('p', { class: 'muted' }, message),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => close() }, '취소'),
        h('button', { class: 'btn primary', onclick: () => { result = true; close(); } }, okLabel),
      ),
    ), { onClose: () => resolve(result) });
  });
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
export const easeOutBack = (p) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

export function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
