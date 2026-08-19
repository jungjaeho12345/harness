// 계약 케이스: 인증·세션 3라우트(인벤토리 id 'login'·'logout'·'session') — default 프로파일.
// 동결 축: 세션 토큰 운반 2수단(sid 쿠키 우선 · x-session-id 헤더 폴백, ?session= 쿼리 폴백 부재) ·
//   비프로덕션 쿠키 속성(HttpOnly·SameSite=Lax·Path=/·Max-Age=3600·Secure 없음) · 401에도 JSON 바디 ·
//   로그아웃 멱등(세션 없이도 200) · 단일 세션 정책(재로그인이 같은 사용자의 기존 세션을 죽인다).
// 규율: 서버 코드 import 금지(CONTRACT_BASE_URL로만) · 비밀번호는 credentials(role)로만 · 리포트 기록은 record로만.
//
// CRITICAL(공용 세션 파괴 + 복구 의무 — 스위트 규약): POST /api/login은 같은 userId의 기존 세션을
//   **전부 무효화**한다(단일 세션 정책). 그래서 이 파일이 R로 로그인하는 순간 러너가 준비한 공용 R
//   세션(sid('R'))은 죽고, 로그아웃 계약까지 마치면 R 세션은 아예 없어진다. 규약은 "로그인한 케이스는
//   그 역할의 공용 세션을 반드시 복구한다"이다 — 이 파일 **마지막 케이스**가 R로 재로그인해
//   republish('R', ...)(contract/lib/session.js)로 세션 파일을 갱신한다. 그래서 뒤에 정렬되는 default
//   케이스 파일(collection·crosscutting·distribution-*·logs·media-upload·receiver-config·users)은
//   sid('R')를 **정상 세션으로 쓸 수 있다**. 파일 안의 케이스 순서를 바꾸지 마라(복구는 반드시 마지막).
//   역할을 R로 고른 이유: 공용 픽스처(contract/lib/fixtures.js)는 D와 Z만 쓰므로 소실 구간이 가장 짧다.
// CRITICAL(로그인 예산 — decisions (8)): 이 파일은 default 프로파일에서 **정확히 2회** 로그인한다
//   (계약 검증 1 + 마지막 공용 세션 복구 1). 프로파일 합계 = 러너 3 + 이 파일 2 + sse-stream 2 = 7 ≤ 10회/15분.

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';
import { credentials, republish, sid } from '../../lib/session.js';

requireProfile('default');

// 이 파일이 로그인으로 소실시키는 공용 역할(위 CRITICAL 참조).
const BURNED_ROLE = 'R';

// GET /api/session 200 응답의 user 키 집합(실측 확정) — sessionService.identityOf의 IDENTITY_FIELDS 투영이라
// 로그인 응답(userService SAFE_FIELDS 6키)과 달리 active가 없다.
const SESSION_USER_KEYS = ['department', 'departmentCode', 'name', 'role', 'userId'];
// POST /api/login 200 응답의 user 키 집합(실측 확정) — SAFE_FIELDS. password·잠금 메타는 없다.
const LOGIN_USER_KEYS = ['active', 'department', 'departmentCode', 'name', 'role', 'userId'];

// Set-Cookie 파싱 — 부분 문자열 일치로 통과해 버리는 함정을 피한다(속성 이름/값을 실제로 갈라 본다).
// 반환: { name, value, attrs(Map<소문자 속성명, 값|true>) }. 세션 쿠키가 없으면 undefined.
function parseSessionCookie(res, name = 'sid') {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const line = list.find((c) => c.startsWith(`${name}=`));
  if (!line) return undefined;
  const [head, ...rest] = line.split(';').map((s) => s.trim());
  const attrs = new Map();
  for (const a of rest) {
    const i = a.indexOf('=');
    if (i === -1) attrs.set(a.toLowerCase(), true);
    else attrs.set(a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim());
  }
  const eq = head.indexOf('=');
  return { name: head.slice(0, eq), value: head.slice(eq + 1), attrs };
}

// 리포트에 실을 쿠키 "속성만" — 값(토큰)은 절대 담지 않는다.
function cookieFacts(cookie) {
  return {
    cookieHttpOnly: cookie.attrs.has('httponly'),
    cookieMaxAge: typeof cookie.attrs.get('max-age') === 'string' ? cookie.attrs.get('max-age') : null,
    cookieName: cookie.name,
    cookiePath: typeof cookie.attrs.get('path') === 'string' ? cookie.attrs.get('path') : null,
    cookieSameSite: typeof cookie.attrs.get('samesite') === 'string' ? cookie.attrs.get('samesite').toLowerCase() : null,
    cookieSecure: cookie.attrs.has('secure'),
  };
}

