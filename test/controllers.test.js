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

test('createControllers: 10개 도메인과 메서드를 결선한다', () => {
  const { controllers } = setup();
  assert.deepEqual(
    Object.keys(controllers).sort(),
    ['article', 'auth', 'collection', 'distribution', 'distributionTarget', 'media', 'photo', 'receiverConfig', 'translation', 'user'],
  );
  for (const m of ['login', 'logout', 'manageUsers', 'editDps', 'session']) {
    assert.equal(typeof controllers.auth[m], 'function', `auth.${m}`);
  }
  assert.equal(typeof controllers.user.query, 'function');
  for (const m of [
    'query', 'search', 'create', 'update', 'applyAction',
    'acquireEditLock', 'releaseEditLock', 'forceReleaseEditLock', 'assertLockHolder',
    'getById', 'queryHistory',
  ]) {
    assert.equal(typeof controllers.article[m], 'function', `article.${m}`);
  }
  assert.equal(typeof controllers.media.search, 'function');
  assert.equal(typeof controllers.translation.run, 'function');
  for (const m of ['register', 'search']) {
    assert.equal(typeof controllers.photo[m], 'function', `photo.${m}`);
  }
  for (const m of ['query', 'create', 'remove']) {
    assert.equal(typeof controllers.receiverConfig[m], 'function', `receiverConfig.${m}`);
  }
  // 배부 대상(ADR-008) — 삭제 경로는 없다(비활성은 deactivate).
  for (const m of ['query', 'create', 'update', 'deactivate']) {
    assert.equal(typeof controllers.distributionTarget[m], 'function', `distributionTarget.${m}`);
  }
  assert.equal(controllers.distributionTarget.remove, undefined, 'remove 경로는 없어야 한다');
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

test('article.queryHistory: 이력 조회를 서비스에 위임한다', () => {
  const { controllers } = setup();
  const c = controllers.article.create({ title: '제목', markupVersion: END_MARKUP, author: 'kim' });
  assert.equal(c.ok, true);
  // create는 이력을 남기지 않는다.
  assert.deepEqual(controllers.article.queryHistory(c.articleId), []);

  // D 송고 → status/send 이벤트 1건만 기록.
  controllers.article.applyAction(c.articleId, 'D', 'send', { userId: 'desk' });

  const history = controllers.article.queryHistory(c.articleId);
  assert.ok(Array.isArray(history));
  assert.equal(history.length, 1);
  assert.equal(history[0].eventType, 'status');
  assert.equal(history[0].action, 'send');

  const sendHistory = controllers.article.queryHistory(c.articleId, { sendOnly: true });
  assert.ok(Array.isArray(sendHistory));
  assert.equal(sendHistory.length, 1);
  assert.equal(sendHistory[0].eventType, 'status');
  assert.equal(sendHistory[0].action, 'send');
});

test('article.queryHistory: 이벤트 없는 기사는 빈 배열을 반환한다', () => {
  const { controllers } = setup();
  assert.deepEqual(controllers.article.queryHistory(999999), []);
  assert.deepEqual(controllers.article.queryHistory(999999, { sendOnly: true }), []);
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

  // 보유자는 편집 탭(clientId)이다 — 보유 탭만 assert/release 가능.
  assert.equal(controllers.article.acquireEditLock(c.articleId, { userId: 'kim', sessionId: 's1', clientId: 'c1' }).ok, true);
  assert.equal(controllers.article.assertLockHolder(c.articleId, { clientId: 'c1' }).ok, true);
  assert.equal(controllers.article.assertLockHolder(c.articleId, { clientId: 'c2' }).ok, false);

  // 다른 사용자의 획득은 실패하고 누가 잠갔는지 노출하지 않는다.
  const other = controllers.article.acquireEditLock(c.articleId, { userId: 'lee', sessionId: 's2', clientId: 'c2' });
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'locked');
  assert.equal(other.lockerClientId, undefined);

  assert.equal(controllers.article.releaseEditLock(c.articleId, { clientId: 'c1' }).ok, true);
  // 강제 해제는 보유자와 무관하게 동작한다.
  controllers.article.acquireEditLock(c.articleId, { userId: 'lee', sessionId: 's2', clientId: 'c2' });
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

// --- 배부 결선 (phase 47, ADR-008) ---
// 스풀 FS 조작은 주입해서 검증한다 — 실제 파일을 만들지 않는다(fetchFn 주입과 동일한 이유).
function fakeSpoolFs() {
  const calls = { mkdir: [], writeFile: [], rename: [] };
  const op = (name) => async (...args) => { calls[name].push(args); };
  return { calls, mkdir: op('mkdir'), writeFile: op('writeFile'), rename: op('rename') };
}

// 배부 훅은 fire-and-forget이라 마이크로태스크 큐를 비운 뒤 단언한다.
const flushSpool = () => new Promise((resolve) => setImmediate(resolve));

test('createControllers: DIST_SPOOL_DIR 설정 시 송고가 활성 수신처 스풀에 배부된다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const spoolFs = fakeSpoolFs();
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, sessionService, spoolFs,
  });
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await controllers.auth.login('admin', 'pw');
  assert.equal(controllers.distributionTarget.create(sessionId, { name: 'KBS', kind: 'press', spoolDir: 'kbs' }).ok, true);

  const c = controllers.article.create({ title: '제목', markupVersion: END_MARKUP, author: 'kim' });
  const a = controllers.article.applyAction(c.articleId, 'D', 'send', { userId: 'desk' });
  await flushSpool();

  assert.equal(a.status, 'DPS');
  assert.equal(spoolFs.calls.mkdir[0][0], '/spool/out/kbs');
  assert.equal(spoolFs.calls.rename.length, 1);
  assert.match(spoolFs.calls.rename[0][1], /^\/spool\/out\/kbs\/AKR\d{8}\d{9}_.*\.json$/);
  // 배부 사실이 DB에 기록된다(배부시간 + 이력).
  const row = db.prepare('SELECT distributedAt FROM Contents WHERE articleId = ?').get(c.articleId);
  assert.notEqual(row.distributedAt, null);
  const hist = db.prepare("SELECT * FROM ArticleHistory WHERE articleId = ? AND eventType = 'distribute'").all(c.articleId);
  assert.deepEqual(hist.map((h) => h.action), ['press']);
});

