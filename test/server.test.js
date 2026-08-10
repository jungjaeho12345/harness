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

async function api(base, method, path, { sid, body, clientId } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (sid) headers['x-session-id'] = sid;
  // 편집 탭 식별자(per-tab) — lock/save/unlock에서 보유자 판정에 쓰인다.
  if (clientId) headers['x-edit-client'] = clientId;
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

test('action: 엠바고 설정된 RDS를 D가 송고하면 DES, DES 기사 KILL→EEK·보류→EEH', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const sid = (await login(ctx.base, 'desk', 'pw')).sessionId;

    // 이 환경은 DIST_SPOOL_DIR 미설정이라 배부 훅이 비활성이다 — 승격 없이 DES에 머문다.
    const mkDes = async () => {
      const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
        sid, body: { title: 't', markupVersion: END_MARKUP, embargoAt: '2026-06-25T09:00:00.000Z' },
      })).body;
      const sent = await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, { sid, body: { action: 'send' } });
      assert.equal(sent.body.status, 'DES');
      return articleId;
    };

    const killId = await mkDes();
    const killed = await api(ctx.base, 'POST', `/api/articles/${killId}/action`, { sid, body: { action: 'kill' } });
    assert.equal(killed.body.status, 'EEK');

    const holdId = await mkDes();
    const held = await api(ctx.base, 'POST', `/api/articles/${holdId}/action`, { sid, body: { action: 'hold' } });
    assert.equal(held.body.status, 'EEH');

    // 회귀: 엠바고 미설정 RDS를 D가 송고하면 여전히 DPS.
    const { articleId: plain } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: END_MARKUP } })).body;
    const plainSent = await api(ctx.base, 'POST', `/api/articles/${plain}/action`, { sid, body: { action: 'send' } });
    assert.equal(plainSent.body.status, 'DPS');
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

test('GET /api/articles/:id/history: 미인증은 401, 인증은 시간순 이력 배열', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const sid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: END_MARKUP } })).body;
    await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, { sid, body: { action: 'send' } });

    // 미인증 → 401.
    const unauth = await api(ctx.base, 'GET', `/api/articles/${articleId}/history`);
    assert.equal(unauth.status, 401);

    // 인증 → { ok:true, items:[...] }.
    const r = await api(ctx.base, 'GET', `/api/articles/${articleId}/history`, { sid });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.items));
    // 1-menu-actions 이력 설계: create는 이력을 남기지 않고, 송고 전이는 eventType='status'·action='send' 1건만 기록된다.
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.items[0].eventType, 'status');
    assert.equal(r.body.items[0].action, 'send');
  } finally { await ctx.close(); }
});

test('GET /api/articles/:id/history?sendOnly=1: send 이벤트만 반환, 미인증 401', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const sid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: END_MARKUP } })).body;
    await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, { sid, body: { action: 'send' } });

    const unauth = await api(ctx.base, 'GET', `/api/articles/${articleId}/history?sendOnly=1`);
    assert.equal(unauth.status, 401);

    const r = await api(ctx.base, 'GET', `/api/articles/${articleId}/history?sendOnly=1`, { sid });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.items));
    assert.ok(r.body.items.length >= 1);
    assert.ok(r.body.items.every((h) => h.eventType === 'status' && h.action === 'send'));
  } finally { await ctx.close(); }
});

test('GET /api/articles/:id/history/:historyId: 미인증 401, 인증 200 item(본문 포함), 없는 id 404', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const sid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: END_MARKUP } })).body;

    // 편집 저장(잠금 획득 → PUT)으로 스냅샷 있는 edit 이력을 만든다.
    const lock = await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: 'tab1' });
    assert.equal(lock.status, 200);
    const put = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, {
      sid, clientId: 'tab1', body: { markupVersion: END_MARKUP },
    });
    assert.equal(put.status, 200);

    // 목록은 본문 blob 없이 hasSnapshot만 싣는다(경량).
    const list = await api(ctx.base, 'GET', `/api/articles/${articleId}/history`, { sid });
    const edit = list.body.items.find((h) => h.eventType === 'edit');
    assert.ok(edit, 'edit 이력 행이 있어야 함');
    assert.ok(edit.hasSnapshot, '스냅샷 존재 플래그');
    assert.equal(edit.markupVersion, undefined, '목록에는 본문 blob이 실리지 않는다');

    // 미인증 → 401.
    const unauth = await api(ctx.base, 'GET', `/api/articles/${articleId}/history/${edit.id}`);
    assert.equal(unauth.status, 401);

    // 인증 → 200 { ok:true, item }(본문 포함).
    const r = await api(ctx.base, 'GET', `/api/articles/${articleId}/history/${edit.id}`, { sid });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.item.markupVersion, END_MARKUP);

    // 없는 id → 404 not-found.
    const missing = await api(ctx.base, 'GET', `/api/articles/${articleId}/history/999999`, { sid });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.reason, 'not-found');
  } finally { await ctx.close(); }
});

