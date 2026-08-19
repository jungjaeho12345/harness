// 계약 케이스: 배부 수신처 CRUD 4 라우트 — GET /api/distribution-targets(distribution-targets-list) ·
// POST /api/distribution-targets(distribution-targets-create) · PUT /api/distribution-targets/:id
// (distribution-targets-update) · POST /api/distribution-targets/:id/deactivate(distribution-targets-deactivate).
// default 프로파일.
// 계약 축(ADR-008):
//  (1) 4 라우트 전부 **Z 전용** — 미인증 401 · 비-Z 403(R도 D도 안 된다). 게이트는 라우트가 아니라
//      distributionTargetService/authorization이 강제한다(Spring에서 게이트 위치가 바뀌어도 계약은 같다).
//  (2) **행 삭제 경로가 없다** — DELETE /api/distribution-targets/:id 라우트는 존재하지 않고(404),
//      제거는 active='N' soft delete뿐이다. 비활성 행은 목록에서 사라지지 않는다(필터 정책이 계약).
//  (3) 검증 거부 토큰 5종은 전부 fail() fallback 400이다(전역 STATUS_BY_REASON에 없다).
//
// 예측(코드 정독 → 실행 전 기록, decisions (16)):
//  - 인가: 미인증 401 {ok:false,reason:'unauthenticated'} · R/D 403 forbidden — 4 라우트 동형.
//  - create Z 성공 → 200 {ok:true,id:<정수>} (키 2개). active 미지정이면 'Y'.
//  - 검증 거부(create): name 누락 → 400 invalid-name · kind:'bogus' → 400 invalid-kind ·
//    spoolDir '../escape'|'a/b' → 400 invalid-spool-dir · 사용 중 spoolDir → 400 duplicate-spool-dir ·
//    active:'x' → 400 invalid-active. 검증 순서는 name → kind → spoolDir → active.
//  - list Z → 200 {ok:true,items:[...]}, 원소 키는 SAFE_FIELDS 정확 7키이며 **spoolDir가 실린다**
//    (Z 전용 관리 화면의 계약 — 서버 파일시스템 절대경로가 아니라 슬러그다).
//  - update Z → 200 {ok:true,changes:1} + updatedAt 갱신. 없는 id → 404 not-found ·
//    비수치 id('abc') → Number() NaN → 어떤 행에도 매치되지 않아 404 not-found(500 아님).
//  - deactivate Z → 200 {ok:true,changes:1}, 되읽으면 active='N'이고 **행은 목록에 남는다**.
//  - PUT {active:'N'}도 같은 전이의 두 번째 진입점 → 같은 결과.
//  - DELETE /api/distribution-targets/:id → 핸들러 미등록 → Express 기본 404(JSON 계약 아님).
//    관측은 커버리지 집계 제외 채널 x-distribution-targets-delete로만 남긴다(decisions (23)).
//
// 금지(step10): 이 파일이 만든 수신처를 **활성인 채로 남기지 않는다** — 같은 프로파일의 뒤 케이스가
//   기사를 송고하면 예상치 못한 배부가 일어나 status·distributedAt이 흔들린다. 회수는 deactivate뿐이다
//   (행 삭제 금지 — ADR-008·SCHEMA.md).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { sid } from '../../lib/session.js';
import { unique } from '../../lib/fixtures.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';

requireProfile('default');

// distributionTargetService.SAFE_FIELDS(정렬) — 모델이 SELECT *라 원소는 항상 이 7키다.
const SAFE_KEYS = ['active', 'createdAt', 'id', 'kind', 'name', 'spoolDir', 'updatedAt'];

const listTargets = (role, query) => api('GET', '/api/distribution-targets', { sid: sid(role), query });
const createTarget = (body, role = 'Z') => api('POST', '/api/distribution-targets', { sid: sid(role), body });
const updateTarget = (id, body, role = 'Z') => api('PUT', `/api/distribution-targets/${id}`, { sid: sid(role), body });
const deactivateTarget = (id, role = 'Z') => api('POST', `/api/distribution-targets/${id}/deactivate`, { sid: sid(role) });

// 자기 픽스처만 조회한다(절대 개수 단언 금지 — decisions (6)). spoolDir는 유일성이 보장된 키다.
async function findBySpoolDir(spoolDir) {
  const res = await listTargets('Z', { spoolDir });
  return res.json?.items?.[0];
}

// 존재하지 않는 id — 사전 존재 데이터가 있어도 충돌하지 않도록 충분히 큰 값을 쓴다.
const ABSENT_ID = 999999999;

const pressSpool = unique('ct-press');
const nonpressSpool = unique('ct-nonpr');
const pressName = unique('contract-target-press');
const nonpressName = unique('contract-target-nonpress');

