// 유튜브 · 치지직 링크로 가져오기 (키리누키): 구간을 골라 그 부분만 받아서 소스로 추가
// 실제 다운로드는 내 컴퓨터에서 실행하는 도우미(tools/yt-helper.mjs)가 yt-dlp로 처리

import { state, project, mutate, mediaById, clipsOnTrack, clipEnd, defaultClip } from './store.js';
import { h, modal, toast, fmtDur } from './ui.js';
import { importFiles } from './media.js';
import { addMediaClip, trackFor } from './ops.js';
import { textStyleById } from './presets.js';

const DEFAULT_HELPER = 'http://127.0.0.1:8787';
// 데스크톱 앱이면 앱 안에 들어 있는 도우미를 씀
const native = typeof window !== 'undefined' ? window.editinNative : null;
export const isDesktopApp = !!native?.isApp;
const helperUrl = () => {
  if (native?.helperUrl) return native.helperUrl;
  try { return localStorage.getItem('editin.helper') || DEFAULT_HELPER; } catch { return DEFAULT_HELPER; }
};

// ---------- 링크·시간 해석 ----------

export function parseYouTube(url) {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\.|^m\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
      id = u.searchParams.get('v');
      const m = u.pathname.match(/^\/(shorts|live|embed|v)\/([\w-]{6,})/);
      if (!id && m) id = m[2];
    }
    if (!id || !/^[\w-]{6,}$/.test(id)) return null;
    const t = u.searchParams.get('t') || u.searchParams.get('start') || (u.hash.match(/t=([\w]+)/) || [])[1];
    return { id, start: t ? parseTime(t) : null };
  } catch {
    return null;
  }
}

/** 치지직 링크: 다시보기·업로드 영상(/video/숫자), 라이브(/live/채널), 클립(/clips/…) */
export function parseChzzk(url) {
  try {
    const u = new URL(String(url).trim());
    if (!/(^|\.)chzzk\.naver\.com$/.test(u.hostname)) return null;
    const p = u.pathname;
    const time = u.searchParams.get('currentTime') || u.searchParams.get('t') || u.searchParams.get('start');
    const start = time ? parseTime(time) : null;
    let m = p.match(/^\/video\/(\d+)/);
    if (m) return { platform: 'chzzk', kind: 'video', id: m[1], start };
    m = p.match(/^\/live\/([\da-f]+)/i);
    if (m) return { platform: 'chzzk', kind: 'live', id: m[1], start: null };
    m = p.match(/^\/(?:embed\/)?clips?\/([\w-]+)/);
    if (m) return { platform: 'chzzk', kind: 'clip', id: m[1], start: null };
    return null;
  } catch {
    return null;
  }
}

/** 지원하는 링크인지와 종류 */
export function parseLink(url) {
  const yt = parseYouTube(url);
  if (yt) return { platform: 'youtube', kind: 'video', ...yt };
  return parseChzzk(url);
}

export const PLATFORM_NAME = { youtube: '유튜브', chzzk: '치지직' };

/** "1:02:03", "1;02;03", "62:03", "3723", "1h2m3s", "1시간 2분 3초" → 초 */
export function parseTime(s) {
  s = String(s).trim()
    .replace(/[;；：]/g, ':') // 세미콜론·전각 콜론도 콜론으로
    .replace(/\s*(시간|hours?|hrs?)\s*/gi, 'h')
    .replace(/\s*(분|minutes?|mins?)\s*/gi, 'm')
    .replace(/\s*(초|seconds?|secs?)\s*/gi, 's')
    .replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const hms = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/i);
  if (hms && (hms[1] || hms[2]) ) return (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
  if (hms && hms[3] && /s$/i.test(s)) return +hms[3];
  const parts = s.split(':');
  if (parts.length > 3 || parts.some((p) => p === '' || Number.isNaN(Number(p)))) return null;
  return parts.map(Number).reduce((acc, n) => acc * 60 + n, 0);
}

export function fmtClock(t) {
  if (t == null || !isFinite(t)) return '';
  t = Math.max(0, t);
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = Math.floor(t % 60);
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

// ---------- 도우미 통신 ----------

async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 60000);
  try {
    const r = await fetch(helperUrl() + path, { ...opts, signal: ctrl.signal });
    if (opts.raw) return r;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `도우미 오류 (${r.status})`);
    return j;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHelper() {
  try {
    return await api('/health', { timeout: 2500 });
  } catch {
    return null;
  }
}

