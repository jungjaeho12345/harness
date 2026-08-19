// 계약 케이스: 배부 실행/복구 3 라우트 — POST /api/distribution/tick(distribution-tick) ·
// GET /api/distribution/failures(distribution-failures) · POST /api/distribution/retry(distribution-retry).
// default 프로파일.
// 계약 축(ADR-008):
//  (1) 3 라우트 전부 **Z 전용** — 미인증 401 · 비-Z 403(R도 D도 안 된다).
//  (2) tick은 **body를 읽지 않는다** — role·시각·대상 목록을 클라가 주입해도 판정이 바뀌지 않는다(ADR-004).
//      부수효과 라우트라 **GET으로 열려 있지 않다**(404 — 프리페치/크롤러가 배부를 트리거하면 안 된다).
//  (3) 앱에 타이머가 없다 — 배부 실행은 외부 cron의 tick pull뿐이고, 이 스위트는 egress를 만들지 않는다.
//  (4) tick 응답에 **서버 파일시스템 경로가 실리지 않는다**(spoolDir·스풀 루트·.json 파일명) —
//      tick 서비스의 화이트리스트 투영이 transport까지 유지되는지가 계약이다.
//  (5) 배부 멱등의 근거는 append-only 이력이다 — 같은 기사가 두 번 배부되지 않는다.
//
// 예측(코드 정독 → 실행 전 기록, decisions (16)):
//  - 인가: 미인증 401 unauthenticated · R/D 403 forbidden. tick은 인가가 스풀 설정 판정보다 **먼저**다.
//  - GET /api/distribution/tick → 핸들러 미등록 → 404(라우트 부재 관측이므로 x- 채널에 기록).
//  - tick 성공 → 200 {ok,at,scanned,distributed,failed,invalid} 정확 6키. distributed 원소는
//    {articleId,kinds,status} 3키. body를 넣어도 같은 키 집합이고 at은 서버 시계다(주입한 2999년이 아니다).
//  - 실배부: embargoAt이 과거인 기사를 D가 송고하면 status=DES(엠바고 배부 대기, 즉시 배부 없음) →
//    Z tick → distributed에 {kinds:['press'],status:'DPS'} · 되읽으면 distributedAt이 채워진다.
//  - 멱등: 같은 조건 재실행 → 그 기사는 distributed에 없다(이력 기준).
//  - failures → 200 {ok:true,items:[...]}. limit은 서비스가 정규화·클램프한다(abc=NaN·-1 → 기본값,
//    1 → 1건 창) — 어떤 값이든 400이 아니라 200이다.
//  - retry: 식별자는 historyId 하나뿐 → 없는 id·누락·문자열 전부 404 no-failure(전역 스캔 봉쇄).
//
// 미동결(excluded (f)): 실패 원장이 **있는** 상태의 failures 목록/재전송 성공·409 4종(status-changed·
//   kind-changed·stale-cycle·retry-in-flight)·500 3종(spool-write-failed·invalid-spool-dir·
//   invalid-article-id). 스풀 쓰기 실패를 API만으로 결정적으로 만들 수 없다(수신처 CRUD가 잘못된
//   spoolDir를 애초에 거부한다). 그 축은 기존 backend 테스트(test/distribution-failure-api.test.js)가 소유한다.
//   서버·파일시스템 권한을 조작해 실패를 유도하지 않는다 — 환경 의존이라 Spring 대상에서 재현되지 않는다.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { sid } from '../../lib/session.js';
import { unique, createArticle } from '../../lib/fixtures.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';

requireProfile('default');

const TICK_KEYS = ['at', 'distributed', 'failed', 'invalid', 'ok', 'scanned'];
const DISTRIBUTED_ITEM_KEYS = ['articleId', 'kinds', 'status'];
// distributionRetryService.list()의 투영 키(정렬) — 목록이 비어 있으면 확인할 수 없으므로
// "원소가 있을 때만" 대조한다(빈 배열도 계약이다 — excluded (f)).
const FAILURE_ITEM_KEYS = [
  'articleId', 'failedAt', 'historyId', 'kind', 'kindDistributed',
  'reason', 'targetActive', 'targetId', 'targetKind', 'targetName',
];

// 미해소 실패 행이 아닌 historyId — 어떤 대상 서버에서도 매치되지 않도록 충분히 큰 값을 쓴다.
const ABSENT_HISTORY_ID = 999999999;

const tick = (opts = {}) => api('POST', '/api/distribution/tick', opts);
const failures = (role, query) => api('GET', '/api/distribution/failures', { sid: sid(role), query });
const retry = (role, body) => api('POST', '/api/distribution/retry', { sid: sid(role), body });

