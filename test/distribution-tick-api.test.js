// 시점 배부 tick transport 테스트 — POST /api/distribution/tick (ADR-008 (3)).
// 계약: Z 전용(미인증 401 / 비-Z 403), 게이트는 컨트롤러/인가 서비스가 강제하고 라우트는 위임만 한다(ADR-006).
// CRITICAL(ADR-004): 라우트는 req.body를 읽지 않는다 — 바디로 대상 기사·강제 시각을 받으면 엠바고 우회가 된다.
// CRITICAL(ADR-008): 앱에 타이머가 없다 — 이 라우트를 외부 운영 루틴이 주기 호출한다.
// SSE(ADR-005): 배부/완결 전이 후 무효화 신호가 재발행돼야 목록의 배부시간·상태가 즉시 갱신된다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

const END_MARKUP = JSON.stringify({
  format: 'yh-editor', version: 1,
  blocks: [{ type: 'text', text: '제목' }, { type: 'text', text: '본문' }, { type: 'text', text: '(끝)' }],
});

// 실제 파일을 만들지 않는 스풀 FS(주입) — 컨트롤러 테스트와 동일한 관례.
function fakeSpoolFs() {
  const calls = { mkdir: [], writeFile: [], rename: [] };
  const op = (name) => async (...args) => { calls[name].push(args); };
  return { calls, mkdir: op('mkdir'), writeFile: op('writeFile'), rename: op('rename') };
}