// ---------- 유튜브 플레이어 (구간 고르기) ----------

let ytApi = null;
function loadYTApi() {
  if (ytApi) return ytApi;
  ytApi = new Promise((resolve, reject) => {
    if (window.YT?.Player) { resolve(window.YT); return; }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApi = null; reject(new Error('유튜브 플레이어를 불러오지 못했어요')); };
    document.head.append(s);
    setTimeout(() => reject(new Error('timeout')), 10000);
  });
  return ytApi;
}

// ---------- 화면 ----------

export function openYouTubeImport(prefill = '') {
  let close;
  const body = h('div', { class: 'yt-import' });
  close = modal('▶ 유튜브 · 치지직 링크로 가져오기', body, { wide: true, onClose: () => cleanup?.() });
  let cleanup = null;

  const urlInp = h('input', { class: 'text-input', placeholder: '유튜브 또는 치지직 다시보기 링크 (예: https://chzzk.naver.com/video/1234)', value: prefill, 'aria-label': '영상 링크' });
  urlInp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); });
  const goBtn = h('button', { class: 'btn primary', onclick: () => go() }, '영상 불러오기');
  const stepUrl = h('div', { class: 'yt-step' },
    h('div', { class: 'row' }, urlInp, goBtn),
    h('p', { class: 'muted small' }, '키리누키(클립)는 원본 채널의 2차 창작·클립 가이드라인을 확인하고, 허락된 범위에서 만들어 주세요. 출처 표시는 자동으로 넣을 수 있어요.'));
  const stage = h('div', { class: 'yt-stage' });
  body.append(stepUrl, stage);
  const bar = ytdlpBar();
  if (bar) body.append(bar);

  async function go() {
    const url = urlInp.value.trim();
    if (!/^https?:\/\//.test(url)) { toast('링크를 붙여넣어 주세요'); return; }

    goBtn.disabled = true;
    stage.replaceChildren(h('div', { class: 'muted' }, '도우미 확인 중…'));
    const health = await checkHelper();
    if (!health) { goBtn.disabled = false; stage.replaceChildren(setupGuide(() => go())); return; }
    if (!health.ok) { goBtn.disabled = false; stage.replaceChildren(setupGuide(() => go(), health)); return; }
    stage.replaceChildren(h('div', { class: 'muted' }, '영상 정보 가져오는 중…'));
    try {
      const info = await api(`/info?url=${encodeURIComponent(url)}`);
      showPicker(url, info);
    } catch (e) {
      stage.replaceChildren(h('div', { class: 'check-item error' }, `⛔ ${e.message}`));
    } finally {
      goBtn.disabled = false;
    }
  }

  function showPicker(url, info) {
    const link = parseLink(url);
    const yt = link?.platform === 'youtube' ? link : null;
    const dur = info.duration || null;
    let start = link?.start ?? 0;
    let end = dur ? Math.min(dur, start + 60) : start + 60;
    const narrow = project().width / project().height < 1.3; // 세로·정사각 화면
    // 클립은 짧아서 기본으로 전체를 가져옴
    const opts = { height: 1080, exact: true, credit: true, full: !!info.isClip, fill: narrow ? 'blurfill' : 'keep' };
    const startInp = h('input', { class: 'text-input time-input', value: fmtClock(start), 'aria-label': '시작 시간' });
    const endInp = h('input', { class: 'text-input time-input', value: fmtClock(end), 'aria-label': '끝 시간' });
    const lenEl = h('span', { class: 'yt-len' });
    const warn = h('div', { class: 'muted small' });
    const rangeBox = h('div', { class: 'yt-range' });
    const goBtn2 = h('button', { class: 'btn primary' });
    const sync = () => {
      startInp.value = fmtClock(start);
      endInp.value = fmtClock(end);
      rangeBox.hidden = opts.full;
      goBtn2.textContent = opts.full ? '⬇ 전체 영상 가져오기' : '⬇ 이 구간 가져오기';
      if (opts.full) {
        lenEl.textContent = dur ? `전체 ${fmtDur(dur)}` : '전체 영상';
        lenEl.classList.remove('bad');
        warn.textContent = dur && dur > 1200 ? `⚠️ 전체가 ${Math.round(dur / 60)}분이에요. 받는 데 오래 걸리고 편집도 무거워져요. 필요한 부분만 고르는 걸 추천해요.` : '';
        return;
      }
      const len = end - start;
      lenEl.textContent = len > 0 ? `길이 ${fmtDur(len)}` : '끝이 시작보다 뒤여야 해요';
      lenEl.classList.toggle('bad', len <= 0);
      warn.textContent = len > 600 ? '⚠️ 10분이 넘어요. 길수록 받는 데 오래 걸리고 편집도 무거워져요.' : '';
    };
    for (const [inp, set] of [[startInp, (v) => { start = v; }], [endInp, (v) => { end = v; }]]) {
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      inp.addEventListener('change', () => {
        const v = parseTime(inp.value);
        if (v == null) { toast('시간은 1:23 또는 1:02:03 처럼 적어 주세요'); sync(); return; }
        set(dur ? Math.min(v, dur) : v);
        sync();
      });
    }
    // 유튜브 플레이어
    const playerBox = h('div', { class: 'yt-player' }, h('div', { id: 'yt-player-el' }));
    let player = null;
    let previewTimer = null;
    const nowBtn = (label, fn) => (!yt ? null : h('button', { class: 'btn small', onclick: () => {
      if (!player?.getCurrentTime) { toast('플레이어가 아직 준비되지 않았어요. 시간을 직접 적어 주세요.'); return; }
      fn(player.getCurrentTime());
      sync();
    } }, label));
    if (yt) {
      loadYTApi().then((YT) => {
        player = new YT.Player('yt-player-el', {
          videoId: yt.id,
          playerVars: { start: Math.floor(start), rel: 0, modestbranding: 1, playsinline: 1 },
          width: '100%', height: '100%',
        });
      }).catch(() => {
        playerBox.replaceChildren(h('div', { class: 'yt-noplayer muted small' }, '플레이어를 불러오지 못했어요. 아래에 시간을 직접 적어 주세요.'));
      });
    } else {
      // 치지직 등: 플레이어를 넣을 수 없어서 썸네일 + 원래 사이트에서 시간 확인
      const chzzkUrl = link?.platform === 'chzzk' && link.kind !== 'live'
        ? () => (link.kind === 'clip' ? `https://chzzk.naver.com/clips/${link.id}` : `https://chzzk.naver.com/video/${link.id}${start ? `?currentTime=${Math.floor(start)}` : ''}`) : null;
      playerBox.replaceChildren(
        info.thumbnail ? h('img', { src: info.thumbnail, alt: '', class: 'yt-thumb' }) : null,
        h('div', { class: 'yt-noplayer-note' },
          h('span', {}, `${PLATFORM_NAME[link?.platform] || '이 사이트'} 영상은 여기서 재생할 수 없어요. 원하는 장면의 시간을 확인해서 아래에 적어 주세요.`),
          chzzkUrl ? h('button', { class: 'btn small', onclick: () => window.open(chzzkUrl(), '_blank') }, '치지직에서 열기 ↗') : null));
    }
    cleanup = () => { clearInterval(previewTimer); try { player?.destroy?.(); } catch { /* 무시 */ } };
    const preview = () => {
      if (!player?.seekTo) return;
      player.seekTo(start, true);
      player.playVideo();
      clearInterval(previewTimer);
      previewTimer = setInterval(() => { if (player.getCurrentTime() >= end) { player.pauseVideo(); clearInterval(previewTimer); } }, 200);
    };
    const seg = (items, key) => {
      const wrap = h('div', { class: 'seg' });
      const paint = () => wrap.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', items[i][0] === opts[key]));
      items.forEach(([v, l]) => wrap.append(h('button', { onclick: () => { opts[key] = v; paint(); } }, l)));
      paint();
      return wrap;
    };
    const cb = (key, label, sub) => {
      const i = h('input', { type: 'checkbox', checked: opts[key] ? true : null });
      i.addEventListener('change', () => { opts[key] = i.checked; });
      return h('label', { class: 'check' }, i, h('span', {}, label, sub ? h('span', { class: 'muted small block' }, sub) : null));
    };
    // 세로 화면 채우는 방식: 썸네일로 미리보기
    // 썸네일이 없으면 16:9 색 막대 그림으로 대신
    const placeholder = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="4" height="9" fill="#e5484d"/><rect x="4" width="4" height="9" fill="#f5a524"/><rect x="8" width="4" height="9" fill="#3ddc97"/><rect x="12" width="4" height="9" fill="#5b7cff"/></svg>');
    const thumb = `url("${info.thumbnail || placeholder}")`;
    const fillCard = ([v, label, desc]) => {
      const pv = h('span', { class: `fill-pv fill-${v}`, style: { '--thumb': thumb, aspectRatio: `${project().width} / ${project().height}` } },
        v === 'blurfill' ? h('span', { class: 'fill-bg' }) : null,
        h('span', { class: 'fill-fg' }));
      const b = h('button', { class: `card fill-card ${opts.fill === v ? 'active' : ''}`, title: desc, onclick: () => {
        opts.fill = v;
        b.parentNode.querySelectorAll('.fill-card').forEach((x) => x.classList.toggle('active', x === b));
      } }, pv, h('span', { class: 'card-name' }, label), h('span', { class: 'muted small' }, desc));
      return b;
    };
    const fillCards = h('div', { class: 'fill-cards' }, [
      ['blurfill', '원본 + 흐린 배경', '잘리는 곳 없이'],
      ['cover', '꽉 채우기', '가운데만 크게'],
      ['keep', '그대로', '위아래 검은 여백'],
    ].map(fillCard));
    const modeSeg = h('div', { class: 'seg yt-mode' }, [[false, '✂ 구간 고르기'], [true, '🎞 전체 영상']].map(([v, l]) => {
      const b = h('button', { class: opts.full === v ? 'active' : '', onclick: () => {
        opts.full = v;
        modeSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        sync();
      } }, l);
      return b;
    }));
    rangeBox.append(
      h('div', { class: 'ctl' }, h('label', {}, '시작'), h('div', { class: 'row' }, startInp, nowBtn('지금 위치', (t) => { start = t; if (end <= start) end = start + 30; }))),
      h('div', { class: 'ctl' }, h('label', {}, '끝'), h('div', { class: 'row' }, endInp, nowBtn('지금 위치', (t) => { end = t; }))),
      yt ? h('div', { class: 'ctl yt-range-side' }, h('button', { class: 'btn small', onclick: preview }, '▶ 구간 미리보기')) : h('div'));
    if (info.isLive) goBtn2.disabled = true;
    goBtn2.onclick = () => {
      if (info.isLive) return;
      if (!opts.full && end - start <= 0.5) { toast('구간을 다시 확인해 주세요'); return; }
      cleanup?.();
      download(url, info, opts.full ? { ...opts, start: null, end: null } : { ...opts, start, end });
    };
    stage.replaceChildren(...[
      h('div', { class: 'yt-meta' },
        h('b', {}, info.title || '제목 없음'),
        h('span', { class: 'muted small' }, [info.channel, dur ? fmtClock(dur) : null, info.isLive ? '라이브 중' : null].filter(Boolean).join(' · '))),
      info.isLive ? h('div', { class: 'check-item warn' }, '⚠️ 지금 방송 중인 라이브는 가져올 수 없어요. 방송이 끝난 뒤 다시보기 링크로 가져와 주세요.') : null,
      playerBox,
      h('div', { class: 'yt-mode-row' }, modeSeg, lenEl),
      rangeBox,
      warn,
      narrow ? h('div', { class: 'ctl' }, h('label', {}, '세로 화면 채우는 방식'), fillCards) : null,
      h('div', { class: 'tpl-grid' },
        h('div', {},
          h('div', { class: 'ctl' }, h('label', {}, '화질'), seg([[720, '720p'], [1080, '1080p']], 'height'))),
        h('div', {},
          cb('exact', '정확한 시간에 자르기', '조금 느리지만 고른 시간에 딱 맞게 잘라요'),
          cb('credit', '출처 표시 넣기', `‘출처: ${info.channel || '채널'}’ 글자를 영상 위에 넣어요`))),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => close() }, '취소'),
        goBtn2),
    ].filter(Boolean));
    sync();
  }

  async function download(url, info, o) {
    const bar = h('div', { class: 'progress-bar' });
    const label = h('div', { class: 'progress-label' }, '시작하는 중…');
    let jobId = null;
    let cancelled = false;
    stepUrl.hidden = true;
    stage.replaceChildren(
      h('div', { class: 'yt-meta' }, h('b', {}, info.title || ''), h('span', { class: 'muted small' }, o.start == null ? '전체 영상' : `${fmtClock(o.start)} ~ ${fmtClock(o.end)} (${fmtDur(o.end - o.start)})`)),
      h('div', { class: 'progress' }, bar), label,
      h('p', { class: 'muted small' }, '고른 구간만 받아요. 원본 길이와 인터넷 속도에 따라 시간이 걸려요.'),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: async () => {
        cancelled = true;
        if (jobId) await api(`/job/${jobId}`, { method: 'DELETE' }).catch(() => {});
        close();
        toast('가져오기를 취소했어요');
      } }, '취소')));
    try {
      const { job } = await api('/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, start: o.start, end: o.end, height: o.height, exact: o.exact, engine: info.engine }),
      });
      jobId = job;
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        if (cancelled) return;
        const s = await api(`/job/${job}`);
        bar.style.width = `${s.progress}%`;
        label.textContent = `${s.stage} ${Math.round(s.progress)}%`;
        if (s.status === 'error') throw new Error(s.error);
        if (s.status === 'done') break;
      }
      label.textContent = '편집기로 옮기는 중…';
      const r = await api(`/job/${job}/file`, { raw: true, timeout: 600000 });
      if (!r.ok) throw new Error('파일을 받지 못했어요');
      const blob = await r.blob();
      if (cancelled) return;
      const ext = r.headers.get('X-File-Ext') || 'mp4';
      const safe = (info.title || 'youtube').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
      const tag = o.start == null ? '' : ` [${fmtClock(o.start).replace(/:/g, '.')}]`;
      const file = new File([blob], `${safe}${tag}.${ext}`, { type: blob.type || 'video/mp4' });
      close();
      await addToProject(file, info, url, o);
    } catch (e) {
      if (cancelled) return;
      console.error(e);
      if (!body.isConnected) { toast(`가져오지 못했어요: ${friendlyError(e.message)}`, { type: 'error', duration: 8000 }); return; }
      stepUrl.hidden = false;
      stage.replaceChildren(h('div', { class: 'check-item error' }, `⛔ ${friendlyError(e.message)}`));
    }
  }
}

