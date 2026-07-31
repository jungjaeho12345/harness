// 엠바고 배부 판정 규칙 테스트 — embargoPolicy는 순수 모듈이다(시계·DB·파일시스템 비의존).
// 여기서 잠그는 것은 news.md "엠바고 규칙"의 직역이다:
//   1차 엠바고 → 언론사(press), 2차 엠바고 → 비언론사(nonpress, 송고 시 press는 즉시),
//   1+2차 → 1차 시각에 press, 2차 시각에 nonpress.
// CRITICAL: now는 ISO-8601 UTC 문자열 계약이다(숫자 epoch ms 금지) — 숫자를 흘리면
// Date.parse(숫자)=NaN 이 되어 모든 기사가 조용히 "미도래"로 떨어지고 엠바고가 영원히 배부되지 않는다.
// 그 무음 실패를 조기에 잡는 가드 케이스를 아래에 둔다.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBARGO_DISTRIBUTABLE_STATUSES,
  requiredKinds,
  distributedKinds,
  unparsableEmbargoFields,
  dueKinds,
  embargoStatusFor,
} from '../src/services/embargoPolicy.js';

// 고정 시각(전부 명시적 UTC 'Z' — 로컬 타임존/플랫폼에 의존하지 않는다).
const T1 = '2026-07-30T09:00:00.000Z'; // 1차 엠바고
const T2 = '2026-07-30T12:00:00.000Z'; // 2차 엠바고
const BEFORE = '2026-07-30T08:59:59.999Z';
const BETWEEN = '2026-07-30T10:00:00.000Z';
const AFTER = '2026-07-30T13:00:00.000Z';

const FIRST_ONLY = { embargoAt: T1 };
const SECOND_ONLY = { secondEmbargoAt: T2 };
const BOTH = { embargoAt: T1, secondEmbargoAt: T2 };

// 배부 이력 1행(articleHistoryModel.queryByArticle 행 shape의 부분집합).
function distributeRow(action, id = 1) {
  return {
    id,
    articleId: 'AKR20260730123456789',
    eventType: 'distribute',
    action,
    fromStatus: null,
    toStatus: null,
    actorUserId: 'desk1',
    createdAt: T1,
    hasSnapshot: 0,
  };
}

// ─── EMBARGO_DISTRIBUTABLE_STATUSES ────────────────────────────────────────

test('EMBARGO_DISTRIBUTABLE_STATUSES: DES·EPS·DPS 세 상태만이며 동결돼 있다', () => {
  assert.deepEqual([...EMBARGO_DISTRIBUTABLE_STATUSES], ['DES', 'EPS', 'DPS']);
  assert.equal(Object.isFrozen(EMBARGO_DISTRIBUTABLE_STATUSES), true);
});

// ─── requiredKinds ─────────────────────────────────────────────────────────

test('requiredKinds: 1차만/2차만/1+2차/미설정 4행', () => {
  assert.deepEqual(requiredKinds(FIRST_ONLY), ['press'], '1차 엠바고 = 언론사');
  // 2차만인 기사의 "송고 즉시 press 배부"는 완결 요건이 아니다(A.3: EPS→DPS는 2차 배부 후).
  assert.deepEqual(requiredKinds(SECOND_ONLY), ['nonpress'], '2차 엠바고 = 비언론사');
  assert.deepEqual(requiredKinds(BOTH), ['press', 'nonpress']);
  assert.deepEqual(requiredKinds({}), [], '엠바고 미설정 = 이 모듈 관여 없음');
});

test('requiredKinds: 빈 문자열·null·undefined는 미설정으로 취급한다', () => {
  assert.deepEqual(requiredKinds({ embargoAt: '', secondEmbargoAt: '' }), []);
  assert.deepEqual(requiredKinds({ embargoAt: null, secondEmbargoAt: null }), []);
  assert.deepEqual(requiredKinds({ embargoAt: undefined, secondEmbargoAt: undefined }), []);
  assert.deepEqual(requiredKinds({ embargoAt: '', secondEmbargoAt: T2 }), ['nonpress']);
});

test('requiredKinds: contents가 없거나 객체가 아니어도 throw 없이 []를 돌려준다', () => {
  assert.deepEqual(requiredKinds(), []);
  assert.deepEqual(requiredKinds(null), []);
  assert.deepEqual(requiredKinds('AKR1'), []);
});

test('requiredKinds: 반환 순서는 키 입력 순서와 무관하게 항상 [press, nonpress]다', () => {
  // 단언 안정성 — 호출자가 정렬을 다시 하지 않아도 되도록 순서를 계약으로 고정한다.
  assert.deepEqual(requiredKinds({ secondEmbargoAt: T2, embargoAt: T1 }), ['press', 'nonpress']);
});

