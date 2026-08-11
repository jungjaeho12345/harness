// listen 주소 설정화 + 수집 인제스트 fail-closed 테스트 (phase 60 step1).
// bootstrap()은 테스트가 실행하지 않으므로(import.meta.url 가드) 검증 대상은
// export된 순수 헬퍼 3개(resolveHost·isLoopbackHost·logHostDiagnostics)와
// createApp({ requireCollectionToken }) 정책 주입의 HTTP 왕복이다.
// CRITICAL(무회귀): requireCollectionToken 기본값은 false — loopback 기본 구성(기존 1015건·로컬 운영)은
//   아무것도 바뀌지 않는다. fail-closed는 비-loopback 바인딩 + COLLECTION_TOKEN 미설정 조합에서만 발동한다.
// env 원복 주의: 라우트가 요청 시점에 process.env.COLLECTION_TOKEN을 읽으므로 D계열은 try/finally로
//   반드시 원복한다(누락 시 같은 프로세스의 다른 테스트 파일이 오염된다).

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createReceiverConfigModel } from '../src/models/receiverConfigModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createApp, resolveHost, isLoopbackHost, logHostDiagnostics } from '../server/index.js';

const ENV = { GOOGLE_API_KEY: 'gk', GOOGLE_CSE_ID: 'cse', YOUTUBE_API_KEY: 'yk' };

async function start({ requireCollectionToken, fetchFn } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService, env: ENV, fetchFn });
  const app = createApp({ controllers, requireCollectionToken });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, controllers, base, close: () => new Promise((r) => server.close(r)) };
}

function seedUser(db, user) {
  createUserModel(db).insert({ active: 'Y', ...user, password: bcrypt.hashSync(user.password, 10) });
}

// D계열 픽스처 — receive용 FTP 소스 + pull용 API 소스를 함께 심는다.
// API 소스가 없으면 pull이 가드 이전에 unregistered(403)로 거부되어 fetchFn 미호출 단언이 무의미해진다.
function seedSources(db) {
  const model = createReceiverConfigModel(db);
  model.insert({ sourceId: 'src-1', type: 'FTP', active: 'Y' });
  model.insert({ sourceId: 'api-1', type: 'API', apiEndpoint: 'https://x/api', apiKey: 'K', active: 'Y' });
}

