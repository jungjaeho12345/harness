// 사진DB transport 테스트 — POST /api/photos(등록) + GET /api/photos/search(캡션 검색).
// 계약: 두 라우트 모두 세션 게이트(로그인만 — 이미지/글기사 검색과 동형, 역할 게이트 없음).
//   등록: 200 { ok, id } / 부적격 src 400 invalid-src / 미인증 401.
// CRITICAL(ADR-004): registeredBy는 세션에서만 도출 — body의 registeredBy는 무시된다.

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

async function start() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp({ controllers, sessionService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
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

async function login(base, userId, password) {
  return (await api(base, 'POST', '/api/login', { body: { userId, password } })).body;
}

test('photos: 미인증 POST /api/photos → 401 unauthenticated', async () => {
  const ctx = await start();
  try {
    const r = await api(ctx.base, 'POST', '/api/photos', {
      body: { src: '/uploads/a.png', caption: '캡션' },
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'unauthenticated');
  } finally { await ctx.close(); }
});

test('photos: 미인증 GET /api/photos/search → 401 unauthenticated', async () => {
  const ctx = await start();
  try {
    const r = await api(ctx.base, 'GET', '/api/photos/search?q=x');
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'unauthenticated');
  } finally { await ctx.close(); }
});

test('photos: 인증 + 유효 src 등록 → 200 { ok, id }, 검색으로 재조회된다 (풀 루프)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    const reg = await api(ctx.base, 'POST', '/api/photos', {
      sid, body: { src: '/uploads/a.png', caption: '광화문 야경', sourceArticleId: 'AKR1' },
    });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.ok, true);
    assert.equal(typeof reg.body.id, 'number');

    const found = await api(ctx.base, 'GET', '/api/photos/search?q=%EA%B4%91%ED%99%94%EB%AC%B8', { sid });
    assert.equal(found.status, 200);
    assert.equal(found.body.ok, true);
    assert.equal(found.body.items.length, 1);
    assert.equal(found.body.items[0].id, reg.body.id);
    assert.equal(found.body.items[0].src, '/uploads/a.png');
    assert.equal(found.body.items[0].sourceArticleId, 'AKR1');
  } finally { await ctx.close(); }
});

test('photos: registeredBy는 세션 사용자로 저장 — body의 registeredBy는 무시된다 (ADR-004)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    const reg = await api(ctx.base, 'POST', '/api/photos', {
      sid, body: { src: 'https://cdn/x.png', caption: '위조시도', registeredBy: 'attacker' },
    });
    assert.equal(reg.status, 200);

    const found = await api(ctx.base, 'GET', '/api/photos/search?q=%EC%9C%84%EC%A1%B0', { sid });
    assert.equal(found.body.items[0].registeredBy, 'kim', '세션 userId가 이긴다');
  } finally { await ctx.close(); }
});

test('photos: 부적격 src(javascript:/data:/http:) 등록 → 400 invalid-src, 검색 결과에 없다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    for (const src of ['javascript:alert(1)', 'data:image/png;base64,AAA', 'http://x/y.png']) {
      const r = await api(ctx.base, 'POST', '/api/photos', {
        sid, body: { src, caption: '위험캡션' },
      });
      assert.equal(r.status, 400, `${src} → 400`);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.reason, 'invalid-src');
    }

    const found = await api(ctx.base, 'GET', '/api/photos/search?q=%EC%9C%84%ED%97%98', { sid });
    assert.deepEqual(found.body.items, [], '거부된 src는 DB에 저장되지 않는다');
  } finally { await ctx.close(); }
});
