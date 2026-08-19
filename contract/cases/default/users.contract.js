// 계약 케이스: 사용자 관리 3 라우트 — GET /api/users(users-list) · POST /api/users(users-create) ·
// PUT /api/users/:id(users-update). default 프로파일.
// 계약 축: (1) 역할별 응답 투영 — Z=SAFE_FIELDS 6키, 비-Z=정확 4키(userId,name,department,departmentCode).
//          (2) 비밀번호는 평문도 해시도 어떤 응답에도 없다. (3) 쓰기 2라우트는 Z 전용(미인증 401 · 비-Z 403).
// 판정 기준은 **요청자의 세션 role**이다 — 클라이언트가 보낸 role/body는 신뢰 대상이 아니다(ADR-004).
//
// 예측(코드 정독 → 실행 전 기록, decisions (16)):
//  - GET 미인증 → 401 {ok:false,reason:'unauthenticated'}(server/index.js UNAUTH 상수).
//  - GET R → 200, 원소는 라우트 리터럴 4키. GET Z → 200, userService.SAFE_FIELDS 6키(잠금 필드 미노출).
//  - POST/PUT 미인증 → authorization 게이트 unauthenticated → fail() → 401. 비-Z → forbidden → 403.
//  - POST Z 성공 → 200 {ok:true,user:sanitize(row)} — sanitize는 **undefined 필드를 뺀다**(누락 필드는 키 자체가 없다).
//  - POST 중복 userId → User.userId는 TEXT PRIMARY KEY라 insert가 throw → 라우트 catch → next(e) →
//    전역 에러 핸들러 → **500 {ok:false,reason:'internal-error'}**(400·409가 아니다).
//  - POST 검증 없음 → role:'X' 같은 정의 밖 값도 그대로 200(userService.create에 검증이 없다).
//  - PUT 성공 → 200 {ok:true,changes:1}(user 객체를 돌려주지 않는다). 없는 userId → **200 {ok:true,changes:0}**(404 아님).
//
// 금지(step7): 시드 계정(reporter·desk·admin) 수정 금지 — 러너가 그 세션으로 전 프로파일을 돌린다.
//   생성한 계정으로 로그인하지 않는다(로그인 예산 15분/10회, decisions (8)).

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api } from '../../lib/http.js';
import { sid } from '../../lib/session.js';
import { unique } from '../../lib/fixtures.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';

requireProfile('default');

// Z 조회 투영(userService.SAFE_FIELDS) / 비-Z 투영(라우트 리터럴) — 정렬 비교용.
const SAFE_KEYS = ['active', 'department', 'departmentCode', 'name', 'role', 'userId'];
const PUBLIC_KEYS = ['department', 'departmentCode', 'name', 'userId'];
const BCRYPT_RE = /\$2[aby]\$/; // bcrypt 해시 접두사 — 어떤 응답에도 나오면 안 된다.

// 계약 스위트가 만드는 계정의 비밀번호는 매 실행 난수다(하드코딩 금지 — decisions (22)).
// 이 값은 요청 body 밖으로 나가지 않는다: 리포트·단언 메시지·로그에 넣지 않는다.
function secret() {
  return crypto.randomBytes(24).toString('hex');
}

// 응답 본문 전체를 문자열로 훑어 비밀 누출을 본다. 실패 메시지에 값 자체는 넣지 않는다(LOGS.md 마스킹).
function assertNoSecret(res, plaintext) {
  const body = JSON.stringify(res.json ?? res.text ?? null);
  assert.equal(BCRYPT_RE.test(body), false, 'bcrypt 해시 접두사가 응답에 실렸다');
  assert.equal(body.includes('"password"'), false, 'password 키가 응답에 실렸다');
  if (plaintext) assert.equal(body.includes(plaintext), false, '평문 비밀번호가 응답에 실렸다');
}

function listUsers(role) {
  return api('GET', '/api/users', { sid: sid(role) });
}

function findUser(res, userId) {
  return (res.json?.items ?? []).find((u) => u.userId === userId);
}

