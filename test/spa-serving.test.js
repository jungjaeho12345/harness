// SPA 동일 출처 서빙 테스트 (phase 60 step0) — createApp({ spaDir })로 가짜 dist를 주입해 검증한다.
// 계약: (1) 정적 서빙 — <spaDir>의 빌드 산출물을 그대로 서빙, (2) SPA 폴백 — GET/HEAD ·
//   /api·/uploads 제외(대소문자 무관) · Accept: text/html 인 비-API 내비게이션만 index.html.
// CRITICAL: spaDir 미주입/index.html 부재면 현행과 완전히 동일(기존 404 계약 무회귀 — opt-in).
// 픽스처는 os.tmpdir()에 만든다(test/upload.test.js 전례) — web/dist는 조건부 스모크(E22)에서만 읽는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp, isSpaFallbackRequest, resolveSpaRoot, resolveSpaDir } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

// 가짜 dist 픽스처 — 실제 vite 산출물과 같은 구조(index.html + assets/…). 식별 표식 문자열 포함.
const FIXTURE_INDEX = '<!doctype html><html lang="ko"><head><title>spa</title></head>'
  + '<body><div id="root">SPA-FIXTURE-INDEX</div></body></html>';
const FIXTURE_ASSET = 'console.log("SPA-FIXTURE-ASSET");';

function makeFakeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-dist-'));
  fs.writeFileSync(path.join(dir, 'index.html'), FIXTURE_INDEX);
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), FIXTURE_ASSET);
  return dir;
}

async function start({ spaDir } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp({ controllers, spaDir });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
}

// fetch는 URL을 정규화해 '..'를 미리 없앤다 — 경로 탈출(C17)은 원시 경로 그대로 보내야 한다.
function rawGet(base, rawPath, headers = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: hostname, port, path: rawPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const HTML_ACCEPT = 'text/html,application/xhtml+xml,*/*;q=0.8';

// --- A. 순수 판정 함수 (HTTP 없이) ---

test('A1: isSpaFallbackRequest — 브라우저 내비게이션 GET은 true', () => {
  for (const p of ['/list.do', '/writer.do', '/', '/login.do', '/unknown/deep/path']) {
    assert.equal(isSpaFallbackRequest({ method: 'GET', path: p, accept: HTML_ACCEPT }), true, p);
  }
});

test('A2: isSpaFallbackRequest — 메서드 게이트(GET/HEAD만 true)', () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.equal(isSpaFallbackRequest({ method: m, path: '/list.do', accept: HTML_ACCEPT }), false, m);
  }
  assert.equal(isSpaFallbackRequest({ method: 'HEAD', path: '/list.do', accept: HTML_ACCEPT }), true);
});

test('A3: isSpaFallbackRequest — 예약 접두사 게이트(정확 일치·하위 경로, 대소문자 무관)', () => {
  for (const p of ['/api', '/api/', '/api/health', '/api/stream', '/uploads', '/uploads/x.png']) {
    assert.equal(isSpaFallbackRequest({ method: 'GET', path: p, accept: HTML_ACCEPT }), false, p);
  }
  // Express 라우팅은 기본 case-insensitive — 대문자 경로도 API 네임스페이스다.
  for (const p of ['/API/health', '/Api/unknown', '/UPLOADS/x.png']) {
    assert.equal(isSpaFallbackRequest({ method: 'GET', path: p, accept: HTML_ACCEPT }), false, p);
  }
  // 접두사가 단어 경계에서 끊기지 않으면 제외 대상이 아니다(단순 startsWith 금지의 잠금).
  for (const p of ['/apidocs', '/uploadsomething']) {
    assert.equal(isSpaFallbackRequest({ method: 'GET', path: p, accept: HTML_ACCEPT }), true, p);
  }
});

test('A4: isSpaFallbackRequest — Accept 게이트(text/html 포함일 때만 true)', () => {
  for (const accept of ['*/*', 'application/json', undefined, '']) {
    assert.equal(isSpaFallbackRequest({ method: 'GET', path: '/list.do', accept }), false, String(accept));
  }
  assert.equal(isSpaFallbackRequest({ method: 'GET', path: '/list.do', accept: 'text/html' }), true);
});

// --- B. 서빙 활성 (가짜 dist 주입) ---

test('B5: GET / → 200 index.html (정적 index)', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(await res.text(), FIXTURE_INDEX);
  } finally { await ctx.close(); }
});

