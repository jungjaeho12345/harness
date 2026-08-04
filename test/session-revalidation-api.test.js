// 세션 재검증 결선 테스트 (HTTP 레벨) — phase 52 step2.
// step1의 sessionGuard(매 요청 User 행 재조회)를 실제 인증 경로에 연결했는지 본다:
//   transport(sessionOf/GET /api/session/GET /api/stream)와 authorization 게이트가
//   **같은 재검증 경로**를 타야 하며, 한 갈래라도 빠지면 그 라우트만 옛 스냅샷 권한으로 남는다.
// 검증: 비활성화·역할 강등이 기존 세션에 즉시 반영(공격 1~6) + 정상 플로우 무손상(회귀 7~10).
// 조립은 test/server.test.js와 동형(createSchema → createSessionService → createControllers → createApp).
// SSE(/api/stream)는 응답이 끝나지 않으므로 node:http로 첫 청크만 읽고 끊는다(sse-auth.test.js 패턴).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

// injectSessionService:false — createApp에 세션 스토어를 넘기지 않고 조립한다.
// (transport가 controllers.auth를 통해서만 신원을 얻는지 확인하는 대조군)
async function start({ injectSessionService = true } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp(injectSessionService ? { controllers, sessionService } : { controllers });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, controllers, base, close: () => new Promise((r) => server.close(r)) };
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

