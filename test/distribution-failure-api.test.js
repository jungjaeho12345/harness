// 배부 실패 조회/재전송 transport 테스트 — GET /api/distribution/failures · POST /api/distribution/retry
// (Z 전용, ADR-008 MVP-4). 하네스는 distribution-tick-api.test.js 복제(실제 파일 미생성).
// CRITICAL 잠그는 것:
//   (1) 인가는 검증된 세션에서만 — body의 role:'Z'는 무시(ADR-004), 게이트가 스풀 설정 판정보다 먼저.
//   (2) 재전송은 부수효과(스풀 쓰기)가 있으므로 GET으로 열지 않는다.
//   (3) 응답 본문에 서버 파일시스템 경로(spoolDir/스풀 루트/파일 경로)가 실리지 않는다.
//   (4) 재전송 성공 시에만 SSE 무효화 신호('status') 1회.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createDistributionTargetModel } from '../src/models/distributionTargetModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

// 경로 구분자가 없는 토큰만 골랐다 — 응답 위생 단언이 플랫폼에 의존하지 않도록(tick 테스트와 동일).
const SPOOL_ROOT = '/spool/retryout';
const TARGET_DIR = 'kbsretry';

const NOW = '2026-08-06T09:30:00.000Z';
const MARKUP = '{"blocks":[{"text":"본문 (끝)"}]}';
const ARTICLE_ID = 'AKR202608060000000001';

function fakeSpoolFs({ fail = false } = {}) {
  const calls = { mkdir: [], writeFile: [], rename: [] };
  const op = (name) => async (...args) => { calls[name].push(args); };
  return {
    calls,
    mkdir: fail ? async () => { throw new Error('권한 없음'); } : op('mkdir'),
    writeFile: op('writeFile'),
    rename: op('rename'),
  };
}

async function start({ spool = true, spoolFs = fakeSpoolFs() } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    sessionService,
    env: spool ? { ...ENV, DIST_SPOOL_DIR: SPOOL_ROOT } : ENV,
    spoolFs,
    now: () => NOW,
  });
  const app = createApp({ controllers, sessionService });
  const signals = [];
  const notify = app.notifyChange;
  app.notifyChange = (kind) => { signals.push(kind); return notify(kind); };

  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, spoolFs, signals, close: () => new Promise((r) => server.close(r)) };
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

async function loginAs(ctx, role, userId) {
  seedUser(ctx.db, { userId, name: userId, role, department: '사회부', password: 'pw' });
  const r = await api(ctx.base, 'POST', '/api/login', { body: { userId, password: 'pw' } });
  return r.body.sessionId;
}

function seedTarget(db, { name = 'KBS', kind = 'press', spoolDir = TARGET_DIR } = {}) {
  return createDistributionTargetModel(db).insert({
    name, kind, spoolDir, active: 'Y', createdAt: NOW,
  });
}

// 배부 가능한(DPS) 기사 1건.
function seedArticle(db, articleId = ARTICLE_ID, { status = 'DPS' } = {}) {
  createArticleModel(db).insert({
    article: { articleId, title: '제목', markupVersion: MARKUP },
    contents: {
      articleId, title: '제목', author: 'kim', sender: 'desk', status,
      createdAt: '2026-08-06T08:00:00.000Z', sentAt: '2026-08-06T08:10:00.000Z',
    },
  });
  return articleId;
}

// 수신처 단위 실패 이력 시드 — step2의 distributionService가 남기는 행과 같은 shape.
function seedFailure(db, { articleId = ARTICLE_ID, targetId, kind = 'press', reason = 'spool-write-failed' }) {
  db.prepare(
    `INSERT INTO ArticleHistory (articleId, eventType, action, targetId, reason, actorUserId, createdAt)
     VALUES (?, 'distribute-failed', ?, ?, ?, 'sys', '2026-08-06T09:00:00.000Z')`,
  ).run(articleId, kind, targetId, reason);
}
function seedRetryEvent(db, { articleId = ARTICLE_ID, targetId, kind = 'press' }) {
  db.prepare(
    `INSERT INTO ArticleHistory (articleId, eventType, action, targetId, actorUserId, createdAt)
     VALUES (?, 'distribute-retry', ?, ?, 'z1', '2026-08-06T09:01:00.000Z')`,
  ).run(articleId, kind, targetId);
}

