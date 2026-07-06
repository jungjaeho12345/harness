// 서버 계측(logService 주입) 테스트 — createApp에 스파이 logService(실제 createLogService 인스턴스)를
// 주입해 요청/로그인/에러가 적절한 레벨로 기록되는지, 비밀번호·세션 토큰·쿠키가 로그에 새지 않는지(마스킹) 검증한다.
// transport(server/index.js)의 계측만 본다 — 로그 소비 API(/api/logs/*)는 step2.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createLogService } from '../src/services/logService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp, SESSION_COOKIE_NAME } from '../server/index.js';

async function start() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService });
  const logService = createLogService();
  const app = createApp({ controllers, sessionService, logService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, controllers, logService, base, close: () => new Promise((r) => server.close(r)) };
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
  return { status: res.status, body: await res.json() };
}

test('요청 로깅: 완료된 요청이 INFO로 method/path/status/ms만 기록된다', async () => {
  const ctx = await start();
  try {
    const res = await fetch(`${ctx.base}/api/health`);
    assert.equal(res.status, 200);

    const lines = ctx.logService.snapshot();
    const hit = lines.find((r) => /GET \/api\/health 200 \d+ms/.test(r.line));
    assert.ok(hit, `GET /api/health 200 INFO 라인이 있어야 한다: ${JSON.stringify(lines.map((r) => r.line))}`);
    assert.equal(hit.level, 'INFO');
  } finally { await ctx.close(); }
});

test('요청 로깅: 쿼리스트링은 로그에 남지 않는다(req.path만 — 토큰 누출 표면 차단)', async () => {
  const ctx = await start();
  try {
    await fetch(`${ctx.base}/api/health?token=secret-query-token`);

    const lines = ctx.logService.snapshot();
    assert.ok(lines.some((r) => /GET \/api\/health 200/.test(r.line)));
    assert.ok(lines.every((r) => !r.line.includes('secret-query-token')), '쿼리 값이 로그에 없어야 한다');
    assert.ok(lines.every((r) => !r.line.includes('?')), '쿼리스트링 자체가 로그에 없어야 한다');
  } finally { await ctx.close(); }
});

test('로그인 로깅: 성공은 INFO(login ok userId=...), 실패는 WARN(reason 포함) — 비밀번호는 절대 없다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw-secret-1' });

    const ok = await login(ctx.base, 'kim', 'pw-secret-1');
    assert.equal(ok.status, 200);
    const bad = await login(ctx.base, 'kim', 'wrong-pw-2');
    assert.equal(bad.status, 401);

    const lines = ctx.logService.snapshot();
    const okLine = lines.find((r) => r.line.includes('login ok userId=kim'));
    assert.ok(okLine, 'login ok 라인이 있어야 한다');
    assert.equal(okLine.level, 'INFO');

    const failLine = lines.find((r) => /login failed userId=kim reason=\S+/.test(r.line));
    assert.ok(failLine, 'login failed 라인이 있어야 한다');
    assert.equal(failLine.level, 'WARN');

    // 마스킹 회귀 가드 — 어떤 로그 라인에도 비밀번호 문자열이 없다.
    assert.ok(lines.every((r) => !r.line.includes('pw-secret-1')));
    assert.ok(lines.every((r) => !r.line.includes('wrong-pw-2')));
  } finally { await ctx.close(); }
});

test('에러 핸들러: HTTP 응답은 500 internal-error(스택 미노출) 불변 + ERROR 로그에 err.message가 남는다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const { body } = await login(ctx.base, 'kim', 'pw');

    // 던지는 컨트롤러 스텁 — 전역 에러 핸들러 경로를 강제한다.
    ctx.controllers.article.query = () => { throw new Error('boom'); };

    const res = await fetch(`${ctx.base}/api/articles`, {
      headers: { 'x-session-id': body.sessionId },
    });
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { ok: false, reason: 'internal-error' });
    assert.ok(!text.includes('boom'), '응답에 err.message가 노출되면 안 된다');
    assert.ok(!text.includes('at '), '응답에 스택이 노출되면 안 된다');

    const errLine = ctx.logService.snapshot().find((r) => r.level === 'ERROR' && r.line.includes('boom'));
    assert.ok(errLine, 'ERROR 레벨로 boom이 기록돼야 한다');
    assert.match(errLine.line, /GET \/api\/articles/);
  } finally { await ctx.close(); }
});

test('마스킹: 세션 토큰(쿠키/x-session-id 값)은 어떤 로그 라인에도 없다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const { body } = await login(ctx.base, 'kim', 'pw');
    const sid = body.sessionId;

    // 쿠키와 헤더 둘 다 실어 보낸다 — 어느 쪽 값도 로그에 새면 안 된다.
    const res = await fetch(`${ctx.base}/api/session`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}`, 'x-session-id': sid },
    });
    assert.equal(res.status, 200);

    const lines = ctx.logService.snapshot();
    assert.ok(lines.some((r) => /GET \/api\/session 200/.test(r.line)), '요청 자체는 기록된다');
    assert.ok(lines.every((r) => !r.line.includes(sid)), '세션 토큰 값이 로그에 없어야 한다');
  } finally { await ctx.close(); }
});

test('logService 미주입(기본값)이어도 createApp은 무회귀로 동작한다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService });
  const app = createApp({ controllers, sessionService }); // logService 없음 — 기본 createLogService()
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally { await new Promise((r) => server.close(r)); }
});

test('수집 로깅: receive 실패(미등록 sourceId)가 WARN으로 sourceId+reason만 기록된다(payload 없음)', async () => {
  const ctx = await start();
  try {
    const res = await fetch(`${ctx.base}/api/collection/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: 'no-such-src', payload: '비밀페이로드제목\n본문' }),
    });
    assert.equal(res.status, 403);

    const lines = ctx.logService.snapshot();
    const warnLine = lines.find((r) => r.level === 'WARN' && /collection receive sourceId=no-such-src reason=\S+/.test(r.line));
    assert.ok(warnLine, 'collection receive WARN 라인이 있어야 한다');
    assert.ok(lines.every((r) => !r.line.includes('비밀페이로드제목')), 'payload가 로그에 없어야 한다');
  } finally { await ctx.close(); }
});
