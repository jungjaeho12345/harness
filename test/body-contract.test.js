// 본문(markupVersion) 계약 통합 테스트 — 실제 createApp(in-memory :memory: db)을 거쳐
// 클라→서버→DB→재조회 round-trip에서 본문이 유실되지 않음을 못박는다(fakeModel을 쓰지 않는다).
// 운영 news.db는 절대 건드리지 않는다(:memory: 사용, 읽기 전용 단건 조회).

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { seedUsers, SAMPLE_USERS } from '../src/db/seed.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp } from '../server/index.js';

async function start() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  seedUsers(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService });
  const app = createApp({ controllers, sessionService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
}

async function api(base, method, path, { sid, body, clientId } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (sid) headers['x-session-id'] = sid;
  // 편집 탭(per-tab) 식별자 — lock/save 보유자 판정에 쓰인다.
  if (clientId) headers['x-edit-client'] = clientId;
  const res = await fetch(`${base}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, body: json };
}

// 본문 블록 markupVersion 문자열 — 텍스트 + "(끝)" 마커.
function markup() {
  return JSON.stringify({
    format: 'yh-editor',
    version: 1,
    blocks: [
      { type: 'text', text: '제목' },
      { type: 'text', text: '본문줄' },
      { type: 'text', text: '(끝)' },
    ],
  });
}

test('본문 계약: create→lock→PUT 후 단건조회(GET /api/articles/:id)로 본문이 그대로 보존된다', async () => {
  const ctx = await start();
  try {
    // 데스크(D)로 로그인 — RDS 기사를 송고하면 DPS로 전이(생애주기).
    const desk = SAMPLE_USERS.find((u) => u.role === 'D');
    const login = await api(ctx.base, 'POST', '/api/login', { body: { userId: desk.userId, password: desk.password } });
    const sid = login.body.sessionId;

    const m1 = markup();
    const created = await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: '제목', markupVersion: m1 } });
    assert.equal(created.body.ok, true);
    const { articleId } = created.body;

    // 편집 잠금 획득 후 같은 탭(clientId)으로 PUT 본문 수정.
    const cid = 'tab-1';
    const lock = await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: cid, body: {} });
    assert.equal(lock.body.ok, true);
    const m2 = JSON.stringify({
      format: 'yh-editor', version: 1,
      blocks: [{ type: 'text', text: '수정 제목' }, { type: 'text', text: '수정 본문' }, { type: 'text', text: '(끝)' }],
    });
    const put = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, { sid, clientId: cid, body: { title: '수정 제목', markupVersion: m2 } });
    assert.equal(put.body.ok, true);

    // 단건 조회로 본문 보존 확인 — null/빈 문자열이 아니라 저장한 블록 JSON과 동일해야 한다.
    const got = await api(ctx.base, 'GET', `/api/articles/${articleId}`, { sid });
    assert.equal(got.status, 200);
    assert.equal(got.body.ok, true);
    assert.equal(got.body.article.articleId, articleId);
    assert.equal(got.body.article.markupVersion, m2);
    assert.equal(got.body.contents.articleId, articleId);
    assert.equal(got.body.contents.status, 'RDS');
  } finally { await ctx.close(); }
});

test('본문 계약: 편집 후 송고가 (끝) 보존으로 no-end-marker 거부 없이 성공한다(D: RDS→DPS)', async () => {
  const ctx = await start();
  try {
    const desk = SAMPLE_USERS.find((u) => u.role === 'D');
    const login = await api(ctx.base, 'POST', '/api/login', { body: { userId: desk.userId, password: desk.password } });
    const sid = login.body.sessionId;

    const created = await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: '제목', markupVersion: markup() } });
    const { articleId } = created.body;

    const cid = 'tab-1';
    await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: cid, body: {} });
    await api(ctx.base, 'PUT', `/api/articles/${articleId}`, { sid, clientId: cid, body: { title: '제목', markupVersion: markup() } });

    const send = await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, { sid, body: { action: 'send' } });
    assert.equal(send.status, 200);
    assert.equal(send.body.ok, true);
    assert.equal(send.body.status, 'DPS'); // (끝) 보존 → 송고 성공.
  } finally { await ctx.close(); }
});

test('GET /api/articles/:id는 미인증이면 401, 없는 기사면 404(읽기 전용)', async () => {
  const ctx = await start();
  try {
    const unauth = await api(ctx.base, 'GET', '/api/articles/AKR-none');
    assert.equal(unauth.status, 401);

    const reporter = SAMPLE_USERS.find((u) => u.role === 'R');
    const login = await api(ctx.base, 'POST', '/api/login', { body: { userId: reporter.userId, password: reporter.password } });
    const sid = login.body.sessionId;

    const missing = await api(ctx.base, 'GET', '/api/articles/AKR-does-not-exist', { sid });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.ok, false);
    assert.equal(missing.body.reason, 'not-found');
  } finally { await ctx.close(); }
});
