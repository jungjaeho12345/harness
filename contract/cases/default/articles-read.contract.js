// 계약 케이스: 기사 읽기 5 라우트 — default 프로파일.
//   #18 GET /api/articles/search (articles-search)
//   #19 GET /api/articles (articles-list)
//   #20 GET /api/articles/:id (articles-get)
//   #21 GET /api/articles/:id/history (articles-history)
//   #22 GET /api/articles/:id/history/:historyId (articles-history-snapshot)
//
// 이 파일이 동결하는 계약 축:
//  (a) 응답 투영 — lockerSessionId·lockerClientId는 **어떤 응답에도 없다**(contentsProjection 단일 지점).
//      픽스처가 실제로 잠금을 보유한 상태(DB 컬럼에 세션 토큰 원문이 들어 있는 상태)에서 관측하므로
//      이 단언은 공허하지 않다 — 투영을 빼면 세션 토큰이 그대로 실린다.
//  (b) 필터 화이트리스트 FILTER_KEYS **13키**(계획서 부록 A의 '15키'는 드리프트 — 코드가 정본)와
//      반복 쿼리 키(?status=A&status=B) 문법. 콤마 표기는 **동작하지 않는다**(Spring 파리티 함정).
//  (c) 목록/검색 응답에 페이징·총수 필드가 없다는 '없음'의 계약.
//  (d) 이력은 append-only 원장의 읽기만 한다 — 이 파일은 이력 행을 지우거나 고치지 않는다.
//
// 규율: server/·src/ import 금지(CONTRACT_BASE_URL로만) · 절대 개수 단언 금지(고유 토큰으로 좁힌
//   자기 픽스처만) · 리포트 기록은 record 한 곳 · 로그인 직접 호출 없음(러너 세션 재사용).

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { actor, sid } from '../../lib/session.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';
import { unique, createArticle, acquireLock } from '../../lib/fixtures.js';

requireProfile('default');

// --- 실측 shape 상수(정렬된 키 목록) — 리포트에도 이 문자열을 실어 Spring 대상 diff가 shape 드리프트를 잡는다.
// Contents 29컬럼 − 투영 2컬럼(lockerSessionId·lockerClientId) = 27키.
const CONTENTS_ROW_KEYS = 'articleId,attachmentFile,attribute,author,category,coAuthor,content,createdAt,'
  + 'department,departmentCode,distributedAt,editedAt,embargoAt,externalComment,internalComment,keyword,'
  + 'lockYN,lockedAt,lockerUserId,modifier,referenceFile,region,secondEmbargoAt,sender,sentAt,status,title';
// 검색은 Article 테이블 행이다(목록의 Contents 행과 동형이 아니다 — 본문 markupVersion이 실린다).
const ARTICLE_ROW_KEYS = 'articleId,content,markupVersion,modifier,title';
// 이력 목록 행 = 모델 8컬럼 + hasSnapshot + 파생 3키(title·version·status). markupVersion·snapshotTitle 부재.
const HISTORY_ROW_KEYS = 'action,actorUserId,articleId,createdAt,eventType,fromStatus,hasSnapshot,id,'
  + 'status,title,toStatus,version';
// 단건 스냅샷 item = 7키(fromStatus·toStatus·hasSnapshot 없음, 본문 markupVersion 있음).
const SNAPSHOT_ITEM_KEYS = 'action,actorUserId,articleId,createdAt,eventType,id,markupVersion';

// 날짜 범위 필터용 경계 — 실제 데이터 시각을 모른 채 결정적으로 판정하기 위한 사전식 경계값.
const FAR_PAST = '2000-01-01T00:00:00.000Z';
const FAR_FUTURE = '2999-12-31T23:59:59.999Z';

const keysOf = (obj) => Object.keys(obj ?? {}).sort().join(',');
const idsOf = (items) => items.map((r) => r.articleId);
const has = (items, articleId) => idsOf(items).includes(articleId);

// 투영 계약의 강화 검사 — 키 집합 비교만으로는 중첩 객체를 놓친다. 응답 JSON 전체를 문자열로 훑는다.
// 세션 토큰 원문(러너가 준 R/D/Z 3종)이 응답 어디에도 없어야 한다(값 자체는 리포트·메시지에 담지 않는다).
function assertNoLockerLeak(res, label) {
  const serialized = JSON.stringify(res.json ?? null);
  assert.ok(!serialized.includes('lockerSessionId'), `${label}: 응답에 lockerSessionId가 등장한다`);
  assert.ok(!serialized.includes('lockerClientId'), `${label}: 응답에 lockerClientId가 등장한다`);
  for (const role of ['R', 'D', 'Z']) {
    assert.ok(!serialized.includes(sid(role)), `${label}: 응답에 ${role} 세션 토큰 원문이 등장한다`);
  }
}

