// 엠바고 시점 배부 규칙(순수 함수) 테스트 — news.md "엠바고 규칙" 256~263행 + ADR-008 (3)(5).
// 이 모듈은 I/O가 없다: 현재 시각은 인자로 받고, DB/FS/네트워크를 건드리지 않는다.
// CRITICAL: 판정 불가한 엠바고 값은 절대 "배부 시각 도래"로 수렴하면 안 된다(외부 반출은 회수 불가).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISTRIBUTION_KINDS,
  requiredKinds,
  dueKinds,
  distributedKinds,
  pendingKinds,
  isEmbargoComplete,
} from '../src/services/embargoSchedule.js';
import { embargoCompleteTransition, transition, initialStatus } from '../src/services/lifecycle.js';

const T1 = '2026-07-28T05:00:00.000Z'; // 1차 엠바고
const T2 = '2026-07-28T09:00:00.000Z'; // 2차 엠바고

// 배부 이력 1행(distributionService가 남기는 형태와 동일).
const distRow = (action) => ({ eventType: 'distribute', action });

test('DISTRIBUTION_KINDS: press·nonpress 두 축만 존재한다', () => {
  assert.deepEqual(DISTRIBUTION_KINDS, ['press', 'nonpress']);
});

// --- requiredKinds: 완결(EPS→DPS)에 필요한 배부 종류 ---

test('requiredKinds: 엠바고 없음 → 빈 배열(시점 배부 대상 아님)', () => {
  assert.deepEqual(requiredKinds({}), []);
  assert.deepEqual(requiredKinds({ embargoAt: '', secondEmbargoAt: null }), []);
});

test('requiredKinds: 1차만 → press만 (news.md "1차 엠바고 시간에는 언론사에 배부")', () => {
  assert.deepEqual(requiredKinds({ embargoAt: T1 }), ['press']);
});

test('requiredKinds: 2차만 → press(송고 시 배부분)+nonpress', () => {
  assert.deepEqual(requiredKinds({ secondEmbargoAt: T2 }), ['press', 'nonpress']);
});

test('requiredKinds: 1+2차 → press+nonpress', () => {
  assert.deepEqual(requiredKinds({ embargoAt: T1, secondEmbargoAt: T2 }), ['press', 'nonpress']);
});

// --- dueKinds: 지금 시각에 배부해야 할 종류 ---

test('dueKinds: 1차 시각 미도달이면 빈 배열', () => {
  assert.deepEqual(dueKinds({ embargoAt: T1 }, '2026-07-28T04:59:59.999Z'), []);
});

test('dueKinds: 1차 시각과 정확히 같으면 도래로 본다(>=)', () => {
  assert.deepEqual(dueKinds({ embargoAt: T1 }, T1), ['press']);
});

test('dueKinds: 1+2차 — 1차만 지났으면 press만, 2차도 지나면 둘 다', () => {
  assert.deepEqual(dueKinds({ embargoAt: T1, secondEmbargoAt: T2 }, '2026-07-28T06:00:00.000Z'), ['press']);
  assert.deepEqual(dueKinds({ embargoAt: T1, secondEmbargoAt: T2 }, '2026-07-28T10:00:00.000Z'), ['press', 'nonpress']);
});

test('dueKinds: 2차만 설정된 기사의 press는 절대 due가 아니다(송고 시 배부분 — 중복 반출 금지)', () => {
  assert.deepEqual(dueKinds({ secondEmbargoAt: T2 }, '2026-07-28T23:00:00.000Z'), ['nonpress']);
});

test('dueKinds: 파싱 불가/빈 값/비문자열 엠바고는 due가 되지 않는다', () => {
  const now = '2026-12-31T00:00:00.000Z';
  assert.deepEqual(dueKinds({ embargoAt: '' }, now), []);
  assert.deepEqual(dueKinds({ embargoAt: '   ' }, now), []);
  assert.deepEqual(dueKinds({ embargoAt: 'nope' }, now), []);
  assert.deepEqual(dueKinds({ embargoAt: null, secondEmbargoAt: undefined }, now), []);
  assert.deepEqual(dueKinds({ embargoAt: 20260728 }, now), []);
  assert.deepEqual(dueKinds({}, now), []);
});

test('dueKinds: now가 파싱 불가면 아무것도 due가 아니다', () => {
  assert.deepEqual(dueKinds({ embargoAt: T1, secondEmbargoAt: T2 }, 'not-a-date'), []);
  assert.deepEqual(dueKinds({ embargoAt: T1 }, undefined), []);
});

test('dueKinds: 인자를 변형하지 않는다', () => {
  const contents = { embargoAt: T1, secondEmbargoAt: T2 };
  const snapshot = JSON.stringify(contents);
  dueKinds(contents, '2026-07-28T10:00:00.000Z');
  assert.equal(JSON.stringify(contents), snapshot);
});

// --- distributedKinds: 이력에서 이미 배부된 종류 ---

