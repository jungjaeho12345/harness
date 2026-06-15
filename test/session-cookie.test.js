// 세션 쿠키 transport 테스트 (security-hardening step0).
// 검증: 로그인 응답에 HttpOnly 세션 쿠키 Set-Cookie, 쿠키만으로 인증 통과(헤더 없이),
// 헤더(x-session-id) 하위호환 유지, 둘 다 없으면 401, logout 시 쿠키 만료(clearCookie),
// req.body.role 위조 무력화(세션 신원에서만 role 도출), 쿠키 옵션의 env 분기(secure/sameSite).
// 세션 스토어/도메인 로직/DB는 무변경 — transport(server/index.js)만 본다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp, sessionCookieOptions, SESSION_COOKIE_NAME } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

async function start() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp({ controllers, sessionService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, controllers, base, close: () => new Promise((r) => server.close(r)) };
}

function seedUser(db, user) {
  createUserModel(db).insert({ active: 'Y', ...user, password: bcrypt.hashSync(user.password, 10) });
}

// raw fetch 래퍼 — Set-Cookie 헤더와 cookie 송신을 직접 다룬다.
async function req(base, method, path, { headers = {}, body, cookie } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  const res = await fetch(`${base}${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, body: json, setCookie: res.headers.getSetCookie?.() ?? [] };
}

// Set-Cookie 배열에서 세션 쿠키 한 줄 추출.
function findSessionCookie(setCookie) {
  return setCookie.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
}

// Set-Cookie 한 줄에서 "name=value"만 추려 다시 보낼 Cookie 헤더로.
function cookieHeaderFrom(setCookieLine) {
  return setCookieLine.split(';')[0];
}

test('로그인 성공 응답에 HttpOnly 세션 쿠키가 Set-Cookie로 내려온다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const r = await req(ctx.base, 'POST', '/api/login', { body: { userId: 'kim', password: 'pw' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    // body shape 하위호환 유지.
    assert.match(r.body.sessionId, /^[0-9a-f]{64}$/);

    const sc = findSessionCookie(r.setCookie);
    assert.ok(sc, 'session cookie should be set');
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=/i);
    assert.match(sc, /Path=\//i);
    // 쿠키값은 발급된 sessionId와 동일.
    assert.match(sc, new RegExp(`^${SESSION_COOKIE_NAME}=${r.body.sessionId}`));
  } finally { await ctx.close(); }
});

test('쿠키만으로(헤더 없이) 보호 라우트 인증을 통과한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const login = await req(ctx.base, 'POST', '/api/login', { body: { userId: 'kim', password: 'pw' } });
    const cookie = cookieHeaderFrom(findSessionCookie(login.setCookie));

    const articles = await req(ctx.base, 'GET', '/api/articles', { cookie });
    assert.equal(articles.status, 200);
    assert.equal(articles.body.ok, true);

    const session = await req(ctx.base, 'GET', '/api/session', { cookie });
    assert.equal(session.status, 200);
    assert.equal(session.body.user.userId, 'kim');
  } finally { await ctx.close(); }
});

test('헤더(x-session-id) 하위호환: 쿠키 없이 헤더만으로도 인증 통과', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const login = await req(ctx.base, 'POST', '/api/login', { body: { userId: 'kim', password: 'pw' } });
    const sid = login.body.sessionId;

    const articles = await req(ctx.base, 'GET', '/api/articles', { headers: { 'x-session-id': sid } });
    assert.equal(articles.status, 200);
    assert.equal(articles.body.ok, true);
  } finally { await ctx.close(); }
});

test('쿠키 우선: 쿠키와 헤더가 다르면 쿠키 세션이 신원을 결정한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    seedUser(ctx.db, { userId: 'lee', role: 'D', department: '편집부', password: 'pw' });
    const kimLogin = await req(ctx.base, 'POST', '/api/login', { body: { userId: 'kim', password: 'pw' } });
    const leeLogin = await req(ctx.base, 'POST', '/api/login', { body: { userId: 'lee', password: 'pw' } });
    const kimCookie = cookieHeaderFrom(findSessionCookie(kimLogin.setCookie));

    // 쿠키=kim, 헤더=lee → 쿠키 우선이면 kim.
    const session = await req(ctx.base, 'GET', '/api/session', {
      cookie: kimCookie, headers: { 'x-session-id': leeLogin.body.sessionId },
    });
    assert.equal(session.status, 200);
    assert.equal(session.body.user.userId, 'kim');
  } finally { await ctx.close(); }
});

test('쿠키·헤더 둘 다 없으면 401', async () => {
  const ctx = await start();
  try {
    const r = await req(ctx.base, 'GET', '/api/articles');
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'unauthenticated');
  } finally { await ctx.close(); }
});

test('logout: 세션 무효화 + Set-Cookie로 쿠키 만료(clearCookie)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const login = await req(ctx.base, 'POST', '/api/login', { body: { userId: 'kim', password: 'pw' } });
    const cookie = cookieHeaderFrom(findSessionCookie(login.setCookie));

    const out = await req(ctx.base, 'POST', '/api/logout', { cookie });
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    const cleared = findSessionCookie(out.setCookie);
    assert.ok(cleared, 'logout should emit a Set-Cookie to clear session cookie');
    // clearCookie는 만료된 쿠키(Expires 과거 또는 Max-Age=0)를 내린다.
    assert.match(cleared, /Expires=Thu, 01 Jan 1970|Max-Age=0/i);

    // 무효화 후 같은 쿠키로 재접근은 401.
    const after = await req(ctx.base, 'GET', '/api/articles', { cookie });
    assert.equal(after.status, 401);
  } finally { await ctx.close(); }
});

test('req.body.role 위조는 무력화된다: 쿠키 세션의 role(R)로 처리된다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const login = await req(ctx.base, 'POST', '/api/login', { body: { userId: 'kim', password: 'pw' } });
    const cookie = cookieHeaderFrom(findSessionCookie(login.setCookie));
    const end = JSON.stringify({
      format: 'yh-editor', version: 1,
      blocks: [{ type: 'text', text: '제목' }, { type: 'text', text: '본문' }, { type: 'text', text: '(끝)' }],
    });
    const created = await req(ctx.base, 'POST', '/api/articles', { cookie, body: { title: 't', markupVersion: end } });
    const { articleId } = created.body;

    // role='D' 위조 시도 → 세션 role R로 처리되어 RDS.
    const acted = await req(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      cookie, body: { action: 'send', role: 'D' },
    });
    assert.equal(acted.status, 200);
    assert.equal(acted.body.status, 'RDS');
  } finally { await ctx.close(); }
});

test('sessionCookieOptions: production에서만 secure=true + SameSite=None', () => {
  const prod = sessionCookieOptions('production');
  assert.equal(prod.httpOnly, true);
  assert.equal(prod.secure, true);
  assert.equal(prod.sameSite, 'none');
  assert.equal(prod.path, '/');
  assert.equal(prod.maxAge, 60 * 60 * 1000);

  for (const env of ['development', 'test', undefined]) {
    const local = sessionCookieOptions(env);
    assert.equal(local.httpOnly, true);
    assert.equal(local.secure, false, `secure must be false for env=${env}`);
    assert.equal(local.sameSite, 'lax', `sameSite must be lax for env=${env}`);
    assert.equal(local.path, '/');
  }
});
