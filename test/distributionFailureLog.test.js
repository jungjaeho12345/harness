// 배부 실패 원장 파생(distributionFailureLog) — 순수 모듈 테스트.
// 입력은 articleHistoryModel.queryDistributionEvents() 반환 shape:
//   { id, articleId, eventType, action, targetId, reason, actorUserId, createdAt }
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISTRIBUTE_FAILED_EVENT,
  DISTRIBUTE_RETRY_EVENT,
  RETRYABLE_FAILURE_REASONS,
  isRetryableFailureReason,
  unresolvedFailures,
  findUnresolvedFailure,
} from '../src/services/distributionFailureLog.js';

function failedRow(id, { articleId = 'AKR1', targetId = 1, kind = 'press', reason = 'spool-write-failed', createdAt = `2026-08-06T00:00:0${id}.000Z` } = {}) {
  return { id, articleId, eventType: DISTRIBUTE_FAILED_EVENT, action: kind, targetId, reason, actorUserId: 'admin', createdAt };
}

function retryRow(id, { articleId = 'AKR1', targetId = 1, kind = 'press', createdAt = `2026-08-06T00:00:0${id}.000Z` } = {}) {
  return { id, articleId, eventType: DISTRIBUTE_RETRY_EVENT, action: kind, targetId, reason: null, actorUserId: 'admin', createdAt };
}

// 케이스 1
test('distributionFailureLog: 이벤트 상수와 RETRYABLE_FAILURE_REASONS (frozen, status-changed 미포함)', () => {
  assert.equal(DISTRIBUTE_FAILED_EVENT, 'distribute-failed');
  assert.equal(DISTRIBUTE_RETRY_EVENT, 'distribute-retry');
  assert.ok(Array.isArray(RETRYABLE_FAILURE_REASONS), '배열이어야 함');
  assert.ok(Object.isFrozen(RETRYABLE_FAILURE_REASONS), 'frozen이어야 함');
  assert.ok(!RETRYABLE_FAILURE_REASONS.includes('status-changed'),
    'status-changed는 안전 중단이지 재전송 가능 실패가 아니다 — 영속하면 영원히 미해소로 남는다');
});

// 케이스 2
test('distributionFailureLog: isRetryableFailureReason — allowlist만 true', () => {
  for (const r of RETRYABLE_FAILURE_REASONS) {
    assert.equal(isRetryableFailureReason(r), true, `${r}는 재전송 가능`);
  }
  assert.ok(RETRYABLE_FAILURE_REASONS.includes('spool-write-failed'));
  assert.ok(RETRYABLE_FAILURE_REASONS.includes('invalid-spool-dir'));
  assert.ok(RETRYABLE_FAILURE_REASONS.includes('invalid-article-id'));
  assert.equal(isRetryableFailureReason('status-changed'), false);
  // spool-disabled(spoolWriter.js의 실제 토큰)는 배부 기능 자체가 꺼진 상태 — 수신처 단위 재전송 대상이 아니다.
  assert.equal(isRetryableFailureReason('spool-disabled'), false);
  assert.equal(isRetryableFailureReason(undefined), false);
  assert.equal(isRetryableFailureReason(null), false);
  assert.equal(isRetryableFailureReason(''), false);
  assert.equal(isRetryableFailureReason({}), false);
});

// 케이스 3
test('distributionFailureLog: unresolvedFailures — 빈/비배열 입력은 [] (throw 금지)', () => {
  assert.deepEqual(unresolvedFailures([]), []);
  assert.deepEqual(unresolvedFailures(null), []);
  assert.deepEqual(unresolvedFailures(undefined), []);
  assert.deepEqual(unresolvedFailures('rows'), []);
  assert.deepEqual(unresolvedFailures(42), []);
});

// 케이스 4
test('distributionFailureLog: 실패 1건 → 미해소 1건, shape는 6키 정확히(경로성 필드 금지)', () => {
  const items = unresolvedFailures([failedRow(1)]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    historyId: 1, articleId: 'AKR1', targetId: 1, kind: 'press',
    reason: 'spool-write-failed', failedAt: '2026-08-06T00:00:01.000Z',
  });
  assert.deepEqual(
    Object.keys(items[0]).sort(),
    ['articleId', 'failedAt', 'historyId', 'kind', 'reason', 'targetId'],
    'spoolDir 같은 경로성 필드가 없어야 한다',
  );
});

// 케이스 5
test('distributionFailureLog: 실패 후 재전송 성공이면 해소 (미해소 0건)', () => {
  assert.deepEqual(unresolvedFailures([failedRow(1), retryRow(2)]), []);
});