test('distributedKinds: distribute 이력의 action만 모은다(중복은 접힌다)', () => {
  const rows = [distRow('press'), distRow('press'), distRow('nonpress')];
  assert.deepEqual(distributedKinds(rows), ['press', 'nonpress']);
});

test('distributedKinds: status/edit 이력은 섞이지 않는다', () => {
  const rows = [
    { eventType: 'status', action: 'send', toStatus: 'EPS' },
    { eventType: 'edit', action: undefined },
    { eventType: 'status', action: 'press' }, // eventType이 distribute가 아니면 무시
    distRow('press'),
  ];
  assert.deepEqual(distributedKinds(rows), ['press']);
});

test('distributedKinds: 미지 action은 무시한다(allowlist)', () => {
  const rows = [distRow('all'), distRow('press '), distRow(''), distRow(null), distRow('nonpress')];
  assert.deepEqual(distributedKinds(rows), ['nonpress']);
});

test('distributedKinds: 빈 입력·비배열은 빈 배열', () => {
  assert.deepEqual(distributedKinds([]), []);
  assert.deepEqual(distributedKinds(), []);
  assert.deepEqual(distributedKinds(null), []);
});

// --- pendingKinds: due − 이미 배부됨 (멱등성의 핵심) ---

test('pendingKinds: 이미 배부된 kind는 다시 배부하지 않는다', () => {
  const contents = { embargoAt: T1, secondEmbargoAt: T2 };
  const now = '2026-07-28T10:00:00.000Z';
  assert.deepEqual(pendingKinds(contents, [], now), ['press', 'nonpress']);
  assert.deepEqual(pendingKinds(contents, [distRow('press')], now), ['nonpress']);
  assert.deepEqual(pendingKinds(contents, [distRow('press'), distRow('nonpress')], now), []);
});

test('pendingKinds: 시각 미도래면 이력과 무관하게 빈 배열', () => {
  assert.deepEqual(pendingKinds({ embargoAt: T1 }, [], '2026-07-01T00:00:00.000Z'), []);
});

// --- isEmbargoComplete: EPS→DPS 완결 판정 ---

test('isEmbargoComplete: 1차만 — press 이력이 있으면 완결', () => {
  assert.equal(isEmbargoComplete({ embargoAt: T1 }, []), false);
  assert.equal(isEmbargoComplete({ embargoAt: T1 }, [distRow('press')]), true);
});

test('isEmbargoComplete: 2차만 — press(송고 시)+nonpress 둘 다 있어야 완결', () => {
  const c = { secondEmbargoAt: T2 };
  assert.equal(isEmbargoComplete(c, [distRow('nonpress')]), false);
  assert.equal(isEmbargoComplete(c, [distRow('press')]), false);
  assert.equal(isEmbargoComplete(c, [distRow('press'), distRow('nonpress')]), true);
});

test('isEmbargoComplete: 1+2차 — 하나라도 빠지면 미완결', () => {
  const c = { embargoAt: T1, secondEmbargoAt: T2 };
  assert.equal(isEmbargoComplete(c, [distRow('press')]), false);
  assert.equal(isEmbargoComplete(c, [distRow('press'), distRow('nonpress')]), true);
});

test('isEmbargoComplete: 엠바고 없는 기사는 완결 판정 대상이 아니다(false)', () => {
  assert.equal(isEmbargoComplete({}, [distRow('press'), distRow('nonpress')]), false);
});

test('isEmbargoComplete: 시각이 아직 안 됐어도 이력이 다 있으면 완결이다(근거는 이력)', () => {
  // 시각 비교가 아니라 ArticleHistory가 판정 근거라는 계약을 고정한다(ADR-008 (5)).
  assert.equal(isEmbargoComplete({ embargoAt: '2099-01-01T00:00:00.000Z' }, [distRow('press')]), true);
});

// --- lifecycle: 엠바고 완결에 의한 시스템 전이 ---

test('embargoCompleteTransition: EPS만 DPS로 전이한다', () => {
  assert.deepEqual(embargoCompleteTransition('EPS'), { ok: true, status: 'DPS' });
});

test('embargoCompleteTransition: 보류/킬/그 외 상태는 거부한다(EEH·EEK를 되살리지 않는다)', () => {
  for (const s of ['EEH', 'EEK', 'DPS', 'RDS', 'DDH', 'DDK', 'DPD', 'RRH', 'RRK', undefined, null, '']) {
    assert.deepEqual(embargoCompleteTransition(s), { ok: false, reason: 'forbidden-transition' }, `status=${s}`);
  }
});

test('lifecycle 기존 계약 불변: EPS에는 send 전이가 없고 initialStatus는 그대로다', () => {
  assert.deepEqual(transition('EPS', 'D', 'send'), { ok: false, reason: 'forbidden-transition' });
  assert.deepEqual(transition('RDS', 'D', 'send'), { ok: true, status: 'DPS' });
  assert.equal(initialStatus('D', 'hold'), 'DDH');
});