let pressCreate;
let nonpressCreate;

before(async () => {
  pressCreate = await createTarget({ name: pressName, kind: 'press', spoolDir: pressSpool });
  nonpressCreate = await createTarget({ name: nonpressName, kind: 'nonpress', spoolDir: nonpressSpool });
  for (const [what, res] of [['press', pressCreate], ['nonpress', nonpressCreate]]) {
    if (res.status !== 200 || res.json?.ok !== true || !Number.isInteger(res.json.id)) {
      throw new Error(`픽스처 실패 createTarget(${what}): status=${res.status} reason=${res.json?.reason ?? '-'}`);
    }
  }
});

// 안전망 — 어떤 케이스가 실패해 중간에 멈춰도 이 파일의 수신처는 반드시 비활성으로 남는다(멱등).
after(async () => {
  for (const created of [pressCreate, nonpressCreate]) {
    if (created?.json?.id !== undefined) await deactivateTarget(created.json.id);
  }
});

test('POST /api/distribution-targets — Z는 수신처를 만든다(응답은 {ok,id}뿐)', () => {
  for (const [caseId, res, kind] of [['z-create-press', pressCreate, 'press'], ['z-create-nonpress', nonpressCreate, 'nonpress']]) {
    assert.equal(res.status, 200, `${kind} 생성 상태`);
    assert.deepEqual(Object.keys(res.json).sort(), ['id', 'ok']);
    assert.equal(res.json.ok, true);
    assert.ok(Number.isInteger(res.json.id) && res.json.id > 0);

    record('distribution-targets-create', 'success', {
      ...fromResponse(res, { values: { idIsPositiveInteger: true, kind } }),
      caseId,
    });
  }
});

test('POST /api/distribution-targets — 검증 거부 5종은 전부 400이고 행을 만들지 않는다', async () => {
  const freeSpool = unique('ct-actv'); // active 거부 케이스용 — 거부되므로 이 슬러그는 계속 미사용이다.
  const cases = [
    // [caseId, body, 기대 reason]
    ['missing-name', { kind: 'press', spoolDir: unique('ct-noname') }, 'invalid-name'],
    ['bad-kind', { name: unique('ct-badkind'), kind: 'bogus', spoolDir: unique('ct-badkind') }, 'invalid-kind'],
    ['spool-parent-ref', { name: unique('ct-esc'), kind: 'press', spoolDir: '../escape' }, 'invalid-spool-dir'],
    ['spool-separator', { name: unique('ct-sep'), kind: 'press', spoolDir: 'a/b' }, 'invalid-spool-dir'],
    ['duplicate-spool', { name: unique('ct-dup'), kind: 'press', spoolDir: pressSpool }, 'duplicate-spool-dir'],
    ['bad-active', { name: unique('ct-act'), kind: 'press', spoolDir: freeSpool, active: 'x' }, 'invalid-active'],
  ];

  for (const [caseId, body, reason] of cases) {
    const res = await createTarget(body);
    assert.equal(res.status, 400, `${caseId} 상태`);
    assert.deepEqual(res.json, { ok: false, reason }, `${caseId} 본문`);

    record('distribution-targets-create', 'validation', {
      ...fromResponse(res, { values: { rejected: caseId } }),
      caseId,
    });
  }

  // 거부는 아무 행도 만들지 않는다 — 유효한 슬러그였던 free/dup 후보로 되짚는다.
  assert.equal(await findBySpoolDir(freeSpool), undefined, 'invalid-active 거부가 행을 만들었다');
  const dup = await findBySpoolDir(pressSpool);
  assert.equal(dup.id, pressCreate.json.id, 'duplicate 거부가 기존 행을 덮어썼다');
});

test('GET /api/distribution-targets — Z 목록 원소는 SAFE_FIELDS 7키(spoolDir 포함)', async () => {
  const res = await listTargets('Z');

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['items', 'ok']);
  assert.ok(Array.isArray(res.json.items));
  // 사전 존재 데이터 강건성 — 개수는 단언하지 않고 "SAFE_FIELDS 밖 키 없음"만 전수로 본다.
  for (const item of res.json.items) {
    const extra = Object.keys(item).filter((k) => !SAFE_KEYS.includes(k));
    assert.deepEqual(extra, [], '목록 원소에 SAFE_FIELDS 밖 키가 있다');
  }

  const mine = res.json.items.find((t) => t.spoolDir === pressSpool);
  assert.ok(mine, '방금 만든 수신처가 목록에 없다');
  assert.deepEqual(Object.keys(mine).sort(), SAFE_KEYS);
  assert.equal(mine.id, pressCreate.json.id);
  assert.equal(mine.name, pressName);
  assert.equal(mine.kind, 'press');
  assert.equal(mine.active, 'Y', 'active 미지정 생성의 기본값은 Y');
  assert.equal(typeof mine.createdAt, 'string');
  assert.equal(typeof mine.updatedAt, 'string');

  // 필터는 화이트리스트 컬럼 AND 동등 비교다 — 자기 슬러그로 좁히면 정확히 1건.
  const filtered = await listTargets('Z', { spoolDir: pressSpool });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.json.items.length, 1);

  record('distribution-targets-list', 'success', {
    ...fromResponse(res, {
      values: { itemKeys: SAFE_KEYS.join(','), spoolDirExposed: true, defaultActive: 'Y', filteredMineCount: 1 },
    }),
    caseId: 'z-list',
  });
});

