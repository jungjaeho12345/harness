// CLI 인자 값 판정 (phase 64 step0) — scripts/lib/cliArgs.mjs 순수 모듈을 node:test로 잠근다.
// 배경: 6개 CLI 전부가 `opts.x = argv[++i]` 꼴로 값을 읽어, 값 플래그가 마지막 인자로 오면
//   undefined가 기본값으로 조용히 통과했다(무음 기본값 진행). scripts/**는 eslint ignore 대상이라
//   이 순수 모듈 + 테스트가 유일한 정적 안전망이다(exeMeta.mjs를 exe-branding.test.js가 잠그는 전례).
// 계약: flagValue(argv, index, flag) → { ok: true, value } | { ok: false, reason, message }.
//   reason 3분류 = 'missing'(다음 토큰 없음) · 'empty'(trim 결과 빈 문자열) · 'flag-like'('--' 접두).
//   '-' 한 글자 접두는 정당한 값이다(음수 등 — 범위 가드가 판정할 몫).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { flagValue } from '../scripts/lib/cliArgs.mjs';

describe('cliArgs.flagValue — 정상 값', () => {
  test('일반 값은 그대로 통과한다', () => {
    const r = flagValue(['--out', 'dist/server-exe'], 0, '--out');
    assert.deepEqual(r, { ok: true, value: 'dist/server-exe' });
  });

  test('플래그 뒤가 아닌 위치(index)의 다음 토큰을 읽는다', () => {
    const r = flagValue(['--skip-web', '--name', 'app.exe'], 1, '--name');
    assert.deepEqual(r, { ok: true, value: 'app.exe' });
  });

  test("'-1' 같은 한 글자 하이픈 값은 통과한다(음수 — 범위 가드의 몫)", () => {
    const r = flagValue(['--port', '-1'], 0, '--port');
    assert.deepEqual(r, { ok: true, value: '-1' });
  });

  test("'-' 단독 값도 통과한다(flag-like가 아니다)", () => {
    const r = flagValue(['--out', '-'], 0, '--out');
    assert.deepEqual(r, { ok: true, value: '-' });
  });
});

describe('cliArgs.flagValue — missing(플래그가 마지막 인자)', () => {
  test('다음 토큰이 없으면 ok:false reason:missing', () => {
    const r = flagValue(['--out'], 0, '--out');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing');
  });

  test('message에 플래그 이름이 들어간다', () => {
    const r = flagValue(['--server-exe'], 0, '--server-exe');
    assert.ok(r.message.includes('--server-exe'), `message=${r.message}`);
  });
});

describe('cliArgs.flagValue — empty(빈 문자열·공백만)', () => {
  test('빈 문자열이면 ok:false reason:empty', () => {
    const r = flagValue(['--name', ''], 0, '--name');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty');
  });

  test('공백만 있는 값도 empty다', () => {
    const r = flagValue(['--spa', '   '], 0, '--spa');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty');
  });

  test('message에 플래그 이름이 들어간다', () => {
    const r = flagValue(['--spa', ''], 0, '--spa');
    assert.ok(r.message.includes('--spa'), `message=${r.message}`);
  });
});

describe("cliArgs.flagValue — flag-like('--' 접두 값)", () => {
  test("값이 '--'로 시작하면 ok:false reason:flag-like(다음 플래그가 값으로 먹히는 사고 차단)", () => {
    const r = flagValue(['--out', '--skip-web'], 0, '--out');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'flag-like');
  });

  test("'--' 단독도 flag-like다", () => {
    const r = flagValue(['--scenario', '--'], 0, '--scenario');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'flag-like');
  });

  test('message에 플래그 이름과 문제 값이 들어간다', () => {
    const r = flagValue(['--scenario', '--show'], 0, '--scenario');
    assert.ok(r.message.includes('--scenario'), `message=${r.message}`);
    assert.ok(r.message.includes('--show'), `message=${r.message}`);
  });
});

describe('cliArgs.flagValue — 순수성', () => {
  test('입력 배열을 변형하지 않는다', () => {
    const argv = ['--out', 'dist/x', '--name', ''];
    const snapshot = [...argv];
    flagValue(argv, 0, '--out');
    flagValue(argv, 2, '--name');
    assert.deepEqual(argv, snapshot);
  });

  test('실패 반환에도 message는 항상 문자열 1줄이다(개행 없음)', () => {
    for (const [argv, flag] of [[['--out'], '--out'], [['--out', ' '], '--out'], [['--out', '--x'], '--out']]) {
      const r = flagValue(argv, 0, flag);
      assert.equal(r.ok, false);
      assert.equal(typeof r.message, 'string');
      assert.ok(!r.message.includes('\n'), `message에 개행: ${JSON.stringify(r.message)}`);
    }
  });
});
