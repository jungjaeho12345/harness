// 계약 케이스: 세션 가드(요청마다 User 행 재조회) — default 프로파일. [④ 테스트 게이트 보강]
//
// 왜 이 파일이 필요한가(발견 경위): phase 67 테스트 게이트에서 `src/services/sessionGuard.js`의
//   revalidate()를 "세션 스토어가 준 신원을 그대로 반환"하도록 변이했더니 **계약 스위트 267 케이스가
//   전부 green(exit 0, covered 39/39)** 이었다. 즉 "세션은 로그인 시점 스냅샷이 아니라 매 요청 DB 최신
//   role/active에서 재도출된다"(ADR-004, 2026-08-03 감사 [high])는 신뢰 경계가 동결돼 있지 않았다.
//   이 축이 비어 있으면 68+ Spring이 이 가드를 빼먹어도 계약 게이트가 green으로 통과한다 —
//   그 결과는 "비활성화·강등된 계정이 최대 1시간(슬라이딩) 동안 이전 권한을 유지"하는 권한 상승이다.
//
// 동결 축:
//   (1) role 강등은 **재로그인 없이 다음 요청부터** 반영된다(Z 전용 라우트가 403이 된다).
//   (2) GET /api/session의 user는 로그인 응답 스냅샷이 아니라 **DB 최신값**이다(강등 후 role이 바뀐다).
//   (3) active='N' 비활성화는 그 세션을 **즉시 무효화**한다(401) — 그리고 무효화는 영구적이라
//       같은 토큰은 다른 라우트에서도 되살아나지 않는다(세션 스토어에서 제거됐다는 음성 증거).
//
// 규율:
//  - **시드 계정(reporter/desk/admin)은 건드리지 않는다** — 러너가 그 세션으로 전 프로파일을 돌린다.
//    강등·비활성화 대상은 이 파일이 만든 픽스처 계정뿐이다(행 삭제 없음 — DB 비파괴).
//  - 픽스처 계정으로 **정확히 1회** 로그인한다. default 프로파일 로그인 합계 = 러너 3 + auth 2 +
//    sse-stream 2 + 여기 1 = **8 ≤ 10회/15분**(contract/README.md 로그인 예산). 이 계정은 R/D/Z 공용
//    세션과 userId가 다르므로 단일 세션 정책에 걸리지 않는다 → 공용 세션 복구 의무가 없다.
//  - 비밀번호는 이 프로세스에서 만든 난수이며 요청 body 밖으로 나가지 않는다(리포트·단언 메시지 금지).

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api } from '../../lib/http.js';
import { sid } from '../../lib/session.js';
import { unique } from '../../lib/fixtures.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';

requireProfile('default');

// GET /api/session 200의 user 키 집합(auth.contract.js와 같은 실측 상수) — 강등 후에도 shape은 불변이다.
const SESSION_USER_KEYS = ['department', 'departmentCode', 'name', 'role', 'userId'];

// 픽스처 계정의 비밀번호는 매 실행 난수다(하드코딩 금지 — decisions (22)).
const password = crypto.randomBytes(24).toString('hex');
const fixtureUser = {
  userId: unique('ct-guard'),
  name: unique('ct-guard-name'),
  role: 'Z', // Z로 만들어 "Z 전용 라우트 200 → 강등 → 403"의 왕복을 한 계정으로 본다.
  department: unique('ct-guard-dept'),
  departmentCode: 'CT',
  password,
};

// 이 파일이 발급받은 픽스처 세션(로그인 1회). 토큰은 리포트·메시지에 담지 않는다.
let guardSid = null;

before(async () => {
  const created = await api('POST', '/api/users', { sid: sid('Z'), body: fixtureUser });
  if (created.status !== 200 || created.json?.ok !== true) {
    throw new Error(`픽스처 실패 createUser: status=${created.status} reason=${created.json?.reason ?? '-'}`);
  }
  const login = await api('POST', '/api/login', { body: { userId: fixtureUser.userId, password } });
  if (login.status !== 200 || login.json?.ok !== true || typeof login.json.sessionId !== 'string') {
    throw new Error(`픽스처 실패 login(fixture): status=${login.status} reason=${login.json?.reason ?? '-'}`);
  }
  assert.equal(login.json.user?.role, 'Z', '픽스처 계정은 Z로 생성돼야 한다');
  guardSid = login.json.sessionId;
});

