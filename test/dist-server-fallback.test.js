// 시작 bat 부적합 경고 (phase 64 step1 A-4 + 게이트 확장) — dist-server.mjs의 순수 함수
// startupWarning({ mode, exeBasename })을 node:test로 잠근다.
// 배경: 동봉 기사작성기-server.bat은 "%~dp0기사작성기-server.exe"를 실행한다. 그 이름의 exe가
//   배포 폴더에 없는 두 경로 — (1) --fallback(node-bundled): node.exe+server-bundle.cjs 배포,
//   (2) SEA인데 한글 rename 실패로 ASCII 폴백(article-server.exe) — 에서 운영자가 bat을 눌러도
//   기동하지 않으므로 조립 요약 직전에 경고 1줄을 낸다(실패 승격 금지 — 둘 다 의도된 경로다).
// dist-server.mjs는 invokedAsCli 가드가 있어 import 부작용이 0이다(빌드가 돌지 않는다).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { startupWarning } from '../scripts/dist-server.mjs';

const BAT_TARGET = '기사작성기-server.exe';

describe('dist-server.startupWarning — 폴백(node-bundled) 경고', () => {
  test('node-bundled면 경고 문자열을 돌려준다(폴백 사실 + bat 기동 불가 + 대체 실행 안내)', () => {
    const w = startupWarning({ mode: 'node-bundled', exeBasename: 'node.exe' });
    assert.equal(typeof w, 'string');
    assert.ok(w.includes('node-bundled') || w.includes('폴백'), `폴백 사실 누락: ${w}`);
    assert.ok(w.includes('.bat') || w.includes('bat'), `bat 언급 누락: ${w}`);
    assert.ok(w.includes('node.exe') && w.includes('server-bundle.cjs'), `대체 실행 안내 누락: ${w}`);
  });
});

describe('dist-server.startupWarning — exe 이름 불일치 경고(게이트 확장)', () => {
  test('SEA인데 ASCII 폴백 이름이면 경고 문자열(두 이름을 모두 명시)', () => {
    const w = startupWarning({ mode: 'sea', exeBasename: 'article-server.exe' });
    assert.equal(typeof w, 'string');
    assert.ok(w.includes('article-server.exe'), `실제 이름 누락: ${w}`);
    assert.ok(w.includes(BAT_TARGET), `bat이 가리키는 이름 누락: ${w}`);
  });
});

describe('dist-server.startupWarning — 정상 경로는 null', () => {
  test('SEA + bat이 가리키는 이름 그대로면 null', () => {
    assert.equal(startupWarning({ mode: 'sea', exeBasename: BAT_TARGET }), null);
  });

  test('알 수 없는 mode + 일치하는 이름도 null(경고 남발 금지)', () => {
    assert.equal(startupWarning({ mode: 'whatever', exeBasename: BAT_TARGET }), null);
  });

  test('인자 누락(빈 객체·무인자)도 null — 경고는 근거가 있을 때만', () => {
    assert.equal(startupWarning({}), null);
    assert.equal(startupWarning(), null);
  });
});

describe('dist-server.startupWarning — 출력 형태', () => {
  test('경고는 항상 1줄이다(개행 없음 — stdout 1줄 계약)', () => {
    for (const args of [
      { mode: 'node-bundled', exeBasename: 'node.exe' },
      { mode: 'sea', exeBasename: 'article-server.exe' },
    ]) {
      const w = startupWarning(args);
      assert.ok(!w.includes('\n'), `개행 포함: ${JSON.stringify(w)}`);
    }
  });
});
