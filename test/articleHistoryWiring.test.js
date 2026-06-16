import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createArticleService } from '../src/services/articleService.js';

// 실제 모델 + 이력 모델을 같은 in-memory db에 결선해 통합 검증한다.
function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleHistoryModel = createArticleHistoryModel(db);
  const articleModel = createArticleModel(db, { articleHistoryModel });
  const service = createArticleService({ articleModel, db, articleHistoryModel });
  return { db, articleModel, articleHistoryModel, service };
}

// historyModel 미주입(하위호환) 결선.
function setupNoHistory() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const service = createArticleService({ articleModel, db });
  return { db, articleModel, service };
}

const END = '(끝)';
function markup(text, withEnd = false) {
  const blocks = [{ type: 'text', text }];
  if (withEnd) blocks.push({ type: 'text', text: END });
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}

test('create 후 getHistory에 create 이벤트 1건 — toStatus RDS, title 보존', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  const rows = service.getHistory(articleId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventType, 'create');
  assert.equal(rows[0].toStatus, 'RDS');
  assert.equal(rows[0].fromStatus, null);
  assert.equal(rows[0].title, '제목');
  assert.equal(rows[0].actorUserId, 'kim');
  assert.ok(rows[0].createdAt, 'createdAt이 기록된다');
});

test('create: modifier가 있으면 actorUserId는 modifier 우선', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', author: 'kim', modifier: 'lee' });
  const rows = service.getHistory(articleId);
  assert.equal(rows[0].actorUserId, 'lee');
});

test('update 후 edit 이벤트가 추가되고 getHistory가 시간순(create→edit)', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  service.update(articleId, { title: '수정', modifier: 'park' });
  const rows = service.getHistory(articleId);
  assert.deepEqual(rows.map((r) => r.eventType), ['create', 'edit']);
  const edit = rows[1];
  assert.equal(edit.title, '수정');
  assert.equal(edit.actorUserId, 'park');
  assert.equal(edit.fromStatus, null, 'update는 상태전이 없음');
  assert.equal(edit.toStatus, null);
});

test('applyAction(send) 성공 시 send 이벤트 — from/toStatus·actorRole·actorUserId 보존', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.deepEqual(r, { ok: true, status: 'DPS' });

  const sends = service.getSendHistory(articleId);
  assert.equal(sends.length, 1);
  const s = sends[0];
  assert.equal(s.eventType, 'send');
  assert.equal(s.fromStatus, 'RDS');
  assert.equal(s.toStatus, 'DPS');
  assert.equal(s.actorRole, 'D');
  assert.equal(s.actorUserId, 'desk');

  // 전체 이력은 create, send 두 건.
  assert.deepEqual(service.getHistory(articleId).map((h) => h.eventType), ['create', 'send']);
});

test('applyAction(hold/kill/approveDelete) 성공 시 해당 action 이벤트가 기록된다', () => {
  const { service } = setup();
  const a = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  service.applyAction(a.articleId, 'R', 'hold', { userId: 'kim', sessionId: 's1' });
  const holdRows = service.getHistory(a.articleId);
  assert.equal(holdRows[1].eventType, 'hold');
  assert.equal(holdRows[1].fromStatus, 'RDS');
  assert.equal(holdRows[1].toStatus, 'RRH');
  assert.equal(holdRows[1].actorRole, 'R');

  const b = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  service.applyAction(b.articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  const r = service.applyAction(b.articleId, 'D', 'approveDelete', { userId: 'desk', sessionId: 's1' });
  assert.equal(r.ok, true);
  const events = service.getHistory(b.articleId).map((h) => h.eventType);
  assert.deepEqual(events, ['create', 'send', 'approveDelete']);
});

test('거부된 applyAction(정의 외 전이)은 이력을 남기지 않는다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' }); // RDS → DPS
  const before = service.getHistory(articleId).length;
  const r = service.applyAction(articleId, 'R', 'send', { sessionId: 's2' }); // DPS + R = 거부
  assert.equal(r.ok, false);
  assert.equal(service.getHistory(articleId).length, before, '거부 전이는 이력 미기록');
});

test('send no-end-marker 거부는 이력을 남기지 않는다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-end-marker');
  // create 1건만 남아야 한다.
  assert.deepEqual(service.getHistory(articleId).map((h) => h.eventType), ['create']);
});

test('존재하지 않는 기사 applyAction은 이력을 남기지 않는다', () => {
  const { service } = setup();
  const r = service.applyAction('AKR000', 'D', 'send', { sessionId: 's1' });
  assert.equal(r.ok, false);
  assert.equal(service.getHistory('AKR000').length, 0);
});

test('원자성: 모델 insert에서 이력 INSERT 실패 시 기사도 롤백된다(같은 tx)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  // recordWithDb가 던지도록 만들어 같은 tx에서 강제 실패를 주입.
  const failingHistory = {
    recordWithDb() { throw new Error('이력 강제 실패'); },
    findByArticleId() { return []; },
    findSendByArticleId() { return []; },
  };
  const articleModel = createArticleModel(db, { articleHistoryModel: failingHistory });
  const service = createArticleService({ articleModel, db, articleHistoryModel: failingHistory });

  assert.throws(() => service.create({ title: '제목', author: 'kim' }));
  // 기사 저장이 같은 tx였다면 롤백되어 Article/Contents 모두 없어야 한다.
  const article = db.prepare('SELECT * FROM Article').get();
  const contents = db.prepare('SELECT * FROM Contents').get();
  const hist = db.prepare('SELECT * FROM ArticleHistory').get();
  assert.equal(article, undefined, 'Article 롤백');
  assert.equal(contents, undefined, 'Contents 롤백');
  assert.equal(hist, undefined, 'ArticleHistory 롤백');
});

test('하위호환: historyModel 미주입 시 create/update/applyAction은 기존대로 동작하고 getHistory는 빈 배열', () => {
  const { service, articleModel } = setupNoHistory();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  assert.equal(articleModel.getById(articleId).contents.status, 'RDS');
  const u = service.update(articleId, { title: '수정' });
  assert.equal(u.ok, true);
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.deepEqual(r, { ok: true, status: 'DPS' });
  assert.deepEqual(service.getHistory(articleId), []);
  assert.deepEqual(service.getSendHistory(articleId), []);
});

test('하위호환: articleModel에 historyModel 미주입이면 history 인자는 무시되고 기사만 저장', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db); // historyModel 미주입
  articleModel.insert({
    article: { articleId: 'AKR1', title: '제목' },
    contents: { articleId: 'AKR1', status: 'RDS', createdAt: '2026-06-14T00:00:00.000Z' },
    history: { articleId: 'AKR1', eventType: 'create', createdAt: '2026-06-14T00:00:00.000Z' },
  });
  assert.equal(articleModel.getById('AKR1').contents.status, 'RDS');
  assert.equal(db.prepare('SELECT * FROM ArticleHistory').get(), undefined, '이력은 무시됨');
});
