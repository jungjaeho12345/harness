// 로그 다이제스트 조회 라우트(/api/logs/digest) 테스트 (26-realtime-log-viewer step2).
// 검증: (1) 미인증 401, (2) 인증 세션 + 주입 logService 윈도우 필터 반영, (3) date 미지정 시 현재 시각 기준,
//   (4) 잘못된 date 400 invalid-date. 세션 게이트만(role 없음)·읽기 전용·DB 미접촉(in-memory).
// logService를 createControllers·createApp 양쪽에 같은 인스턴스로 주입해 라우트가 그 버퍼를 본다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createLogService } from '../src/services/logService.js';
import { createApp } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

// logService를 controllers·app 양쪽에 동일 인스턴스로 주입한다(단일 버퍼 공유).
async function start({ logService } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV, logService });
  const app = createApp({ controllers, sessionService, logService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
}

function seedUser(db, user) {
  createUserModel(db).insert({ active: 'Y', ...user, password: bcrypt.hashSync(user.password, 10) });
}

async function api(base, method, path, { sid } = {}) {
  const headers = {};
  if (sid) headers['x-session-id'] = sid;
  const res = await fetch(`${base}${path}`, { method, headers });
  let json;
  try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, body: json };
}

async function login(base, userId, password) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, password }),
  });
  return (await res.json()).sessionId;
}

test('다이제스트: 세션 없으면 401 UNAUTH', async () => {
  const ctx = await start({ logService: createLogService() });
  try {
    const r = await api(ctx.base, 'GET', '/api/logs/digest');
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'unauthenticated');
  } finally { await ctx.close(); }
});

test('다이제스트: 인증 + date 지정 시 윈도우 필터를 반영한다(total/byLevel)', async () => {
  // clock을 가변으로 두고 특정 시각에 로그를 심는다 — runDate=2026-07-05 윈도우(07-04 06:00~07-05 05:59).
  let nowMs = new Date(2026, 6, 4, 12, 0, 0).getTime(); // 전날 정오 → 윈도우 안
  const logService = createLogService({ clock: () => nowMs });
  logService.info('yesterday-noon-1');
  logService.warn('yesterday-noon-2');
  nowMs = new Date(2026, 6, 6, 12, 0, 0).getTime(); // 이틀 뒤 → 윈도우 밖
  logService.error('future-out-of-window');

  const ctx = await start({ logService });
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const r = await api(ctx.base, 'GET', '/api/logs/digest?date=2026-07-05', { sid });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.digest.total, 2);
    assert.deepEqual(r.body.digest.byLevel, { INFO: 1, WARN: 1 });
    assert.equal(r.body.digest.date, '2026-07-05');
    assert.equal(r.body.digest.lines.length, 2);
  } finally { await ctx.close(); }
});

test('다이제스트: date 미지정 시 현재 시각(clock) 기준 윈도우로 동작한다', async () => {
  let nowMs;
  const logService = createLogService({ clock: () => nowMs });
  nowMs = new Date(2026, 6, 4, 12, 0, 0).getTime(); // "전날" 정오 → 오늘 실행 윈도우 안
  logService.info('yesterday-noon');
  nowMs = new Date(2026, 6, 5, 10, 0, 0).getTime(); // "오늘" 10:00 = 조회 시각(now)

  const ctx = await start({ logService });
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const r = await api(ctx.base, 'GET', '/api/logs/digest', { sid }); // date 미지정
    assert.equal(r.status, 200);
    assert.equal(r.body.digest.date, '2026-07-05');
    assert.equal(r.body.digest.total, 1);
    assert.deepEqual(r.body.digest.byLevel, { INFO: 1 });
  } finally { await ctx.close(); }
});

test('다이제스트: 잘못된 date는 400 invalid-date(throw 아님)', async () => {
  const ctx = await start({ logService: createLogService() });
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', password: 'pw' });
    const sid = await login(ctx.base, 'kim', 'pw');

    const r = await api(ctx.base, 'GET', '/api/logs/digest?date=foo', { sid });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'invalid-date');
  } finally { await ctx.close(); }
});