const pressSpool = unique('ct-tick');
let target;          // 이 파일이 만든 활성 press 수신처(마지막에 반드시 비활성화한다).
let due;             // 엠바고가 이미 도래한 기사 { articleId }
let firstTick;       // 실배부 tick 응답(멱등 케이스의 순서 의존을 명시적으로 만든다)

// tick 응답에 서버 파일시스템 경로가 새지 않았는지 — 응답 전체 문자열을 훑는다.
// 실패 메시지에 경로·슬러그 원문을 넣지 않는다(LOGS.md 마스킹 규율).
function assertNoSpoolPath(res) {
  const raw = JSON.stringify(res.json ?? res.text ?? null);
  assert.equal(raw.includes('spoolDir'), false, '응답에 spoolDir 키가 실렸다');
  assert.equal(raw.includes(pressSpool), false, '응답에 수신처 폴더 슬러그가 실렸다');
  assert.equal(raw.includes('.json'), false, '응답에 스풀 파일명이 실렸다');
  assert.equal(/[\\/]/.test(raw), false, '응답에 경로 구분자가 실렸다');
}

async function createTargetFixture() {
  const res = await api('POST', '/api/distribution-targets', {
    sid: sid('Z'), body: { name: unique('contract-tick-target'), kind: 'press', spoolDir: pressSpool },
  });
  if (res.status !== 200 || res.json?.ok !== true || !Number.isInteger(res.json.id)) {
    throw new Error(`픽스처 실패 createTarget: status=${res.status} reason=${res.json?.reason ?? '-'}`);
  }
  return { id: res.json.id };
}

// 조건 대기(고정 sleep 금지 — decisions (9)). 비동기 승격 가능성 때문에 되읽기는 폴링으로 한다.
async function pollContents(articleId, predicate, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const res = await api('GET', `/api/articles/${articleId}`, { sid: sid('Z') });
    lastStatus = res.status;
    if (res.status === 200 && predicate(res.json.contents)) return res.json.contents;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`조건 대기 시간 초과(${what}): 마지막 status=${lastStatus}, 한도=${timeoutMs}ms`);
}

before(async () => {
  target = await createTargetFixture();
});

// 안전망 — 어떤 케이스가 실패해도 이 파일의 수신처는 비활성으로 남는다(뒤 케이스의 예상치 못한 배부 방지).
after(async () => {
  if (target?.id !== undefined) await api('POST', `/api/distribution-targets/${target.id}/deactivate`, { sid: sid('Z') });
});

test('tick · failures · retry — 미인증 401 · R 403 · D 403(D도 안 된다)', async () => {
  const routes = [
    ['distribution-tick', () => tick(), (role) => tick({ sid: sid(role), body: { role: 'Z' } })],
    ['distribution-failures', () => api('GET', '/api/distribution/failures'), (role) => failures(role)],
    [
      'distribution-retry',
      () => api('POST', '/api/distribution/retry', { body: { historyId: ABSENT_HISTORY_ID } }),
      (role) => retry(role, { historyId: ABSENT_HISTORY_ID, role: 'Z' }),
    ],
  ];

  for (const [routeId, anonCall, roleCall] of routes) {
    const noSession = await anonCall();
    assert.equal(noSession.status, 401, `${routeId} 미인증 상태`);
    assert.deepEqual(noSession.json, { ok: false, reason: 'unauthenticated' });
    record(routeId, 'unauthenticated', { ...fromResponse(noSession), caseId: 'no-session' });

    for (const role of ['R', 'D']) {
      // body의 role:'Z' 스푸핑은 통하지 않는다 — acting role은 검증된 세션에서만 도출된다(ADR-004).
      const denied = await roleCall(role);
      assert.equal(denied.status, 403, `${routeId} ${role} 세션 상태`);
      assert.deepEqual(denied.json, { ok: false, reason: 'forbidden' });
      record(routeId, 'forbidden', { ...fromResponse(denied), caseId: role === 'R' ? 'r-session' : 'd-session' });
    }
  }
});

test('GET /api/distribution/tick — 부수효과 라우트를 GET으로 열지 않는다(404)', async () => {
  const res = await api('GET', '/api/distribution/tick', { sid: sid('Z') });

  assert.equal(res.status, 404);
  assert.equal(res.json?.ok, undefined, 'GET에 성공 응답이 있어서는 안 된다');

  // 인벤토리에 없는 (메서드, 경로) 조합의 관측 → x- 채널(커버리지 집계 제외 — decisions (23)).
  record('x-distribution-tick-get', 'not-found', {
    ...fromResponse(res, { values: { jsonBody: false } }),
    caseId: 'method-not-exposed',
  });
});

