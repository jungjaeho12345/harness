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

async function start({ fetchFn, env = ENV } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env, fetchFn });
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

test('로그인: 임계치만큼 실패 후 올바른 자격도 잠금(423 Locked, 세션 미발급)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw1234' });

    // step1 기본 임계치(5회) 만큼 잘못된 비밀번호로 실패 — 레이트리밋 한도(10) 안.
    for (let i = 0; i < 5; i += 1) {
      const r = await api(ctx.base, 'POST', '/api/login', { body: { userId: 'kim', password: 'wrong' } });
      assert.equal(r.status, 401);
      assert.equal(r.body.reason, 'invalid-credentials');
    }

    // 6번째 호출: 올바른 자격이어도 잠금 → 423, reason:'locked', 세션 미발급.
    const locked = await api(ctx.base, 'POST', '/api/login', { body: { userId: 'kim', password: 'pw1234' } });
    assert.equal(locked.status, 423);
    assert.equal(locked.body.ok, false);
    assert.equal(locked.body.reason, 'locked');
    assert.equal(locked.body.sessionId, undefined);
    // 내부 상태(잔여 시도/해제 시각) 비노출.
    assert.equal(locked.body.failedLoginCount, undefined);
    assert.equal(locked.body.lockedUntil, undefined);
    assert.equal(locked.body.remaining, undefined);
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

// step5: SSE 인증을 쿠키 우선으로 강화한다(readSessionToken 경유). 세션 토큰 URL 노출을 줄이되,
// dev cross-origin(SameSite 제약으로 쿠키 미적재 + EventSource는 헤더 불가)을 위해 ?session= 쿼리
// 폴백은 유지한다(step3 결정 정합: prod None;Secure / dev·test Lax+폴백). 쿠키가 있으면 쿼리는 무시.
test('GET /api/stream: 쿠키로 인증하면 ready 무효화 신호를 보낸다(미인증 401)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    // 미인증 스트림은 거부.
    const unauth = await fetch(`${ctx.base}/api/stream`);
    assert.equal(unauth.status, 401);
    assert.equal((await unauth.json()).reason, 'unauthenticated');

    // 쿠키만으로(?session= 없이) 인증되어 ready 신호를 받는다 — 토큰이 URL에 노출되지 않는다.
    const ac = new AbortController();
    const res = await fetch(`${ctx.base}/api/stream`, {
      headers: { cookie: `sid=${sid}` },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const { value } = await res.body.getReader().read();
    assert.match(Buffer.from(value).toString('utf8'), /event: ready/);
    ac.abort();
  } finally { await ctx.close(); }
});

test('GET /api/stream: ?session= 쿼리 폴백은 유지된다(dev cross-origin)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

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

test('GET /api/stream: 쿠키가 ?session= 쿼리보다 우선한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    // 유효 쿠키 + 무효 쿼리 → 쿠키로 인증되어 통과한다.
    const ac = new AbortController();
    const res = await fetch(`${ctx.base}/api/stream?session=deadbeef`, {
      headers: { cookie: `sid=${sid}` },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
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

test('derive: continue는 새 articleId·RDS를 반환하고 author는 세션 사용자로 stamp(body author 무시)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: '원본제목', markupVersion: END_MARKUP, author: '원작자' },
    })).body;

    // body로 author='해커'·role='Z'·status를 보내도 무시되고 세션 사용자가 author가 되어야 한다.
    const r = await api(ctx.base, 'POST', `/api/articles/${articleId}/derive`, {
      sid, body: { mode: 'continue', author: '해커', role: 'Z', status: 'DPS', articleId: 'spoof' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.articleId);
    assert.notEqual(r.body.articleId, articleId);

    // 새 기사 조회: status RDS, author는 세션 사용자(김기자), 본문 복사(continue).
    const got = (await api(ctx.base, 'GET', `/api/articles/${r.body.articleId}`, { sid })).body;
    assert.equal(got.contents.status, 'RDS');
    assert.equal(got.contents.author, '김기자');
    assert.equal(got.article.markupVersion, END_MARKUP);
  } finally { await ctx.close(); }
});

test('derive: followUp은 본문 빈값으로 새 기사를 만든다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: '원본제목', markupVersion: END_MARKUP },
    })).body;

    const r = await api(ctx.base, 'POST', `/api/articles/${articleId}/derive`, { sid, body: { mode: 'followUp' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.notEqual(r.body.articleId, articleId);

    const got = (await api(ctx.base, 'GET', `/api/articles/${r.body.articleId}`, { sid })).body;
    assert.equal(got.contents.status, 'RDS');
    assert.equal(got.article.markupVersion, '');
  } finally { await ctx.close(); }
});

test('derive: 원본 기사는 파생 후에도 불변이다(DB 비파괴)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: '원본제목', markupVersion: END_MARKUP, author: '원작자' },
    })).body;

    const before = (await api(ctx.base, 'GET', `/api/articles/${articleId}`, { sid })).body;
    await api(ctx.base, 'POST', `/api/articles/${articleId}/derive`, { sid, body: { mode: 'continue' } });
    const after = (await api(ctx.base, 'GET', `/api/articles/${articleId}`, { sid })).body;

    assert.deepEqual(after.article, before.article);
    assert.deepEqual(after.contents, before.contents);
  } finally { await ctx.close(); }
});