test('GET /api/articles/:id/history: 이벤트 없는 기사는 빈 items, 단건/search 라우트는 무회귀', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    // 존재하지 않는 기사 이력 → 빈 배열.
    const empty = await api(ctx.base, 'GET', '/api/articles/999999/history', { sid });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.items, []);

    // /search 라우트가 history 라우트 추가로 깨지지 않는다.
    const search = await api(ctx.base, 'GET', '/api/articles/search?q=', { sid });
    assert.equal(search.status, 200);
    assert.equal(search.body.ok, true);
    assert.ok(Array.isArray(search.body.items));

    // 단건 조회 라우트도 그대로 동작(존재 기사).
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: '{}' } })).body;
    const single = await api(ctx.base, 'GET', `/api/articles/${articleId}`, { sid });
    assert.equal(single.status, 200);
    assert.equal(single.body.ok, true);
    assert.ok(single.body.article);
  } finally { await ctx.close(); }
});

// --- phase 56 step3: /history 응답의 파생 필드(title/version/status) 계약 — HTTP 경계에서 잠근다 ---

// 본문 빌더 — 표식은 반드시 '둘째 줄 이후'에 심는다(첫 줄은 제목으로 응답에 실리는 것이 정상).
function bodyWithSecret(title, secretLine) {
  return JSON.stringify({
    format: 'yh-editor', version: 1,
    blocks: [
      { type: 'text', text: title },
      { type: 'text', text: secretLine },
      { type: 'text', text: '(끝)' },
    ],
  });
}

test('GET /history: 파생 필드(title/version/status)가 실리고 본문 blob은 응답 어디에도 없다', async () => {
  const SECRET = '대외비본문표식-편집';
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const sid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: 't', markupVersion: END_MARKUP },
    })).body;

    // 본문 편집 2회(잠금 보유 탭) — 두 번째 편집 본문의 둘째 줄에 표식을 심는다.
    await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: 'tab1' });
    const put1 = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, {
      sid, clientId: 'tab1', body: { markupVersion: bodyWithSecret('중간 제목', '중간 본문') },
    });
    assert.equal(put1.status, 200);
    const put2 = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, {
      sid, clientId: 'tab1', body: { markupVersion: bodyWithSecret('최신 제목', SECRET) },
    });
    assert.equal(put2.status, 200);
    const sent = await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, { sid, body: { action: 'send' } });
    assert.equal(sent.body.status, 'DPS');

    const r = await api(ctx.base, 'GET', `/api/articles/${articleId}/history`, { sid });
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 3, 'edit 2건 + status/send 1건');
    for (const item of r.body.items) {
      assert.equal(typeof item.title, 'string');
      assert.equal(typeof item.version, 'number');
      assert.equal(typeof item.status, 'string');
      assert.equal('markupVersion' in item, false, '목록 item에 본문 blob이 없다');
    }
    // 최신 편집 행(id 최대 edit)의 제목 = 그 편집으로 저장된 본문의 첫 줄.
    const edits = r.body.items.filter((h) => h.eventType === 'edit');
    assert.equal(edits[0].title, '최신 제목');
    assert.equal(edits[0].version, 3, 'v1(최초 저장) + 편집 2회');
    // 응답 본문 문자열 전체에 편집 본문의 표식이 등장하지 않는다(키 이름 단언보다 강한 blob 누출 스캔).
    assert.equal(JSON.stringify(r.body).includes(SECRET), false);

    // 미인증 401 회귀 — 파생 추가와 무관하게 세션 없는 요청은 거부되고 items가 없다.
    const unauth = await api(ctx.base, 'GET', `/api/articles/${articleId}/history`);
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.items, undefined);
  } finally { await ctx.close(); }
});

