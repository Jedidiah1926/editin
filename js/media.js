// 미디어 불러오기와 분석 (길이, 썸네일, 파형)

import { mutate, uid, mediaRuntime, emit, idbPut, mediaById } from './store.js';

const PEAK_RATE = 100; // 초당 RMS 샘플 수
export const THUMB_H = 48;

export function mediaKind(file) {
  const t = file.type || '';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('image/')) return 'image';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  return null;
}

function loadMeta(kind, url) {
  return new Promise((resolve, reject) => {
    if (kind === 'image') {
      const img = new Image();
      img.onload = () => resolve({ duration: Infinity, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('이미지를 읽을 수 없어요'));
      img.src = url;
      return;
    }
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => {
      const finish = () => resolve({
        duration: el.duration,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
      });
      // 일부 webm은 길이가 Infinity로 나옴 → 끝으로 이동해 실제 길이 확인
      if (!isFinite(el.duration)) {
        el.ontimeupdate = () => {
          el.ontimeupdate = null;
          if (isFinite(el.duration)) finish();
          else resolve({ duration: el.currentTime || 1, width: el.videoWidth, height: el.videoHeight });
        };
        el.currentTime = 1e9;
      } else finish();
    };
    el.onerror = () => reject(new Error('이 형식은 브라우저에서 재생할 수 없어요'));
    el.src = url;
  });
}

/** 파일들을 불러와 미디어 라이브러리에 추가. 추가된 media 배열 반환 */
export async function importFiles(fileList) {
  const added = [];
  const errors = [];
  for (const file of fileList) {
    const kind = mediaKind(file);
    if (!kind) {
      errors.push(`${file.name}: 지원하지 않는 파일`);
      continue;
    }
    const url = URL.createObjectURL(file);
    try {
      const meta = await loadMeta(kind, url);
      const m = {
        id: uid('m'),
        name: file.name,
        type: kind,
        duration: kind === 'image' ? null : meta.duration,
        width: meta.width,
        height: meta.height,
        hasAudio: kind !== 'image',
        size: file.size,
      };
      mediaRuntime.set(m.id, { url, file, peaks: null, thumbs: null, analyzing: true });
      added.push(m);
      idbPut('files', m.id, file);
    } catch (e) {
      URL.revokeObjectURL(url);
      errors.push(`${file.name}: ${e.message}`);
    }
  }
  if (added.length) {
    mutate(`미디어 ${added.length}개 추가`, (p) => { p.media.push(...added); });
    for (const m of added) analyze(m);
  }
  return { added, errors };
}

/** 저장된 파일로부터 런타임 정보 복원 */
export function restoreRuntime(m, file) {
  const url = URL.createObjectURL(file);
  mediaRuntime.set(m.id, { url, file, peaks: null, thumbs: null, analyzing: true });
  analyze(m);
}

async function analyze(m) {
  const rt = mediaRuntime.get(m.id);
  const jobs = [];
  if (m.type === 'video') jobs.push(makeThumbs(m, rt).catch(() => null));
  if (m.type === 'image') jobs.push(makeImageThumb(m, rt).catch(() => null));
  if (m.type !== 'image') jobs.push(makePeaks(m, rt).catch(() => null));
  await Promise.all(jobs);
  rt.analyzing = false;
  emit('media-analyzed', m.id);
}

async function makeImageThumb(m, rt) {
  const img = new Image();
  img.src = rt.url;
  await img.decode();
  const tw = Math.max(1, Math.round((THUMB_H * img.naturalWidth) / img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = THUMB_H;
  c.getContext('2d').drawImage(img, 0, 0, tw, THUMB_H);
  rt.thumbs = { url: await canvasUrl(c, 'image/jpeg', 0.7), count: 1, tw, interval: Infinity };
  rt.poster = rt.thumbs.url;
}

async function makeThumbs(m, rt) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = rt.url;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; });
  const aspect = (v.videoWidth || 16) / (v.videoHeight || 9);
  const tw = Math.max(16, Math.round(THUMB_H * aspect));
  const count = Math.max(1, Math.min(60, Math.ceil(m.duration / 2)));
  const interval = m.duration / count;
  const c = document.createElement('canvas');
  c.width = tw * count;
  c.height = THUMB_H;
  const ctx = c.getContext('2d');
  for (let i = 0; i < count; i++) {
    const t = Math.min(m.duration - 0.05, i * interval + interval / 2);
    await seek(v, t);
    ctx.drawImage(v, i * tw, 0, tw, THUMB_H);
    if (i === 0) {
      const pc = document.createElement('canvas');
      pc.width = tw * 2;
      pc.height = THUMB_H * 2;
      pc.getContext('2d').drawImage(v, 0, 0, pc.width, pc.height);
      rt.poster = await canvasUrl(pc, 'image/jpeg', 0.7);
      emit('media-analyzed', m.id);
    }
  }
  rt.thumbs = { url: await canvasUrl(c, 'image/jpeg', 0.65), count, tw, interval };
  v.removeAttribute('src');
  v.load();
}

