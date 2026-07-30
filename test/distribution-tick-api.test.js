// 엠바고 시점 배부 tick transport 테스트 — POST /api/distribution/tick (Z 전용, ADR-008 (3)).
// 계약: 앱에 타이머를 두지 않고 외부 운영 cron이 **Z 세션으로** 이 엔드포인트를 주기 호출한다(pull).
// CRITICAL 잠그는 것:
//   (1) 인가는 검증된 세션에서만 도출한다 — body의 role:'Z'는 무시된다(ADR-004). 게이트가 스풀 설정 판정보다 먼저다.
//   (2) 부수효과(실제 배부)가 있는 연산이므로 GET으로는 열지 않는다(프리페치/크롤러 트리거 금지).
//   (3) 200 응답 본문에 서버 파일시스템 경로(spoolDir/스풀 루트)가 실리지 않는다 — tick 서비스의 화이트리스트 투영이
//       transport까지 유지되는지 잠근다.
//   (4) 실제 배부가 있었을 때만 SSE 무효화 신호('status')를 보낸다.
// 스풀 FS 조작은 주입해서 검증한다 — 실제 파일을 만들지 않는다.

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

// 스풀 루트/수신처 폴더 — 경로 구분자가 없는 토큰만 골랐다(응답 위생 단언이 플랫폼에 의존하지 않도록).
const SPOOL_ROOT = '/spool/tickout';
const TARGET_DIR = 'kbstick';

const T1 = '2026-07-30T09:00:00.000Z'; // 1차 엠바고 시각
const NOW = '2026-07-30T09:30:00.000Z'; // tick 실행 시각(도래 후)
const MARKUP = '{"blocks":[{"text":"본문 (끝)"}]}';

// 실제 파일을 만들지 않는 스풀 FS. fail:true면 mkdir이 실패해 전 수신처 쓰기가 실패한다.
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

async function start({ spool = true, spoolFs = fakeSpoolFs(), now = () => NOW } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, {
    sessionService,
    env: spool ? { ...ENV, DIST_SPOOL_DIR: SPOOL_ROOT } : ENV,
    spoolFs,
    now,
  });
  const app = createApp({ controllers, sessionService });
  // SSE 무효화 신호를 기록한다(실제 배부가 있을 때만 보내야 한다).
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

// 활성 수신처 1곳(언론사).
function seedTarget(db) {
  return createDistributionTargetModel(db).insert({
    name: 'KBS', kind: 'press', spoolDir: TARGET_DIR, active: 'Y', createdAt: T1,
  });
}

// 송고까지 끝나 배부만 남은 엠바고 기사(1차만) 1건.
function seedDueArticle(db, articleId = 'AKR202607300000000001') {
  createArticleModel(db).insert({
    article: { articleId, title: '제목', markupVersion: MARKUP },
    contents: {
      articleId,
      title: '제목',
      author: 'kim',
      sender: 'desk',
      status: 'DES',
      createdAt: '2026-07-30T08:00:00.000Z',
      sentAt: '2026-07-30T08:10:00.000Z',
      embargoAt: T1,
    },
  });
  return articleId;
}

const tick = (ctx, opts) => api(ctx.base, 'POST', '/api/distribution/tick', opts);