test('GET /history: 편집 없이 송고한 기사(v1 경로)도 제목이 오고 생성 본문 blob은 새지 않는다', async () => {
  const SECRET = '대외비본문표식-생성';
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const sid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    // 생성 본문 '둘째 줄'에 표식 — 첫 줄(제목)은 응답에 실리는 것이 정상이므로 표식이 아니다.
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: 't', markupVersion: bodyWithSecret('생성 제목', SECRET) },
    })).body;
    await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, { sid, body: { action: 'send' } });

    const r = await api(ctx.base, 'GET', `/api/articles/${articleId}/history`, { sid });
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1, '생성은 이력을 남기지 않는다 — 송고 1건뿐');
    assert.equal(r.body.items[0].version, 1, '편집 0회 = 최초 저장 본문이 곧 v1');
    assert.equal(r.body.items[0].title, '생성 제목', 'v1 본문 예외가 HTTP 경계까지 이어진다');
    // v1Body 경로에서도 본문 blob이 응답 문자열 어디에도 새지 않는다.
    assert.equal(JSON.stringify(r.body).includes(SECRET), false);
  } finally { await ctx.close(); }
});

test('GET /history?sendOnly=1: 송고 item의 파생 값이 전체 조회와 일치한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const sid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: 't', markupVersion: END_MARKUP },
    })).body;
    await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: 'tab1' });
    await api(ctx.base, 'PUT', `/api/articles/${articleId}`, {
      sid, clientId: 'tab1', body: { markupVersion: bodyWithSecret('송고 제목', '본문') },
    });
    await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, { sid, body: { action: 'send' } });

    const sendOnly = await api(ctx.base, 'GET', `/api/articles/${articleId}/history?sendOnly=1`, { sid });
    assert.equal(sendOnly.status, 200);
    assert.equal(sendOnly.body.items.length, 1);
    assert.equal(sendOnly.body.items[0].version, 2, '필터로 잘린 edit 스냅샷까지 센 버전');
    assert.equal(sendOnly.body.items[0].title, '송고 제목');

    const full = await api(ctx.base, 'GET', `/api/articles/${articleId}/history`, { sid });
    const same = full.body.items.find((h) => h.id === sendOnly.body.items[0].id);
    assert.deepEqual(sendOnly.body.items[0], same, '전체 조회의 같은 id item과 값이 일치한다');
  } finally { await ctx.close(); }
});

// --- phase 58 테스트 게이트 보강: 레거시(snapshotTitle NULL) 행 혼재 기사의 HTTP 왕복 ---
// 레거시 행은 유일하게 본문 blob이 모델→서비스 JS 경계를 넘는 경로다(단일 CASE 조회의 폴백 입력).
// 그 blob이 HTTP 응답까지 새지 않는 것은 decorateHistoryRows의 방어 제거뿐이 지킨다 —
// 서비스 레벨 잠금(titleColumn 키 집합)에 더해 HTTP 경계에서도 누출 스캔·키 부재를 잠근다.
test('GET /history: 레거시+신규 혼재 기사 — 레거시 제목은 본문 첫 줄, blob·snapshotTitle은 HTTP로 새지 않는다', async () => {
  const LEGACY_SECRET = '대외비본문표식-레거시행';
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const sid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: 't', markupVersion: END_MARKUP },
    })).body;

    // 신규 기록 경로: PUT 편집 1회(snapshotTitle 컬럼 저장) — 이후 레거시 행을 직접 심는다
    // (컬럼 도입 이전에 기록된 행과 동형: snapshotTitle NULL + markupVersion 보유. 표식은 둘째 줄).
    await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: 'tab1' });
    await api(ctx.base, 'PUT', `/api/articles/${articleId}`, {
      sid, clientId: 'tab1', body: { markupVersion: bodyWithSecret('신규 제목', '신규 본문') },
    });
    ctx.db.prepare(
      "INSERT INTO ArticleHistory (articleId, eventType, actorUserId, createdAt, markupVersion) VALUES (?, 'edit', 'desk', ?, ?)",
    ).run(articleId, '2026-08-10T00:00:02.000Z', bodyWithSecret('레거시 제목', LEGACY_SECRET));

    const r = await api(ctx.base, 'GET', `/api/articles/${articleId}/history`, { sid });
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 2, '신규 edit 1건 + 레거시 edit 1건');
    // id DESC — 레거시 행(나중 insert)이 먼저 온다. 제목은 각자 자기 출처에서.
    assert.equal(r.body.items[0].title, '레거시 제목', '레거시 행은 CASE 폴백 본문의 첫 줄');
    assert.equal(r.body.items[1].title, '신규 제목', '신규 행은 저장 컬럼 값');
    for (const item of r.body.items) {
      assert.equal('markupVersion' in item, false, '본문 blob 키가 item에 없다');
      assert.equal('snapshotTitle' in item, false, '저장 컬럼 키가 item에 없다');
    }
    // 레거시 행의 본문은 JS 경계를 넘는 유일한 blob이다 — 응답 문자열 전체에서 표식이 없어야 한다.
    assert.equal(JSON.stringify(r.body).includes(LEGACY_SECRET), false, '레거시 blob이 HTTP로 새지 않는다');
  } finally { await ctx.close(); }
});

