// FTP 스풀 watcher 테스트 — 주입한 가짜 watch/readFile로 파일 이벤트→onFile 흐름만 검증한다.
// 실제 FS·FTP는 쓰지 않는다(결정성). sourceId는 <dir>/<sourceId>/<file>의 상위 서브디렉토리에서 도출한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFtpWatcher } from '../server/ftpWatcher.js';

// 가짜 watch — 콜백을 캡처해 테스트가 직접 파일 이벤트를 발사할 수 있게 한다.
function fakeWatch() {
  let cb;
  const closed = { value: false };
  const watch = (_dir, _opts, handler) => { cb = handler; return { close: () => { closed.value = true; } }; };
  return { watch, emit: (filename) => cb('rename', filename), closed };
}

test('새 파일 이벤트 시 서브디렉토리명을 sourceId로 도출해 onFile에 넘긴다', async () => {
  const { watch, emit } = fakeWatch();
  const reads = [];
  const readFile = async (path) => { reads.push(path); return '자동제목\n본문'; };
  const calls = [];
  const w = createFtpWatcher({
    dir: '/spool',
    onFile: (e) => { calls.push(e); },
    watch,
    readFile,
  });
  w.start();

  emit('src-1/article.txt');
  await new Promise((r) => setImmediate(r)); // handle()의 비동기 readFile 완료 대기.

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceId, 'src-1');
  assert.equal(calls[0].payload, '자동제목\n본문');
  assert.match(reads[0], /article\.txt$/);
});

test('서브디렉토리 없는 최상위 항목은 무시한다(sourceId 도출 불가)', async () => {
  const { watch, emit } = fakeWatch();
  const calls = [];
  const w = createFtpWatcher({
    dir: '/spool',
    onFile: (e) => calls.push(e),
    watch,
    readFile: async () => 'x',
  });
  w.start();

  emit('toplevel.txt'); // 서브디렉토리 없음 → 무시
  emit(null); // filename 없음 → 무시
  await new Promise((r) => setImmediate(r));

  assert.equal(calls.length, 0);
});

test('stop()은 watcher를 닫는다', () => {
  const { watch, closed } = fakeWatch();
  const w = createFtpWatcher({ dir: '/spool', onFile: () => {}, watch, readFile: async () => '' });
  w.start();
  w.stop();
  assert.equal(closed.value, true);
});
