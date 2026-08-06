// CSRF Origin/Referer 가드 transport 테스트 (phase 52 step0, ADR-009).
// 검증: 상태 변경 메서드(비 GET/HEAD/OPTIONS)에서 교차 출처 Origin/Referer는 403 + 부수효과 0,
//       자기 출처·ALLOWED_ORIGINS·비프로덕션 loopback은 통과, Origin·Referer 부재(서버-서버/cron)는 통과,
//       읽기(GET)·preflight(OPTIONS)는 대상 밖, X-Forwarded-Host 스푸핑으로 자기 출처를 위장할 수 없음.
// env(NODE_ENV)와 출처 목록(origins)은 createApp에 주입한다 — 전역 process.env에 의존하지 않는다
// (test/https-enforcement.test.js와 동일 규약). 세션/도메인/DB는 무변경 — transport(server/index.js)만 본다.
//
// 프로덕션 앱 전제: env:'production'이면 trust proxy=1 + 평문→https 308 리다이렉트가 CSRF 가드보다 앞에 선다.
// 따라서 프로덕션 앱을 쓰는 모든 요청에 x-forwarded-proto: https를 싣는다(안 실으면 가드가 아니라 리다이렉트를 측정한다).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createReceiverConfigModel } from '../src/models/receiverConfigModel.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp, allowedOrigins, logOriginDiagnostics, SESSION_COOKIE_NAME } from '../server/index.js';

// media 분기용 기본 env(API 키) — NODE_ENV와는 별개 축이다.
const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

// 송고(send)가 도메인 규칙(끝 표시)까지 통과하도록 종료 마커가 있는 본문을 쓴다 —
// 그래야 "403은 가드 때문이고, 같은 요청이 Origin만 없으면 실제로 성사된다"가 성립한다.
const END_MARKUP = JSON.stringify({
  format: 'yh-editor', version: 1,
  blocks: [{ type: 'text', text: '제목' }, { type: 'text', text: '본문' }, { type: 'text', text: '(끝)' }],
});

const PROD_HOST = 'app.example';
const EVIL_ORIGIN = 'https://evil.example';

// env(NODE_ENV)·origins(허용 출처 목록)를 주입해 createApp을 띄운다.
async function start({ env, origins } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV });
  const app = createApp({ controllers, sessionService, env, origins });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
}

function seedUser(db, user) {
  createUserModel(db).insert({ active: 'Y', ...user, password: bcrypt.hashSync(user.password, 10) });
}