test('B6: GET /assets/app-abc123.js → 200 픽스처 JS', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/assets/app-abc123.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.equal(await res.text(), FIXTURE_ASSET);
  } finally { await ctx.close(); }
});

test('B7: GET /list.do (Accept: text/html) → 200 index.html (SPA 폴백)', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/list.do`, { headers: { accept: HTML_ACCEPT } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), FIXTURE_INDEX);
  } finally { await ctx.close(); }
});

test('B8: GET /writer.do?articleId=A1 → 200 index.html (쿼리스트링 무관)', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/writer.do?articleId=A1`, { headers: { accept: HTML_ACCEPT } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), FIXTURE_INDEX);
  } finally { await ctx.close(); }
});

test('B9: HEAD /list.do (Accept: text/html) → 200, 본문 없음', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/list.do`, { method: 'HEAD', headers: { accept: HTML_ACCEPT } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  } finally { await ctx.close(); }
});

// --- C. 경계 — 폴백이 절대 먹으면 안 되는 곳(전부 "브라우저인 척" Accept: text/html) ---

test('C10: GET /api/health → 200 JSON (정적/폴백이 API를 가리지 않는다)', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/api/health`, { headers: { accept: HTML_ACCEPT } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally { await ctx.close(); }
});

test('C11: GET /api/articles 미인증 → 401 JSON (HTML 아님)', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/api/articles`, { headers: { accept: HTML_ACCEPT } });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, reason: 'unauthenticated' });
  } finally { await ctx.close(); }
});

test('C12: GET /api/stream 미인증 → 401 JSON (SSE 라우트 무손상)', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/api/stream`, { headers: { accept: HTML_ACCEPT } });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, reason: 'unauthenticated' });
  } finally { await ctx.close(); }
});

test('C13: GET /api/unknown-path → 404, 본문이 index.html이 아니다', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/api/unknown-path`, { headers: { accept: HTML_ACCEPT } });
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes('SPA-FIXTURE-INDEX'));
  } finally { await ctx.close(); }
});

test('C14: GET /uploads/missing.png → 404, 본문이 index.html이 아니다', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/uploads/missing.png`, { headers: { accept: HTML_ACCEPT } });
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes('SPA-FIXTURE-INDEX'));
  } finally { await ctx.close(); }
});

test('C15: POST /list.do (Accept: text/html) → 404 (비-GET은 폴백 대상 아님)', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/list.do`, { method: 'POST', headers: { accept: HTML_ACCEPT } });
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes('SPA-FIXTURE-INDEX'));
  } finally { await ctx.close(); }
});

test('C16: GET /assets/does-not-exist.js (Accept: */*) → 404, HTML 200 함정 차단', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/assets/does-not-exist.js`, { headers: { accept: '*/*' } });
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes('SPA-FIXTURE-INDEX'));
  } finally { await ctx.close(); }
});

test('C17: 경로 탈출 — 정적 루트 밖 파일 내용이 응답에 실리지 않는다(원시 경로 요청)', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    // 기대 동작: express.static이 탈출 시도를 거부하고 next()로 흘리면(fallthrough) 폴백이
    // index.html을 준다(200) — 상태 코드는 단언하지 않는다. 계약은 "루트 밖 내용 미노출"뿐이다.
    for (const rawPath of ['/../package.json', '/..%2f..%2fpackage.json', '/%2e%2e/news.db']) {
      const res = await rawGet(ctx.base, rawPath, { accept: HTML_ACCEPT });
      assert.ok(!res.body.includes('article-production-system'), `${rawPath}: package.json 내용 노출`);
      assert.ok(!res.body.includes('SQLite format 3'), `${rawPath}: SQLite 파일 내용 노출`);
    }
  } finally { await ctx.close(); }
});

test('C18: CSRF 무간섭 — 활성 상태에서도 악성 Origin의 POST는 403 forbidden-origin', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    const res = await fetch(`${ctx.base}/api/logout`, {
      method: 'POST', headers: { origin: 'https://evil.example', accept: HTML_ACCEPT },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, reason: 'forbidden-origin' });
  } finally { await ctx.close(); }
});

// --- D. 비활성 (현행 동작 완전 동일 — opt-in의 핵심 계약) ---

