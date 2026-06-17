// 기사 본문(markupVersion)에 인라인 이미지(base64) 등으로 100kb를 넘는 본문이 와도
// 생성(POST)·수정(PUT)이 거부되지 않아야 한다(송고 안 됨 버그 — 전역 JSON 파서 100kb 한도).
// 단 비-기사 라우트(예: 로그인)는 기존 작은 한도를 유지한다(보호 면적 무회귀).
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
  return { db, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
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
  let json; try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, body: json };
}
const login = async (ctx) => (await api(ctx.base, 'POST', '/api/login', { body: { userId: 'kim', password: 'pw' } })).body;

// 100kb를 확실히 넘는 본문(인라인 base64 이미지 모사 ~300KB).
function bigBody() {
  const bigImg = `data:image/png;base64,${'A'.repeat(300 * 1024)}`;
  return JSON.stringify({
    format: 'yh-editor', version: 1,
    blocks: [
      { type: 'text', text: '헤드라인' },
      { type: 'embed', embedType: 'image', src: bigImg },
      { type: 'text', text: '(끝)' },
    ],
  });
}

test('POST /api/articles: 100kb 초과 본문(인라인 이미지)도 생성된다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx)).sessionId;
    const r = await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: '헤드라인', markupVersion: bigBody() } });
    assert.equal(r.status, 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    assert.match(r.body.articleId, /^AKR\d{17}$/);
  } finally { await ctx.close(); }
});

test('PUT /api/articles/:id: 100kb 초과 본문으로 수정된다(잠금 보유자)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx)).sessionId;
    const created = await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: '{}' } });
    const { articleId } = created.body;
    // 잠금 보유자만 PUT 가능 — 같은 clientId(x-edit-client)로 lock 획득 후 PUT.
    const clientId = 'c-test-1';
    await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId, body: { action: 'revise' } });
    const r = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, { sid, clientId, body: { markupVersion: bigBody() } });
    assert.equal(r.status, 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  } finally { await ctx.close(); }
});

test('비-기사 라우트(로그인)는 작은 한도를 유지한다(큰 본문 거부)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const big = 'A'.repeat(300 * 1024);
    const r = await api(ctx.base, 'POST', '/api/login', { body: { userId: 'kim', password: 'pw', junk: big } });
    assert.notEqual(r.status, 200, '로그인 라우트는 100kb 초과 본문을 받지 않아야 한다');
  } finally { await ctx.close(); }
});
