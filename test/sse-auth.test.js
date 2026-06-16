// SSE(/api/stream) 쿠키 인증 강화 테스트 (security-hardening step2).
// 검증: 쿼리(?session=) 평문 폴백 제거, 쿠키(우선)+x-session-id 헤더만 인증 통과, 무인증/위조는 401,
//   인증 후 슬라이딩 갱신(touchSession) 동작. transport(server/index.js)의 /api/stream만 본다.
// 헤더/쿠키를 직접 제어하려고 node:http.request를 쓴다 — fetch는 일부 헤더를 금지 헤더로 무시한다
//   (step1 https-enforcement.test.js의 rawFetch 패턴). SSE 응답의 첫 청크(ready 이벤트)까지 읽고 종료한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp, SESSION_COOKIE_NAME } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

async function start() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp({ controllers, sessionService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, controllers, sessionService, base, close: () => new Promise((r) => server.close(r)) };
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

// /api/stream을 저수준으로 GET해 상태코드와 첫 SSE 청크(있으면)를 돌려준다.
// 200이면 첫 data 청크를 한 번 읽고 즉시 소켓을 끊는다(스트림이 닫히지 않으므로 직접 종료).
// 401 등 비-스트림 응답이면 바디를 모아 돌려준다.
function streamGet(base, path, { headers = {} } = {}) {
  const u = new URL(`${base}${path}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        const status = res.statusCode;
        const contentType = res.headers['content-type'] ?? '';
        if (status !== 200) {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { buf += c; });
          res.on('end', () => resolve({ status, contentType, chunk: buf }));
          return;
        }
        // SSE: 첫 청크만 읽고 끊는다.
        res.setEncoding('utf8');
        res.once('data', (chunk) => {
          req.destroy();
          resolve({ status, contentType, chunk });
        });
      },
    );
    req.on('error', (e) => {
      // 첫 청크 수신 후 destroy로 발생하는 소켓 종료 에러는 무시(이미 resolve됨).
      if (e.code === 'ECONNRESET') return;
      reject(e);
    });
    req.end();
  });
}

test('SSE: 쿠키만 실은 요청이 인증을 통과해 text/event-stream으로 ready 신호를 보낸다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const r = await streamGet(ctx.base, '/api/stream', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` },
    });
    assert.equal(r.status, 200);
    assert.match(r.contentType, /text\/event-stream/);
    assert.match(r.chunk, /event: ready/);
  } finally { await ctx.close(); }
});

test('SSE: x-session-id 헤더만 실은 요청도 통과한다(하위호환 회귀 가드)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const r = await streamGet(ctx.base, '/api/stream', {
      headers: { 'x-session-id': sid },
    });
    assert.equal(r.status, 200);
    assert.match(r.contentType, /text\/event-stream/);
    assert.match(r.chunk, /event: ready/);
  } finally { await ctx.close(); }
});

test('SSE: ?session=<유효토큰> 쿼리만 실은 요청은 이제 401이다(쿼리 폴백 제거 — 이 step의 핵심)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const r = await streamGet(ctx.base, `/api/stream?session=${sid}`);
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.contentType, /text\/event-stream/);
  } finally { await ctx.close(); }
});

test('SSE: 쿠키·헤더 둘 다 없으면 401', async () => {
  const ctx = await start();
  try {
    const r = await streamGet(ctx.base, '/api/stream');
    assert.equal(r.status, 401);
  } finally { await ctx.close(); }
});

test('SSE: 위조/만료 sid면 401', async () => {
  const ctx = await start();
  try {
    const r = await streamGet(ctx.base, '/api/stream', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=deadbeef` },
    });
    assert.equal(r.status, 401);
  } finally { await ctx.close(); }
});

test('SSE: 인증 통과 시 슬라이딩 갱신(touchSession)이 호출돼 세션 만료가 연장된다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    // touchSession 호출 여부를 스파이로 확인 — 인증 입력(쿠키)에서 검증 세션을 도출하는지.
    const original = ctx.sessionService.touchSession.bind(ctx.sessionService);
    let touchedWith;
    ctx.sessionService.touchSession = (s) => { touchedWith = s; return original(s); };

    const r = await streamGet(ctx.base, '/api/stream', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` },
    });
    assert.equal(r.status, 200);
    assert.equal(touchedWith, sid, 'touchSession은 쿠키 sid로 호출돼야 한다');
  } finally { await ctx.close(); }
});
