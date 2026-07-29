// 시점/엠바고 배부 tick transport 테스트 — POST /api/distribution/tick (phase 48 step3, ADR-008 (3)).
// 계약: Z 전용 세션 게이트(미인증 401 / 비-Z 403), 스풀 미설정 503, 동시 겹침 409, 잘못된 시계 400.
//   라우트는 controllers.distribution.runTick(sessionToken)에 위임만 한다(ADR-006 얇은 transport).
// CRITICAL(ADR-004/ADR-008): req.body를 읽지 않는다 — 대상 기사·kind·시각·actor·role 주입은 통하지 않는다.
//   배부/전이가 1건 이상일 때만 SSE 무효화 신호(kind:'distribute')를 재발행한다(ADR-005 — 0건이면 미발행).
// 가짜 spoolFs 주입으로 실제 파일을 쓰지 않는다(distributionService/spoolWriter는 주입된 FS만 만진다).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };
// 항상 과거(오프셋 포함 ISO) — 실제 시계(주입 없음)로도 도래로 인정된다.
const PAST = '2020-01-01T00:00:00.000Z';

// 실제 파일을 쓰지 않는 가짜 스풀 FS — writeFile 호출을 기록해 "스풀에 몇 건 기록됐는가"를 센다.
function fakeSpoolFs() {
  const files = [];
  return {
    files,
    mkdir: async () => {},
    writeFile: async (path, data) => { files.push({ path, data }); },
    rename: async () => {},
  };
}

async function start({ withSpool = true } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const spoolFs = fakeSpoolFs();
  const env = withSpool ? { ...ENV, DIST_SPOOL_DIR: 'spool' } : { ...ENV };
  const controllers = createControllers(db, { sessionService, env, spoolFs });
  const app = createApp({ controllers, sessionService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, spoolFs, base, close: () => new Promise((r) => server.close(r)) };
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

// 배부 가능한 EPS 엠바고 기사(press 1차, 과거·오프셋 포함 ISO)를 db에 직접 넣는다.
function insertEps(db, articleId) {
  createArticleModel(db).insert({
    article: { articleId, title: '제목', markupVersion: '{"blocks":[{"text":"본문"}]}' },
    contents: {
      articleId, title: '제목', author: 'r1', status: 'EPS',
      createdAt: PAST, sentAt: PAST, embargoAt: PAST,
    },
  });
}

// /api/stream을 열어 청크를 누적하고, 특정 문자열이 나타날 때까지 대기하는 헬퍼를 돌려준다.
function openStream(base, headers) {
  const u = new URL(`${base}/api/stream`);
  let buf = '';
  const waiters = [];
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers },
      (res) => {
        if (res.statusCode !== 200) { reject(new Error(`stream status ${res.statusCode}`)); return; }
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          for (const w of [...waiters]) {
            if (buf.includes(w.needle)) { waiters.splice(waiters.indexOf(w), 1); w.hit(); }
          }
        });
        resolve({
          getBuf: () => buf,
          waitFor: (needle, ms = 1500) => new Promise((res2, rej2) => {
            if (buf.includes(needle)) { res2(); return; }
            const t = setTimeout(() => rej2(new Error(`timeout: ${needle}`)), ms);
            waiters.push({ needle, hit: () => { clearTimeout(t); res2(); } });
          }),
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', (e) => { if (e.code === 'ECONNRESET') return; reject(e); });
    req.end();
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('tick: 미인증(세션 없음)은 401 unauthenticated (결과 미노출)', async () => {
  const ctx = await start();
  try {
    const r = await api(ctx.base, 'POST', '/api/distribution/tick');
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'unauthenticated');
    assert.equal(r.body.checked, undefined);
  } finally { await ctx.close(); }
});

test('tick: 비-Z(R/D) 세션은 403 forbidden (tick 결과 미노출)', async () => {
  const ctx = await start();
  try {
    for (const role of ['R', 'D']) {
      const sid = await loginAs(ctx, role, `user-${role}`);
      const r = await api(ctx.base, 'POST', '/api/distribution/tick', { sid });
      assert.equal(r.status, 403, `${role} 상태`);
      assert.equal(r.body.reason, 'forbidden');
      assert.equal(r.body.checked, undefined);
    }
  } finally { await ctx.close(); }
});

test('tick: Z 세션은 200 + {ok,checked,distributed,completed,incomplete} shape', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'Z', 'admin');
    const r = await api(ctx.base, 'POST', '/api/distribution/tick', { sid });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.checked, 0);
    assert.deepEqual(r.body.distributed, []);
    assert.deepEqual(r.body.completed, []);
    assert.deepEqual(r.body.incomplete, []);
  } finally { await ctx.close(); }
});

