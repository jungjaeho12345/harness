// HTTP transport 계층 테스트 — in-memory db로 createApp을 만들어 핵심 경로를 검증한다.
// 라우트는 비즈니스 로직을 재구현하지 않으므로(ADR-006) 인가 게이트·shape 매핑·세션 신뢰 경계만 본다.
// CRITICAL 검증: 모든 acting role은 세션에서 도출(req.body.role 무시), Z 전용/잠금 보유자/DPS lock=D 게이트.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createReceiverConfigModel } from '../src/models/receiverConfigModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp } from '../server/index.js';

// media 분기를 결정적으로 만들기 위한 기본 env(키 존재) — 실제 외부 호출은 fetchFn 주입으로 차단.
const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

const END_MARKUP = JSON.stringify({
  format: 'yh-editor', version: 1,
  blocks: [{ type: 'text', text: '제목' }, { type: 'text', text: '본문' }, { type: 'text', text: '(끝)' }],
});

async function start({ fetchFn } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV, fetchFn });
  const app = createApp({ controllers, sessionService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, controllers, base, close: () => new Promise((r) => server.close(r)) };
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

test('GET /api/health → 200 ok', async () => {
  const ctx = await start();
  try {
    const r = await api(ctx.base, 'GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  } finally { await ctx.close(); }
});

test('미인증 요청은 거부된다 (GET /api/articles → 401)', async () => {
  const ctx = await start();
  try {
    const r = await api(ctx.base, 'GET', '/api/articles');
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'unauthenticated');
  } finally { await ctx.close(); }
});

test('로그인: 성공 시 세션 발급(비밀번호 미노출), 실패 시 401', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw1234' });

    const ok = await login(ctx.base, 'kim', 'pw1234');
    assert.equal(ok.ok, true);
    assert.match(ok.sessionId, /^[0-9a-f]{64}$/);
    assert.equal(ok.user.password, undefined);

    // 발급된 세션으로 보호 라우트 접근 가능.
    const list = await api(ctx.base, 'GET', '/api/articles', { sid: ok.sessionId });
    assert.equal(list.status, 200);
    assert.equal(list.body.ok, true);

    const bad = await api(ctx.base, 'POST', '/api/login', { body: { userId: 'kim', password: 'wrong' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.sessionId, undefined);
  } finally { await ctx.close(); }
});

test('action: acting role은 세션에서 도출하고 req.body.role은 무시한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const created = await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: '제목', markupVersion: END_MARKUP } });
    const { articleId } = created.body;

    // body.role='D'로 권한 상승을 시도해도 세션 role R로 처리 → R RDS send = RDS (DPS 아님).
    const acted = await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      sid, body: { action: 'send', role: 'D' },
    });
    assert.equal(acted.status, 200);
    assert.equal(acted.body.status, 'RDS');

    const rows = await api(ctx.base, 'GET', `/api/articles?articleId=${articleId}`, { sid });
    assert.equal(rows.body.items[0].status, 'RDS');
  } finally { await ctx.close(); }
});

test('action: D 송고는 DPS, 삭제승인은 DPD로 전이한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const sid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: END_MARKUP } })).body;

    const sent = await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, { sid, body: { action: 'send' } });
    assert.equal(sent.body.status, 'DPS');

    const del = await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, { sid, body: { action: 'approveDelete' } });
    assert.equal(del.status, 200);
    assert.equal(del.body.status, 'DPD');
  } finally { await ctx.close(); }
});

test('action: 송고는 "(끝)" 마커가 없으면 400 (no-end-marker)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const sid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    const noEnd = JSON.stringify({ format: 'yh-editor', version: 1, blocks: [{ type: 'text', text: '제목' }] });
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: noEnd } })).body;

    const r = await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, { sid, body: { action: 'send' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, 'no-end-marker');
  } finally { await ctx.close(); }
});

test('PUT /api/articles/:id: 잠금 보유자만 수정할 수 있다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: '원제목', markupVersion: '{}' } })).body;

    // 잠금 없이 수정 → 403 not-holder.
    const denied = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, { sid, body: { title: '수정제목' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'not-holder');

    // 잠금 획득 후 수정 → ok.
    await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid });
    const ok = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, { sid, body: { title: '수정제목' } });
    assert.equal(ok.status, 200);
    const rows = await api(ctx.base, 'GET', `/api/articles?articleId=${articleId}`, { sid });
    assert.equal(rows.body.items[0].title, '수정제목');
  } finally { await ctx.close(); }
});

test('DPS 편집 진입 lock 획득은 D 전용, 비-DPS는 인증 사용자 누구나', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const dsid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    // RDS 기사 — R도 잠금 획득 가능.
    const { articleId: rds } = (await api(ctx.base, 'POST', '/api/articles', { sid: rsid, body: { title: 't', markupVersion: '{}' } })).body;
    assert.equal((await api(ctx.base, 'POST', `/api/articles/${rds}/lock`, { sid: rsid })).status, 200);

    // DPS 기사 만들기 (D 송고).
    const { articleId: dps } = (await api(ctx.base, 'POST', '/api/articles', { sid: dsid, body: { title: 't', markupVersion: END_MARKUP } })).body;
    await api(ctx.base, 'POST', `/api/articles/${dps}/action`, { sid: dsid, body: { action: 'send' } });

    // R이 DPS 잠금 시도 → 403 forbidden.
    const rDenied = await api(ctx.base, 'POST', `/api/articles/${dps}/lock`, { sid: rsid });
    assert.equal(rDenied.status, 403);
    // D는 DPS 잠금(고침 진입) 가능.
    assert.equal((await api(ctx.base, 'POST', `/api/articles/${dps}/lock`, { sid: dsid })).status, 200);
  } finally { await ctx.close(); }
});