const failures = (ctx, opts) => api(ctx.base, 'GET', '/api/distribution/failures', opts);
const retry = (ctx, opts) => api(ctx.base, 'POST', '/api/distribution/retry', opts);
const fsCallCount = (ctx) => ctx.spoolFs.calls.mkdir.length
  + ctx.spoolFs.calls.writeFile.length + ctx.spoolFs.calls.rename.length;

// ── GET /api/distribution/failures ──────────────────────────────────────

// 케이스 1
test('GET /api/distribution/failures: 미인증은 401 unauthenticated, items 없음', async () => {
  const ctx = await start();
  try {
    seedFailure(ctx.db, { targetId: seedTarget(ctx.db) });
    const r = await failures(ctx);
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { ok: false, reason: 'unauthenticated' });
  } finally { await ctx.close(); }
});

// 케이스 2
test('GET /api/distribution/failures: R/D는 403 forbidden', async () => {
  const ctx = await start();
  try {
    seedFailure(ctx.db, { targetId: seedTarget(ctx.db) });
    for (const role of ['R', 'D']) {
      const sid = await loginAs(ctx, role, `u${role}`);
      const r = await failures(ctx, { sid });
      assert.equal(r.status, 403, `${role} 세션`);
      assert.equal(r.body.reason, 'forbidden');
      assert.ok(!('items' in r.body), '거부 응답에 items 없음');
    }
  } finally { await ctx.close(); }
});

// 케이스 3 + 4
test('GET /api/distribution/failures: Z는 200 { ok, items } — 응답에 스풀 경로가 없다', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    const articleId = seedArticle(ctx.db);
    seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await failures(ctx, { sid: zsid });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.items[0].articleId, articleId);
    assert.strictEqual(r.body.items[0].targetId, targetId);
    assert.equal(r.body.items[0].kind, 'press');
    assert.equal(r.body.items[0].targetName, 'KBS');

    // 응답 위생 — 스풀 루트·수신처 폴더·파일 경로·spoolDir 키가 어디에도 없다(tick 테스트 (3)과 동형).
    const raw = JSON.stringify(r.body);
    assert.equal(raw.includes('spoolDir'), false);
    assert.equal(raw.includes('retryout'), false);
    assert.equal(raw.includes(TARGET_DIR), false);
    assert.equal(raw.includes('.json'), false);
  } finally { await ctx.close(); }
});

// 케이스 5
test('GET /api/distribution/failures: ?limit=1이 적용된다', async () => {
  const ctx = await start();
  try {
    seedArticle(ctx.db);
    const t1 = seedTarget(ctx.db, { name: 'KBS', spoolDir: 'kbs1' });
    const t2 = seedTarget(ctx.db, { name: 'MBC', spoolDir: 'mbc2' });
    seedFailure(ctx.db, { targetId: t1 });
    seedFailure(ctx.db, { targetId: t2 });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    assert.equal((await failures(ctx, { sid: zsid })).body.items.length, 2);
    const limited = await failures(ctx, { sid: zsid });
    const r = await api(ctx.base, 'GET', '/api/distribution/failures?limit=1', { sid: zsid });
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1, 'limit=1 → 최신 1건만');
    assert.ok(limited.body.items.length > r.body.items.length);
  } finally { await ctx.close(); }
});

// 케이스 6
test('GET /api/distribution/failures: 재전송으로 해소된 항목은 목록에 없다', async () => {
  const ctx = await start();
  try {
    seedArticle(ctx.db);
    const targetId = seedTarget(ctx.db);
    seedFailure(ctx.db, { targetId });
    seedRetryEvent(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await failures(ctx, { sid: zsid });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, []);
  } finally { await ctx.close(); }
});

// ── POST /api/distribution/retry ────────────────────────────────────────

