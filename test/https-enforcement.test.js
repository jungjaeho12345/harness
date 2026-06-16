// HTTPS 강제 transport 테스트 (security-hardening step1).
// 검증: 비프로덕션(기본)은 평문 http 무영향(리다이렉트 없음), 프로덕션은 평문→https 308 리다이렉트 + HSTS 헤더.
// env는 createApp/enforceHttps에 주입(전역 process.env 비의존 — sessionService now 주입 패턴과 일관).
// 실제 TLS는 띄우지 않는다(단위 수준 — X-Forwarded-Proto로 프록시 뒤 평문/암호화를 모사, trust proxy=1 신뢰).
// transport(server/index.js)만 본다 — 세션/도메인/DB는 무변경.

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
import { createApp, enforceHttps } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

// env(NODE_ENV)를 주입해 createApp을 띄운다 — 기본은 비프로덕션.
async function start({ env } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp({ controllers, sessionService, env });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, controllers, base, close: () => new Promise((r) => server.close(r)) };
}

function seedUser(db, user) {
  createUserModel(db).insert({ active: 'Y', ...user, password: bcrypt.hashSync(user.password, 10) });
}

// redirect 추적을 끈 raw 요청 — 3xx 응답을 그대로 본다.
// node:http.request 사용 — fetch는 Host를 금지 헤더로 무시하므로, 프록시 뒤 임의 Host를
// 모사하려면 저수준 클라이언트가 필요하다(리다이렉트 Location의 Host 보존 검증).
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
        res.resume(); // 바디는 버린다
        resolve({
          status: res.statusCode,
          location: res.headers.location ?? null,
          hsts: res.headers['strict-transport-security'] ?? null,
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// --- enforceHttps 단위 분기 (env 경계) ---
test('enforceHttps: 비프로덕션 env는 no-op 미들웨어(next 호출, 응답 미변경)를 반환한다', () => {
  for (const env of ['development', 'test', undefined]) {
    const mw = enforceHttps(env);
    let nexted = false;
    let touched = false;
    const res = {
      redirect() { touched = true; },
      status() { touched = true; return this; },
      end() { touched = true; },
    };
    mw({ secure: false, method: 'GET', get: () => 'http' }, res, () => { nexted = true; });
    assert.equal(nexted, true, `env=${env} should pass through`);
    assert.equal(touched, false, `env=${env} should not redirect/reject`);
  }
});

// --- 비프로덕션 회귀 가드 (로컬/테스트 무영향) ---
test('비프로덕션: 평문 GET은 리다이렉트 없이 200 (X-Forwarded-Proto: http여도 무영향)', async () => {
  const ctx = await start();
  try {
    const r = await rawFetch(ctx.base, 'GET', '/api/health', { headers: { 'x-forwarded-proto': 'http' } });
    assert.equal(r.status, 200);
    assert.equal(r.location, null);
  } finally { await ctx.close(); }
});

test('비프로덕션: HSTS 헤더가 없다(https 강제 비활성)', async () => {
  const ctx = await start();
  try {
    const r = await rawFetch(ctx.base, 'GET', '/api/health');
    assert.equal(r.hsts, null);
  } finally { await ctx.close(); }
});

// --- 프로덕션: 평문 → https 리다이렉트 ---
test('프로덕션: X-Forwarded-Proto=http GET은 동일 경로 https로 308 리다이렉트', async () => {
  const ctx = await start({ env: 'production' });
  try {
    const r = await rawFetch(ctx.base, 'GET', '/api/articles?foo=bar', {
      headers: { 'x-forwarded-proto': 'http', host: 'example.com' },
    });
    assert.equal(r.status, 308);
    assert.equal(r.location, 'https://example.com/api/articles?foo=bar');
  } finally { await ctx.close(); }
});

test('프로덕션: X-Forwarded-Proto=https GET은 통과(리다이렉트 없음)', async () => {
  const ctx = await start({ env: 'production' });
  try {
    const r = await rawFetch(ctx.base, 'GET', '/api/health', {
      headers: { 'x-forwarded-proto': 'https', host: 'example.com' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.location, null);
  } finally { await ctx.close(); }
});

test('프로덕션: 비-GET 평문(POST)도 308로 리다이렉트(메서드·바디 보존)', async () => {
  const ctx = await start({ env: 'production' });
  try {
    const r = await rawFetch(ctx.base, 'POST', '/api/login', {
      headers: { 'x-forwarded-proto': 'http', host: 'example.com' },
      body: { userId: 'x', password: 'y' },
    });
    assert.equal(r.status, 308);
    assert.equal(r.location, 'https://example.com/api/login');
  } finally { await ctx.close(); }
});

// --- 프로덕션 HSTS ---
test('프로덕션: https 응답에 Strict-Transport-Security 헤더가 있다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    const r = await rawFetch(ctx.base, 'GET', '/api/health', {
      headers: { 'x-forwarded-proto': 'https', host: 'example.com' },
    });
    assert.equal(r.status, 200);
    assert.ok(r.hsts, 'HSTS header should be present');
    assert.match(r.hsts, /max-age=\d+/i);
  } finally { await ctx.close(); }
});

// --- 프로덕션: 인증 흐름 무회귀 (https 요청은 도메인 로직까지 정상 도달) ---
test('프로덕션: https로 온 요청은 로그인/세션 인증이 정상 동작한다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const login = await fetch(`${ctx.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', host: 'example.com' },
      body: JSON.stringify({ userId: 'kim', password: 'pw' }),
      redirect: 'manual',
    });
    assert.equal(login.status, 200);
    const body = await login.json();
    assert.equal(body.ok, true);
    assert.match(body.sessionId, /^[0-9a-f]{64}$/);
  } finally { await ctx.close(); }
});
