// 테스트 게이트 보강 (phase 60 — same-origin-serving) — 구현 스위트가 순수 함수로만 잠근 계약을
// HTTP 왕복·실기 부트로 교차 검증한다. 프로덕션 코드는 무수정(테스트만 추가).
// 보강 4건:
//  T1 대문자 예약 접두사(HTTP 왕복) — 소문자화 계약이 순수 함수(A3) 밖의 실제 요청 경로에서도 유효한지.
//  T2 정적 파일 vs 폴백 우선순위 — dist에 SPA 라우트와 같은 이름의 실파일이 있으면 정적이 먼저다
//     (express.static → 폴백 등록 순서의 행동 잠금).
//  T3 fail-closed 중 FTP 스풀 인제스트 경로 무영향 — HTTP 503이어도 bootstrap watcher가 쓰는
//     controllers.collection.receive 직접 호출(HTTP 밖 경로)은 정상 동작한다(phase 계획 decisions (9)).
//  T4 bootstrap 결선 실기 E2E — 테스트 스위트가 실행하지 않는 bootstrap()을 자식 프로세스로 실기 기동해
//     resolveSpaDir(SPA_DIR)·resolveHost(HOST)·requireCollectionToken 주입이 실제로 결선됐는지 확인한다
//     (구현자 스모크의 재현 — cwd는 임시 디렉토리라 프로덕션 news.db에 바인딩하지 않는다).

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createReceiverConfigModel } from '../src/models/receiverConfigModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };
const HTML_ACCEPT = 'text/html,application/xhtml+xml,*/*;q=0.8';

const FIXTURE_INDEX = '<!doctype html><html lang="ko"><body>HARDENING-FIXTURE-INDEX</body></html>';
const FIXTURE_ASSET = 'console.log("HARDENING-FIXTURE-ASSET");';

function makeFakeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-hard-'));
  fs.writeFileSync(path.join(dir, 'index.html'), FIXTURE_INDEX);
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), FIXTURE_ASSET);
  return dir;
}

async function start({ spaDir, requireCollectionToken } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp({ controllers, spaDir, requireCollectionToken });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, controllers, base, close: () => new Promise((r) => server.close(r)) };
}

// process.env의 한 키를 임시 조작하고 반드시 원복한다(host-binding.test.js와 동일 규율).
async function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  }
}

// --- T1. 대문자 예약 접두사 — HTTP 왕복 잠금 ---
// 순수 함수 A3만으로는 라우팅 결선이 규칙을 실제로 쓰는지 보장되지 않는다(변이 M4에서 A3만 red였다).
// Express 라우팅은 기본 case-insensitive이므로 /API/*·/UPLOADS/*도 예약 네임스페이스다 —
// 폴백이 대문자를 비-API로 오분류하면 API 네임스페이스가 200 HTML을 돌려주는 드리프트가 된다.
test('T1: GET /API/unknown·/Api/x·/UPLOADS/missing.png (Accept: text/html) → 404, 본문은 index.html이 아니다', async () => {
  const ctx = await start({ spaDir: makeFakeDist() });
  try {
    for (const p of ['/API/unknown', '/Api/unknown', '/UPLOADS/missing.png']) {
      const res = await fetch(`${ctx.base}${p}`, { headers: { accept: HTML_ACCEPT } });
      assert.equal(res.status, 404, p);
      assert.ok(!(await res.text()).includes('HARDENING-FIXTURE-INDEX'), `${p}: 폴백이 먹었다`);
    }
  } finally { await ctx.close(); }
});

// --- T2. 정적 파일 vs 폴백 우선순위 ---
// dist에 SPA 라우트와 같은 이름의 실파일(login.do)이 있으면 express.static이 폴백보다 먼저 서빙한다.
// vite 산출물에는 .do 실파일이 없지만, 등록 순서(정적 → 폴백)의 행동을 잠가 훗날 순서가 뒤집혀도
// (폴백이 실파일을 가리는 드리프트) 테스트가 잡는다.
test('T2: dist에 실파일 login.do가 있으면 GET /login.do는 폴백(index.html)이 아니라 그 파일이다', async () => {
  const dist = makeFakeDist();
  fs.writeFileSync(path.join(dist, 'login.do'), 'REAL-LOGIN-DO-FILE');
  const ctx = await start({ spaDir: dist });
  try {
    const res = await fetch(`${ctx.base}/login.do`, { headers: { accept: HTML_ACCEPT } });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, 'REAL-LOGIN-DO-FILE');
    assert.ok(!body.includes('HARDENING-FIXTURE-INDEX'));
    // 실파일이 없는 다른 SPA 라우트는 여전히 폴백이다(우선순위이지 폴백 무력화가 아니다).
    const fallback = await fetch(`${ctx.base}/list.do`, { headers: { accept: HTML_ACCEPT } });
    assert.equal(fallback.status, 200);
    assert.equal(await fallback.text(), FIXTURE_INDEX);
  } finally { await ctx.close(); }
});

