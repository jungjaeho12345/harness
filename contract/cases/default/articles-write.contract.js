// 계약 케이스: 기사 쓰기·편집 잠금 5 라우트 — default 프로파일.
//   articles-create(POST /api/articles) · articles-update(PUT /api/articles/:id)
//   articles-lock / articles-unlock / articles-force-unlock(POST /api/articles/:id/{lock,unlock,force-unlock})
// 동결하는 계약 축 3개:
//   (1) 서버 stamp — 초기 status·부서·작성자·modifier는 서버가 결정한다(클라 role/status/articleId/sender 무시, ADR-004).
//   (2) x-edit-client 탭 단위 인가 — 같은 세션이어도 다른 탭이면 저장·해제가 거부된다(not-holder 403).
//   (3) 멱등 unlock — 이미 풀린 잠금의 해제도 200이다(탭 닫기·pagehide가 중복 호출한다).
// 규율: 서버 코드 import 금지(CONTRACT_BASE_URL로만 접근) · 리포트 기록은 record 한 곳으로만 ·
//   각 케이스는 자기가 건 잠금을 finally에서 스스로 푼다(30분 TTL이 다음 실행 판정을 바꾸지 않게).
// SSE lock/create/update 신호 자체는 step11 소유 — 여기서는 상태 변화만 본다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';
import { actor, sid } from '../../lib/session.js';
import {
  unique, createArticle, createSentArticle, acquireLock,
} from '../../lib/fixtures.js';

// 케이스 오배치 방지 — 다른 프로파일에서 --files로 잘못 실행되면 로드 시점에 즉시 실패한다.
requireProfile('default');

// 발급 규칙은 'AKR' + 오늘 YYYYMMDD + 난수 9자리다 — 1900년 날짜는 어떤 서버에서도 발급되지 않는다.
const NO_SUCH_ARTICLE = 'AKR19000101000000000';
const ARTICLE_ID_RE = /^AKR\d{8}\d{9}$/;

const bodyBlocks = (text) => JSON.stringify({ blocks: [{ text }] });

// 되읽기 — 단건 조회는 step4(articles-read)가 동결하는 라우트라 여기서는 관측만 하고 기록하지 않는다.
async function reread(articleId, role) {
  const res = await api('GET', `/api/articles/${articleId}`, { sid: sid(role) });
  assert.equal(res.status, 200, '되읽기(GET /api/articles/:id)가 200이 아니다');
  assert.equal(res.json?.ok, true, '되읽기 응답 ok가 true가 아니다');
  return res.json;
}

const lockReq = (articleId, role, clientId, body = {}) => api('POST', `/api/articles/${articleId}/lock`, {
  sid: sid(role), headers: { 'x-edit-client': clientId }, body,
});

const unlockReq = (articleId, role, clientId) => api('POST', `/api/articles/${articleId}/unlock`, {
  sid: sid(role), headers: { 'x-edit-client': clientId }, body: {},
});

const forceUnlockReq = (articleId, role) => api('POST', `/api/articles/${articleId}/force-unlock`, {
  sid: sid(role), body: {},
});

const putReq = (articleId, role, clientId, body) => api('PUT', `/api/articles/${articleId}`, {
  sid: sid(role), headers: { 'x-edit-client': clientId }, body,
});

// 정리 전용 — 자기가 건 잠금을 스스로 푼다. 실패해도 케이스 판정을 덮지 않는다(진단은 본 단언이 한다).
async function releaseQuietly(articleId, role, clientId) {
  try { await unlockReq(articleId, role, clientId); } catch { /* 정리 실패는 케이스 실패를 가리지 않는다 */ }
}

// --- 인가(미인증) ---

test('미인증 — 쓰기·잠금 5 라우트 전부 401 unauthenticated', async () => {
  const { articleId } = await createArticle('R');
  const tab = unique('tab');
  const cases = [
    ['articles-create', 'POST', '/api/articles', { title: unique('contract-title') }],
    ['articles-update', 'PUT', `/api/articles/${articleId}`, { title: unique('contract-title') }],
    ['articles-lock', 'POST', `/api/articles/${articleId}/lock`, {}],
    ['articles-unlock', 'POST', `/api/articles/${articleId}/unlock`, {}],
    ['articles-force-unlock', 'POST', `/api/articles/${articleId}/force-unlock`, {}],
  ];

  for (const [routeId, method, path, body] of cases) {
    // 세션 없이(x-edit-client만 붙여) 호출한다 — 탭 헤더는 인증 수단이 아니다(ADR-004).
    const res = await api(method, path, { headers: { 'x-edit-client': tab }, body });
    assert.equal(res.status, 401, `${routeId}: 미인증 요청은 401이어야 한다`);
    assert.equal(res.json?.reason, 'unauthenticated', `${routeId}: 미인증 사유 토큰`);
    record(routeId, 'unauthenticated', { ...fromResponse(res), caseId: 'no-session' });
  }

  // 잠금을 만들지 않았으므로 정리할 상태가 없다.
  const after = await reread(articleId, 'R');
  assert.equal(after.contents.lockYN, 'N', '거부된 잠금 요청은 잠금을 만들지 않는다');
});