test('배부 수신처 4 라우트 — 미인증 401 · R 403 · D 403(D도 안 된다)', async () => {
  const id = pressCreate.json.id;
  // 게이트가 뚫려도 피해가 자기 픽스처에 머물도록 **자기 행 id**를 대상으로 시험한다.
  const routes = [
    ['distribution-targets-list', () => api('GET', '/api/distribution-targets'), (role) => listTargets(role)],
    [
      'distribution-targets-create',
      () => api('POST', '/api/distribution-targets', { body: { name: unique('ct-denied'), kind: 'press', spoolDir: unique('ct-denied') } }),
      (role) => createTarget({ name: unique('ct-denied'), kind: 'press', spoolDir: unique('ct-denied') }, role),
    ],
    [
      'distribution-targets-update',
      () => api('PUT', `/api/distribution-targets/${id}`, { body: { name: unique('ct-denied') } }),
      (role) => updateTarget(id, { name: unique('ct-denied') }, role),
    ],
    [
      'distribution-targets-deactivate',
      () => api('POST', `/api/distribution-targets/${id}/deactivate`),
      (role) => deactivateTarget(id, role),
    ],
  ];

  for (const [routeId, anonCall, roleCall] of routes) {
    const noSession = await anonCall();
    assert.equal(noSession.status, 401, `${routeId} 미인증 상태`);
    assert.deepEqual(noSession.json, { ok: false, reason: 'unauthenticated' });
    record(routeId, 'unauthenticated', { ...fromResponse(noSession), caseId: 'no-session' });

    for (const role of ['R', 'D']) {
      const denied = await roleCall(role);
      assert.equal(denied.status, 403, `${routeId} ${role} 세션 상태`);
      assert.deepEqual(denied.json, { ok: false, reason: 'forbidden' });
      record(routeId, 'forbidden', { ...fromResponse(denied), caseId: role === 'R' ? 'r-session' : 'd-session' });
    }
  }

  // 거부된 write는 아무것도 바꾸지 않았다 — 이름·활성 상태 그대로.
  const mine = await findBySpoolDir(pressSpool);
  assert.equal(mine.name, pressName, '거부된 PUT이 이름을 바꿨다');
  assert.equal(mine.active, 'Y', '거부된 deactivate가 행을 내렸다');
});

test('PUT /api/distribution-targets/:id — Z는 이름을 바꾼다(200 changes:1 · 되읽어 반영)', async () => {
  const before2 = await findBySpoolDir(pressSpool);
  const renamed = `${pressName}-renamed`;

  const res = await updateTarget(pressCreate.json.id, { name: renamed });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['changes', 'ok']);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.changes, 1);

  const after2 = await findBySpoolDir(pressSpool);
  assert.equal(after2.name, renamed);
  assert.equal(after2.kind, 'press', '전달하지 않은 필드는 불변(present-only)');
  assert.equal(after2.createdAt, before2.createdAt, 'createdAt은 서버 소유 — 수정으로 바뀌지 않는다');
  assert.equal(typeof after2.updatedAt, 'string');
  assert.ok(after2.updatedAt.length > 0, 'updatedAt이 stamp되지 않았다');

  record('distribution-targets-update', 'success', {
    ...fromResponse(res, { values: { changes: 1, nameApplied: true, kindUnchanged: true, createdAtStable: true } }),
    caseId: 'z-rename',
  });
});

test('PUT /api/distribution-targets/:id — 검증 거부는 400이고 아무것도 저장하지 않는다', async () => {
  const id = pressCreate.json.id;
  const cases = [
    ['bad-active', { active: 'x' }, 'invalid-active'],
    ['bad-kind', { kind: 'PRESS' }, 'invalid-kind'],
  ];

  for (const [caseId, body, reason] of cases) {
    const res = await updateTarget(id, body);
    assert.equal(res.status, 400, `${caseId} 상태`);
    assert.deepEqual(res.json, { ok: false, reason }, `${caseId} 본문`);

    record('distribution-targets-update', 'validation', {
      ...fromResponse(res, { values: { rejected: caseId } }),
      caseId,
    });
  }

  const mine = await findBySpoolDir(pressSpool);
  assert.equal(mine.active, 'Y', '거부된 PUT이 활성 상태를 바꿨다');
  assert.equal(mine.kind, 'press', '거부된 PUT이 kind를 바꿨다');
});