test('force-unlock: D/Z 전용 (R은 403)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const dsid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid: rsid, body: { title: 't', markupVersion: '{}' } })).body;
    await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid: rsid });

    assert.equal((await api(ctx.base, 'POST', `/api/articles/${articleId}/force-unlock`, { sid: rsid })).status, 403);
    assert.equal((await api(ctx.base, 'POST', `/api/articles/${articleId}/force-unlock`, { sid: dsid })).status, 200);
  } finally { await ctx.close(); }
});

test('사용자 관리: POST /api/users는 Z 전용 (미인증 401, 비-Z 403, Z 200·비밀번호 미노출)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'admin', role: 'Z', password: 'pw' });
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const zsid = (await login(ctx.base, 'admin', 'pw')).sessionId;
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    const unauth = await api(ctx.base, 'POST', '/api/users', { body: { userId: 'new', role: 'R', password: 'x' } });
    assert.equal(unauth.status, 401);

    const forbidden = await api(ctx.base, 'POST', '/api/users', { sid: rsid, body: { userId: 'new', role: 'R', password: 'x' } });
    assert.equal(forbidden.status, 403);

    const created = await api(ctx.base, 'POST', '/api/users', { sid: zsid, body: { userId: 'new', name: '새기자', role: 'R', password: 'x' } });
    assert.equal(created.status, 200);
    assert.equal(created.body.ok, true);
    assert.equal(created.body.user.password, undefined);
    assert.equal(created.body.user.userId, 'new');
  } finally { await ctx.close(); }
});

test('수신 설정: Z 전용 게이트 (비-Z 403, Z 생성/조회 가능)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'admin', role: 'Z', password: 'pw' });
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const zsid = (await login(ctx.base, 'admin', 'pw')).sessionId;
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    assert.equal((await api(ctx.base, 'GET', '/api/receiver-config', { sid: rsid })).status, 403);

    const created = await api(ctx.base, 'POST', '/api/receiver-config', { sid: zsid, body: { sourceId: 'src-1', type: 'FTP', active: 'Y' } });
    assert.equal(created.status, 200);
    const list = await api(ctx.base, 'GET', '/api/receiver-config', { sid: zsid });
    assert.equal(list.body.items.length, 1);
  } finally { await ctx.close(); }
});

test('수집 인제스트: 미등록 sourceId 거부(403), 등록 시 attribute=자동기사', async () => {
  const ctx = await start();
  try {
    // 미등록 → 거부.
    const denied = await api(ctx.base, 'POST', '/api/collection/receive', { body: { sourceId: 'nope', payload: '제목\n본문' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'unregistered');

    // 등록 후 → 자동기사로 등록.
    createReceiverConfigModel(ctx.db).insert({ sourceId: 'src-1', type: 'FTP', active: 'Y' });
    const ok = await api(ctx.base, 'POST', '/api/collection/receive', { body: { sourceId: 'src-1', payload: '자동제목\n본문' } });
    assert.equal(ok.status, 200);

    const rows = ctx.controllers.article.query({ articleId: ok.body.articleId });
    assert.equal(rows[0].attribute, '자동기사');
    assert.equal(rows[0].status, 'RDS');
  } finally { await ctx.close(); }
});

test('GET /api/stream: x-session-id 헤더로 ready 무효화 신호를 보낸다(쿠키 폴백은 sse-auth.test.js)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    // 미인증 스트림은 거부.
    const unauth = await fetch(`${ctx.base}/api/stream`);
    assert.equal(unauth.status, 401);
    await unauth.body?.cancel?.();

    const ac = new AbortController();
    const res = await fetch(`${ctx.base}/api/stream`, {
      headers: { 'x-session-id': sid },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const { value } = await res.body.getReader().read();
    assert.match(Buffer.from(value).toString('utf8'), /event: ready/);
    ac.abort();
  } finally { await ctx.close(); }
});

test('GET /api/media/search: 세션 게이트 + 이미지 검색 위임(주입 fetchFn)', async () => {
  let calledUrl;
  const fetchFn = async (url) => { calledUrl = url; return { ok: true, json: async () => ({ items: [{ id: 'img-1' }] }) }; };
  const ctx = await start({ fetchFn });
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    assert.equal((await api(ctx.base, 'GET', '/api/media/search?q=뉴스&type=image')).status, 401);

    const r = await api(ctx.base, 'GET', '/api/media/search?q=뉴스&type=image', { sid });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, [{ id: 'img-1' }]);
    assert.match(calledUrl, /customsearch/);
  } finally { await ctx.close(); }
});