// 픽스처 계정 — 6필드를 전부 채운다(Z 투영의 "정확 6키"를 자기 픽스처로 단언하기 위해).
// active는 주지 않는다: userService.create의 기본값 'Y'가 적용되는지도 함께 본다.
const fixtureUser = {
  userId: unique('ct-user'),
  name: unique('ct-name'),
  role: 'R',
  department: unique('ct-dept'),
  departmentCode: 'CT',
  password: secret(),
};
let createRes;

before(async () => {
  createRes = await api('POST', '/api/users', { sid: sid('Z'), body: fixtureUser });
  if (createRes.status !== 200 || createRes.json?.ok !== true) {
    throw new Error(`픽스처 실패 createUser: status=${createRes.status} reason=${createRes.json?.reason ?? '-'}`);
  }
});

test('POST /api/users — Z는 사용자를 만든다(응답에 비밀번호 없음)', () => {
  assert.equal(createRes.status, 200);
  assert.deepEqual(Object.keys(createRes.json).sort(), ['ok', 'user']);
  assert.equal(createRes.json.ok, true);
  // 응답 user = sanitize(row): 요청한 5필드 + 서비스 기본값 active='Y'. password는 어떤 경우에도 없다.
  assert.deepEqual(Object.keys(createRes.json.user).sort(), SAFE_KEYS);
  assert.equal(createRes.json.user.userId, fixtureUser.userId);
  assert.equal(createRes.json.user.role, 'R');
  assert.equal(createRes.json.user.active, 'Y');
  assertNoSecret(createRes, fixtureUser.password);

  record('users-create', 'success', {
    ...fromResponse(createRes, {
      values: { userKeys: SAFE_KEYS.join(','), role: 'R', active: 'Y', hasPassword: false },
    }),
    caseId: 'z-create',
  });
});

test('GET /api/users — Z는 SAFE_FIELDS 6키 전체 명단을 받는다(password·잠금 필드 없음)', async () => {
  const res = await listUsers('Z');

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['items', 'ok']);
  assert.ok(Array.isArray(res.json.items));
  // 사전 존재 데이터 강건성(decisions (6)): 전 원소는 "SAFE_FIELDS 밖 키가 없다"만 보고,
  // "정확히 6키"는 6필드를 전부 채운 자기 픽스처로 단언한다.
  for (const item of res.json.items) {
    const extra = Object.keys(item).filter((k) => !SAFE_KEYS.includes(k));
    assert.deepEqual(extra, [], 'Z 명단 원소에 SAFE_FIELDS 밖 키가 있다');
  }
  const mine = findUser(res, fixtureUser.userId);
  assert.ok(mine, '방금 만든 사용자가 Z 명단에 없다');
  assert.deepEqual(Object.keys(mine).sort(), SAFE_KEYS);
  assert.equal(mine.name, fixtureUser.name);
  assert.equal(mine.department, fixtureUser.department);
  assert.equal(mine.departmentCode, 'CT');
  assert.equal(mine.role, 'R');
  assert.equal(mine.active, 'Y');
  assertNoSecret(res, fixtureUser.password);

  record('users-list', 'success', {
    ...fromResponse(res, {
      values: { fixtureKeys: SAFE_KEYS.join(','), hasRole: true, hasActive: true, hasPassword: false },
    }),
    caseId: 'z-full',
  });
});

test('GET /api/users — 비-Z(R)는 정확 4키 투영만 받는다(role·active 미노출)', async () => {
  const res = await listUsers('R');

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['items', 'ok']);
  assert.ok(res.json.items.length > 0, '투영 판정에 쓸 원소가 없다');
  // 추가 키가 1개라도 있으면 실패 — 기자에게 role/active/잠금 상태가 새면 계약 위반이다.
  for (const item of res.json.items) {
    const extra = Object.keys(item).filter((k) => !PUBLIC_KEYS.includes(k));
    assert.deepEqual(extra, [], '비-Z 투영에 4필드 밖 키가 있다');
    assert.ok('userId' in item, '비-Z 투영 원소에 userId가 없다');
    assert.equal('role' in item, false);
    assert.equal('active' in item, false);
  }
  const mine = findUser(res, fixtureUser.userId);
  assert.ok(mine, '방금 만든 사용자가 R 명단에 없다');
  assert.deepEqual(Object.keys(mine).sort(), PUBLIC_KEYS);
  assertNoSecret(res, fixtureUser.password);

  record('users-list', 'success', {
    ...fromResponse(res, {
      values: { fixtureKeys: PUBLIC_KEYS.join(','), hasRole: false, hasActive: false, hasPassword: false },
    }),
    caseId: 'r-projection',
  });
});