// ─── distributedKinds ──────────────────────────────────────────────────────

test('distributedKinds: eventType=distribute 행의 action만 수집한다', () => {
  const rows = [
    { id: 3, eventType: 'status', action: 'send', toStatus: 'EPS' },
    distributeRow('press', 2),
    { id: 1, eventType: 'edit', action: 'save' },
  ];
  assert.deepEqual(distributedKinds(rows), ['press']);
});

test('distributedKinds: 중복 행은 한 번만 센다(멱등 판정의 근거)', () => {
  const rows = [distributeRow('press', 5), distributeRow('press', 2), distributeRow('nonpress', 4)];
  assert.deepEqual(distributedKinds(rows), ['press', 'nonpress']);
});

test('distributedKinds: press/nonpress 외 action과 비정상 행은 버린다', () => {
  const rows = [
    distributeRow('portal', 9),
    distributeRow(null, 8),
    distributeRow('', 7),
    { id: 6, eventType: 'distribute' },
    null,
    'garbage',
  ];
  assert.deepEqual(distributedKinds(rows), []);
});

test('distributedKinds: 빈 배열·비배열 입력은 []를 돌려준다(throw 금지)', () => {
  assert.deepEqual(distributedKinds([]), []);
  assert.deepEqual(distributedKinds(), []);
  assert.deepEqual(distributedKinds(null), []);
  assert.deepEqual(distributedKinds({ 0: distributeRow('press') }), []);
});

test('distributedKinds: 이력이 최신순(id DESC)이어도 반환 순서는 [press, nonpress]로 고정된다', () => {
  const rows = [distributeRow('nonpress', 9), distributeRow('press', 4)];
  assert.deepEqual(distributedKinds(rows), ['press', 'nonpress']);
});

// ─── dueKinds: 도래 판정 ───────────────────────────────────────────────────

test('dueKinds: 1차만 — 도래 전에는 배부하지 않는다', () => {
  assert.deepEqual(dueKinds({ status: 'DES', contents: FIRST_ONLY, distributed: [], now: BEFORE }), []);
});

test('dueKinds: 1차만 — 도래 시각에 press를 배부한다(경계 포함, now === embargoAt)', () => {
  assert.deepEqual(dueKinds({ status: 'DES', contents: FIRST_ONLY, distributed: [], now: T1 }), ['press']);
  assert.deepEqual(dueKinds({ status: 'DES', contents: FIRST_ONLY, distributed: [], now: AFTER }), ['press']);
});

test('dueKinds: 이미 배부된 kind는 재배부하지 않는다(멱등 — tick 중복 호출 방어)', () => {
  assert.deepEqual(dueKinds({ status: 'EPS', contents: FIRST_ONLY, distributed: ['press'], now: AFTER }), []);
  assert.deepEqual(
    dueKinds({ status: 'EPS', contents: BOTH, distributed: ['press', 'nonpress'], now: AFTER }),
    [],
  );
});

test('dueKinds: 2차만 — 송고 즉시 press가 배부된 뒤 2차 시각에 nonpress만 배부한다', () => {
  // 2차만 기사에는 embargoAt이 없으므로 press는 애초에 tick 대상이 아니다(송고 훅이 이미 배부).
  assert.deepEqual(dueKinds({ status: 'EPS', contents: SECOND_ONLY, distributed: ['press'], now: BETWEEN }), []);
  assert.deepEqual(dueKinds({ status: 'EPS', contents: SECOND_ONLY, distributed: ['press'], now: T2 }), ['nonpress']);
});

test('dueKinds: 1+2차 — 1차 시각엔 press, 2차 시각엔 nonpress를 순서대로 배부한다', () => {
  assert.deepEqual(dueKinds({ status: 'DES', contents: BOTH, distributed: [], now: T1 }), ['press']);
  assert.deepEqual(dueKinds({ status: 'EPS', contents: BOTH, distributed: ['press'], now: BETWEEN }), []);
  assert.deepEqual(dueKinds({ status: 'EPS', contents: BOTH, distributed: ['press'], now: T2 }), ['nonpress']);
});

test('dueKinds: 1+2차 — tick이 늦어 둘 다 도래했으면 [press, nonpress]를 함께 돌려준다', () => {
  assert.deepEqual(dueKinds({ status: 'DES', contents: BOTH, distributed: [], now: AFTER }), ['press', 'nonpress']);
});

