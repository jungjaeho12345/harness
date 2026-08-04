// CSRF Origin/Referer 가드 transport 테스트 (phase 52 step0, ADR-009).
// 검증: 상태 변경 메서드(비 GET/HEAD/OPTIONS)에서 교차 출처 Origin/Referer는 403 + 부수효과 0,
//       자기 출처·ALLOWED_ORIGINS·비프로덕션 loopback은 통과, Origin·Referer 부재(서버-서버/cron)는 통과,
//       읽기(GET)·preflight(OPTIONS)는 대상 밖, X-Forwarded-Host 스푸핑으로 자기 출처를 위장할 수 없음.
// env(NODE_ENV)와 출처 목록(origins)은 createApp에 주입한다 — 전역 process.env에 의존하지 않는다
// (test/https-enforcement.test.js와 동일 규약). 세션/도메인/DB는 무변경 — transport(server/index.js)만 본다.
//
// 프로덕션 앱 전제: env:'production'이면 trust proxy=1 + 평문→https 308 리다이렉트가 CSRF 가드보다 앞에 선다.
// 따라서 프로덕션 앱을 쓰는 모든 요청에 x-forwarded-proto: https를 싣는다(안 실으면 가드가 아니라 리다이렉트를 측정한다).

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
import { createApp, allowedOrigins, SESSION_COOKIE_NAME } from '../server/index.js';

// media 분기용 기본 env(API 키) — NODE_ENV와는 별개 축이다.
const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

// 송고(send)가 도메인 규칙(끝 표시)까지 통과하도록 종료 마커가 있는 본문을 쓴다 —
// 그래야 "403은 가드 때문이고, 같은 요청이 Origin만 없으면 실제로 성사된다"가 성립한다.
const END_MARKUP = JSON.stringify({
  format: 'yh-editor', version: 1,
  blocks: [{ type: 'text', text: '제목' }, { type: 'text', text: '본문' }, { type: 'text', text: '(끝)' }],
});

const PROD_HOST = 'app.example';
const EVIL_ORIGIN = 'https://evil.example';

// env(NODE_ENV)·origins(허용 출처 목록)를 주입해 createApp을 띄운다.
async function start({ env, origins } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp({ controllers, sessionService, env, origins });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
}

function seedUser(db, user) {
  createUserModel(db).insert({ active: 'Y', ...user, password: bcrypt.hashSync(user.password, 10) });
}

