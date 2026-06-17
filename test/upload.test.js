// 파일 업로드 transport 테스트 — createApp({uploadDir})로 임시 디렉터리에 업로드한다.
// 계약: POST /api/upload (세션 게이트), JSON { filename, contentBase64(raw, prefix 없음) },
//   확장자 화이트리스트 + 5MB 디코드 크기 상한, <random-hex>.<ext>로 저장(원본 파일명 의존 금지),
//   200 { ok, path:'/uploads/<name>', filename }, GET /uploads/<name>로 정적 서빙.
// CRITICAL(ADR-004): 신원은 세션에서만 도출(미인증 401). DB는 손대지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

// 테스트마다 os.tmpdir() 아래 고유 업로드 디렉터리를 만든다 — 시작 시 빈 디렉터리.
function makeUploadDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
}

async function start({ uploadDir } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp({ controllers, sessionService, uploadDir });
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

// 1x1 투명 PNG의 raw base64(데이터 URI prefix 없음).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function rmDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

test('upload: 미인증 POST /api/upload → 401 unauthenticated', async () => {
  const uploadDir = makeUploadDir();
  const ctx = await start({ uploadDir });
  try {
    const r = await api(ctx.base, 'POST', '/api/upload', {
      body: { filename: 'a.png', contentBase64: PNG_BASE64 },
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'unauthenticated');
  } finally { await ctx.close(); rmDir(uploadDir); }
});

test('upload: 인증 + 유효 png → 200, 디스크 저장, GET /uploads/<name>으로 바이트 반환', async () => {
  const uploadDir = makeUploadDir();
  const ctx = await start({ uploadDir });
  try {
    seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    const r = await api(ctx.base, 'POST', '/api/upload', {
      sid, body: { filename: '사진.PNG', contentBase64: PNG_BASE64 },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.filename, '사진.PNG');
    // path는 /uploads/<random-hex>.png 형태 — 원본 파일명에 의존하지 않는다(경로 탐색 방지).
    assert.match(r.body.path, /^\/uploads\/[0-9a-f]+\.png$/);

    // 디스크에 실제 저장됐는지 확인.
    const name = r.body.path.replace('/uploads/', '');
    const onDisk = path.join(uploadDir, name);
    assert.ok(fs.existsSync(onDisk), '업로드 파일이 uploadDir에 존재해야 한다');
    const expected = Buffer.from(PNG_BASE64, 'base64');
    assert.deepEqual(fs.readFileSync(onDisk), expected);

    // 정적 서빙: GET /uploads/<name> → 저장된 바이트.
    const served = await fetch(`${ctx.base}${r.body.path}`);
    assert.equal(served.status, 200);
    const servedBytes = Buffer.from(await served.arrayBuffer());
    assert.deepEqual(servedBytes, expected);
  } finally { await ctx.close(); rmDir(uploadDir); }
});

test('upload: 허용되지 않은 확장자(.exe) → 400 invalid-file', async () => {
  const uploadDir = makeUploadDir();
  const ctx = await start({ uploadDir });
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    const r = await api(ctx.base, 'POST', '/api/upload', {
      sid, body: { filename: 'malware.exe', contentBase64: PNG_BASE64 },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'invalid-file');

    // 디렉터리에 아무것도 쓰이지 않았어야 한다.
    assert.equal(fs.readdirSync(uploadDir).length, 0);
  } finally { await ctx.close(); rmDir(uploadDir); }
});

test('upload: 경로 탐색 파일명(../)은 무력화된다 — 저장명은 random-hex, uploadDir 밖으로 새지 않는다', async () => {
  const uploadDir = makeUploadDir();
  const ctx = await start({ uploadDir });
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    const r = await api(ctx.base, 'POST', '/api/upload', {
      sid, body: { filename: '../../../../etc/passwd.png', contentBase64: PNG_BASE64 },
    });
    // 확장자(.png)는 허용이지만 저장명은 원본 경로를 절대 쓰지 않는다.
    assert.equal(r.status, 200);
    assert.match(r.body.path, /^\/uploads\/[0-9a-f]+\.png$/);
    assert.ok(!r.body.path.includes('..'), 'path에 ".."가 없어야 한다');

    // uploadDir 안에 정확히 1개(hex.png)만 생기고, 상위로 새어나간 파일이 없어야 한다.
    const entries = fs.readdirSync(uploadDir);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^[0-9a-f]+\.png$/);
    assert.ok(!fs.existsSync(path.join(uploadDir, '..', 'passwd.png')), '상위 디렉터리로 새지 않아야 한다');
  } finally { await ctx.close(); rmDir(uploadDir); }
});

test('upload: 5MB 초과(디코드) → 400 too-large', async () => {
  const uploadDir = makeUploadDir();
  const ctx = await start({ uploadDir });
  try {
    seedUser(ctx.db, { userId: 'kim', role: 'R', department: '사회부', password: 'pw' });
    const sid = (await login(ctx.base, 'kim', 'pw')).sessionId;

    // 5MB + 1바이트 → base64로 인코딩(디코드 크기가 상한 초과).
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41).toString('base64');
    const r = await api(ctx.base, 'POST', '/api/upload', {
      sid, body: { filename: 'big.pdf', contentBase64: big },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'too-large');

    assert.equal(fs.readdirSync(uploadDir).length, 0);
  } finally { await ctx.close(); rmDir(uploadDir); }
});
