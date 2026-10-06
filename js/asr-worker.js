// 음성 인식 워커: Whisper(transformers.js)를 브라우저 안에서 실행 — 음성이 외부로 전송되지 않음
// 모델은 처음 한 번 내려받고 브라우저 캐시에 저장됨

const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const SR = 16000;

let transcriber = null;
let loadedModel = null;

async function load(model, id) {
  if (transcriber && loadedModel === model) return;
  const { pipeline, env } = await import(LIB);
  env.allowLocalModels = false;
  let device = 'wasm';
  try {
    if (self.navigator?.gpu && (await self.navigator.gpu.requestAdapter())) device = 'webgpu';
  } catch { /* WebGPU 없음 */ }
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.file) {
      files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      self.postMessage({ type: 'status', id, stage: 'download', loaded, total });
    }
  };
  if (transcriber) await transcriber.dispose?.();
  transcriber = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback,
  });
  loadedModel = model;
  self.postMessage({ type: 'status', id, stage: 'ready', device });
}

function rms(a, s, n) {
  let sum = 0;
  const e = Math.min(a.length, s + n);
  for (let i = s; i < e; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / Math.max(1, e - s));
}

/** 긴 음성을 가장 조용한 지점에서 끊어 30초 이하 조각으로 나눔 (문장 중간 절단 방지) */
function splitWindows(audio, maxLen = 28, minLen = 12) {
  const out = [];
  let s = 0;
  const n = audio.length;
  const win = SR * 0.1;
  const step = SR * 0.05;
  while (s < n) {
    if (n - s <= maxLen * SR) { out.push([s, n]); break; }
    let best = s + maxLen * SR;
    let bestE = Infinity;
    for (let p = s + minLen * SR; p < s + maxLen * SR - win; p += step) {
      const e = rms(audio, p, win);
      if (e < bestE) { bestE = e; best = Math.round(p + win / 2); }
    }
    out.push([s, best]);
    s = best;
  }
  return out;
}

self.onmessage = async (e) => {
  const { type, id } = e.data;
  if (type !== 'run') return;
  try {
    const { audio, model, language } = e.data;
    self.postMessage({ type: 'status', id, stage: 'loading' });
    await load(model, id);
    const windows = splitWindows(audio);
    const segments = [];
    for (let k = 0; k < windows.length; k++) {
      const [a, b] = windows[k];
      self.postMessage({ type: 'progress', id, done: k, total: windows.length });
      const piece = audio.subarray(a, b);
      // 거의 무음인 조각은 건너뜀 (Whisper가 없는 말을 지어내는 것 방지)
      if (rms(piece, 0, piece.length) < 0.004) continue;
      const opts = { return_timestamps: true, task: 'transcribe' };
      if (language && language !== 'auto') opts.language = language;
      const out = await transcriber(piece, opts);
      const off = a / SR;
      const dur = (b - a) / SR;
      for (const ch of out.chunks || [{ text: out.text, timestamp: [0, dur] }]) {
        const [cs, ce] = ch.timestamp || [0, dur];
        const text = (ch.text || '').trim();
        if (!text) continue;
        segments.push({ text, start: off + (cs ?? 0), end: off + Math.min(ce ?? dur, dur) });
      }
    }
    self.postMessage({ type: 'progress', id, done: windows.length, total: windows.length });
    self.postMessage({ type: 'result', id, segments });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
