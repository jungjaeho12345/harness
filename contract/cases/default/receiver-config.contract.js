// 계약 케이스: 수집 수신 설정 3 라우트 — GET /api/receiver-config(receiver-config-list) ·
// POST /api/receiver-config(receiver-config-create) · DELETE /api/receiver-config/:id(receiver-config-delete).
// default 프로파일.
// 계약 축: (1) 3 라우트 전부 Z 전용(미인증 401 · 비-Z 403) — 라우트에는 게이트가 없고
//          receiverConfigService가 세션 토큰을 받아 판정한다(Spring에서 게이트 위치가 바뀌어도 계약은 동일).
//          (2) 응답 투영은 SAFE_FIELDS 10키 — password(FTP)·apiKey(API)는 **쓰기 전용 시크릿**이라 어떤 응답에도 없다.
//          (3) DELETE는 이 시스템의 유일한 행 삭제 라우트다. **ReceiverConfig 설정 행만** 지우고
//          그 sourceId로 이미 수집된 Article/Contents는 건드리지 않는다(DB 비파괴 원칙의 명시적 예외 경계).
//          수집 기사 불변을 실제로 확인하는 케이스는 step8(collection)이 소유한다 — 여기서는 명세에만 서술한다.
//
// 예측(코드 정독 → 실행 전 기록, decisions (16)):
//  - 미인증 → 게이트 unauthenticated → fail() → 401. 비-Z(R) → forbidden → 403. 3 라우트 동형.
//  - POST Z → 200 {ok:true,id:<정수>} — 입력 검증이 없다(type/sourceId 미검증). 시크릿을 되돌려주지 않는다.
//  - GET Z → 200 {ok:true,items:[...]}. 모델이 SELECT *라 원소는 항상 SAFE_FIELDS **정확 10키**
//    (미지정 컬럼은 null). password·apiKey는 sanitize allowlist 밖이라 없다.
//  - 쿼리: 라우트가 req.query를 그대로 서비스에 넘기고 모델이 화이트리스트 컬럼만 AND 동등 필터로 쓴다
//    → ?sourceId=<내것>은 내 행만, ?sourceId=<내것>&type=<불일치>는 빈 목록, 화이트리스트 밖 키는 무시(400 아님).
//  - DELETE 내 행 → 200 {ok:true,changes:1}. 같은 id 재삭제 → **200 {ok:true,changes:0}**(멱등, 404 아님).
//  - DELETE /abc → 라우트가 Number('abc')=NaN을 넘긴다 → SQL 바인딩상 매칭 0 → 200 {ok:true,changes:0} 예상
//    (드라이버가 NaN을 거부하면 500 internal-error — 실측으로 확정한다).
//
// 금지(step7): 자기가 만들지 않은 ReceiverConfig 행은 절대 지우지 않는다(decisions (14)) —
//   대상 서버(68+)에 실제 운영 설정이 있을 수 있다. 이 파일이 만든 행은 이 파일이 전부 회수한다.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api } from '../../lib/http.js';
import { sid } from '../../lib/session.js';
import { unique } from '../../lib/fixtures.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';

requireProfile('default');

// receiverConfigService.SAFE_FIELDS(정렬) — password·apiKey는 의도적으로 빠져 있다.
const SAFE_KEYS = [
  'active', 'apiEndpoint', 'createdAt', 'host', 'id', 'name', 'port', 'sourceId', 'type', 'username',
];

// 시크릿은 매 실행 난수다(하드코딩 금지 — decisions (22)). 요청 body 밖으로 내보내지 않는다.
function secret() {
  return crypto.randomBytes(24).toString('hex');
}

// 응답 본문 전체를 훑어 시크릿 누출을 본다. 실패 메시지에 값 자체는 넣지 않는다(LOGS.md 마스킹).
function assertNoSecret(res, ...plaintexts) {
  const body = JSON.stringify(res.json ?? res.text ?? null);
  assert.equal(body.includes('"password"'), false, 'password 키가 응답에 실렸다');
  assert.equal(body.includes('"apiKey"'), false, 'apiKey 키가 응답에 실렸다');
  for (const value of plaintexts) {
    if (value) assert.equal(body.includes(value), false, '시크릿 원문이 응답에 실렸다');
  }
}

function listConfigs(role, query) {
  return api('GET', '/api/receiver-config', { sid: sid(role), query });
}

const ftpSecret = secret();
const apiSecret = secret();

// FTP 설정(활성) — 목록 투영·삭제 케이스의 주 픽스처.
const ftpConfig = {
  sourceId: unique('ct-src'),
  type: 'FTP',
  name: unique('ct-recv'),
  host: '127.0.0.1',
  port: '21',
  username: unique('ct-user'),
  password: ftpSecret,
  active: 'Y',
};
// API 설정은 **비활성(active:'N')으로 만든다** — 대상 서버에 남아 능동 수집(pull)의 활성 API 소스로
// 선택되는 일이 없게 하기 위해서다. 회수(삭제)는 이 파일 마지막 케이스가 한다.
const apiConfig = {
  sourceId: unique('ct-src'),
  type: 'API',
  name: unique('ct-recv'),
  apiEndpoint: 'https://example.invalid/collect',
  apiKey: apiSecret,
  active: 'N',
};

