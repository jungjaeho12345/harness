import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleService } from '../src/services/articleService.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const service = createArticleService({ articleModel, db });
  const { articleId } = service.create({ title: '제목', author: 'kim' });
  return { db, articleModel, service, articleId };
}

test('acquireEditLock: 잠겨있지 않으면 획득하고 보유자는 세션이다', () => {
  const { service, articleModel, articleId } = setup();
  const r = service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1' });
  assert.equal(r.ok, true);
  const c = articleModel.getById(articleId).contents;
  assert.equal(c.lockYN, 'Y');
  assert.equal(c.lockerSessionId, 's1');
  assert.equal(c.lockerUserId, 'kim');
  assert.ok(c.lockedAt);
});

test('acquireEditLock: 다른 세션이 잠근 기사는 획득 실패하고 누가 잠갔는지 노출하지 않는다', () => {
  const { service, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1' });
  const r = service.acquireEditLock(articleId, { userId: 'lee', sessionId: 's2' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'locked');
  assert.equal(r.lockerUserId, undefined, '잠근 사용자 비노출');
  assert.equal(r.lockerSessionId, undefined, '잠근 세션 비노출');
});

test('acquireEditLock: 같은 세션은 다시 획득(갱신)할 수 있다', () => {
  const { service, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1' });
  const r = service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1' });
  assert.equal(r.ok, true);
});

test('acquireEditLock: 30분 무갱신(stale) 잠금은 다음 시도자가 가져갈 수 있다', () => {
  const { service, articleModel, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1' });
  // lockedAt을 31분 전으로 강제해 stale을 유도한다.
  const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  articleModel.setLock(articleId, { lockerUserId: 'kim', lockerSessionId: 's1', lockedAt: old });

  const r = service.acquireEditLock(articleId, { userId: 'lee', sessionId: 's2' });
  assert.equal(r.ok, true);
  assert.equal(articleModel.getById(articleId).contents.lockerSessionId, 's2');
});

test('assertLockHolder: 보유 세션만 true', () => {
  const { service, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1' });
  assert.equal(service.assertLockHolder(articleId, { sessionId: 's1' }).ok, true);
  assert.equal(service.assertLockHolder(articleId, { sessionId: 's2' }).ok, false);
});

test('releaseEditLock: 보유자는 해제할 수 있고 비보유자는 해제할 수 없다', () => {
  const { service, articleModel, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1' });

  assert.equal(service.releaseEditLock(articleId, { sessionId: 's2' }).ok, false);
  assert.equal(articleModel.getById(articleId).contents.lockYN, 'Y', '비보유자 해제 시 잠금 유지');

  assert.equal(service.releaseEditLock(articleId, { sessionId: 's1' }).ok, true);
  assert.equal(articleModel.getById(articleId).contents.lockYN, 'N');
});

test('releaseEditLock: 이미 해제된 잠금 해제는 멱등(ok)', () => {
  const { service, articleId } = setup();
  assert.equal(service.releaseEditLock(articleId, { sessionId: 's1' }).ok, true);
});

test('forceReleaseEditLock: 보유자와 무관하게 강제 해제한다', () => {
  const { service, articleModel, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1' });
  const r = service.forceReleaseEditLock(articleId);
  assert.equal(r.ok, true);
  assert.equal(articleModel.getById(articleId).contents.lockYN, 'N');
});