test('derive: 미인증은 401, 정의되지 않은 권한은 403', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    seedUser(ctx.db, { userId: 'ghost', name: '유령', role: 'X', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: 't', markupVersion: END_MARKUP },
    })).body;

    const unauth = await api(ctx.base, 'POST', `/api/articles/${articleId}/derive`, { body: { mode: 'continue' } });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.reason, 'unauthenticated');

    const ghostSid = (await login(ctx.base, 'ghost', 'pw')).sessionId;
    const forbidden = await api(ctx.base, 'POST', `/api/articles/${articleId}/derive`, {
      sid: ghostSid, body: { mode: 'continue' },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.reason, 'forbidden');
  } finally { await ctx.close(); }
});

test('derive: 알 수 없는 mode는 400(unknown-mode), 원본 없으면 404(not-found)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: 't', markupVersion: END_MARKUP },
    })).body;

    const bad = await api(ctx.base, 'POST', `/api/articles/${articleId}/derive`, { sid, body: { mode: 'translate' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.reason, 'unknown-mode');

    const missing = await api(ctx.base, 'POST', '/api/articles/NOPE/derive', { sid, body: { mode: 'continue' } });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.reason, 'not-found');
  } finally { await ctx.close(); }
});

test('derive: 성공 시 SSE change(create) 무효화 신호가 발생한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: 't', markupVersion: END_MARKUP },
    })).body;

    const ac = new AbortController();
    const res = await fetch(`${ctx.base}/api/stream?session=${sid}`, { signal: ac.signal });
    const reader = res.body.getReader();
    await reader.read(); // ready 프레임 소비.

    const derived = await api(ctx.base, 'POST', `/api/articles/${articleId}/derive`, { sid, body: { mode: 'continue' } });
    assert.equal(derived.status, 200);

    const { value } = await reader.read();
    const frame = Buffer.from(value).toString('utf8');
    assert.match(frame, /event: change/);
    assert.match(frame, /"kind":"create"/);
    ac.abort();
  } finally { await ctx.close(); }
});

// --- 번역 라우트 (POST /api/articles/:id/translate) ---
// 형태 (A) 확정: 클라가 보낸 text가 아니라 서버가 DB에서 본문을 조회해 번역한다.
test('translate: 미인증은 401 (POST /api/articles/:id/translate)', async () => {
  const ctx = await start();
  try {
    const r = await api(ctx.base, 'POST', '/api/articles/NOPE/translate', { body: { targetLang: 'en' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'unauthenticated');
  } finally { await ctx.close(); }
});

test('translate: 세션 게이트 후 서버가 DB 본문을 조회해 번역 위임(주입 fetchFn)', async () => {
  // 가짜 Google v2 응답 — q 파라미터로 전송된 번역 대상 텍스트를 캡처한다.
  let calledUrl;
  const fetchFn = async (url) => {
    calledUrl = url;
    return { ok: true, json: async () => ({ data: { translations: [{ translatedText: 'TITLE\nBODY', detectedSourceLanguage: 'ko' }] } }) };
  };
  const env = { ...ENV, GOOGLE_TRANSLATE_API_KEY: 'tk' };
  const ctx = await start({ fetchFn, env });
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: '제목', markupVersion: END_MARKUP },
    })).body;

    const r = await api(ctx.base, 'POST', `/api/articles/${articleId}/translate`, { sid, body: { targetLang: 'en' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.translatedText, 'TITLE\nBODY');
    // 번역 대상 텍스트는 서버가 기사 본문에서 추출한다(클라가 보낸 text가 아님).
    // END_MARKUP 블록 텍스트(제목/본문/(끝))가 q 파라미터로 전송되어야 한다.
    assert.match(decodeURIComponent(calledUrl), /본문/);
    assert.match(calledUrl, /target=en/);
  } finally { await ctx.close(); }
});

test('translate: 키 누락 환경에서도 500이 아니라 graceful(no-key, 원문) 응답을 그대로 내려준다', async () => {
  // 기본 ENV에는 GOOGLE_TRANSLATE_API_KEY가 없다 — fetch 미호출 graceful degrade.
  let fetched = false;
  const fetchFn = async () => { fetched = true; return { ok: true, json: async () => ({}) }; };
  const ctx = await start({ fetchFn });
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: '제목', markupVersion: END_MARKUP },
    })).body;

    const r = await api(ctx.base, 'POST', `/api/articles/${articleId}/translate`, { sid, body: { targetLang: 'ko' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'no-key');
    // 원문(서버가 추출한 본문)을 그대로 폴백으로 돌려준다.
    assert.match(r.body.translatedText, /본문/);
    assert.equal(fetched, false);
  } finally { await ctx.close(); }
});

test('translate: 클라가 보낸 text는 무시되고 서버 DB 본문을 신뢰한다(형태 A)', async () => {
  let calledUrl;
  const fetchFn = async (url) => {
    calledUrl = url;
    return { ok: true, json: async () => ({ data: { translations: [{ translatedText: 'OK' }] } }) };
  };
  const env = { ...ENV, GOOGLE_TRANSLATE_API_KEY: 'tk' };
  const ctx = await start({ fetchFn, env });
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: '제목', markupVersion: END_MARKUP },
    })).body;

    // 악성 text를 보내도 서버는 DB 본문만 번역에 사용한다.
    await api(ctx.base, 'POST', `/api/articles/${articleId}/translate`, {
      sid, body: { targetLang: 'en', text: '위조된본문스파이' },
    });
    assert.doesNotMatch(decodeURIComponent(calledUrl), /위조된본문스파이/);
    assert.match(decodeURIComponent(calledUrl), /본문/);
  } finally { await ctx.close(); }
});

test('translate: 존재하지 않는 기사는 404(not-found)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const r = await api(ctx.base, 'POST', '/api/articles/NOPE/translate', { sid, body: { targetLang: 'ko' } });
    assert.equal(r.status, 404);
    assert.equal(r.body.reason, 'not-found');
  } finally { await ctx.close(); }
});
