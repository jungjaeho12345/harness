// HTTPS 강제(enforcement) transport 테스트 — step6.
// 강제는 운영(forceHttps:true)에서만: (a) HSTS 헤더 + (b) HTTP→HTTPS 리다이렉트.
// 토글 OFF(기본 false, 테스트/dev HTTP)에서는 미들웨어가 no-op이어야 한다(기존 전체 무회귀).
// 프록시 뒤 원 프로토콜은 X-Forwarded-Proto로 판정(trust proxy 최소). 앱은 TLS 종단을 하지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

async function start({ forceHttps } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp({ controllers, sessionService, forceHttps });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

// redirect:'manual' — 3xx Location을 따라가지 않고 그대로 본다.
async function raw(base, path, { method = 'GET', proto } = {}) {
  const headers = {};
  if (proto) headers['x-forwarded-proto'] = proto;
  return fetch(`${base}${path}`, { method, headers, redirect: 'manual' });
}

test('forceHttps 기본(false): HTTP 요청이 정상 처리된다(no-op, 무회귀)', async () => {
  const ctx = await start();
  try {
    const res = await raw(ctx.base, '/api/health');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    // HSTS는 HTTP dev에 보내면 안 된다(이후 접속이 깨질 수 있음).
    assert.equal(res.headers.get('strict-transport-security'), null);
  } finally { await ctx.close(); }
});

test('forceHttps:true + X-Forwarded-Proto:http → https로 3xx 리다이렉트(Location 헤더)', async () => {
  const ctx = await start({ forceHttps: true });
  try {
    const res = await raw(ctx.base, '/api/articles', { proto: 'http' });
    assert.ok(res.status >= 300 && res.status < 400, `리다이렉트 3xx 기대, 실제 ${res.status}`);
    const loc = res.headers.get('location');
    assert.ok(loc, 'Location 헤더가 있어야 한다');
    assert.match(loc, /^https:\/\//);
    assert.match(loc, /\/api\/articles$/); // 동일 경로 보존.
  } finally { await ctx.close(); }
});

test('forceHttps:true + X-Forwarded-Proto:https → 정상 처리 + Strict-Transport-Security 헤더', async () => {
  const ctx = await start({ forceHttps: true });
  try {
    const res = await raw(ctx.base, '/api/health', { proto: 'https' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    const hsts = res.headers.get('strict-transport-security');
    assert.ok(hsts, 'HSTS 헤더가 있어야 한다');
    assert.match(hsts, /max-age=\d+/);
  } finally { await ctx.close(); }
});

test('forceHttps:true: CORS preflight(OPTIONS)가 리다이렉트로 깨지지 않는다', async () => {
  const ctx = await start({ forceHttps: true });
  try {
    const res = await fetch(`${ctx.base}/api/articles`, {
      method: 'OPTIONS',
      headers: {
        'x-forwarded-proto': 'http',
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
      redirect: 'manual',
    });
    // preflight는 리다이렉트(3xx)가 아니라 CORS 응답(2xx)이어야 한다.
    assert.ok(res.status < 300, `preflight는 리다이렉트되면 안 된다, 실제 ${res.status}`);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  } finally { await ctx.close(); }
});

test('forceHttps:true + X-Forwarded-Proto:https: /api/health가 깨지지 않는다', async () => {
  const ctx = await start({ forceHttps: true });
  try {
    const res = await raw(ctx.base, '/api/health', { proto: 'https' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  } finally { await ctx.close(); }
});
