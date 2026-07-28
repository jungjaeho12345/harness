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

// --- 시점 배부 tick 실행 게이트 (ADR-008 (3) — Z/시스템 전용) ---

test('runDistributionTick: Z만 통과하고 세션에서 도출한 userId를 돌려준다', () => {
  const { authz, sessionService } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin1');

  const gate = authz.runDistributionTick(z);
  assert.equal(gate.ok, true);
  assert.equal(gate.role, 'Z');
  assert.equal(gate.userId, 'admin1', 'actorUserId는 검증된 세션에서만 온다(ADR-004)');
});

test('runDistributionTick: 미인증은 unauthenticated, R/D는 forbidden', () => {
  const { authz, sessionService } = setup();

  assert.equal(authz.runDistributionTick(undefined).reason, 'unauthenticated');
  assert.equal(authz.runDistributionTick('bogus-session').reason, 'unauthenticated');
  assert.equal(authz.runDistributionTick(sessionFor(sessionService, 'R', 'kim')).reason, 'forbidden');
  assert.equal(authz.runDistributionTick(sessionFor(sessionService, 'D', 'desk')).reason, 'forbidden');
});

test('runDistributionTick: capability 표에 Z 전용으로 등재된다', () => {
  const { authz } = setup();
  assert.equal(authz.assertAuthorized('Z', 'runDistributionTick').ok, true);
  assert.equal(authz.assertAuthorized('D', 'runDistributionTick').ok, false);
  assert.equal(authz.assertAuthorized('R', 'runDistributionTick').ok, false);
});