// node:http.request 기반 raw 요청 — fetch가 금지 헤더로 막는 Host/Origin/Referer를 그대로 보낸다.
async function rawFetch(base, method, path, { headers = {}, body } = {}) {
  const u = new URL(`${base}${path}`);
  const h = { ...headers };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
    h['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: res.statusCode, body: json, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// 프로덕션 앱용 기본 헤더(리다이렉트 회피 + 자기 출처 판정의 Host 고정).
function prod(extra = {}) {
  return { host: PROD_HOST, 'x-forwarded-proto': 'https', ...extra };
}

// 로그인은 Origin 없이 수행한다(가드 대상 밖) → 브라우저가 자동 첨부하는 쿠키를 모사할 Cookie 헤더를 만든다.
async function loginCookie(base, headers, userId, password) {
  const r = await rawFetch(base, 'POST', '/api/login', { headers, body: { userId, password } });
  assert.equal(r.status, 200, '로그인 자체는 성공해야 한다(Origin 부재 = 가드 통과)');
  return `${SESSION_COOKIE_NAME}=${r.body.sessionId}`;
}

const statusOf = (db, articleId) => db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status;
const lockOf = (db, articleId) => db.prepare('SELECT lockYN FROM Contents WHERE articleId = ?').get(articleId).lockYN;
const titleOf = (db, articleId) => db.prepare('SELECT title FROM Contents WHERE articleId = ?').get(articleId).title;
const countRows = (db, table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

// --- allowedOrigins: cors 옵션과 CSRF 가드가 공유하는 단일 출처 ---
test('allowedOrigins: 기본값은 오늘의 CORS allowlist와 동일하다', () => {
  assert.deepEqual(allowedOrigins({}), ['http://localhost:5173', 'http://127.0.0.1:5173']);
  // 인자 미주입(process.env)도 기본 두 항목을 항상 포함한다.
  for (const o of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
    assert.ok(allowedOrigins().includes(o), `${o} must stay in the default allowlist`);
  }
});

test('allowedOrigins: ALLOWED_ORIGINS(콤마 구분)를 트림·빈 값 제외 후 append 한다', () => {
  const list = allowedOrigins({ ALLOWED_ORIGINS: ' https://a.example , , https://b.example ' });
  assert.deepEqual(list, [
    'http://localhost:5173', 'http://127.0.0.1:5173',
    'https://a.example', 'https://b.example',
  ]);
});

// --- phase 54 step2: 프로덕션 기본 allowlist에서 dev loopback 제외 ---
// 프로덕션 쿠키는 SameSite=None; Secure라 cross-site 요청에도 붙고, 이 목록은 CORS(응답 읽기)와
// CSRF 가드(쓰기 실행)가 공유한다 → http://localhost:5173으로 열린 아무 로컬 페이지가 운영 API를
// 피해자 세션으로 호출·판독할 수 있었다(Origin 위조 불필요 — 브라우저가 진짜 그 값을 보낸다).
// 운영 영향: 프로덕션 배포는 ALLOWED_ORIGINS에 SPA 출처를 등록해야 한다(미설정 시 자기 출처 외 쓰기 403).
test('allowedOrigins: 프로덕션에서는 기본 loopback을 내보내지 않는다(빈 배열)', () => {
  assert.deepEqual(allowedOrigins({ NODE_ENV: 'production' }), []);
});

// 프로덕션 부트스트랩의 실제 배선 확인 — bootstrap()이 `allowedOrigins()`(무인자 = process.env)를 한 번
// 계산해 createApp(origins)와 부트 진단에 같은 값으로 넘긴다. 즉 이 함수가 process.env.NODE_ENV를
// 실제로 읽어야 운영에서 loopback이 빠진다. 인자 주입 테스트만으로는 이 결선이 검증되지 않는다.
test('allowedOrigins: 무인자 호출은 process.env를 읽는다(프로덕션 기본 배선에서 loopback 제외)', () => {
  const prevEnv = process.env.NODE_ENV;
  const prevList = process.env.ALLOWED_ORIGINS;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOWED_ORIGINS;
    assert.deepEqual(allowedOrigins(), []);

    process.env.ALLOWED_ORIGINS = 'https://spa.example';
    assert.deepEqual(allowedOrigins(), ['https://spa.example']);
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    if (prevList === undefined) delete process.env.ALLOWED_ORIGINS; else process.env.ALLOWED_ORIGINS = prevList;
  }
  // 환경 복원 확인 — 뒤따르는 테스트(무인자 기본값 계약)가 오염되지 않는다.
  assert.ok(allowedOrigins().includes('http://localhost:5173'));
});

test('allowedOrigins: 프로덕션에서도 ALLOWED_ORIGINS 파싱 규칙(트림·빈 값 제외·순서)은 그대로다', () => {
  assert.deepEqual(
    allowedOrigins({ NODE_ENV: 'production', ALLOWED_ORIGINS: ' https://spa.example , ,https://admin.example ' }),
    ['https://spa.example', 'https://admin.example'],
  );
});

test('allowedOrigins: 비프로덕션(미지정/development/test)은 기본 두 항목을 그대로 포함한다', () => {
  for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }]) {
    assert.deepEqual(allowedOrigins(env), ['http://localhost:5173', 'http://127.0.0.1:5173'], JSON.stringify(env));
  }
  // append 규칙도 비프로덕션에서는 오늘 그대로다.
  assert.deepEqual(allowedOrigins({ NODE_ENV: 'development', ALLOWED_ORIGINS: 'https://a.example' }), [
    'http://localhost:5173', 'http://127.0.0.1:5173', 'https://a.example',
  ]);
});

