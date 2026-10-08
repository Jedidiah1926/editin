#!/usr/bin/env node
// editin 유튜브 도우미
// 브라우저는 보안 정책상 유튜브 영상을 직접 받을 수 없어서, 내 컴퓨터에서 이 도우미가 yt-dlp로 받아 편집기에 넘겨줌.
// 필요한 프로그램: yt-dlp, ffmpeg  (설치 방법은 README 참고)
// 실행: npm run yt-helper   (기본 주소 http://127.0.0.1:8787)
// 데스크톱 앱(Electron)에서는 앱 안에서 startHelper()로 바로 켜짐 — 따로 실행할 필요 없음

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.EDITIN_HELPER_PORT || 8787);
const HOST = '127.0.0.1';
// 편집기를 연 주소만 허용 (다른 웹사이트가 도우미를 쓰지 못하게)
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_JOBS = 3;

export function findYtDlp(candidates) {
  const list = candidates || [['yt-dlp', []], ['yt-dlp.exe', []], ['python3', ['-m', 'yt_dlp']], ['python', ['-m', 'yt_dlp']]];
  for (const [cmd, pre] of list) {
    const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return { cmd, pre, version: r.stdout.trim() };
  }
  return null;
}

export function findStreamlink(candidates) {
  const list = candidates || [['streamlink', []], ['streamlink.exe', []], ['python3', ['-m', 'streamlink']], ['python', ['-m', 'streamlink']]];
  for (const [cmd, pre] of list) {
    const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return { cmd, pre, version: r.stdout.trim().replace(/^streamlink\s*/i, '') };
  }
  return null;
}

export function hasFfmpeg(path = 'ffmpeg') {
  return spawnSync(path, ['-version'], { windowsHide: true }).status === 0;
}

// 설정: CLI로 실행하면 시스템에 설치된 것을, 앱에서는 앱에 들어 있는 것을 씀
const cfg = {
  ytdlp: null, // { cmd, pre, version }
  streamlink: null, // { cmd, pre, version } — 치지직 다시보기·클립용 (yt-dlp가 안 될 때)
  ffmpeg: false,
  ffmpegPath: null, // 지정하면 --ffmpeg-location으로 전달
  extraArgs: [], // 예: JS 런타임 지정
  env: {},
  extraOrigins: (process.env.EDITIN_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
};
const jobs = new Map();

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && (LOCAL_ORIGIN.test(origin) || cfg.extraOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    return true;
  }
  return !origin; // 브라우저가 아닌 요청(curl 등)은 허용
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function validUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function run(args) {
  const pre = [...cfg.ytdlp.pre, ...cfg.extraArgs];
  if (cfg.ffmpegPath) pre.push('--ffmpeg-location', cfg.ffmpegPath);
  return spawn(cfg.ytdlp.cmd, [...pre, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...cfg.env }, windowsHide: true });
}