// 목록 조회 헬퍼 — 항상 투영 검사를 통과시킨 뒤 items를 돌려준다.
async function list(role, query, label) {
  const res = await api('GET', '/api/articles', { sid: sid(role), query });
  assert.equal(res.status, 200, `${label}: 200이어야 한다`);
  assert.equal(res.json?.ok, true, `${label}: ok=true여야 한다`);
  assert.ok(Array.isArray(res.json.items), `${label}: items 배열이어야 한다`);
  assertNoLockerLeak(res, label);
  return { res, items: res.json.items };
}

// 픽스처(실행마다 고유 토큰) — A: RDS 유지 / B: 다른 작성자·부서(R 작성) / C: 편집 스냅샷 + 송고.
const TOKEN = unique('ctread');
const fx = {};

test('픽스처 준비 — 기사 3건을 API로 생성하고 C에 편집 스냅샷·송고 이력을 남긴다', async () => {
  fx.deptA = unique('ct-dept-a');
  fx.deptB = unique('ct-dept-b');
  fx.deptC = unique('ct-dept-c');
  fx.authorA = unique('ct-author-a');
  fx.authorB = unique('ct-author-b');
  fx.authorC = unique('ct-author-c');
  fx.editMark = unique('ct-edit');

  fx.a = await createArticle('D', {
    title: `${TOKEN} A`, author: fx.authorA, department: fx.deptA, departmentCode: 'CT-A',
  });
  fx.b = await createArticle('R', {
    title: `${TOKEN} B`, author: fx.authorB, department: fx.deptB, departmentCode: 'CT-B',
  });
  fx.c = await createArticle('D', {
    title: `${TOKEN} C`, author: fx.authorC, department: fx.deptC, departmentCode: 'CT-C',
  });

  // C: 편집 잠금 획득 → PUT 저장(= edit 이력 + 본문 스냅샷) → 송고(= status/send 이력).
  // 잠금은 일부러 해제하지 않는다 — 잠금 보유 상태의 행에서 투영을 관측하기 위함이다.
  fx.clientId = unique('ct-tab');
  await acquireLock(fx.c.articleId, 'D', fx.clientId);
  fx.editBody = JSON.stringify({
    format: 'yh-editor',
    version: 1,
    blocks: [{ type: 'text', text: fx.editMark }, { type: 'text', text: '(끝)' }],
  });
  const put = await api('PUT', `/api/articles/${fx.c.articleId}`, {
    sid: sid('D'), headers: { 'x-edit-client': fx.clientId }, body: { markupVersion: fx.editBody },
  });
  assert.equal(put.status, 200, '픽스처: PUT 저장 200');
  assert.equal(put.json?.ok, true, '픽스처: PUT 저장 ok');

  const send = await api('POST', `/api/articles/${fx.c.articleId}/action`, {
    sid: sid('D'), body: { action: 'send' },
  });
  assert.equal(send.status, 200, '픽스처: 송고 200');
  assert.equal(send.json?.status, 'DPS', '픽스처: 무엠바고 송고는 DPS');
  // 송고자(sender)는 서버가 세션 userId로 stamp한다 — sender 필터의 기대값 출처(비밀 아님).
  fx.senderUserId = actor('D').userId;
});

// --- 1. 인가: 5 라우트 전부 미인증 401 ---

test('미인증 — 읽기 5 라우트 전부 401 unauthenticated', async () => {
  const cases = [
    ['articles-search', '/api/articles/search?q=x', 'search'],
    ['articles-list', '/api/articles', 'list'],
    ['articles-get', `/api/articles/${fx.a.articleId}`, 'get'],
    ['articles-history', `/api/articles/${fx.a.articleId}/history`, 'history'],
    ['articles-history-snapshot', `/api/articles/${fx.a.articleId}/history/1`, 'snapshot'],
  ];
  for (const [routeId, path, caseId] of cases) {
    const res = await api('GET', path);
    assert.equal(res.status, 401, `${caseId}: 미인증은 401`);
    assert.deepEqual(res.json, { ok: false, reason: 'unauthenticated' }, `${caseId}: 본문 고정`);
    record(routeId, 'unauthenticated', { ...fromResponse(res), caseId });
  }
});

// --- 2. GET /api/articles 기본 shape ---

