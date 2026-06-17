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

test('articleHistoryModel: 행 삭제 함수를 노출하지 않는다 (DB 비파괴)', () => {
  const { history } = setup();
  assert.equal(history.delete, undefined);
  assert.equal(history.remove, undefined);
});