let ftpCreate;
let apiCreate;

before(async () => {
  ftpCreate = await api('POST', '/api/receiver-config', { sid: sid('Z'), body: ftpConfig });
  apiCreate = await api('POST', '/api/receiver-config', { sid: sid('Z'), body: apiConfig });
  for (const [what, res] of [['ftp', ftpCreate], ['api', apiCreate]]) {
    if (res.status !== 200 || res.json?.ok !== true || !Number.isInteger(res.json.id)) {
      throw new Error(`픽스처 실패 createReceiverConfig(${what}): status=${res.status} reason=${res.json?.reason ?? '-'}`);
    }
  }
});

test('POST /api/receiver-config — Z는 설정을 만든다(응답은 {ok,id}뿐 · 시크릿 미반향)', () => {
  for (const [caseId, res, plain] of [['z-create-ftp', ftpCreate, ftpSecret], ['z-create-api', apiCreate, apiSecret]]) {
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['id', 'ok']);
    assert.equal(res.json.ok, true);
    assert.ok(Number.isInteger(res.json.id) && res.json.id > 0);
    assertNoSecret(res, plain);

    record('receiver-config-create', 'success', {
      ...fromResponse(res, { values: { idIsPositiveInteger: true, hasSecret: false } }),
      caseId,
    });
  }
});

test('GET /api/receiver-config — Z 목록은 SAFE_FIELDS 10키(password·apiKey 없음)', async () => {
  const res = await listConfigs('Z');

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['items', 'ok']);
  assert.ok(Array.isArray(res.json.items));
  // 사전 존재 데이터 강건성(decisions (6)): 개수는 단언하지 않고, 전 원소는 "SAFE_FIELDS 밖 키 없음"만 본다.
  for (const item of res.json.items) {
    const extra = Object.keys(item).filter((k) => !SAFE_KEYS.includes(k));
    assert.deepEqual(extra, [], '목록 원소에 SAFE_FIELDS 밖 키가 있다(시크릿 노출 위험)');
  }
  const mine = res.json.items.find((c) => c.sourceId === ftpConfig.sourceId);
  assert.ok(mine, '방금 만든 설정이 목록에 없다');
  assert.deepEqual(Object.keys(mine).sort(), SAFE_KEYS); // 미지정 컬럼도 null로 실린다 → 항상 10키.
  assert.equal(mine.id, ftpCreate.json.id);
  assert.equal(mine.type, 'FTP');
  assert.equal(mine.host, '127.0.0.1');
  assert.equal(mine.port, '21');
  assert.equal(mine.username, ftpConfig.username);
  assert.equal(mine.active, 'Y');
  assert.equal(mine.createdAt, null); // 서버가 채우지 않는다 — 입력값이 없으면 null 그대로다.
  assertNoSecret(res, ftpSecret, apiSecret);

  record('receiver-config-list', 'success', {
    ...fromResponse(res, {
      values: { itemKeys: SAFE_KEYS.join(','), hasPassword: false, hasApiKey: false, createdAtNull: true },
    }),
    caseId: 'z-list',
  });
});

test('GET /api/receiver-config — 쿼리는 화이트리스트 컬럼 AND 동등 필터(밖의 키는 무시)', async () => {
  // 자기 픽스처 sourceId로 좁힌 개수만 단언한다(절대 개수 단언 금지 — decisions (6)).
  const bySource = await listConfigs('Z', { sourceId: ftpConfig.sourceId });
  assert.equal(bySource.status, 200);
  assert.equal(bySource.json.items.length, 1);
  assert.equal(bySource.json.items[0].id, ftpCreate.json.id);

  // AND 조합 — type이 어긋나면 빈 목록(200)이다.
  const andMiss = await listConfigs('Z', { sourceId: ftpConfig.sourceId, type: 'API' });
  assert.equal(andMiss.status, 200);
  assert.deepEqual(andMiss.json.items, []);

  // 화이트리스트 밖 키는 400이 아니라 무시된다.
  const ignored = await listConfigs('Z', { sourceId: ftpConfig.sourceId, notAColumn: 'zzz' });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.json.items.length, 1);
  assertNoSecret(bySource, ftpSecret, apiSecret);

  record('receiver-config-list', 'success', {
    ...fromResponse(bySource, { values: { mineCount: 1, andMismatchCount: 0, unknownKeyIgnored: true } }),
    caseId: 'z-filter',
  });
});

test('GET /api/receiver-config — 미인증 401 · 비-Z(R) 403', async () => {
  const noSession = await api('GET', '/api/receiver-config');
  assert.equal(noSession.status, 401);
  assert.deepEqual(noSession.json, { ok: false, reason: 'unauthenticated' });
  record('receiver-config-list', 'unauthenticated', { ...fromResponse(noSession), caseId: 'no-session' });

  const asReporter = await listConfigs('R');
  assert.equal(asReporter.status, 403);
  assert.deepEqual(asReporter.json, { ok: false, reason: 'forbidden' });
  record('receiver-config-list', 'forbidden', { ...fromResponse(asReporter), caseId: 'r-session' });
});

