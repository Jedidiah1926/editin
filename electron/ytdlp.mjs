// yt-dlp 관리: 앱에 들어 있는 yt-dlp를 사용자 폴더로 복사해 두고(쓰기 가능한 곳이어야 교체 가능),
// 하루에 한 번 백그라운드에서 GitHub 최신 릴리스와 비교해 새 버전이면 받아서 교체.
// - 공식 체크섬(SHA2-256SUMS)으로 받은 파일을 검증한 뒤에만 교체
// - GitHub API 대신 릴리스 파일을 직접 받아서, 회사망·프록시 환경에서도 잘 동작

import { app, net } from 'electron';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const isWin = process.platform === 'win32';
const EXE = isWin ? 'yt-dlp.exe' : 'yt-dlp';
// GitHub 릴리스의 파일 이름
const ASSET = isWin ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const CHECK_EVERY_MS = 20 * 60 * 60 * 1000; // 하루에 한 번 정도

const userBin = () => join(app.getPath('userData'), 'bin');
const userExe = () => join(userBin(), EXE);
const stateFile = () => join(app.getPath('userData'), 'ytdlp-update.json');

/** 앱에 함께 들어 있는 yt-dlp 위치 (배포본: resources/bin, 개발 중: vendor/) */
function bundledExe(root) {
  const candidates = [
    join(process.resourcesPath || '', 'bin', EXE),
    join(root, 'vendor', EXE),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

export function versionOf(exe) {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** 쓸 yt-dlp를 준비하고 {cmd, pre, version} 반환. 없으면 시스템에 설치된 것을 찾음 */
export function prepareYtDlp(root) {
  const bundled = bundledExe(root);
  const target = userExe();
  // 지난번에 사용 중이라 교체하지 못한 새 버전이 있으면 지금 교체
  const pending = `${target}.new`;
  if (existsSync(pending)) {
    try { renameSync(pending, target); } catch { /* 다음 실행 때 다시 시도 */ }
  }
  try {
    if (bundled) {
      mkdirSync(userBin(), { recursive: true });
      const have = existsSync(target) ? versionOf(target) : null;
      const shipped = versionOf(bundled);
      // 사용자 폴더 것이 없거나, 앱 업데이트로 들어온 버전이 더 새것이면 교체
      if (!have || (shipped && shipped > have)) {
        copyFileSync(bundled, target);
        if (!isWin) chmodSync(target, 0o755);
      }
    }
  } catch (e) {
    console.error('[yt-dlp] 준비 실패', e);
  }
  for (const exe of [target, bundled, 'yt-dlp']) {
    if (!exe || (exe !== 'yt-dlp' && !existsSync(exe))) continue;
    const v = versionOf(exe);
    if (v) return { cmd: exe, pre: [], version: v };
  }
  return null;
}

function readState() {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}

function writeState(s) {
  try { writeFileSync(stateFile(), JSON.stringify(s)); } catch { /* 무시 */ }
}

export function updateInfo() {
  return readState();
}

async function download(url) {
  // 앱(크롬) 네트워크를 먼저 사용 — 시스템 프록시·인증서 설정을 따름. 안 되면 Node fetch로
  let lastErr;
  for (const f of [(u) => net.fetch(u), (u) => fetch(u)]) {
    try {
      const r = await f(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 최신 yt-dlp로 업데이트. force가 아니면 마지막 확인 후 하루가 지났을 때만.
 * 결과: { status: 'updated'|'latest'|'skipped'|'error', version, from, message }
 */
export async function autoUpdate(ytdlp, { force = false } = {}) {
  const st = readState();
  if (!ytdlp || ytdlp.cmd !== userExe()) {
    return { status: 'skipped', version: ytdlp?.version, message: '자동 업데이트는 앱에 들어 있는 yt-dlp에서만 돼요' };
  }
  if (!force && st.lastCheck && Date.now() - st.lastCheck < CHECK_EVERY_MS) {
    return { status: 'skipped', version: ytdlp.version, message: '최근에 확인했어요' };
  }
  let result;
  try {
    const sums = (await download(`${RELEASE}/SHA2-256SUMS`)).toString('utf8');
    const line = sums.split('\n').find((l) => l.trim().endsWith(` ${ASSET}`) || l.trim().endsWith(`*${ASSET}`));
    const want = line?.trim().split(/\s+/)[0]?.toLowerCase();
    if (!want || want.length !== 64) throw new Error('체크섬 정보를 찾지 못했어요');
    const have = sha256(readFileSync(ytdlp.cmd));
    if (have === want) {
      result = { status: 'latest', version: ytdlp.version };
    } else {
      const bin = await download(`${RELEASE}/${ASSET}`);
      if (sha256(bin) !== want) throw new Error('받은 파일의 체크섬이 맞지 않아 업데이트를 취소했어요');
      const tmp = `${ytdlp.cmd}.download`;
      writeFileSync(tmp, bin);
      if (!isWin) chmodSync(tmp, 0o755);
      const version = versionOf(tmp);
      if (!version) { rmSync(tmp, { force: true }); throw new Error('받은 yt-dlp가 실행되지 않아요'); }
      try {
        renameSync(tmp, ytdlp.cmd);
      } catch {
        // 윈도우에서 실행 중이면 교체가 안 됨 → 다음 실행 때 교체
        renameSync(tmp, `${ytdlp.cmd}.new`);
      }
      result = { status: 'updated', version, from: ytdlp.version };
      ytdlp.version = version;
    }
  } catch (e) {
    result = { status: 'error', version: ytdlp.version, message: String(e.message || e).slice(0, 200) };
  }
  writeState({ ...st, lastCheck: result.status === 'error' ? st.lastCheck : Date.now(), lastResult: result });
  return result;
}