function friendlyError(msg) {
  if (/Sign in|age|confirm your age/i.test(msg)) return `로그인이 필요한 영상(연령 제한·멤버십 등)은 가져올 수 없어요. (${msg})`;
  if (/private|unavailable|removed/i.test(msg)) return `비공개이거나 삭제된 영상이에요. (${msg})`;
  if (/Failed to fetch|NetworkError|abort/i.test(msg)) return '도우미와 연결이 끊겼어요. 도우미 창이 켜져 있는지 확인해 주세요.';
  return msg;
}

async function addToProject(file, info, url, o) {
  const { added, errors } = await importFiles([file]);
  errors.forEach((e) => toast(e, { type: 'error' }));
  const m = added[0];
  if (!m) return;
  mutate('유튜브 출처 기록', (p) => {
    const mm = p.media.find((x) => x.id === m.id);
    if (mm) mm.source = { kind: parseLink(url)?.platform || 'web', url: info.url || url, title: info.title, channel: info.channel, start: o.start, end: o.end };
  });
  const main = clipsOnTrack('v1');
  const c = addMediaClip(m.id, { at: main.length ? clipEnd(main[main.length - 1]) : 0, trackId: 'v1' });
  if (!c) return;
  const vertical = project().height > project().width;
  const narrow = project().width / project().height < 1.3;
  mutate('가져온 영상 배치', (p) => {
    const x = p.clips.find((y) => y.id === c.id);
    if (narrow) x.fit = o.fill === 'keep' ? 'contain' : o.fill;
    if (o.credit && (info.channel || info.title)) {
      const st = textStyleById('minimal');
      const t = defaultClip('text', {
        start: x.start, dur: x.dur, trackId: trackFor('text').id,
        text: { content: `출처: ${info.channel || info.title}`, style: st.id, size: 0.8, x: 0.5, y: vertical ? 0.06 : 0.07, anim: 'none', credit: true },
      });
      p.clips.push(t);
    }
  });
  state.time = c.start;
  toast(o.start == null ? `'${info.title || '영상'}' 전체를 가져왔어요` : `'${info.title || '영상'}' ${fmtClock(o.start)}~${fmtClock(o.end)} 구간을 가져왔어요`, { duration: 5000 });
}

