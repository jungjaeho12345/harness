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
