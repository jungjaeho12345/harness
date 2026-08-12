// 셸 로컬 창 전용 preload (phase 62 step1) — 샌드박스 preload는 ESM을 못 쓴다 → .cjs + require('electron')만.
// CRITICAL: 노출 함수는 이 5개뿐이다. ipcRenderer 원본·require·process·파일시스템을 절대 노출하지 않는다.
// 이 파일이 붙는 webContents는 로컬 창(file://) 하나뿐이며, 원격 URL을 절대 로드하지 않는다(최상위 불변식).
// 메인 쪽 핸들러가 sender(file:// + 로컬 창 contents id)를 재검증하므로, 여기가 뚫려도 원격 페이지는
// IPC를 잡을 수 없다(이중 방어).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellBridge', {
  probeServer: (input) => ipcRenderer.invoke('probeServer', String(input ?? '')),
  saveServer: (input) => ipcRenderer.invoke('saveServer', String(input ?? '')),
  getState: () => ipcRenderer.invoke('getState'),
  retry: () => { ipcRenderer.invoke('retry'); },
  quit: () => { ipcRenderer.invoke('quit'); },
});
