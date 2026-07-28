// 시점 배부(tick) transport 테스트 — POST /api/distribution/tick (phase 48, ADR-008 (3)).
// 계약: Z 전용 세션 게이트(미인증 401 / 비-Z 403) → spool-disabled(400) → busy(409, 프로세스 내 단일 실행) →
//   200 정상 배부. 라우트는 위임만 한다(ADR-006) — 시각 판정/엠바고 비교는 서비스가 강제한다.
// CRITICAL(ADR-004): acting role은 검증된 세션에서만 도출 — body의 role/now는 무시된다.
// 신호 책임(ADR-005): 이 라우트는 status 전이가 있을 때만 notifyChange('status')를 호출한다.

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
const PAST_EMBARGO = '2000-01-01T00:00:00Z';
const FUTURE_EMBARGO = '2999-01-01T00:00:00Z';

const END_MARKUP = JSON.stringify({
  format: 'yh-editor', version: 1,
  blocks: [{ type: 'text', text: '제목' }, { type: 'text', text: '본문' }, { type: 'text', text: '(끝)' }],
});

// 실제 파일시스템을 건드리지 않는 가짜 spoolFs — 3종 호출 인자를 기록한다.
function fakeSpoolFs() {
  const calls = { mkdir: [], writeFile: [], rename: [] };
  const op = (name) => async (...args) => { calls[name].push(args); };
  return { calls, mkdir: op('mkdir'), writeFile: op('writeFile'), rename: op('rename') };
}

// writeFile을 외부에서 resolve하는 deferred로 만든다 — 첫 tick이 스풀 쓰기에서 대기하게 해
// 두 번째 tick이 busy(409)로 거부되는지 결정적으로 검증한다.
function deferredSpoolFs() {
  const calls = { mkdir: [], writeFile: [], rename: [] };
  let resolveWrite;
  const gate = new Promise((resolve) => { resolveWrite = resolve; });
  return {
    calls,
    mkdir: async (...args) => { calls.mkdir.push(args); },
    writeFile: async (...args) => { calls.writeFile.push(args); await gate; },
    rename: async (...args) => { calls.rename.push(args); },
    releaseWrite: () => resolveWrite(),
  };
}

async function start({ env = ENV, spoolFs } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env, spoolFs });
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

async function loginAs(ctx, role, userId) {
  seedUser(ctx.db, { userId, name: userId, role, department: '사회부', password: 'pw' });
  return (await login(ctx.base, userId, 'pw')).sessionId;
}

// EPS 기사 1건을 만든다 — 1차 엠바고만 설정해 송고 즉시 배부 없이 RDS→EPS로 진입시킨다
// (articleService.distributionKindsForSend: 1차만 설정이면 즉시 배부 없음 — press는 tick 몫).
async function seedEpsArticle(ctx, zsid, embargoAt) {
  const created = await api(ctx.base, 'POST', '/api/articles', {
    sid: zsid,
    body: {
      title: '제목', markupVersion: END_MARKUP, author: 'kim', department: '사회부', embargoAt,
    },
  });
  assert.equal(created.status, 200);
  const { articleId } = created.body;
  const sent = await api(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
    sid: zsid, body: { action: 'send' },
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, 'EPS');
  return articleId;
}

async function getArticleStatus(ctx, sid, articleId) {
  const r = await api(ctx.base, 'GET', `/api/articles/${articleId}`, { sid });
  assert.equal(r.status, 200);
  return r.body.contents.status;
}