// 케이스 7 + 8
test('POST /api/distribution/retry: 미인증 401 · 비-Z 403(body role:"Z" 무시) — 스풀 FS 호출 0회', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    seedArticle(ctx.db);
    seedFailure(ctx.db, { targetId });

    const anon = await retry(ctx, { body: { articleId: ARTICLE_ID, targetId } });
    assert.equal(anon.status, 401);
    assert.equal(anon.body.reason, 'unauthenticated');

    for (const role of ['R', 'D']) {
      const sid = await loginAs(ctx, role, `u${role}`);
      const r = await retry(ctx, { sid, body: { articleId: ARTICLE_ID, targetId, role: 'Z' } });
      assert.equal(r.status, 403, `${role} 세션 — body role 위조 무시(ADR-004)`);
      assert.equal(r.body.reason, 'forbidden');
    }
    assert.equal(fsCallCount(ctx), 0, '거부 경로는 스풀 FS를 건드리지 않는다');
    assert.deepEqual(ctx.signals, []);
  } finally { await ctx.close(); }
});

// 케이스 9 + 10 + 18(성공 신호)
test('POST /api/distribution/retry: Z + 유효 실패 → 200, FS 1세트, 응답에 file/spoolDir 없음, distributedAt 갱신 + 신호 1회', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    const articleId = seedArticle(ctx.db);
    seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { articleId, targetId } });

    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, articleId, targetId, kind: 'press', at: NOW });
    assert.equal(ctx.spoolFs.calls.mkdir.length, 1);
    assert.equal(ctx.spoolFs.calls.writeFile.length, 1);
    assert.equal(ctx.spoolFs.calls.rename.length, 1, 'mkdir/writeFile/rename 정확히 1세트');
    const raw = JSON.stringify(r.body);
    assert.equal(raw.includes('file'), false, '응답에 file 없음');
    assert.equal(raw.includes(TARGET_DIR), false, '응답에 spoolDir 슬러그 없음');

    // DB: distributedAt 갱신 + status 불변.
    const row = ctx.db.prepare('SELECT status, distributedAt FROM Contents WHERE articleId = ?').get(articleId);
    assert.equal(row.distributedAt, NOW);
    assert.equal(row.status, 'DPS', '재전송은 상태를 바꾸지 않는다');
    assert.deepEqual(ctx.signals, ['status'], '성공 시에만 무효화 신호 1회');
  } finally { await ctx.close(); }
});

// 케이스 11
test('POST /api/distribution/retry: 성공 후 GET failures에서 항목이 사라진다 (왕복)', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    const articleId = seedArticle(ctx.db);
    seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    assert.equal((await failures(ctx, { sid: zsid })).body.items.length, 1);
    await retry(ctx, { sid: zsid, body: { articleId, targetId } });
    assert.deepEqual((await failures(ctx, { sid: zsid })).body.items, []);
  } finally { await ctx.close(); }
});

// 케이스 12
test('POST /api/distribution/retry: 미해소 실패가 없는 쌍은 404 no-failure, FS 0회', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    const articleId = seedArticle(ctx.db);
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { articleId, targetId } });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { ok: false, reason: 'no-failure' });
    assert.equal(fsCallCount(ctx), 0);
    assert.deepEqual(ctx.signals, []);
  } finally { await ctx.close(); }
});

// 케이스 13
test('POST /api/distribution/retry: 기사 status가 EEK면 409 status-changed, FS 0회', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    const articleId = seedArticle(ctx.db, ARTICLE_ID, { status: 'EEK' });
    seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { articleId, targetId } });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { ok: false, reason: 'status-changed' });
    assert.equal(fsCallCount(ctx), 0);
  } finally { await ctx.close(); }
});

// 케이스 14
test('POST /api/distribution/retry: 비활성 수신처는 403 inactive', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    const articleId = seedArticle(ctx.db);
    seedFailure(ctx.db, { targetId });
    createDistributionTargetModel(ctx.db).update(targetId, { active: 'N' });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { articleId, targetId } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { ok: false, reason: 'inactive' });
    assert.equal(fsCallCount(ctx), 0);
  } finally { await ctx.close(); }
});

