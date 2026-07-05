// 로그 SSE 스트림(/api/logs/stream) 라우트 테스트 (26-realtime-log-viewer step1).
// 검증: (1) 미인증(세션 없음) 401, (2) 인증 세션 → text/event-stream + event: ready,
//   (3) 접속 시 백로그 재생(event: log), (4) 평문 ?session= 단독 접근 401(폴백 없음),
//   (5) app.notifyChange가 무효화와 함께 INFO 로그를 남긴다(계측 배선).
// transport(server/index.js)의 /api/logs/stream만 본다. logService는 in-memory 인스턴스를 주입한다.
// 헤더/쿠키를 직접 제어하려고 node:http.request를 쓴다(sse-auth.test.js 컨벤션). SSE 응답은
//   초기 청크(ready+백로그)까지 모으고 명시적으로 소켓을 끊는다(스트림이 닫히지 않으므로).

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
import { createLogService } from '../src/services/logService.js';
import { createApp, SESSION_COOKIE_NAME } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

async function start({ logService } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp({ controllers, sessionService, logService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, app, controllers, sessionService, base, close: () => new Promise((r) => server.close(r)) };
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

// SSE GET — 200이면 초기 청크(들)를 짧게 모아 돌려주고 소켓을 끊는다. 비-200은 바디를 모은다.
// 백로그가 여러 청크로 나뉠 수 있으므로 잠깐(30ms) 누적 후 종료한다(무한 대기 방지).
function streamGet(base, path, { headers = {} } = {}) {
  const u = new URL(`${base}${path}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        const status = res.statusCode;
        const contentType = res.headers['content-type'] ?? '';
        res.setEncoding('utf8');
        if (status !== 200) {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => resolve({ status, contentType, chunk: buf }));
          return;
        }
        let buf = '';
        setTimeout(() => {
          req.destroy();
          resolve({ status, contentType, chunk: buf });
        }, 30);
        res.on('data', (c) => { buf += c; });
      },
    );
    req.on('error', (e) => {
      if (e.code === 'ECONNRESET') return; // destroy로 인한 소켓 종료 — 이미 resolve됨.
      reject(e);
    });
    req.end();
  });
}

test('로그 스트림: 쿠키/헤더 없으면 401 UNAUTH', async () => {
  const ctx = await start();
  try {
    const r = await streamGet(ctx.base, '/api/logs/stream');
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.contentType, /text\/event-stream/);
  } finally { await ctx.close(); }
});

test('로그 스트림: 인증 세션 → 200 text/event-stream + event: ready', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const r = await streamGet(ctx.base, '/api/logs/stream', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` },
    });
    assert.equal(r.status, 200);
    assert.match(r.contentType, /text\/event-stream/);
    assert.match(r.chunk, /event: ready/);
  } finally { await ctx.close(); }
});

test('로그 스트림: x-session-id 헤더도 통과한다(하위호환)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const r = await streamGet(ctx.base, '/api/logs/stream', {
      headers: { 'x-session-id': sid },
    });
    assert.equal(r.status, 200);
    assert.match(r.contentType, /text\/event-stream/);
  } finally { await ctx.close(); }
});

test('로그 스트림: 접속 시 백로그가 event: log로 재생된다', async () => {
  const logService = createLogService();
  logService.log('INFO', 'seeded-backlog-line-one');
  logService.log('WARN', 'seeded-backlog-line-two');
  const ctx = await start({ logService });
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const r = await streamGet(ctx.base, '/api/logs/stream', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` },
    });
    assert.equal(r.status, 200);
    assert.match(r.chunk, /event: log/);
    assert.match(r.chunk, /seeded-backlog-line-one/);
    assert.match(r.chunk, /seeded-backlog-line-two/);
  } finally { await ctx.close(); }
});

test('로그 스트림: ?session=<유효토큰> 단독은 401(평문 폴백 없음)', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const r = await streamGet(ctx.base, `/api/logs/stream?session=${sid}`);
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.contentType, /text\/event-stream/);
  } finally { await ctx.close(); }
});

test('로그 스트림: 위조 sid면 401', async () => {
  const ctx = await start();
  try {
    const r = await streamGet(ctx.base, '/api/logs/stream', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=deadbeef` },
    });
    assert.equal(r.status, 401);
  } finally { await ctx.close(); }
});

test('계측: app.notifyChange(kind)가 무효화와 함께 INFO 로그를 남긴다', async () => {
  const logService = createLogService();
  const ctx = await start({ logService });
  try {
    ctx.app.notifyChange('create');
    const entries = logService.entries();
    const found = entries.find((e) => e.level === 'INFO' && /change: create/.test(e.message));
    assert.ok(found, 'change: create INFO 엔트리가 있어야 한다');
  } finally { await ctx.close(); }
});

test('계측: notifyChange가 무효화 신호(bus)를 그대로 방출한다(회귀 가드)', async () => {
  const logService = createLogService();
  const ctx = await start({ logService });
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    // /api/stream 구독자에게 change 신호가 도달하는지 확인.
    const u = new URL(`${ctx.base}/api/stream`);
    const got = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
          headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` } },
        (res) => {
          res.setEncoding('utf8');
          let buf = '';
          res.on('data', (c) => {
            buf += c;
            if (/event: change/.test(buf)) { req.destroy(); resolve(buf); }
          });
        },
      );
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
      req.end();
      setTimeout(() => ctx.app.notifyChange('status'), 20);
    });
    assert.match(got, /event: change/);
  } finally { await ctx.close(); }
});