test('PUT /api/articles/:id: 잠금 보유 탭(clientId)만 수정할 수 있다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const cid = 'tab-1';
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: '원제목', markupVersion: '{}' } })).body;

    // 잠금 없이 수정 → 403 not-holder.
    const denied = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, { sid, clientId: cid, body: { title: '수정제목' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'not-holder');

    // 잠금 획득 후 같은 탭(clientId)으로 수정 → ok.
    await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: cid });
    const ok = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, { sid, clientId: cid, body: { title: '수정제목' } });
    assert.equal(ok.status, 200);
    const rows = await api(ctx.base, 'GET', `/api/articles?articleId=${articleId}`, { sid });
    assert.equal(rows.body.items[0].title, '수정제목');
  } finally { await ctx.close(); }
});

test('PUT /api/articles/:id: 같은 세션의 2번째 탭(다른 clientId)은 lock·save가 차단된다 [c]', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: '원제목', markupVersion: '{}' } })).body;

    // 1번째 탭이 잠금을 보유한다.
    assert.equal((await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: 'tab-1' })).status, 200);

    // 같은 세션의 2번째 탭은 잠금 획득 실패(locked).
    const lock2 = await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: 'tab-2' });
    assert.equal(lock2.status, 401, '같은 세션 다른 탭 잠금은 locked(401)');
    assert.equal(lock2.body.reason, 'locked');

    // 2번째 탭은 저장도 차단(not-holder).
    const save2 = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, { sid, clientId: 'tab-2', body: { title: '탈취제목' } });
    assert.equal(save2.status, 403);
    assert.equal(save2.body.reason, 'not-holder');

    // 1번째 탭은 여전히 보유자로 저장 가능.
    assert.equal((await api(ctx.base, 'PUT', `/api/articles/${articleId}`, { sid, clientId: 'tab-1', body: { title: '정상제목' } })).status, 200);
  } finally { await ctx.close(); }
});

test('PUT /api/articles/:id: 남의 편집 탭(clientId)을 알아도 다른 사용자는 저장할 수 없다 [ADR-004]', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk1', role: 'D', department: '사회부', password: 'pw' });
    seedUser(ctx.db, { userId: 'rep1', role: 'R', department: '사회부', password: 'pw' });
    const dsid = (await login(ctx.base, 'desk1', 'pw')).sessionId;
    const rsid = (await login(ctx.base, 'rep1', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid: dsid, body: { title: '원제목', markupVersion: '{"v":1}' } })).body;

    // D가 자기 탭(tab-d)으로 잠금을 보유한다.
    assert.equal((await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid: dsid, clientId: 'tab-d' })).status, 200);

    // R이 D의 탭 식별자를 그대로 흉내내 저장 시도 → 세션 신원이 다르므로 403 not-holder.
    const steal = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, {
      sid: rsid, clientId: 'tab-d', body: { title: '탈취제목', markupVersion: '{"v":666}' },
    });
    assert.equal(steal.status, 403);
    assert.equal(steal.body.reason, 'not-holder');

    // 쓰기 0건 — 제목·본문이 그대로다.
    const after = await api(ctx.base, 'GET', `/api/articles/${articleId}`, { sid: dsid });
    assert.equal(after.body.article.title, '원제목', '탈취 시도 후 제목 무변경');
    assert.equal(after.body.article.markupVersion, '{"v":1}', '탈취 시도 후 본문 무변경');

    // 정상 경로 회귀: 보유자 D는 자기 세션·자기 탭으로 저장할 수 있다.
    assert.equal((await api(ctx.base, 'PUT', `/api/articles/${articleId}`, { sid: dsid, clientId: 'tab-d', body: { title: '정상제목' } })).status, 200);
    const ok = await api(ctx.base, 'GET', `/api/articles/${articleId}`, { sid: dsid });
    assert.equal(ok.body.article.title, '정상제목');
  } finally { await ctx.close(); }
});