// --- phase 54 리뷰 후속: 프로덕션 허용 목록 공백을 부트 시점에 표면화 ---
// step2가 프로덕션 기본 loopback을 제거한 뒤로, ALLOWED_ORIGINS를 잊은 배포는 "자기 출처 외 모든 쓰기 403"이
// 된다(ADR-009 가정과 실패 모드). 이 실패는 조용하다 — 로그인은 되는데 저장/송고만 403이라 원인 추적이 어렵다.
// 동일 출처 배포는 정상 구성이므로 부팅을 막지 않고 경고로만 남긴다.
function fakeLog() {
  const warns = [];
  const infos = [];
  return { warns, infos, warn: (m) => warns.push(m), info: (m) => infos.push(m) };
}

test('logOriginDiagnostics: 프로덕션 + 허용 목록 공백 → 경고 1회(원인·조치가 문구에 있다)', () => {
  const logService = fakeLog();
  const flagged = logOriginDiagnostics({ env: { NODE_ENV: 'production' }, origins: [], logService });

  assert.equal(flagged, true);
  assert.equal(logService.warns.length, 1);
  assert.match(logService.warns[0], /ALLOWED_ORIGINS/);
  assert.match(logService.warns[0], /403/); // 증상(무엇이 실패하는지)이 문구에 있어야 추적이 가능하다
  assert.deepEqual(logService.infos, []);
});

test('logOriginDiagnostics: 프로덕션 + 허용 목록 있음 → 경고 없이 실제 적용 목록을 info로 남긴다', () => {
  const logService = fakeLog();
  const flagged = logOriginDiagnostics({
    env: { NODE_ENV: 'production' },
    origins: ['https://spa.example', 'https://admin.example'],
    logService,
  });

  assert.equal(flagged, false);
  assert.deepEqual(logService.warns, []);
  assert.equal(logService.infos.length, 1);
  assert.match(logService.infos[0], /https:\/\/spa\.example/);
  assert.match(logService.infos[0], /https:\/\/admin\.example/);
});

test('logOriginDiagnostics: 비프로덕션은 아무것도 남기지 않는다(dev 기본값은 공백이 아니고 경고가 소음이 된다)', () => {
  for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }]) {
    const logService = fakeLog();
    assert.equal(logOriginDiagnostics({ env, origins: [], logService }), false, JSON.stringify(env));
    assert.deepEqual(logService.warns, [], JSON.stringify(env));
    assert.deepEqual(logService.infos, [], JSON.stringify(env));
  }
});

