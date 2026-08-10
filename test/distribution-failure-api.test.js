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
// 반환값은 새 행의 historyId다(재전송 식별자 — 목록의 키이자 POST body의 유일한 값).
function seedFailure(db, { articleId = ARTICLE_ID, targetId, kind = 'press', reason = 'spool-write-failed' }) {
  const info = db.prepare(
    `INSERT INTO ArticleHistory (articleId, eventType, action, targetId, reason, actorUserId, createdAt)
     VALUES (?, 'distribute-failed', ?, ?, ?, 'sys', '2026-08-06T09:00:00.000Z')`,
  ).run(articleId, kind, targetId, reason);
  return Number(info.lastInsertRowid);
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
    const historyId = seedFailure(ctx.db, { targetId });

    const anon = await retry(ctx, { body: { historyId } });
    assert.equal(anon.status, 401);
    assert.equal(anon.body.reason, 'unauthenticated');

    for (const role of ['R', 'D']) {
      const sid = await loginAs(ctx, role, `u${role}`);
      const r = await retry(ctx, { sid, body: { historyId, role: 'Z' } });
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
    const historyId = seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { historyId } });

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
    seedArticle(ctx.db);
    const historyId = seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    assert.equal((await failures(ctx, { sid: zsid })).body.items.length, 1);
    await retry(ctx, { sid: zsid, body: { historyId } });
    assert.deepEqual((await failures(ctx, { sid: zsid })).body.items, []);
  } finally { await ctx.close(); }
});

// 케이스 12
test('POST /api/distribution/retry: 미해소 실패 행이 아닌 historyId는 404 no-failure, FS 0회', async () => {
  const ctx = await start();
  try {
    seedTarget(ctx.db);
    seedArticle(ctx.db);
    const zsid = await loginAs(ctx, 'Z', 'admin');

    // 존재하지 않는 id·비정수 id 모두 같은 어휘로 거부된다(전역 스캔 봉쇄).
    for (const historyId of [424242, 'abc', '', undefined]) {
      const r = await retry(ctx, { sid: zsid, body: { historyId } });
      assert.equal(r.status, 404, `historyId=${JSON.stringify(historyId)}`);
      assert.deepEqual(r.body, { ok: false, reason: 'no-failure' });
    }
    assert.equal(fsCallCount(ctx), 0);
    assert.deepEqual(ctx.signals, []);
  } finally { await ctx.close(); }
});

// 케이스 13
test('POST /api/distribution/retry: 기사 status가 EEK면 409 status-changed, FS 0회', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    seedArticle(ctx.db, ARTICLE_ID, { status: 'EEK' });
    const historyId = seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { historyId } });
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
    seedArticle(ctx.db);
    const historyId = seedFailure(ctx.db, { targetId });
    createDistributionTargetModel(ctx.db).update(targetId, { active: 'N' });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { historyId } });
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
    const ghostTargetHid = seedFailure(ctx.db, { targetId: 777 });
    seedArticle(ctx.db);
    const noTarget = await retry(ctx, { sid: zsid, body: { historyId: ghostTargetHid } });
    assert.equal(noTarget.status, 404);
    assert.equal(noTarget.body.reason, 'not-found');

    // 기사 행 없음.
    const targetId = seedTarget(ctx.db);
    const ghostArticleHid = seedFailure(ctx.db, { articleId: 'AKR-GHOST', targetId });
    const noArticle = await retry(ctx, { sid: zsid, body: { historyId: ghostArticleHid } });
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
    seedArticle(ctx.db);
    const historyId = seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { historyId } });
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