function appToolError(retry, health) {
  return h('div', { class: 'yt-setup' },
    h('div', { class: 'check-item error' }, health && !health.ffmpeg
      ? '⛔ 앱에 들어 있는 ffmpeg를 찾지 못했어요. 앱을 다시 설치해 주세요.'
      : '⛔ 앱 안의 다운로드 도구(yt-dlp)를 시작하지 못했어요. 앱을 다시 실행하거나, 아래 버튼으로 yt-dlp를 다시 받아 보세요.'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: async () => { toast('yt-dlp 받는 중…'); const r = await native.ytdlp.update(); toast(updateMessage(r)); } }, 'yt-dlp 다시 받기'),
      h('button', { class: 'btn primary', onclick: retry }, '다시 확인')));
}

export function updateMessage(r) {
  if (!r) return '';
  if (r.status === 'updated') return `yt-dlp를 최신 버전(${r.version})으로 업데이트했어요`;
  if (r.status === 'latest') return `yt-dlp가 이미 최신 버전이에요 (${r.version})`;
  if (r.status === 'checking') return 'yt-dlp 업데이트 확인 중…';
  if (r.status === 'error') return `yt-dlp 업데이트 실패: ${r.message || '알 수 없는 오류'}`;
  return r.message || '';
}

/** 앱: yt-dlp 버전 표시 + 지금 업데이트 */
function ytdlpBar() {
  if (!isDesktopApp) return null;
  const label = h('span', { class: 'muted small' }, 'yt-dlp 확인 중…');
  const btn = h('button', { class: 'btn ghost small', onclick: async () => {
    btn.disabled = true;
    label.textContent = 'yt-dlp 업데이트 확인 중…';
    const r = await native.ytdlp.update();
    label.textContent = `yt-dlp ${r.version || ''} · ${r.status === 'updated' ? '방금 업데이트됨' : r.status === 'latest' ? '최신 버전' : '업데이트 실패'}`;
    if (r.status === 'error') toast(updateMessage(r), { type: 'error' });
    btn.disabled = false;
  } }, '지금 업데이트');
  native.ytdlp.status().then((s) => {
    label.textContent = s.version ? `yt-dlp ${s.version} · 하루 한 번 자동 업데이트` : 'yt-dlp 없음';
  });
  return h('div', { class: 'yt-tool-bar' }, label, btn);
}