test('dueKinds: 배부 가능 상태(DES·EPS·DPS)에서는 도래한 kind를 돌려준다', () => {
  for (const status of EMBARGO_DISTRIBUTABLE_STATUSES) {
    assert.deepEqual(
      dueKinds({ status, contents: FIRST_ONLY, distributed: [], now: AFTER }),
      ['press'],
      `배부 가능해야 함: ${status}`,
    );
  }
});

test('dueKinds: 미송고·보류·킬·삭제 상태(8종)는 도래해도 절대 배부하지 않는다', () => {
  // 회수 수단이 없는 외부 수신처로 나가면 되돌릴 수 없다 — 상태 게이트가 유일한 방어선이다.
  for (const status of ['RDS', 'RRH', 'RRK', 'DDH', 'DDK', 'EEK', 'EEH', 'DPD']) {
    assert.deepEqual(
      dueKinds({ status, contents: BOTH, distributed: [], now: AFTER }),
      [],
      `배부 금지여야 함: ${status}`,
    );
  }
  // 알 수 없는/누락 상태도 기본 거부다.
  assert.deepEqual(dueKinds({ status: undefined, contents: BOTH, distributed: [], now: AFTER }), []);
  assert.deepEqual(dueKinds({ status: 'des', contents: BOTH, distributed: [], now: AFTER }), []);
  assert.deepEqual(dueKinds({}), []);
});

test('dueKinds: 엠바고가 없는 기사는 []다(일반 DPS는 송고 훅이 이미 전체 배부)', () => {
  assert.deepEqual(dueKinds({ status: 'DPS', contents: {}, distributed: [], now: AFTER }), []);
});

test('dueKinds: 파싱 불가한 엠바고 값은 "미도래"로 취급해 배부하지 않는다', () => {
  // 엠바고 시각 입력란은 자유 텍스트다 — 파싱 실패를 "즉시 배부"로 해석하면 오타 하나가 유출이 된다.
  const bad = { embargoAt: '내일 오전', secondEmbargoAt: T2 };
  assert.deepEqual(dueKinds({ status: 'DES', contents: bad, distributed: [], now: AFTER }), ['nonpress']);
  assert.deepEqual(unparsableEmbargoFields(bad), ['embargoAt'], '무음 삼킴 금지 — 호출자가 표면화할 수 있어야 한다');
});

test('unparsableEmbargoFields: 정상 값·미설정은 빈 배열, 두 필드 모두 깨졌으면 두 필드를 돌려준다', () => {
  assert.deepEqual(unparsableEmbargoFields(BOTH), []);
  assert.deepEqual(unparsableEmbargoFields({}), []);
  assert.deepEqual(unparsableEmbargoFields({ embargoAt: '', secondEmbargoAt: null }), []);
  assert.deepEqual(
    unparsableEmbargoFields({ embargoAt: '2026-13-99', secondEmbargoAt: 'ㅁㄴㅇㄹ' }),
    ['embargoAt', 'secondEmbargoAt'],
  );
  assert.deepEqual(unparsableEmbargoFields(null), [], 'contents가 없어도 throw 금지');
});

test('dueKinds: now는 ISO-8601 UTC 문자열이어야 한다 — 숫자·undefined·쓰레기 값이면 []', () => {
  // 크로스-step 계약(step3 now=() => new Date().toISOString(), step4 가짜 시계) 위반 가드다.
  // 숫자 epoch ms를 허용하면 Date.parse(1700000000000)=NaN → 전부 미도래 → 엠바고가 영원히
  // 배부되지 않는 무음 실패가 된다. 여기서 즉시 실패하게 만들어 원인이 보이게 한다.
  const args = { status: 'DES', contents: BOTH, distributed: [] };
  for (const now of [Date.parse(AFTER), 1700000000000, undefined, null, '', '내일', {}, new Date(AFTER)]) {
    assert.deepEqual(dueKinds({ ...args, now }), [], `배부 금지여야 함(now=${String(now)})`);
  }
  // 인자 객체 자체가 없어도 안전해야 한다.
  assert.deepEqual(dueKinds(), []);
});

// ─── embargoStatusFor: 상태 판정 ───────────────────────────────────────────

test('embargoStatusFor: 1차만 — 배부 전엔 DES 유지(null), 1차 배부로 곧장 DPS', () => {
  assert.equal(embargoStatusFor({ status: 'DES', contents: FIRST_ONLY, distributed: [] }), null);
  // 같은 배부가 "첫 배부"이자 "완결"이므로 완결이 이긴다 — 중간에 EPS를 억지로 거치지 않는다.
  assert.equal(embargoStatusFor({ status: 'DES', contents: FIRST_ONLY, distributed: ['press'] }), 'DPS');
});