test('createControllers: DIST_SPOOL_DIR 미설정이면 배부가 비활성이고 송고는 정상 동작한다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const spoolFs = fakeSpoolFs();
  const sessionService = createSessionService();
  const controllers = createControllers(db, { env: ENV, sessionService, spoolFs });
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await controllers.auth.login('admin', 'pw');
  controllers.distributionTarget.create(sessionId, { name: 'KBS', kind: 'press', spoolDir: 'kbs' });

  const c = controllers.article.create({ title: '제목', markupVersion: END_MARKUP, author: 'kim' });
  const a = controllers.article.applyAction(c.articleId, 'D', 'send', { userId: 'desk' });
  await flushSpool();

  assert.equal(a.status, 'DPS');
  assert.deepEqual(spoolFs.calls.writeFile, [], '스풀 루트 미설정이면 파일을 쓰지 않는다');
  assert.equal(db.prepare('SELECT distributedAt FROM Contents WHERE articleId = ?').get(c.articleId).distributedAt, null);
});

test('createControllers: 배부 실패는 logService.warn으로 표면화된다(식별자·사유만)', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const warns = [];
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' },
    sessionService,
    // 모든 쓰기가 실패하는 FS — 미발송이 무음으로 사라지지 않아야 한다.
    spoolFs: {
      mkdir: async () => { throw new Error('권한 없음'); },
      writeFile: async () => {},
      rename: async () => {},
    },
    logService: { warn: (m) => warns.push(m), info: () => {}, error: () => {} },
  });
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await controllers.auth.login('admin', 'pw');
  controllers.distributionTarget.create(sessionId, { name: 'KBS', kind: 'press', spoolDir: 'kbs' });

  const c = controllers.article.create({ title: '제목', markupVersion: END_MARKUP, author: 'kim' });
  controllers.article.applyAction(c.articleId, 'D', 'send', { userId: 'desk' });
  await flushSpool();

  assert.equal(warns.length, 1);
  assert.match(warns[0], /^distribution failed articleId=AKR\d+ targetId=1 kind=press reason=spool-write-failed$/);
  // 실패했으므로 배부 시각도 기록되지 않는다(거짓 기록 금지).
  assert.equal(db.prepare('SELECT distributedAt FROM Contents WHERE articleId = ?').get(c.articleId).distributedAt, null);
});