test('GET /api/articles — 200 {ok,items} · 행 27키 · 잠금 2컬럼 부재 · 페이징 필드 없음', async () => {
  const { res, items } = await list('R', undefined, 'list-plain');
  assert.deepEqual(Object.keys(res.json).sort(), ['items', 'ok'], '응답은 ok/items 2키뿐(총수·페이징 없음)');

  const mine = items.filter((r) => [fx.a.articleId, fx.b.articleId, fx.c.articleId].includes(r.articleId));
  assert.equal(mine.length, 3, '자기 픽스처 3건이 기본 목록에 있다');
  for (const row of mine) assert.equal(keysOf(row), CONTENTS_ROW_KEYS, '행 키 집합 = Contents 27키(투영 후)');

  // 목록 UI가 소비하는 키가 실제로 있는지(부재하면 화면이 빈다) — 값이 아니라 존재만 본다.
  const consumed = ['articleId', 'title', 'author', 'modifier', 'department', 'departmentCode',
    'createdAt', 'editedAt', 'sentAt', 'distributedAt', 'status', 'lockYN'];
  for (const key of consumed) {
    assert.ok(Object.hasOwn(mine[0], key), `목록 소비 키 ${key}가 있어야 한다`);
  }

  record('articles-list', 'success', {
    ...fromResponse(res, { values: { rowKeys: CONTENTS_ROW_KEYS, mineCount: mine.length } }),
    caseId: 'plain',
  });
});

test('GET /api/articles — 잠금 보유 행도 lockYN·lockerUserId만 싣고 세션 토큰·탭 식별자는 없다', async () => {
  const { res, items } = await list('R', { articleId: fx.c.articleId }, 'list-locked-row');
  assert.equal(items.length, 1, 'articleId 필터는 정확히 그 기사만 돌려준다');
  const row = items[0];
  assert.equal(row.lockYN, 'Y', '픽스처 C는 잠금 보유 상태다(투영 단언이 공허하지 않다)');
  assert.ok(row.lockerUserId, 'lockerUserId는 잠금 표시 계약이라 남는다');
  assert.equal(Object.hasOwn(row, 'lockerSessionId'), false, 'lockerSessionId 키 자체가 없다');
  assert.equal(Object.hasOwn(row, 'lockerClientId'), false, 'lockerClientId 키 자체가 없다');

  record('articles-list', 'success', {
    ...fromResponse(res, {
      values: {
        lockYN: row.lockYN, hasLockerUserId: true,
        hasLockerSessionId: Object.hasOwn(row, 'lockerSessionId'),
        hasLockerClientId: Object.hasOwn(row, 'lockerClientId'),
      },
    }),
    caseId: 'locked-row-projection',
  });
});

// --- 3. 반복 쿼리 키와 status 필터(양성 + 음성) ---

test('GET /api/articles — 반복 키 ?status=RDS&status=DDH는 IN, ?status=DPS는 RDS 픽스처를 뺀다', async () => {
  const both = await list('D', { status: ['RDS', 'DDH'] }, 'list-status-repeat');
  assert.ok(has(both.items, fx.a.articleId), 'RDS 픽스처 A가 포함된다');
  assert.ok(!has(both.items, fx.c.articleId), '송고된 DPS 픽스처 C는 빠진다');
  record('articles-list', 'success', {
    ...fromResponse(both.res, { values: { hasRdsFixture: true, hasDpsFixture: false } }),
    caseId: 'status-repeated-key',
  });

  const dps = await list('D', { status: 'DPS' }, 'list-status-dps');
  assert.ok(!has(dps.items, fx.a.articleId), 'RDS 픽스처 A가 빠진다(필터가 실제로 동작한다)');
  assert.ok(has(dps.items, fx.c.articleId), 'DPS 픽스처 C는 포함된다');
  record('articles-list', 'success', {
    ...fromResponse(dps.res, { values: { hasRdsFixture: false, hasDpsFixture: true } }),
    caseId: 'status-single',
  });
});

test('GET /api/articles — 콤마 표기 ?status=RDS,DDH는 배열이 아니다(단일 문자열 → 매칭 없음)', async () => {
  const { res, items } = await list('D', { status: 'RDS,DDH' }, 'list-status-comma');
  assert.ok(!has(items, fx.a.articleId), '콤마 표기는 반복 키의 대체 문법이 아니다 — RDS 픽스처도 안 잡힌다');
  record('articles-list', 'success', {
    ...fromResponse(res, { values: { commaSplit: false, hasRdsFixture: false } }),
    caseId: 'status-comma-not-split',
  });
});

test('GET /api/articles — excludeStatus는 NOT IN', async () => {
  const noRds = await list('D', { excludeStatus: 'RDS' }, 'list-exclude-rds');
  assert.ok(!has(noRds.items, fx.a.articleId), 'RDS 픽스처가 제외된다');
  assert.ok(has(noRds.items, fx.c.articleId), 'DPS 픽스처는 남는다');
  record('articles-list', 'success', {
    ...fromResponse(noRds.res, { values: { hasRdsFixture: false, hasDpsFixture: true } }),
    caseId: 'exclude-status',
  });

  const noDps = await list('D', { excludeStatus: ['DPS', 'DDH'] }, 'list-exclude-repeat');
  assert.ok(has(noDps.items, fx.a.articleId), 'RDS 픽스처는 남는다');
  assert.ok(!has(noDps.items, fx.c.articleId), 'DPS 픽스처가 제외된다(반복 키 NOT IN)');
  record('articles-list', 'success', {
    ...fromResponse(noDps.res, { values: { hasRdsFixture: true, hasDpsFixture: false } }),
    caseId: 'exclude-status-repeated-key',
  });
});

