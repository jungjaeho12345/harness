import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  return { db, history: createArticleHistoryModel(db) };
}

test('articleHistoryModel: insert가 ArticleHistory에 1행을 적재한다', () => {
  const { db, history } = setup();
  history.insert({
    articleId: 'AKR1',
    eventType: 'status',
    action: 'send',
    fromStatus: 'RDS',
    toStatus: 'DPS',
    actorUserId: 'desk',
    createdAt: '2026-06-16T00:00:00.000Z',
  });
  const rows = db.prepare('SELECT * FROM ArticleHistory').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].articleId, 'AKR1');
  assert.equal(rows[0].eventType, 'status');
  assert.equal(rows[0].action, 'send');
  assert.equal(rows[0].fromStatus, 'RDS');
  assert.equal(rows[0].toStatus, 'DPS');
  assert.equal(rows[0].actorUserId, 'desk');
  assert.equal(rows[0].createdAt, '2026-06-16T00:00:00.000Z');
  assert.ok(rows[0].id, 'id 자동 증가');
});

test('articleHistoryModel: insert는 정의되지 않은 키를 컬럼에서 제외한다(edit는 action null)', () => {
  const { db, history } = setup();
  history.insert({
    articleId: 'AKR1',
    eventType: 'edit',
    actorUserId: 'kim',
    createdAt: '2026-06-16T00:00:00.000Z',
  });
  const row = db.prepare('SELECT * FROM ArticleHistory WHERE articleId = ?').get('AKR1');
  assert.equal(row.eventType, 'edit');
  assert.equal(row.action, null);
  assert.equal(row.fromStatus, null);
  assert.equal(row.toStatus, null);
  assert.equal(row.actorUserId, 'kim');
});

