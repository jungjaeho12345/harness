// SSE 구독 콜백의 재검증 예외 내성 — phase 52 코드리뷰 [med] 회귀 수정.
//
// 배경: step3이 두 SSE 라우트의 구독 콜백 안에서 controllers.auth.peek(sid)를 호출하면서
//   **이벤트 리스너가 DB를 읽는** 경로가 처음 생겼다(phase 52 이전엔 어떤 리스너도 DB를 만지지 않았다).
//   - /api/logs/stream: logService.subscribe 콜백 → peek. logService.log는 리스너를 try/catch 없이
//     동기 호출하고(src/services/logService.js), 그 호출자는 요청 로거의 res.on('finish')다
//     (server/index.js). 따라서 peek이 throw하면(SQLITE_BUSY·디스크 I/O 등) 예외가 finish 리스너
//     밖으로 새어 **uncaughtException → 프로세스 종료**가 된다.
//   - /api/stream: 같은 예외가 bus.emit('change') 경로를 타고 라우트 핸들러로 올라가
//     **성공한 저장이 500으로 보고**된다(클라이언트 재시도 → 중복 저장).
//
// 계약: 재검증이 예외로 실패하면 "일단 전송"이 아니라 **fail-closed**(종료 프레임 1회 후 연결 종료)다.
//   재검증 불가 = 봉인. 잡는 위치는 리스너 국소다 — sessionGuard에서 잡으면 HTTP 라우트의 기존 동작
//   (DB 예외 → 전역 에러 핸들러 500 internal-error)이 401로 바뀌는 광범위한 동작 변화가 생긴다.
//
// 변이 검증: server/index.js의 두 리스너에서 try/catch를 제거하면 이 파일이 red가 된다
//   (로그 스트림 쪽은 uncaughtException, /api/stream 쪽은 저장 응답 500).

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

// 종료 이벤트 계약(sse-reauth.test.js와 동일 바이트열 — 끝의 빈 줄이 SSE 프레임 종결자다).
const UNAUTHORIZED_FRAME = 'event: unauthorized\ndata: {"ok":false,"reason":"unauthenticated"}\n\n';

// peek만 실패하게 만드는 주입 — session(touch)은 정상이라 HTTP 라우트는 평소대로 동작한다.
// 실증 시나리오: WAL/busy_timeout 미설정 상태에서 다른 프로세스가 같은 news.db를 열어 SQLITE_BUSY.
function withFailingPeek(controllers) {
  const state = { failing: false, calls: 0 };
  const auth = {
    ...controllers.auth,
    peek(sessionId) {
      state.calls += 1;
      if (state.failing) throw new Error('SQLITE_BUSY: database is locked');
      return controllers.auth.peek(sessionId);
    },
  };
  return { controllers: { ...controllers, auth }, state };
}

async function start({ logService = createLogService() } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const { controllers, state } = withFailingPeek(createControllers(db, { sessionService }));
  const app = createApp({ controllers, logService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, app, logService, base, peek: state, close: () => new Promise((r) => server.close(r)) };
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

// SSE를 열어둔 채 조작하기 위한 핸들(sse-reauth.test.js와 동형).
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
      if (e.code === 'ECONNRESET') return;
      reject(e);
    });
    req.end();
  });
}