// node:http.request 기반 raw 요청 — fetch가 금지 헤더로 막는 Host/Origin/Referer를 그대로 보낸다.
async function rawFetch(base, method, path, { headers = {}, body } = {}) {
  const u = new URL(`${base}${path}`);
  const h = { ...headers };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
    h['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: res.statusCode, body: json, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// 프로덕션 앱용 기본 헤더(리다이렉트 회피 + 자기 출처 판정의 Host 고정).
function prod(extra = {}) {
  return { host: PROD_HOST, 'x-forwarded-proto': 'https', ...extra };
}

// 로그인은 Origin 없이 수행한다(가드 대상 밖) → 브라우저가 자동 첨부하는 쿠키를 모사할 Cookie 헤더를 만든다.
async function loginCookie(base, headers, userId, password) {
  const r = await rawFetch(base, 'POST', '/api/login', { headers, body: { userId, password } });
  assert.equal(r.status, 200, '로그인 자체는 성공해야 한다(Origin 부재 = 가드 통과)');
  return `${SESSION_COOKIE_NAME}=${r.body.sessionId}`;
}

const statusOf = (db, articleId) => db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status;
const lockOf = (db, articleId) => db.prepare('SELECT lockYN FROM Contents WHERE articleId = ?').get(articleId).lockYN;

// --- allowedOrigins: cors 옵션과 CSRF 가드가 공유하는 단일 출처 ---
test('allowedOrigins: 기본값은 오늘의 CORS allowlist와 동일하다', () => {
  assert.deepEqual(allowedOrigins({}), ['http://localhost:5173', 'http://127.0.0.1:5173']);
  // 인자 미주입(process.env)도 기본 두 항목을 항상 포함한다.
  for (const o of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
    assert.ok(allowedOrigins().includes(o), `${o} must stay in the default allowlist`);
  }
});

test('allowedOrigins: ALLOWED_ORIGINS(콤마 구분)를 트림·빈 값 제외 후 append 한다', () => {
  const list = allowedOrigins({ ALLOWED_ORIGINS: ' https://a.example , , https://b.example ' });
  assert.deepEqual(list, [
    'http://localhost:5173', 'http://127.0.0.1:5173',
    'https://a.example', 'https://b.example',
  ]);
});

// --- 공격 시나리오 (프로덕션) ---
test('1) 프로덕션: 교차 출처 Origin의 POST /action은 403 forbidden-origin이고 status가 바뀌지 않는다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;
    assert.equal(statusOf(ctx.db, articleId), 'RDS');

    const attack = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, origin: EVIL_ORIGIN }), body: { action: 'send' },
    });
    assert.equal(attack.status, 403);
    assert.deepEqual(attack.body, { ok: false, reason: 'forbidden-origin' });
    assert.equal(statusOf(ctx.db, articleId), 'RDS', '거부된 요청은 부수효과가 없어야 한다');

    // 동일 요청이 Origin만 없으면 성공한다 = 막힌 원인이 가드임을 확인(양성 대조).
    const legit = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie }), body: { action: 'send' },
    });
    assert.equal(legit.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('2) 프로덕션: 본문 없는 POST /force-unlock도 교차 출처면 403이고 잠금이 유지된다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;
    await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/lock`, {
      headers: prod({ cookie, 'x-edit-client': 'tab-1' }),
    });
    assert.equal(lockOf(ctx.db, articleId), 'Y');

    const attack = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/force-unlock`, {
      headers: prod({ cookie, origin: EVIL_ORIGIN }),
    });
    assert.equal(attack.status, 403);
    assert.equal(attack.body.reason, 'forbidden-origin');
    assert.equal(lockOf(ctx.db, articleId), 'Y', '거부된 강제 해제는 잠금을 풀지 않는다');

    const legit = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/force-unlock`, {
      headers: prod({ cookie }),
    });
    assert.equal(legit.status, 200);
    assert.equal(lockOf(ctx.db, articleId), 'N');
  } finally { await ctx.close(); }
});

test('3) 프로덕션: Origin: null(익명화된 교차 출처)은 403', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, origin: 'null' }), body: { action: 'send' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, 'forbidden-origin');
    assert.equal(statusOf(ctx.db, articleId), 'RDS');
  } finally { await ctx.close(); }
});

test('4) 프로덕션: Origin 없이 교차 출처 Referer만 있어도 403', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, referer: 'https://evil.example/x' }), body: { action: 'send' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, 'forbidden-origin');
    assert.equal(statusOf(ctx.db, articleId), 'RDS');
  } finally { await ctx.close(); }
});

test('5) 프로덕션: 파싱 불가능한 Referer(Origin 없음)는 403', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, referer: 'not-a-url' }), body: { action: 'send' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, 'forbidden-origin');
    assert.equal(statusOf(ctx.db, articleId), 'RDS');
  } finally { await ctx.close(); }
});

// --- 정상 플로우 무손상 ---
test('6) Origin·Referer가 둘 다 없는 상태 변경(서버-서버·cron·기존 테스트 스타일)은 통과한다', async () => {
  const ctx = await start(); // 비프로덕션 기본 앱 = 기존 테스트와 동일 구성.
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, {}, 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: { cookie }, body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: { cookie }, body: { action: 'send' },
    });
    assert.equal(r.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('7) 비프로덕션: 포트가 밀린 loopback Origin(localhost:5174)도 통과한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, {}, 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: { cookie }, body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: { cookie, origin: 'http://localhost:5174' }, body: { action: 'send' },
    });
    assert.equal(r.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('8) 비프로덕션: 127.0.0.1 loopback Origin도 통과한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, {}, 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: { cookie }, body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: { cookie, origin: 'http://127.0.0.1:5173' }, body: { action: 'send' },
    });
    assert.equal(r.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('9) 프로덕션: 자기 출처(https://app.example) 상태 변경은 통과한다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, origin: `https://${PROD_HOST}` }), body: { action: 'send' },
    });
    assert.equal(r.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('10) 프로덕션: 읽기(GET)는 교차 출처 Origin이어도 이 미들웨어의 대상이 아니다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');

    const r = await rawFetch(ctx.base, 'GET', '/api/articles', {
      headers: prod({ cookie, origin: EVIL_ORIGIN }),
    });
    assert.equal(r.status, 200, '응답 노출 차단은 CORS 책임 — 가드는 상태 변경 메서드만 본다');
    assert.equal(r.body.ok, true);
  } finally { await ctx.close(); }
});

test('11) 프로덕션: CORS preflight(OPTIONS)는 가드의 영향을 받지 않는다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    const r = await rawFetch(ctx.base, 'OPTIONS', '/api/articles', {
      headers: prod({ origin: EVIL_ORIGIN, 'access-control-request-method': 'POST' }),
    });
    assert.ok(r.status < 300, `preflight는 403이면 안 된다, 실제 ${r.status}`);
    assert.equal(r.headers['access-control-allow-origin'], undefined, '미허용 출처엔 ACAO를 주지 않는다');
  } finally { await ctx.close(); }
});

test('12) ALLOWED_ORIGINS로 등록한 출처는 프로덕션에서도 통과한다(미등록이면 403)', async () => {
  const spa = 'https://spa.example';
  const ctx = await start({ env: 'production', origins: allowedOrigins({ ALLOWED_ORIGINS: spa }) });
  const plain = await start({ env: 'production' }); // 기본 allowlist(오늘과 동일) — 대조군.
  try {
    for (const c of [ctx, plain]) {
      seedUser(c.db, { userId: 'desk', role: 'D', password: 'pw' });
    }
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const allowed = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, origin: spa }), body: { action: 'send' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');

    // 같은 출처가 미등록 앱에서는 거부된다.
    const plainCookie = await loginCookie(plain.base, prod(), 'desk', 'pw');
    const plainCreated = await rawFetch(plain.base, 'POST', '/api/articles', {
      headers: prod({ cookie: plainCookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const denied = await rawFetch(plain.base, 'POST', `/api/articles/${plainCreated.body.articleId}/action`, {
      headers: prod({ cookie: plainCookie, origin: spa }), body: { action: 'send' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'forbidden-origin');
  } finally {
    await ctx.close();
    await plain.close();
  }
});

test('13) 프로덕션: X-Forwarded-Host 스푸핑으로 자기 출처 판정을 통과시킬 수 없다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, origin: EVIL_ORIGIN, 'x-forwarded-host': 'evil.example' }),
      body: { action: 'send' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, 'forbidden-origin');
    assert.equal(statusOf(ctx.db, articleId), 'RDS');
  } finally { await ctx.close(); }
});