test('GET /api/users — 미인증은 401 unauthenticated', async () => {
  const res = await api('GET', '/api/users');

  assert.equal(res.status, 401);
  assert.deepEqual(res.json, { ok: false, reason: 'unauthenticated' });

  record('users-list', 'unauthenticated', { ...fromResponse(res), caseId: 'no-session' });
});

test('POST /api/users — 미인증 401 · 비-Z(R) 403이고 행이 생기지 않는다', async () => {
  const denied = { userId: unique('ct-denied'), name: unique('ct-denied-name'), role: 'R', password: secret() };

  const noSession = await api('POST', '/api/users', { body: denied });
  assert.equal(noSession.status, 401);
  assert.deepEqual(noSession.json, { ok: false, reason: 'unauthenticated' });
  record('users-create', 'unauthenticated', { ...fromResponse(noSession), caseId: 'no-session' });

  const asReporter = await api('POST', '/api/users', { sid: sid('R'), body: denied });
  assert.equal(asReporter.status, 403);
  assert.deepEqual(asReporter.json, { ok: false, reason: 'forbidden' });
  record('users-create', 'forbidden', { ...fromResponse(asReporter), caseId: 'r-session' });

  // 게이트가 실제로 모델 호출을 막았는지 — 거부된 userId는 Z 명단에도 없어야 한다.
  const list = await listUsers('Z');
  assert.equal(findUser(list, denied.userId), undefined, '거부된 요청이 사용자 행을 만들었다');
});

test('POST /api/users — 같은 userId 재생성은 500 internal-error(중복 키가 400·409가 아니다)', async () => {
  const res = await api('POST', '/api/users', { sid: sid('Z'), body: fixtureUser });

  assert.equal(res.status, 500);
  assert.deepEqual(res.json, { ok: false, reason: 'internal-error' });
  assertNoSecret(res, fixtureUser.password);

  // 태그는 'conflict'가 아니라 'server-error'다(articles-read의 스칼라 반복 500과 같은 어휘).
  // 이유: 이 500은 결함 후보이지 충돌(409) 계약이 아니다 — 'conflict'로 적어 두면 누군가
  // users-create의 expect에 'conflict'를 추가하는 순간 **500 관측이 그 커버리지를 채워** 실재하지
  // 않는 409 계약이 검증된 것처럼 보인다. 'server-error'는 인벤토리 EXPECT_TAGS 고정 어휘 밖이라
  // 어떤 expect도 이 관측으로 충족될 수 없다(contract-inventory-check가 unknown expect tag로 red).
  record('users-create', 'server-error', { ...fromResponse(res), caseId: 'duplicate-userid' });
});

test('POST /api/users — 입력 검증이 없다(정의 밖 role·필드 누락도 200)', async () => {
  // active:'N'으로 만든다 — 검증 부재를 관측하되 로그인 가능한 계정을 남기지 않기 위해서다
  // (userService.create는 password 미지정 시 빈 문자열을 해시한다 — forward_notes 참조).
  const loose = { userId: unique('ct-loose'), role: 'X', active: 'N' };
  const res = await api('POST', '/api/users', { sid: sid('Z'), body: loose });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  // sanitize는 undefined 필드를 빼므로 누락한 name/department/departmentCode는 키 자체가 없다.
  assert.deepEqual(Object.keys(res.json.user).sort(), ['active', 'role', 'userId']);
  assert.equal(res.json.user.role, 'X'); // R/D/Z 검증 없음 — 그대로 저장된다.
  assertNoSecret(res, null);

  record('users-create', 'validation', {
    ...fromResponse(res, { values: { userKeys: 'active,role,userId', role: 'X', validated: false } }),
    caseId: 'no-validation',
  });
});

