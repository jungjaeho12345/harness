// 컨트롤러 계층 테스트 — createControllers가 모델/서비스를 결선하고
// 대표 흐름(로그인/세션, 기사 create→applyAction·편집잠금, receiverConfig Z 게이트,
// media search, collection 수신)을 서비스로 위임하는지 검증한다.
// 컨트롤러는 로직을 재구현하지 않으므로(ADR-006) 위임 결과만 확인한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createReceiverConfigModel } from '../src/models/receiverConfigModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';

// media 분기를 결정적으로 만들기 위한 기본 env(키 존재) — 실제 외부 호출은 fetchFn 주입으로 차단.
const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

function setup({ fetchFn, sessionService } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const controllers = createControllers(db, { env: ENV, fetchFn, sessionService });
  return { db, controllers };
}

// 평문 비밀번호를 bcrypt 해시로 저장해 사용자 한 명을 시드한다.
function seedUser(db, user) {
  createUserModel(db).insert({
    active: 'Y',
    ...user,
    password: bcrypt.hashSync(user.password, 10),
  });
}

const END_MARKUP = JSON.stringify({
  format: 'yh-editor', version: 1,
  blocks: [{ type: 'text', text: '제목' }, { type: 'text', text: '본문' }, { type: 'text', text: '(끝)' }],
});

test('createControllers: 6개 도메인과 메서드를 결선한다', () => {
  const { controllers } = setup();
  assert.deepEqual(
    Object.keys(controllers).sort(),
    ['article', 'auth', 'collection', 'media', 'receiverConfig', 'user'],
  );
  for (const m of ['login', 'logout', 'manageUsers', 'editDps', 'session']) {
    assert.equal(typeof controllers.auth[m], 'function', `auth.${m}`);
  }
  assert.equal(typeof controllers.user.query, 'function');
  for (const m of [
    'query', 'search', 'create', 'update', 'applyAction',
    'acquireEditLock', 'releaseEditLock', 'forceReleaseEditLock', 'assertLockHolder',
  ]) {
    assert.equal(typeof controllers.article[m], 'function', `article.${m}`);
  }
  assert.equal(typeof controllers.media.search, 'function');
  for (const m of ['query', 'create', 'remove']) {
    assert.equal(typeof controllers.receiverConfig[m], 'function', `receiverConfig.${m}`);
  }
  assert.equal(typeof controllers.collection.receive, 'function');
});

test('auth.login: 자격 검증 후 세션을 발급하고 비밀번호를 노출하지 않는다', async () => {
  const { db, controllers } = setup();
  seedUser(db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw1234' });

  const r = await controllers.auth.login('kim', 'pw1234');
  assert.equal(r.ok, true);
  assert.match(r.sessionId, /^[0-9a-f]{64}$/);
  assert.equal(r.user.userId, 'kim');
  assert.equal(r.user.password, undefined);

  // 발급된 세션은 session 헬퍼로 유효하게 조회된다.
  const me = controllers.auth.session(r.sessionId);
  assert.equal(me.userId, 'kim');
  assert.equal(me.role, 'R');
});

test('auth.login: 잘못된 비밀번호는 거부하고 세션을 발급하지 않는다', async () => {
  const { db, controllers } = setup();
  seedUser(db, { userId: 'kim', role: 'R', password: 'pw1234' });

  const r = await controllers.auth.login('kim', 'wrong');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-credentials');
  assert.equal(r.sessionId, undefined);
});

test('auth.logout: 세션을 무효화한다', async () => {
  const { db, controllers } = setup();
  seedUser(db, { userId: 'kim', role: 'R', password: 'pw' });
  const { sessionId } = await controllers.auth.login('kim', 'pw');

  assert.equal(controllers.auth.logout(sessionId).ok, true);
  assert.equal(controllers.auth.session(sessionId), undefined);
});

test('createControllers: 외부 sessionService 주입을 지원한다 (HTTP 계층과 공유)', async () => {
  const sessionService = createSessionService();
  const { db, controllers } = setup({ sessionService });
  seedUser(db, { userId: 'kim', role: 'R', password: 'pw' });

  const { sessionId } = await controllers.auth.login('kim', 'pw');
  // 주입한 sessionService가 그대로 쓰였다면 같은 스토어에서 세션을 검증할 수 있다.
  assert.equal(sessionService.touchSession(sessionId).userId, 'kim');
});

test('user.query: 비밀번호를 제외한 목록을 서비스에 위임한다', () => {
  const { db, controllers } = setup();
  seedUser(db, { userId: 'kim', role: 'R', password: 'pw' });

  const list = controllers.user.query({ userId: 'kim' });
  assert.equal(list.length, 1);
  assert.equal(list[0].userId, 'kim');
  assert.equal(list[0].password, undefined);
});

test('article.create→applyAction: 생애주기 전이를 서비스에 위임한다', () => {
  const { controllers } = setup();
  const c = controllers.article.create({
    title: '제목', markupVersion: END_MARKUP, author: 'kim', department: '사회부',
  });
  assert.equal(c.ok, true);

  // D 권한이 RDS 기사를 송고 → DPS (sender 기록).
  const a = controllers.article.applyAction(c.articleId, 'D', 'send', { userId: 'desk' });
  assert.equal(a.ok, true);
  assert.equal(a.status, 'DPS');

  const rows = controllers.article.query({ articleId: c.articleId });
  assert.equal(rows[0].status, 'DPS');
  assert.equal(rows[0].sender, 'desk');
});

test('article.applyAction: 송고는 "(끝)" 마커가 없으면 거부된다 (가드 위임)', () => {
  const { controllers } = setup();
  const noEnd = JSON.stringify({ format: 'yh-editor', version: 1, blocks: [{ type: 'text', text: '제목' }] });
  const c = controllers.article.create({ title: '제목', markupVersion: noEnd });
  const a = controllers.article.applyAction(c.articleId, 'D', 'send', { userId: 'desk' });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'no-end-marker');
});

