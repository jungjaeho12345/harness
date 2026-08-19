// 계약 케이스: 배부 비활성 서버(DIST_SPOOL_DIR 미설정)의 계약 — minimal 프로파일.
// 계약 축(ADR-008):
//  (1) 스풀 루트가 설정되지 않은 서버에서 배부 **실행** 계열은 503 spool-disabled다
//      (POST /api/distribution/tick · POST /api/distribution/retry). 기본값을 하드코딩하지 않으므로
//      미구성 환경에서 의도치 않은 파일 쓰기가 생기지 않는다.
//  (2) 판정 **순서**는 인가 → 설정이다 — 비-Z에게는 403이지 503이 아니다(배부 설정 상태조차 알려주지 않는다).
//  (3) **조회는 스풀 설정과 무관하게 결선된다** — GET /api/distribution/failures는 200이다.
//  (4) 수신처 CRUD도 스풀 설정과 무관하다(대상 저장은 파일시스템을 건드리지 않는다).
//
// 예측(코드 정독 → 실행 전 기록, decisions (16)):
//  - Z tick → 503 {ok:false,reason:'spool-disabled'} (컨트롤러가 tick 서비스 미결선을 판정).
//  - Z retry(임의 historyId) → 503 {ok:false,reason:'spool-disabled'} — spoolWriter 부재가
//    no-failure(404)보다 **먼저** 판정된다(DB를 건드리지 않는다).
//  - R tick/retry → 403 forbidden(인가가 먼저다).
//  - Z failures → 200 {ok:true,items:[...]}.
//  - Z 수신처 생성 → 200 {ok:true,id}.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { sid } from '../../lib/session.js';
import { unique } from '../../lib/fixtures.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';

requireProfile('minimal');

const ABSENT_HISTORY_ID = 999999999;
const spoolDir = unique('ct-mini');

let created; // 이 파일이 만든 수신처 — 반드시 비활성으로 회수한다(행 삭제 경로는 없다).

after(async () => {
  if (created?.id !== undefined) {
    await api('POST', `/api/distribution-targets/${created.id}/deactivate`, { sid: sid('Z') });
  }
});

test('POST /api/distribution/tick — 스풀 미설정 서버는 Z에게 503 spool-disabled', async () => {
  const res = await api('POST', '/api/distribution/tick', { sid: sid('Z') });

  assert.equal(res.status, 503);
  assert.deepEqual(res.json, { ok: false, reason: 'spool-disabled' });

  record('distribution-tick', 'disabled', {
    ...fromResponse(res, { values: { spoolConfigured: false } }),
    caseId: 'z-spool-disabled',
  });
});

test('POST /api/distribution/retry — 스풀 미설정 서버는 Z에게 503 spool-disabled(404보다 먼저)', async () => {
  const res = await api('POST', '/api/distribution/retry', {
    sid: sid('Z'), body: { historyId: ABSENT_HISTORY_ID },
  });

  // 미해소 실패가 없는 historyId지만 no-failure(404)가 아니라 설정 판정이 이긴다 — DB를 건드리지 않는다.
  assert.equal(res.status, 503);
  assert.deepEqual(res.json, { ok: false, reason: 'spool-disabled' });

  record('distribution-retry', 'disabled', {
    ...fromResponse(res, { values: { spoolConfigured: false, beforeNoFailure: true } }),
    caseId: 'z-spool-disabled',
  });
});

test('인가가 설정 판정보다 먼저다 — 비-Z(R)에게는 503이 아니라 403이다', async () => {
  const probes = [
    ['distribution-tick', () => api('POST', '/api/distribution/tick', { sid: sid('R'), body: { role: 'Z' } })],
    [
      'distribution-retry',
      () => api('POST', '/api/distribution/retry', { sid: sid('R'), body: { historyId: ABSENT_HISTORY_ID, role: 'Z' } }),
    ],
  ];

  for (const [routeId, call] of probes) {
    const res = await call();
    assert.equal(res.status, 403, `${routeId} — 비-Z에게 배부 설정 상태를 알려주면 안 된다`);
    assert.deepEqual(res.json, { ok: false, reason: 'forbidden' });

    record(routeId, 'forbidden', {
      ...fromResponse(res, { values: { gateBeforeConfig: true } }),
      caseId: 'r-session-not-disabled',
    });
  }
});

test('GET /api/distribution/failures — 조회는 스풀 설정과 무관하게 결선된다(200)', async () => {
  const res = await api('GET', '/api/distribution/failures', { sid: sid('Z') });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['items', 'ok']);
  assert.equal(res.json.ok, true);
  assert.ok(Array.isArray(res.json.items));

  record('distribution-failures', 'success', {
    ...fromResponse(res, { values: { spoolConfigured: false, itemsIsArray: true } }),
    caseId: 'z-list-spool-disabled',
  });
});

test('POST /api/distribution-targets — 수신처 CRUD는 스풀 설정과 무관하다(200)', async () => {
  const res = await api('POST', '/api/distribution-targets', {
    sid: sid('Z'), body: { name: unique('contract-mini-target'), kind: 'press', spoolDir },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['id', 'ok']);
  assert.equal(res.json.ok, true);
  assert.ok(Number.isInteger(res.json.id) && res.json.id > 0);
  created = { id: res.json.id };

  record('distribution-targets-create', 'success', {
    ...fromResponse(res, { values: { spoolConfigured: false, idIsPositiveInteger: true } }),
    caseId: 'z-create-spool-disabled',
  });
});

test('회수: 만든 수신처를 비활성화한다(행 삭제 경로는 없다 — soft delete만)', async () => {
  assert.ok(created, '선행 케이스(수신처 생성)가 실행되지 않았다 — 같은 파일 안의 순서 의존');
  const res = await api('POST', `/api/distribution-targets/${created.id}/deactivate`, { sid: sid('Z') });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.changes, 1);

  const listed = await api('GET', '/api/distribution-targets', { sid: sid('Z'), query: { spoolDir } });
  assert.equal(listed.json.items.length, 1, '회수는 행 삭제가 아니다 — 행은 남는다');
  assert.equal(listed.json.items[0].active, 'N');

  record('distribution-targets-deactivate', 'success', {
    ...fromResponse(res, { values: { changes: 1, activeAfter: 'N', stillListed: true } }),
    caseId: 'z-deactivate-spool-disabled',
  });
});
