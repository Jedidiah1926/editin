// editin 데스크톱 앱 (Electron)
// - 편집기 화면은 웹 버전과 같은 파일을 app:// 주소로 띄움
// - 유튜브 가져오기 도우미가 앱 안에서 함께 켜짐 (따로 실행할 필요 없음)
// - 앱에 들어 있는 yt-dlp는 하루 한 번 자동으로 최신 버전으로 업데이트

import { app, BrowserWindow, protocol, net, ipcMain, shell, session, Menu } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { startHelper, hasFfmpeg, findStreamlink } from '../tools/yt-helper.mjs';
import { prepareYtDlp, autoUpdate } from './ytdlp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'app://editin';

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true, corsEnabled: true },
}]);

// 한 번에 하나만 실행 (두 번째로 열면 기존 창을 앞으로)
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let helper = null;
let ytdlp = null;
let lastUpdate = null;

function ffmpegPath() {
  // 리눅스용 정적 ffmpeg는 인터넷 주소(호스트 이름)를 열 때 멈추는 문제가 있어, 설치된 ffmpeg가 있으면 그걸 씀
  if (process.platform === 'linux' && hasFfmpeg('ffmpeg')) return 'ffmpeg';
  try {
    // 배포본에서는 asar 밖(app.asar.unpacked)에 풀려 있음
    const p = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const fromPkg = join(ROOT, 'node_modules', 'ffmpeg-static', p).replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
    if (existsSync(fromPkg)) return fromPkg;
  } catch { /* 무시 */ }
  return null;
}

function serveFiles() {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

/** 앱에 들어 있는 streamlink (치지직 다시보기·클립용). 없으면 설치된 것을 찾음 */
function streamlinkPath() {
  const exe = process.platform === 'win32' ? 'streamlink.exe' : 'streamlink';
  const bundled = [
    join(process.resourcesPath || '', 'streamlink', 'bin', exe),
    join(ROOT, 'vendor', 'streamlink', 'bin', exe),
  ].filter((p) => existsSync(p));
  return findStreamlink([...bundled.map((p) => [p, []]), ['streamlink', []], ['python3', ['-m', 'streamlink']], ['python', ['-m', 'streamlink']]]);
}

async function startServices() {
  ytdlp = prepareYtDlp(ROOT);
  const streamlink = streamlinkPath();
  const ff = ffmpegPath();
  helper = await startHelper({
    port: 0,
    ytdlp,
    streamlink,
    ffmpeg: !!ff,
    ffmpegPath: ff === 'ffmpeg' ? null : ff,
    embedded: true,
    extraOrigins: [ORIGIN],
    // 유튜브 영상 주소 해석에 필요한 JS 런타임: 앱에 들어 있는 Node(Electron)를 그대로 씀.
    // 사용자 컴퓨터에 deno가 있으면 yt-dlp가 그걸 먼저 씀.
    extraArgs: ['--js-runtimes', `node:${process.execPath}`],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  // 하루 한 번 yt-dlp 자동 업데이트 (백그라운드)
  setTimeout(() => runUpdate(false), 4000);
}

async function runUpdate(force) {
  if (!ytdlp) return { status: 'error', message: 'yt-dlp를 찾을 수 없어요' };
  win?.webContents.send('ytdlp-status', { status: 'checking', version: ytdlp.version });
  const r = await autoUpdate(ytdlp, { force });
  lastUpdate = r;
  helper?.setYtDlp(ytdlp);
  win?.webContents.send('ytdlp-status', r);
  return r;
}

/** 내보낸 MP4 다듬기: 영상은 그대로 복사, 소리만 AAC로, moov를 앞으로(faststart) */
async function finalizeVideo(data) {
  const ff = ffmpegPath() || 'ffmpeg';
  const dir = mkdtempSync(join(tmpdir(), 'editin-export-'));
  const src = join(dir, 'in.mp4');
  const dst = join(dir, 'out.mp4');
  try {
    writeFileSync(src, Buffer.from(data));
    await new Promise((resolve, reject) => {
      const p = spawn(ff, ['-y', '-v', 'error', '-i', src, '-map', '0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', dst], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg ${code}`))));
      p.on('error', reject);
    });
    return readFileSync(dst);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1117',
    title: 'editin',
    icon: join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--editin-helper=${helper?.url || ''}`, `--editin-version=${app.getVersion()}`],
    },
  });
  win.loadURL(`${ORIGIN}/index.html`);
  // 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  serveFiles();
  // 유튜브 플레이어(구간 고르기)는 Referer가 없으면 재생을 거부하므로 채워 줌
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube.com/*', 'https://www.youtube-nocookie.com/*'] },
    (d, cb) => {
      if (!d.requestHeaders.Referer || d.requestHeaders.Referer.startsWith('app://')) d.requestHeaders.Referer = 'https://editin.app/';
      cb({ requestHeaders: d.requestHeaders });
    },
  );
  ipcMain.handle('ytdlp:update', () => runUpdate(true));
  ipcMain.handle('media:finalize', (_e, data) => finalizeVideo(data));
  ipcMain.handle('ytdlp:status', () => ({ version: ytdlp?.version || null, last: lastUpdate }));
  try {
    await startServices();
  } catch (e) {
    console.error('[editin] 도우미 시작 실패', e);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  helper?.stop();
  app.quit();
});