test('article 편집 잠금: acquire/assert/release를 서비스에 위임한다', () => {
  const { controllers } = setup();
  const c = controllers.article.create({ title: 't', markupVersion: '{}' });

  assert.equal(controllers.article.acquireEditLock(c.articleId, { userId: 'kim', sessionId: 's1' }).ok, true);
  assert.equal(controllers.article.assertLockHolder(c.articleId, { sessionId: 's1' }).ok, true);
  assert.equal(controllers.article.assertLockHolder(c.articleId, { sessionId: 's2' }).ok, false);

  // 다른 세션의 획득은 실패하고 누가 잠갔는지 노출하지 않는다.
  const other = controllers.article.acquireEditLock(c.articleId, { sessionId: 's2' });
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'locked');
  assert.equal(other.lockerSessionId, undefined);

  assert.equal(controllers.article.releaseEditLock(c.articleId, { sessionId: 's1' }).ok, true);
  // 강제 해제는 보유자와 무관하게 동작한다.
  controllers.article.acquireEditLock(c.articleId, { sessionId: 's2' });
  assert.equal(controllers.article.forceReleaseEditLock(c.articleId).ok, true);
});

test('article.update / search: 서비스에 위임한다', () => {
  const { controllers } = setup();
  const c = controllers.article.create({ title: '원제목', markupVersion: '{}' });
  const u = controllers.article.update(c.articleId, { title: '수정제목' });
  assert.equal(u.ok, true);

  const found = controllers.article.search('수정제목');
  assert.ok(found.some((row) => row.articleId === c.articleId));
});

test('auth.manageUsers: Z 게이트를 인가 서비스에 위임한다', async () => {
  const { db, controllers } = setup();
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  seedUser(db, { userId: 'rep', role: 'R', password: 'pw' });
  const zsid = (await controllers.auth.login('admin', 'pw')).sessionId;
  const rsid = (await controllers.auth.login('rep', 'pw')).sessionId;

  assert.equal(controllers.auth.manageUsers(zsid, 'query', {}).ok, true);
  assert.equal(controllers.auth.manageUsers(rsid, 'query', {}).reason, 'forbidden');
  assert.equal(controllers.auth.manageUsers('no-such-session', 'query', {}).reason, 'unauthenticated');
});

test('auth.editDps: DPS 고침 인가를 서비스에 위임한다', async () => {
  const { db, controllers } = setup();
  seedUser(db, { userId: 'desk', role: 'D', password: 'pw' });
  const sid = (await controllers.auth.login('desk', 'pw')).sessionId;

  const c = controllers.article.create({ title: 't', markupVersion: END_MARKUP });
  controllers.article.applyAction(c.articleId, 'D', 'send', { userId: 'desk' }); // → DPS

  const ok = controllers.auth.editDps(sid, c.articleId, 'revise');
  assert.equal(ok.ok, true);
  assert.equal(ok.role, 'D');
});

test('receiverConfig: Z 게이트를 인가 서비스에 위임한다 (create/query/remove)', async () => {
  const { db, controllers } = setup();
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  seedUser(db, { userId: 'rep', role: 'R', password: 'pw' });
  const zsid = (await controllers.auth.login('admin', 'pw')).sessionId;
  const rsid = (await controllers.auth.login('rep', 'pw')).sessionId;

  // 비-Z는 거부.
  const denied = controllers.receiverConfig.create(rsid, { sourceId: 's', type: 'FTP' });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'forbidden');

  // Z는 생성/조회/삭제 가능.
  const created = controllers.receiverConfig.create(zsid, { sourceId: 's', type: 'FTP', active: 'Y' });
  assert.equal(created.ok, true);
  const list = controllers.receiverConfig.query(zsid, {});
  assert.equal(list.ok, true);
  assert.equal(list.items.length, 1);
  const removed = controllers.receiverConfig.remove(zsid, created.id);
  assert.equal(removed.ok, true);
  assert.equal(removed.changes, 1);
});

test('collection.receive: 등록 sourceId를 자동기사로 등록(위임)한다', () => {
  const { db, controllers } = setup();
  createReceiverConfigModel(db).insert({ sourceId: 'src-1', type: 'FTP', active: 'Y' });

  const r = controllers.collection.receive('src-1', '자동제목\n본문');
  assert.equal(r.ok, true);
  const rows = controllers.article.query({ articleId: r.articleId });
  assert.equal(rows[0].attribute, '자동기사');
  assert.equal(rows[0].status, 'RDS');
});

test('media.search: 이미지 검색을 미디어 서비스에 위임한다 (주입 fetchFn)', async () => {
  let calledUrl;
  const fetchFn = async (url) => {
    calledUrl = url;
    return { ok: true, json: async () => ({ items: [{ id: 'img-1' }] }) };
  };
  const { controllers } = setup({ fetchFn });

  const r = await controllers.media.search('뉴스', 'image');
  assert.equal(r.error, false);
  assert.deepEqual(r.items, [{ id: 'img-1' }]);
  assert.match(calledUrl, /customsearch/);
});

test('media.search: 영상 검색은 YouTube로 위임한다', async () => {
  let calledUrl;
  const fetchFn = async (url) => {
    calledUrl = url;
    return { ok: true, json: async () => ({}) };
  };
  const { controllers } = setup({ fetchFn });

  const r = await controllers.media.search('뉴스', 'video');
  assert.equal(r.error, false);
  assert.deepEqual(r.items, []);
  assert.match(calledUrl, /youtube/);
});