test('GET /api/articles — department 단일 · departments 반복 · departments 우선', async () => {
  const single = await list('D', { department: fx.deptA }, 'list-department');
  assert.deepEqual(idsOf(single.items), [fx.a.articleId], 'department=A는 A만');
  record('articles-list', 'success', {
    ...fromResponse(single.res, { values: { hasA: true, hasB: false } }),
    caseId: 'department-single',
  });

  const multi = await list('D', { departments: [fx.deptA, fx.deptB] }, 'list-departments');
  assert.deepEqual(idsOf(multi.items).sort(), [fx.a.articleId, fx.b.articleId].sort(), 'departments 반복 키는 IN');
  record('articles-list', 'success', {
    ...fromResponse(multi.res, { values: { hasA: true, hasB: true } }),
    caseId: 'departments-repeated-key',
  });

  // 둘 다 주면 departments가 이긴다(department는 무시된다 — 모델의 우선순위 규칙).
  const both = await list('D', { department: fx.deptA, departments: fx.deptB }, 'list-departments-precedence');
  assert.deepEqual(idsOf(both.items), [fx.b.articleId], 'departments가 department를 덮어쓴다');
  record('articles-list', 'success', {
    ...fromResponse(both.res, { values: { hasA: false, hasB: true, departmentsWins: true } }),
    caseId: 'departments-precedence',
  });
});

// 배열을 받을 수 있는 키는 status·excludeStatus·departments 3종뿐이다. 스칼라 전용 키(articleId·author·
// sender·department·날짜)를 반복하면 배열이 SQL 바인딩으로 내려가 **500 internal-error**가 난다.
// 결함 후보로 기록한다(decisions (2) — 이 phase는 서버를 고치지 않는다). 인벤토리 밖 관측이므로
// routeId는 x- 접두사를 써서 커버리지 집계에서 제외한다(decisions (23)).
// 68+ 대상이 400을 준다면 이 케이스는 red가 된다 — 그때 '버그 패리티를 맞출지'를 사람이 판정하라.
test('GET /api/articles — 스칼라 전용 필터 키를 반복하면 500 internal-error(실측 · 결함 후보)', async () => {
  const res = await api('GET', '/api/articles', { sid: sid('D'), query: { department: [fx.deptA, fx.deptB] } });
  assert.equal(res.status, 500, '반복 department는 배열 필터가 아니라 서버 오류로 떨어진다');
  assert.deepEqual(res.json, { ok: false, reason: 'internal-error' }, '전역 에러 핸들러의 고정 본문');
  record('x-articles-list-repeated-scalar-key', 'server-error', {
    ...fromResponse(res, { values: { key: 'department', arrayCapableKeys: 'departments,excludeStatus,status' } }),
    caseId: 'repeated-department',
  });
});

test('GET /api/articles — author · articleId · sender 필터', async () => {
  const byAuthor = await list('D', { author: fx.authorA }, 'list-author');
  assert.deepEqual(idsOf(byAuthor.items), [fx.a.articleId], 'author=A는 A만(B는 빠진다)');
  record('articles-list', 'success', {
    ...fromResponse(byAuthor.res, { values: { hasA: true, hasB: false } }),
    caseId: 'author',
  });

  const byId = await list('D', { articleId: fx.b.articleId }, 'list-article-id');
  assert.deepEqual(idsOf(byId.items), [fx.b.articleId], 'articleId 필터는 그 한 건만');
  record('articles-list', 'success', {
    ...fromResponse(byId.res, { values: { hasA: false, hasB: true } }),
    caseId: 'article-id',
  });

  // sender는 송고 시 서버가 세션 userId로 stamp한다 — 미송고 픽스처(A)는 NULL이라 어떤 sender 값에도 안 걸린다.
  const senderId = fx.senderUserId;
  const bySender = await list('D', { sender: senderId, articleId: fx.c.articleId }, 'list-sender');
  assert.deepEqual(idsOf(bySender.items), [fx.c.articleId], '송고자 필터로 C가 잡힌다');
  const bogusSender = await list('D', { sender: unique('ct-nosuch') }, 'list-sender-negative');
  assert.ok(!has(bogusSender.items, fx.c.articleId), '없는 송고자로는 C가 안 잡힌다');
  record('articles-list', 'success', {
    ...fromResponse(bySender.res, { values: { hasSentFixture: true, bogusSenderMatches: false } }),
    caseId: 'sender',
  });
});