// --- create ---

test('create 성공 — 200 {ok,articleId} + 부서·작성자·초기 status를 서버가 stamp한다', async () => {
  const me = actor('R');
  const title = unique('contract-title');
  const res = await api('POST', '/api/articles', {
    sid: sid('R'), body: { title, markupVersion: bodyBlocks('계약 스위트 create 본문.') },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.articleId, ARTICLE_ID_RE, 'articleId는 AKR + 8자리 날짜 + 9자리 난수다');
  assert.deepEqual(Object.keys(res.json).sort(), ['articleId', 'ok'], '성공 응답 키는 ok·articleId 둘뿐이다');

  const { article, contents } = await reread(res.json.articleId, 'R');
  assert.equal(contents.status, 'RDS', '초기 status는 서버 계산값 RDS다');
  assert.equal(contents.author, me.name, '작성자 미전송이면 세션 사용자로 stamp된다');
  assert.equal(contents.department, me.department, '부서 미전송이면 세션 부서로 stamp된다');
  assert.equal(contents.departmentCode, me.departmentCode);
  assert.equal(article.title, title);
  assert.equal(contents.lockYN, 'N', '신규 기사는 잠겨 있지 않다');
  assert.equal(contents.lockerUserId, null);

  record('articles-create', 'success', {
    ...fromResponse(res, {
      values: {
        articleIdPattern: 'AKR+YYYYMMDD+9',
        storedStatus: contents.status,
        authorStampedFromSession: contents.author === me.name,
        departmentStampedFromSession: contents.department === me.department
          && contents.departmentCode === me.departmentCode,
        lockYN: contents.lockYN,
      },
    }),
    caseId: 'ok',
  });
});

test('create 신뢰 경계 — 클라 role/status/articleId/sender/distributedAt은 무시되고 author만 보존된다', async () => {
  const claimedAuthor = unique('contract-author');
  const res = await api('POST', '/api/articles', {
    sid: sid('R'),
    body: {
      title: unique('contract-title'),
      markupVersion: bodyBlocks('계약 스위트 신뢰 경계 본문.'),
      // 아래는 전부 "클라이언트가 결정할 수 없는" 값이다(ADR-004) — 반영되면 그것이 결함이다.
      role: 'Z',
      status: 'DPS',
      articleId: 'contract-client-supplied-id',
      sender: 'contract-client-sender',
      distributedAt: '2020-01-01T00:00:00.000Z',
      // author는 예외 — 대필 입력으로 보존된다(코드 정본: server/index.js `if (!dto.author)`).
      author: claimedAuthor,
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.articleId, ARTICLE_ID_RE);
  assert.ok(res.json.articleId !== 'contract-client-supplied-id', 'articleId는 서버가 발급한다');

  const { contents } = await reread(res.json.articleId, 'R');
  assert.equal(contents.status, 'RDS', '클라가 보낸 status는 반영되지 않는다');
  assert.ok(contents.articleId === res.json.articleId, '저장된 articleId는 서버 발급 값이다');
  assert.equal(contents.sender, null, 'sender는 송고가 정한다 — create 입력으로 채워지지 않는다');
  assert.equal(contents.distributedAt, null, 'distributedAt은 배부가 정한다');
  assert.equal(contents.author, claimedAuthor, '명시된 author는 보존된다(무시되지 않는다)');

  record('articles-create', 'trust-boundary', {
    ...fromResponse(res, {
      values: {
        storedStatus: contents.status,
        clientStatusIgnored: contents.status !== 'DPS',
        clientArticleIdIgnored: contents.articleId === res.json.articleId,
        clientSenderIgnored: contents.sender === null,
        clientDistributedAtIgnored: contents.distributedAt === null,
        clientAuthorPreserved: contents.author === claimedAuthor,
      },
    }),
    caseId: 'client-fields-ignored',
  });
});

test('create + action:hold — 초기 status는 세션 role이 정한다(D→DDH · R→RRH)', async () => {
  for (const [role, expected] of [['D', 'DDH'], ['R', 'RRH']]) {
    const res = await api('POST', '/api/articles', {
      sid: sid(role),
      // status가 아니라 "의도(action)"만 보낸다 — 상태 계산은 서버 몫이다.
      body: { title: unique('contract-title'), markupVersion: bodyBlocks('계약 스위트 보류 본문.'), action: 'hold' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);

    const { contents } = await reread(res.json.articleId, role);
    assert.equal(contents.status, expected, `${role} + action:hold의 초기 status`);

    record('articles-create', 'initial-status', {
      ...fromResponse(res, { values: { role, action: 'hold', storedStatus: contents.status } }),
      caseId: `hold-${role}`,
    });
  }
});

// --- lock ---

test('lock 성공 — 200 + lockYN Y·보유자 표시, 세션 토큰·탭 식별자는 응답에 없다', async () => {
  const { articleId } = await createArticle('R');
  const me = actor('R');
  const tabA = unique('tab');
  try {
    const res = await lockReq(articleId, 'R', tabA);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true }, '잠금 성공 응답은 {ok:true} 뿐이다(보유자 정보 미노출)');

    const { contents } = await reread(articleId, 'R');
    assert.equal(contents.lockYN, 'Y');
    assert.equal(contents.lockerUserId, me.userId, '보유자 표시(UI 계약)는 유지된다');
    assert.ok(typeof contents.lockedAt === 'string' && contents.lockedAt.length > 0);
    assert.ok(!('lockerSessionId' in contents), 'lockerSessionId는 어떤 응답에도 없다(세션 토큰 원문)');
    assert.ok(!('lockerClientId' in contents), 'lockerClientId는 어떤 응답에도 없다(탭 사칭 재료)');

    record('articles-lock', 'success', {
      ...fromResponse(res, {
        values: {
          lockYN: contents.lockYN,
          lockerUserIdIsSessionUser: contents.lockerUserId === me.userId,
          lockerSessionIdAbsent: !('lockerSessionId' in contents),
          lockerClientIdAbsent: !('lockerClientId' in contents),
        },
      }),
      caseId: 'acquire',
    });

    // 같은 사용자·같은 탭의 재획득(F5 새로고침)은 멱등이다.
    const again = await lockReq(articleId, 'R', tabA);
    assert.equal(again.status, 200);
    assert.equal(again.json.ok, true);
    record('articles-lock', 'success', {
      ...fromResponse(again, { values: { sameTabReacquire: true } }),
      caseId: 'reacquire-same-tab',
    });
  } finally {
    await releaseQuietly(articleId, 'R', tabA);
  }
});

test('lock 충돌 — 다른 사용자도, 같은 세션의 다른 탭도 401 locked (누가 잠갔는지 노출 없음)', async () => {
  const { articleId } = await createArticle('R');
  const me = actor('R');
  const tabA = unique('tab');
  const tabB = unique('tab');
  try {
    await acquireLock(articleId, 'R', tabA);

    // (1) 다른 사용자(D) — 전역 매핑상 401이다(423/409 아님).
    const other = await lockReq(articleId, 'D', tabB);
    assert.equal(other.status, 401, '잠금 충돌은 401이다');
    assert.equal(other.json.reason, 'locked');
    assert.deepEqual(Object.keys(other.json).sort(), ['ok', 'reason'], '보유자 정보를 담지 않는다');
    record('articles-lock', 'conflict', {
      ...fromResponse(other), caseId: 'other-user',
    });

    // (2) 같은 세션의 다른 탭 — 한 사용자가 여러 탭에서 동시 편집하지 못한다.
    const sameSessionOtherTab = await lockReq(articleId, 'R', tabB);
    assert.equal(sameSessionOtherTab.status, 401);
    assert.equal(sameSessionOtherTab.json.reason, 'locked');
    record('articles-lock', 'conflict', {
      ...fromResponse(sameSessionOtherTab), caseId: 'same-session-other-tab',
    });

    const { contents } = await reread(articleId, 'R');
    assert.equal(contents.lockYN, 'Y', '거부된 잠금 시도는 기존 잠금을 건드리지 않는다');
    assert.equal(contents.lockerUserId, me.userId);
  } finally {
    await releaseQuietly(articleId, 'R', tabA);
  }
});

test('lock 404 — 존재하지 않는 기사', async () => {
  const res = await lockReq(NO_SUCH_ARTICLE, 'R', unique('tab'));
  assert.equal(res.status, 404);
  assert.equal(res.json.reason, 'not-found');
  record('articles-lock', 'not-found', { ...fromResponse(res), caseId: 'unknown-article' });
});

test('lock DPS 게이트 — 송고된 기사(DPS)의 편집 진입은 D만 가능하다(R은 403 forbidden)', async () => {
  const sent = await createSentArticle();
  assert.equal(sent.status, 'DPS', '픽스처 전제: 무엠바고 송고는 DPS다');
  const tabR = unique('tab');
  const tabD = unique('tab');
  const tabP = unique('tab');
  try {
    const denied = await lockReq(sent.articleId, 'R', tabR);
    assert.equal(denied.status, 403, 'DPS 기사에 대한 R의 잠금은 403이다');
    assert.equal(denied.json.reason, 'forbidden');
    record('articles-lock', 'forbidden', { ...fromResponse(denied), caseId: 'dps-reporter' });

    const afterDenied = await reread(sent.articleId, 'D');
    assert.equal(afterDenied.contents.lockYN, 'N', '거부된 잠금 시도는 잠금을 만들지 않는다');

    // D의 고침(revise) 진입.
    const revise = await lockReq(sent.articleId, 'D', tabD);
    assert.equal(revise.status, 200);
    assert.equal(revise.json.ok, true);
    record('articles-lock', 'success', {
      ...fromResponse(revise, { values: { articleStatus: sent.status, action: 'revise' } }),
      caseId: 'dps-desk-revise',
    });
    await releaseQuietly(sent.articleId, 'D', tabD);

    // D의 포털고침(portalRevise) 분기 — 같은 게이트를 통과한다.
    const portal = await lockReq(sent.articleId, 'D', tabP, { action: 'portalRevise' });
    assert.equal(portal.status, 200);
    assert.equal(portal.json.ok, true);
    record('articles-lock', 'success', {
      ...fromResponse(portal, { values: { articleStatus: sent.status, action: 'portalRevise' } }),
      caseId: 'dps-desk-portal-revise',
    });

    const held = await reread(sent.articleId, 'D');
    assert.equal(held.contents.status, 'DPS', '잠금 획득은 상태 전이를 일으키지 않는다');
  } finally {
    await releaseQuietly(sent.articleId, 'D', tabD);
    await releaseQuietly(sent.articleId, 'D', tabP);
  }
});

// --- update ---

test('update 보유자 인가 — 잠금 없음 403 · 보유 탭 200 · 같은 세션 다른 탭 403(탭 단위 인가)', async () => {
  const { articleId } = await createArticle('R');
  const me = actor('R');
  const tabA = unique('tab');
  const tabB = unique('tab');
  const heldTitle = unique('contract-title');
  try {
    // (a) 잠금 없이 저장 — 세션만으로는 쓸 수 없다.
    const noLock = await putReq(articleId, 'R', tabA, { title: unique('contract-title') });
    assert.equal(noLock.status, 403);
    assert.equal(noLock.json.reason, 'not-holder');
    record('articles-update', 'forbidden', { ...fromResponse(noLock), caseId: 'no-lock' });

    await acquireLock(articleId, 'R', tabA);

    // (b) 보유 탭 저장 — 성공하고 modifier가 세션 사용자로 stamp된다.
    const ok = await putReq(articleId, 'R', tabA, { title: heldTitle, markupVersion: bodyBlocks('계약 스위트 수정 본문.') });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.ok(Number.isInteger(ok.json.changes) && ok.json.changes >= 1, 'changes는 갱신 행 수다');

    const saved = await reread(articleId, 'R');
    assert.equal(saved.article.title, heldTitle);
    assert.equal(saved.contents.title, heldTitle);
    assert.equal(saved.contents.modifier, me.userId, 'modifier는 세션 사용자로 stamp된다');
    assert.ok(typeof saved.contents.editedAt === 'string' && saved.contents.editedAt.length > 0);
    record('articles-update', 'success', {
      ...fromResponse(ok, {
        values: {
          changes: ok.json.changes,
          titleApplied: saved.article.title === heldTitle,
          modifierStampedFromSession: saved.contents.modifier === me.userId,
        },
      }),
      caseId: 'holder-tab',
    });

    // (c) 같은 세션의 "다른 탭" — 세션이 같아도 보유 탭이 아니면 저장할 수 없다(이 계약의 핵심).
    const otherTab = await putReq(articleId, 'R', tabB, { title: unique('contract-title') });
    assert.equal(otherTab.status, 403, '같은 세션의 다른 탭도 보유자가 아니다');
    assert.equal(otherTab.json.reason, 'not-holder');
    record('articles-update', 'forbidden', { ...fromResponse(otherTab), caseId: 'other-tab-same-session' });

    const afterDenied = await reread(articleId, 'R');
    assert.equal(afterDenied.article.title, heldTitle, '거부된 저장은 본문·제목을 바꾸지 않는다');
  } finally {
    await releaseQuietly(articleId, 'R', tabA);
  }
});

test('update 화이트리스트 — status/sender/articleId/role/modifier는 무시되고 빈 부서는 세션 부서로 보정된다', async () => {
  const { articleId } = await createArticle('R');
  const me = actor('R');
  const tabA = unique('tab');
  const newTitle = unique('contract-title');
  try {
    await acquireLock(articleId, 'R', tabA);

    const res = await putReq(articleId, 'R', tabA, {
      title: newTitle,
      status: 'DPS',
      sender: 'contract-client-sender',
      articleId: 'contract-client-supplied-id',
      role: 'Z',
      modifier: 'contract-client-modifier',
      department: '', // 빈 부서 → 세션 부서로 보정(신규 저장과 정합).
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);

    const { contents } = await reread(articleId, 'R');
    assert.equal(contents.title, newTitle, '화이트리스트 안 필드는 반영된다');
    assert.equal(contents.status, 'RDS', 'status는 전이 라우트만 바꾼다');
    assert.equal(contents.sender, null, 'sender는 클라 입력으로 채워지지 않는다');
    assert.ok(contents.articleId === articleId, 'articleId는 바뀌지 않는다');
    assert.equal(contents.modifier, me.userId, 'modifier는 클라 값이 아니라 세션 사용자다');
    assert.equal(contents.department, me.department, '빈 부서는 세션 부서로 보정된다');
    assert.equal(contents.departmentCode, me.departmentCode);

    record('articles-update', 'whitelist', {
      ...fromResponse(res, {
        values: {
          storedStatus: contents.status,
          clientStatusIgnored: contents.status !== 'DPS',
          clientSenderIgnored: contents.sender === null,
          clientArticleIdIgnored: contents.articleId === articleId,
          clientModifierOverridden: contents.modifier === me.userId,
          emptyDepartmentBackfilled: contents.department === me.department,
        },
      }),
      caseId: 'ignored-fields',
    });
  } finally {
    await releaseQuietly(articleId, 'R', tabA);
  }
});

test('update 404 — 존재 검사가 잠금 검사보다 먼저다(403 not-holder가 아니라 404 not-found)', async () => {
  const res = await putReq(NO_SUCH_ARTICLE, 'R', unique('tab'), { title: unique('contract-title') });
  assert.equal(res.status, 404, '없는 기사에 대한 저장은 404다(잠금 판정보다 존재 판정이 앞선다)');
  assert.equal(res.json.reason, 'not-found');
  record('articles-update', 'not-found', { ...fromResponse(res), caseId: 'unknown-article' });
});

// --- unlock ---

test('unlock — 보유 탭은 해제 200, 재호출도 200(멱등)', async () => {
  const { articleId } = await createArticle('R');
  const tabA = unique('tab');
  try {
    await acquireLock(articleId, 'R', tabA);

    const res = await unlockReq(articleId, 'R', tabA);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });

    const after = await reread(articleId, 'R');
    assert.equal(after.contents.lockYN, 'N');
    assert.equal(after.contents.lockerUserId, null, '해제는 보유자 표시도 지운다');
    assert.equal(after.contents.lockedAt, null);
    record('articles-unlock', 'success', {
      ...fromResponse(res, { values: { lockYN: after.contents.lockYN, lockerUserIdCleared: after.contents.lockerUserId === null } }),
      caseId: 'holder-tab',
    });

    // 탭 닫기·pagehide가 중복 호출한다 — 잠겨 있지 않아도 200이다(거부 아님).
    const again = await unlockReq(articleId, 'R', tabA);
    assert.equal(again.status, 200, '이미 해제된 잠금의 해제는 멱등이다');
    assert.deepEqual(again.json, { ok: true });
    record('articles-unlock', 'success', {
      ...fromResponse(again, { values: { idempotentRepeat: true } }),
      caseId: 'idempotent-repeat',
    });
  } finally {
    await releaseQuietly(articleId, 'R', tabA);
  }
});

test('unlock 403 — 다른 사용자도, 같은 사용자의 다른 탭도 보유자가 아니다(not-holder)', async () => {
  const { articleId } = await createArticle('R');
  const me = actor('R');
  const tabA = unique('tab');
  const tabB = unique('tab');
  try {
    await acquireLock(articleId, 'R', tabA);

    // 남의 탭 식별자를 그대로 흉내내도 세션 신원이 다르면 거부된다(ADR-004).
    const stolen = await unlockReq(articleId, 'D', tabA);
    assert.equal(stolen.status, 403);
    assert.equal(stolen.json.reason, 'not-holder');
    record('articles-unlock', 'forbidden', { ...fromResponse(stolen), caseId: 'other-user-stolen-tab' });

    const otherTab = await unlockReq(articleId, 'R', tabB);
    assert.equal(otherTab.status, 403, '같은 사용자여도 보유 탭이 아니면 해제할 수 없다');
    assert.equal(otherTab.json.reason, 'not-holder');
    record('articles-unlock', 'forbidden', { ...fromResponse(otherTab), caseId: 'other-tab-same-session' });

    const still = await reread(articleId, 'R');
    assert.equal(still.contents.lockYN, 'Y', '거부된 해제는 잠금을 풀지 않는다');
    assert.equal(still.contents.lockerUserId, me.userId);
  } finally {
    await releaseQuietly(articleId, 'R', tabA);
  }
});

test('unlock 404 — 존재하지 않는 기사', async () => {
  const res = await unlockReq(NO_SUCH_ARTICLE, 'R', unique('tab'));
  assert.equal(res.status, 404);
  assert.equal(res.json.reason, 'not-found');
  record('articles-unlock', 'not-found', { ...fromResponse(res), caseId: 'unknown-article' });
});

// --- force-unlock ---

test('force-unlock — R은 403 forbidden, D는 200(해제) · 잠기지 않은 기사도 200', async () => {
  const { articleId } = await createArticle('R');
  const me = actor('R');
  const tabA = unique('tab');
  try {
    await acquireLock(articleId, 'R', tabA);

    const denied = await forceUnlockReq(articleId, 'R');
    assert.equal(denied.status, 403, '강제 해제는 D/Z 전용이다');
    assert.equal(denied.json.reason, 'forbidden');
    record('articles-force-unlock', 'forbidden', { ...fromResponse(denied), caseId: 'reporter' });

    const kept = await reread(articleId, 'R');
    assert.equal(kept.contents.lockYN, 'Y', '거부된 강제 해제는 잠금을 유지한다');
    assert.equal(kept.contents.lockerUserId, me.userId);

    const forced = await forceUnlockReq(articleId, 'D');
    assert.equal(forced.status, 200);
    assert.deepEqual(forced.json, { ok: true });
    const after = await reread(articleId, 'R');
    assert.equal(after.contents.lockYN, 'N', '강제 해제는 보유자와 무관하게 잠금을 푼다');
    assert.equal(after.contents.lockerUserId, null);
    record('articles-force-unlock', 'success', {
      ...fromResponse(forced, { values: { lockYN: after.contents.lockYN, lockerUserIdCleared: after.contents.lockerUserId === null } }),
      caseId: 'desk-releases-other-user-lock',
    });

    // 잠겨 있지 않은 기사에 대한 강제 해제 — 존재만 확인한다.
    const again = await forceUnlockReq(articleId, 'D');
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { ok: true });
    record('articles-force-unlock', 'success', {
      ...fromResponse(again, { values: { notLockedRepeat: true } }),
      caseId: 'already-unlocked',
    });
  } finally {
    // 이 케이스가 건 잠금은 이미 강제 해제로 풀렸다 — 실패 경로를 대비한 정리만 남긴다.
    await releaseQuietly(articleId, 'R', tabA);
  }
});

test('force-unlock 404 — 존재하지 않는 기사(권한 게이트 통과 후 존재 검사)', async () => {
  const res = await forceUnlockReq(NO_SUCH_ARTICLE, 'D');
  assert.equal(res.status, 404);
  assert.equal(res.json.reason, 'not-found');
  record('articles-force-unlock', 'not-found', { ...fromResponse(res), caseId: 'unknown-article' });
});
