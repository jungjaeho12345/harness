import test from 'node:test';
import assert from 'node:assert/strict';
import { transition, initialStatus } from '../src/services/lifecycle.js';

// news.md 기사 생애주기 전이표 — 허용 칸. [status, role, action, expectedNext]
const ALLOWED = [
  // R(기자): RDS만 다룬다.
  ['RDS', 'R', 'send', 'RDS'],
  ['RDS', 'R', 'hold', 'RRH'],
  ['RDS', 'R', 'kill', 'RRK'],
  // D(데스크)
  ['RDS', 'D', 'send', 'DPS'],
  ['RDS', 'D', 'hold', 'DDH'],
  ['RDS', 'D', 'kill', 'DDK'],
  ['DPS', 'D', 'send', 'DPS'], // 재송고
  ['DPS', 'D', 'hold', 'DDH'],
  ['DPS', 'D', 'approveDelete', 'DPD'],
  ['DDH', 'D', 'send', 'DPS'],
  ['DDH', 'D', 'kill', 'DDK'],
  // Z(관리자) — D와 동일
  ['RDS', 'Z', 'send', 'DPS'],
  ['RDS', 'Z', 'hold', 'DDH'],
  ['RDS', 'Z', 'kill', 'DDK'],
  ['DPS', 'Z', 'send', 'DPS'],
  ['DPS', 'Z', 'hold', 'DDH'],
  ['DPS', 'Z', 'approveDelete', 'DPD'],
  ['DDH', 'Z', 'send', 'DPS'],
  ['DDH', 'Z', 'kill', 'DDK'],
];

for (const [status, role, action, next] of ALLOWED) {
  test(`transition 허용: ${status} + ${role} + ${action} → ${next}`, () => {
    assert.deepEqual(transition(status, role, action), { ok: true, status: next });
  });
}

// 거부 칸 — 정의되지 않은 (status, role, action) 조합.
const DENIED = [
  // R은 DPS/DDH 기사에 어떤 액션도 불가
  ['DPS', 'R', 'send'],
  ['DPS', 'R', 'hold'],
  ['DPS', 'R', 'kill'],
  ['DPS', 'R', 'approveDelete'],
  ['DDH', 'R', 'send'],
  ['DDH', 'R', 'hold'],
  ['DDH', 'R', 'kill'],
  // R은 approveDelete 자체가 불가
  ['RDS', 'R', 'approveDelete'],
  // DPS는 바로 KILL 불가 (D/Z)
  ['DPS', 'D', 'kill'],
  ['DPS', 'Z', 'kill'],
  // DDH는 이미 보류 — hold 불가 (D/Z)
  ['DDH', 'D', 'hold'],
  ['DDH', 'Z', 'hold'],
  // approveDelete는 DPS에서만 — RDS/DDH는 거부
  ['RDS', 'D', 'approveDelete'],
  ['DDH', 'D', 'approveDelete'],
  // 터미널 상태는 전이 없음
  ['RRH', 'D', 'send'],
  ['RRK', 'D', 'send'],
  ['DDK', 'D', 'send'],
  ['DPD', 'D', 'send'],
  ['RRH', 'R', 'send'],
];

for (const [status, role, action] of DENIED) {
  test(`transition 거부: ${status} + ${role} + ${action}`, () => {
    const r = transition(status, role, action);
    assert.equal(r.ok, false);
    assert.ok(r.reason, 'reason이 있어야 한다');
  });
}

test('transition 거부: 정의되지 않은 권한', () => {
  assert.equal(transition('RDS', 'X', 'send').ok, false);
  assert.equal(transition('RDS', undefined, 'send').ok, false);
});

test('transition 거부: 정의되지 않은 액션', () => {
  assert.equal(transition('RDS', 'D', 'publish').ok, false);
  assert.equal(transition('RDS', 'D', undefined).ok, false);
});

// initialStatus — 최초 작성(create) 초기 상태. 기본 RDS, 보류는 (Z|D)→DDH·R→RRH (news.md "기사 생애주기").
// transition('RDS',role,'hold')과 결과가 동일하다(단일 진실). 거부하지 않고 항상 유효한 상태 문자열을 반환한다.
const INITIAL_HOLD = [
  ['Z', 'DDH'],   // Z 보류 → DDH
  ['D', 'DDH'],   // D 보류 → DDH
  ['R', 'RRH'],   // R 보류 → RRH
];

for (const [role, next] of INITIAL_HOLD) {
  test(`initialStatus: ${role}가 보류로 최초 작성하면 ${next}`, () => {
    assert.equal(initialStatus(role, 'hold'), next);
  });
}

const INITIAL_RDS = [
  ['Z', 'send'],   // Z 송고 → RDS (신규 최초 송고는 권한 무관 RDS)
  ['D', 'send'],
  ['R', 'send'],
  ['Z', 'kill'],   // 정의 외 action도 RDS (거부하지 않음)
  ['Z', undefined],
  [undefined, 'hold'],   // 거부되는 role(미지정)+hold 폴백 → RDS (보존)
  [undefined, undefined],
];

for (const [role, action] of INITIAL_RDS) {
  test(`initialStatus: role=${role} action=${action} → RDS`, () => {
    assert.equal(initialStatus(role, action), 'RDS');
  });
}