function userKeys(body) {
  return Object.keys(body?.user ?? {}).sort();
}

// 이 파일이 발급받은 세션(로그인 케이스가 채운다) — 이후 케이스가 공유한다. 로그인 재호출 금지.
let issued = null;
function issuedSession() {
  if (!issued) throw new Error('로그인 케이스가 선행되지 않았다 — 이 파일의 케이스는 위에서 아래로 실행돼야 한다.');
  return issued;
}

test('GET /api/session — 자격 없음: 401 + JSON 바디 {ok:false, reason:unauthenticated}', async () => {
  const res = await api('GET', '/api/session');

  assert.equal(res.status, 401);
  // 바디 없는 401은 계약 위반이다 — SPA(httpModel)가 상태코드가 아니라 본문 ok/reason을 읽는다.
  assert.deepEqual(res.json, { ok: false, reason: 'unauthenticated' });
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);

  record('session', 'unauthenticated', {
    ...fromResponse(res),
    caseId: 'no-credentials',
  });
});

test('GET /api/session — x-session-id 헤더 폴백: 200 + user 정확 5키(비밀번호·active 없음)', async () => {
  const res = await api('GET', '/api/session', { sid: sid(BURNED_ROLE) });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(Object.keys(res.json).sort(), ['ok', 'user']);
  assert.deepEqual(userKeys(res.json), SESSION_USER_KEYS);
  assert.equal(res.json.user.password, undefined);
  assert.equal(res.json.user.role, 'R');

  record('session', 'success', {
    ...fromResponse(res, { values: { userKeys: SESSION_USER_KEYS.join(','), role: res.json.user.role } }),
    caseId: 'header-fallback',
  });
});

test('POST /api/login — 성공: 200 {ok,sessionId(64-hex),user} + 비프로덕션 세션 쿠키 속성', async () => {
  const cred = credentials(BURNED_ROLE); // 비밀번호는 요청 body에만 쓴다(로그·리포트 금지).
  const res = await api('POST', '/api/login', { body: { userId: cred.userId, password: cred.password } });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(Object.keys(res.json).sort(), ['ok', 'sessionId', 'user']);
  assert.match(res.json.sessionId, /^[0-9a-f]{64}$/);
  assert.deepEqual(userKeys(res.json), LOGIN_USER_KEYS);
  assert.equal(res.json.user.password, undefined);

  const cookie = parseSessionCookie(res);
  assert.ok(cookie, 'Set-Cookie로 sid 세션 쿠키가 내려와야 한다');
  assert.equal(cookie.value, res.json.sessionId); // 쿠키 값 = 응답 sessionId(두 운반 수단이 같은 토큰).
  assert.equal(cookie.attrs.has('httponly'), true);
  assert.equal(cookie.attrs.get('path'), '/');
  assert.equal(cookie.attrs.get('max-age'), '3600');
  assert.equal(String(cookie.attrs.get('samesite')).toLowerCase(), 'lax');
  assert.equal(cookie.attrs.has('secure'), false); // 비프로덕션은 Secure 없음(prod-cookie 프로파일과의 차이가 계약).

  issued = { sid: res.json.sessionId, cookieHeader: `${cookie.name}=${cookie.value}` };

  record('login', 'success', {
    ...fromResponse(res, {
      values: { ...cookieFacts(cookie), sessionIdHex64: /^[0-9a-f]{64}$/.test(res.json.sessionId), userKeys: LOGIN_USER_KEYS.join(',') },
      headers: ['content-type', 'set-cookie'],
    }),
    caseId: 'ok',
  });
});

test('POST /api/login — 단일 세션 정책: 같은 사용자의 이전 세션은 무효화된다(이전 토큰 401)', async () => {
  issuedSession();
  const res = await api('GET', '/api/session', { sid: sid(BURNED_ROLE) }); // 러너가 만든 이전 R 세션.

  assert.equal(res.status, 401);
  assert.equal(res.json.reason, 'unauthenticated');

  record('session', 'unauthenticated', {
    ...fromResponse(res),
    caseId: 'previous-session-invalidated-by-login',
  });
});

test('GET /api/session — 쿠키만으로(헤더 없이) 200: 쿠키 운반 경로 실증', async () => {
  const res = await api('GET', '/api/session', { headers: { cookie: issuedSession().cookieHeader } });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(userKeys(res.json), SESSION_USER_KEYS);

  record('session', 'success', {
    ...fromResponse(res, { values: { transport: 'cookie', userKeys: SESSION_USER_KEYS.join(',') } }),
    caseId: 'cookie-transport',
  });
});