test('GET /api/articles — createdAt/sentAt/distributedAt 범위(NULL 값 행은 범위 필터에서 탈락)', async () => {
  const inRange = await list('D', {
    articleId: fx.a.articleId, createdAtFrom: FAR_PAST, createdAtTo: FAR_FUTURE,
  }, 'list-created-range');
  assert.deepEqual(idsOf(inRange.items), [fx.a.articleId], 'createdAt 범위 안이면 잡힌다');

  const outOfRange = await list('D', { articleId: fx.a.articleId, createdAtFrom: FAR_FUTURE }, 'list-created-out');
  assert.deepEqual(idsOf(outOfRange.items), [], 'createdAtFrom이 미래면 빠진다');
  record('articles-list', 'success', {
    ...fromResponse(inRange.res, { values: { inRange: true, outOfRangeEmpty: true } }),
    caseId: 'created-at-range',
  });

  const sent = await list('D', { sentAtFrom: FAR_PAST, articleId: fx.c.articleId }, 'list-sent-range');
  assert.deepEqual(idsOf(sent.items), [fx.c.articleId], '송고된 C는 sentAt 범위에 잡힌다');
  const unsent = await list('D', { sentAtFrom: FAR_PAST, articleId: fx.a.articleId }, 'list-sent-null');
  assert.deepEqual(idsOf(unsent.items), [], 'sentAt이 NULL인 A는 범위 필터에서 탈락한다');
  record('articles-list', 'success', {
    ...fromResponse(sent.res, { values: { sentFixtureMatched: true, nullSentAtDropped: true } }),
    caseId: 'sent-at-range',
  });

  // A는 한 번도 송고되지 않았으므로 distributedAt은 반드시 NULL이다(사전 존재 수신처와 무관하게 결정적).
  const distFrom = await list('D', { articleId: fx.a.articleId, distributedAtFrom: FAR_PAST }, 'list-dist-from');
  assert.deepEqual(idsOf(distFrom.items), [], 'distributedAt이 NULL인 행은 From 범위에서 탈락');
  const distTo = await list('D', { articleId: fx.a.articleId, distributedAtTo: FAR_FUTURE }, 'list-dist-to');
  assert.deepEqual(idsOf(distTo.items), [], 'distributedAt이 NULL인 행은 To 범위에서도 탈락');
  record('articles-list', 'success', {
    ...fromResponse(distFrom.res, { values: { nullDistributedAtDroppedFrom: true, nullDistributedAtDroppedTo: true } }),
    caseId: 'distributed-at-range',
  });
});

test('GET /api/articles — FILTER_KEYS 13키 전수 동시 사용 · 그중 11키 동시 양성', async () => {
  const all13 = {
    articleId: fx.c.articleId,
    author: fx.authorC,
    sender: fx.senderUserId,
    status: 'DPS',
    excludeStatus: 'RDS',
    department: fx.deptC,
    departments: fx.deptC,
    createdAtFrom: FAR_PAST,
    createdAtTo: FAR_FUTURE,
    sentAtFrom: FAR_PAST,
    sentAtTo: FAR_FUTURE,
    distributedAtFrom: FAR_PAST,
    distributedAtTo: FAR_FUTURE,
  };
  assert.equal(Object.keys(all13).length, 13, 'FILTER_KEYS는 13키다(계획서 부록 A의 15키는 드리프트)');

  // 13키 전수: 400이 아니라 200이어야 한다(distributedAt은 배부 여부에 달려 있어 멤버십은 단언하지 않는다).
  const full = await list('D', all13, 'list-all-13-keys');
  record('articles-list', 'success', {
    ...fromResponse(full.res, { values: { filterKeyCount: 13, status200: true } }),
    caseId: 'all-13-filter-keys',
  });

  // 배부 축 2키를 뺀 11키는 동시에 양성이어야 한다 — 나머지 키가 조용히 무시되지 않았다는 증거.
  const eleven = { ...all13 };
  delete eleven.distributedAtFrom;
  delete eleven.distributedAtTo;
  const positive = await list('D', eleven, 'list-11-keys-positive');
  assert.deepEqual(idsOf(positive.items), [fx.c.articleId], '11키 동시 적용에도 C가 잡힌다');
  record('articles-list', 'success', {
    ...fromResponse(positive.res, { values: { filterKeyCount: 11, matchedFixture: true } }),
    caseId: 'eleven-filter-keys-positive',
  });
});

test('GET /api/articles — 화이트리스트 밖 쿼리 키는 무시된다(에러 아님)', async () => {
  const plain = await list('D', { status: 'RDS' }, 'list-whitelist-baseline');
  const withBogus = await list('D', { bogusKey: '1', limit: '1', q: 'x', status: 'RDS' }, 'list-whitelist-bogus');
  assert.equal(withBogus.res.status, 200, '알 수 없는 키에도 400이 아니라 200');
  assert.equal(has(plain.items, fx.a.articleId), true, '기준 질의에 A가 있다');
  assert.equal(has(withBogus.items, fx.a.articleId), true, '무시되므로 결과가 같다(A 포함)');
  assert.equal(has(withBogus.items, fx.c.articleId), false, '무시되므로 결과가 같다(C 제외)');
  record('articles-list', 'success', {
    ...fromResponse(withBogus.res, { values: { unknownKeysIgnored: true, hasA: true, hasC: false } }),
    caseId: 'unknown-keys-ignored',
  });
});