async function start({ spoolDir = '/spool/out' } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const spoolFs = fakeSpoolFs();
  const controllers = createControllers(db, {
    sessionService,
    env: spoolDir ? { ...ENV, DIST_SPOOL_DIR: spoolDir } : ENV,
    spoolFs,
  });
  const app = createApp({ controllers, sessionService });
  // 무효화 신호 관측 — 라우트가 SSE 버스로 내보내는 kind를 기록한다.
  const signals = [];
  const realNotify = app.notifyChange;
  app.notifyChange = (kind) => { signals.push(kind); return realNotify(kind); };

  const server = app.listen(0);
  await once(server, 'listening');
  return {
    db,
    controllers,
    spoolFs,
    signals,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

function seedUser(db, user) {
  createUserModel(db).insert({ active: 'Y', ...user, password: bcrypt.hashSync(user.password, 10) });
}

async function api(base, method, path, { sid, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (sid) headers['x-session-id'] = sid;
  const res = await fetch(`${base}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, body: json };
}

const login = async (base, userId, password) => (await api(base, 'POST', '/api/login', { body: { userId, password } })).body;

// 엠바고가 설정된 기사를 만들어 송고(EPS)한다. 엠바고 시각은 과거로 둬 tick 대상이 되게 한다.
function seedEmbargoArticle(controllers, { embargoAt, secondEmbargoAt } = {}) {
  const c = controllers.article.create({
    title: '제목', markupVersion: END_MARKUP, author: 'kim', embargoAt, secondEmbargoAt,
  });
  const r = controllers.article.applyAction(c.articleId, 'D', 'send', { userId: 'desk' });
  assert.equal(r.status, 'EPS');
  return c.articleId;
}

const statusOf = (db, id) => db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(id).status;
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('POST /api/distribution/tick: 미인증은 401', async () => {
  const ctx = await start();
  const r = await api(ctx.base, 'POST', '/api/distribution/tick');
  assert.equal(r.status, 401);
  assert.equal(r.body.reason, 'unauthenticated');
  await ctx.close();
});

test('POST /api/distribution/tick: 비-Z(R·D) 세션은 403이고 배부가 일어나지 않는다', async () => {
  const ctx = await start();
  seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
  seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
  const articleId = seedEmbargoArticle(ctx.controllers, { embargoAt: '2020-01-01T00:00:00.000Z' });

  for (const user of ['kim', 'desk']) {
    const { sessionId } = await login(ctx.base, user, 'pw');
    const r = await api(ctx.base, 'POST', '/api/distribution/tick', { sid: sessionId });
    assert.equal(r.status, 403, user);
    assert.equal(r.body.reason, 'forbidden');
  }

  assert.deepEqual(ctx.spoolFs.calls.writeFile, []);
  assert.equal(statusOf(ctx.db, articleId), 'EPS');
  await ctx.close();
});

test('POST /api/distribution/tick: body의 role은 무시된다(신뢰 경계는 세션)', async () => {
  const ctx = await start();
  seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
  const { sessionId } = await login(ctx.base, 'kim', 'pw');

  const r = await api(ctx.base, 'POST', '/api/distribution/tick', {
    sid: sessionId, body: { role: 'Z', articleId: 'AKR-임의', now: '2099-01-01T00:00:00.000Z' },
  });

  assert.equal(r.status, 403);
  await ctx.close();
});

test('POST /api/distribution/tick: Z 세션이면 도래분을 배부하고 EPS→DPS 전이 요약을 돌려준다', async () => {
  const ctx = await start();
  seedUser(ctx.db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await login(ctx.base, 'admin', 'pw');
  assert.equal(
    (await api(ctx.base, 'POST', '/api/distribution-targets', {
      sid: sessionId, body: { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
    })).status,
    200,
  );
  const articleId = seedEmbargoArticle(ctx.controllers, { embargoAt: '2020-01-01T00:00:00.000Z' });

  const r = await api(ctx.base, 'POST', '/api/distribution/tick', { sid: sessionId });

  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.checkedCount, 1);
  assert.deepEqual(r.body.completed, [articleId]);
  assert.deepEqual(r.body.failed, []);
  assert.equal(ctx.spoolFs.calls.rename.length, 1);
  assert.equal(statusOf(ctx.db, articleId), 'DPS');
  await ctx.close();
});

test('POST /api/distribution/tick: 반복 호출은 멱등이다(재배부·재전이 0)', async () => {
  const ctx = await start();
  seedUser(ctx.db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await login(ctx.base, 'admin', 'pw');
  await api(ctx.base, 'POST', '/api/distribution-targets', {
    sid: sessionId, body: { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
  });
  seedEmbargoArticle(ctx.controllers, { embargoAt: '2020-01-01T00:00:00.000Z' });

  await api(ctx.base, 'POST', '/api/distribution/tick', { sid: sessionId });
  const writes = ctx.spoolFs.calls.rename.length;
  const second = await api(ctx.base, 'POST', '/api/distribution/tick', { sid: sessionId });

  assert.equal(second.status, 200);
  assert.equal(second.body.checkedCount, 0);
  assert.deepEqual(second.body.completed, []);
  assert.equal(ctx.spoolFs.calls.rename.length, writes, '두 번째 호출은 파일을 더 쓰지 않는다');
  await ctx.close();
});

test('POST /api/distribution/tick: 스풀 미설정이면 503 spool-disabled', async () => {
  const ctx = await start({ spoolDir: null });
  seedUser(ctx.db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await login(ctx.base, 'admin', 'pw');

  const r = await api(ctx.base, 'POST', '/api/distribution/tick', { sid: sessionId });

  assert.equal(r.status, 503, '설정 누락은 클라이언트 잘못이 아니다');
  assert.equal(r.body.reason, 'spool-disabled');
  await ctx.close();
});

test('tick 배부 후 SSE 무효화 신호가 재발행된다(목록의 배부시간·상태 즉시 갱신)', async () => {
  const ctx = await start();
  seedUser(ctx.db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await login(ctx.base, 'admin', 'pw');
  await api(ctx.base, 'POST', '/api/distribution-targets', {
    sid: sessionId, body: { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
  });
  seedEmbargoArticle(ctx.controllers, { embargoAt: '2020-01-01T00:00:00.000Z' });
  ctx.signals.length = 0;

  await api(ctx.base, 'POST', '/api/distribution/tick', { sid: sessionId });

  assert.equal(ctx.signals.includes('distribute'), true, 'tick 결과가 무효화 신호로 나가야 한다');
  await ctx.close();
});

test('송고 즉시 배부(fire-and-forget) 후에도 무효화 신호가 한 번 더 나간다', async () => {
  const ctx = await start();
  seedUser(ctx.db, { userId: 'admin', role: 'Z', password: 'pw' });
  seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
  const { sessionId: zSid } = await login(ctx.base, 'admin', 'pw');
  await api(ctx.base, 'POST', '/api/distribution-targets', {
    sid: zSid, body: { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
  });

  const { sessionId: dSid } = await login(ctx.base, 'desk', 'pw');
  const created = await api(ctx.base, 'POST', '/api/articles', {
    sid: dSid, body: { title: '제목', markupVersion: END_MARKUP, author: 'kim' },
  });
  ctx.signals.length = 0;

  const sent = await api(ctx.base, 'POST', `/api/articles/${created.body.articleId}/action`, {
    sid: dSid, body: { action: 'send' },
  });
  assert.equal(sent.body.status, 'DPS');
  await flush();

  assert.deepEqual(ctx.signals, ['status', 'distribute'], '송고 신호 뒤에 배부 완료 신호가 따라온다');
  await ctx.close();
});

test('SSE 신호에는 행 데이터가 실리지 않는다(ADR-005 — kind만)', async () => {
  const ctx = await start();
  seedUser(ctx.db, { userId: 'admin', role: 'Z', password: 'pw' });
  const { sessionId } = await login(ctx.base, 'admin', 'pw');
  await api(ctx.base, 'POST', '/api/distribution-targets', {
    sid: sessionId, body: { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
  });
  seedEmbargoArticle(ctx.controllers, { embargoAt: '2020-01-01T00:00:00.000Z' });

  const res = await fetch(`${ctx.base}/api/stream`, { headers: { 'x-session-id': sessionId } });
  const reader = res.body.getReader();
  await reader.read(); // ready 이벤트

  await api(ctx.base, 'POST', '/api/distribution/tick', { sid: sessionId });
  const chunk = new TextDecoder().decode((await reader.read()).value);

  assert.match(chunk, /event: change/);
  assert.match(chunk, /data: \{"kind":"distribute"\}/);
  assert.equal(chunk.includes('제목'), false, '기사 행 데이터는 신호에 담기지 않는다');

  await reader.cancel();
  await ctx.close();
});