// --- 시점 배부 tick 결선 (phase 48, ADR-008 (3)(5)) ---

// 엠바고가 설정된 기사를 송고해 EPS로 만든 뒤, 엠바고 시각만 과거로 되돌려 tick 대상으로 만든다.
// (엠바고 값은 사용자 입력 자유 텍스트라 서비스가 아니라 DB에 직접 심는 편이 결정적이다.)
function seedEmbargoArticle(db, controllers, { embargoAt, secondEmbargoAt } = {}) {
  const c = controllers.article.create({
    title: '제목', markupVersion: END_MARKUP, author: 'kim', embargoAt, secondEmbargoAt,
  });
  const r = controllers.article.applyAction(c.articleId, 'D', 'send', { userId: 'desk' });
  assert.equal(r.status, 'EPS', '엠바고가 설정된 기사는 송고 시 EPS가 된다');
  return c.articleId;
}

test('createControllers: distribution 도메인은 tick·onChange만 노출한다(타이머 진입점 없음)', () => {
  const { controllers } = setup();
  assert.deepEqual(Object.keys(controllers.distribution).sort(), ['onChange', 'tick']);
});

test('distribution.tick: Z 세션이면 도래한 엠바고를 배부하고 EPS→DPS로 전이한다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const spoolFs = fakeSpoolFs();
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, sessionService, spoolFs,
  });
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await controllers.auth.login('admin', 'pw');
  controllers.distributionTarget.create(sessionId, { name: 'KBS', kind: 'press', spoolDir: 'kbs' });

  const articleId = seedEmbargoArticle(db, controllers, { embargoAt: '2020-01-01T00:00:00.000Z' });
  await flushSpool();
  assert.deepEqual(spoolFs.calls.writeFile, [], '1차 엠바고 기사는 송고 시 배부하지 않는다(phase 47)');

  const r = await controllers.distribution.tick(sessionId);

  assert.equal(r.ok, true);
  assert.deepEqual(r.completed, [articleId]);
  assert.equal(spoolFs.calls.rename.length, 1, '언론사 스풀에 기록된다');
  assert.equal(db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status, 'DPS');
  const hist = db.prepare('SELECT eventType, action FROM ArticleHistory WHERE articleId = ? ORDER BY id').all(articleId);
  assert.deepEqual(hist.map((h) => `${h.eventType}:${h.action}`), ['status:send', 'distribute:press', 'status:embargoComplete']);
});

test('distribution.tick: 비-Z는 forbidden, 미인증은 unauthenticated이며 파일을 쓰지 않는다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const spoolFs = fakeSpoolFs();
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, sessionService, spoolFs,
  });
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  seedUser(db, { userId: 'desk', role: 'D', password: 'pw' });
  const { sessionId: zSid } = await controllers.auth.login('admin', 'pw');
  controllers.distributionTarget.create(zSid, { name: 'KBS', kind: 'press', spoolDir: 'kbs' });
  const articleId = seedEmbargoArticle(db, controllers, { embargoAt: '2020-01-01T00:00:00.000Z' });
  const { sessionId: dSid } = await controllers.auth.login('desk', 'pw');

  assert.equal((await controllers.distribution.tick(dSid)).reason, 'forbidden');
  assert.equal((await controllers.distribution.tick(undefined)).reason, 'unauthenticated');

  assert.deepEqual(spoolFs.calls.writeFile, []);
  assert.equal(db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status, 'EPS');
});

