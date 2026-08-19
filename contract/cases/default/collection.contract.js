// 계약 케이스: 수집 인제스트 2 라우트 — POST /api/collection/receive(collection-receive) ·
// POST /api/collection/pull(collection-pull). default 프로파일 = loopback 바인딩 + COLLECTION_TOKEN 설정.
//
// 가드 순서가 계약이다: fail-closed(503) → 토큰(401) → 서비스 판정(403 unregistered·inactive /
// 400 no-active-api-source·fetch-failed). default는 loopback이라 503 축이 없다(그 축은 failclosed 소유).
// 이 두 라우트는 **사용자 세션 라우트가 아니다** — 방어는 바인딩 + x-collection-token 뿐이며
// 세션(x-session-id)은 어떤 판정에도 쓰이지 않는다. 여기서 쓰는 세션은 픽스처(수신 설정 등록·기사 되읽기)용이다.
//
// egress 0(ADR-008): pull이 호출하는 주소는 (a) 대상 서버 자신의 /api/health (b) 아무도 듣지 않는
// loopback 포트뿐이다. 외부 인터넷 주소는 등록하지 않는다 — assertNoEgress가 실행 시점에 잠근다.
// 토큰 값은 리포트·에러 메시지·stdout 어디에도 남기지 않는다(자격증명 규율 — 테스트 토큰이라도 동일).

import test from 'node:test';
import assert from 'node:assert/strict';
import { api, BASE_URL } from '../../lib/http.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';
import { sid } from '../../lib/session.js';
import { createReceiverConfig, unique } from '../../lib/fixtures.js';

requireProfile('default');

// 러너가 넘긴 수집 토큰(COLLECTION_TOKEN과 같은 값) — 값은 절대 출력하지 않는다.
const TOKEN = process.env.CONTRACT_COLLECTION_TOKEN;
if (!TOKEN) {
  throw new Error(
    'CONTRACT_COLLECTION_TOKEN이 없다 — default 프로파일 대상 서버는 COLLECTION_TOKEN이 설정돼 있어야 한다'
    + '(러너가 넘긴다). 토큰이 없는 서버의 수집 개방 계약은 minimal 프로파일 케이스가 소유한다.',
  );
}
const WRONG_TOKEN = 'contract-wrong-collection-token';
if (WRONG_TOKEN === TOKEN) throw new Error('음성 케이스의 오토큰이 실제 토큰과 같다 — 케이스가 무의미해진다.');

const withToken = (value = TOKEN) => ({ 'x-collection-token': value });
const AUTO_ATTRIBUTE = '자동기사'; // rcv.md 규칙 — 수집 기사는 반드시 이 속성을 갖는다.
const DEAD_ENDPOINT = 'http://127.0.0.1:1/'; // 아무도 듣지 않는 loopback 포트(연결 거부).

// 등록하는 apiEndpoint가 '대상 서버 자신' 또는 loopback인지 잠근다(egress 0 — 오프라인·폐쇄망 결정성).
function assertNoEgress(endpoint) {
  const selfOrLoopback = endpoint.startsWith(`${BASE_URL}/`)
    || /^http:\/\/127(\.\d{1,3}){3}(:\d+)?\//.test(endpoint);
  assert.ok(selfOrLoopback, 'pull 대상 apiEndpoint는 대상 서버 자신이거나 loopback이어야 한다(egress 0)');
  return endpoint;
}

// 수집된 기사 되읽기 — 목록 필터(articleId)로 자기 픽스처 1행만 본다(절대 개수 단언 금지).
async function readContentsRow(articleId) {
  const res = await api('GET', '/api/articles', { sid: sid('Z'), query: { articleId } });
  assert.equal(res.status, 200);
  assert.equal(res.json?.ok, true);
  const mine = (res.json.items ?? []).filter((row) => row.articleId === articleId);
  assert.equal(mine.length, 1, '수집한 기사가 articleId 필터로 정확히 1행 조회돼야 한다');
  return mine[0];
}