test('embargoStatusFor: 2차만 — 송고 즉시 press 배부는 EPS, 2차 배부 후 DPS', () => {
  assert.equal(embargoStatusFor({ status: 'DES', contents: SECOND_ONLY, distributed: ['press'] }), 'EPS');
  assert.equal(
    embargoStatusFor({ status: 'DES', contents: SECOND_ONLY, distributed: ['press', 'nonpress'] }),
    'DPS',
  );
  assert.equal(embargoStatusFor({ status: 'EPS', contents: SECOND_ONLY, distributed: ['nonpress'] }), 'DPS');
});

test('embargoStatusFor: 1+2차 — 1차 배부는 EPS(미완결), 2차 배부로 DPS', () => {
  assert.equal(embargoStatusFor({ status: 'DES', contents: BOTH, distributed: ['press'] }), 'EPS');
  assert.equal(embargoStatusFor({ status: 'DES', contents: BOTH, distributed: ['press', 'nonpress'] }), 'DPS');
  assert.equal(embargoStatusFor({ status: 'EPS', contents: BOTH, distributed: ['press', 'nonpress'] }), 'DPS');
});

test('embargoStatusFor: 계산 결과가 현재 status와 같으면 null이다(무의미한 쓰기 금지)', () => {
  assert.equal(embargoStatusFor({ status: 'DES', contents: BOTH, distributed: [] }), null);
  assert.equal(embargoStatusFor({ status: 'EPS', contents: BOTH, distributed: ['press'] }), null);
});

test('embargoStatusFor: EPS에서 DES로 역행하지 않는다(이력 유실·부분 실패 방어)', () => {
  assert.equal(embargoStatusFor({ status: 'EPS', contents: BOTH, distributed: [] }), null);
  assert.equal(embargoStatusFor({ status: 'EPS', contents: FIRST_ONLY, distributed: [] }), null);
});

test('embargoStatusFor: DES/EPS가 아닌 상태는 절대 건드리지 않는다(부활·역행 금지)', () => {
  for (const status of ['DPS', 'EEK', 'EEH', 'DPD', 'RDS', 'RRH', 'RRK', 'DDH', 'DDK', undefined]) {
    assert.equal(
      embargoStatusFor({ status, contents: BOTH, distributed: ['press', 'nonpress'] }),
      null,
      `건드리면 안 됨: ${String(status)}`,
    );
  }
});

test('embargoStatusFor: 엠바고 미설정이면 DES/EPS라도 null이다(자동 승격 없음)', () => {
  // 엠바고를 모두 지운 DES/EPS 기사는 대기 상태로 남는다 — 운영 액션(KILL→EEK / 보류→EEH)으로 처리한다.
  // 배부되지 않은 기사를 "배부 완결(DPS)"로 만드는 승격 규칙은 발명하지 않는다.
  assert.equal(embargoStatusFor({ status: 'DES', contents: {}, distributed: ['press'] }), null);
  assert.equal(embargoStatusFor({ status: 'EPS', contents: {}, distributed: ['press', 'nonpress'] }), null);
  assert.equal(embargoStatusFor({ status: 'EPS', contents: null, distributed: [] }), null);
  assert.equal(embargoStatusFor(), null, '인자 없이 호출해도 throw 금지');
});

test('embargoStatusFor: 알 수 없는 배부 kind는 배부 실적으로 세지 않는다', () => {
  assert.equal(embargoStatusFor({ status: 'DES', contents: BOTH, distributed: ['portal'] }), null);
  assert.equal(embargoStatusFor({ status: 'DES', contents: BOTH, distributed: 'press' }), null);
});

// ─── 순수성 ────────────────────────────────────────────────────────────────

test('embargoPolicy: 인자로 받은 객체·배열을 변형하지 않는다(순수 함수)', () => {
  const contents = { embargoAt: T1, secondEmbargoAt: T2 };
  const distributed = ['press'];
  const rows = [distributeRow('press', 2), { id: 1, eventType: 'status', action: 'send' }];
  const contentsBefore = structuredClone(contents);
  const distributedBefore = structuredClone(distributed);
  const rowsBefore = structuredClone(rows);

  requiredKinds(contents);
  unparsableEmbargoFields(contents);
  distributedKinds(rows);
  dueKinds({ status: 'EPS', contents, distributed, now: AFTER });
  embargoStatusFor({ status: 'EPS', contents, distributed });

  assert.deepEqual(contents, contentsBefore);
  assert.deepEqual(distributed, distributedBefore);
  assert.deepEqual(rows, rowsBefore);
});
