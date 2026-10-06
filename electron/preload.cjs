// 편집기 화면에 앱 전용 기능을 안전하게 연결 (Node 기능은 직접 노출하지 않음)
const { contextBridge, ipcRenderer } = require('electron');

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');

contextBridge.exposeInMainWorld('editinNative', {
  isApp: true,
  version: arg('editin-version'),
  helperUrl: arg('editin-helper'),
  platform: process.platform,
  // 내보낸 영상 마무리 (ffmpeg: 소리 AAC 변환 + faststart). 영상은 다시 인코딩하지 않음
  finalizeVideo: (data) => ipcRenderer.invoke('media:finalize', data),
  ytdlp: {
    status: () => ipcRenderer.invoke('ytdlp:status'),
    update: () => ipcRenderer.invoke('ytdlp:update'),
    onStatus: (cb) => {
      const fn = (_e, s) => cb(s);
      ipcRenderer.on('ytdlp-status', fn);
      return () => ipcRenderer.removeListener('ytdlp-status', fn);
    },
  },
});