// 케이스 15
test('POST /api/distribution/retry: 없는 수신처·없는 기사는 404 not-found', async () => {
  const ctx = await start();
  try {
    const zsid = await loginAs(ctx, 'Z', 'admin');

    // 수신처 행 없음(실패 이력만 존재).
    seedFailure(ctx.db, { targetId: 777 });
    seedArticle(ctx.db);
    const noTarget = await retry(ctx, { sid: zsid, body: { articleId: ARTICLE_ID, targetId: 777 } });
    assert.equal(noTarget.status, 404);
    assert.equal(noTarget.body.reason, 'not-found');

    // 기사 행 없음.
    const targetId = seedTarget(ctx.db);
    seedFailure(ctx.db, { articleId: 'AKR-GHOST', targetId });
    const noArticle = await retry(ctx, { sid: zsid, body: { articleId: 'AKR-GHOST', targetId } });
    assert.equal(noArticle.status, 404);
    assert.equal(noArticle.body.reason, 'not-found');
    assert.equal(fsCallCount(ctx), 0);
  } finally { await ctx.close(); }
});

// 케이스 16
test('POST /api/distribution/retry: 스풀 미설정 + Z → 503 spool-disabled, 같은 환경 GET failures는 200', async () => {
  const ctx = await start({ spool: false });
  try {
    const targetId = seedTarget(ctx.db);
    const articleId = seedArticle(ctx.db);
    seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { articleId, targetId } });
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { ok: false, reason: 'spool-disabled' });

    const l = await failures(ctx, { sid: zsid });
    assert.equal(l.status, 200, '조회는 스풀 설정과 무관하다');
    assert.equal(l.body.items.length, 1);
  } finally { await ctx.close(); }
});

// 케이스 17
test('GET /api/distribution/retry: 라우트가 없어 404다 (부수효과 연산은 GET으로 열지 않는다)', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    seedArticle(ctx.db);
    seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await api(ctx.base, 'GET', '/api/distribution/retry', { sid: zsid });
    assert.equal(r.status, 404);
    assert.equal(fsCallCount(ctx), 0, 'GET은 재전송을 트리거하지 않는다');
    assert.deepEqual(ctx.signals, []);
  } finally { await ctx.close(); }
});

// 케이스 18(실패·거부는 무신호)
test('POST /api/distribution/retry: 재전송 실패·거부 응답에는 SSE 신호가 없다', async () => {
  const ctx = await start({ spoolFs: fakeSpoolFs({ fail: true }) });
  try {
    const targetId = seedTarget(ctx.db);
    const articleId = seedArticle(ctx.db);
    seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { articleId, targetId } });
    assert.equal(r.status, 400, 'spool-write-failed는 매핑 밖 — 폴백 400');
    assert.deepEqual(r.body, { ok: false, reason: 'spool-write-failed' });
    assert.deepEqual(ctx.signals, [], '실패에는 신호를 보내지 않는다');

    const denied = await retry(ctx, { body: { articleId, targetId } });
    assert.equal(denied.status, 401);
    assert.deepEqual(ctx.signals, [], '거부에도 신호 없음');
  } finally { await ctx.close(); }
});

// 케이스 19
test('POST /api/distribution/retry: targetId를 JSON 문자열로 보내도 정상 처리된다 (HTTP 경계 정규화)', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    const articleId = seedArticle(ctx.db);
    seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { articleId, targetId: String(targetId) } });
    assert.equal(r.status, 200);
    assert.strictEqual(r.body.targetId, targetId, '응답 targetId는 숫자다');
  } finally { await ctx.close(); }
});

// 케이스 20
test('POST /api/distribution/retry: 수신처 kind가 바뀐 상태면 409 kind-changed, FS 0회', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    const articleId = seedArticle(ctx.db);
    seedFailure(ctx.db, { targetId, kind: 'press' });
    createDistributionTargetModel(ctx.db).update(targetId, { kind: 'nonpress' });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { articleId, targetId } });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { ok: false, reason: 'kind-changed' });
    assert.equal(fsCallCount(ctx), 0, '엠바고 파기 차단 — 아무것도 쓰지 않는다');
  } finally { await ctx.close(); }
});