function setupGuide(retry, health) {
  if (isDesktopApp) return appToolError(retry, health);
  const mac = /Mac/.test(navigator.platform);
  const win = /Win/.test(navigator.platform);
  const install = win
    ? ['winget install yt-dlp.yt-dlp Gyan.FFmpeg']
    : mac ? ['brew install yt-dlp ffmpeg'] : ['pip install -U yt-dlp', 'sudo apt install ffmpeg'];
  const copyRow = (cmd) => h('div', { class: 'cmd-row' }, h('code', {}, cmd),
    h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(cmd).then(() => toast('복사했어요')) }, '복사'));
  const missing = health ? [!health.ytdlp && 'yt-dlp', !health.ffmpeg && 'ffmpeg'].filter(Boolean) : null;
  const urlInp = h('input', { class: 'text-input', value: helperUrl(), 'aria-label': '도우미 주소' });
  urlInp.addEventListener('keydown', (e) => e.stopPropagation());
  urlInp.addEventListener('change', () => { try { localStorage.setItem('editin.helper', urlInp.value.trim() || DEFAULT_HELPER); } catch { /* 무시 */ } });
  return h('div', { class: 'yt-setup' },
    h('div', { class: 'check-item warn' }, missing?.length
      ? `⚠️ 도우미는 켜져 있지만 ${missing.join(', ')}이(가) 설치되어 있지 않아요.`
      : '⚠️ 유튜브 도우미가 꺼져 있어요. 브라우저는 보안상 유튜브 영상을 직접 받을 수 없어서, 내 컴퓨터에서 작은 도우미를 켜야 해요.'),
    h('ol', { class: 'setup-steps' },
      h('li', {}, h('b', {}, '처음 한 번만: '), 'yt-dlp와 ffmpeg 설치', ...install.map(copyRow)),
      h('li', {}, h('b', {}, '편집기 폴더에서 도우미 켜기 '), h('span', { class: 'muted small' }, '(창을 켜 둔 채로 쓰세요)'), copyRow('npm run yt-helper')),
      h('li', {}, '아래 ‘다시 확인’ 누르기')),
    h('details', {}, h('summary', { class: 'muted small' }, '도우미 주소 바꾸기'), urlInp),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: retry }, '다시 확인')));
}

/** 붙여넣은 글이 유튜브 링크인지 */
export function isYouTubeUrl(s) {
  return !!parseYouTube(String(s || ''));
}

/** 붙여넣으면 가져오기 창을 열 링크 (유튜브·치지직) */
export function isSupportedUrl(s) {
  return !!parseLink(String(s || '').trim());
}

export { mediaById };
