// 수집(자동기사) FTP 스풀 디렉토리 watcher — event 방식 (RCV.md, ARCHITECTURE.md).
// 외부 FTP 서버를 코드로 띄우지 않는다. 외부 계정이 자기 폴더에 파일을 떨구면(스풀 레이아웃
// <dir>/<sourceId>/<file>) 그 파일 이벤트를 받아 onFile({ sourceId, payload })로 넘긴다.
// 등록 여부 판정은 collectionService가 하므로 watcher는 sourceId 도출·전달만 한다.
//
// watch/readFile는 주입 가능하다 — 테스트는 실제 FS/FTP 없이 가짜를 주입한다.

import { watch as fsWatch } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createFtpWatcher({
  dir,
  onFile,
  watch = fsWatch,
  readFile = fsReadFile,
}) {
  let watcher;

  // 새 파일 이벤트 처리 — 상위 서브디렉토리명을 sourceId로 도출해 파일을 읽어 넘긴다.
  async function handle(filename) {
    if (!filename) return;
    // 스풀 레이아웃: <dir>/<sourceId>/<file>. 구분자는 OS에 따라 / 또는 \.
    const parts = String(filename).split(/[/\\]/).filter(Boolean);
    if (parts.length < 2) return; // 서브디렉토리 없는 최상위 항목(디렉토리 생성 등)은 무시
    const sourceId = parts[0];
    const payload = await readFile(join(dir, filename), 'utf8');
    await onFile({ sourceId, payload });
  }

  function start() {
    watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
      // 읽기 실패(디렉토리/경합)는 한 파일만 건너뛴다 — watcher는 계속 살아 있다.
      handle(filename).catch(() => {});
    });
    return watcher;
  }

  function stop() {
    if (watcher) watcher.close();
    watcher = undefined;
  }

  return { start, stop };
}
