// 끝-끝 통합 스모크 — in-memory db로 createApp을 띄우고 시드→로그인→세션→기사 왕복을 확인한다.
// 운영 news.db는 절대 건드리지 않는다(:memory: 사용). 시드는 멱등이어야 한다(2회 실행 시 중복/삭제 없음).

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { seedUsers, SAMPLE_USERS } from '../src/db/seed.js';
import { createUserModel } from '../src/models/userModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp } from '../server/index.js';

async function start() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  seedUsers(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService });
  const app = createApp({ controllers, sessionService });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
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

test('seed가 멱등이다 — 2회 실행해도 중복/삭제 없이 동일한 3개 계정만 유지된다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);

  const first = seedUsers(db);
  assert.deepEqual(first.sort(), SAMPLE_USERS.map((u) => u.userId).sort()); // 최초엔 전부 삽입.

  const second = seedUsers(db);
  assert.deepEqual(second, []); // 두 번째엔 아무것도 삽입하지 않는다(멱등 skip).

  const all = createUserModel(db).query({});
  assert.equal(all.length, SAMPLE_USERS.length); // 중복 없음.
  // 비밀번호는 해시로 저장(평문 아님).
  const admin = createUserModel(db).findById('admin');
  assert.notEqual(admin.password, 'admin123');
  assert.match(admin.password, /^\$2[aby]\$/);
});

test('스모크: health → 시드 로그인 → 세션 복원 → 기사 create/query 왕복', async () => {
  const ctx = await start();
  try {
    // 1) health.
    const health = await api(ctx.base, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    // 2) 시드 사용자로 로그인 → sessionId 발급(비밀번호 미노출).
    const reporter = SAMPLE_USERS[0];
    const login = await api(ctx.base, 'POST', '/api/login', {
      body: { userId: reporter.userId, password: reporter.password },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.ok, true);
    assert.match(login.body.sessionId, /^[0-9a-f]{64}$/);
    assert.equal(login.body.user.password, undefined);
    const sid = login.body.sessionId;

    // 3) 세션 복원(F5) — 재인증 없이 신원 반환.
    const session = await api(ctx.base, 'GET', '/api/session', { sid });
    assert.equal(session.status, 200);
    assert.equal(session.body.user.userId, reporter.userId);
    assert.equal(session.body.user.role, 'R');

    // 4) 기사 create → query 왕복(1건 확인).
    const created = await api(ctx.base, 'POST', '/api/articles', {
      sid, body: { title: '스모크 제목', markupVersion: '{}' },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.ok, true);
    const { articleId } = created.body;

    const rows = await api(ctx.base, 'GET', `/api/articles?articleId=${articleId}`, { sid });
    assert.equal(rows.status, 200);
    assert.equal(rows.body.items.length, 1);
    assert.equal(rows.body.items[0].articleId, articleId);
    assert.equal(rows.body.items[0].title, '스모크 제목');
    assert.equal(rows.body.items[0].status, 'RDS'); // 최초 작성은 RDS.
    assert.equal(rows.body.items[0].department, reporter.department); // 세션 부서 stamp.
  } finally { await ctx.close(); }
});
