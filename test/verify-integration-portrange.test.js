// 포트 범위 분리 잠금 (phase 64 step2 A-7 — 테스트 게이트 보강). scripts/verify-integration.mjs의
// 서버/CDP 포트 선택이 서로소(disjoint) 범위를 쓰는 불변식을 텍스트 스캔으로 잠근다.
// 배경: cdpPort는 서버 자식 spawn 직후(아직 bind 전일 수 있다) 뽑히므로, 두 범위가 겹치면
//   test-listen이 통과해도 같은 번호 경합이 성립한다(step2가 고친 결함 클래스). 이 파일이 없으면
//   범위를 다시 겹치게 되돌려도 어떤 테스트도 red가 되지 않는다(실행 로그 notes로만 관측 가능).
// 전례: boot-db-open·sea-import-meta-lock의 텍스트 잠금과 동형. 정확한 숫자를 고정하지 않고
//   불변식(서로소 + Windows 동적 포트 기본 범위 49152 미만 + 양수 span)만 잠근다 — 값 조정은
//   불변식을 지키는 한 이 테스트를 건드리지 않고 가능하다(과잠금 방지).
// 파일시스템 읽기 전용 — DB·네트워크·프로세스 부수효과 없음.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-integration.mjs');

// 숫자 리터럴 base/span을 쓰는 pickFreePort 호출만 추출한다(함수 정의 줄은 매칭되지 않는다).
function numericCallSites(text) {
  return [...text.matchAll(/pickFreePort\(\s*[^,)]+,\s*(\d+)\s*,\s*(\d+)\s*\)/g)]
    .map((m) => ({ base: Number(m[1]), span: Number(m[2]), text: m[0] }));
}

describe('verify-integration — 서버/CDP 포트 범위 분리(텍스트 잠금)', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const calls = numericCallSites(text);

  test('숫자 범위 pickFreePort 호출은 정확히 2건이다(서버 1 + CDP 1)', () => {
    assert.equal(calls.length, 2, `발견: ${JSON.stringify(calls.map((c) => c.text))}`);
  });

  test('두 범위 [base, base+span)는 서로소다(겹치면 spawn 직후 경합 회귀)', () => {
    const [a, b] = calls;
    const disjoint = a.base + a.span <= b.base || b.base + b.span <= a.base;
    assert.ok(disjoint, `범위가 겹친다: [${a.base}, ${a.base + a.span}) vs [${b.base}, ${b.base + b.span})`);
  });

  test('두 범위 모두 양수 span이고 Windows 동적 포트 기본 범위(49152~) 아래다', () => {
    for (const c of calls) {
      assert.ok(c.span > 0, `span이 0 이하: ${c.text}`);
      assert.ok(c.base + c.span <= 49152, `동적 포트 범위 침범: ${c.text} → 상한 ${c.base + c.span}`);
      assert.ok(c.base >= 1024, `well-known 포트 침범: ${c.text}`);
    }
  });
});