function seek(v, t) {
  return new Promise((res) => {
    const done = () => { v.removeEventListener('seeked', done); res(); };
    v.addEventListener('seeked', done);
    v.currentTime = Math.max(0, t);
    setTimeout(done, 1500);
  });
}

let decodeCtx;
async function makePeaks(m, rt) {
  const buf = await rt.file.arrayBuffer();
  decodeCtx = decodeCtx || new OfflineAudioContext(1, 1, 44100);
  let audio;
  try {
    audio = await decodeCtx.decodeAudioData(buf);
  } catch {
    // 오디오 트랙 없음
    if (m.type === 'video') setHasAudio(m.id, false);
    return;
  }
  const n = Math.ceil(audio.duration * PEAK_RATE);
  const peaks = new Float32Array(n);
  const win = Math.floor(audio.sampleRate / PEAK_RATE);
  const chans = [];
  for (let ch = 0; ch < audio.numberOfChannels; ch++) chans.push(audio.getChannelData(ch));
  let max = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const s0 = i * win;
    const s1 = Math.min(s0 + win, audio.length);
    for (let s = s0; s < s1; s++) {
      let v = 0;
      for (const d of chans) v += d[s];
      v /= chans.length;
      sum += v * v;
    }
    peaks[i] = Math.sqrt(sum / Math.max(1, s1 - s0));
    if (peaks[i] > max) max = peaks[i];
  }
  rt.peaks = peaks;
  rt.peakRate = PEAK_RATE;
  rt.peakMax = max;
  if (m.type === 'video' && max < 1e-4) setHasAudio(m.id, false);
  rt.wave = await drawWave(peaks, max);
}

function setHasAudio(id, v) {
  const m = mediaById(id);
  if (m && m.hasAudio !== v) {
    m.hasAudio = v; // 분석 결과일 뿐이므로 실행 취소 기록에 남기지 않음
    emit('project', { source: 'analysis' });
  }
}

/** 파형 이미지 (초당 50px) */
async function drawWave(peaks, max) {
  const pxPerSec = 50;
  const width = Math.min(30000, Math.max(1, Math.ceil((peaks.length / PEAK_RATE) * pxPerSec)));
  const height = 40;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  const norm = max > 0 ? 1 / max : 1;
  const per = peaks.length / width;
  for (let x = 0; x < width; x++) {
    let v = 0;
    const i0 = Math.floor(x * per);
    const i1 = Math.max(i0 + 1, Math.floor((x + 1) * per));
    for (let i = i0; i < i1 && i < peaks.length; i++) v = Math.max(v, peaks[i]);
    const hgt = Math.max(1, Math.sqrt(v * norm) * height);
    ctx.fillRect(x, (height - hgt) / 2, 1, hgt);
  }
  return { url: await canvasUrl(c, 'image/png'), pxPerSec };
}

function canvasUrl(c, type, q) {
  return new Promise((res) => c.toBlob((b) => res(b ? URL.createObjectURL(b) : c.toDataURL(type, q)), type, q));
}

/** 미디어에서 기본 클립 길이 */
export function defaultDuration(m) {
  if (m.type === 'image') return 4;
  return m.duration;
}

export { PEAK_RATE };
