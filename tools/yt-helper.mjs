#!/usr/bin/env node
// editin 유튜브 도우미
// 브라우저는 보안 정책상 유튜브 영상을 직접 받을 수 없어서, 내 컴퓨터에서 이 도우미가 yt-dlp로 받아 편집기에 넘겨줌.
// 필요한 프로그램: yt-dlp, ffmpeg  (설치 방법은 README 참고)
// 실행: npm run yt-helper   (기본 주소 http://127.0.0.1:8787)

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.EDITIN_HELPER_PORT || 8787);
const HOST = '127.0.0.1';
// 편집기를 연 주소만 허용 (다른 웹사이트가 도우미를 쓰지 못하게)
const EXTRA_ORIGINS = (process.env.EDITIN_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_JOBS = 3;

function findYtDlp() {
  for (const [cmd, pre] of [['yt-dlp', []], ['yt-dlp.exe', []], ['python3', ['-m', 'yt_dlp']], ['python', ['-m', 'yt_dlp']]]) {
    const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8' });
    if (r.status === 0) return { cmd, pre, version: r.stdout.trim() };
  }
  return null;
}

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version']).status === 0;
}

const ytdlp = findYtDlp();
const ffmpeg = hasFfmpeg();
const jobs = new Map();

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && (LOCAL_ORIGIN.test(origin) || EXTRA_ORIGINS.includes(origin))) {
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

function run(args, { onLine } = {}) {
  return spawn(ytdlp.cmd, [...ytdlp.pre, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

/** 지정 구간만 받기 (키리누키용). start/end가 없으면 전체 */
function startDownload({ url, start, end, height = 1080, exact = true }) {
  const id = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'editin-'));
  const job = { id, dir, status: 'running', progress: 0, stage: '준비 중', error: null, file: null, proc: null };
  const args = [
    '--no-playlist', '--no-warnings', '--newline', '--no-part',
    '-f', `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}]/b`,
    '--merge-output-format', 'mp4',
    '-o', join(dir, 'clip.%(ext)s'),
    '--progress-template', 'download:PROG %(progress._percent_str)s',
  ];
  if (start != null || end != null) {
    const a = Math.max(0, Number(start) || 0);
    const b = end != null ? Number(end) : null;
    args.push('--download-sections', `*${fmtT(a)}-${b != null ? fmtT(b) : 'inf'}`);
    // 키프레임이 아닌 곳에서도 정확히 자르기 (조금 느려짐)
    if (exact) args.push('--force-keyframes-at-cuts');
  }
  args.push(url);
  const p = run(args);
  job.proc = p;
  let err = '';
  const onData = (d) => {
    for (const line of String(d).split('\n')) {
      const m = line.match(/PROG\s+([\d.]+)%/);
      if (m) { job.progress = Math.min(99, parseFloat(m[1])); job.stage = '받는 중'; }
      else if (/\[Merger\]|\[ffmpeg\]|Destination/.test(line)) job.stage = '파일 만드는 중';
    }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', (d) => { err += d; onData(d); });
  p.on('close', (code) => {
    job.proc = null;
    if (job.status === 'cancelled') return;
    const files = existsDir(dir) ? readdirSync(dir).filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl')) : [];
    const mp4 = files.find((f) => f.endsWith('.mp4')) || files[0];
    if (code === 0 && mp4) {
      job.file = join(dir, mp4);
      job.size = statSync(job.file).size;
      job.status = 'done';
      job.progress = 100;
      job.stage = '완료';
    } else {
      job.status = 'error';
      job.error = cleanErr(err) || '다운로드에 실패했어요';
    }
  });
  jobs.set(id, job);
  // 오래된 작업 정리
  if (jobs.size > MAX_JOBS * 4) for (const [k, j] of jobs) if (j.status !== 'running') { cleanup(j); jobs.delete(k); if (jobs.size <= MAX_JOBS * 2) break; }
  return job;
}

function existsDir(d) { try { return statSync(d).isDirectory(); } catch { return false; } }

function cleanup(job) {
  try { rmSync(job.dir, { recursive: true, force: true }); } catch { /* 무시 */ }
}

const server = http.createServer(async (req, res) => {
  if (!cors(req, res)) { send(res, 403, { error: '허용되지 않은 주소에서 온 요청이에요' }); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (u.pathname === '/health') {
      send(res, 200, { ok: !!ytdlp && ffmpeg, app: 'editin-helper', ytdlp: ytdlp?.version || null, ffmpeg });
      return;
    }
    if (!ytdlp) { send(res, 500, { error: 'yt-dlp가 설치되어 있지 않아요' }); return; }
    if (u.pathname === '/info' && req.method === 'GET') {
      const url = u.searchParams.get('url');
      if (!validUrl(url)) { send(res, 400, { error: '올바른 링크가 아니에요' }); return; }
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

server.listen(PORT, HOST, () => {
  console.log(`\n  editin 유튜브 도우미가 켜졌어요 → http://${HOST}:${PORT}`);
  console.log(`  yt-dlp: ${ytdlp ? ytdlp.version : '❌ 없음 (설치 필요: pip install yt-dlp)'}`);
  console.log(`  ffmpeg: ${ffmpeg ? '✅' : '❌ 없음 (설치 필요)'}`);
  console.log('  편집기를 쓰는 동안 이 창을 켜 두세요. 끄려면 Ctrl+C\n');
});

process.on('SIGINT', () => {
  for (const j of jobs.values()) { j.proc?.kill(); cleanup(j); }
  process.exit(0);
});