async function assertInactive(ctx) {
  for (const [method, p, accept] of [
    ['GET', '/list.do', HTML_ACCEPT],
    ['GET', '/', HTML_ACCEPT],
    ['GET', '/assets/app-abc123.js', '*/*'],
  ]) {
    const res = await fetch(`${ctx.base}${p}`, { method, headers: { accept } });
    assert.equal(res.status, 404, `${method} ${p} → 404이어야 한다(500 금지)`);
  }
}

test('D19: spaDir 미주입 → 미정의 경로는 전부 404 (기존 동작)', async () => {
  const ctx = await start();
  try { await assertInactive(ctx); } finally { await ctx.close(); }
});

test('D20: spaDir가 빈 디렉터리(index.html 없음) → 404이며 500이 아니다', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-empty-'));
  const ctx = await start({ spaDir: empty });
  try { await assertInactive(ctx); } finally { await ctx.close(); }
});

test('D21: spaDir가 존재하지 않는 경로 → throw 없이 404 (500 아님)', async () => {
  const missing = path.join(os.tmpdir(), 'spa-does-not-exist-', String(Date.now()));
  const ctx = await start({ spaDir: missing }); // createApp이 throw하면 여기서 실패한다.
  try { await assertInactive(ctx); } finally { await ctx.close(); }
});

// --- E. 실제 빌드 산출물 스모크 (web/dist 있을 때만) ---

const REAL_DIST = fileURLToPath(new URL('../web/dist', import.meta.url));
const REAL_INDEX = path.join(REAL_DIST, 'index.html');

test('E22: 실제 web/dist 서빙 + CSP 호환 잠금', { skip: !fs.existsSync(REAL_INDEX) }, async () => {
  const ctx = await start({ spaDir: REAL_DIST });
  try {
    const res = await fetch(`${ctx.base}/login.do`, { headers: { accept: HTML_ACCEPT } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal(html, fs.readFileSync(REAL_INDEX, 'utf8'));

    // 해시를 하드코딩하지 않는다 — index.html에서 script src를 추출해 그대로 요청한다.
    const script = html.match(/<script[^>]*\bsrc="([^"]+)"/);
    assert.ok(script, 'index.html에 <script src>가 있어야 한다');
    const asset = await fetch(`${ctx.base}${script[1]}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);

    // CSP 호환 잠금 — 이 단언이 red면 CSP 완화가 아니라 빌드 설정을 의심하라(step0 결정 (6)).
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .filter((m) => m[1].trim().length > 0);
    assert.equal(inlineScripts.length, 0, '내용이 있는 인라인 <script>가 없어야 한다');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.ok(m[1].startsWith('/'), `동일 출처 절대 경로여야 한다: ${m[1]}`);
    }
  } finally { await ctx.close(); }
});

// --- F. 부트 결선 헬퍼 resolveSpaRoot / resolveSpaDir (순수 함수 — bootstrap은 테스트가 실행하지 않는다) ---

test('F23: resolveSpaRoot — index.html 존재 시 절대 경로, 부재/비문자열/빈 값이면 undefined (throw 없음)', () => {
  const dist = makeFakeDist();
  assert.equal(resolveSpaRoot(dist), path.resolve(dist));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-empty-'));
  assert.equal(resolveSpaRoot(empty), undefined); // 디렉토리는 있어도 index.html이 없으면 비활성.
  assert.equal(resolveSpaRoot(path.join(os.tmpdir(), 'spa-none-', String(Date.now()))), undefined);
  for (const v of [undefined, null, '', '   ', 42]) {
    assert.equal(resolveSpaRoot(v), undefined, String(v));
  }
});

test('F24: resolveSpaDir — SPA_DIR 미설정이면 defaultDir 그대로(기본 경로 계산은 호출부 책임), 설정 시 그 값(절대화)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-base-'));
  assert.equal(resolveSpaDir({}, base), base);
  assert.equal(resolveSpaDir({ SPA_DIR: '/opt/news/web-dist' }, base), path.resolve('/opt/news/web-dist'));
  // 상대 경로는 절대화한다.
  assert.equal(resolveSpaDir({ SPA_DIR: 'rel/dist' }, base), path.resolve('rel/dist'));
});

test('F25: resolveSpaDir — 명시적 빈 값(SPA_DIR=)은 undefined (off 스위치)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-base-'));
  assert.equal(resolveSpaDir({ SPA_DIR: '' }, base), undefined);
  assert.equal(resolveSpaDir({ SPA_DIR: '   ' }, base), undefined);
});