test('PUT /api/users/:id — 미인증 401 · 비-Z(R) 403이고 값이 바뀌지 않는다', async () => {
  const patch = { name: unique('ct-should-not-apply') };

  const noSession = await api('PUT', `/api/users/${fixtureUser.userId}`, { body: patch });
  assert.equal(noSession.status, 401);
  assert.deepEqual(noSession.json, { ok: false, reason: 'unauthenticated' });
  record('users-update', 'unauthenticated', { ...fromResponse(noSession), caseId: 'no-session' });

  const asReporter = await api('PUT', `/api/users/${fixtureUser.userId}`, { sid: sid('R'), body: patch });
  assert.equal(asReporter.status, 403);
  assert.deepEqual(asReporter.json, { ok: false, reason: 'forbidden' });
  record('users-update', 'forbidden', { ...fromResponse(asReporter), caseId: 'r-session' });

  const list = await listUsers('Z');
  assert.equal(findUser(list, fixtureUser.userId).name, fixtureUser.name, '거부된 요청이 값을 바꿨다');
});

test('PUT /api/users/:id — Z는 이름·부서를 바꾼다(200 changes:1 · 되읽어 반영)', async () => {
  const patch = { name: unique('ct-rename'), department: unique('ct-dept2') };
  const res = await api('PUT', `/api/users/${fixtureUser.userId}`, { sid: sid('Z'), body: patch });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['changes', 'ok']); // user 객체를 돌려주지 않는다.
  assert.equal(res.json.ok, true);
  assert.equal(res.json.changes, 1);

  const list = await listUsers('Z');
  const mine = findUser(list, fixtureUser.userId);
  assert.equal(mine.name, patch.name);
  assert.equal(mine.department, patch.department);
  assert.equal(mine.role, 'R', '수정 요청에 없던 필드가 바뀌었다');
  fixtureUser.name = patch.name;
  fixtureUser.department = patch.department;

  record('users-update', 'success', {
    ...fromResponse(res, { values: { changes: 1, bodyKeysExact: 'changes,ok', reread: 'applied' } }),
    caseId: 'z-rename',
  });
});

test('PUT /api/users/:id — 비밀번호 변경 응답에 평문도 해시도 없다', async () => {
  const nextPassword = secret();
  const res = await api('PUT', `/api/users/${fixtureUser.userId}`, {
    sid: sid('Z'), body: { password: nextPassword },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['changes', 'ok']);
  assert.equal(res.json.changes, 1);
  assertNoSecret(res, nextPassword);

  // 되읽어도 password 키·해시가 없다(Z 투영은 SAFE_FIELDS 밖을 싣지 않는다).
  const list = await listUsers('Z');
  assertNoSecret(list, nextPassword);
  assert.equal('password' in findUser(list, fixtureUser.userId), false);

  record('users-update', 'success', {
    ...fromResponse(res, { values: { changes: 1, hasPassword: false, hasBcryptHash: false } }),
    caseId: 'password-no-echo',
  });
});

test('PUT /api/users/:id — 비활성화(active:N)는 200이고 명단에 반영된다(행은 남는다)', async () => {
  // 자기 픽스처 계정에만 한다 — 시드 계정을 비활성화하면 전 프로파일의 세션이 무너진다(step7 금지사항).
  const res = await api('PUT', `/api/users/${fixtureUser.userId}`, { sid: sid('Z'), body: { active: 'N' } });

  assert.equal(res.status, 200);
  assert.equal(res.json.changes, 1);

  const list = await listUsers('Z');
  const mine = findUser(list, fixtureUser.userId);
  assert.ok(mine, '비활성화된 사용자가 명단에서 사라졌다(행 삭제는 계약 위반)');
  assert.equal(mine.active, 'N');

  record('users-update', 'success', {
    ...fromResponse(res, { values: { changes: 1, active: 'N', rowKept: true } }),
    caseId: 'deactivate',
  });
});

test('PUT /api/users/:id — 없는 userId도 200 {ok:true,changes:0}(404가 아니다)', async () => {
  const res = await api('PUT', `/api/users/${unique('ct-missing')}`, {
    sid: sid('Z'), body: { name: unique('ct-noop') },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['changes', 'ok']);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.changes, 0); // 존재 판정을 하지 않는다 — 대상 없음이 changes로만 드러난다.

  record('users-update', 'not-found', {
    ...fromResponse(res, { values: { changes: 0 } }),
    caseId: 'unknown-userid',
  });
});