test('POST /api/articles: 작성자 미전송 시 세션 사용자 이름으로 stamp한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', departmentCode: 'SOC', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    // author를 보내지 않고 생성 → 세션 사용자 이름으로 보정(신규 작성 작성자 자동 입력).
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: '{}' } })).body;
    const row = (await api(ctx.base, 'GET', `/api/articles?articleId=${articleId}`, { sid })).body.items[0];
    assert.equal(row.author, '김기자', '작성자 미전송 시 세션 사용자로 보정');
  } finally { await ctx.close(); }
});

test('POST /api/articles: 최초 작성 초기 상태는 세션 role+action으로 결정 ((Z|D)+hold→DDH, R+hold→RRH, send/그 외 RDS)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'admin', name: '관리자', role: 'Z', department: '편집부', password: 'pw' });
    seedUser(ctx.db, { userId: 'desk', name: '데스크', role: 'D', department: '편집부', password: 'pw' });
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const zsid = (await login(ctx.base, 'admin', 'pw')).sessionId;
    const dsid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    // 세션 role Z + action:hold → DDH.
    const zHold = (await api(ctx.base, 'POST', '/api/articles', { sid: zsid, body: { title: 't', markupVersion: '{}', action: 'hold' } })).body;
    assert.equal((await api(ctx.base, 'GET', `/api/articles?articleId=${zHold.articleId}`, { sid: zsid })).body.items[0].status, 'DDH');

    // 세션 role D + action:hold → DDH (Z와 동일).
    const dHold = (await api(ctx.base, 'POST', '/api/articles', { sid: dsid, body: { title: 't', markupVersion: '{}', action: 'hold' } })).body;
    assert.equal((await api(ctx.base, 'GET', `/api/articles?articleId=${dHold.articleId}`, { sid: dsid })).body.items[0].status, 'DDH');

    // 세션 role R + action:hold → RRH.
    const rHold = (await api(ctx.base, 'POST', '/api/articles', { sid: rsid, body: { title: 't', markupVersion: '{}', action: 'hold' } })).body;
    assert.equal((await api(ctx.base, 'GET', `/api/articles?articleId=${rHold.articleId}`, { sid: rsid })).body.items[0].status, 'RRH');

    // 세션 role Z + action:send → RDS (신규 최초 송고는 RDS 유지).
    const zSend = (await api(ctx.base, 'POST', '/api/articles', { sid: zsid, body: { title: 't', markupVersion: '{}', action: 'send' } })).body;
    assert.equal((await api(ctx.base, 'GET', `/api/articles?articleId=${zSend.articleId}`, { sid: zsid })).body.items[0].status, 'RDS');
  } finally { await ctx.close(); }
});

test('POST /api/articles: body.role/body.status는 초기 상태 결정에 쓰이지 않는다 (ADR-004)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    // R 세션이 body로 role:Z·status:DDH를 보내도 무시되고, 세션 role R + action:hold 기준 → RRH (DDH 아님).
    const r = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: '{}', role: 'Z', status: 'DDH', action: 'hold' } })).body;
    assert.equal((await api(ctx.base, 'GET', `/api/articles?articleId=${r.articleId}`, { sid })).body.items[0].status, 'RRH');
  } finally { await ctx.close(); }
});

test('POST /api/articles: 명시한 작성자는 세션 stamp가 덮어쓰지 않는다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: '{}', author: '대필기자' } })).body;
    const row = (await api(ctx.base, 'GET', `/api/articles?articleId=${articleId}`, { sid })).body.items[0];
    assert.equal(row.author, '대필기자', '명시한 작성자는 보존');
  } finally { await ctx.close(); }
});

test('PUT /api/articles/:id: 부서를 빈 값으로 저장하면 세션 부서로 보정한다 (#3)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', departmentCode: 'SOC', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const cid = 'tab-1';
    // POST 자동입력을 피하려 다른 부서(경제부)로 명시 저장.
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: '{}', department: '경제부', departmentCode: 'ECO' } })).body;
    await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: cid });

    // 편집 저장에서 부서를 빈 값으로 전송 → 세션 부서(사회부)로 보정.
    const ok = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, { sid, clientId: cid, body: { department: '', departmentCode: '' } });
    assert.equal(ok.status, 200);
    const row = (await api(ctx.base, 'GET', `/api/articles?articleId=${articleId}`, { sid })).body.items[0];
    assert.equal(row.department, '사회부', '빈 부서는 세션 부서로 보정');
    assert.equal(row.departmentCode, 'SOC');
  } finally { await ctx.close(); }
});

