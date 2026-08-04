// 응답 비밀 노출 전수 단언 — phase 51 step0.
// CRITICAL(ADR-004): 세션 토큰은 그 자체가 권한이다. 어떤 기사 라우트도 다른 사용자의
// 활성 세션 토큰(Contents.lockerSessionId)이나 편집 탭 식별자(lockerClientId)를 응답에 실어서는 안 된다.
// 실려 나가면 R(기자) 세션으로 목록만 조회해도 D(데스크)의 토큰을 얻어 권한 상승이 가능하다.
//
// 검증 방식: D가 기사를 잠근 "진짜" 상태(DB에서 직접 확인)를 만든 뒤, R 세션으로 기사 라우트를
// 전수 호출해 응답 JSON 문자열에 (i) D의 세션 토큰 (ii) 비밀 키 이름이 없음을 단언한다.
// 라우트는 배열로 선언하고 루프로 단언한다 — 새 라우트가 생기면 여기에 추가한다(실패 메시지에 경로 포함).
// GET /api/stream(SSE)은 행 데이터 없는 무효화 신호라 대상이 아니다(ADR-005).

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

// 외부 호출은 하지 않는다 — 번역 키를 주지 않아 graceful(no-key) 경로로 떨어진다.
const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

const END_MARKUP = JSON.stringify({
  format: 'yh-editor', version: 1,
  blocks: [{ type: 'text', text: '제목' }, { type: 'text', text: '본문' }, { type: 'text', text: '(끝)' }],
});

// 앱만 만든다(포트 바인딩 없음) — 라우터 전수 반영 테스트는 네트워크가 필요 없다.
function buildApp() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    sessionService,
    env: ENV,
    fetchFn: async () => { throw new Error('외부 호출 금지'); },
  });
  return { db, app: createApp({ controllers, sessionService }) };
}

async function start() {
  const { db, app } = buildApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
}

function seedUser(db, user) {
  createUserModel(db).insert({ active: 'Y', ...user, password: bcrypt.hashSync(user.password, 10) });
}

