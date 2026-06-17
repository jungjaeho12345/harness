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

test('acquireEditLock: 잠겨있지 않으면 획득하고 보유자는 편집 탭(clientId)이다', () => {
  const { service, articleModel, articleId } = setup();
  const r = service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  assert.equal(r.ok, true);
  const c = articleModel.getById(articleId).contents;
  assert.equal(c.lockYN, 'Y');
  assert.equal(c.lockerSessionId, 's1');
  assert.equal(c.lockerUserId, 'kim');
  assert.equal(c.lockerClientId, 'c1');
  assert.ok(c.lockedAt);
});

test('acquireEditLock: 다른 사용자가 잠근 기사는 획득 실패하고 누가 잠갔는지 노출하지 않는다', () => {
  const { service, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  const r = service.acquireEditLock(articleId, { userId: 'lee', sessionId: 's2', clientId: 'c2' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'locked');
  assert.equal(r.lockerUserId, undefined, '잠근 사용자 비노출');
  assert.equal(r.lockerSessionId, undefined, '잠근 세션 비노출');
  assert.equal(r.lockerClientId, undefined, '잠근 탭 비노출');
});

test('acquireEditLock: 같은 탭(clientId)은 다시 획득(F5 새로고침 재획득)할 수 있다', () => {
  const { service, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  const r = service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  assert.equal(r.ok, true);
});

test('acquireEditLock: (b) 같은 사용자가 다른 세션으로 재로그인하면 takeover한다(이전 세션 만료)', () => {
  const { service, articleModel, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  // 같은 userId, 다른 sessionId(재로그인), 다른 clientId(새 탭) → takeover 허용.
  const r = service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's2', clientId: 'c2' });
  assert.equal(r.ok, true);
  const c = articleModel.getById(articleId).contents;
  assert.equal(c.lockerSessionId, 's2');
  assert.equal(c.lockerClientId, 'c2');
});

test('acquireEditLock: (c) 같은 세션의 다른 탭(다른 clientId)은 차단한다', () => {
  const { service, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  // 같은 userId·같은 sessionId·다른 clientId → 한 사용자가 여러 탭 동시 편집 금지 → locked.
  const r = service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c2' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'locked');
});

test('acquireEditLock: 30분 무갱신(stale) 잠금은 다음 시도자가 가져갈 수 있다', () => {
  const { service, articleModel, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  // lockedAt을 31분 전으로 강제해 stale을 유도한다.
  const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  articleModel.setLock(articleId, { lockerUserId: 'kim', lockerSessionId: 's1', lockerClientId: 'c1', lockedAt: old });

  const r = service.acquireEditLock(articleId, { userId: 'lee', sessionId: 's2', clientId: 'c2' });
  assert.equal(r.ok, true);
  const c = articleModel.getById(articleId).contents;
  assert.equal(c.lockerSessionId, 's2');
  assert.equal(c.lockerClientId, 'c2');
});

test('assertLockHolder: 보유 탭(clientId)만 true', () => {
  const { service, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  assert.equal(service.assertLockHolder(articleId, { clientId: 'c1' }).ok, true);
  // 같은 세션이라도 다른 탭(clientId)은 보유자가 아니다 → 저장 차단.
  assert.equal(service.assertLockHolder(articleId, { clientId: 'c2' }).ok, false);
});

test('releaseEditLock: 보유 탭(clientId)은 해제할 수 있고 비보유 탭은 해제할 수 없다', () => {
  const { service, articleModel, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });

  // 다른 탭(같은 세션이라도) → not-holder, 잠금 유지.
  assert.equal(service.releaseEditLock(articleId, { clientId: 'c2' }).ok, false);
  assert.equal(articleModel.getById(articleId).contents.lockYN, 'Y', '비보유 탭 해제 시 잠금 유지');

  // 보유 탭 → 해제.
  assert.equal(service.releaseEditLock(articleId, { clientId: 'c1' }).ok, true);
  const c = articleModel.getById(articleId).contents;
  assert.equal(c.lockYN, 'N');
  assert.equal(c.lockerClientId, null, '해제 시 lockerClientId도 NULL이 된다');
});

test('releaseEditLock: 이미 해제된 잠금 해제는 멱등(ok)', () => {
  const { service, articleId } = setup();
  assert.equal(service.releaseEditLock(articleId, { clientId: 'c1' }).ok, true);
});

test('forceReleaseEditLock: 보유자와 무관하게 강제 해제한다', () => {
  const { service, articleModel, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  const r = service.forceReleaseEditLock(articleId);
  assert.equal(r.ok, true);
  assert.equal(articleModel.getById(articleId).contents.lockYN, 'N');
});