test('PUT /api/articles/:id: 부서 키를 보내지 않으면 기존 부서를 보존한다 (부분 수정, #3)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', departmentCode: 'SOC', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const cid = 'tab-1';
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: '{}', department: '경제부', departmentCode: 'ECO' } })).body;
    await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: cid });

    // 부서 키 없이 제목만 수정 → 기존 부서(경제부) 보존.
    const ok = await api(ctx.base, 'PUT', `/api/articles/${articleId}`, { sid, clientId: cid, body: { title: '새제목' } });
    assert.equal(ok.status, 200);
    const row = (await api(ctx.base, 'GET', `/api/articles?articleId=${articleId}`, { sid })).body.items[0];
    assert.equal(row.department, '경제부', '부서 미전송 시 기존 부서 보존');
    assert.equal(row.title, '새제목');
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

test('unlock: 남의 편집 탭(clientId)을 알아도 다른 사용자는 해제할 수 없다 [ADR-004]', async () => {
  const ctx = await start();
  const lockOf = (articleId) => ctx.db.prepare('SELECT lockYN FROM Contents WHERE articleId = ?').get(articleId).lockYN;
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const dsid = (await login(ctx.base, 'desk', 'pw')).sessionId;
    const rsid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid: rsid, body: { title: 't', markupVersion: '{}' } })).body;

    // R이 자기 탭(tab-r)으로 잠금을 보유한다.
    assert.equal((await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid: rsid, clientId: 'tab-r' })).status, 200);

    // D가 R의 탭 식별자를 그대로 흉내내 해제 시도 → 세션 신원이 다르므로 403 not-holder.
    const steal = await api(ctx.base, 'POST', `/api/articles/${articleId}/unlock`, { sid: dsid, clientId: 'tab-r' });
    assert.equal(steal.status, 403);
    assert.equal(steal.body.reason, 'not-holder');
    assert.equal(lockOf(articleId), 'Y', '거부된 해제는 잠금을 풀지 않는다');

    // 강제 해제(D/Z 전용)는 그대로 동작한다 — 이번 강화의 표적이 아니다.
    assert.equal((await api(ctx.base, 'POST', `/api/articles/${articleId}/force-unlock`, { sid: dsid })).status, 200);
    assert.equal(lockOf(articleId), 'N');
  } finally { await ctx.close(); }
});

test('unlock: 보유자 본인은 자기 탭으로 해제할 수 있다(신원은 세션에서 도출)', async () => {
  const ctx = await start();
  const lockOf = (articleId) => ctx.db.prepare('SELECT lockYN FROM Contents WHERE articleId = ?').get(articleId).lockYN;
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;
    const { articleId } = (await api(ctx.base, 'POST', '/api/articles', { sid, body: { title: 't', markupVersion: '{}' } })).body;
    await api(ctx.base, 'POST', `/api/articles/${articleId}/lock`, { sid, clientId: 'tab-1' });

    assert.equal((await api(ctx.base, 'POST', `/api/articles/${articleId}/unlock`, { sid, clientId: 'tab-1' })).status, 200);
    assert.equal(lockOf(articleId), 'N');
    // 탭 닫기·pagehide 경로가 중복 호출한다 — 두 번째 해제도 멱등(200).
    assert.equal((await api(ctx.base, 'POST', `/api/articles/${articleId}/unlock`, { sid, clientId: 'tab-1' })).status, 200);
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

test('수집 pull: 등록된 API 소스를 능동 호출해 자동기사로 등록한다 (#4)', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ title: '풀제목', content: '풀본문' }) });
  const ctx = await start({ fetchFn });
  try {
    createReceiverConfigModel(ctx.db).insert({ sourceId: 'api-1', type: 'API', apiEndpoint: 'https://x/api', apiKey: 'K', active: 'Y' });
    const ok = await api(ctx.base, 'POST', '/api/collection/pull', { body: { sourceId: 'api-1' } });
    assert.equal(ok.status, 200);
    const rows = ctx.controllers.article.query({ articleId: ok.body.articleId });
    assert.equal(rows[0].attribute, '자동기사');
    assert.equal(rows[0].title, '풀제목');

    // 미등록 sourceId는 거부(403 unregistered).
    const denied = await api(ctx.base, 'POST', '/api/collection/pull', { body: { sourceId: 'nope' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'unregistered');
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

test('GET /api/stream: x-session-id 헤더 폴백으로 인증된다', async () => {
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

test('GET /api/stream: 쿠키 인증은 무효 ?session= 쿼리를 무시한다', async () => {
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
    const res = await fetch(`${ctx.base}/api/stream`, { headers: { 'x-session-id': sid }, signal: ac.signal });
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