test('POST /api/distribution/tick — Z는 body 없이 호출하고 요약 6키를 받는다', async () => {
  const res = await tick({ sid: sid('Z') });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), TICK_KEYS);
  assert.equal(res.json.ok, true);
  assert.equal(typeof res.json.at, 'string');
  assert.ok(Number.isInteger(res.json.scanned) && res.json.scanned >= 0);
  assert.ok(Array.isArray(res.json.distributed), 'distributed는 배열이다');
  assert.ok(Array.isArray(res.json.failed));
  assert.ok(Array.isArray(res.json.invalid));
  assertNoSpoolPath(res);

  record('distribution-tick', 'success', {
    ...fromResponse(res, { values: { bodyOmitted: true, distributedIsArray: true, noSpoolPath: true } }),
    caseId: 'z-empty-run',
  });
});

test('POST /api/distribution/tick — body는 읽히지 않는다(주입이 통하지 않는다는 음성 증거)', async () => {
  // 시각·대상 목록·기사 식별자·role을 주입한다 — 하나라도 통하면 엠바고가 무력화된다(ADR-004).
  const injected = {
    role: 'Z',
    now: '2999-01-01T00:00:00.000Z',
    targets: [{ id: target.id, spoolDir: pressSpool, kind: 'press' }],
    articleId: 'AKR299901010000000001',
    kinds: ['press', 'nonpress'],
  };
  const res = await tick({ sid: sid('Z'), body: injected });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), TICK_KEYS, '주입 body가 응답 shape을 바꿨다');
  assert.equal(res.json.ok, true);
  assert.equal(res.json.at.startsWith('2999'), false, '주입한 시각이 서버 시계를 대체했다(엠바고 무력화)');
  assert.equal(
    res.json.distributed.some((d) => d.articleId === injected.articleId), false,
    '주입한 articleId가 배부됐다',
  );
  assertNoSpoolPath(res);

  record('distribution-tick', 'success', {
    ...fromResponse(res, { values: { bodyIgnored: true, injectedClockRejected: true, noSpoolPath: true } }),
    caseId: 'z-body-ignored',
  });
});

test('POST /api/distribution/tick — 도래한 엠바고 기사를 배부하고 distributedAt을 남긴다', async () => {
  // (a) 활성 press 수신처는 before가 만들었다. (b) 엠바고가 이미 도래한 기사를 D가 송고한다.
  const embargoAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1시간 전 — 이미 도래.
  due = await createArticle('D', { embargoAt });
  const sent = await api('POST', `/api/articles/${due.articleId}/action`, { sid: sid('D'), body: { action: 'send' } });
  assert.equal(sent.status, 200);
  // 엠바고가 설정된 기사는 송고 즉시 배부되지 않는다 — DES(배부 전 대기)로 진입한다.
  assert.equal(sent.json.status, 'DES', '엠바고 기사가 송고 즉시 완결(DPS)로 갔다 — 엠바고 누수');
  const beforeTick = await pollContents(due.articleId, (c) => c.status === 'DES', '송고 후 DES 진입');
  assert.equal(beforeTick.distributedAt ?? null, null, 'tick 전에 이미 배부 시각이 찍혀 있다');

  // (c) Z tick — 그 기사가 배부 요약에 나타난다.
  firstTick = await tick({ sid: sid('Z') });
  assert.equal(firstTick.status, 200);
  assert.ok(firstTick.json.scanned >= 1);
  const mine = firstTick.json.distributed.find((d) => d.articleId === due.articleId);
  assert.ok(mine, '도래한 엠바고 기사가 배부되지 않았다');
  assert.deepEqual(Object.keys(mine).sort(), DISTRIBUTED_ITEM_KEYS);
  assert.deepEqual(mine.kinds, ['press'], '1차 엠바고만 설정된 기사는 언론사(press)로만 나간다');
  assert.equal(mine.status, 'DPS', '필요한 kind가 전부 배부됐으므로 완결(DPS)');
  assertNoSpoolPath(firstTick);

  // (d) 되읽기는 폴링으로 — 상태 승격이 비동기일 가능성을 고정 sleep 없이 흡수한다.
  const after2 = await pollContents(
    due.articleId,
    (c) => c.status === 'DPS' && Boolean(c.distributedAt),
    '배부 후 distributedAt·status 승격',
  );
  assert.equal(after2.status, 'DPS');
  assert.equal(typeof after2.distributedAt, 'string');

  record('distribution-tick', 'success', {
    ...fromResponse(firstTick, {
      values: {
        distributedKinds: 'press', promotedStatus: 'DPS', distributedAtSet: true, noSpoolPath: true,
      },
    }),
    caseId: 'z-distribute-due',
  });
});