test('POST /api/distribution/tick: 세션 헤더 없음 → 401 unauthenticated', async () => {
  const ctx = await start();
  try {
    const r = await api(ctx.base, 'POST', '/api/distribution/tick');
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { ok: false, reason: 'unauthenticated' });
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: role R/D는 403 forbidden', async () => {
  const ctx = await start();
  try {
    for (const role of ['R', 'D']) {
      const sid = await loginAs(ctx, role, `user-${role}`);
      const r = await api(ctx.base, 'POST', '/api/distribution/tick', { sid });
      assert.equal(r.status, 403, `role ${role}`);
      assert.equal(r.body.reason, 'forbidden');
    }
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: role Z + DIST_SPOOL_DIR 미설정 → 400 spool-disabled', async () => {
  const ctx = await start({ env: ENV }); // DIST_SPOOL_DIR 없음.
  try {
    const sid = await loginAs(ctx, 'Z', 'admin');
    const r = await api(ctx.base, 'POST', '/api/distribution/tick', { sid });
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, 'spool-disabled');
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: 과거 1차 엠바고 EPS 기사 → 200, press 배부 + DPS 완결 전이', async () => {
  const spoolFs = fakeSpoolFs();
  const ctx = await start({ env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, spoolFs });
  try {
    const zsid = await loginAs(ctx, 'Z', 'admin');
    const targetCreated = await api(ctx.base, 'POST', '/api/distribution-targets', {
      sid: zsid, body: { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
    });
    assert.equal(targetCreated.status, 200);

    const articleId = await seedEpsArticle(ctx, zsid, PAST_EMBARGO);
    assert.equal(await getArticleStatus(ctx, zsid, articleId), 'EPS');

    const r = await api(ctx.base, 'POST', '/api/distribution/tick', { sid: zsid });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.distributed.length, 1);
    assert.equal(r.body.distributed[0].articleId, articleId);
    assert.deepEqual(r.body.distributed[0].kinds, ['press']);
    assert.deepEqual(r.body.transitioned, [articleId]);
    assert.deepEqual(r.body.failed, []);

    assert.equal(await getArticleStatus(ctx, zsid, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: 멱등 — 연속 2회 중 2번째는 distributed 빈 배열, 파일 쓰기 재발생 없음', async () => {
  const spoolFs = fakeSpoolFs();
  const ctx = await start({ env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, spoolFs });
  try {
    const zsid = await loginAs(ctx, 'Z', 'admin');
    await api(ctx.base, 'POST', '/api/distribution-targets', {
      sid: zsid, body: { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
    });
    const articleId = await seedEpsArticle(ctx, zsid, PAST_EMBARGO);

    const first = await api(ctx.base, 'POST', '/api/distribution/tick', { sid: zsid });
    assert.equal(first.status, 200);
    assert.equal(first.body.distributed.length, 1);
    const writesAfterFirst = spoolFs.calls.writeFile.length;
    assert.equal(writesAfterFirst, 1);

    const second = await api(ctx.base, 'POST', '/api/distribution/tick', { sid: zsid });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.distributed, []);
    assert.equal(spoolFs.calls.writeFile.length, writesAfterFirst, '2번째 tick은 파일을 다시 쓰지 않는다');
    assert.equal(await getArticleStatus(ctx, zsid, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: 중첩 호출 → 두 번째는 409 busy, 첫 번째만 스풀에 기록된다', async () => {
  const spoolFs = deferredSpoolFs();
  const ctx = await start({ env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, spoolFs });
  try {
    const zsid = await loginAs(ctx, 'Z', 'admin');
    await api(ctx.base, 'POST', '/api/distribution-targets', {
      sid: zsid, body: { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
    });
    const articleId = await seedEpsArticle(ctx, zsid, PAST_EMBARGO);

    // 첫 tick을 시작하되 응답을 기다리지 않는다 — writeFile에서 대기 중이다.
    const firstPromise = api(ctx.base, 'POST', '/api/distribution/tick', { sid: zsid });
    // writeFile 호출까지 확실히 도달하도록 잠깐 마이크로태스크를 양보한다.
    await new Promise((resolve) => setImmediate(resolve));

    const second = await api(ctx.base, 'POST', '/api/distribution/tick', { sid: zsid });
    assert.equal(second.status, 409);
    assert.deepEqual(second.body, { ok: false, reason: 'busy' });

    spoolFs.releaseWrite();
    const first = await firstPromise;
    assert.equal(first.status, 200);
    assert.equal(first.body.distributed.length, 1);

    assert.equal(spoolFs.calls.writeFile.length, 1, '중복 스풀 기록이 없어야 한다');
    assert.equal(await getArticleStatus(ctx, zsid, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: 미래 시각 엠바고만 있는 EPS 기사는 배부되지 않는다', async () => {
  const spoolFs = fakeSpoolFs();
  const ctx = await start({ env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, spoolFs });
  try {
    const zsid = await loginAs(ctx, 'Z', 'admin');
    await api(ctx.base, 'POST', '/api/distribution-targets', {
      sid: zsid, body: { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
    });
    const articleId = await seedEpsArticle(ctx, zsid, FUTURE_EMBARGO);

    const r = await api(ctx.base, 'POST', '/api/distribution/tick', { sid: zsid });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.distributed, []);
    assert.deepEqual(r.body.transitioned, []);
    assert.equal(spoolFs.calls.writeFile.length, 0);
    assert.equal(await getArticleStatus(ctx, zsid, articleId), 'EPS');
  } finally { await ctx.close(); }
});

test('GET /api/distribution/tick: 존재하지 않는다 (POST만 노출)', async () => {
  const ctx = await start({ env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, spoolFs: fakeSpoolFs() });
  try {
    const zsid = await loginAs(ctx, 'Z', 'admin');
    const r = await api(ctx.base, 'GET', '/api/distribution/tick', { sid: zsid });
    assert.equal(r.status, 404);
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: body role:Z 스푸핑은 세션 없이 통하지 않는다 (신뢰 경계는 세션)', async () => {
  const ctx = await start({ env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, spoolFs: fakeSpoolFs() });
  try {
    const r = await api(ctx.base, 'POST', '/api/distribution/tick', { body: { role: 'Z' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'unauthenticated');
  } finally { await ctx.close(); }
});

test('POST /api/distribution/tick: body.now는 판정에 영향을 주지 않는다 (미래 엠바고는 여전히 미배부)', async () => {
  const spoolFs = fakeSpoolFs();
  const ctx = await start({ env: { ...ENV, DIST_SPOOL_DIR: '/spool/out' }, spoolFs });
  try {
    const zsid = await loginAs(ctx, 'Z', 'admin');
    await api(ctx.base, 'POST', '/api/distribution-targets', {
      sid: zsid, body: { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
    });
    const articleId = await seedEpsArticle(ctx, zsid, FUTURE_EMBARGO);

    const r = await api(ctx.base, 'POST', '/api/distribution/tick', {
      sid: zsid, body: { now: '2099-01-01T00:00:00Z' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.distributed, []);
    assert.equal(await getArticleStatus(ctx, zsid, articleId), 'EPS');
  } finally { await ctx.close(); }
});
