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

test('articleHistoryModel: record로 넣은 행이 findByArticleId로 조회되고 컬럼 값이 보존된다', () => {
  const { history } = setup();
  history.record({
    articleId: 'AKR1',
    eventType: 'send',
    actorUserId: 'kim',
    actorRole: 'reporter',
    fromStatus: 'RDS',
    toStatus: 'SND',
    title: '제목',
    createdAt: '2026-06-14T00:00:00.000Z',
  });
  const rows = history.findByArticleId('AKR1');
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.articleId, 'AKR1');
  assert.equal(r.eventType, 'send');
  assert.equal(r.actorUserId, 'kim');
  assert.equal(r.actorRole, 'reporter');
  assert.equal(r.fromStatus, 'RDS');
  assert.equal(r.toStatus, 'SND');
  assert.equal(r.title, '제목');
  assert.equal(r.createdAt, '2026-06-14T00:00:00.000Z');
  assert.ok(Number.isInteger(r.id));
});

test('articleHistoryModel: 선택 컬럼을 빼도 INSERT되고 NULL로 조회된다', () => {
  const { history } = setup();
  history.record({
    articleId: 'AKR2',
    eventType: 'edit',
    createdAt: '2026-06-14T01:00:00.000Z',
  });
  const rows = history.findByArticleId('AKR2');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorUserId, null);
  assert.equal(rows[0].fromStatus, null);
  assert.equal(rows[0].title, null);
});

test('articleHistoryModel: findByArticleId는 createdAt 오름차순(과거→현재)으로 반환한다', () => {
  const { history } = setup();
  history.record({ articleId: 'AKR3', eventType: 'edit', createdAt: '2026-06-14T03:00:00.000Z' });
  history.record({ articleId: 'AKR3', eventType: 'send', createdAt: '2026-06-14T01:00:00.000Z' });
  history.record({ articleId: 'AKR3', eventType: 'hold', createdAt: '2026-06-14T02:00:00.000Z' });
  const rows = history.findByArticleId('AKR3');
  assert.deepEqual(
    rows.map((r) => r.createdAt),
    ['2026-06-14T01:00:00.000Z', '2026-06-14T02:00:00.000Z', '2026-06-14T03:00:00.000Z'],
  );
});

test('articleHistoryModel: findSendByArticleId는 eventType=send만 오름차순으로 반환한다', () => {
  const { history } = setup();
  history.record({ articleId: 'AKR4', eventType: 'edit', createdAt: '2026-06-14T01:00:00.000Z' });
  history.record({ articleId: 'AKR4', eventType: 'send', createdAt: '2026-06-14T02:00:00.000Z' });
  history.record({ articleId: 'AKR4', eventType: 'hold', createdAt: '2026-06-14T03:00:00.000Z' });
  history.record({ articleId: 'AKR4', eventType: 'send', createdAt: '2026-06-14T04:00:00.000Z' });
  const rows = history.findSendByArticleId('AKR4');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.eventType === 'send'));
  assert.deepEqual(
    rows.map((r) => r.createdAt),
    ['2026-06-14T02:00:00.000Z', '2026-06-14T04:00:00.000Z'],
  );
});

test('articleHistoryModel: 존재하지 않는 articleId면 빈 배열을 반환한다', () => {
  const { history } = setup();
  assert.deepEqual(history.findByArticleId('NOPE'), []);
  assert.deepEqual(history.findSendByArticleId('NOPE'), []);
});

test('articleHistoryModel: recordWithDb는 외부 트랜잭션 안에서 동작한다 (자체 BEGIN 없음)', () => {
  const { db, history } = setup();
  db.exec('BEGIN');
  history.recordWithDb(db, {
    articleId: 'AKR5',
    eventType: 'send',
    createdAt: '2026-06-14T00:00:00.000Z',
  });
  db.exec('COMMIT');
  assert.equal(history.findByArticleId('AKR5').length, 1);
});

test('articleHistoryModel: recordWithDb는 외부 롤백 시 행이 남지 않는다 (원자성 계약)', () => {
  const { db, history } = setup();
  db.exec('BEGIN');
  history.recordWithDb(db, {
    articleId: 'AKR6',
    eventType: 'send',
    createdAt: '2026-06-14T00:00:00.000Z',
  });
  db.exec('ROLLBACK');
  assert.deepEqual(history.findByArticleId('AKR6'), []);
});