test('distribution.tick: 스풀 미설정이면 게이트 통과 후 spool-disabled를 돌려준다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { env: ENV, sessionService, spoolFs: fakeSpoolFs() });
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await controllers.auth.login('admin', 'pw');

  assert.deepEqual(await controllers.distribution.tick(sessionId), { ok: false, reason: 'spool-disabled' });
  // 비-Z는 배부 활성 여부와 무관하게 여전히 거부된다(설정 상태가 인가를 약화시키지 않는다).
  assert.equal((await controllers.distribution.tick('bogus')).reason, 'unauthenticated');
});

test('distribution.tick: 이력은 tick을 호출한 세션 사용자로 남는다(클라이언트 값 불신)', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, sessionService, spoolFs: fakeSpoolFs(),
  });
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await controllers.auth.login('admin', 'pw');
  controllers.distributionTarget.create(sessionId, { name: 'KBS', kind: 'press', spoolDir: 'kbs' });
  const articleId = seedEmbargoArticle(db, controllers, { embargoAt: '2020-01-01T00:00:00.000Z' });

  await controllers.distribution.tick(sessionId);

  const rows = db.prepare("SELECT actorUserId FROM ArticleHistory WHERE articleId = ? AND eventType != 'status'").all(articleId);
  assert.equal(rows.length > 0, true);
  for (const row of rows) assert.equal(row.actorUserId, 'admin');
});

// --- 배부 변경 구독(onChange) — SSE 무효화 재발행의 seam ---

test('distribution.onChange: 송고 훅 배부 완료 후 구독자에게 알린다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, sessionService, spoolFs: fakeSpoolFs(),
  });
  const seen = [];
  controllers.distribution.onChange(() => seen.push('changed'));
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await controllers.auth.login('admin', 'pw');
  controllers.distributionTarget.create(sessionId, { name: 'KBS', kind: 'press', spoolDir: 'kbs' });

  const c = controllers.article.create({ title: '제목', markupVersion: END_MARKUP, author: 'kim' });
  controllers.article.applyAction(c.articleId, 'D', 'send', { userId: 'desk' });
  await flushSpool();

  assert.equal(seen.length, 1, 'fire-and-forget 배부가 끝난 뒤 목록 무효화 신호가 필요하다');
});

test('distribution.onChange: 배부 0건 + 완결 전이만 있어도 알린다(자가 치유 경로)', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, sessionService, spoolFs: fakeSpoolFs(),
  });
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await controllers.auth.login('admin', 'pw');
  // 수신처가 없으므로 배부는 0건이지만, 배부 이력을 미리 심어 완결 상태로 만든다.
  const articleId = seedEmbargoArticle(db, controllers, { embargoAt: '2020-01-01T00:00:00.000Z' });
  db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, action, createdAt) VALUES (?, 'distribute', 'press', ?)",
  ).run(articleId, '2020-01-01T00:00:00.000Z');

  const seen = [];
  controllers.distribution.onChange(() => seen.push('changed'));
  const r = await controllers.distribution.tick(sessionId);

  assert.deepEqual(r.distributed, []);
  assert.deepEqual(r.completed, [articleId]);
  assert.equal(seen.length, 1, 'status 배지가 EPS→DPS로 바뀌었으므로 목록을 무효화해야 한다');
});

