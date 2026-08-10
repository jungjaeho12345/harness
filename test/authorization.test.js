import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleService } from '../src/services/articleService.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createAuthorization } from '../src/services/authorization.js';

const END = '(끝)';
function markup(text, withEnd = false) {
  const blocks = [{ type: 'text', text }];
  if (withEnd) blocks.push({ type: 'text', text: END });
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const articleService = createArticleService({ articleModel, db });
  const sessionService = createSessionService();
  const authz = createAuthorization({ sessionService, articleModel });
  return { articleModel, articleService, sessionService, authz };
}

// 주어진 역할로 실제 세션을 발급한다 — acting role은 이 세션에서만 도출되어야 한다.
function sessionFor(sessionService, role, userId = 'u') {
  return sessionService.createSession({
    userId, role, department: '정치부', departmentCode: 'POL', name: userId,
  });
}

test('assertAuthorized: capability별 R/D/Z 역할 게이트', () => {
  const { authz } = setup();
  assert.equal(authz.assertAuthorized('Z', 'manageUsers').ok, true);
  assert.equal(authz.assertAuthorized('R', 'manageUsers').ok, false);
  assert.equal(authz.assertAuthorized('D', 'manageUsers').ok, false);
  assert.equal(authz.assertAuthorized('D', 'editDps').ok, true);
  assert.equal(authz.assertAuthorized('R', 'editDps').ok, false);
  assert.equal(authz.assertAuthorized('Z', 'unknownCap').ok, false, '정의되지 않은 capability는 거부');
});

test('manageUsers: Z 세션만 통과, 비-Z는 forbidden, 미인증은 unauthenticated', () => {
  const { authz, sessionService } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');
  const d = sessionFor(sessionService, 'D', 'desk');

  assert.equal(authz.manageUsers(z, 'insert', { userId: 'x' }).ok, true);

  const denied = authz.manageUsers(d, 'insert', {});
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'forbidden');

  const noauth = authz.manageUsers('bad-session', 'insert', {});
  assert.equal(noauth.ok, false);
  assert.equal(noauth.reason, 'unauthenticated');
});

test('manageUsers: acting role은 세션에서만 도출한다 (payload의 role은 신뢰하지 않는다)', () => {
  const { authz, sessionService } = setup();
  const r = sessionFor(sessionService, 'R', 'reporter');
  // payload에 role:'Z'를 실어도 세션 역할(R)로 판정되어 거부되어야 한다.
  const res = authz.manageUsers(r, 'insert', { role: 'Z' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden');
});

test('manageReceiverConfig: Z 세션만 통과', () => {
  const { authz, sessionService } = setup();
  assert.equal(authz.manageReceiverConfig(sessionFor(sessionService, 'Z', 'admin'), 'remove', { id: 1 }).ok, true);
  assert.equal(authz.manageReceiverConfig(sessionFor(sessionService, 'R', 'rep'), 'remove', {}).ok, false);
  assert.equal(authz.manageReceiverConfig('nope', 'remove', {}).reason, 'unauthenticated');
});

test('editDps: DPS 기사는 D 세션만 고침/포털고침 인가, R/미인증은 거부', () => {
  const { authz, articleService, articleModel, sessionService } = setup();
  const { articleId } = articleService.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  articleService.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' }); // RDS → DPS
  assert.equal(articleModel.getById(articleId).contents.status, 'DPS');

  const d = sessionFor(sessionService, 'D', 'desk');
  const r = sessionFor(sessionService, 'R', 'rep');

  assert.equal(authz.editDps(d, articleId, 'revise').ok, true);
  assert.equal(authz.editDps(d, articleId, 'portalRevise').ok, true);

  const denied = authz.editDps(r, articleId, 'revise');
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'forbidden');

  assert.equal(authz.editDps('bad', articleId, 'revise').reason, 'unauthenticated');
});

test('editDps: DPS가 아니면 not-dps, 없는 기사는 not-found, 모르는 액션은 unknown-action', () => {
  const { authz, articleService, sessionService } = setup();
  const d = sessionFor(sessionService, 'D', 'desk');
  const { articleId } = articleService.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' }); // RDS

  assert.equal(authz.editDps(d, articleId, 'revise').reason, 'not-dps');
  assert.equal(authz.editDps(d, 'AKR000', 'revise').reason, 'not-found');
  assert.equal(authz.editDps(d, articleId, 'bogus').reason, 'unknown-action');
});

// --- phase 57 step4: 배부 실패 조회·재전송 게이트 (manageDistributionFailure, ADR-008 MVP-4) ---

// 케이스 1
test('manageDistributionFailure: Z 세션은 { ok:true, role, userId }를 받는다 (userId = 세션 값)', () => {
  const { authz, sessionService } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin7');

  const r = authz.manageDistributionFailure(z);
  assert.equal(r.ok, true);
  assert.equal(r.role, 'Z');
  assert.equal(r.userId, 'admin7', '재전송 이력 actorUserId stamp용 — 세션에서만 도출');
});

// 케이스 2
test('manageDistributionFailure: R·D 세션은 forbidden', () => {
  const { authz, sessionService } = setup();
  for (const role of ['R', 'D']) {
    const sid = sessionFor(sessionService, role, `u-${role}`);
    const r = authz.manageDistributionFailure(sid);
    assert.equal(r.ok, false, `role=${role}`);
    assert.equal(r.reason, 'forbidden', `role=${role}`);
  }
});

// 케이스 3
test('manageDistributionFailure: 미인증은 unauthenticated이고 role이 응답에 없다', () => {
  const { authz } = setup();
  const r = authz.manageDistributionFailure('no-such-session');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unauthenticated');
  assert.ok(!('role' in r), 'role 미노출');
  assert.ok(!('userId' in r), 'userId 미노출');
});

// 케이스 4
test('manageDistributionFailure: 게이트는 touchSession을 쓴다 (일반 REST 슬라이딩 갱신 계약)', () => {
  const calls = [];
  const fakeSession = {
    touchSession(sid) {
      calls.push(sid);
      return sid === 'z-sid' ? { userId: 'admin', role: 'Z' } : undefined;
    },
  };
  const authz = createAuthorization({ sessionService: fakeSession, articleModel: {} });

  assert.equal(authz.manageDistributionFailure('z-sid').ok, true);
  assert.deepEqual(calls, ['z-sid'], 'touchSession 경유(스파이 확인) — peek이 아니다');
});

// 케이스 5
test('assertAuthorized: manageDistributionFailure는 Z만 허용한다', () => {
  const { authz } = setup();
  assert.equal(authz.assertAuthorized('Z', 'manageDistributionFailure').ok, true);
  assert.equal(authz.assertAuthorized('R', 'manageDistributionFailure').ok, false);
  assert.equal(authz.assertAuthorized('D', 'manageDistributionFailure').ok, false);
});
