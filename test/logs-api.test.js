// 로그 노출 API 테스트 (26-log-viewer step2) — /api/logs/digest, /api/logs/stream.
// 핵심 보안 단언: 둘 다 Z 전용(미인증 401, 비-Z 403) — /api/stream(로그인만)과 달리 role 게이트가 있다.
// stream은 text/event-stream + ready + 버퍼 replay(event: log), 접속 종료 시 구독 해제(누수 가드).
// digest는 { ok, items } — 가짜 시계를 주입해 [전날 06:00, 당일 06:00) KST 창을 결정적으로 검증한다.
// SSE 청크 분할은 프로토콜상 보장되지 않으므로 until 조건까지 data를 누적해 읽는다(sse-auth.test.js 확장).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createLogService } from '../src/services/logService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp } from '../server/index.js';

async function start({ logService = createLogService() } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService });
  const app = createApp({ controllers, sessionService, logService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, logService, base, close: () => new Promise((r) => server.close(r)) };
}

function seedUser(db, user) {
  createUserModel(db).insert({ active: 'Y', ...user, password: bcrypt.hashSync(user.password, 10) });
}

async function login(base, userId, password) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, password }),
  });
  return (await res.json()).sessionId;
}

// SSE 경로를 저수준 GET — 200이면 until(buf)이 참이 될 때까지 data를 누적한 뒤 소켓을 끊는다.
// 첫 청크 coalescing에 의존하지 않는다(청크 분할은 SSE 프로토콜상 보장되지 않음). 비-200은 바디 수집.
function streamGet(base, path, { headers = {}, until = () => true, timeoutMs = 2000 } = {}) {
  const u = new URL(`${base}${path}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        const status = res.statusCode;
        const contentType = res.headers['content-type'] ?? '';
        let buf = '';
        res.setEncoding('utf8');
        if (status !== 200) {
          res.on('data', (c) => { buf += c; });
          res.on('end', () => resolve({ status, contentType, body: buf }));
          return;
        }
        let timer;
        const finish = () => {
          clearTimeout(timer);
          req.destroy();
          resolve({ status, contentType, body: buf });
        };
        timer = setTimeout(finish, timeoutMs);
        res.on('data', (c) => {
          buf += c;
          if (until(buf)) finish();
        });
      },
    );
    req.on('error', (e) => {
      // until 충족 후 destroy로 발생하는 소켓 종료 에러는 무시(이미 resolve됨).
      if (e.code === 'ECONNRESET') return;
      reject(e);
    });
    req.end();
  });
}

// 조건이 참이 될 때까지 짧게 폴링한다(close 전파는 비동기 — 구독 해제 단언용).
async function waitFor(cond, { timeoutMs = 2000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

// KST 벽시계(y,mo,d,h,mi) → epoch ms. logService 기본 tzOffsetMinutes=540과 정렬.
const KST_MS = 540 * 60 * 1000;
const kst = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - KST_MS;

// --- digest 인가 ---

test('digest: 미인증이면 401', async () => {
  const ctx = await start();
  try {
    const res = await fetch(`${ctx.base}/api/logs/digest`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, reason: 'unauthenticated' });
  } finally { await ctx.close(); }
});

test('digest: 비-Z(R) 로그인은 403 forbidden — 핵심 보안 단언(200이 아님)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const res = await fetch(`${ctx.base}/api/logs/digest`, { headers: { 'x-session-id': sid } });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, reason: 'forbidden' });
  } finally { await ctx.close(); }
});

test('digest: Z는 200 + { ok, items } — 창 내부 시드 포함, 창 밖(경계 이전/이후) 제외', async () => {
  // 가변 가짜 시계 — 창 내부 시각에 시드하고, 경계(당일 06:00 KST)를 지나서 digest를 호출한다.
  // 기본 시계로 시드하면 now의 로그는 항상 [직전 06:00, 당일 06:00) 창 밖이라 items가 빈다.
  let clock = kst(2026, 7, 5, 5, 59); // 창 시작(07-05 06:00) 직전 — 제외돼야 한다.
  const logService = createLogService({ now: () => clock });
  logService.info('digest-seed-before-window');
  clock = kst(2026, 7, 5, 12, 0); // 창 내부(전날 정오 KST).
  logService.info('digest-seed-inside-a');
  logService.warn('digest-seed-inside-b');
  clock = kst(2026, 7, 6, 9, 0); // 당일 09:00 KST — 경계(06:00) 이후. 이후 로그는 다음 창.

  const ctx = await start({ logService });
  try {
    seedUser(ctx.db, { userId: 'adm', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw'); // 이 시점 로그(ts=09:00)는 창 밖.

    const res = await fetch(`${ctx.base}/api/logs/digest`, { headers: { 'x-session-id': sid } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.items));

    const messages = body.items.map((r) => r.message);
    assert.ok(messages.includes('digest-seed-inside-a'), `창 내부 시드가 있어야 한다: ${JSON.stringify(messages)}`);
    assert.ok(messages.includes('digest-seed-inside-b'));
    assert.ok(!messages.includes('digest-seed-before-window'), '창 시작 이전 로그는 제외돼야 한다');
    assert.ok(!messages.some((m) => m.includes('login ok')), '경계 이후(당일 09:00) 로그는 제외돼야 한다');

    // record shape — step0 계약({ seq, ts, level, message, line }) 그대로 실린다.
    const rec = body.items.find((r) => r.message === 'digest-seed-inside-a');
    assert.equal(rec.level, 'INFO');
    assert.match(rec.line, /^\[2026-07-05 12:00:00\] \[INFO\] digest-seed-inside-a$/);
    assert.equal(typeof rec.seq, 'number');
    assert.equal(typeof rec.ts, 'number');
  } finally { await ctx.close(); }
});

// --- stream 인가 ---

test('stream: 미인증이면 401 — 스트림을 열지 않는다(event-stream 아님)', async () => {
  const ctx = await start();
  try {
    const r = await streamGet(ctx.base, '/api/logs/stream');
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.contentType, /text\/event-stream/);
  } finally { await ctx.close(); }
});

test('stream: 비-Z(R)는 403 — /api/stream(로그인만)과 다른 role 게이트(핵심 보안 단언)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const r = await streamGet(ctx.base, '/api/logs/stream', { headers: { 'x-session-id': sid } });
    assert.equal(r.status, 403);
    assert.doesNotMatch(r.contentType, /text\/event-stream/);
    assert.deepEqual(JSON.parse(r.body), { ok: false, reason: 'forbidden' });
  } finally { await ctx.close(); }
});

test('stream: Z는 200 event-stream + ready + 접속 전 시드가 event: log로 replay된다', async () => {
  const logService = createLogService();
  logService.info('stream-replay-seed-a');
  logService.warn('stream-replay-seed-b');

  const ctx = await start({ logService });
  try {
    seedUser(ctx.db, { userId: 'adm', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw');

    const r = await streamGet(ctx.base, '/api/logs/stream', {
      headers: { 'x-session-id': sid },
      until: (buf) => buf.includes('stream-replay-seed-b'),
    });
    assert.equal(r.status, 200);
    assert.match(r.contentType, /text\/event-stream/);
    assert.match(r.body, /event: ready/);
    assert.match(r.body, /event: log/);

    // replay된 record JSON을 파싱해 step0 계약 shape을 확인한다.
    const dataLine = r.body.split('\n').find((l) => l.startsWith('data: ') && l.includes('stream-replay-seed-a'));
    assert.ok(dataLine, `replay data 라인이 있어야 한다: ${r.body}`);
    const rec = JSON.parse(dataLine.slice('data: '.length));
    assert.equal(rec.message, 'stream-replay-seed-a');
    assert.equal(rec.level, 'INFO');
    assert.equal(typeof rec.seq, 'number');
    assert.equal(typeof rec.ts, 'number');
    assert.match(rec.line, /\[INFO\] stream-replay-seed-a$/);
  } finally { await ctx.close(); }
});

test('stream: 접속 종료 시 구독이 해제돼 subscriberCount가 기준선(0)으로 복귀한다(누수 가드)', async () => {
  const logService = createLogService();
  logService.info('leak-guard-seed');

  const ctx = await start({ logService });
  try {
    seedUser(ctx.db, { userId: 'adm', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw');
    assert.equal(logService.subscriberCount(), 0, '접속 전 기준선은 0');

    // streamGet은 until 충족 후 소켓을 destroy한다 — ready+replay 수신 시점엔 구독이 이미 등록돼 있다.
    const r = await streamGet(ctx.base, '/api/logs/stream', {
      headers: { 'x-session-id': sid },
      until: (buf) => buf.includes('leak-guard-seed'),
    });
    assert.equal(r.status, 200);

    // close 전파는 비동기 — 짧은 폴링으로 req close 핸들러의 unsubscribe(off) 호출을 기다린다.
    const released = await waitFor(() => logService.subscriberCount() === 0);
    assert.ok(released, `구독이 해제돼야 한다(현재 ${logService.subscriberCount()})`);
  } finally { await ctx.close(); }
});