// 케이스 18(실패·거부는 무신호 + 서버측 장애 5xx — 코드리뷰 반려 [low]: 폴백 400은 운영 cron·화면이
// 클라이언트 잘못으로 오독한다. tick-failed:500 선례를 따른다.)
test('POST /api/distribution/retry: 스풀 기록 실패는 500 — SSE 신호 없음', async () => {
  const ctx = await start({ spoolFs: fakeSpoolFs({ fail: true }) });
  try {
    const targetId = seedTarget(ctx.db);
    seedArticle(ctx.db);
    const historyId = seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { historyId } });
    assert.equal(r.status, 500, 'spool-write-failed는 서버측 장애다(tick-failed:500 선례)');
    assert.deepEqual(r.body, { ok: false, reason: 'spool-write-failed' });
    assert.deepEqual(ctx.signals, [], '실패에는 신호를 보내지 않는다');

    const denied = await retry(ctx, { body: { historyId } });
    assert.equal(denied.status, 401);
    assert.deepEqual(ctx.signals, [], '거부에도 신호 없음');
  } finally { await ctx.close(); }
});

// 케이스 18-1 (코드리뷰 반려 [low] — invalid-spool-dir도 재전송 경로에서는 서버측 장애다.
// 배부 대상 CRUD의 입력 검증 400(distribution-targets-api)과 같은 토큰이지만 문맥이 다르다 —
// 저장된 spoolDir가 잘못된 것은 클라이언트가 고칠 수 있는 요청 오류가 아니다.)
test('POST /api/distribution/retry: 저장된 spoolDir가 무효(invalid-spool-dir)면 500', async () => {
  const ctx = await start();
  try {
    // 모델 직접 시드로 검증을 우회한 무효 slug — spoolWriter의 sanitize가 거부한다.
    const targetId = seedTarget(ctx.db, { spoolDir: 'BAD DIR' });
    seedArticle(ctx.db);
    const historyId = seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { historyId } });
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { ok: false, reason: 'invalid-spool-dir' });
    assert.deepEqual(ctx.signals, []);
  } finally { await ctx.close(); }
});

// 케이스 19
test('POST /api/distribution/retry: historyId를 JSON 문자열로 보내도 정상 처리된다 (HTTP 경계 정규화)', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    seedArticle(ctx.db);
    const historyId = seedFailure(ctx.db, { targetId });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { historyId: String(historyId) } });
    assert.equal(r.status, 200);
    assert.strictEqual(r.body.targetId, targetId, '응답 targetId는 숫자다');
  } finally { await ctx.close(); }
});

// 코드리뷰 반려 [high] — stale-cycle의 HTTP 매핑(409 상태 충돌).
test('POST /api/distribution/retry: 재송고 경계 이전 사이클의 실패는 409 stale-cycle, FS 0회', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    seedArticle(ctx.db, ARTICLE_ID, { status: 'DES' });
    const historyId = seedFailure(ctx.db, { targetId });
    // 실패 행 **이후**의 송고 이력 — 새 배부 사이클이 열렸다(보류→엠바고 재설정→재송고).
    ctx.db.prepare(
      `INSERT INTO ArticleHistory (articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt)
       VALUES (?, 'status', 'send', 'RDS', 'DES', 'desk', '2026-08-06T09:10:00.000Z')`,
    ).run(ARTICLE_ID);
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { historyId } });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { ok: false, reason: 'stale-cycle' });
    assert.equal(fsCallCount(ctx), 0, '이전 사이클 실패로는 아무것도 쓰지 않는다');
    assert.deepEqual(ctx.signals, []);
  } finally { await ctx.close(); }
});