test('POST /api/distribution/tick — 이미 배부된 기사는 재배부되지 않는다(이력 기준 멱등)', async () => {
  // 순서 의존을 명시한다: 이 케이스는 바로 앞 케이스(z-distribute-due)의 산출물을 전제로 한다
  // (같은 파일·직렬 실행 — --test-concurrency=1). 단독 실행되면 여기서 즉시 실패한다.
  assert.ok(due && firstTick, '선행 케이스(도래 기사 배부)가 실행되지 않았다 — 같은 파일 안의 순서 의존');
  // 전제 재확인 — 이미 배부된 상태여야 멱등을 논할 수 있다.
  const before2 = await pollContents(due.articleId, (c) => Boolean(c.distributedAt), '멱등 케이스 전제(배부 완료)');
  assert.equal(before2.status, 'DPS');

  const second = await tick({ sid: sid('Z') });
  assert.equal(second.status, 200);
  assert.equal(
    second.json.distributed.some((d) => d.articleId === due.articleId), false,
    '같은 기사가 두 번 배부됐다 — 이력 기준 멱등이 깨졌다',
  );
  assertNoSpoolPath(second);

  const after2 = await pollContents(due.articleId, (c) => c.status === 'DPS', '재실행 후 상태 유지');
  assert.equal(after2.distributedAt, before2.distributedAt, '재배부 없이 배부 시각이 갱신됐다');

  record('distribution-tick', 'success', {
    ...fromResponse(second, { values: { redistributed: false, distributedAtStable: true, noSpoolPath: true } }),
    caseId: 'z-idempotent',
  });
});

test('GET /api/distribution/failures — Z 조회는 200 {ok,items}이고 limit은 서비스가 정규화한다', async () => {
  // 실패 원장을 API로 결정적으로 만들 수 없으므로(excluded (f)) 여기서 동결하는 것은
  // "빈 배열도 계약"인 shape과 limit 정규화·인가뿐이다. 개수는 단언하지 않는다(decisions (6)).
  const probes = [['z-list', undefined], ['limit-1', { limit: 1 }], ['limit-nan', { limit: 'abc' }], ['limit-negative', { limit: -1 }]];

  for (const [caseId, query] of probes) {
    const res = await failures('Z', query);
    assert.equal(res.status, 200, `${caseId} 상태 — limit 값이 무엇이든 400이 아니다`);
    assert.deepEqual(Object.keys(res.json).sort(), ['items', 'ok']);
    assert.equal(res.json.ok, true);
    assert.ok(Array.isArray(res.json.items), `${caseId} items는 배열이다`);
    for (const item of res.json.items) {
      assert.deepEqual(Object.keys(item).sort(), FAILURE_ITEM_KEYS, `${caseId} 항목 키 집합`);
    }

    record('distribution-failures', 'success', {
      ...fromResponse(res, { values: { itemsIsArray: true, itemKeysConform: true, limitAccepted: true } }),
      caseId,
    });
  }
});

test('POST /api/distribution/retry — 식별자는 historyId 하나뿐이고 미해소 실패가 없으면 404 no-failure', async () => {
  const probes = [
    ['absent-id', { historyId: ABSENT_HISTORY_ID }],
    ['missing-historyId', {}],
    ['string-historyId', { historyId: 'abc' }],
    // articleId·targetId·kind를 함께 보내도 서버는 historyId만 읽는다(나머지는 실패 행에서 도출 — ADR-004).
    ['extra-fields-ignored', { historyId: ABSENT_HISTORY_ID, articleId: 'AKR299901010000000001', targetId: 1, kind: 'press' }],
  ];

  for (const [caseId, body] of probes) {
    const res = await retry('Z', body);
    assert.equal(res.status, 404, `${caseId} 상태`);
    assert.deepEqual(res.json, { ok: false, reason: 'no-failure' }, `${caseId} 본문`);

    record('distribution-retry', 'not-found', {
      ...fromResponse(res, { values: { probe: caseId } }),
      caseId,
    });
  }
});

test('회수: 이 파일이 만든 수신처를 비활성화한다(뒤 케이스의 예상치 못한 배부 방지)', async () => {
  const res = await api('POST', `/api/distribution-targets/${target.id}/deactivate`, { sid: sid('Z') });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);

  const listed = await api('GET', '/api/distribution-targets', { sid: sid('Z'), query: { spoolDir: pressSpool } });
  assert.equal(listed.json.items.length, 1, '회수는 행 삭제가 아니다 — 행은 남는다');
  assert.equal(listed.json.items[0].active, 'N');
});
