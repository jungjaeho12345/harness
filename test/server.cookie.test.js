// 쿠키 세션 transport 테스트 — 세션 토큰을 HttpOnly/SameSite/(조건부)Secure 쿠키로 운반한다.
// step3: /api/login Set-Cookie 발급, 요청에서 쿠키 우선→x-session-id 헤더 폴백, /api/logout 쿠키 만료.
// sessionService(세션 스토어/발급)는 수정하지 않는다 — 운반 수단만 추가. 헤더 폴백 유지로 무회귀.

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

async function start({ cookieSecure } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp({ controllers, sessionService, cookieSecure });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
}

function seedUser(db, user) {
  createUserModel(db).insert({ active: 'Y', ...user, password: bcrypt.hashSync(user.password, 10) });
}

// 단순 Set-Cookie 파서 — sid 쿠키 값을 추출한다(없으면 undefined).
function sidFromSetCookie(setCookie) {
  if (!setCookie) return undefined;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) {
    const m = /^sid=([^;]*)/.exec(c);
    if (m) return decodeURIComponent(m[1]);
  }
  return undefined;
}

function sidCookieHeader(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return sc.find((c) => c && c.startsWith('sid='));
}

test('로그인 성공 응답에 HttpOnly·SameSite 세션 쿠키가 발급된다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw1234' });
    const res = await fetch(`${ctx.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'kim', password: 'pw1234' }),
    });
    const cookie = sidCookieHeader(res);
    assert.ok(cookie, 'Set-Cookie에 sid 쿠키가 있어야 한다');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=/i);
    assert.match(cookie, /Path=\//i);
    // 쿠키 값이 64 hex 세션 토큰과 일치.
    const body = await res.json();
    assert.equal(sidFromSetCookie(cookie), body.sessionId);
    assert.match(body.sessionId, /^[0-9a-f]{64}$/);
  } finally { await ctx.close(); }
});

test('발급된 쿠키만으로(헤더 없이) 보호 라우트에 인증된다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw1234' });
    const loginRes = await fetch(`${ctx.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'kim', password: 'pw1234' }),
    });
    const cookie = sidCookieHeader(loginRes);
    const sid = sidFromSetCookie(cookie);

    // x-session-id 헤더 없이 Cookie 헤더만 보낸다.
    const list = await fetch(`${ctx.base}/api/articles`, {
      headers: { cookie: `sid=${sid}` },
    });
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.ok, true);
  } finally { await ctx.close(); }
});

test('쿠키가 헤더보다 우선하지만 헤더 폴백은 유지된다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw1234' });
    const loginRes = await fetch(`${ctx.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'kim', password: 'pw1234' }),
    });
    const sid = sidFromSetCookie(sidCookieHeader(loginRes));

    // 헤더 폴백(쿠키 없이 x-session-id만)도 여전히 동작.
    const headerOnly = await fetch(`${ctx.base}/api/articles`, {
      headers: { 'x-session-id': sid },
    });
    assert.equal(headerOnly.status, 200);

    // 쿠키 우선: 유효 쿠키 + 무효 헤더 → 쿠키로 인증.
    const both = await fetch(`${ctx.base}/api/articles`, {
      headers: { cookie: `sid=${sid}`, 'x-session-id': 'deadbeef' },
    });
    assert.equal(both.status, 200);
  } finally { await ctx.close(); }
});

test('/api/session F5 복원: 쿠키만으로 신원 복원', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw1234' });
    const loginRes = await fetch(`${ctx.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'kim', password: 'pw1234' }),
    });
    const sid = sidFromSetCookie(sidCookieHeader(loginRes));
    const sres = await fetch(`${ctx.base}/api/session`, { headers: { cookie: `sid=${sid}` } });
    assert.equal(sres.status, 200);
    const body = await sres.json();
    assert.equal(body.ok, true);
    assert.equal(body.user.userId, 'kim');
  } finally { await ctx.close(); }
});

test('/api/logout: 세션 무효화 + 쿠키 만료(Max-Age=0)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw1234' });
    const loginRes = await fetch(`${ctx.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'kim', password: 'pw1234' }),
    });
    const sid = sidFromSetCookie(sidCookieHeader(loginRes));

    const logoutRes = await fetch(`${ctx.base}/api/logout`, {
      method: 'POST',
      headers: { cookie: `sid=${sid}` },
    });
    assert.equal(logoutRes.status, 200);
    const clearCookie = sidCookieHeader(logoutRes);
    assert.ok(clearCookie, 'logout 응답에 sid Set-Cookie가 있어야 한다');
    assert.match(clearCookie, /Max-Age=0/i);

    // 세션이 실제로 무효화되어 쿠키로 접근 불가.
    const after = await fetch(`${ctx.base}/api/articles`, { headers: { cookie: `sid=${sid}` } });
    assert.equal(after.status, 401);
  } finally { await ctx.close(); }
});

test('cookieSecure=false(테스트/dev)에서는 Secure 속성이 빠진다', async () => {
  const ctx = await start({ cookieSecure: false });
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw1234' });
    const res = await fetch(`${ctx.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'kim', password: 'pw1234' }),
    });
    const cookie = sidCookieHeader(res);
    assert.doesNotMatch(cookie, /Secure/i);
  } finally { await ctx.close(); }
});

test('cookieSecure=true(프로덕션)에서는 Secure 속성이 붙는다', async () => {
  const ctx = await start({ cookieSecure: true });
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw1234' });
    const res = await fetch(`${ctx.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'kim', password: 'pw1234' }),
    });
    const cookie = sidCookieHeader(res);
    assert.match(cookie, /Secure/i);
  } finally { await ctx.close(); }
});