test('세션 가드 — 새 세션의 권한은 DB role에서 도출된다(Z 전용 라우트 200)', async () => {
  const res = await api('GET', '/api/logs/digest', { sid: guardSid });

  assert.equal(res.status, 200, '갓 로그인한 Z 계정은 Z 전용 라우트를 통과해야 한다');
  assert.equal(res.json?.ok, true);

  record('logs-digest', 'success', {
    ...fromResponse(res, { values: { roleAtLogin: 'Z' } }),
    caseId: 'guard-role-live',
  });
});

test('세션 가드 — role 강등은 재로그인 없이 다음 요청부터 403이다(스냅샷 아님)', async () => {
  const demote = await api('PUT', `/api/users/${fixtureUser.userId}`, {
    sid: sid('Z'), body: { role: 'R' },
  });
  assert.equal(demote.status, 200);
  assert.deepEqual(demote.json, { ok: true, changes: 1 });

  record('users-update', 'success', {
    ...fromResponse(demote, { values: { field: 'role', changes: 1 } }),
    caseId: 'guard-demote-role',
  });

  // 같은 토큰 — 재로그인하지 않는다. 가드가 없으면 여기서 200이 나온다(변이 실증 지점).
  const after = await api('GET', '/api/logs/digest', { sid: guardSid });

  assert.equal(after.status, 403, '강등된 계정의 기존 세션이 Z 전용 라우트를 통과하면 권한 상승이다');
  assert.deepEqual(after.json, { ok: false, reason: 'forbidden' });

  record('logs-digest', 'forbidden', {
    ...fromResponse(after, { values: { roleAtLogin: 'Z', roleNow: 'R', reLogin: false } }),
    caseId: 'guard-role-demoted',
  });
});

test('세션 가드 — GET /api/session의 신원은 로그인 스냅샷이 아니라 DB 최신값이다', async () => {
  const res = await api('GET', '/api/session', { sid: guardSid });

  assert.equal(res.status, 200);
  assert.equal(res.json?.ok, true);
  assert.deepEqual(Object.keys(res.json.user ?? {}).sort(), SESSION_USER_KEYS);
  assert.equal(res.json.user.role, 'R', '강등 후 세션 신원의 role은 DB 최신값이어야 한다');
  assert.equal(res.json.user.userId, fixtureUser.userId);

  record('session', 'success', {
    ...fromResponse(res, { values: { roleAtLogin: 'Z', roleNow: 'R', userKeys: SESSION_USER_KEYS.join(',') } }),
    caseId: 'guard-identity-rederived',
  });
});

test('세션 가드 — active=N 비활성화는 그 세션을 즉시 무효화한다(401)', async () => {
  const deactivate = await api('PUT', `/api/users/${fixtureUser.userId}`, {
    sid: sid('Z'), body: { active: 'N' },
  });
  assert.equal(deactivate.status, 200);
  assert.deepEqual(deactivate.json, { ok: true, changes: 1 });

  record('users-update', 'success', {
    ...fromResponse(deactivate, { values: { field: 'active', changes: 1 } }),
    caseId: 'guard-deactivate',
  });

  const after = await api('GET', '/api/session', { sid: guardSid });

  assert.equal(after.status, 401, '비활성화된 계정의 기존 세션이 살아 있으면 즉시 차단 요구가 깨진다');
  assert.deepEqual(after.json, { ok: false, reason: 'unauthenticated' });

  record('session', 'unauthenticated', {
    ...fromResponse(after, { values: { activeNow: 'N', reLogin: false } }),
    caseId: 'guard-deactivated',
  });
});

test('세션 가드 — 무효화는 영구적이다(같은 토큰은 다른 라우트에서도 401)', async () => {
  // 세션을 "그 요청만 거부"가 아니라 **스토어에서 제거**했다는 음성 증거 — 다른 라우트로 되살아나지 않는다.
  const res = await api('GET', '/api/articles', { sid: guardSid });

  assert.equal(res.status, 401);
  assert.deepEqual(res.json, { ok: false, reason: 'unauthenticated' });

  record('articles-list', 'unauthenticated', {
    ...fromResponse(res, { values: { activeNow: 'N', tokenReuse: true } }),
    caseId: 'guard-deactivated-token-dead',
  });
});