test('distribution.onChange: 아무 일도 없는 tick은 알리지 않고, 구독자 예외는 격리된다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, sessionService, spoolFs: fakeSpoolFs(),
  });
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await controllers.auth.login('admin', 'pw');
  controllers.distributionTarget.create(sessionId, { name: 'KBS', kind: 'press', spoolDir: 'kbs' });

  const seen = [];
  controllers.distribution.onChange(() => { throw new Error('구독자 폭발'); });
  controllers.distribution.onChange(() => seen.push('changed'));

  const empty = await controllers.distribution.tick(sessionId);
  assert.deepEqual(empty.completed, []);
  assert.equal(seen.length, 0, '대상이 없으면 불필요한 전체 재조회를 유발하지 않는다');

  const articleId = seedEmbargoArticle(db, controllers, { embargoAt: '2020-01-01T00:00:00.000Z' });
  const r = await controllers.distribution.tick(sessionId);

  assert.equal(r.ok, true, '구독자 예외가 tick 결과를 바꾸지 않는다');
  assert.deepEqual(r.completed, [articleId]);
  // 배부(onDistributed)와 완결 전이 양쪽에서 신호가 날 수 있다 — 중복은 멱등 재조회라 무해하고, 누락이 유해하다.
  assert.equal(seen.length >= 1, true, '앞선 구독자가 throw해도 뒤 구독자는 호출된다');
});

test('distribution.tick: 스풀 쓰기 실패는 요약·로그로 표면화되고 EPS가 유지된다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const warns = [];
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' },
    sessionService,
    spoolFs: {
      mkdir: async () => { throw new Error('권한 없음'); },
      writeFile: async () => {},
      rename: async () => {},
    },
    logService: { warn: (m) => warns.push(m), info: () => {}, error: () => {} },
  });
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await controllers.auth.login('admin', 'pw');
  controllers.distributionTarget.create(sessionId, { name: 'KBS', kind: 'press', spoolDir: 'kbs' });
  const articleId = seedEmbargoArticle(db, controllers, { embargoAt: '2020-01-01T00:00:00.000Z' });

  const r = await controllers.distribution.tick(sessionId);

  assert.equal(r.ok, true, 'tick 자체는 실패로 끝나지 않는다');
  assert.deepEqual(r.completed, [], '스풀에 못 썼으면 완결이 아니다');
  assert.equal(r.failed.length, 1);
  assert.deepEqual(r.incomplete, [{ articleId, missing: ['press'] }]);
  assert.equal(db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status, 'EPS');
  assert.match(warns[0], /^distribution failed articleId=AKR\d+ targetId=1 kind=press reason=spool-write-failed$/);
  // 거짓 기록 금지 — 배부 시각도 배부 이력도 남지 않는다.
  assert.equal(db.prepare('SELECT distributedAt FROM Contents WHERE articleId = ?').get(articleId).distributedAt, null);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM ArticleHistory WHERE articleId = ? AND eventType = 'distribute'").get(articleId).c,
    0,
  );
});

test('distribution.tick: 2차 엠바고 기사는 송고 시 언론사, tick에서 비언론사로 나뉘어 배부된다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const spoolFs = fakeSpoolFs();
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, sessionService, spoolFs,
  });
  seedUser(db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await controllers.auth.login('admin', 'pw');
  controllers.distributionTarget.create(sessionId, { name: 'KBS', kind: 'press', spoolDir: 'kbs' });
  controllers.distributionTarget.create(sessionId, { name: '포털', kind: 'nonpress', spoolDir: 'portal' });

  // 2차 엠바고만 설정 — news.md: "2차 엠바고 시간에는 비언론사에 배부하는데, 송고시 바로 언론사에 배부한다."
  const articleId = seedEmbargoArticle(db, controllers, { secondEmbargoAt: '2020-01-01T00:00:00.000Z' });
  await flushSpool();
  assert.deepEqual(spoolFs.calls.rename.map((c) => c[1].split('/')[3]), ['kbs'], '송고 시에는 언론사만');

  const r = await controllers.distribution.tick(sessionId);

  assert.deepEqual(spoolFs.calls.rename.map((c) => c[1].split('/')[3]), ['kbs', 'portal'], 'tick에서 비언론사가 추가된다');
  assert.deepEqual(r.completed, [articleId], '두 종류가 모두 나갔으므로 완결');
  assert.equal(db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status, 'DPS');
});
