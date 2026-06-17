import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createArticleService } from '../src/services/articleService.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const service = createArticleService({ articleModel, db, historyModel });
  return { db, articleModel, historyModel, service };
}

const END = '(끝)';
function markup(text, withEnd = false) {
  const blocks = [{ type: 'text', text }];
  if (withEnd) blocks.push({ type: 'text', text: END });
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}

test('history: 편집 저장(update) 시 eventType=edit 이력 1건이 기록된다(actorUserId=modifier)', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  service.update(articleId, { title: '수정', modifier: 'kim' });

  const rows = service.queryHistory(articleId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventType, 'edit');
  assert.equal(rows[0].action, null);
  assert.equal(rows[0].actorUserId, 'kim');
  assert.ok(rows[0].createdAt, 'createdAt이 stamp된다');
});

test('history: 전이 성공 시에만 eventType=status 이력이 기록된다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.equal(r.ok, true);

  const rows = service.queryHistory(articleId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventType, 'status');
  assert.equal(rows[0].action, 'send');
  assert.equal(rows[0].fromStatus, 'RDS');
  assert.equal(rows[0].toStatus, 'DPS');
  assert.equal(rows[0].actorUserId, 'desk');
});

test('history: 전이 거부(no-end-marker) 시 이력이 기록되지 않는다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.equal(r.ok, false);
  assert.equal(service.queryHistory(articleId).length, 0);
});

test('history: 정의되지 않은 전이 거부 시 이력이 기록되지 않는다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' }); // RDS → DPS (status 1건)
  const r = service.applyAction(articleId, 'R', 'send', { sessionId: 's2' }); // 거부
  assert.equal(r.ok, false);

  const rows = service.queryHistory(articleId);
  assert.equal(rows.length, 1, '거부된 전이는 기록되지 않는다');
  assert.equal(rows[0].action, 'send');
});

test('history: queryHistory({sendOnly})는 송고 status 이벤트만 반환한다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  service.update(articleId, { title: '수정', modifier: 'kim' });          // edit
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });   // status/send
  service.applyAction(articleId, 'D', 'approveDelete', { userId: 'desk', sessionId: 's1' }); // status/approveDelete

  const all = service.queryHistory(articleId);
  assert.equal(all.length, 3);

  const sendOnly = service.queryHistory(articleId, { sendOnly: true });
  assert.equal(sendOnly.length, 1);
  assert.equal(sendOnly[0].eventType, 'status');
  assert.equal(sendOnly[0].action, 'send');
});

test('history: 이력 기록이 실패해도(historyModel.insert throw) 편집/전이는 정상 반환된다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const throwingHistory = {
    insert() { throw new Error('history down'); },
    queryByArticle() { return []; },
  };
  const service = createArticleService({ articleModel, db, historyModel: throwingHistory });

  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  // 편집: 이력 insert가 throw해도 update는 ok.
  const u = service.update(articleId, { title: '수정', modifier: 'kim' });
  assert.equal(u.ok, true);
  // 전이: 이력 insert가 throw해도 전이는 ok이고 status가 바뀐다.
  const a = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.deepEqual(a, { ok: true, status: 'DPS' });
  assert.equal(articleModel.getById(articleId).contents.status, 'DPS');
});

test('history: historyModel 미주입 시 기존 동작이 보존된다(기록 건너뜀, queryHistory 빈 배열)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const service = createArticleService({ articleModel, db }); // historyModel 없음

  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  assert.equal(service.update(articleId, { title: '수정', modifier: 'kim' }).ok, true);
  assert.deepEqual(
    service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' }),
    { ok: true, status: 'DPS' },
  );
  assert.deepEqual(service.queryHistory(articleId), []);
});