// 보강 케이스 (테스트 게이트 — 실 결선 E2E 루프: tick 실패 영속 → 목록 등장 → 재전송 → 해소)
// 위 케이스들은 실패 행을 SQL로 직접 시드한다 — 이 케이스만 실제 tick(distributionService의
// recordTargetFailure 결선)으로 실패를 만들어, step0~5의 결선 전체가 한 줄로 이어짐을 잠근다.
test('E2E: tick 중 스풀 실패가 영속되고 목록에 나타나며, 재전송으로 해소된다 (distributedAt 갱신 + append-only)', async () => {
  // 도중에 복구할 수 있는 스풀 FS — tick 시점엔 mkdir 실패, 재전송 시점엔 성공.
  const calls = { mkdir: [], writeFile: [], rename: [] };
  const state = { fail: true };
  const op = (name) => async (...args) => { calls[name].push(args); };
  const spoolFs = {
    calls,
    mkdir: async (...args) => { if (state.fail) throw new Error('권한 없음'); calls.mkdir.push(args); },
    writeFile: op('writeFile'),
    rename: op('rename'),
  };
  const ctx = await start({ spoolFs });
  try {
    const targetId = seedTarget(ctx.db);
    // 1차 엠바고 도래 기사(DES + embargoAt < NOW) — tick 스캔 대상.
    createArticleModel(ctx.db).insert({
      article: { articleId: ARTICLE_ID, title: '제목', markupVersion: MARKUP },
      contents: {
        articleId: ARTICLE_ID, title: '제목', author: 'kim', sender: 'desk', status: 'DES',
        createdAt: '2026-08-06T08:00:00.000Z', sentAt: '2026-08-06T08:10:00.000Z',
        embargoAt: '2026-08-06T09:00:00.000Z',
      },
    });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    // (1) tick — 스풀 쓰기 실패가 distribute-failed 행으로 영속된다(서버 재시작에도 남는 복구 근거).
    const t = await api(ctx.base, 'POST', '/api/distribution/tick', { sid: zsid, body: {} });
    assert.equal(t.status, 200);
    assert.equal(t.body.distributed.length, 0);
    assert.equal(t.body.failed.length, 1);
    const persisted = ctx.db.prepare("SELECT * FROM ArticleHistory WHERE eventType = 'distribute-failed'").all();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].targetId, targetId, 'targetId가 숫자로 영속된다');
    assert.equal(persisted[0].reason, 'spool-write-failed');
    assert.equal(persisted[0].actorUserId, 'admin', 'tick 실행자의 세션 userId가 stamp된다');

    // (2) 실패 목록 등장 — kindDistributed=false(그 kind의 distribute 행 없음 → 중복 경고 대상).
    const l1 = await failures(ctx, { sid: zsid });
    assert.equal(l1.status, 200);
    assert.equal(l1.body.items.length, 1);
    assert.equal(l1.body.items[0].articleId, ARTICLE_ID);
    assert.equal(l1.body.items[0].targetId, targetId);
    assert.equal(l1.body.items[0].kind, 'press');
    assert.equal(l1.body.items[0].kindDistributed, false);

    // (3) FS 복구 후 재전송 — 목록의 키(historyId) 그대로 재전송한다. 200 + distributedAt present-only 갱신.
    state.fail = false;
    const r = await retry(ctx, { sid: zsid, body: { historyId: l1.body.items[0].historyId } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, articleId: ARTICLE_ID, targetId, kind: 'press', at: NOW });
    const contents = ctx.db.prepare('SELECT distributedAt FROM Contents WHERE articleId = ?').get(ARTICLE_ID);
    assert.equal(contents.distributedAt, NOW);

    // (4) 해소 — 목록에서 사라지되 원장은 append-only(실패 행 보존 + 재전송 행 추가, 삭제 0).
    const l2 = await failures(ctx, { sid: zsid });
    assert.deepEqual(l2.body.items, []);
    const events = ctx.db.prepare(
      "SELECT eventType FROM ArticleHistory WHERE eventType IN ('distribute-failed','distribute-retry') ORDER BY id",
    ).all().map((e) => e.eventType);
    assert.deepEqual(events, ['distribute-failed', 'distribute-retry']);
  } finally { await ctx.close(); }
});

// 케이스 20
test('POST /api/distribution/retry: 수신처 kind가 바뀐 상태면 409 kind-changed, FS 0회', async () => {
  const ctx = await start();
  try {
    const targetId = seedTarget(ctx.db);
    seedArticle(ctx.db);
    const historyId = seedFailure(ctx.db, { targetId, kind: 'press' });
    createDistributionTargetModel(ctx.db).update(targetId, { kind: 'nonpress' });
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await retry(ctx, { sid: zsid, body: { historyId } });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { ok: false, reason: 'kind-changed' });
    assert.equal(fsCallCount(ctx), 0, '엠바고 파기 차단 — 아무것도 쓰지 않는다');
  } finally { await ctx.close(); }
});