test('POST /api/receiver-config — 미인증 401 · 비-Z(R) 403이고 행이 생기지 않는다', async () => {
  const denied = { sourceId: unique('ct-denied'), type: 'FTP', name: unique('ct-denied'), active: 'Y' };

  const noSession = await api('POST', '/api/receiver-config', { body: denied });
  assert.equal(noSession.status, 401);
  assert.deepEqual(noSession.json, { ok: false, reason: 'unauthenticated' });
  record('receiver-config-create', 'unauthenticated', { ...fromResponse(noSession), caseId: 'no-session' });

  const asReporter = await api('POST', '/api/receiver-config', { sid: sid('R'), body: denied });
  assert.equal(asReporter.status, 403);
  assert.deepEqual(asReporter.json, { ok: false, reason: 'forbidden' });
  record('receiver-config-create', 'forbidden', { ...fromResponse(asReporter), caseId: 'r-session' });

  // 게이트가 모델 호출 자체를 막았는지 — 거부된 sourceId는 조회되지 않아야 한다.
  const check = await listConfigs('Z', { sourceId: denied.sourceId });
  assert.deepEqual(check.json.items, [], '거부된 요청이 설정 행을 만들었다');
});

test('DELETE /api/receiver-config/:id — 미인증 401 · 비-Z(R) 403이고 행이 남는다', async () => {
  // 게이트가 뚫려도 피해가 자기 픽스처에 머물도록 **자기 행 id**를 대상으로 시험한다.
  const target = `/api/receiver-config/${ftpCreate.json.id}`;

  const noSession = await api('DELETE', target);
  assert.equal(noSession.status, 401);
  assert.deepEqual(noSession.json, { ok: false, reason: 'unauthenticated' });
  record('receiver-config-delete', 'unauthenticated', { ...fromResponse(noSession), caseId: 'no-session' });

  const asReporter = await api('DELETE', target, { sid: sid('R') });
  assert.equal(asReporter.status, 403);
  assert.deepEqual(asReporter.json, { ok: false, reason: 'forbidden' });
  record('receiver-config-delete', 'forbidden', { ...fromResponse(asReporter), caseId: 'r-session' });

  const check = await listConfigs('Z', { id: ftpCreate.json.id });
  assert.equal(check.json.items.length, 1, '거부된 삭제 요청이 행을 지웠다');
});

test('DELETE /api/receiver-config/:id — Z는 자기 설정 행을 지운다(200 changes:1 · 목록에서 사라짐)', async () => {
  const res = await api('DELETE', `/api/receiver-config/${ftpCreate.json.id}`, { sid: sid('Z') });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['changes', 'ok']);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.changes, 1);

  const after = await listConfigs('Z', { id: ftpCreate.json.id });
  assert.deepEqual(after.json.items, [], '삭제한 설정이 목록에 남아 있다');

  record('receiver-config-delete', 'success', {
    ...fromResponse(res, { values: { changes: 1, goneFromList: true } }),
    caseId: 'z-delete-own',
  });
});

test('DELETE /api/receiver-config/:id — 같은 id 재삭제는 멱등 200 {ok:true,changes:0}(404 아님)', async () => {
  const res = await api('DELETE', `/api/receiver-config/${ftpCreate.json.id}`, { sid: sid('Z') });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.changes, 0); // 존재 판정을 하지 않는다 — 대상 없음이 changes로만 드러난다.

  record('receiver-config-delete', 'not-found', {
    ...fromResponse(res, { values: { changes: 0 } }),
    caseId: 'repeat-idempotent',
  });
});

test('DELETE /api/receiver-config/abc — 숫자가 아닌 id는 Number() NaN으로 넘어간다', async () => {
  const res = await api('DELETE', '/api/receiver-config/abc', { sid: sid('Z') });

  // 라우트가 Number(req.params.id)로 NaN을 만들어 서비스에 넘긴다 — 그 결과 자체가 계약이다.
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.changes, 0);

  record('receiver-config-delete', 'not-found', {
    ...fromResponse(res, { values: { changes: 0, idParsedAs: 'NaN' } }),
    caseId: 'nan-id',
  });
});

test('회수: 이 파일이 만든 나머지 설정 행(API)을 지운다', async () => {
  const res = await api('DELETE', `/api/receiver-config/${apiCreate.json.id}`, { sid: sid('Z') });

  assert.equal(res.status, 200);
  assert.equal(res.json.changes, 1);

  const after = await listConfigs('Z', { sourceId: apiConfig.sourceId });
  assert.deepEqual(after.json.items, []);

  record('receiver-config-delete', 'success', {
    ...fromResponse(res, { values: { changes: 1, goneFromList: true } }),
    caseId: 'cleanup-api',
  });
});