test('PUT · deactivate — 없는 id와 비수치 id는 둘 다 404 not-found(500 아님)', async () => {
  const probes = [['absent-id', ABSENT_ID], ['nan-id', 'abc']];

  for (const [caseId, id] of probes) {
    const put = await updateTarget(id, { name: unique('ct-nowhere') });
    assert.equal(put.status, 404, `PUT ${caseId} 상태`);
    assert.deepEqual(put.json, { ok: false, reason: 'not-found' });
    record('distribution-targets-update', 'not-found', {
      ...fromResponse(put, { values: { probe: caseId } }),
      caseId,
    });

    const off = await deactivateTarget(id);
    assert.equal(off.status, 404, `deactivate ${caseId} 상태`);
    assert.deepEqual(off.json, { ok: false, reason: 'not-found' });
    record('distribution-targets-deactivate', 'not-found', {
      ...fromResponse(off, { values: { probe: caseId } }),
      caseId,
    });
  }
});

test('soft delete 경로 (a) POST /:id/deactivate — active=N이고 행은 목록에 남는다', async () => {
  const res = await deactivateTarget(pressCreate.json.id);

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['changes', 'ok']);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.changes, 1);

  const mine = await findBySpoolDir(pressSpool);
  assert.ok(mine, '비활성 수신처가 목록에서 사라졌다 — soft delete가 아니라 삭제다');
  assert.equal(mine.active, 'N');
  assert.equal(mine.id, pressCreate.json.id, '같은 행이 유지된다(재생성 아님)');

  record('distribution-targets-deactivate', 'success', {
    ...fromResponse(res, { values: { changes: 1, activeAfter: 'N', stillListed: true } }),
    caseId: 'z-deactivate',
  });
});

test('soft delete 경로 (b) PUT {active:"N"} — 같은 전이의 두 번째 진입점', async () => {
  const res = await updateTarget(nonpressCreate.json.id, { active: 'N' });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.changes, 1);

  const mine = await findBySpoolDir(nonpressSpool);
  assert.ok(mine, '비활성 수신처가 목록에서 사라졌다');
  assert.equal(mine.active, 'N');
  assert.equal(mine.id, nonpressCreate.json.id);

  record('distribution-targets-update', 'success', {
    ...fromResponse(res, { values: { changes: 1, activeAfter: 'N', stillListed: true } }),
    caseId: 'z-soft-delete',
  });
});

test('DELETE /api/distribution-targets/:id — 라우트가 존재하지 않는다(행 삭제 경로 없음)', async () => {
  const id = pressCreate.json.id;
  const res = await api('DELETE', `/api/distribution-targets/${id}`, { sid: sid('Z') });

  // 핸들러 미등록 → 프레임워크 기본 404. JSON 응답 계약이 아니므로 본문 shape은 단언하지 않는다.
  assert.equal(res.status, 404);
  assert.equal(res.json?.ok, undefined, '삭제 성공 응답이 있어서는 안 된다');

  // 행은 그대로 남아 있다 — 이 단언이 "행 삭제 경로가 없다"의 실증이다.
  const mine = await findBySpoolDir(pressSpool);
  assert.ok(mine, 'DELETE 요청이 수신처 행을 지웠다(ADR-008 위반)');
  assert.equal(mine.id, id);

  // 인벤토리에 없는 라우트의 관측 → x- 접두사(커버리지 집계 제외 — decisions (23)).
  // 실재 라우트 id(distribution-targets-deactivate 등)에 매달면 커버리지가 거짓으로 채워진다.
  record('x-distribution-targets-delete', 'not-found', {
    ...fromResponse(res, { values: { rowSurvives: true, jsonBody: false } }),
    caseId: 'route-absent',
  });
});

test('회수: 이 파일이 만든 수신처는 전부 비활성으로 남는다(뒤 케이스의 예상치 못한 배부 방지)', async () => {
  for (const [spoolDir, created] of [[pressSpool, pressCreate], [nonpressSpool, nonpressCreate]]) {
    const mine = await findBySpoolDir(spoolDir);
    assert.ok(mine, '수신처 행이 사라졌다');
    assert.equal(mine.id, created.json.id);
    assert.equal(mine.active, 'N', '활성 수신처를 남기면 뒤 케이스의 송고가 배부를 유발한다');
  }
});