test('POST /api/logout — 세션 종료: 200 {ok:true} + 만료 쿠키(Max-Age=0), 이후 같은 토큰은 401', async () => {
  const session = issuedSession();
  const res = await api('POST', '/api/logout', { sid: session.sid });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  const cleared = parseSessionCookie(res);
  assert.ok(cleared, '로그아웃도 Set-Cookie로 세션 쿠키를 만료시켜야 한다');
  assert.equal(cleared.value, ''); // 빈 값 + Max-Age=0 = 삭제 지시.
  assert.equal(cleared.attrs.get('max-age'), '0');
  assert.equal(cleared.attrs.has('httponly'), true);
  assert.equal(cleared.attrs.get('path'), '/');
  assert.equal(String(cleared.attrs.get('samesite')).toLowerCase(), 'lax');
  assert.equal(cleared.attrs.has('secure'), false);

  record('logout', 'success', {
    ...fromResponse(res, { values: cookieFacts(cleared), headers: ['content-type', 'set-cookie'] }),
    caseId: 'clears-session',
  });

  // 무효화 실증 — 같은 토큰(쿠키·헤더 어느 쪽으로도)으로는 다시 통과할 수 없다.
  const after = await api('GET', '/api/session', { sid: session.sid });
  assert.equal(after.status, 401);
  assert.equal(after.json.reason, 'unauthenticated');
  const afterCookie = await api('GET', '/api/session', { headers: { cookie: session.cookieHeader } });
  assert.equal(afterCookie.status, 401);

  record('session', 'unauthenticated', {
    ...fromResponse(after),
    caseId: 'after-logout',
  });
});

test('POST /api/logout — 세션 없이도 200 {ok:true}(멱등·항상 성공)', async () => {
  const res = await api('POST', '/api/logout');

  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });

  record('logout', 'success', {
    ...fromResponse(res),
    caseId: 'without-session',
  });
});

test('GET /api/session — ?session= 쿼리 폴백은 없다(유효 토큰이어도 401)', async () => {
  // 유효한 토큰을 쿼리로만 준다 — 쿠키·헤더가 아니면 인증되지 않는 것이 계약이다(URL/로그 누출 표면 제거).
  const res = await api('GET', '/api/session', { query: { session: sid('D') } });

  assert.equal(res.status, 401);
  assert.equal(res.json.reason, 'unauthenticated');

  record('session', 'unauthenticated', {
    ...fromResponse(res, { values: { transport: 'query' } }),
    caseId: 'query-fallback-absent',
  });
});

test('GET /api/session — 형식이 잘못된 토큰은 401(500이 아니다)', async () => {
  const res = await api('GET', '/api/session', { sid: 'not-a-real-token' });

  assert.equal(res.status, 401);
  assert.equal(res.json.reason, 'unauthenticated');

  record('session', 'unauthenticated', {
    ...fromResponse(res),
    caseId: 'malformed-token',
  });
});

// --- 공용 세션 복구(스위트 규약 — 반드시 이 파일의 마지막) ---
// 위 계약 검증이 전부 끝난 뒤에만 돈다. 계약 단언이 아니라 스위트 위생이므로 record하지 않는다
// (리포트에는 계약 관측만 남는다 — 이중 실행 diff의 신호 대 잡음 유지).
test('공용 R 세션 복구 — 로그인/로그아웃 계약이 파괴한 sid(\'R\')을 되살린다', async () => {
  const cred = credentials(BURNED_ROLE); // 비밀번호는 요청 body에만 쓴다(로그·리포트 금지).
  const res = await api('POST', '/api/login', { body: { userId: cred.userId, password: cred.password } });

  assert.equal(res.status, 200, '복구 로그인이 실패하면 뒤 파일의 sid(R) 케이스가 전부 401로 무너진다');
  assert.equal(res.json?.ok, true);
  republish(BURNED_ROLE, { sid: res.json.sessionId, user: res.json.user }); // 토큰은 lib 밖으로 흘리지 않는다.

  // 복구 실증 — 갱신된 공용 토큰이 실제로 통과하는지 본다(파일만 쓰고 끝내는 실수 차단).
  const check = await api('GET', '/api/session', { sid: sid(BURNED_ROLE) });
  assert.equal(check.status, 200, '복구된 공용 세션은 즉시 사용 가능해야 한다');
  assert.equal(check.json?.user?.role, BURNED_ROLE);
});