// origins 미주입 시 env에서 파생한다 — 부트 배선이 createApp과 같은 규칙을 보게 하는 안전망.
test('logOriginDiagnostics: origins 미주입이면 env로 allowedOrigins를 파생한다', () => {
  const empty = fakeLog();
  assert.equal(logOriginDiagnostics({ env: { NODE_ENV: 'production' }, logService: empty }), true);

  const filled = fakeLog();
  assert.equal(
    logOriginDiagnostics({ env: { NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://spa.example' }, logService: filled }),
    false,
  );
  assert.match(filled.infos[0], /https:\/\/spa\.example/);
});

test('19) 프로덕션 기본 구성: Origin http://localhost:5173의 상태 변경은 403이고 status가 그대로다', async () => {
  const ctx = await start({ env: 'production', origins: allowedOrigins({ NODE_ENV: 'production' }) });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      const denied = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
        headers: prod({ cookie, origin }), body: { action: 'send' },
      });
      assert.equal(denied.status, 403, `${origin}는 프로덕션에서 허용되면 안 된다`);
      assert.equal(denied.body.reason, 'forbidden-origin');
      assert.equal(statusOf(ctx.db, articleId), 'RDS', '거부된 요청은 부수효과가 없어야 한다');
    }

    // 자기 출처 분기는 무손상 — 목록이 비어도 운영 SPA(같은 출처)는 계속 동작한다.
    const legit = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, origin: `https://${PROD_HOST}` }), body: { action: 'send' },
    });
    assert.equal(legit.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('20) 프로덕션: ALLOWED_ORIGINS로 등록한 출처만 남는다(등록분 통과·기본 loopback 부재)', async () => {
  const spa = 'http://spa.example';
  const origins = allowedOrigins({ NODE_ENV: 'production', ALLOWED_ORIGINS: spa });
  assert.deepEqual(origins, [spa], '프로덕션 목록에는 기본 loopback이 섞이지 않는다');
  const ctx = await start({ env: 'production', origins });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const allowed = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, origin: spa }), body: { action: 'send' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('21) 프로덕션 기본 구성: Origin·Referer 없는 서버-서버 경로는 계속 통과한다(ADR-009 관용)', async () => {
  const ctx = await start({ env: 'production', origins: allowedOrigins({ NODE_ENV: 'production' }) });
  try {
    createReceiverConfigModel(ctx.db).insert({ sourceId: 'src-1', type: 'FTP', active: 'Y' });
    const before = countRows(ctx.db, 'Article');

    const r = await rawFetch(ctx.base, 'POST', '/api/collection/receive', {
      headers: prod(), body: { sourceId: 'src-1', payload: '자동제목\n본문' },
    });
    assert.equal(r.status, 200);
    assert.equal(countRows(ctx.db, 'Article'), before + 1);
  } finally { await ctx.close(); }
});

test('22) 비프로덕션 회귀: 오늘의 dev 구성에서 Origin http://localhost:5173 상태 변경은 통과한다', async () => {
  const ctx = await start(); // env 미지정 + 기본 origins(allowedOrigins()) = 오늘의 dev 배선.
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, {}, 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: { cookie }, body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: { cookie, origin: 'http://localhost:5173' }, body: { action: 'send' },
    });
    assert.equal(r.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

// --- 공격 시나리오 (프로덕션) ---
test('1) 프로덕션: 교차 출처 Origin의 POST /action은 403 forbidden-origin이고 status가 바뀌지 않는다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;
    assert.equal(statusOf(ctx.db, articleId), 'RDS');

    const attack = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, origin: EVIL_ORIGIN }), body: { action: 'send' },
    });
    assert.equal(attack.status, 403);
    assert.deepEqual(attack.body, { ok: false, reason: 'forbidden-origin' });
    assert.equal(statusOf(ctx.db, articleId), 'RDS', '거부된 요청은 부수효과가 없어야 한다');

    // 동일 요청이 Origin만 없으면 성공한다 = 막힌 원인이 가드임을 확인(양성 대조).
    const legit = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie }), body: { action: 'send' },
    });
    assert.equal(legit.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('2) 프로덕션: 본문 없는 POST /force-unlock도 교차 출처면 403이고 잠금이 유지된다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;
    await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/lock`, {
      headers: prod({ cookie, 'x-edit-client': 'tab-1' }),
    });
    assert.equal(lockOf(ctx.db, articleId), 'Y');

    const attack = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/force-unlock`, {
      headers: prod({ cookie, origin: EVIL_ORIGIN }),
    });
    assert.equal(attack.status, 403);
    assert.equal(attack.body.reason, 'forbidden-origin');
    assert.equal(lockOf(ctx.db, articleId), 'Y', '거부된 강제 해제는 잠금을 풀지 않는다');

    const legit = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/force-unlock`, {
      headers: prod({ cookie }),
    });
    assert.equal(legit.status, 200);
    assert.equal(lockOf(ctx.db, articleId), 'N');
  } finally { await ctx.close(); }
});

test('3) 프로덕션: Origin: null(익명화된 교차 출처)은 403', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, origin: 'null' }), body: { action: 'send' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, 'forbidden-origin');
    assert.equal(statusOf(ctx.db, articleId), 'RDS');
  } finally { await ctx.close(); }
});

test('4) 프로덕션: Origin 없이 교차 출처 Referer만 있어도 403', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, referer: 'https://evil.example/x' }), body: { action: 'send' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, 'forbidden-origin');
    assert.equal(statusOf(ctx.db, articleId), 'RDS');
  } finally { await ctx.close(); }
});

test('5) 프로덕션: 파싱 불가능한 Referer(Origin 없음)는 403', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, referer: 'not-a-url' }), body: { action: 'send' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, 'forbidden-origin');
    assert.equal(statusOf(ctx.db, articleId), 'RDS');
  } finally { await ctx.close(); }
});

// --- 정상 플로우 무손상 ---
test('6) Origin·Referer가 둘 다 없는 상태 변경(서버-서버·cron·기존 테스트 스타일)은 통과한다', async () => {
  const ctx = await start(); // 비프로덕션 기본 앱 = 기존 테스트와 동일 구성.
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, {}, 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: { cookie }, body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: { cookie }, body: { action: 'send' },
    });
    assert.equal(r.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('7) 비프로덕션: 포트가 밀린 loopback Origin(localhost:5174)도 통과한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, {}, 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: { cookie }, body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: { cookie, origin: 'http://localhost:5174' }, body: { action: 'send' },
    });
    assert.equal(r.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('8) 비프로덕션: 127.0.0.1 loopback Origin도 통과한다', async () => {
  const ctx = await start();
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, {}, 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: { cookie }, body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: { cookie, origin: 'http://127.0.0.1:5173' }, body: { action: 'send' },
    });
    assert.equal(r.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('9) 프로덕션: 자기 출처(https://app.example) 상태 변경은 통과한다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, origin: `https://${PROD_HOST}` }), body: { action: 'send' },
    });
    assert.equal(r.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('10) 프로덕션: 읽기(GET)는 교차 출처 Origin이어도 이 미들웨어의 대상이 아니다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');

    const r = await rawFetch(ctx.base, 'GET', '/api/articles', {
      headers: prod({ cookie, origin: EVIL_ORIGIN }),
    });
    assert.equal(r.status, 200, '응답 노출 차단은 CORS 책임 — 가드는 상태 변경 메서드만 본다');
    assert.equal(r.body.ok, true);
  } finally { await ctx.close(); }
});