test('tick: 요청 바디(role/articleId/now/kinds)는 무시된다 — 바디 없이 호출과 동일', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'Z', 'admin');
    // 미래 시각·대상·kind를 주입해도 반출을 일으키지 않는다. EPS 기사가 없으니 checked=0로 동일해야 한다.
    const withBody = await api(ctx.base, 'POST', '/api/distribution/tick', {
      sid,
      body: { role: 'Z', articleId: 'AKR20300101000000001', now: '2030-01-01T00:00:00Z', kinds: ['press', 'nonpress'] },
    });
    const noBody = await api(ctx.base, 'POST', '/api/distribution/tick', { sid });
    assert.equal(withBody.status, 200);
    assert.deepEqual(withBody.body, noBody.body);
    assert.equal(ctx.spoolFs.files.length, 0, '대상 없이 바디 주입만으로는 스풀 기록 0');
  } finally { await ctx.close(); }
});

test('tick: R 세션 + body role:Z 스푸핑은 403 (신뢰 경계는 세션)', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'R', 'rep');
    const r = await api(ctx.base, 'POST', '/api/distribution/tick', { sid, body: { role: 'Z' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, 'forbidden');
  } finally { await ctx.close(); }
});

test('tick: DIST_SPOOL_DIR 미설정 — Z는 503 spool-disabled, 비-Z는 여전히 403(설정 누출 없음)', async () => {
  const ctx = await start({ withSpool: false });
  try {
    const z = await loginAs(ctx, 'Z', 'admin');
    const zr = await api(ctx.base, 'POST', '/api/distribution/tick', { sid: z });
    assert.equal(zr.status, 503);
    assert.equal(zr.body.reason, 'spool-disabled');

    const r = await loginAs(ctx, 'R', 'rep');
    const rr = await api(ctx.base, 'POST', '/api/distribution/tick', { sid: r });
    assert.equal(rr.status, 403, '비-Z는 설정 상태를 알 수 없다 — spool-disabled가 아니라 forbidden');
    assert.equal(rr.body.reason, 'forbidden');
  } finally { await ctx.close(); }
});

test('tick: 엔드투엔드 — 활성 press 수신처 + EPS 엠바고 기사 → 스풀 1건·DPS 전이·이력, 재tick 멱등', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'Z', 'admin');
    // 활성 press 수신처 등록(Z 세션).
    const created = await api(ctx.base, 'POST', '/api/distribution-targets', {
      sid, body: { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
    });
    assert.equal(created.status, 200);

    const A = 'AKR20200101000000001';
    insertEps(ctx.db, A);

    const r = await api(ctx.base, 'POST', '/api/distribution/tick', { sid });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.distributed, [{ articleId: A, kinds: ['press'] }]);
    assert.deepEqual(r.body.completed, [A]);

    assert.equal(ctx.spoolFs.files.length, 1, '가짜 FS에 스풀 파일 1건');
    assert.equal(
      ctx.db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(A).status,
      'DPS',
    );
    const distRows = ctx.db.prepare(
      "SELECT * FROM ArticleHistory WHERE articleId = ? AND eventType = 'distribute'",
    ).all(A);
    assert.equal(distRows.length, 1);
    assert.equal(distRows[0].action, 'press');
    const compRows = ctx.db.prepare(
      "SELECT * FROM ArticleHistory WHERE articleId = ? AND eventType = 'status' AND action = 'embargoComplete'",
    ).all(A);
    assert.equal(compRows.length, 1);
    assert.equal(compRows[0].fromStatus, 'EPS');
    assert.equal(compRows[0].toStatus, 'DPS');

    // 재tick: 이미 DPS라 후보 아님 → 파일 쓰기 추가 0(멱등).
    const r2 = await api(ctx.base, 'POST', '/api/distribution/tick', { sid });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.checked, 0);
    assert.equal(ctx.spoolFs.files.length, 1, '멱등 — 추가 스풀 쓰기 0');
  } finally { await ctx.close(); }
});

test('tick: SSE — 배부 발생 시 change(kind:distribute) 발행, 0건 tick은 미발행', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'Z', 'admin');
    await api(ctx.base, 'POST', '/api/distribution-targets', {
      sid, body: { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
    });

    const stream = await openStream(ctx.base, { 'x-session-id': sid });
    try {
      await stream.waitFor('event: ready');

      // (a) 배부 0건 tick — change 신호가 없어야 한다.
      const empty = await api(ctx.base, 'POST', '/api/distribution/tick', { sid });
      assert.equal(empty.body.checked, 0);
      await delay(200);
      assert.ok(
        !stream.getBuf().includes('"kind":"distribute"'),
        '배부 0건 tick은 notifyChange를 발행하지 않는다',
      );

      // (b) 배부 발생 tick — change(kind:distribute) 신호가 온다.
      insertEps(ctx.db, 'AKR20200101000000002');
      const hit = await api(ctx.base, 'POST', '/api/distribution/tick', { sid });
      assert.deepEqual(hit.body.completed, ['AKR20200101000000002']);
      await stream.waitFor('"kind":"distribute"');
    } finally {
      stream.close();
    }
  } finally { await ctx.close(); }
});

test('tick: GET /api/distribution/tick은 존재하지 않는다 (실행은 POST만)', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'Z', 'admin');
    const r = await api(ctx.base, 'GET', '/api/distribution/tick', { sid });
    assert.equal(r.status, 404);
    assert.equal(r.body?.ok, undefined);
  } finally { await ctx.close(); }
});