test('GET /api/articles — 역할(R/D/Z) 무관하게 같은 목록을 받는다', async () => {
  const query = { departments: [fx.deptA, fx.deptB, fx.deptC] };
  const r = await list('R', query, 'list-role-R');
  const d = await list('D', query, 'list-role-D');
  const z = await list('Z', query, 'list-role-Z');
  const expected = [fx.a.articleId, fx.b.articleId, fx.c.articleId].sort();
  assert.deepEqual(idsOf(r.items).sort(), expected, 'R은 자기 부서 밖 기사도 본다(역할 필터 없음)');
  assert.deepEqual(idsOf(d.items).sort(), expected, 'D도 동일');
  assert.deepEqual(idsOf(z.items).sort(), expected, 'Z도 동일');
  assert.equal(keysOf(r.items[0]), keysOf(d.items[0]), '행 shape도 역할 무관');
  record('articles-list', 'success', {
    ...fromResponse(r.res, { values: { sameForRDZ: true, mineCount: 3 } }),
    caseId: 'role-agnostic',
  });
});

// --- 4. GET /api/articles/search ---

test('GET /api/articles/search — 고유 토큰 검색 · Article 행 shape · 빈 q · 무매칭', async () => {
  const hit = await api('GET', '/api/articles/search', { sid: sid('R'), query: { q: TOKEN } });
  assert.equal(hit.status, 200);
  assert.deepEqual(Object.keys(hit.json).sort(), ['items', 'ok'], '목록과 같은 봉투(ok/items) — 총수 필드 없음');
  assertNoLockerLeak(hit, 'search-token');
  const hitIds = idsOf(hit.json.items).sort();
  assert.deepEqual(hitIds, [fx.a.articleId, fx.b.articleId, fx.c.articleId].sort(), '고유 토큰은 내 픽스처 3건만 매칭');
  // 검색 행은 Contents가 아니라 Article 행이다 — 본문(markupVersion)이 실려 나간다.
  for (const row of hit.json.items) assert.equal(keysOf(row), ARTICLE_ROW_KEYS, '검색 행 = Article 5키');
  record('articles-search', 'success', {
    ...fromResponse(hit, { values: { rowKeys: ARTICLE_ROW_KEYS, mineCount: 3 } }),
    caseId: 'token',
  });

  // 빈 q: LIKE '%%' — 거부가 아니라 전 행 매칭이다(내 픽스처가 들어 있다).
  const empty = await api('GET', '/api/articles/search', { sid: sid('R'), query: { q: '' } });
  assert.equal(empty.status, 200, '빈 q도 200(400 아님)');
  assert.ok(has(empty.json.items, fx.a.articleId), '빈 q는 전 행 매칭 — 내 픽스처가 포함된다');
  record('articles-search', 'success', {
    ...fromResponse(empty, { values: { emptyQueryRejected: false, matchesEverything: true } }),
    caseId: 'empty-q',
  });

  // q 파라미터 자체가 없으면 서버가 ''로 폴백한다(빈 q와 동형).
  const noQ = await api('GET', '/api/articles/search', { sid: sid('R') });
  assert.equal(noQ.status, 200, 'q 미전달도 200');
  assert.ok(has(noQ.json.items, fx.a.articleId), 'q 미전달은 빈 문자열 폴백과 같다');
  record('articles-search', 'success', {
    ...fromResponse(noQ, { values: { missingQueryParamOk: true } }),
    caseId: 'missing-q',
  });

  const miss = await api('GET', '/api/articles/search', { sid: sid('R'), query: { q: unique('ct-nomatch') } });
  assert.equal(miss.status, 200, '무매칭도 200 빈 목록(404 아님)');
  assert.ok(!has(miss.json.items, fx.a.articleId), '내 픽스처가 매칭되지 않는다');
  record('articles-search', 'success', {
    ...fromResponse(miss, { values: { fixtureMatched: false } }),
    caseId: 'no-match',
  });
});

// --- 5. GET /api/articles/:id ---