test('11) 프로덕션: CORS preflight(OPTIONS)는 가드의 영향을 받지 않는다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    const r = await rawFetch(ctx.base, 'OPTIONS', '/api/articles', {
      headers: prod({ origin: EVIL_ORIGIN, 'access-control-request-method': 'POST' }),
    });
    assert.ok(r.status < 300, `preflight는 403이면 안 된다, 실제 ${r.status}`);
    assert.equal(r.headers['access-control-allow-origin'], undefined, '미허용 출처엔 ACAO를 주지 않는다');
  } finally { await ctx.close(); }
});

test('12) ALLOWED_ORIGINS로 등록한 출처는 프로덕션에서도 통과한다(미등록이면 403)', async () => {
  const spa = 'https://spa.example';
  const ctx = await start({ env: 'production', origins: allowedOrigins({ ALLOWED_ORIGINS: spa }) });
  const plain = await start({ env: 'production' }); // 기본 allowlist(오늘과 동일) — 대조군.
  try {
    for (const c of [ctx, plain]) {
      seedUser(c.db, { userId: 'desk', role: 'D', password: 'pw' });
    }
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const allowed = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, origin: spa }), body: { action: 'send' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(statusOf(ctx.db, articleId), 'DPS');

    // 같은 출처가 미등록 앱에서는 거부된다.
    const plainCookie = await loginCookie(plain.base, prod(), 'desk', 'pw');
    const plainCreated = await rawFetch(plain.base, 'POST', '/api/articles', {
      headers: prod({ cookie: plainCookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const denied = await rawFetch(plain.base, 'POST', `/api/articles/${plainCreated.body.articleId}/action`, {
      headers: prod({ cookie: plainCookie, origin: spa }), body: { action: 'send' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'forbidden-origin');
  } finally {
    await ctx.close();
    await plain.close();
  }
});

// --- 보강(④ 테스트 게이트): 메서드 경계 / Referer 통과 분기 / 프로덕션 loopback 봉인 / 인제스트 경로 ---
// 14·15는 "상태 변경 메서드 전부"를 잠근다 — 기존 13개는 전부 POST라 안전 메서드 목록에 PUT/DELETE가
//   끼어들어도(또는 가드가 POST 전용으로 좁혀져도) 아무 테스트도 red가 되지 않았다.
// 16은 Referer 통과 분기를 잠근다 — 기존 4·5는 둘 다 403 기대라 "Referer가 있으면 무조건 403" 구현에서도
//   전부 green이 된다(자기 출처 Referer 요청이 조용히 막히는 회귀를 아무도 못 잡는다).
// 17은 loopback 관용의 프로덕션 봉인(!isProd)을 잠근다.
// 18은 ADR-008 cron·수집처럼 Origin·Referer가 없는 서버-서버 경로가 살아 있는지를 프로덕션 앱에서 확인한다.

test('14) 프로덕션: 교차 출처 PUT(기사 저장)도 403이고 본문이 저장되지 않는다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', department: '편집부', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: '원제목', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;
    await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/lock`, {
      headers: prod({ cookie, 'x-edit-client': 'tab-1' }),
    });

    const attack = await rawFetch(ctx.base, 'PUT', `/api/articles/${articleId}`, {
      headers: prod({ cookie, origin: EVIL_ORIGIN, 'x-edit-client': 'tab-1' }),
      body: { title: '탈취제목', markupVersion: END_MARKUP },
    });
    assert.equal(attack.status, 403);
    assert.deepEqual(attack.body, { ok: false, reason: 'forbidden-origin' });
    assert.equal(titleOf(ctx.db, articleId), '원제목', '거부된 저장은 본문을 바꾸지 않는다');

    // 양성 대조 — 같은 PUT이 Origin만 없으면 성사된다(막은 주체가 가드임을 확정).
    const legit = await rawFetch(ctx.base, 'PUT', `/api/articles/${articleId}`, {
      headers: prod({ cookie, 'x-edit-client': 'tab-1' }),
      body: { title: '정상수정', markupVersion: END_MARKUP },
    });
    assert.equal(legit.status, 200);
    assert.equal(titleOf(ctx.db, articleId), '정상수정');
  } finally { await ctx.close(); }
});

test('15) 프로덕션: 교차 출처 DELETE(수신 설정 삭제)도 403이고 행이 그대로 남는다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'admin', role: 'Z', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'admin', 'pw');
    const id = createReceiverConfigModel(ctx.db).insert({ sourceId: 'src-1', type: 'FTP', active: 'Y' });
    assert.equal(countRows(ctx.db, 'ReceiverConfig'), 1);

    const attack = await rawFetch(ctx.base, 'DELETE', `/api/receiver-config/${id}`, {
      headers: prod({ cookie, origin: EVIL_ORIGIN }),
    });
    assert.equal(attack.status, 403);
    assert.equal(attack.body.reason, 'forbidden-origin');
    assert.equal(countRows(ctx.db, 'ReceiverConfig'), 1, '거부된 DELETE는 행을 지우지 않는다');

    const legit = await rawFetch(ctx.base, 'DELETE', `/api/receiver-config/${id}`, {
      headers: prod({ cookie }),
    });
    assert.equal(legit.status, 200);
    assert.equal(countRows(ctx.db, 'ReceiverConfig'), 0);
  } finally { await ctx.close(); }
});

test('16) 프로덕션: Origin 없이 자기 출처 Referer만 있는 상태 변경은 통과한다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, referer: `https://${PROD_HOST}/editor?tab=1` }), body: { action: 'send' },
    });
    assert.equal(r.status, 200, 'Referer의 origin이 자기 출처면 통과해야 한다');
    assert.equal(statusOf(ctx.db, articleId), 'DPS');
  } finally { await ctx.close(); }
});

test('17) 프로덕션: 미등록 loopback Origin은 거부된다(비프로덕션 관용은 프로덕션에 새지 않는다)', async () => {
  const loopback = 'http://localhost:9999'; // 기본 allowlist(5173)에 없는 포트 — 관용 분기로만 통과 가능.
  const ctx = await start({ env: 'production' });
  const dev = await start(); // 같은 Origin이 비프로덕션에서는 통과한다는 대조군.
  try {
    for (const c of [ctx, dev]) seedUser(c.db, { userId: 'desk', role: 'D', password: 'pw' });

    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const denied = await rawFetch(ctx.base, 'POST', `/api/articles/${created.body.articleId}/action`, {
      headers: prod({ cookie, origin: loopback }), body: { action: 'send' },
    });
    assert.equal(denied.status, 403, '프로덕션에서 loopback 관용이 살아 있으면 안 된다');
    assert.equal(denied.body.reason, 'forbidden-origin');
    assert.equal(statusOf(ctx.db, created.body.articleId), 'RDS');

    const devCookie = await loginCookie(dev.base, {}, 'desk', 'pw');
    const devCreated = await rawFetch(dev.base, 'POST', '/api/articles', {
      headers: { cookie: devCookie }, body: { title: 't', markupVersion: END_MARKUP },
    });
    const allowed = await rawFetch(dev.base, 'POST', `/api/articles/${devCreated.body.articleId}/action`, {
      headers: { cookie: devCookie, origin: loopback }, body: { action: 'send' },
    });
    assert.equal(allowed.status, 200, '비프로덕션 dev 배선(포트 밀림)은 계속 통과해야 한다');
  } finally {
    await ctx.close();
    await dev.close();
  }
});

test('18) 프로덕션: Origin·Referer 없는 수집 인제스트(서버-서버·cron)는 그대로 통과한다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    createReceiverConfigModel(ctx.db).insert({ sourceId: 'src-1', type: 'FTP', active: 'Y' });
    const before = countRows(ctx.db, 'Article');

    // 세션 쿠키도 브라우저 헤더도 없는 서버-서버 호출 — 가드가 이 경로를 막으면 수집이 통째로 죽는다.
    const r = await rawFetch(ctx.base, 'POST', '/api/collection/receive', {
      headers: prod(), body: { sourceId: 'src-1', payload: '자동제목\n본문' },
    });
    assert.equal(r.status, 200);
    assert.equal(countRows(ctx.db, 'Article'), before + 1, '자동기사가 실제로 등록된다');
  } finally { await ctx.close(); }
});

test('13) 프로덕션: X-Forwarded-Host 스푸핑으로 자기 출처 판정을 통과시킬 수 없다', async () => {
  const ctx = await start({ env: 'production' });
  try {
    seedUser(ctx.db, { userId: 'desk', role: 'D', password: 'pw' });
    const cookie = await loginCookie(ctx.base, prod(), 'desk', 'pw');
    const created = await rawFetch(ctx.base, 'POST', '/api/articles', {
      headers: prod({ cookie }), body: { title: 't', markupVersion: END_MARKUP },
    });
    const { articleId } = created.body;

    const r = await rawFetch(ctx.base, 'POST', `/api/articles/${articleId}/action`, {
      headers: prod({ cookie, origin: EVIL_ORIGIN, 'x-forwarded-host': 'evil.example' }),
      body: { action: 'send' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, 'forbidden-origin');
    assert.equal(statusOf(ctx.db, articleId), 'RDS');
  } finally { await ctx.close(); }
});