test('articleHistoryModel: queryByArticle가 해당 기사 이력을 최신순(id DESC)으로 반환한다', () => {
  const { history } = setup();
  history.insert({ articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim', createdAt: '2026-06-16T00:00:01.000Z' });
  history.insert({ articleId: 'AKR1', eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS', actorUserId: 'desk', createdAt: '2026-06-16T00:00:02.000Z' });
  history.insert({ articleId: 'AKR1', eventType: 'status', action: 'hold', fromStatus: 'DPS', toStatus: 'DRH', actorUserId: 'desk', createdAt: '2026-06-16T00:00:03.000Z' });

  const rows = history.queryByArticle('AKR1');
  assert.equal(rows.length, 3);
  // id DESC — 가장 최근(마지막 insert)이 먼저.
  assert.deepEqual(rows.map((r) => r.action), ['hold', 'send', null]);
});

test('articleHistoryModel: queryByArticle는 다른 기사의 이력을 섞지 않는다', () => {
  const { history } = setup();
  history.insert({ articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim', createdAt: '2026-06-16T00:00:01.000Z' });
  history.insert({ articleId: 'AKR2', eventType: 'edit', actorUserId: 'lee', createdAt: '2026-06-16T00:00:02.000Z' });

  const rows = history.queryByArticle('AKR1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].articleId, 'AKR1');
});

test('articleHistoryModel: queryByArticle는 markupVersion 대신 hasSnapshot 플래그만 반환한다 (목록 경량)', () => {
  const { history } = setup();
  history.insert({
    articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim',
    createdAt: '2026-06-16T00:00:01.000Z', markupVersion: '{"format":"yh-editor","blocks":[]}',
  });
  history.insert({
    articleId: 'AKR1', eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS',
    actorUserId: 'desk', createdAt: '2026-06-16T00:00:02.000Z',
  });

  const rows = history.queryByArticle('AKR1');
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.markupVersion, undefined, '본문 blob은 목록에 싣지 않는다');
  // id DESC — status(스냅샷 없음)가 먼저, edit(스냅샷 있음)이 뒤.
  assert.ok(!rows[0].hasSnapshot, 'status 행은 hasSnapshot falsy');
  assert.ok(rows[1].hasSnapshot, '스냅샷 있는 edit 행은 hasSnapshot truthy');
});

test('articleHistoryModel: querySnapshotById는 본문 포함 단건을 articleId 스코프로 반환한다', () => {
  const { history } = setup();
  history.insert({
    articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim',
    createdAt: '2026-06-16T00:00:01.000Z', markupVersion: 'SNAP-1',
  });
  const { id } = history.queryByArticle('AKR1')[0];

  const found = history.querySnapshotById('AKR1', id);
  assert.equal(found.markupVersion, 'SNAP-1', '단건 조회는 본문을 포함한다');
  assert.equal(found.articleId, 'AKR1');

  // 다른 기사의 articleId로는 같은 id라도 조회되지 않는다(스냅샷 유출 방지).
  assert.equal(history.querySnapshotById('AKR2', id), undefined);
  // 없는 id는 undefined.
  assert.equal(history.querySnapshotById('AKR1', 99999), undefined);
});

test('articleHistoryModel: 행 삭제 함수를 노출하지 않는다 (DB 비파괴)', () => {
  const { history } = setup();
  assert.equal(history.delete, undefined);
  assert.equal(history.remove, undefined);
});

// --- phase 56 step1: querySnapshotsByArticle — 이력 '제목' 파생(서비스)용 스냅샷 본문 별도 조회 ---
// queryByArticle의 경량 계약(blob 미포함)은 그대로 두고, 스냅샷 보유 행만 두 컬럼으로 읽는다.

test('articleHistoryModel: querySnapshotsByArticle는 스냅샷 보유 행만 {id, markupVersion}으로 반환한다', () => {
  const { history } = setup();
  history.insert({
    articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim',
    createdAt: '2026-06-16T00:00:01.000Z', markupVersion: 'SNAP-1',
  });
  history.insert({
    articleId: 'AKR1', eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS',
    actorUserId: 'desk', createdAt: '2026-06-16T00:00:02.000Z',
  });
  history.insert({
    articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim',
    createdAt: '2026-06-16T00:00:03.000Z', markupVersion: 'SNAP-2',
  });

  const rows = history.querySnapshotsByArticle('AKR1');
  assert.equal(rows.length, 2, '스냅샷 없는 status 행은 제외된다');
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['id', 'markupVersion'], '두 컬럼만 반환한다');
  }
  // id DESC — 최근 스냅샷이 먼저.
  assert.deepEqual(rows.map((r) => r.markupVersion), ['SNAP-2', 'SNAP-1'], '본문 문자열이 그대로다');
});

test('articleHistoryModel: querySnapshotsByArticle는 markupVersion이 빈 문자열인 행을 제외한다(hasSnapshot 동형)', () => {
  const { history } = setup();
  history.insert({
    articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim',
    createdAt: '2026-06-16T00:00:01.000Z', markupVersion: '',
  });
  history.insert({
    articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim',
    createdAt: '2026-06-16T00:00:02.000Z', markupVersion: 'SNAP-1',
  });

  const rows = history.querySnapshotsByArticle('AKR1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].markupVersion, 'SNAP-1');
});

test('articleHistoryModel: querySnapshotsByArticle는 다른 기사의 스냅샷을 섞지 않는다', () => {
  const { history } = setup();
  history.insert({
    articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim',
    createdAt: '2026-06-16T00:00:01.000Z', markupVersion: 'SNAP-AKR1',
  });
  history.insert({
    articleId: 'AKR2', eventType: 'edit', actorUserId: 'lee',
    createdAt: '2026-06-16T00:00:02.000Z', markupVersion: 'SNAP-AKR2',
  });

  const rows = history.querySnapshotsByArticle('AKR1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].markupVersion, 'SNAP-AKR1');
});

test('articleHistoryModel: querySnapshotsByArticle는 이력/스냅샷이 없으면 빈 배열이다', () => {
  const { history } = setup();
  // 이력 자체가 없는 기사.
  assert.deepEqual(history.querySnapshotsByArticle('AKR-NONE'), []);
  // 이력은 있으나 스냅샷이 하나도 없는 기사.
  history.insert({
    articleId: 'AKR1', eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS',
    actorUserId: 'desk', createdAt: '2026-06-16T00:00:01.000Z',
  });
  assert.deepEqual(history.querySnapshotsByArticle('AKR1'), []);
});

test('articleHistoryModel: querySnapshotsByArticle 반환 순서는 id DESC로 결정적이다', () => {
  const { history } = setup();
  for (let i = 1; i <= 3; i += 1) {
    history.insert({
      articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim',
      createdAt: '2026-06-16T00:00:01.000Z', markupVersion: `SNAP-${i}`, // 같은 createdAt — id로만 정렬
    });
  }
  const first = history.querySnapshotsByArticle('AKR1');
  assert.deepEqual(first.map((r) => r.markupVersion), ['SNAP-3', 'SNAP-2', 'SNAP-1']);
  assert.ok(first[0].id > first[1].id && first[1].id > first[2].id, 'id DESC');
  // 같은 입력에 항상 같은 순서.
  assert.deepEqual(history.querySnapshotsByArticle('AKR1'), first);
});

// --- phase 57 step0: 배부 실패 영속 컬럼(targetId·reason) + queryDistributionEvents ---
// 일반 이력 계약(queryByArticle)은 불변 — 배부 실패/재전송 이벤트는 별도 조회로만 읽는다.

test('articleHistoryModel: insert가 targetId·reason을 저장하고, 미전달 시 NULL이다 (present-only)', () => {
  const { db, history } = setup();
  history.insert({
    articleId: 'AKR1', eventType: 'distribute-failed', action: 'press',
    targetId: 12, reason: 'spool-write-failed',
    actorUserId: 'admin', createdAt: '2026-08-06T00:00:00.000Z',
  });
  history.insert({
    articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim', createdAt: '2026-08-06T00:00:01.000Z',
  });
  const rows = db.prepare('SELECT * FROM ArticleHistory ORDER BY id').all();
  assert.equal(rows[0].targetId, 12);
  assert.equal(rows[0].reason, 'spool-write-failed');
  assert.equal(rows[1].targetId, null, '미전달 시 targetId는 NULL');
  assert.equal(rows[1].reason, null, '미전달 시 reason은 NULL');
});

test('articleHistoryModel: queryDistributionEvents의 targetId는 숫자다 (INTEGER affinity — 타입 함정 잠금)', () => {
  const { history } = setup();
  history.insert({
    articleId: 'AKR1', eventType: 'distribute-failed', action: 'press',
    targetId: 12, reason: 'spool-write-failed',
    actorUserId: 'admin', createdAt: '2026-08-06T00:00:00.000Z',
  });
  const [row] = history.queryDistributionEvents();
  assert.strictEqual(row.targetId, 12, "숫자 12여야 한다 — '12'(문자열)면 대상 매칭이 조용히 깨진다");
});

test('articleHistoryModel: queryByArticle 반환 행에 targetId·reason 키가 없다 (일반 이력 계약 불변)', () => {
  const { history } = setup();
  history.insert({
    articleId: 'AKR1', eventType: 'distribute-failed', action: 'press',
    targetId: 12, reason: 'spool-write-failed',
    actorUserId: 'admin', createdAt: '2026-08-06T00:00:00.000Z',
  });
  const rows = history.queryByArticle('AKR1');
  assert.equal(rows.length, 1);
  const keys = Object.keys(rows[0]);
  assert.ok(!keys.includes('targetId'), '일반 이력 응답에 targetId를 싣지 않는다');
  assert.ok(!keys.includes('reason'), '일반 이력 응답에 reason을 싣지 않는다');
});

test('articleHistoryModel: queryDistributionEvents는 distribute-failed/distribute-retry 행만 반환한다', () => {
  const { history } = setup();
  const base = { articleId: 'AKR1', actorUserId: 'admin', createdAt: '2026-08-06T00:00:00.000Z' };
  history.insert({ ...base, eventType: 'distribute-failed', action: 'press', targetId: 1, reason: 'spool-write-failed' });
  history.insert({ ...base, eventType: 'distribute-retry', action: 'press', targetId: 1 });
  history.insert({ ...base, eventType: 'distribute', action: 'press' });
  history.insert({ ...base, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' });
  history.insert({ ...base, eventType: 'edit' });

  const rows = history.queryDistributionEvents();
  assert.equal(rows.length, 2, 'distribute/status/edit 행은 섞이지 않는다');
  assert.deepEqual(
    rows.map((r) => r.eventType).sort(),
    ['distribute-failed', 'distribute-retry'],
  );
});

test('articleHistoryModel: queryDistributionEvents 반환 shape (markupVersion 미노출)', () => {
  const { history } = setup();
  history.insert({
    articleId: 'AKR1', eventType: 'distribute-failed', action: 'press',
    targetId: 3, reason: 'spool-write-failed',
    actorUserId: 'admin', createdAt: '2026-08-06T00:00:00.000Z',
  });
  const [row] = history.queryDistributionEvents();
  assert.deepEqual(
    Object.keys(row).sort(),
    ['action', 'actorUserId', 'articleId', 'createdAt', 'eventType', 'id', 'reason', 'targetId'],
    '정확히 8개 키 — 본문 blob(markupVersion) 미노출',
  );
});

test('articleHistoryModel: queryDistributionEvents 정렬은 id DESC로 결정적이다', () => {
  const { history } = setup();
  for (let i = 1; i <= 3; i += 1) {
    history.insert({
      articleId: 'AKR1', eventType: 'distribute-failed', action: 'press',
      targetId: i, reason: 'spool-write-failed',
      actorUserId: 'admin', createdAt: '2026-08-06T00:00:00.000Z', // 같은 createdAt — id로만 정렬
    });
  }
  const rows = history.queryDistributionEvents();
  assert.deepEqual(rows.map((r) => r.targetId), [3, 2, 1], '최근 insert(id 최대)가 먼저');
  assert.ok(rows[0].id > rows[1].id && rows[1].id > rows[2].id, 'id DESC');
});

test('articleHistoryModel: queryDistributionEvents({ articleId })는 그 기사 행만 준다', () => {
  const { history } = setup();
  history.insert({
    articleId: 'AKR1', eventType: 'distribute-failed', action: 'press',
    targetId: 1, reason: 'spool-write-failed', actorUserId: 'admin', createdAt: '2026-08-06T00:00:00.000Z',
  });
  history.insert({
    articleId: 'AKR2', eventType: 'distribute-failed', action: 'nonpress',
    targetId: 2, reason: 'spool-write-failed', actorUserId: 'admin', createdAt: '2026-08-06T00:00:01.000Z',
  });
  const rows = history.queryDistributionEvents({ articleId: 'AKR1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].articleId, 'AKR1', '다른 기사 미혼입');
});

test('articleHistoryModel: queryDistributionEvents({ limit })는 최신 N건만, 미지정이면 기본값', () => {
  const { history } = setup();
  for (let i = 1; i <= 3; i += 1) {
    history.insert({
      articleId: 'AKR1', eventType: 'distribute-failed', action: 'press',
      targetId: i, reason: 'spool-write-failed',
      actorUserId: 'admin', createdAt: '2026-08-06T00:00:00.000Z',
    });
  }
  const limited = history.queryDistributionEvents({ limit: 2 });
  assert.equal(limited.length, 2, 'limit 2 → 최신 2건');
  assert.deepEqual(limited.map((r) => r.targetId), [3, 2], '최신 우선');
  // 미지정 → 기본값 적용(3건 전부 반환 — 기본값은 100 이상).
  assert.equal(history.queryDistributionEvents().length, 3);
  // 비정수·1 미만 limit도 기본값으로 정규화되어 throw 없이 동작한다.
  assert.equal(history.queryDistributionEvents({ limit: 'abc' }).length, 3);
  assert.equal(history.queryDistributionEvents({ limit: 0 }).length, 3);
});

test('articleHistoryModel: queryDistributionEvents는 대상 이벤트가 없으면 빈 배열이다', () => {
  const { history } = setup();
  history.insert({
    articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim', createdAt: '2026-08-06T00:00:00.000Z',
  });
  assert.deepEqual(history.queryDistributionEvents(), []);
  assert.deepEqual(history.queryDistributionEvents({ articleId: 'AKR-NONE' }), []);
});

// --- 코드리뷰 반려(phase 57 fix): 재전송 식별자 historyId 계약의 기반 ---
// retry가 (articleId,targetId)가 아니라 historyId로 좁혀지려면(같은 쌍에 kind 2종 동시 미해소 복구),
// (1) insert가 새 행의 id를 돌려주고 (2) id 단건으로 배부 이벤트 행만 조회할 수 있어야 한다.

test('articleHistoryModel: insert가 새 행의 id(정수)를 반환한다', () => {
  const { history } = setup();
  const first = history.insert({
    articleId: 'AKR1', eventType: 'distribute-failed', action: 'press',
    targetId: 1, reason: 'spool-write-failed', actorUserId: 'sys', createdAt: '2026-08-06T00:00:00.000Z',
  });
  const second = history.insert({
    articleId: 'AKR1', eventType: 'distribute-retry', action: 'press',
    targetId: 1, actorUserId: 'z1', createdAt: '2026-08-06T00:01:00.000Z',
  });
  assert.ok(Number.isInteger(first) && first >= 1, 'insert 반환은 새 행의 정수 id다');
  assert.ok(Number.isInteger(second) && second > first, 'id는 단조 증가한다');
});

test('articleHistoryModel: getDistributionEventById는 배부 이벤트 행만 — 타 eventType·미존재 id는 undefined', () => {
  const { history } = setup();
  const failedId = history.insert({
    articleId: 'AKR1', eventType: 'distribute-failed', action: 'nonpress',
    targetId: 7, reason: 'spool-write-failed', actorUserId: 'sys', createdAt: '2026-08-06T00:00:00.000Z',
  });
  const retryId = history.insert({
    articleId: 'AKR1', eventType: 'distribute-retry', action: 'nonpress',
    targetId: 7, actorUserId: 'z1', createdAt: '2026-08-06T00:01:00.000Z',
  });
  const editId = history.insert({
    articleId: 'AKR1', eventType: 'edit', actorUserId: 'kim',
    createdAt: '2026-08-06T00:02:00.000Z', markupVersion: '{"blocks":[]}',
  });

  const row = history.getDistributionEventById(failedId);
  assert.equal(row.id, failedId);
  assert.equal(row.articleId, 'AKR1');
  assert.equal(row.eventType, 'distribute-failed');
  assert.equal(row.action, 'nonpress');
  assert.strictEqual(row.targetId, 7, 'targetId는 숫자다');
  assert.equal(row.reason, 'spool-write-failed');
  // shape은 queryDistributionEvents와 동형 — markupVersion(본문 blob) 미노출.
  assert.deepEqual(
    Object.keys(row).sort(),
    ['action', 'articleId', 'createdAt', 'eventType', 'id', 'reason', 'targetId', 'actorUserId'].sort(),
  );

  assert.ok(history.getDistributionEventById(retryId), 'distribute-retry 행도 조회된다');
  assert.equal(history.getDistributionEventById(editId), undefined, '배부 이벤트가 아닌 행은 이 경로로 새지 않는다');
  assert.equal(history.getDistributionEventById(999999), undefined, '미존재 id');
});