test('GET /api/articles/:id — {ok,article,contents} · 본문 일치 · contents 투영 · 없는 id 404', async () => {
  const res = await api('GET', `/api/articles/${fx.c.articleId}`, { sid: sid('R') });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['article', 'contents', 'ok'], '봉투는 정확히 3키');
  assertNoLockerLeak(res, 'get-by-id');
  assert.equal(keysOf(res.json.article), ARTICLE_ROW_KEYS, 'article = Article 5키');
  assert.equal(keysOf(res.json.contents), CONTENTS_ROW_KEYS, 'contents = Contents 27키(투영 후)');
  assert.equal(res.json.article.markupVersion, fx.editBody, 'article.markupVersion이 저장한 본문과 같다');
  assert.equal(res.json.contents.lockYN, 'Y', '잠금 보유 상태에서 관측했다');
  assert.equal(Object.hasOwn(res.json.contents, 'lockerSessionId'), false, 'contents에 lockerSessionId 없음');
  assert.equal(Object.hasOwn(res.json.contents, 'lockerClientId'), false, 'contents에 lockerClientId 없음');
  record('articles-get', 'success', {
    ...fromResponse(res, {
      values: { articleKeys: ARTICLE_ROW_KEYS, contentsKeys: CONTENTS_ROW_KEYS, bodyRoundTrip: true },
    }),
    caseId: 'ok',
  });

  const missing = await api('GET', `/api/articles/${unique('ct-missing')}`, { sid: sid('R') });
  assert.equal(missing.status, 404, '없는 id는 404');
  assert.deepEqual(missing.json, { ok: false, reason: 'not-found' }, '본문 고정');
  record('articles-get', 'not-found', { ...fromResponse(missing), caseId: 'missing-id' });
});

// --- 6. GET /api/articles/:id/history ---

test('GET /api/articles/:id/history — 이력 없는 기사도 200 빈 배열(404 아님)', async () => {
  const res = await api('GET', `/api/articles/${fx.b.articleId}/history`, { sid: sid('R') });
  assert.equal(res.status, 200, '생성만 된 기사도 200');
  assert.deepEqual(res.json, { ok: true, items: [] }, '기사 생성은 이력 행을 남기지 않는다');
  record('articles-history', 'success', {
    ...fromResponse(res, { values: { emptyForFreshArticle: true } }),
    caseId: 'fresh-article-empty',
  });

  const unknown = await api('GET', `/api/articles/${unique('ct-missing')}/history`, { sid: sid('R') });
  assert.equal(unknown.status, 200, '존재하지 않는 기사도 404가 아니라 200이다');
  assert.deepEqual(unknown.json, { ok: true, items: [] }, '빈 배열');
  record('articles-history', 'success', {
    ...fromResponse(unknown, { values: { unknownArticleIsNotFound404: false } }),
    caseId: 'unknown-article-empty',
  });
});

test('GET /api/articles/:id/history — 행 12키 · 본문 blob 부재 · 파생(title/version/status)', async () => {
  const res = await api('GET', `/api/articles/${fx.c.articleId}/history`, { sid: sid('R') });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['items', 'ok']);
  assertNoLockerLeak(res, 'history-list');
  const items = res.json.items;
  for (const row of items) {
    assert.equal(keysOf(row), HISTORY_ROW_KEYS, '이력 행은 12키 고정');
    assert.equal(Object.hasOwn(row, 'markupVersion'), false, '목록에 본문 blob이 없다');
    assert.equal(Object.hasOwn(row, 'snapshotTitle'), false, '저장 컬럼명(snapshotTitle)은 응답에 없다 — 파생 키는 title');
  }

  const edit = items.find((r) => r.eventType === 'edit');
  const send = items.find((r) => r.eventType === 'status' && r.action === 'send');
  assert.ok(edit, '편집 이력 행이 있다');
  assert.ok(send, '송고 이력 행이 있다');
  assert.equal(edit.hasSnapshot, 1, 'hasSnapshot은 불리언이 아니라 정수 1');
  assert.equal(send.hasSnapshot, 0, '상태 전이 행은 스냅샷 0');
  assert.equal(edit.action, null, 'edit 행의 action은 null');
  assert.equal(edit.fromStatus, null, 'edit 행은 전이가 아니다');
  assert.equal(edit.toStatus, null, 'edit 행은 전이가 아니다');
  assert.equal(send.fromStatus, 'RDS', '송고 전 상태');
  assert.equal(send.toStatus, 'DPS', '송고 후 상태');
  assert.equal(edit.title, fx.editMark, '파생 title은 저장된 스냅샷 제목(본문 첫 텍스트 줄)');
  assert.equal(edit.version, 2, '최초 저장 본문이 v1이라 첫 편집 스냅샷은 v2');
  assert.equal(send.version, 2, '전이 행은 버전을 올리지 않는다');
  assert.equal(edit.status, 'RDS', '전이 이전 구간의 상태는 첫 전이의 fromStatus로 역승계된다');
  assert.equal(send.status, 'DPS', '전이 행의 상태는 toStatus');
  fx.editHistoryId = edit.id;
  fx.sendHistoryId = send.id;

  record('articles-history', 'success', {
    ...fromResponse(res, {
      values: {
        rowKeys: HISTORY_ROW_KEYS,
        editHasSnapshot: edit.hasSnapshot, sendHasSnapshot: send.hasSnapshot,
        editVersion: edit.version, editStatus: edit.status,
        sendFromStatus: send.fromStatus, sendToStatus: send.toStatus, sendStatus: send.status,
      },
    }),
    caseId: 'rows',
  });
});

