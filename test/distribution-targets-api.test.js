// 배부 대상 transport 테스트 — GET/POST /api/distribution-targets, PUT /:id, POST /:id/deactivate.
// 계약: 4개 라우트 전부 Z 전용 세션 게이트(미인증 401 / 비-Z 403). 게이트는 distributionTargetService가 강제하고
//   라우트는 위임만 한다(ADR-006 얇은 transport).
// CRITICAL(ADR-004): acting role은 검증된 세션에서만 도출 — body의 role은 무시된다.
// DB 비파괴: DELETE 라우트는 존재하지 않는다(비활성은 POST /:id/deactivate = active='N').

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
const VALID = { name: 'KBS 뉴스', kind: 'press', spoolDir: 'kbs' };

async function start() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
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

// 4개 라우트를 한 번에 두드리는 헬퍼(미인증/비-Z 게이트 검증용).
async function hitAll(base, sid) {
  return [
    await api(base, 'GET', '/api/distribution-targets', { sid }),
    await api(base, 'POST', '/api/distribution-targets', { sid, body: VALID }),
    await api(base, 'PUT', '/api/distribution-targets/1', { sid, body: { name: 'x' } }),
    await api(base, 'POST', '/api/distribution-targets/1/deactivate', { sid }),
  ];
}

test('distribution-targets: 미인증은 4개 라우트 전부 401 unauthenticated', async () => {
  const ctx = await start();
  try {
    for (const r of await hitAll(ctx.base)) {
      assert.equal(r.status, 401);
      assert.equal(r.body.reason, 'unauthenticated');
    }
  } finally { await ctx.close(); }
});

test('distribution-targets: 비-Z(R/D)는 4개 라우트 전부 403 forbidden', async () => {
  const ctx = await start();
  try {
    for (const role of ['R', 'D']) {
      const sid = await loginAs(ctx, role, `user-${role}`);
      for (const r of await hitAll(ctx.base, sid)) {
        assert.equal(r.status, 403, `${role} 라우트 상태`);
        assert.equal(r.body.reason, 'forbidden');
      }
    }
    // 게이트가 실제 쓰기를 막았는지 DB로 확인.
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM DistributionTarget').get().c, 0);
  } finally { await ctx.close(); }
});

test('distribution-targets: body의 role:Z 스푸핑은 통하지 않는다 (신뢰 경계는 세션)', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'R', 'rep');
    const post = await api(ctx.base, 'POST', '/api/distribution-targets', {
      sid, body: { ...VALID, role: 'Z' },
    });
    assert.equal(post.status, 403);
    assert.equal(post.body.reason, 'forbidden');

    const get = await api(ctx.base, 'GET', '/api/distribution-targets?role=Z', { sid });
    assert.equal(get.status, 403);

    const put = await api(ctx.base, 'PUT', '/api/distribution-targets/1', {
      sid, body: { name: 'x', role: 'Z' },
    });
    assert.equal(put.status, 403);

    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM DistributionTarget').get().c, 0);
  } finally { await ctx.close(); }
});

test('distribution-targets: Z 풀 루프 — 등록 → 목록 → 수정 → 비활성(행 보존)', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'Z', 'admin');

    const created = await api(ctx.base, 'POST', '/api/distribution-targets', { sid, body: VALID });
    assert.equal(created.status, 200);
    assert.equal(created.body.ok, true);
    assert.equal(typeof created.body.id, 'number');
    const { id } = created.body;

    const listed = await api(ctx.base, 'GET', '/api/distribution-targets', { sid });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.deepEqual(
      Object.keys(listed.body.items[0]).sort(),
      ['active', 'createdAt', 'id', 'kind', 'name', 'spoolDir', 'updatedAt'],
    );
    assert.equal(listed.body.items[0].spoolDir, 'kbs');
    assert.equal(listed.body.items[0].active, 'Y');

    const updated = await api(ctx.base, 'PUT', `/api/distribution-targets/${id}`, {
      sid, body: { name: 'KBS 보도본부', kind: 'nonpress' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.changes, 1);

    const afterUpdate = await api(ctx.base, 'GET', '/api/distribution-targets?kind=nonpress', { sid });
    assert.equal(afterUpdate.body.items.length, 1);
    assert.equal(afterUpdate.body.items[0].name, 'KBS 보도본부');

    const off = await api(ctx.base, 'POST', `/api/distribution-targets/${id}/deactivate`, { sid });
    assert.equal(off.status, 200);
    assert.equal(off.body.ok, true);
    assert.equal(off.body.changes, 1);

    const afterOff = await api(ctx.base, 'GET', '/api/distribution-targets', { sid });
    assert.equal(afterOff.body.items.length, 1, '비활성 후에도 목록에 남는다(soft delete)');
    assert.equal(afterOff.body.items[0].active, 'N');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM DistributionTarget').get().c, 1);
  } finally { await ctx.close(); }
});

