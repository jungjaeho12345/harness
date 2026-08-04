// SSE push 시점 재인증 테스트 — phase 52 step3.
// 2026-08-03 감사 [medium]: 두 SSE 라우트(/api/logs/stream, /api/stream)가 **접속 시점에만** 인증해서
//   로그아웃·세션 만료·역할 강등·계정 비활성화 이후에도 연결이 살아 있는 한 push가 계속됐다.
// 검증: 이벤트를 쓰기 직전 controllers.auth.peek(비연장)으로 재확인하고, 실패하면 그 이벤트를 쓰지 않고
//   `event: unauthorized` 1회 후 스트림을 끝낸다 — 무효화 이후 단 한 줄도 나가지 않는다.
// 재검증은 반드시 **비연장 peek**이어야 한다(touch면 열린 SSE가 세션을 무한 연장 — 시나리오 8이 잡는다).
//
// 조립은 test/logs-api.test.js와 동형(logService 주입으로 로그 라인을 결정적으로 만든다).
// 스트림 읽기는 그 파일의 streamGet과 달리 **끊지 않고 열어둔다** — 서버가 스스로 끝내는지,
//   그리고 종료 프레임 뒤에 추가 바이트가 없는지(시나리오 11)를 봐야 하기 때문이다.

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

// 종료 이벤트 계약(step5 클라이언트가 이 이벤트로 EventSource를 닫는다).
// CRITICAL: 끝의 빈 줄이 SSE 프레임 종결자다 — 없으면 브라우저가 이벤트를 디스패치하지 않는다.
const UNAUTHORIZED_FRAME = 'event: unauthorized\ndata: {"ok":false,"reason":"unauthenticated"}\n\n';

const ONE_MIN_MS = 60 * 1000;

async function start({ logService = createLogService(), now } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService(now ? { now } : {});
  const controllers = createControllers(db, { sessionService });
  const app = createApp({ controllers, logService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, app, logService, base, close: () => new Promise((r) => server.close(r)) };
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

// SSE를 열어둔 채로 조작할 수 있는 핸들 — { status, contentType, buf, serverEnded, close() }.
// serverEnded는 **서버가 res.end()로 끝냈을 때만** true다(우리 쪽 destroy는 'end'를 만들지 않는다).
function openStream(base, path, { headers = {} } = {}) {
  const u = new URL(`${base}${path}`);
  const handle = { buf: '', status: undefined, contentType: '', serverEnded: false, close: () => {} };
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        handle.status = res.statusCode;
        handle.contentType = res.headers['content-type'] ?? '';
        res.setEncoding('utf8');
        res.on('data', (c) => { handle.buf += c; });
        res.on('end', () => { handle.serverEnded = true; });
        resolve(handle);
      },
    );
    handle.close = () => req.destroy();
    req.on('error', (e) => {
      // 테스트가 소켓을 끊을 때 나는 종료 에러는 무시(이미 resolve됨).
      if (e.code === 'ECONNRESET') return;
      reject(e);
    });
    req.end();
  });
}