async function api(base, method, path, { sid, body, clientId } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (sid) headers['x-session-id'] = sid;
  if (clientId) headers['x-edit-client'] = clientId;
  const res = await fetch(`${base}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, body: json };
}

async function login(base, userId, password) {
  return (await api(base, 'POST', '/api/login', { body: { userId, password } })).body;
}

const D_CLIENT = 'tab-desk-secret';

// D(desk1)가 기사를 만들고 잠근 상태 + R(rep1) 세션을 준비한다.
async function fixture(ctx) {
  seedUser(ctx.db, { userId: 'desk1', name: '데스크', role: 'D', department: '편집부', password: 'pw' });
  seedUser(ctx.db, { userId: 'rep1', name: '기자', role: 'R', department: '사회부', password: 'pw' });

  const dSid = (await login(ctx.base, 'desk1', 'pw')).sessionId;
  const rSid = (await login(ctx.base, 'rep1', 'pw')).sessionId;

  const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
    sid: dSid, body: { title: '잠긴 기사', markupVersion: END_MARKUP },
  })).body;

  const lock = await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid: dSid, clientId: D_CLIENT });
  assert.equal(lock.status, 200, 'D가 잠금을 획득해야 픽스처가 성립한다');

  // 이력 스냅샷 라우트 검증용 이력 1건(edit) — 보유 탭으로 저장한다.
  await api(ctx.base, 'PUT', `/api/articles/${articleId}`, {
    sid: dSid, clientId: D_CLIENT, body: { title: '잠긴 기사(수정)', markupVersion: END_MARKUP },
  });
  const history = (await api(ctx.base, 'GET', `/api/articles/${articleId}/history`, { sid: dSid })).body.items;
  assert.ok(history.length > 0, '이력 픽스처가 있어야 한다');

  // 픽스처가 진짜인지 DB에서 확인한다 — 여기에 D의 실제 세션 토큰이 저장돼 있다.
  const row = ctx.db.prepare('SELECT * FROM Contents WHERE articleId = ?').get(articleId);
  assert.equal(row.lockYN, 'Y');
  assert.equal(row.lockerUserId, 'desk1');
  assert.equal(row.lockerSessionId, dSid, 'DB에 D의 실제 세션 토큰이 저장돼 있어야 한다');
  assert.equal(row.lockerClientId, D_CLIENT);

  return { dSid, rSid, articleId, historyId: history[0].id };
}

// R 세션으로 호출할 기사/배부 라우트 전수. 새 라우트가 추가되면 반드시 여기에 넣는다.
// 4번째 원소는 Express에 등록된 라우트 템플릿 — 아래 "누락 방지" 테스트가 라우터 실물과 대조한다.
function routesFor({ articleId, historyId }) {
  return [
    ['GET', '/api/articles', {}, '/api/articles'],
    ['GET', `/api/articles/${articleId}`, {}, '/api/articles/:id'],
    ['GET', '/api/articles/search?q=%EC%9E%A0%EA%B8%B4', {}, '/api/articles/search'],
    ['GET', `/api/articles/${articleId}/history`, {}, '/api/articles/:id/history'],
    ['GET', `/api/articles/${articleId}/history/${historyId}`, {}, '/api/articles/:id/history/:historyId'],
    ['POST', '/api/articles', { body: { title: 'R의 새 기사', markupVersion: END_MARKUP } }, '/api/articles'],
    ['POST', `/api/articles/${articleId}/action`, { body: { action: 'send' } }, '/api/articles/:id/action'],
    ['POST', `/api/articles/${articleId}/derive`, { body: { mode: 'continue' } }, '/api/articles/:id/derive'],
    ['POST', `/api/articles/${articleId}/translate`, { body: { targetLang: 'en' } }, '/api/articles/:id/translate'],
    ['PUT', `/api/articles/${articleId}`, { clientId: 'tab-r', body: { title: '탈취 시도' } }, '/api/articles/:id'],
    ['POST', `/api/articles/${articleId}/lock`, { clientId: 'tab-r' }, '/api/articles/:id/lock'],
    ['POST', `/api/articles/${articleId}/unlock`, { clientId: 'tab-r' }, '/api/articles/:id/unlock'],
    ['POST', `/api/articles/${articleId}/force-unlock`, { clientId: 'tab-r' }, '/api/articles/:id/force-unlock'],
    // 스풀 미설정이라 spool-disabled/403이어도 응답 본문을 검사한다.
    ['POST', '/api/distribution/tick', {}, '/api/distribution/tick'],
  ];
}

// 감사 대상 범위 — Contents 행(잠금 컬럼 보유)이 응답에 실릴 수 있는 라우트군.
// /api/stream(SSE)은 무효화 신호만 보내므로(ADR-005) 제외한다.
const inAuditScope = (path) => path.startsWith('/api/articles') || path === '/api/distribution/tick';

// Express 라우터에 실제 등록된 (METHOD, 템플릿) 전수. 반영(reflection)이라 목록을 손으로 관리하지 않는다.
function registeredRoutes(app) {
  const stack = app._router?.stack ?? app.router?.stack ?? [];
  const out = [];
  for (const layer of stack) {
    if (!layer.route || typeof layer.route.path !== 'string') continue;
    for (const [method, on] of Object.entries(layer.route.methods ?? {})) {
      if (on && method !== '_all') out.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return out;
}

test('R 세션의 어떤 기사 라우트 응답에도 D의 활성 세션 토큰/편집 탭 식별자가 실리지 않는다', async () => {
  const ctx = await start();
  try {
    const { dSid, rSid, articleId, historyId } = await fixture(ctx);

    for (const [method, path, opts] of routesFor({ articleId, historyId })) {
      const r = await api(ctx.base, method, path, { sid: rSid, ...opts });
      const raw = JSON.stringify(r.body ?? null);
      const where = `${method} ${path}`;
      assert.equal(raw.includes(dSid), false, `${where}: D의 세션 토큰이 응답에 실렸다`);
      assert.equal(raw.includes(D_CLIENT), false, `${where}: D의 편집 탭 식별자가 응답에 실렸다`);
      assert.equal(raw.includes('lockerSessionId'), false, `${where}: lockerSessionId 키가 응답에 있다`);
      assert.equal(raw.includes('lockerClientId'), false, `${where}: lockerClientId 키가 응답에 있다`);
    }
  } finally { await ctx.close(); }
});

test('투영 후에도 잠금 표시 UI 계약(lockYN/lockerUserId/lockedAt)은 응답에 남는다', async () => {
  const ctx = await start();
  try {
    const { rSid, articleId } = await fixture(ctx);

    const list = await api(ctx.base, 'GET', '/api/articles', { sid: rSid });
    const row = list.body.items.find((i) => i.articleId === articleId);
    assert.equal(row.lockYN, 'Y');
    assert.equal(row.lockerUserId, 'desk1');
    assert.ok(row.lockedAt, 'lockedAt은 유지된다');

    const one = await api(ctx.base, 'GET', `/api/articles/${articleId}`, { sid: rSid });
    assert.equal(one.body.contents.lockYN, 'Y');
    assert.equal(one.body.contents.lockerUserId, 'desk1');
    assert.ok(one.body.contents.lockedAt);
  } finally { await ctx.close(); }
});

// 누락 방지 장치 — 손으로 관리하는 목록은 반드시 썩는다(이 결함의 원인 자체가 라우트별 누락이었다).
// 라우터 실물과 대조해, 새 기사 라우트를 추가하면 위 전수 목록에 넣기 전까지 이 테스트가 먼저 실패하게 한다.
test('전수 목록이 등록된 모든 기사/배부 라우트를 덮는다(새 라우트 누락 방지)', () => {
  const { app } = buildApp();
  const registered = registeredRoutes(app);

  // 반영이 깨지면(Express 내부 구조 변경 등) 조용히 통과하지 않고 여기서 실패한다.
  assert.ok(registered.length > 20, `라우터 반영 실패: ${registered.length}건만 수집됐다`);
  assert.ok(registered.includes('GET /api/articles/:id'), '알려진 라우트가 수집되지 않았다 — 반영 로직 점검');

  const audited = new Set(routesFor({ articleId: 'X', historyId: 1 }).map(([m, , , tpl]) => `${m} ${tpl}`));
  const missing = registered.filter((r) => inAuditScope(r.slice(r.indexOf(' ') + 1)) && !audited.has(r));
  assert.deepEqual(missing, [], `응답 비밀 감사에서 빠진 라우트: ${missing.join(', ')} → routesFor에 추가하라`);

  // 반대 방향 — 사라진 라우트를 감사 목록에 남겨두면 커버리지 착시가 된다.
  const stale = [...audited].filter((r) => !registered.includes(r));
  assert.deepEqual(stale, [], `등록되지 않은 라우트가 감사 목록에 남아 있다: ${stale.join(', ')}`);
});

test('응답 투영은 DB의 잠금 상태를 바꾸지 않는다(잠금 판정 근거 보존 — DB 비파괴)', async () => {
  const ctx = await start();
  try {
    const { dSid, rSid, articleId } = await fixture(ctx);

    await api(ctx.base, 'GET', '/api/articles', { sid: rSid });
    await api(ctx.base, 'GET', `/api/articles/${articleId}`, { sid: rSid });

    const row = ctx.db.prepare('SELECT * FROM Contents WHERE articleId = ?').get(articleId);
    assert.equal(row.lockYN, 'Y');
    assert.equal(row.lockerSessionId, dSid, '응답 투영이 DB 행을 오염시키지 않는다');
    assert.equal(row.lockerClientId, D_CLIENT);
  } finally { await ctx.close(); }
});