test('distribution-targets: 잘못된 spoolDir/kind/name POST → 400 + 지정 reason', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'Z', 'admin');

    for (const spoolDir of ['../escape', 'a/b', 'a\\b', '/etc', 'C:\\x', 'kbs\u0000', 'con', 'KBS', null, 123]) {
      const r = await api(ctx.base, 'POST', '/api/distribution-targets', {
        sid, body: { name: '대상', kind: 'press', spoolDir },
      });
      assert.equal(r.status, 400, `spoolDir ${JSON.stringify(spoolDir)}`);
      assert.equal(r.body.reason, 'invalid-spool-dir');
    }
    // spoolDir 키 자체가 누락된 요청도 거부된다.
    const missing = await api(ctx.base, 'POST', '/api/distribution-targets', {
      sid, body: { name: '대상', kind: 'press' },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.reason, 'invalid-spool-dir');

    const badKind = await api(ctx.base, 'POST', '/api/distribution-targets', {
      sid, body: { name: '대상', kind: 'PRESS', spoolDir: 'kbs' },
    });
    assert.equal(badKind.status, 400);
    assert.equal(badKind.body.reason, 'invalid-kind');

    const badName = await api(ctx.base, 'POST', '/api/distribution-targets', {
      sid, body: { name: null, kind: 'press', spoolDir: 'kbs' },
    });
    assert.equal(badName.status, 400);
    assert.equal(badName.body.reason, 'invalid-name');

    // 어떤 거부도 행을 만들지 않는다 — 'null'/'undefined' 문자열 행이 없어야 한다.
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM DistributionTarget').get().c, 0);
  } finally { await ctx.close(); }
});

test('distribution-targets: 빈 바디 POST도 500이 아니라 400으로 수렴한다', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'Z', 'admin');
    const r = await api(ctx.base, 'POST', '/api/distribution-targets', { sid });
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, 'invalid-name');
  } finally { await ctx.close(); }
});

test('distribution-targets: 없는 id의 PUT/deactivate → 404 not-found', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'Z', 'admin');

    const put = await api(ctx.base, 'PUT', '/api/distribution-targets/9999', {
      sid, body: { name: '없음' },
    });
    assert.equal(put.status, 404);
    assert.equal(put.body.reason, 'not-found');

    const off = await api(ctx.base, 'POST', '/api/distribution-targets/9999/deactivate', { sid });
    assert.equal(off.status, 404);
    assert.equal(off.body.reason, 'not-found');
  } finally { await ctx.close(); }
});

test('distribution-targets: 비수치 :id도 500이 아니라 404 not-found (회귀 잠금)', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'Z', 'admin');
    // 기존 행이 있어도 NaN id는 어떤 행에도 매치되지 않는다.
    await api(ctx.base, 'POST', '/api/distribution-targets', { sid, body: VALID });

    const put = await api(ctx.base, 'PUT', '/api/distribution-targets/abc', {
      sid, body: { name: '변경' },
    });
    assert.equal(put.status, 404);
    assert.equal(put.body.reason, 'not-found');

    const off = await api(ctx.base, 'POST', '/api/distribution-targets/abc/deactivate', { sid });
    assert.equal(off.status, 404);
    assert.equal(off.body.reason, 'not-found');

    // 기존 행은 그대로다.
    const listed = await api(ctx.base, 'GET', '/api/distribution-targets', { sid });
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].active, 'Y');
  } finally { await ctx.close(); }
});

test('distribution-targets: DELETE /api/distribution-targets/:id 라우트는 존재하지 않는다 (DB 비파괴)', async () => {
  const ctx = await start();
  try {
    const sid = await loginAs(ctx, 'Z', 'admin');
    const { body: created } = await api(ctx.base, 'POST', '/api/distribution-targets', { sid, body: VALID });

    // 핸들러 미등록 → Express 기본 404(JSON 응답 계약이 아니다).
    const del = await api(ctx.base, 'DELETE', `/api/distribution-targets/${created.id}`, { sid });
    assert.equal(del.status, 404);
    assert.equal(del.body?.ok, undefined, '삭제 성공 응답이 있어서는 안 된다');

    // 행은 그대로 남아 있다.
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM DistributionTarget').get().c, 1);
  } finally { await ctx.close(); }
});