test('GET /api/articles/:id/history — sendOnly/type 판정(빈 값도 참, 0·false만 거짓)', async () => {
  const variants = [
    ['sendOnly-1', { sendOnly: '1' }, true],
    ['type-send', { type: 'send' }, true],
    ['sendOnly-empty', { sendOnly: '' }, true],
    ['sendOnly-no', { sendOnly: 'no' }, true],
    ['sendOnly-0-with-type-send', { sendOnly: '0', type: 'send' }, true],
    ['sendOnly-0', { sendOnly: '0' }, false],
    ['sendOnly-false', { sendOnly: 'false' }, false],
    ['type-edit', { type: 'edit' }, false],
  ];
  for (const [caseId, query, filtered] of variants) {
    const res = await api('GET', `/api/articles/${fx.c.articleId}/history`, { sid: sid('R'), query });
    assert.equal(res.status, 200, `${caseId}: 200`);
    const ids = res.json.items.map((r) => r.id);
    assert.ok(ids.includes(fx.sendHistoryId), `${caseId}: 송고 행은 항상 남는다`);
    assert.equal(
      ids.includes(fx.editHistoryId), !filtered,
      `${caseId}: 편집 행 포함 여부는 sendOnly 판정을 따른다`,
    );
    if (filtered) {
      for (const row of res.json.items) {
        assert.equal(row.eventType, 'status', `${caseId}: 필터 시 status 행만`);
        assert.equal(row.action, 'send', `${caseId}: 필터 시 send 행만`);
      }
    }
    record('articles-history', 'success', {
      ...fromResponse(res, { values: { sendOnlyApplied: filtered, sendRowPresent: true } }),
      caseId,
    });
  }
});

// --- 7. GET /api/articles/:id/history/:historyId ---

test('GET /api/articles/:id/history/:historyId — 스냅샷 본문 200 · 전이 행도 200(본문 null)', async () => {
  const res = await api('GET', `/api/articles/${fx.c.articleId}/history/${fx.editHistoryId}`, { sid: sid('R') });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['item', 'ok'], '봉투는 ok/item 2키');
  assertNoLockerLeak(res, 'history-snapshot');
  assert.equal(keysOf(res.json.item), SNAPSHOT_ITEM_KEYS, 'item = 7키(본문 포함, 전이 컬럼 없음)');
  assert.equal(res.json.item.markupVersion, fx.editBody, '스냅샷 본문이 저장한 본문과 같다');
  assert.equal(res.json.item.articleId, fx.c.articleId, 'articleId 스코프가 응답에도 실린다');
  record('articles-history-snapshot', 'success', {
    ...fromResponse(res, { values: { itemKeys: SNAPSHOT_ITEM_KEYS, bodyRoundTrip: true } }),
    caseId: 'edit-row',
  });

  // 이 라우트는 '스냅샷 보유 행'으로 제한되지 않는다 — 전이 행 id도 200이고 본문만 null이다.
  const transition = await api('GET', `/api/articles/${fx.c.articleId}/history/${fx.sendHistoryId}`, { sid: sid('R') });
  assert.equal(transition.status, 200, '스냅샷이 없는 전이 행도 200');
  assert.equal(transition.json.item.markupVersion, null, '본문은 null');
  assert.equal(keysOf(transition.json.item), SNAPSHOT_ITEM_KEYS, '같은 7키');
  record('articles-history-snapshot', 'success', {
    ...fromResponse(transition, { values: { itemKeys: SNAPSHOT_ITEM_KEYS, markupVersionNull: true } }),
    caseId: 'transition-row',
  });
});

test('GET /api/articles/:id/history/:historyId — 비정수·미존재·타 기사 스코프는 전부 404', async () => {
  const cases = [
    ['non-integer', `/api/articles/${fx.c.articleId}/history/abc`],
    ['fractional', `/api/articles/${fx.c.articleId}/history/1.5`],
    ['unknown-id', `/api/articles/${fx.c.articleId}/history/2147483646`],
    // 다른 기사에 속한 historyId — 모델이 articleId AND id로 스코프한다(권한 우회 방지).
    ['other-article-scope', `/api/articles/${fx.b.articleId}/history/${fx.editHistoryId}`],
  ];
  for (const [caseId, path] of cases) {
    const res = await api('GET', path, { sid: sid('R') });
    assert.equal(res.status, 404, `${caseId}: 404`);
    assert.deepEqual(res.json, { ok: false, reason: 'not-found' }, `${caseId}: 본문 고정`);
    record('articles-history-snapshot', 'not-found', { ...fromResponse(res), caseId });
  }
});
