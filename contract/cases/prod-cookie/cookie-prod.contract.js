// 계약 케이스: 프로덕션 세션 쿠키 속성 — prod-cookie 프로파일(NODE_ENV=production + FORCE_HTTPS=false).
// 동결 축: Set-Cookie에 **Secure + SameSite=None**(비프로덕션의 SameSite=Lax·Secure 없음과의 차이가 계약이다) ·
//   프로덕션에서도 x-session-id 헤더 폴백이 산다 · 만료 쿠키(로그아웃)에도 같은 속성이 실린다.
// 규율: 이 프로파일은 러너가 세션을 준비하지 않는다(hasSessions()=false) — actor()/sid()를 부르지 마라.
//   케이스가 credentials(role)로 **정확히 1회** 로그인하고 그 세션을 3케이스가 공유한다(위에서 아래 순서).
//   프로덕션이라 CSRF 게이트의 loopback 관용이 꺼져 있고 allowlist가 비어 있다 —
//   상태 변경 요청에 Origin/Referer를 붙이면 403이 된다(부재 관용 위에서 돈다).

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';
import { credentials } from '../../lib/session.js';

requireProfile('prod-cookie');

const LOGIN_ROLE = 'R';

// Set-Cookie 파싱 — 속성 이름/값을 실제로 갈라 본다(부분 문자열 일치로 통과하는 함정 방지).
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

let issued = null;
function issuedSession() {
  if (!issued) throw new Error('로그인 케이스가 선행되지 않았다 — 이 파일의 케이스는 위에서 아래로 실행돼야 한다.');
  return issued;
}

test('POST /api/login — 프로덕션 세션 쿠키는 Secure + SameSite=None이다', async () => {
  const cred = credentials(LOGIN_ROLE); // 비밀번호는 요청 body에만 쓴다.
  const res = await api('POST', '/api/login', { body: { userId: cred.userId, password: cred.password } });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.sessionId, /^[0-9a-f]{64}$/);

  const cookie = parseSessionCookie(res);
  assert.ok(cookie, 'Set-Cookie로 sid 세션 쿠키가 내려와야 한다');
  assert.equal(cookie.attrs.has('secure'), true); // 비프로덕션과의 차이 (1)
  assert.equal(String(cookie.attrs.get('samesite')).toLowerCase(), 'none'); // 비프로덕션과의 차이 (2)
  assert.equal(cookie.attrs.has('httponly'), true);
  assert.equal(cookie.attrs.get('path'), '/');
  assert.equal(cookie.attrs.get('max-age'), '3600');

  issued = { sid: res.json.sessionId };

  record('login', 'success', {
    ...fromResponse(res, { values: cookieFacts(cookie), headers: ['content-type', 'set-cookie'] }),
    caseId: 'production-cookie-attributes',
  });
});

test('GET /api/session — 프로덕션에서도 x-session-id 헤더 폴백이 산다', async () => {
  const res = await api('GET', '/api/session', { sid: issuedSession().sid });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.user.role, 'R');

  record('session', 'success', {
    ...fromResponse(res, { values: { transport: 'header', role: res.json.user.role } }),
    caseId: 'header-fallback-in-production',
  });
});

test('POST /api/logout — 만료 쿠키에도 Secure + SameSite=None이 실린다', async () => {
  const res = await api('POST', '/api/logout', { sid: issuedSession().sid });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });

  const cleared = parseSessionCookie(res);
  assert.ok(cleared, '로그아웃도 Set-Cookie로 세션 쿠키를 만료시켜야 한다');
  assert.equal(cleared.value, '');
  assert.equal(cleared.attrs.get('max-age'), '0');
  assert.equal(cleared.attrs.has('secure'), true);
  assert.equal(String(cleared.attrs.get('samesite')).toLowerCase(), 'none');
  assert.equal(cleared.attrs.has('httponly'), true);
  assert.equal(cleared.attrs.get('path'), '/');

  record('logout', 'success', {
    ...fromResponse(res, { values: cookieFacts(cleared), headers: ['content-type', 'set-cookie'] }),
    caseId: 'production-cookie-cleared',
  });
});
