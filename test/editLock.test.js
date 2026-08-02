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

test('assertLockHolder: 보유 탭(clientId) + 검증 세션 사용자만 true', () => {
  const { service, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  assert.equal(service.assertLockHolder(articleId, { clientId: 'c1', userId: 'kim', sessionId: 's1' }).ok, true);
  // 같은 세션이라도 다른 탭(clientId)은 보유자가 아니다 → 저장 차단.
  assert.equal(service.assertLockHolder(articleId, { clientId: 'c2', userId: 'kim', sessionId: 's1' }).ok, false);
});

test('assertLockHolder: 남의 clientId를 알아도 다른 사용자의 저장은 거부한다(ADR-004)', () => {
  const { service, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  // 공격자가 잠금 보유 탭 문자열을 알아도, 검증 세션의 userId가 다르면 저장 인가는 열리지 않는다.
  const r = service.assertLockHolder(articleId, { clientId: 'c1', userId: 'lee', sessionId: 's2' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-holder');
  // 거부 응답에 누가 잠갔는지 담지 않는다(보유자 비노출).
  assert.equal(r.lockerUserId, undefined, '잠근 사용자 비노출');
  assert.equal(r.lockerSessionId, undefined, '잠근 세션 비노출');
  assert.equal(r.lockerClientId, undefined, '잠근 탭 비노출');
});

test('assertLockHolder: userId를 넘기지 않으면 거부한다(하위호환 폴백 금지)', () => {
  const { service, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  // 호출자가 신원 인자를 빠뜨리면 조용히 인가가 열리는 폴백이 있어선 안 된다.
  assert.equal(service.assertLockHolder(articleId, { clientId: 'c1' }).reason, 'not-holder');
  assert.equal(service.assertLockHolder(articleId, { clientId: 'c1', userId: '' }).reason, 'not-holder');
  assert.equal(service.assertLockHolder(articleId, { clientId: 'c1', userId: null }).reason, 'not-holder');
});

test('assertLockHolder: 같은 사용자가 재로그인해 sessionId가 달라도 보유 탭이면 저장할 수 있다', () => {
  const { service, articleModel, articleId } = setup();
  service.acquireEditLock(articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' });
  // 세션만 갱신되고(재로그인) 탭이 잠금을 재획득하지 못한 상태 — 편집물 유실 방지를 위해 허용한다.
  assert.equal(articleModel.getById(articleId).contents.lockerSessionId, 's1');
  assert.equal(service.assertLockHolder(articleId, { clientId: 'c1', userId: 'kim', sessionId: 's2' }).ok, true);
});

test('assertLockHolder: lockerUserId가 비어 있는 레거시 잠금 행은 거부한다', () => {
  const { service, articleModel, articleId } = setup();
  // 과거(신원 미기록) 잠금 행 재현 — 편집 재진입으로 잠금을 다시 획득하면 복구된다(DB는 고치지 않는다).
  articleModel.setLock(articleId, {
    lockerUserId: null, lockerSessionId: null, lockerClientId: 'c1', lockedAt: new Date().toISOString(),
  });
  assert.equal(service.assertLockHolder(articleId, { clientId: 'c1', userId: 'kim', sessionId: 's1' }).reason, 'not-holder');
});

test('assertLockHolder: 없는 기사는 not-found, 잠기지 않은 기사는 not-holder', () => {
  const { service, articleId } = setup();
  assert.equal(service.assertLockHolder('999999', { clientId: 'c1', userId: 'kim', sessionId: 's1' }).reason, 'not-found');
  assert.equal(service.assertLockHolder(articleId, { clientId: 'c1', userId: 'kim', sessionId: 's1' }).reason, 'not-holder');
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