// --- T3. fail-closed 중에도 FTP 스풀 인제스트 경로는 무영향 ---
// bootstrap의 FTP watcher는 HTTP를 거치지 않고 controllers.collection.receive를 직접 호출한다.
// fail-closed 가드는 HTTP transport(2개 라우트)에만 있으므로 이 경로는 계속 동작해야 한다.
test('T3: requireCollectionToken=true + 토큰 미설정 — HTTP는 503이지만 컨트롤러 직접 호출(FTP 경로)은 정상 수집된다', async () => {
  await withEnv('COLLECTION_TOKEN', undefined, async () => {
    const ctx = await start({ requireCollectionToken: true });
    try {
      createReceiverConfigModel(ctx.db).insert({ sourceId: 'src-ftp', type: 'FTP', active: 'Y' });
      const before = ctx.controllers.article.query({}).length;

      // HTTP 경로 — 503 fail-closed.
      const res = await fetch(`${ctx.base}/api/collection/receive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId: 'src-ftp', payload: '제목\n본문' }),
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).reason, 'collection-disabled');
      assert.equal(ctx.controllers.article.query({}).length, before);

      // FTP 스풀 경로(bootstrap watcher와 동일한 직접 호출) — 가드 없이 정상 수집.
      const r = ctx.controllers.collection.receive('src-ftp', '자동제목\n자동본문');
      assert.equal(r.ok, true);
      const rows = ctx.controllers.article.query({ articleId: r.articleId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].attribute, '자동기사');
      assert.equal(ctx.controllers.article.query({}).length, before + 1);
    } finally { await ctx.close(); }
  });
});

// --- T4. bootstrap 결선 실기 E2E ---
// createApp 주입 테스트는 bootstrap()의 결선(resolveSpaDir·resolveHost·requireCollectionToken 주입,
// app.listen(port, host))을 실행하지 못한다. 자식 프로세스로 실기 기동해 그 결선을 잠근다.
// CRITICAL(격리): cwd를 임시 디렉토리로 준다 — bootstrap의 new DatabaseSync('news.db')가
//   그 안에 새 파일을 만들므로 프로덕션 news.db에는 절대 바인딩하지 않는다.
// HOST=0.0.0.0(비-loopback)이지만 접속은 127.0.0.1로만 한다(외부 인바운드 불요).
test('T4: 실기 부트 — SPA_DIR 서빙 + HOST=0.0.0.0 무토큰이면 수집 HTTP 503, health·정적·폴백은 정상', async () => {
  const serverPath = fileURLToPath(new URL('../server/index.js', import.meta.url));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-e2e-'));
  const dist = makeFakeDist();
  const port = 20000 + Math.floor(Math.random() * 30000);
  const env = { ...process.env, PORT: String(port), HOST: '0.0.0.0', SPA_DIR: dist };
  // fail-closed 조건·부수 기능을 결정적으로 만든다 — 상속 env의 우연한 값 제거.
  delete env.COLLECTION_TOKEN;
  delete env.RCV_SPOOL_DIR;
  delete env.DIST_SPOOL_DIR;
  delete env.NODE_ENV;
  delete env.FORCE_HTTPS;
  delete env.DATA_DIR; // phase 61 — 상속되면 news.db가 cwd 밖에 생겨 임시 cwd 격리 단언이 깨진다.

  const child = spawn(process.execPath, [serverPath], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const base = `http://127.0.0.1:${port}`;
  try {
    // 기동 대기 — health가 200이 될 때까지 폴링(최대 15초). 자식이 죽으면 즉시 실패.
    let ready = false;
    for (let i = 0; i < 150 && !ready; i += 1) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
        ready = res.status === 200 && (await res.json()).ok === true;
      } catch { /* 아직 기동 전 — 재시도 */ }
      if (!ready) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready, `서버가 기동하지 않았다 (exitCode=${child.exitCode})\n${stderr}`);

    // (1) SPA 폴백 — bootstrap이 SPA_DIR을 결선했다.
    const login = await fetch(`${base}/login.do`, { headers: { accept: HTML_ACCEPT } });
    assert.equal(login.status, 200);
    assert.equal(await login.text(), FIXTURE_INDEX);

    // (2) 정적 자산 — Accept 무관(undici 기본 */*) 200.
    const asset = await fetch(`${base}/assets/app-abc123.js`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), FIXTURE_ASSET);

    // (3) Accept에 text/html이 없으면 폴백 없음 — 기존 404 계약 그대로.
    const nonHtml = await fetch(`${base}/list.do`, { headers: { accept: 'application/json' } });
    assert.equal(nonHtml.status, 404);

    // (4) 수집 fail-closed — bootstrap이 !isLoopbackHost('0.0.0.0')로 requireCollectionToken을 켰다.
    for (const route of ['/api/collection/receive', '/api/collection/pull']) {
      const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId: 'nope' }),
      });
      assert.equal(res.status, 503, route);
      assert.equal((await res.json()).reason, 'collection-disabled', route);
    }

    // (5) 격리 확인 — news.db는 임시 cwd 안에 생겼다(프로덕션 DB 무접촉의 증거).
    assert.ok(fs.existsSync(path.join(cwd, 'news.db')));
  } finally {
    child.kill();
    // Windows에서 즉시 안 죽으면 강제 종료를 한 번 더 시도한다(테스트 프로세스 잔류 방지).
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

// --- T5. 마운트 순서 잠금 — dist에 API와 같은 이름의 실파일이 있어도 API 라우트가 이긴다 ---
// 제외 술어가 우연히 지켜주는 것과 별개로 "라우트 → 정적 → 폴백" 등록 순서 자체를 행동으로 잠근다.
// (④ 게이트 변이 M6에서 마운트 전진 배치가 기존 스위트로는 red가 안 됨이 확인됐다 — 이 케이스가 그 갭을 메운다.)
test('T5: dist에 api/health 실파일이 있어도 GET /api/health는 JSON 라우트가 응답한다', async () => {
  const dir = makeFakeDist();
  fs.mkdirSync(path.join(dir, 'api'));
  fs.writeFileSync(path.join(dir, 'api', 'health'), 'STATIC-SHADOW-FILE');
  const ctx = await start({ spaDir: dir });
  try {
    const r = await fetch(`${ctx.base}/api/health`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /application\/json/);
    const body = await r.json();
    assert.equal(body.ok, true);
  } finally {
    await ctx.close();
  }
});

// --- T6. dot 디렉토리 하위 파일 차단 — dotfiles: 'ignore' 명시의 행동 잠금 ---
// express.static 기본(legacy) dotfile 처리는 마지막 세그먼트만 검사해 /.hidden/secret.txt가 200으로
// 노출된다. SPA_DIR은 운영자 설정값이라 dist 밖 루트가 올 수 있어 명시 ignore가 계약이다.
test('T6: /.hidden/secret.txt·/.env는 404이고 본문에 파일 내용이 없다', async () => {
  const dir = makeFakeDist();
  fs.mkdirSync(path.join(dir, '.hidden'));
  fs.writeFileSync(path.join(dir, '.hidden', 'secret.txt'), 'DOT-DIR-SECRET');
  fs.writeFileSync(path.join(dir, '.env'), 'DOTFILE-SECRET');
  const ctx = await start({ spaDir: dir });
  try {
    for (const p of ['/.hidden/secret.txt', '/.env']) {
      const r = await fetch(`${ctx.base}${p}`);
      assert.equal(r.status, 404, p);
      const text = await r.text();
      assert.ok(!text.includes('DOT-DIR-SECRET') && !text.includes('DOTFILE-SECRET'), p);
    }
  } finally {
    await ctx.close();
  }
});

// --- T7. isLoopbackHost 호스트명 오판 차단 — 127.로 시작하는 호스트명은 loopback이 아니다 ---
// fail-closed 게이트의 술어라 오차는 차단(안전) 방향이어야 한다. 127.example.com을 loopback으로
// 인정하면 DNS 결과에 따라 외부 바인딩인데 수집 가드가 꺼진다.
test('T7: isLoopbackHost — 점4자리 127.x.y.z만 참, 127.example.com·::ffff 변형은 거짓', async () => {
  const { isLoopbackHost } = await import('../server/index.js');
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.0.0.2'), true);
  assert.equal(isLoopbackHost('127.255.255.254'), true);
  assert.equal(isLoopbackHost('127.example.com'), false);
  assert.equal(isLoopbackHost('127.0.0'), false);
  assert.equal(isLoopbackHost('::ffff:127.0.0.1'), false); // 과도 차단 방향 — 안전측 수용(문서화된 계약)
});