// 본문(markupVersion)은 목록행에 없다 — 단건 조회로 블록 JSON을 확인한다(파서 규칙 동결).
async function readBodyBlockTexts(articleId) {
  const res = await api('GET', `/api/articles/${articleId}`, { sid: sid('Z') });
  assert.equal(res.status, 200);
  const doc = JSON.parse(res.json.article.markupVersion);
  assert.equal(doc.format, 'yh-editor');
  assert.equal(doc.version, 1);
  return doc.blocks.map((b) => b.text);
}

// --- A-1. 토큰 인가 (가드 2단: 토큰 → 서비스 판정) ---

test('POST /api/collection/receive — 토큰 헤더 없음은 401 unauthenticated(서비스 판정 전에 끊긴다)', async () => {
  const res = await api('POST', '/api/collection/receive', {
    body: { sourceId: unique('ct-src-never'), payload: '토큰 없는 수신\n본문' },
  });

  assert.equal(res.status, 401);
  assert.equal(res.json?.reason, 'unauthenticated');
  assert.deepEqual(Object.keys(res.json).sort(), ['ok', 'reason']);

  record('collection-receive', 'unauthenticated', {
    ...fromResponse(res), caseId: 'receive-token-missing',
  });
});

test('POST /api/collection/receive — 틀린 토큰도 401 unauthenticated', async () => {
  const res = await api('POST', '/api/collection/receive', {
    headers: withToken(WRONG_TOKEN),
    body: { sourceId: unique('ct-src-never'), payload: '틀린 토큰 수신\n본문' },
  });

  assert.equal(res.status, 401);
  assert.equal(res.json?.reason, 'unauthenticated');

  record('collection-receive', 'unauthenticated', {
    ...fromResponse(res), caseId: 'receive-token-wrong',
  });
});

test('POST /api/collection/receive — 올바른 토큰 + 미등록 sourceId는 403 unregistered', async () => {
  const res = await api('POST', '/api/collection/receive', {
    headers: withToken(),
    body: { sourceId: unique('ct-src-never'), payload: '미등록 수신\n본문' },
  });

  assert.equal(res.status, 403);
  assert.equal(res.json?.reason, 'unregistered');

  record('collection-receive', 'forbidden', {
    ...fromResponse(res), caseId: 'receive-unregistered',
  });
});

// --- A-2. 등록 후 수신 성공 + 파서/속성 규칙 되읽기 ---

