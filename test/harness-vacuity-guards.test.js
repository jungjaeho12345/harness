// P3 대조 하네스의 **공허 통과 방지 장치**를 텍스트로 잠근다 (④ 테스트 게이트 · 2026-09-09).
//
// 잠그는 불변식 둘:
//  (1) 각 대조기는 "관측 수가 기대와 같은가"를 스스로 확인한다. 이 줄이 없으면 관측 0건 → diff 0건 →
//      **green** 이라는 경로가 열린다(`compareReports`·`compareSpools` 는 빈 입력 2벌을 「차이 없음」으로
//      돌려준다 — 그 판정은 옳고, 「몇 건을 봤는가」는 드라이버가 소유한다).
//  (2) `scripts/lib/**` 의 순수 판정부 자기검사는 **어떤 자동 게이트에도 걸려 있어야 한다** —
//      드라이버가 시작 시 스스로 돌리거나(`runSelfTest`), `test/**` 가 그 모듈을 직접 import 하거나.
//      둘 다 아니면 그 판정부는 고쳐도 아무 커맨드가 red 가 되지 않는다(실제로 `integrationMode.mjs` 가
//      그 상태였고, 그 전례는 `spring-contract.mjs` 497행 주석에 mysqlHarness 판으로 남아 있다).
//
// 왜 텍스트 잠금인가: `scripts/**` 는 eslint ignore 대상이고 드라이버는 import 시 main() 을 실행해
//   함수 단위로 부를 수 없다(`verify-integration-portrange.test.js`·`boot-db-open` 과 같은 사정).
// 파일시스템 읽기 전용 — DB·네트워크·프로세스 부수효과 없음.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(REPO_ROOT, 'scripts');
const LIB = path.join(SCRIPTS, 'lib');
const TESTS = path.join(REPO_ROOT, 'test');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

describe('대조 하네스 — 관측 수 확인(0건이 green 이 되는 길을 막는다)', () => {
  test('spa-parity 는 관측 수를 요청 표 크기와 대조한다', () => {
    const text = read(SCRIPTS, 'spa-parity.mjs');
    assert.match(text, /result\.observationCount\s*!==\s*table\.length/,
      'spa-parity.mjs 에서 관측 수 대조가 사라졌다 — 관측 0건도 diffs 0 으로 통과한다');
  });

  test('spool-parity 는 대조한 파일 수를 시나리오 기대 총합과 대조한다', () => {
    const text = read(SCRIPTS, 'spool-parity.mjs');
    assert.match(text, /result\.fileCount\s*!==\s*Object\.values\(expected\)\.reduce/,
      'spool-parity.mjs 에서 파일 수 대조가 사라졌다 — 파일 0건도 diffs 0 으로 통과한다');
    assert.match(text, /스풀 파일 수가 시나리오 기대와 다르다/,
      '서버별 폴더 파일 수 대조가 사라졌다 — 한쪽이 아무것도 쓰지 않아도 대칭이면 통과한다');
  });

  test('두 대조기 모두 자식이 죽어 있는데 green 을 내지 않는다(기동/health 실패를 failures 로 센다)', () => {
    for (const name of ['spa-parity.mjs', 'spool-parity.mjs']) {
      assert.match(read(SCRIPTS, name), /기동\/health 실패/, `${name}: 기동 실패 판정이 사라졌다`);
    }
  });
});

describe('순수 판정부 자기검사 — 고아가 된 자기검사가 없다', () => {
  // scripts/lib/<name>.self-test.mjs 또는 <name>.test.mjs 는 전부 「자기 모듈의 자동 게이트」다.
  const selfTests = fs.readdirSync(LIB)
    .filter((f) => f.endsWith('.self-test.mjs') || f.endsWith('.test.mjs'))
    .sort();

  const driverText = fs.readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => read(SCRIPTS, f))
    .join('\n');

  const testDirText = fs.readdirSync(TESTS)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => read(TESTS, f))
    .join('\n');

  test('scripts/lib 에 자기검사 파일이 있다(발견 자체가 0이면 이 스위트가 공허하다)', () => {
    assert.ok(selfTests.length >= 7, `자기검사 파일이 너무 적다: ${JSON.stringify(selfTests)}`);
  });

  test('모든 자기검사는 드라이버가 시작 시 돌리거나 test/** 가 그 모듈을 import 한다', () => {
    const orphans = [];
    for (const file of selfTests) {
      const moduleName = file.replace(/\.(self-test|test)\.mjs$/, '.mjs');
      const runByDriver = driverText.includes(file);
      // 주석에 이름만 적혀 있는 것은 게이트가 아니다 — test/** 의 **실제 import 문**이어야 한다.
      const importedByNpmTest = new RegExp(
        `from\\s+['"][^'"]*scripts/lib/${moduleName.replace('.', '\\.')}['"]`,
      ).test(testDirText);
      if (!runByDriver && !importedByNpmTest) orphans.push(file);
    }
    assert.deepEqual(orphans, [],
      '어떤 자동 게이트에도 걸려 있지 않은 판정부 자기검사다 — 그 모듈은 고쳐도 red 가 되지 않는다');
  });

  test('자기검사를 돌리는 드라이버는 빨간 채로 서버를 띄우지 않는다(실패면 즉시 중단)', () => {
    for (const name of ['spa-parity.mjs', 'spool-parity.mjs', 'tick-cutover-probe.mjs',
      'pool-ceiling-probe.mjs', 'load-rehearsal.mjs', 'db-scale-probe.mjs']) {
      const text = read(SCRIPTS, name);
      // 정의가 아니라 **호출**이 있어야 한다(줄 첫 토큰이 runSelfTest( 인 문장) — 정의만 남기고 호출을
      // 지우는 것이 이 방어선을 없애는 가장 싼 길이다.
      assert.match(text, /^[ \t]*runSelfTest\(/m, `${name}: 자기검사 호출문이 없다(정의만 있는 것은 게이트가 아니다)`);
      assert.match(text, /자기\s*검사가 실패했다|판정부 자기 ?검사가 실패했다/,
        `${name}: 자기검사 실패 시 중단하는 문구가 없다 — 빨간 판정부로 대조를 돌리면 그 대조는 증거가 아니다`);
    }
  });
});