async function waitFor(cond, { timeoutMs = 2000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const countOf = (buf, needle) => (buf.match(new RegExp(needle, 'g')) ?? []).length;

// --- 로그 스트림: 리스너 예외가 프로세스를 죽이면 안 된다 ---

test('[내성 1] 로그 스트림 재검증이 throw해도 프로세스가 죽지 않고 요청은 정상 완료된다', async () => {
  const ctx = await start();
  let s;
  try {
    seedUser(ctx.db, { userId: 'adm', name: '관리자', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw');

    s = await openStream(ctx.base, '/api/logs/stream', { headers: { 'x-session-id': sid } });
    assert.equal(s.status, 200);
    assert.ok(await waitFor(() => s.buf.includes('event: ready')));

    ctx.peek.failing = true;
    // 요청 로거(res.on('finish')) → logService.info → 구독 콜백 → peek throw 경로를 탄다.
    const probe = await api(ctx.base, 'GET', '/api/health');
    assert.deepEqual(probe, { status: 200, body: { ok: true } }, '요청 자체는 정상 응답해야 한다');

    // 서버가 살아 있어야 한다(uncaughtException으로 죽으면 이 요청이 실패한다).
    ctx.peek.failing = false;
    const after = await api(ctx.base, 'GET', '/api/health');
    assert.equal(after.status, 200, '리스너 예외 뒤에도 서버가 살아 있어야 한다');
  } finally { s?.close(); await ctx.close(); }
});

test('[내성 2] 로그 스트림 재검증 예외는 fail-closed — 종료 프레임 1회 후 연결 종료, 구독 해제', async () => {
  const ctx = await start();
  let s;
  try {
    seedUser(ctx.db, { userId: 'adm', name: '관리자', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw');
    assert.equal(ctx.logService.subscriberCount(), 0, '접속 전 기준선은 0');

    s = await openStream(ctx.base, '/api/logs/stream', { headers: { 'x-session-id': sid } });
    assert.ok(await waitFor(() => s.buf.includes('event: ready')));
    assert.ok(await waitFor(() => ctx.logService.subscriberCount() === 1), '로그 구독이 등록돼야 한다');

    ctx.peek.failing = true;
    ctx.logService.info('SECRET-during-db-failure');

    assert.ok(await waitFor(() => s.serverEnded), '재검증 불가 시 스트림은 봉인(종료)돼야 한다');
    assert.ok(!s.buf.includes('SECRET-during-db-failure'), '재검증 실패 시 로그 라인이 나가면 안 된다');
    assert.equal(countOf(s.buf, 'event: unauthorized'), 1, '종료 이벤트는 정확히 1회');
    assert.ok(
      s.buf.endsWith(UNAUTHORIZED_FRAME),
      `종료 프레임이 종결자(\\n\\n)까지 온전해야 한다: ${JSON.stringify(s.buf.slice(-90))}`,
    );
    assert.ok(
      await waitFor(() => ctx.logService.subscriberCount() === 0),
      `종료 시 구독이 해제돼야 한다(현재 ${ctx.logService.subscriberCount()})`,
    );

    // 종료 후 추가 이벤트는 1바이트도 더 쓰지 않는다(이중 close 안전 + 구독 잔존 없음).
    // 재검증이 계속 실패하는 동안에도 마찬가지다.
    const after = s.buf;
    ctx.logService.info('post-termination-line');
    ctx.peek.failing = false;
    ctx.logService.info('post-termination-recovered');
    await settle();
    assert.equal(s.buf, after, '종료 후 추가 바이트가 있으면 안 된다');
  } finally { s?.close(); await ctx.close(); }
});

// --- /api/stream: 리스너 예외가 성공한 저장을 500으로 뒤집으면 안 된다 ---

test('[내성 3] /api/stream 재검증이 throw해도 저장 요청은 성공 응답이다(500 금지)', async () => {
  const ctx = await start();
  let s;
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    s = await openStream(ctx.base, '/api/stream', { headers: { 'x-session-id': sid } });
    assert.equal(s.status, 200);
    assert.ok(await waitFor(() => s.buf.includes('event: ready')));

    ctx.peek.failing = true;
    const created = await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: '저장은 성공해야 한다', markupVersion: '{}' },
    });
    assert.equal(created.status, 200, '성공한 저장이 리스너 예외로 500이 되면 클라가 재시도해 중복 저장이 된다');
    assert.equal(created.body?.ok, true);

    // 저장은 실제로 1건만 남는다(중복 없음).
    const rows = ctx.db.prepare('SELECT COUNT(*) AS n FROM Article').get();
    assert.equal(Number(rows.n), 1);
  } finally { s?.close(); await ctx.close(); }
});

test('[내성 4] /api/stream 재검증 예외도 fail-closed — 신호 미전송, 종료 프레임 1회 후 봉인', async () => {
  const ctx = await start();
  let s;
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    s = await openStream(ctx.base, '/api/stream', { headers: { 'x-session-id': sid } });
    assert.ok(await waitFor(() => s.buf.includes('event: ready')));

    ctx.peek.failing = true;
    ctx.app.notifyChange('create');

    assert.ok(await waitFor(() => s.serverEnded), '재검증 불가 시 무효화 스트림도 봉인돼야 한다');
    assert.ok(!s.buf.includes('event: change'), '재검증 실패 시 change 신호가 나가면 안 된다');
    assert.equal(countOf(s.buf, 'event: unauthorized'), 1, '종료 이벤트는 정확히 1회');
    assert.ok(
      s.buf.endsWith(UNAUTHORIZED_FRAME),
      `종료 프레임이 종결자(\\n\\n)까지 온전해야 한다: ${JSON.stringify(s.buf.slice(-90))}`,
    );

    // 종료 후 추가 신호는 쓰이지 않는다(bus 구독 해제 + 이중 close 안전).
    const after = s.buf;
    ctx.app.notifyChange('status');
    ctx.peek.failing = false;
    ctx.app.notifyChange('update');
    await settle();
    assert.equal(s.buf, after, '종료 후 추가 바이트가 있으면 안 된다');
  } finally { s?.close(); await ctx.close(); }
});

test('[회귀 5] 재검증이 정상 복구되면 두 스트림 모두 평소대로 동작한다(예외 처리가 정상 경로를 바꾸지 않는다)', async () => {
  const ctx = await start();
  let logs;
  let stream;
  try {
    seedUser(ctx.db, { userId: 'adm', name: '관리자', role: 'Z', password: 'pw' });
    const sid = await login(ctx.base, 'adm', 'pw');

    logs = await openStream(ctx.base, '/api/logs/stream', { headers: { 'x-session-id': sid } });
    stream = await openStream(ctx.base, '/api/stream', { headers: { 'x-session-id': sid } });
    assert.ok(await waitFor(() => logs.buf.includes('event: ready')));
    assert.ok(await waitFor(() => stream.buf.includes('event: ready')));

    ctx.logService.info('live-line-ok');
    assert.ok(await waitFor(() => logs.buf.includes('live-line-ok')), `라이브 라인이 와야 한다: ${logs.buf}`);
    ctx.app.notifyChange('create');
    assert.ok(await waitFor(() => stream.buf.includes('event: change')));

    assert.ok(!logs.buf.includes('event: unauthorized'));
    assert.ok(!stream.buf.includes('event: unauthorized'));
    assert.equal(logs.serverEnded, false);
    assert.equal(stream.serverEnded, false);
  } finally { logs?.close(); stream?.close(); await ctx.close(); }
});