// 케이스 6
test('distributionFailureLog: 실패→재전송→실패(더 큰 id)면 다시 미해소, 최신 실패 값을 쓴다', () => {
  const items = unresolvedFailures([
    failedRow(1, { reason: 'spool-write-failed' }),
    retryRow(2),
    failedRow(3, { reason: 'invalid-spool-dir', createdAt: '2026-08-06T09:00:00.000Z' }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].historyId, 3);
  assert.equal(items[0].reason, 'invalid-spool-dir');
  assert.equal(items[0].failedAt, '2026-08-06T09:00:00.000Z');
});

// 케이스 7
test('distributionFailureLog: 같은 쌍 실패 3건은 1건으로 접히고 최신 실패 값을 쓴다', () => {
  const items = unresolvedFailures([
    failedRow(1), failedRow(2), failedRow(3, { reason: 'invalid-article-id' }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].historyId, 3);
  assert.equal(items[0].reason, 'invalid-article-id');
});

// 케이스 8
test('distributionFailureLog: targetId가 다르면 다른 그룹 (수신처별 독립)', () => {
  const items = unresolvedFailures([
    failedRow(1, { targetId: 1 }),
    failedRow(2, { targetId: 2 }),
    retryRow(3, { targetId: 1 }),
  ]);
  assert.equal(items.length, 1, 'targetId 1은 해소, 2만 미해소');
  assert.equal(items[0].targetId, 2);
});

// 케이스 9
test('distributionFailureLog: action(kind)이 다르면 다른 그룹 (press/nonpress 독립)', () => {
  const items = unresolvedFailures([
    failedRow(1, { kind: 'press' }),
    failedRow(2, { kind: 'nonpress' }),
    retryRow(3, { kind: 'press' }),
  ]);
  assert.equal(items.length, 1, 'press는 해소, nonpress만 미해소');
  assert.equal(items[0].kind, 'nonpress');
});

// 케이스 10
test('distributionFailureLog: articleId가 다르면 다른 그룹', () => {
  const items = unresolvedFailures([
    failedRow(1, { articleId: 'AKR1' }),
    failedRow(2, { articleId: 'AKR2' }),
    retryRow(3, { articleId: 'AKR1' }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].articleId, 'AKR2');
});

// 케이스 11
test('distributionFailureLog: 판정은 배열 순서가 아니라 id로 한다 (ASC/DESC/셔플 동일 결과)', () => {
  const rows = [failedRow(1), retryRow(2), failedRow(3), retryRow(4)];
  const expected = unresolvedFailures(rows); // 최신(id 4)이 retry → 해소 → []
  assert.deepEqual(expected, []);
  assert.deepEqual(unresolvedFailures([...rows].reverse()), expected);
  assert.deepEqual(unresolvedFailures([rows[2], rows[0], rows[3], rows[1]]), expected);

  // 최신이 실패인 배열도 순서 무관하게 같은 결과.
  const rows2 = [failedRow(1), retryRow(2), failedRow(3)];
  const expected2 = unresolvedFailures(rows2);
  assert.equal(expected2.length, 1);
  assert.equal(expected2[0].historyId, 3);
  assert.deepEqual(unresolvedFailures([...rows2].reverse()), expected2);
  assert.deepEqual(unresolvedFailures([rows2[1], rows2[2], rows2[0]]), expected2);
});

// 케이스 12
test('distributionFailureLog: 방어 — 비정상 행은 무시한다 (throw 금지)', () => {
  const items = unresolvedFailures([
    failedRow(1),
    { ...failedRow(99), id: 'x' },            // id 비정수
    { ...failedRow(98), id: 1.5 },            // id 비정수(실수)
    { ...failedRow(97), targetId: null },     // targetId null
    { ...failedRow(96), targetId: undefined },// targetId undefined
    { ...failedRow(95), action: 42 },         // action 비문자열
    null, undefined, 'row', 7,                // 비객체 원소
  ]);
  assert.equal(items.length, 1, '유효한 행 1건만 판정에 참여');
  assert.equal(items[0].historyId, 1);
});

// 케이스 13
test('distributionFailureLog: distribute/status/edit 행은 판정에 영향이 없다 (해소 휴리스틱 금지)', () => {
  const items = unresolvedFailures([
    failedRow(1),
    // 같은 쌍의 distribute 행이 실패보다 뒤(id가 커도) — 해소로 보지 않는다(기각한 대안 잠금).
    { id: 2, articleId: 'AKR1', eventType: 'distribute', action: 'press', targetId: 1, reason: null, actorUserId: 'admin', createdAt: '2026-08-06T00:00:02.000Z' },
    { id: 3, articleId: 'AKR1', eventType: 'status', action: 'send', targetId: 1, reason: null, actorUserId: 'admin', createdAt: '2026-08-06T00:00:03.000Z' },
    { id: 4, articleId: 'AKR1', eventType: 'edit', action: 'press', targetId: 1, reason: null, actorUserId: 'admin', createdAt: '2026-08-06T00:00:04.000Z' },
  ]);
  assert.equal(items.length, 1, 'distribute 행이 뒤에 있어도 미해소로 남는다');
  assert.equal(items[0].historyId, 1);
});

// 케이스 14
test('distributionFailureLog: 반환 정렬은 최신 실패 우선(historyId DESC)으로 결정적이다', () => {
  const rows = [
    failedRow(1, { targetId: 1 }),
    failedRow(2, { targetId: 2 }),
    failedRow(3, { targetId: 3 }),
  ];
  const items = unresolvedFailures([rows[1], rows[2], rows[0]]); // 셔플 입력
  assert.deepEqual(items.map((i) => i.historyId), [3, 2, 1]);
});

// 케이스 15
test('distributionFailureLog: 입력 배열·행 객체를 변형하지 않는다', () => {
  const rows = [failedRow(3), retryRow(2), failedRow(1, { targetId: 2 })];
  const before = structuredClone(rows);
  unresolvedFailures(rows);
  findUnresolvedFailure(rows, { articleId: 'AKR1', targetId: 2 });
  assert.deepEqual(rows, before, '호출 전후 입력이 같아야 한다');
});

// 케이스 16
test('distributionFailureLog: findUnresolvedFailure — 쌍의 미해소 항목, 없으면 null, 문자열 targetId 정규화', () => {
  const rows = [failedRow(1, { targetId: 12 })];
  const found = findUnresolvedFailure(rows, { articleId: 'AKR1', targetId: 12 });
  assert.ok(found);
  assert.equal(found.historyId, 1);
  assert.equal(found.targetId, 12);
  // HTTP 경계에서 문자열 '12'가 와도 숫자 12 행과 매칭된다.
  const foundStr = findUnresolvedFailure(rows, { articleId: 'AKR1', targetId: '12' });
  assert.ok(foundStr);
  assert.equal(foundStr.historyId, 1);
  // 없는 쌍은 null.
  assert.equal(findUnresolvedFailure(rows, { articleId: 'AKR1', targetId: 99 }), null);
  assert.equal(findUnresolvedFailure(rows, { articleId: 'AKR-NONE', targetId: 12 }), null);
  // 해소된 쌍도 null.
  assert.equal(findUnresolvedFailure([failedRow(1), retryRow(2)], { articleId: 'AKR1', targetId: 1 }), null);
  // 정규화 불가 targetId도 throw 없이 null.
  assert.equal(findUnresolvedFailure(rows, { articleId: 'AKR1', targetId: 'abc' }), null);
});

// 케이스 17
test('distributionFailureLog: findUnresolvedFailure — kind 2종 동시 미해소면 historyId 최대 항목 1건 (결정적)', () => {
  const rows = [
    failedRow(1, { kind: 'press', reason: 'spool-write-failed' }),
    failedRow(2, { kind: 'nonpress', reason: 'invalid-spool-dir' }),
  ];
  const found = findUnresolvedFailure(rows, { articleId: 'AKR1', targetId: 1 });
  assert.equal(found.historyId, 2, '가장 최근(historyId 최대) 항목을 준다');
  assert.equal(found.kind, 'nonpress');
  // 배열 순서를 셔플해도 같은 결과.
  const shuffled = findUnresolvedFailure([rows[1], rows[0]], { articleId: 'AKR1', targetId: 1 });
  assert.deepEqual(shuffled, found);
});

// 케이스 18
test('distributionFailureLog: findUnresolvedFailure — press가 해소되고 nonpress만 미해소면 nonpress를 준다', () => {
  const rows = [
    failedRow(1, { kind: 'press' }),
    failedRow(2, { kind: 'nonpress' }),
    retryRow(3, { kind: 'press' }), // press 해소 — historyId는 크지만 고르면 안 된다
  ];
  const found = findUnresolvedFailure(rows, { articleId: 'AKR1', targetId: 1 });
  assert.ok(found);
  assert.equal(found.kind, 'nonpress', '해소된 kind를 고르지 않는다');
  assert.equal(found.historyId, 2);
});
