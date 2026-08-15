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

// phase 65 step3 (B-2): --cdp-port 명시 값의 서버 범위 겹침 가드 + 드리프트 잠금.
// 가드의 숫자 리터럴이 서버 포트 선택 호출부의 [base, base+span)와 어긋나면 여기서 red가 된다
// (범위를 상수로 승격하지 않는 대신 이 테스트가 두 숫자의 일치를 잠근다 — decisions (13)).
describe('verify-integration — --cdp-port 서버 범위 겹침 가드(드리프트 잠금)', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const GUARD_RE = /opts\.cdpPort\s*>=\s*(\d+)\s*&&\s*opts\.cdpPort\s*<\s*(\d+)/g;
  const guards = [...text.matchAll(GUARD_RE)].map((m) => ({ lo: Number(m[1]), hi: Number(m[2]), text: m[0] }));

  // 첫 인자까지 파싱해 서버 호출(첫 인자 host)과 CDP 호출을 가른다.
  const sites = [...text.matchAll(/pickFreePort\(\s*([^,)]+),\s*(\d+)\s*,\s*(\d+)\s*\)/g)]
    .map((m) => ({ first: m[1].trim(), base: Number(m[2]), span: Number(m[3]), text: m[0] }));
  const server = sites.filter((s) => s.first === 'host');
  const cdp = sites.filter((s) => s.first !== 'host');

  test('겹침 가드가 정확히 1건 존재한다(기대 형태: opts.cdpPort >= <lo> && opts.cdpPort < <hi>)', () => {
    assert.equal(
      guards.length, 1,
      `가드 매치가 정확히 1건이어야 한다 — 기대 형태 "opts.cdpPort >= 20000 && opts.cdpPort < 35000"`
      + `(표현식 모양을 바꾸면 이 정규식이 못 찾는다). 발견: ${JSON.stringify(guards.map((g) => g.text))}`,
    );
  });

  test('가드 [lo, hi)가 서버 범위 [base, base+span)와 정확히 일치한다', () => {
    assert.equal(server.length, 1, `첫 인자가 host인 서버 호출은 1건이어야 한다. 발견: ${JSON.stringify(server)}`);
    const [g] = guards;
    const [s] = server;
    assert.ok(g, '가드가 없다 — 앞 케이스 참조');
    assert.equal(g.lo, s.base, `가드 하한(${g.lo})이 서버 base(${s.base})와 다르다 — 드리프트`);
    assert.equal(g.hi, s.base + s.span, `가드 상한(${g.hi})이 서버 base+span(${s.base + s.span})과 다르다 — 드리프트`);
  });

  test('가드 범위와 CDP 범위는 서로소다(겹치면 가드가 정당한 CDP 값을 거부한다)', () => {
    assert.equal(cdp.length, 1, `CDP 호출은 1건이어야 한다. 발견: ${JSON.stringify(cdp)}`);
    const [g] = guards;
    const [c] = cdp;
    assert.ok(g, '가드가 없다 — 앞 케이스 참조');
    const disjoint = g.hi <= c.base || c.base + c.span <= g.lo;
    assert.ok(disjoint, `가드 [${g.lo}, ${g.hi})와 CDP [${c.base}, ${c.base + c.span})가 겹친다`);
  });
});