test('POST /api/collection/receive — 등록 소스 수신은 200 {ok,articleId}, 첫 줄=제목·attribute=자동기사', async () => {
  const { sourceId } = await createReceiverConfig();
  const title = unique('ct-collect-title');
  const bodyLine = `${title} 본문 줄`;

  const res = await api('POST', '/api/collection/receive', {
    headers: withToken(),
    body: { sourceId, payload: `${title}\n${bodyLine}` },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json?.ok, true);
  assert.deepEqual(Object.keys(res.json).sort(), ['articleId', 'ok']);
  assert.equal(typeof res.json.articleId, 'string');

  const row = await readContentsRow(res.json.articleId);
  assert.equal(row.title, title, '문자열 payload의 첫 줄이 제목이다');
  assert.equal(row.attribute, AUTO_ATTRIBUTE);
  assert.equal(row.status, 'RDS', '수집 기사는 초기 상태 RDS로 등록된다');
  // 본문 블록: 제목 줄 + 나머지 줄이 그대로 블록이 된다(수집 파이프라인 toMarkup 규칙).
  assert.deepEqual(await readBodyBlockTexts(res.json.articleId), [title, bodyLine]);

  record('collection-receive', 'success', {
    ...fromResponse(res, {
      values: {
        attribute: AUTO_ATTRIBUTE, status: 'RDS', titleFromFirstLine: true, bodyBlockCount: 2,
      },
    }),
    caseId: 'receive-text-payload',
  });
});

// --- A-4. payload 형태(파서가 읽는 필드) ---

test('POST /api/collection/receive — 객체 payload {title,content}는 필드에서 직접 제목·본문을 취한다', async () => {
  const { sourceId } = await createReceiverConfig();
  const title = unique('ct-collect-obj');
  const content = `${title} 객체 본문`;

  const res = await api('POST', '/api/collection/receive', {
    headers: withToken(),
    body: { sourceId, payload: { title, content } },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json?.ok, true);

  const row = await readContentsRow(res.json.articleId);
  assert.equal(row.title, title);
  assert.equal(row.attribute, AUTO_ATTRIBUTE);
  assert.deepEqual(await readBodyBlockTexts(res.json.articleId), [title, content]);

  record('collection-receive', 'success', {
    ...fromResponse(res, {
      values: { attribute: AUTO_ATTRIBUTE, titleFromField: true, bodyBlockCount: 2 },
    }),
    caseId: 'receive-object-payload',
  });
});

test('POST /api/collection/receive — payload 누락은 거부되지 않는다: 200 + 제목/본문이 빈 기사가 생긴다', async () => {
  // 입력 검증이 없다는 것이 계약이다(파서가 빈 문자열을 돌려주고 등록이 그대로 진행된다).
  const { sourceId } = await createReceiverConfig();

  const res = await api('POST', '/api/collection/receive', {
    headers: withToken(),
    body: { sourceId },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json?.ok, true);

  const row = await readContentsRow(res.json.articleId);
  assert.equal(row.title, '', 'payload가 없으면 빈 제목으로 등록된다(400이 아니다)');
  assert.equal(row.attribute, AUTO_ATTRIBUTE);
  assert.deepEqual(await readBodyBlockTexts(res.json.articleId), ['']);

  record('collection-receive', 'success', {
    ...fromResponse(res, {
      values: { attribute: AUTO_ATTRIBUTE, emptyTitle: true, bodyBlockCount: 1 },
    }),
    caseId: 'receive-missing-payload',
  });
});

// --- A-3. 비활성 소스 ---

test('POST /api/collection/receive — active=N 소스는 403 inactive(unregistered와 구분된다)', async () => {
  const { sourceId } = await createReceiverConfig({ active: 'N' });

  const res = await api('POST', '/api/collection/receive', {
    headers: withToken(),
    body: { sourceId, payload: '비활성 소스 수신\n본문' },
  });

  assert.equal(res.status, 403);
  assert.equal(res.json?.reason, 'inactive');

  record('collection-receive', 'forbidden', {
    ...fromResponse(res), caseId: 'receive-inactive-source',
  });
});

// --- A-5~7. pull ---

test('POST /api/collection/pull — 토큰 헤더 없음은 401 unauthenticated(외부 호출 이전에 끊긴다)', async () => {
  const res = await api('POST', '/api/collection/pull', {
    body: { sourceId: unique('ct-src-never') },
  });

  assert.equal(res.status, 401);
  assert.equal(res.json?.reason, 'unauthenticated');

  record('collection-pull', 'unauthenticated', {
    ...fromResponse(res), caseId: 'pull-token-missing',
  });
});

test('POST /api/collection/pull — 미등록 sourceId는 403 unregistered', async () => {
  const res = await api('POST', '/api/collection/pull', {
    headers: withToken(),
    body: { sourceId: unique('ct-src-never') },
  });

  assert.equal(res.status, 403);
  assert.equal(res.json?.reason, 'unregistered');

  record('collection-pull', 'forbidden', {
    ...fromResponse(res), caseId: 'pull-unregistered',
  });
});

test('POST /api/collection/pull — FTP 소스는 400 no-active-api-source(전역 매핑 없는 fallback 400)', async () => {
  const { sourceId } = await createReceiverConfig({ type: 'FTP' });

  const res = await api('POST', '/api/collection/pull', {
    headers: withToken(), body: { sourceId },
  });

  assert.equal(res.status, 400);
  assert.equal(res.json?.reason, 'no-active-api-source');

  record('collection-pull', 'validation', {
    ...fromResponse(res), caseId: 'pull-ftp-source',
  });
});

test('POST /api/collection/pull — 연결 거부 endpoint는 400 fetch-failed(재시도 없이 1회 시도 후 사유 반환)', async () => {
  const { sourceId } = await createReceiverConfig({ apiEndpoint: assertNoEgress(DEAD_ENDPOINT) });

  const res = await api('POST', '/api/collection/pull', {
    headers: withToken(), body: { sourceId },
  });

  assert.equal(res.status, 400);
  assert.equal(res.json?.reason, 'fetch-failed');

  record('collection-pull', 'validation', {
    ...fromResponse(res), caseId: 'pull-fetch-failed',
  });
});

test('POST /api/collection/pull — 대상 서버 자신의 /api/health를 소스로 걸면 200 + 빈 자동기사가 등록된다', async () => {
  // 결정적 성공 경로(egress 0): 응답 JSON {"ok":true}에는 title/content가 없어 파서가 빈 제목·빈 본문을
  // 돌려주고, 그래도 등록은 진행된다 — "pull 성공 = 기사 1건 생성"이며 내용 유효성 검사는 없다.
  const { sourceId } = await createReceiverConfig({ apiEndpoint: assertNoEgress(`${BASE_URL}/api/health`) });

  const res = await api('POST', '/api/collection/pull', {
    headers: withToken(), body: { sourceId },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json?.ok, true);
  assert.deepEqual(Object.keys(res.json).sort(), ['articleId', 'ok']);

  const row = await readContentsRow(res.json.articleId);
  assert.equal(row.title, '');
  assert.equal(row.attribute, AUTO_ATTRIBUTE);
  assert.equal(row.status, 'RDS');
  assert.deepEqual(await readBodyBlockTexts(res.json.articleId), ['']);

  record('collection-pull', 'success', {
    ...fromResponse(res, {
      values: {
        attribute: AUTO_ATTRIBUTE, status: 'RDS', emptyTitle: true, bodyBlockCount: 1,
      },
    }),
    caseId: 'pull-self-health-source',
  });
});

// --- A-8. DB 비파괴 경계: 설정 행 삭제는 수집된 기사를 건드리지 않는다 ---

test('DELETE /api/receiver-config/:id — 설정 행만 지운다: 수집된 기사는 그대로 남고 그 sourceId는 미등록이 된다', async () => {
  const { id, sourceId } = await createReceiverConfig();
  const title = unique('ct-collect-keep');

  const received = await api('POST', '/api/collection/receive', {
    headers: withToken(), body: { sourceId, payload: `${title}\n${title} 본문` },
  });
  assert.equal(received.status, 200);
  const { articleId } = received.json;
  const before = await readContentsRow(articleId);

  // 자기가 만든 설정 행만 지운다(기존 행 금지 — decisions (14)).
  const removed = await api('DELETE', `/api/receiver-config/${id}`, { sid: sid('Z') });
  assert.equal(removed.status, 200);
  assert.equal(removed.json?.ok, true);
  assert.equal(removed.json.changes, 1);

  // 기사는 그대로 조회된다(같은 필드) — 이것이 "설정 행만 지운다"는 계약의 실증이다.
  const after = await readContentsRow(articleId);
  assert.equal(after.title, before.title);
  assert.equal(after.title, title);
  assert.equal(after.attribute, AUTO_ATTRIBUTE);
  assert.equal(after.status, before.status);
  assert.deepEqual(await readBodyBlockTexts(articleId), [title, `${title} 본문`]);

  // 설정이 사라졌으므로 같은 sourceId의 후속 수신은 미등록 거부다(게이트가 설정 행을 본다는 증거).
  const afterDelete = await api('POST', '/api/collection/receive', {
    headers: withToken(), body: { sourceId, payload: '삭제 후 수신\n본문' },
  });
  assert.equal(afterDelete.status, 403);
  assert.equal(afterDelete.json?.reason, 'unregistered');

  // routeId는 step7 소유(receiver-config-delete)라 그 라우트의 필수 태그(success)를 쓰지 않는다 —
  // 커버리지를 대신 채우지 않으면서 관측만 리포트에 남긴다(decisions (13) 커버 단위 = (routeId, 태그) 쌍).
  record('receiver-config-delete', 'article-preserved', {
    ...fromResponse(removed, {
      values: {
        changes: removed.json.changes,
        articleSurvives: true,
        attribute: AUTO_ATTRIBUTE,
        receiveAfterDeleteStatus: afterDelete.status,
      },
    }),
    caseId: 'delete-config-keeps-article',
  });
});