test('POST /api/distribution/tick: 미인증은 401 unauthenticated이고 배부하지 않는다', async () => {
  const ctx = await start();
  try {
    seedTarget(ctx.db);
    seedDueArticle(ctx.db);

    const r = await tick(ctx);
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'unauthenticated');
    assert.deepEqual(ctx.spoolFs.calls.writeFile, [], '미인증 호출은 스풀에 쓰지 않는다');
    assert.deepEqual(ctx.signals, []);
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: 비-Z(R/D)는 403 forbidden — body의 role:"Z"는 무시된다(ADR-004)', async () => {
  const ctx = await start();
  try {
    seedTarget(ctx.db);
    seedDueArticle(ctx.db);

    for (const role of ['R', 'D']) {
      const sid = await loginAs(ctx, role, `u${role}`);
      // 클라이언트가 role을 위조해도 acting role은 세션에서만 도출된다.
      const r = await tick(ctx, { sid, body: { role: 'Z' } });
      assert.equal(r.status, 403, `${role} 세션`);
      assert.equal(r.body.reason, 'forbidden');
    }
    assert.deepEqual(ctx.spoolFs.calls.writeFile, [], '비-Z 호출은 스풀에 쓰지 않는다');
    assert.deepEqual(ctx.signals, []);
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: DIST_SPOOL_DIR 미설정이면 Z에게 503 spool-disabled', async () => {
  const ctx = await start({ spool: false });
  try {
    seedTarget(ctx.db);
    seedDueArticle(ctx.db);

    const zsid = await loginAs(ctx, 'Z', 'admin');
    const r = await tick(ctx, { sid: zsid });
    assert.equal(r.status, 503);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'spool-disabled');

    // 인가 게이트가 먼저다 — 비-Z에게는 배부 설정 상태조차 알려주지 않는다.
    const rsid = await loginAs(ctx, 'R', 'kim');
    const nz = await tick(ctx, { sid: rsid });
    assert.equal(nz.status, 403);
    assert.equal(nz.body.reason, 'forbidden');

    assert.deepEqual(ctx.spoolFs.calls.writeFile, []);
    assert.deepEqual(ctx.signals, []);
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: Z는 도래한 엠바고를 배부하고 요약을 받는다(재호출은 멱등)', async () => {
  const ctx = await start();
  try {
    seedTarget(ctx.db);
    const articleId = seedDueArticle(ctx.db);
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r1 = await tick(ctx, { sid: zsid });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.ok, true);
    assert.equal(r1.body.at, NOW, '시각은 주입된 서버 시계(ISO-8601 문자열)에서만 온다');
    assert.equal(r1.body.scanned, 1);
    assert.deepEqual(r1.body.distributed, [{ articleId, kinds: ['press'], status: 'DPS' }]);
    assert.deepEqual(r1.body.failed, []);
    assert.deepEqual(r1.body.invalid, []);
    assert.equal(ctx.spoolFs.calls.rename.length, 1, '수신처 1곳에 실제로 스풀 파일을 게시한다');
    assert.deepEqual(ctx.signals, ['status'], '배부가 있었으므로 무효화 신호 1건');
    // 배부 사실이 DB에 남는다(배부 시각 + append-only 이력).
    const row = ctx.db.prepare('SELECT status, distributedAt FROM Contents WHERE articleId = ?').get(articleId);
    assert.equal(row.status, 'DPS');
    assert.notEqual(row.distributedAt, null);

    // 멱등 — 같은 시각의 재호출은 재배부도, 신호도 만들지 않는다.
    const r2 = await tick(ctx, { sid: zsid });
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.body.distributed, []);
    assert.equal(ctx.spoolFs.calls.rename.length, 1);
    assert.deepEqual(ctx.signals, ['status'], '변경이 없으면 신호를 보내지 않는다');
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: 실패 항목에 서버 파일시스템 경로가 실리지 않는다', async () => {
  const ctx = await start({ spoolFs: fakeSpoolFs({ fail: true }) });
  try {
    const targetId = seedTarget(ctx.db);
    const articleId = seedDueArticle(ctx.db);
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await tick(ctx, { sid: zsid });
    assert.equal(r.status, 200, '기사 단위 배부 실패는 500이 아니라 요약으로 보고한다');
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.distributed, [], '쓰기가 실패했으므로 승격도 없다');
    assert.deepEqual(r.body.failed, [{
      articleId, targetId, kind: 'press', reason: 'spool-write-failed',
    }]);

    // 응답 위생 — 식별자와 사유만. 스풀 루트/수신처 폴더/파일 경로는 어디에도 없어야 한다.
    const raw = JSON.stringify(r.body);
    assert.equal(raw.includes('spoolDir'), false, '응답에 spoolDir 키가 없어야 한다');
    assert.equal(raw.includes('tickout'), false, '응답에 스풀 루트 경로가 없어야 한다');
    assert.equal(raw.includes(TARGET_DIR), false, '응답에 수신처 폴더명이 없어야 한다');
    assert.equal(raw.includes('.json'), false, '응답에 스풀 파일 경로가 없어야 한다');

    // 실패했으므로 상태·배부 시각은 그대로다(거짓 완결 금지).
    const row = ctx.db.prepare('SELECT status, distributedAt FROM Contents WHERE articleId = ?').get(articleId);
    assert.equal(row.status, 'DES');
    assert.equal(row.distributedAt, null);
    assert.deepEqual(ctx.signals, [], '배부가 0건이면 무효화 신호도 없다');
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: GET으로는 노출하지 않는다(부수효과 연산)', async () => {
  const ctx = await start();
  try {
    seedTarget(ctx.db);
    seedDueArticle(ctx.db);
    const zsid = await loginAs(ctx, 'Z', 'admin');

    const r = await api(ctx.base, 'GET', '/api/distribution/tick', { sid: zsid });
    assert.equal(r.status, 404);
    assert.deepEqual(ctx.spoolFs.calls.writeFile, [], 'GET은 배부를 트리거하지 않는다');
    assert.deepEqual(ctx.signals, []);
  } finally { await ctx.close(); }
});