/** 영상 정보 (제목, 채널, 길이, 썸네일) */
function info(url) {
  return new Promise((resolve, reject) => {
    const p = run(['-J', '--no-playlist', '--no-warnings', url]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      if (code !== 0) { reject(new Error(cleanErr(err) || '영상 정보를 가져오지 못했어요')); return; }
      try {
        const j = JSON.parse(out);
        resolve({
          id: j.id,
          title: j.title,
          channel: j.channel || j.uploader || '',
          channelUrl: j.channel_url || j.uploader_url || '',
          duration: j.duration || null,
          thumbnail: j.thumbnail || '',
          url: j.webpage_url || url,
          isLive: !!j.is_live,
          extractor: j.extractor_key || j.extractor || '',
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function cleanErr(s) {
  const line = String(s).split('\n').reverse().find((l) => l.includes('ERROR'));
  return (line || s).replace(/^.*ERROR:\s*/, '').trim().slice(0, 300);
}

const fmtT = (t) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2);
  return `${h}:${String(m).padStart(2, '0')}:${s.padStart(5, '0')}`;
};

/**
 * 지정 구간만 받기 (키리누키용). start/end가 없으면 전체.
 * 사이트마다 구간 받기 지원이 달라서(치지직 DASH 등) 실패하면 순서대로 다른 방법을 시도:
 *  1) 구간만 + 정확한 자르기  2) 구간만 (키프레임 기준)  3) 전체를 받은 뒤 ffmpeg로 잘라내기
 */
function startDownload({ url, start, end, height = 1080, exact = true, engine }) {
  const id = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'editin-'));
  const job = { id, dir, status: 'running', progress: 0, stage: '준비 중', error: null, file: null, proc: null };
  const useStreamlink = cfg.streamlink && (engine === 'streamlink' || process.env.EDITIN_HELPER_FORCE_STREAMLINK);
  if (useStreamlink || (!cfg.ytdlp && cfg.streamlink && isChzzk(url))) {
    jobs.set(id, job);
    startStreamlink(job, { url, start, end });
    return job;
  }
  const hasSection = start != null || end != null;
  const a = Math.max(0, Number(start) || 0);
  const b = end != null ? Number(end) : null;
  const plans = hasSection
    ? [
      ...(exact ? [{ section: true, exact: true }] : []),
      { section: true, exact: false, label: '다른 방법으로 다시 받는 중' },
      { section: false, cutAfter: true, label: '구간만 받기가 안 되는 영상이라 전체를 받은 뒤 자르는 중' },
    ]
    : [{ section: false }];

  const onData = (d) => {
    for (const line of String(d).split('\n')) {
      const m = line.match(/PROG\s+([\d.]+)%/);
      if (m) { job.progress = Math.min(99, parseFloat(m[1])); if (!job.fixedStage) job.stage = '받는 중'; }
      else if (/\[Merger\]|\[ffmpeg\]|Destination/.test(line) && !job.fixedStage) job.stage = '파일 만드는 중';
    }
  };
  const clearDir = () => { for (const f of existsDir(dir) ? readdirSync(dir) : []) rmSync(join(dir, f), { force: true }); };
  const finish = (file) => {
    job.file = file;
    job.size = statSync(file).size;
    job.status = 'done';
    job.progress = 100;
    job.stage = '완료';
  };
  const fail = (msg) => { job.status = 'error'; job.error = msg || '다운로드에 실패했어요'; };

  const attempt = (i) => {
    const plan = plans[i];
    clearDir();
    job.progress = 0;
    job.fixedStage = plan.label || null;
    if (plan.label) job.stage = plan.label;
    const args = [
      '--no-playlist', '--no-warnings', '--newline', '--no-part',
      '-f', `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}]/b`,
      '--merge-output-format', 'mp4',
      '-o', join(dir, 'clip.%(ext)s'),
      '--progress-template', 'download:PROG %(progress._percent_str)s',
    ];
    if (plan.section) {
      args.push('--download-sections', `*${fmtT(a)}-${b != null ? fmtT(b) : 'inf'}`);
      // 키프레임이 아닌 곳에서도 정확히 자르기 (조금 느려짐)
      if (plan.exact) args.push('--force-keyframes-at-cuts');
    }
    args.push(url);
    const p = run(args);
    job.proc = p;
    let err = '';
    p.stdout.on('data', onData);
    p.stderr.on('data', (d) => { err += d; onData(d); });
    p.on('close', (code) => {
      job.proc = null;
      if (job.status === 'cancelled') return;
      const files = existsDir(dir) ? readdirSync(dir).filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl')) : [];
      const got = files.find((f) => f.endsWith('.mp4')) || files[0];
      if (code === 0 && got) {
        if (plan.cutAfter) cutLocal(join(dir, got), err);
        else finish(join(dir, got));
        return;
      }
      // 로그인·삭제 등 다시 해도 안 되는 오류는 바로 알림
      const msg = cleanErr(err);
      if (i + 1 < plans.length && !/Sign in|login|private|unavailable|removed|not exist|age|성인|19/i.test(msg)) attempt(i + 1);
      else if (cfg.streamlink && isChzzk(url)) { job.stage = 'yt-dlp가 안 돼서 streamlink로 받는 중'; startStreamlink(job, { url, start: a, end: b }); }
      else fail(msg);
    });
  };

  // 전체를 받은 파일에서 구간만 잘라내기 (정확하게 자르려고 다시 인코딩)
  const cutLocal = (src) => {
    job.stage = '고른 구간만 잘라내는 중';
    job.fixedStage = job.stage;
    const out = join(dir, 'cut.mp4');
    const args = ['-y', '-v', 'error', '-ss', String(a)];
    if (b != null) args.push('-to', String(b));
    args.push('-i', src, '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out);
    // -ss를 -i 앞에 두면 빠르게 찾아가고, -to는 입력 기준 시간이 아니므로 길이로 계산
    if (b != null) { const k = args.indexOf('-to'); args.splice(k, 2, '-t', String(Math.max(0.1, b - a))); }
    const p = spawn(cfg.ffmpegPath || 'ffmpeg', args, { windowsHide: true });
    job.proc = p;
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      job.proc = null;
      if (job.status === 'cancelled') return;
      if (code === 0) { rmSync(src, { force: true }); finish(out); } else fail(`자르기 실패: ${String(err).trim().slice(0, 200)}`);
    });
  };

  jobs.set(id, job);
  // 시험용: EDITIN_HELPER_START_PLAN=2 면 '전체 받은 뒤 자르기'부터 (실패 대비 경로 점검)
  attempt(Math.min(plans.length - 1, Number(process.env.EDITIN_HELPER_START_PLAN) || 0));
  // 오래된 작업 정리
  if (jobs.size > MAX_JOBS * 4) for (const [k, j] of jobs) if (j.status !== 'running') { cleanup(j); jobs.delete(k); if (jobs.size <= MAX_JOBS * 2) break; }
  return job;
}

// ---------- 치지직 (yt-dlp가 안 될 때 streamlink로) ----------

const CHZZK = /^https?:\/\/chzzk\.naver\.com\/(video|clips|live)\/([^/?#]+)/;
export const isChzzk = (url) => CHZZK.test(String(url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

async function chzzkApi(path) {
  const r = await fetch(`https://api.chzzk.naver.com${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 200) throw new Error(j?.message || `치지직 정보를 가져오지 못했어요 (${r.status})`);
  return j.content;
}

/** 치지직 영상·클립 정보: 공식 API → 안 되면 streamlink --json */
async function chzzkInfo(url) {
  const [, kind, id] = url.match(CHZZK);
  if (kind === 'live') {
    const c = await chzzkApi(`/service/v2/channels/${id}/live-detail`).catch(() => null);
    return { id, title: c?.liveTitle || '라이브', channel: c?.channel?.channelName || '', duration: null, thumbnail: '', url, isLive: true, extractor: 'chzzk', engine: 'streamlink' };
  }
  let c = null;
  try {
    c = kind === 'video' ? await chzzkApi(`/service/v2/videos/${id}`) : await chzzkApi(`/service/v1/play-info/clip/${id}`);
  } catch { /* 아래에서 streamlink로 */ }
  if (c?.adult && !c.inKey && !c.liveRewindPlaybackJson) throw new Error('성인 인증이 필요한 영상이라 가져올 수 없어요');
  let title = c?.videoTitle || c?.contentTitle || '';
  let channel = c?.channel?.channelName || c?.ownerChannel?.channelName || '';
  if ((!title || !channel) && cfg.streamlink) {
    const meta = await streamlinkJson(url).catch(() => null);
    title = title || meta?.title || '';
    channel = channel || meta?.author || '';
  }
  if (!c && !title) throw new Error('치지직 영상 정보를 가져오지 못했어요. 링크가 맞는지, 삭제된 영상이 아닌지 확인해 주세요.');
  return {
    id,
    title: title || `치지직 ${kind === 'clips' ? '클립' : '영상'} ${id}`,
    channel,
    channelUrl: '',
    duration: c?.duration || c?.contentDuration || null,
    thumbnail: c?.thumbnailImageUrl || c?.thumbnailImageURL || '',
    url,
    isLive: false,
    isClip: kind === 'clips',
    extractor: 'chzzk',
    engine: 'streamlink',
  };
}

function streamlinkJson(url) {
  return new Promise((resolve, reject) => {
    const p = spawn(cfg.streamlink.cmd, [...cfg.streamlink.pre, '--json', url], { windowsHide: true, env: { ...process.env, ...cfg.env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        if (j.error) reject(new Error(j.error)); else resolve(j.metadata || {});
      } catch (e) { reject(e); }
    });
    p.on('error', reject);
  });
}

/**
 * streamlink로 받기. 치지직 다시보기는 DASH라 중간부터 받을 수 없어서,
 * 구간이면 처음부터 끝 시간까지 받은 뒤 ffmpeg로 구간만 잘라냄.
 */
function startStreamlink(job, { url, start, end }) {
  const dir = job.dir;
  const ts = join(dir, 'stream.ts');
  const a = Math.max(0, Number(start) || 0);
  const b = end != null ? Number(end) : null;
  const args = [...cfg.streamlink.pre, '--force', '--progress', 'force', '-o', ts];
  if (cfg.ffmpegPath) args.push('--ffmpeg-ffmpeg', cfg.ffmpegPath);
  if (b != null) args.push('--stream-segmented-duration', fmtT(b + 3));
  args.push(url, 'best');
  job.stage = b != null && a > 30 ? '치지직은 처음부터 고른 끝 시간까지 받은 뒤 잘라요' : '받는 중';
  job.fixedStage = job.stage;
  const p = spawn(cfg.streamlink.cmd, args, { windowsHide: true, env: { ...process.env, ...cfg.env } });
  job.proc = p;
  let err = '';
  const onData = (d) => {
    const t = String(d);
    err += t;
    // 예: [download] Written 12.34 MiB to ... (5s @ 2.47 MiB/s)
    const m = t.match(/Written\s+([\d.]+)\s*(KiB|MiB|GiB)/);
    if (m) {
      const mb = parseFloat(m[1]) * (m[2] === 'GiB' ? 1024 : m[2] === 'KiB' ? 1 / 1024 : 1);
      job.written = mb;
      job.stage = `${job.fixedStage} · ${mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${Math.round(mb)}MB`} 받음`;
    }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('close', (code) => {
    job.proc = null;
    if (job.status === 'cancelled') return;
    if (!existsDir(dir) || !readdirSync(dir).includes('stream.ts') || statSync(ts).size < 1000) {
      job.status = 'error';
      const line = err.split('\n').reverse().find((l) => /error/i.test(l)) || err.trim().split('\n').pop() || '';
      job.error = /adult/i.test(line) ? '성인 인증이 필요한 영상이라 가져올 수 없어요' : (line.replace(/^.*error:\s*/i, '').slice(0, 300) || `streamlink 오류 (${code})`);
      return;
    }
    // 마무리: 구간이면 잘라내고(정확하게 다시 인코딩), 전체면 MP4로 옮겨 담기만
    job.stage = b != null || a > 0 ? '고른 구간만 잘라내는 중' : 'MP4로 바꾸는 중';
    const out = join(dir, 'clip.mp4');
    const ff = b != null || a > 0
      ? ['-y', '-v', 'error', '-ss', String(a), '-i', ts, ...(b != null ? ['-t', String(Math.max(0.1, b - a))] : []), '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]
      : ['-y', '-v', 'error', '-i', ts, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', out];
    const q = spawn(cfg.ffmpegPath || 'ffmpeg', ff, { windowsHide: true });
    job.proc = q;
    let ferr = '';
    q.stderr.on('data', (d) => { ferr += d; });
    q.on('close', (c2) => {
      job.proc = null;
      if (job.status === 'cancelled') return;
      if (c2 !== 0) { job.status = 'error'; job.error = `변환 실패: ${ferr.trim().slice(0, 200)}`; return; }
      rmSync(ts, { force: true });
      job.file = out;
      job.size = statSync(out).size;
      job.status = 'done';
      job.progress = 100;
      job.stage = '완료';
    });
  });
}

function existsDir(d) { try { return statSync(d).isDirectory(); } catch { return false; } }

function cleanup(job) {
  try { rmSync(job.dir, { recursive: true, force: true }); } catch { /* 무시 */ }
}

const server = http.createServer(async (req, res) => {
  if (!cors(req, res)) { send(res, 403, { error: '허용되지 않은 주소에서 온 요청이에요' }); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, `http://${HOST}`);
  const { ytdlp, ffmpeg } = cfg;
  try {
    if (u.pathname === '/health') {
      send(res, 200, { ok: !!ytdlp && ffmpeg, app: 'editin-helper', ytdlp: ytdlp?.version || null, streamlink: cfg.streamlink?.version || null, ffmpeg, embedded: !!cfg.embedded });
      return;
    }
    if (!ytdlp && !cfg.streamlink) { send(res, 500, { error: 'yt-dlp가 설치되어 있지 않아요' }); return; }
    if (u.pathname === '/info' && req.method === 'GET') {
      const url = u.searchParams.get('url');
      if (!validUrl(url)) { send(res, 400, { error: '올바른 링크가 아니에요' }); return; }
      if (isChzzk(url)) {
        // 치지직: 클립·라이브는 바로 streamlink 쪽 정보, 다시보기는 yt-dlp를 먼저 시도
        const kind = url.match(CHZZK)[1];
        if (kind === 'video' && ytdlp) {
          try { send(res, 200, { ...(await info(url)), engine: 'ytdlp' }); return; } catch { /* streamlink로 */ }
        }
        send(res, 200, await chzzkInfo(url));
        return;
      }
      send(res, 200, await info(url));
      return;
    }
    if (u.pathname === '/download' && req.method === 'POST') {
      const body = await readBody(req);
      if (!validUrl(body.url)) { send(res, 400, { error: '올바른 링크가 아니에요' }); return; }
      if (!ffmpeg) { send(res, 500, { error: 'ffmpeg가 설치되어 있지 않아요' }); return; }
      const running = [...jobs.values()].filter((j) => j.status === 'running').length;
      if (running >= MAX_JOBS) { send(res, 429, { error: '이미 받고 있는 영상이 많아요. 잠시 후 다시 시도하세요.' }); return; }
      const job = startDownload(body);
      send(res, 200, { job: job.id });
      return;
    }
    const m = u.pathname.match(/^\/job\/([\w-]+)(\/file)?$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) { send(res, 404, { error: '작업을 찾을 수 없어요' }); return; }
      if (req.method === 'DELETE') {
        job.status = 'cancelled';
        job.proc?.kill();
        cleanup(job);
        jobs.delete(job.id);
        send(res, 200, { ok: true });
        return;
      }
      if (!m[2]) {
        send(res, 200, { status: job.status, progress: job.progress, stage: job.stage, error: job.error, size: job.size || 0 });
        return;
      }
      if (job.status !== 'done') { send(res, 409, { error: '아직 준비되지 않았어요' }); return; }
      const ext = (job.file.split('.').pop() || 'mp4').toLowerCase();
      const types = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime' };
      res.writeHead(200, {
        'Content-Type': types[ext] || 'application/octet-stream',
        'Content-Length': job.size,
        'X-File-Ext': ext,
        'Access-Control-Expose-Headers': 'X-File-Ext',
      });
      const s = createReadStream(job.file);
      s.pipe(res);
      s.on('close', () => { cleanup(job); jobs.delete(job.id); });
      return;
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

/** 도우미 시작. port=0이면 빈 포트를 골라 씀 */
export function startHelper(opts = {}) {
  Object.assign(cfg, opts, { extraOrigins: [...cfg.extraOrigins, ...(opts.extraOrigins || [])] });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? PORT, HOST, () => resolve({
      port: server.address().port,
      url: `http://${HOST}:${server.address().port}`,
      setYtDlp: (y) => { cfg.ytdlp = y; },
      stop: () => { for (const j of jobs.values()) { j.proc?.kill(); cleanup(j); } server.close(); },
    }));
  });
}

// 명령줄에서 직접 실행했을 때 (npm run yt-helper)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ytdlp = findYtDlp();
  const ffmpeg = hasFfmpeg();
  const streamlink = findStreamlink();
  startHelper({ ytdlp, ffmpeg, streamlink }).then(() => {
    console.log(`\n  editin 유튜브 도우미가 켜졌어요 → http://${HOST}:${PORT}`);
    console.log(`  yt-dlp: ${ytdlp ? ytdlp.version : '❌ 없음 (설치 필요: pip install yt-dlp)'}`);
    console.log(`  ffmpeg: ${ffmpeg ? '✅' : '❌ 없음 (설치 필요)'}`);
    console.log(`  streamlink: ${streamlink ? streamlink.version : '없음 (치지직 클립용, 선택: pip install streamlink)'}`);
    console.log('  편집기를 쓰는 동안 이 창을 켜 두세요. 끄려면 Ctrl+C\n');
  });
  process.on('SIGINT', () => {
    for (const j of jobs.values()) { j.proc?.kill(); cleanup(j); }
    process.exit(0);
  });
}