// SSE GET — 200이면 첫 청크만 읽고 소켓을 끊는다(스트림은 스스로 끝나지 않는다).
function streamGet(base, path, { headers = {} } = {}) {
  const u = new URL(`${base}${path}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        const status = res.statusCode;
        res.setEncoding('utf8');
        if (status !== 200) {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => resolve({ status, chunk: buf }));
          return;
        }
        res.once('data', (chunk) => { req.destroy(); resolve({ status, chunk }); });
      },
    );
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}

const countRows = (db, table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
const contentsOf = (db, articleId) => db.prepare('SELECT * FROM Contents WHERE articleId = ?').get(articleId);

// --- 공격 시나리오 ---

test('[공격 1] 비활성화(active=N)된 사용자의 기존 세션은 즉시 차단된다 (GET /api/articles → 401)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    seedUser(ctx.db, { userId: 'admin', name: '관리자', role: 'Z', password: 'pw' });
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const zsid = (await login(ctx.base, 'admin', 'pw')).sessionId;

    // 비활성화 전에는 정상 통과한다(대조).
    assert.equal((await api(ctx.base, 'GET', '/api/articles', { sid: rsid })).status, 200);

    const off = await api(ctx.base, 'PUT', '/api/users/kim', { sid: zsid, body: { active: 'N' } });
    assert.equal(off.status, 200);

    const after = await api(ctx.base, 'GET', '/api/articles', { sid: rsid });
    assert.equal(after.status, 401, '비활성화 즉시 기존 세션은 차단돼야 한다');
    assert.equal(after.body.reason, 'unauthenticated');
  } finally { await ctx.close(); }
});

test('[공격 2] 비활성화된 세션의 신규 저장은 401이고 Article 행이 늘지 않는다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    seedUser(ctx.db, { userId: 'admin', name: '관리자', role: 'Z', password: 'pw' });
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const zsid = (await login(ctx.base, 'admin', 'pw')).sessionId;

    await api(ctx.base, 'PUT', '/api/users/kim', { sid: zsid, body: { active: 'N' } });
    const before = countRows(ctx.db, 'Article');

    const r = await api(ctx.base, 'POST', '/api/articles', {
      sid: rsid, body: { title: '유령기사', markupVersion: END_MARKUP },
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'unauthenticated');
    assert.equal(countRows(ctx.db, 'Article'), before, '차단된 세션은 행을 만들지 못한다');
    assert.equal(countRows(ctx.db, 'Contents'), before);
  } finally { await ctx.close(); }
});

test('[공격 3] D→R 강등된 세션은 force-unlock이 403이고 잠금이 유지된다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    seedUser(ctx.db, { userId: 'desk1', name: '데스크', role: 'D', department: '사회부', password: 'pw' });
    seedUser(ctx.db, { userId: 'admin', name: '관리자', role: 'Z', password: 'pw' });
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const dsid = (await login(ctx.base, 'desk1', 'pw')).sessionId;
    const zsid = (await login(ctx.base, 'admin', 'pw')).sessionId;

    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid: rsid, body: { title: '원제목', markupVersion: '{}' },
    })).body;
    assert.equal((await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid: rsid, clientId: 'tab-1' })).status, 200);

    // Z가 D를 R로 강등한다(세션은 그대로 살아 있다).
    assert.equal((await api(ctx.base, 'PUT', '/api/users/desk1', { sid: zsid, body: { role: 'R' } })).status, 200);

    const forced = await api(ctx.base, 'POST', `/api/articles/${articleId}/force-unlock`, { sid: dsid });
    assert.equal(forced.status, 403, '강등된 세션은 D 전용 강제 해제를 쓸 수 없다');
    assert.equal(forced.body.reason, 'forbidden');

    const row = contentsOf(ctx.db, articleId);
    assert.equal(row.lockYN, 'Y', '잠금은 유지돼야 한다');
    assert.equal(row.lockerUserId, 'kim');
  } finally { await ctx.close(); }
});

test('[공격 4] Z가 자기 자신을 R로 강등하면 이후 Z 전용 게이트(authorization)도 즉시 막힌다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'admin', name: '관리자', role: 'Z', password: 'pw' });
    const zsid = (await login(ctx.base, 'admin', 'pw')).sessionId;

    // 강등 요청 자체는 아직 Z이므로 통과한다.
    assert.equal((await api(ctx.base, 'PUT', '/api/users/admin', { sid: zsid, body: { role: 'R' } })).status, 200);

    const create = await api(ctx.base, 'POST', '/api/users', {
      sid: zsid, body: { userId: 'ghost', name: '유령', role: 'Z', password: 'pw' },
    });
    assert.equal(create.status, 403, 'authorization 게이트도 재검증 경로를 타야 한다');
    assert.equal(create.body.reason, 'forbidden');
    assert.equal(ctx.db.prepare('SELECT * FROM User WHERE userId = ?').get('ghost'), undefined);
  } finally { await ctx.close(); }
});

test('[공격 5] 비활성화로 죽은 토큰은 다시 active=Y로 되돌려도 부활하지 않는다(재로그인 필요)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    seedUser(ctx.db, { userId: 'admin', name: '관리자', role: 'Z', password: 'pw' });
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const zsid = (await login(ctx.base, 'admin', 'pw')).sessionId;

    await api(ctx.base, 'PUT', '/api/users/kim', { sid: zsid, body: { active: 'N' } });
    assert.equal((await api(ctx.base, 'GET', '/api/articles', { sid: rsid })).status, 401);

    await api(ctx.base, 'PUT', '/api/users/kim', { sid: zsid, body: { active: 'Y' } });
    assert.equal(
      (await api(ctx.base, 'GET', '/api/articles', { sid: rsid })).status, 401,
      '무효화된 토큰은 재활성화로 되살아나면 안 된다',
    );

    // 재로그인은 정상 동작한다.
    const again = await login(ctx.base, 'kim', 'pw');
    assert.equal(again.ok, true);
    assert.equal((await api(ctx.base, 'GET', '/api/articles', { sid: again.sessionId })).status, 200);
  } finally { await ctx.close(); }
});

test('[공격 6] 비활성 사용자의 SSE(/api/stream) 접속은 401이다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    seedUser(ctx.db, { userId: 'admin', name: '관리자', role: 'Z', password: 'pw' });
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const zsid = (await login(ctx.base, 'admin', 'pw')).sessionId;

    // 비활성화 전에는 스트림이 열린다(대조).
    const before = await streamGet(ctx.base, '/api/stream', { headers: { 'x-session-id': rsid } });
    assert.equal(before.status, 200);
    assert.match(before.chunk, /event: ready/);

    await api(ctx.base, 'PUT', '/api/users/kim', { sid: zsid, body: { active: 'N' } });

    const after = await streamGet(ctx.base, '/api/stream', { headers: { 'x-session-id': rsid } });
    assert.equal(after.status, 401, 'SSE 접속 시점 인증도 재검증 경로를 타야 한다');
  } finally { await ctx.close(); }
});

// --- 정상 플로우 무손상(회귀) ---

test('[회귀 7] 로그인 → 생성 → lock → 저장 → 송고 전 과정이 그대로 통과한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    const created = await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: '제목', markupVersion: END_MARKUP } });
    assert.equal(created.status, 200);
    const { articleId } = created.body;

    assert.equal((await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: 'tab-1' })).status, 200);
    const saved = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, {
      sid, clientId: 'tab-1', body: { title: '수정제목', markupVersion: END_MARKUP },
    });
    assert.equal(saved.status, 200);
    const sent = await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, { sid, body: { action: 'send' } });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);
    assert.equal(sent.body.status, 'RDS'); // R 송고 = RDS(기존 계약 그대로).
    assert.equal(contentsOf(ctx.db, articleId).status, 'RDS');
  } finally { await ctx.close(); }
});

test('[회귀 8] 권한과 무관한 정보(부서) 변경은 세션을 죽이지 않고 다음 요청부터 반영된다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', departmentCode: 'SOC', password: 'pw' });
    seedUser(ctx.db, { userId: 'admin', name: '관리자', role: 'Z', password: 'pw' });
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const zsid = (await login(ctx.base, 'admin', 'pw')).sessionId;

    await api(ctx.base, 'PUT', '/api/users/kim', {
      sid: zsid, body: { department: '경제부', departmentCode: 'ECO' },
    });

    // 세션은 살아 있고, 부서 stamp는 새 값으로 갱신된다.
    const created = await api(ctx.base, 'POST', '/api/articles', { sid: rsid, body: { title: 't', markupVersion: '{}' } });
    assert.equal(created.status, 200);
    const row = contentsOf(ctx.db, created.body.articleId);
    assert.equal(row.department, '경제부');
    assert.equal(row.departmentCode, 'ECO');
  } finally { await ctx.close(); }
});

test('[회귀 9] GET /api/session(F5 복원)은 정상 사용자에게 그대로 신원을 준다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    const r = await api(ctx.base, 'GET', '/api/session', { sid });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.user.userId, 'kim');
    assert.equal(r.body.user.role, 'R');
    assert.equal(r.body.user.password, undefined);
  } finally { await ctx.close(); }
});

test('[회귀 10] 로그인/로그아웃 왕복이 그대로 동작한다(로그아웃 후 401)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    assert.equal((await api(ctx.base, 'GET', '/api/articles', { sid })).status, 200);

    assert.equal((await api(ctx.base, 'POST', '/api/logout', { sid })).status, 200);
    assert.equal((await api(ctx.base, 'GET', '/api/articles', { sid })).status, 401);
    assert.equal((await api(ctx.base, 'GET', '/api/session', { sid })).status, 401);
  } finally { await ctx.close(); }
});

test('[결선] createApp에 세션 스토어를 넘기지 않아도 인증이 동작하고 재검증이 걸린다', async () => {
  const ctx = await start({ injectSessionService: false });
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    seedUser(ctx.db, { userId: 'admin', name: '관리자', role: 'Z', password: 'pw' });
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const zsid = (await login(ctx.base, 'admin', 'pw')).sessionId;

    // 신원은 controllers.auth 단일 경로에서만 나온다 — 스토어 주입 없이도 통과한다.
    assert.equal((await api(ctx.base, 'GET', '/api/articles', { sid: rsid })).status, 200);
    assert.equal((await api(ctx.base, 'GET', '/api/session', { sid: rsid })).status, 200);

    await api(ctx.base, 'PUT', '/api/users/kim', { sid: zsid, body: { active: 'N' } });
    assert.equal((await api(ctx.base, 'GET', '/api/articles', { sid: rsid })).status, 401);
  } finally { await ctx.close(); }
});