// 조건이 참이 될 때까지 짧게 폴링한다(수신·close 전파는 비동기). 앱 타이머가 아니라 테스트 대기 수단이다.
async function waitFor(cond, { timeoutMs = 2000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

// "더 이상 아무것도 오지 않는다"를 확인하기 위한 짧은 정착 대기.
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const countOf = (buf, needle) => (buf.match(new RegExp(needle, 'g')) ?? []).length;

// --- 공격 시나리오 ---

test('[공격 1] 로그아웃하면 로그 스트림에 새 로그가 실리지 않고 unauthorized 1회 후 종료된다', async () => {
  const logService = createLogService();
  logService.info('replay-seed');
  const ctx = await start({ logService });
  let s;
  try {
    seedUser(ctx.db, { userId: 'adm', name: '관리자', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw');

    s = await openStream(ctx.base, '/api/logs/stream', { headers: { 'x-session-id': sid } });
    assert.equal(s.status, 200);
    assert.match(s.contentType, /text\/event-stream/);
    assert.ok(await waitFor(() => s.buf.includes('replay-seed')), `ready+replay가 먼저 와야 한다: ${s.buf}`);
    assert.match(s.buf, /event: ready/);

    await api(ctx.base, 'POST', '/api/logout', { sid });
    ctx.logService.info('SECRET-after-logout');

    assert.ok(await waitFor(() => s.serverEnded), '무효화된 세션의 스트림은 서버가 끝내야 한다');
    assert.ok(!s.buf.includes('SECRET-after-logout'), '무효화 이후에는 로그 라인이 한 줄도 나가면 안 된다');
    assert.equal(countOf(s.buf, 'event: unauthorized'), 1, '종료 이벤트는 정확히 1회');
    // [시나리오 11] 프레임 종결 잠금 — 끝의 빈 줄까지 온전하고 그 뒤에 추가 바이트가 없다.
    assert.ok(
      s.buf.endsWith(UNAUTHORIZED_FRAME),
      `종료 프레임이 종결자(\\n\\n)까지 온전해야 한다: ${JSON.stringify(s.buf.slice(-90))}`,
    );
  } finally { s?.close(); await ctx.close(); }
});

test('[공격 2] Z가 R로 강등되면 로그 스트림이 즉시 끊긴다(로그 미전송)', async () => {
  const ctx = await start();
  let s;
  try {
    seedUser(ctx.db, { userId: 'adm', name: '관리자', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw');

    s = await openStream(ctx.base, '/api/logs/stream', { headers: { 'x-session-id': sid } });
    assert.equal(s.status, 200);
    assert.ok(await waitFor(() => s.buf.includes('event: ready')));

    // 운영자 DB 직접 수정도 커버된다(세션 가드가 매 peek마다 User 행을 재조회한다).
    ctx.db.prepare('UPDATE User SET role = ? WHERE userId = ?').run('R', 'adm');
    ctx.logService.info('SECRET-after-demote');

    assert.ok(await waitFor(() => s.serverEnded), '강등된 세션의 로그 스트림은 끊겨야 한다');
    assert.ok(!s.buf.includes('SECRET-after-demote'), '비-Z에게 로그 라인이 나가면 안 된다');
    assert.equal(countOf(s.buf, 'event: unauthorized'), 1);
    assert.ok(s.buf.endsWith(UNAUTHORIZED_FRAME));
  } finally { s?.close(); await ctx.close(); }
});

test('[공격 3] 계정이 비활성화(active=N)되면 로그 스트림이 즉시 끊긴다(로그 미전송)', async () => {
  const ctx = await start();
  let s;
  try {
    seedUser(ctx.db, { userId: 'adm', name: '관리자', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw');

    s = await openStream(ctx.base, '/api/logs/stream', { headers: { 'x-session-id': sid } });
    assert.equal(s.status, 200);
    assert.ok(await waitFor(() => s.buf.includes('event: ready')));

    ctx.db.prepare('UPDATE User SET active = ? WHERE userId = ?').run('N', 'adm');
    ctx.logService.info('SECRET-after-deactivate');

    assert.ok(await waitFor(() => s.serverEnded), '비활성 계정의 로그 스트림은 끊겨야 한다');
    assert.ok(!s.buf.includes('SECRET-after-deactivate'));
    assert.equal(countOf(s.buf, 'event: unauthorized'), 1);
    assert.ok(s.buf.endsWith(UNAUTHORIZED_FRAME));
  } finally { s?.close(); await ctx.close(); }
});

test('[공격 4] /api/stream: 로그아웃 후 발생한 change 신호는 전달되지 않고 unauthorized로 끝난다', async () => {
  const ctx = await start();
  let s;
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    seedUser(ctx.db, { userId: 'lee', name: '이기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');
    const otherSid = await login(ctx.base, 'lee', 'pw');

    s = await openStream(ctx.base, '/api/stream', { headers: { 'x-session-id': sid } });
    assert.equal(s.status, 200);
    assert.ok(await waitFor(() => s.buf.includes('event: ready')));

    await api(ctx.base, 'POST', '/api/logout', { sid });

    // 다른 사용자의 기사 생성 → notifyChange('create').
    const created = await api(ctx.base, 'POST', '/api/articles', {
      sid: otherSid, body: { title: '남의 기사', markupVersion: '{}' },
    });
    assert.equal(created.status, 200);

    assert.ok(await waitFor(() => s.serverEnded), '무효화된 세션의 무효화 스트림도 끝나야 한다');
    assert.ok(!s.buf.includes('event: change'), '로그아웃 이후 change 신호가 나가면 안 된다');
    assert.equal(countOf(s.buf, 'event: unauthorized'), 1);
    // [시나리오 11] /api/stream 쪽 프레임 종결 잠금.
    assert.ok(
      s.buf.endsWith(UNAUTHORIZED_FRAME),
      `종료 프레임이 종결자(\\n\\n)까지 온전해야 한다: ${JSON.stringify(s.buf.slice(-90))}`,
    );
  } finally { s?.close(); await ctx.close(); }
});

test('[공격 5] 세션이 만료되면 다음 push 시점에 스트림이 끝난다(가짜 시계)', async () => {
  let clock = Date.UTC(2026, 7, 4, 3, 0);
  const ctx = await start({ now: () => clock });
  let s;
  try {
    seedUser(ctx.db, { userId: 'adm', name: '관리자', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw'); // 만료 = 발급 시각 + 1시간.

    s = await openStream(ctx.base, '/api/logs/stream', { headers: { 'x-session-id': sid } });
    assert.equal(s.status, 200);
    assert.ok(await waitFor(() => s.buf.includes('event: ready')));

    clock += 61 * ONE_MIN_MS; // 1시간 유휴 만료 경과.
    ctx.logService.info('SECRET-after-expiry');

    assert.ok(await waitFor(() => s.serverEnded), '만료된 세션의 스트림은 다음 push에서 끝나야 한다');
    assert.ok(!s.buf.includes('SECRET-after-expiry'));
    assert.ok(s.buf.endsWith(UNAUTHORIZED_FRAME));
  } finally { s?.close(); await ctx.close(); }
});

// --- 정상 플로우 무손상(회귀) ---

test('[회귀 6] 유효한 Z 세션에는 접속 후 로그가 계속 전달되고 연결이 유지된다', async () => {
  const ctx = await start();
  let s;
  try {
    seedUser(ctx.db, { userId: 'adm', name: '관리자', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw');

    s = await openStream(ctx.base, '/api/logs/stream', { headers: { 'x-session-id': sid } });
    assert.equal(s.status, 200);
    assert.ok(await waitFor(() => s.buf.includes('event: ready')));

    ctx.logService.info('live-line-a');
    assert.ok(await waitFor(() => s.buf.includes('live-line-a')), `첫 라이브 라인이 와야 한다: ${s.buf}`);
    ctx.logService.warn('live-line-b');
    assert.ok(await waitFor(() => s.buf.includes('live-line-b')), '재검증이 정상 스트림을 끊으면 안 된다');

    assert.ok(!s.buf.includes('event: unauthorized'), '유효 세션에는 종료 이벤트가 없어야 한다');
    assert.equal(s.serverEnded, false, '연결이 유지돼야 한다');
  } finally { s?.close(); await ctx.close(); }
});

test('[회귀 7] 유효한 일반 세션에는 /api/stream의 change 신호가 정상 전달된다', async () => {
  const ctx = await start();
  let s;
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    s = await openStream(ctx.base, '/api/stream', { headers: { 'x-session-id': sid } });
    assert.equal(s.status, 200);
    assert.ok(await waitFor(() => s.buf.includes('event: ready')));

    const created = await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: '내 기사', markupVersion: '{}' },
    });
    assert.equal(created.status, 200);

    assert.ok(await waitFor(() => s.buf.includes('event: change')), `change 신호가 와야 한다: ${s.buf}`);
    assert.match(s.buf, /"kind":"create"/);
    assert.ok(!s.buf.includes('event: unauthorized'));
    assert.equal(s.serverEnded, false);
  } finally { s?.close(); await ctx.close(); }
});

test('[회귀 8] SSE를 열어두기만 해서는 세션이 연장되지 않는다(비연장 peek)', async () => {
  let clock = Date.UTC(2026, 7, 4, 3, 0);
  const t0 = clock;
  const ctx = await start({ now: () => clock });
  let s;
  try {
    seedUser(ctx.db, { userId: 'adm', name: '관리자', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw'); // 만료 = t0 + 1시간(이후 HTTP 요청 없음).

    s = await openStream(ctx.base, '/api/logs/stream', { headers: { 'x-session-id': sid } });
    assert.equal(s.status, 200);
    assert.ok(await waitFor(() => s.buf.includes('event: ready')));

    // 만료 이전의 push는 정상 전달된다(재검증이 통과).
    clock = t0 + 30 * ONE_MIN_MS;
    ctx.logService.info('tick-at-30m');
    assert.ok(await waitFor(() => s.buf.includes('tick-at-30m')));
    clock = t0 + 59 * ONE_MIN_MS;
    ctx.logService.info('tick-at-59m');
    assert.ok(await waitFor(() => s.buf.includes('tick-at-59m')));

    // 최초 발급 후 1시간 — push로 재검증했다고 만료가 밀리면 안 된다(touch면 여기서 살아남아 red).
    clock = t0 + 61 * ONE_MIN_MS;
    ctx.logService.info('SECRET-after-idle-expiry');

    assert.ok(await waitFor(() => s.serverEnded), 'push 재검증이 세션을 연장하면 유휴 만료가 무력화된다');
    assert.ok(!s.buf.includes('SECRET-after-idle-expiry'));
    assert.ok(s.buf.endsWith(UNAUTHORIZED_FRAME));
  } finally { s?.close(); await ctx.close(); }
});

test('[회귀 9] 접속 시점 인증은 그대로다 — 미인증 401, 비-Z의 로그 스트림 403', async () => {
  const ctx = await start();
  const opened = [];
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const anonLogs = await openStream(ctx.base, '/api/logs/stream');
    const anonStream = await openStream(ctx.base, '/api/stream');
    const nonZ = await openStream(ctx.base, '/api/logs/stream', { headers: { 'x-session-id': sid } });
    opened.push(anonLogs, anonStream, nonZ);

    assert.equal(anonLogs.status, 401);
    assert.doesNotMatch(anonLogs.contentType, /text\/event-stream/);
    assert.equal(anonStream.status, 401);
    assert.equal(nonZ.status, 403);
    assert.doesNotMatch(nonZ.contentType, /text\/event-stream/);
    // 접속 거부는 SSE 종료 이벤트가 아니라 HTTP 상태로 표현한다(헤더가 아직 안 나갔다).
    assert.ok(await waitFor(() => nonZ.serverEnded));
    assert.ok(!nonZ.buf.includes('event: unauthorized'));
    assert.deepEqual(JSON.parse(nonZ.buf), { ok: false, reason: 'forbidden' });
  } finally { for (const s of opened) s.close(); await ctx.close(); }
});

test('[회귀 10] 재인증 종료 시 구독이 해제된다(누수 금지)', async () => {
  const ctx = await start();
  let logs;
  let stream;
  try {
    seedUser(ctx.db, { userId: 'adm', name: '관리자', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw');
    assert.equal(ctx.logService.subscriberCount(), 0, '접속 전 기준선은 0');

    logs = await openStream(ctx.base, '/api/logs/stream', { headers: { 'x-session-id': sid } });
    stream = await openStream(ctx.base, '/api/stream', { headers: { 'x-session-id': sid } });
    assert.ok(await waitFor(() => logs.buf.includes('event: ready')));
    assert.ok(await waitFor(() => stream.buf.includes('event: ready')));
    assert.ok(await waitFor(() => ctx.logService.subscriberCount() === 1), '로그 구독이 등록돼야 한다');

    await api(ctx.base, 'POST', '/api/logout', { sid });
    ctx.app.notifyChange('create'); // /api/stream 쪽 재검증 유발.

    assert.ok(await waitFor(() => logs.serverEnded && stream.serverEnded));
    assert.ok(
      await waitFor(() => ctx.logService.subscriberCount() === 0),
      `종료 시 로그 구독이 해제돼야 한다(현재 ${ctx.logService.subscriberCount()})`,
    );

    // 종료 후의 추가 이벤트는 단 1바이트도 더 쓰지 않는다(구독이 남아 있지 않다는 행동 단언).
    const after = stream.buf;
    ctx.app.notifyChange('status');
    ctx.logService.info('post-termination-line');
    await settle();
    assert.equal(stream.buf, after, '종료 후 추가 바이트가 있으면 안 된다');
    assert.ok(stream.buf.endsWith(UNAUTHORIZED_FRAME));
    assert.ok(logs.buf.endsWith(UNAUTHORIZED_FRAME));
    assert.ok(!logs.buf.includes('post-termination-line'));
  } finally { logs?.close(); stream?.close(); await ctx.close(); }
});