async function api(base, method, path, { sid, body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (sid) headers['x-session-id'] = sid;
  if (token !== undefined) headers['x-collection-token'] = token;
  const res = await fetch(`${base}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, body: json };
}

// process.env의 한 키를 임시 조작하고 반드시 원복한다.
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

function fakeLog() {
  const warns = [];
  const infos = [];
  return { warns, infos, warn: (m) => warns.push(m), info: (m) => infos.push(m) };
}

// --- A. resolveHost(env) ---

test('A1: HOST 미설정 → 기본 127.0.0.1', () => {
  assert.equal(resolveHost({}), '127.0.0.1');
});

test('A2: HOST 빈 문자열 → 기본값(오타로 조용히 전 인터페이스에 열리지 않는다)', () => {
  assert.equal(resolveHost({ HOST: '' }), '127.0.0.1');
});

test('A3: HOST 공백만 → 기본값', () => {
  assert.equal(resolveHost({ HOST: '   ' }), '127.0.0.1');
});

test('A4: HOST 0.0.0.0 → 그대로', () => {
  assert.equal(resolveHost({ HOST: '0.0.0.0' }), '0.0.0.0');
});

test('A5: HOST 앞뒤 공백은 트림한다', () => {
  assert.equal(resolveHost({ HOST: '  192.168.0.10  ' }), '192.168.0.10');
});

test('A6: HOST :: (IPv6 전 인터페이스) → 그대로(값 해석은 Node에 맡긴다)', () => {
  assert.equal(resolveHost({ HOST: '::' }), '::');
});

test('A7: 주입 seam — 인자로 받은 env만 본다(process.env.HOST 무시)', async () => {
  await withEnv('HOST', '0.0.0.0', () => {
    assert.equal(resolveHost({}), '127.0.0.1');
  });
});

// --- B. isLoopbackHost(host) ---

test('B8: localhost·127.0.0.1·::1·[::1] → true', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(h), true, h);
  }
});

test('B9: 127.0.0.0/8 전체가 loopback이다(좁은 판정은 수집 기능 오차단이 된다)', () => {
  for (const h of ['127.0.0.2', '127.1.2.3']) {
    assert.equal(isLoopbackHost(h), true, h);
  }
});

test('B10: 0.0.0.0·::·사설 IP → false', () => {
  for (const h of ['0.0.0.0', '::', '192.168.0.10', '10.0.0.5']) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});

test('B11: undefined·빈 문자열·비문자열 → false(모르는 값은 개방으로 간주하는 안전 방향)', () => {
  for (const h of [undefined, '', null, 42, {}]) {
    assert.equal(isLoopbackHost(h), false, String(h));
  }
});

test('B12: 대소문자 무관(LOCALHOST → true)', () => {
  assert.equal(isLoopbackHost('LOCALHOST'), true);
});

// --- C. logHostDiagnostics({ host, env, logService }) ---

test('C13: loopback(127.0.0.1) + 토큰 없음 → 경고 0줄, 반환 false', () => {
  const logService = fakeLog();
  assert.equal(logHostDiagnostics({ host: '127.0.0.1', env: {}, logService }), false);
  assert.deepEqual(logService.warns, []);
});

test('C14: localhost·::1·127.0.0.2 + 토큰 없음 → 경고 0줄(isLoopbackHost와 같은 판정 공유)', () => {
  for (const host of ['localhost', '::1', '127.0.0.2']) {
    const logService = fakeLog();
    assert.equal(logHostDiagnostics({ host, env: {}, logService }), false, host);
    assert.deepEqual(logService.warns, [], host);
  }
});

test('C15: 0.0.0.0 + 토큰 미설정 → WARN 1줄, 반환 true — 원인·결과·조치가 문구에 있다', () => {
  const logService = fakeLog();
  assert.equal(logHostDiagnostics({ host: '0.0.0.0', env: {}, logService }), true);
  assert.equal(logService.warns.length, 1);
  assert.match(logService.warns[0], /0\.0\.0\.0/); // 실제 host 문자열
  assert.match(logService.warns[0], /COLLECTION_TOKEN/); // 변수명(조치)
  assert.match(logService.warns[0], /disabled/); // 수집 인제스트 비활성 사실(503의 원인 추적)
});

test('C16: 0.0.0.0 + 토큰 설정 → 경고 0줄, 반환 false', () => {
  const logService = fakeLog();
  assert.equal(
    logHostDiagnostics({ host: '0.0.0.0', env: { COLLECTION_TOKEN: 'secret-value' }, logService }),
    false,
  );
  assert.deepEqual(logService.warns, []);
});

test('C17: 192.168.0.10 + 토큰 없음 → 경고 1줄', () => {
  const logService = fakeLog();
  assert.equal(logHostDiagnostics({ host: '192.168.0.10', env: {}, logService }), true);
  assert.equal(logService.warns.length, 1);
});

test('C18: 마스킹 — 어떤 로그 줄에도 토큰 값이 등장하지 않는다', () => {
  const logService = fakeLog();
  logHostDiagnostics({ host: '0.0.0.0', env: { COLLECTION_TOKEN: 'secret-value' }, logService });
  for (const line of [...logService.warns, ...logService.infos]) {
    assert.ok(!line.includes('secret-value'), line);
  }
});

test('C19: logService 미주입에도 throw하지 않는다', () => {
  assert.doesNotThrow(() => logHostDiagnostics({ host: '0.0.0.0', env: {} }));
  assert.doesNotThrow(() => logHostDiagnostics({ host: '127.0.0.1', env: {} }));
});

// --- D. 수집 fail-closed — HTTP 왕복 ---

test('D20: requireCollectionToken=true + 토큰 미설정 → 두 라우트 503 collection-disabled, 부수효과 0', async () => {
  await withEnv('COLLECTION_TOKEN', undefined, async () => {
    let fetchCalls = 0;
    const fetchFn = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ title: 't', content: 'c' }) };
    };
    const ctx = await start({ requireCollectionToken: true, fetchFn });
    try {
      seedSources(ctx.db);
      const before = ctx.controllers.article.query({}).length;

      const received = await api(ctx.base, 'POST', '/api/collection/receive', { body: { sourceId: 'src-1', payload: '제목\n본문' } });
      assert.equal(received.status, 503);
      assert.equal(received.body.reason, 'collection-disabled');

      const pulled = await api(ctx.base, 'POST', '/api/collection/pull', { body: { sourceId: 'api-1' } });
      assert.equal(pulled.status, 503);
      assert.equal(pulled.body.reason, 'collection-disabled');

      // 부수효과 0 — DB 증가 없음, 외부 호출(fetchFn) 없음(가드가 라우트 최상단에 있다는 증거).
      assert.equal(ctx.controllers.article.query({}).length, before);
      assert.equal(fetchCalls, 0);
    } finally { await ctx.close(); }
  });
});

test('D21: 토큰이 설정되면 기존 인증 계약 그대로(일치 200 / 불일치·누락 401 — 503 아님)', async () => {
  await withEnv('COLLECTION_TOKEN', 'tok', async () => {
    const ctx = await start({ requireCollectionToken: true });
    try {
      seedSources(ctx.db);

      const ok = await api(ctx.base, 'POST', '/api/collection/receive', { token: 'tok', body: { sourceId: 'src-1', payload: '자동제목\n본문' } });
      assert.equal(ok.status, 200);
      const rows = ctx.controllers.article.query({ articleId: ok.body.articleId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].attribute, '자동기사');

      const wrong = await api(ctx.base, 'POST', '/api/collection/receive', { token: 'wrong', body: { sourceId: 'src-1', payload: '제목\n본문' } });
      assert.equal(wrong.status, 401);
      assert.equal(wrong.body.reason, 'unauthenticated');

      const missing = await api(ctx.base, 'POST', '/api/collection/receive', { body: { sourceId: 'src-1', payload: '제목\n본문' } });
      assert.equal(missing.status, 401);
    } finally { await ctx.close(); }
  });
});

test('D22: 기본값 무회귀 — requireCollectionToken 미주입 + 토큰 미설정 → 현행 그대로 200', async () => {
  await withEnv('COLLECTION_TOKEN', undefined, async () => {
    const ctx = await start();
    try {
      seedSources(ctx.db);
      const before = ctx.controllers.article.query({}).length;
      const ok = await api(ctx.base, 'POST', '/api/collection/receive', { body: { sourceId: 'src-1', payload: '자동제목\n본문' } });
      assert.equal(ok.status, 200);
      assert.equal(ctx.controllers.article.query({}).length, before + 1);
    } finally { await ctx.close(); }
  });
});

test('D23: 부작용 범위 잠금 — fail-closed여도 수집 2개 라우트 외에는 전부 정상', async () => {
  await withEnv('COLLECTION_TOKEN', undefined, async () => {
    const ctx = await start({ requireCollectionToken: true });
    try {
      seedSources(ctx.db);
      seedUser(ctx.db, { userId: 'kim', name: '김기자', role: 'R', department: '사회부', password: 'pw1234' });

      assert.equal((await api(ctx.base, 'GET', '/api/health')).status, 200);

      const login = await api(ctx.base, 'POST', '/api/login', { body: { userId: 'kim', password: 'pw1234' } });
      assert.equal(login.status, 200);

      const list = await api(ctx.base, 'GET', '/api/articles', { sid: login.body.sessionId });
      assert.equal(list.status, 200);
      assert.equal(list.body.ok, true);
    } finally { await ctx.close(); }
  });
});
