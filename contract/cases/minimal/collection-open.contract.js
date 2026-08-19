// 계약 케이스: 수집 인제스트 개방 계약 — POST /api/collection/receive(collection-receive).
// minimal 프로파일 = loopback 바인딩 + COLLECTION_TOKEN **미설정**.
//
// 이 프로파일에서 두 수집 라우트는 토큰 없이 통과한다. 그것이 취약점 리포트가 아니라 계약이다:
// 방어는 "loopback 바인딩"이고, 토큰은 loopback 밖으로 열 때 필요한 추가 방어다(비-loopback + 무토큰이면
// fail-closed 503 — failclosed 프로파일 소유). 서버가 토큰을 설정하지 않았으면 x-collection-token 헤더는
// 아예 읽히지 않는다(아무 값이나 보내도 무시).
// 세션은 픽스처(수신 설정 등록·기사 되읽기)용일 뿐 수집 라우트의 판정에는 쓰이지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';
import { sid } from '../../lib/session.js';
import { createReceiverConfig, unique } from '../../lib/fixtures.js';

requireProfile('minimal');

const AUTO_ATTRIBUTE = '자동기사';

// 토큰 미설정 서버가 이 헤더를 보지 않는다는 것을 확인하기 위한 아무 값(비밀 아님).
const IGNORED_TOKEN = 'contract-ignored-collection-token';

async function readContentsRow(articleId) {
  const res = await api('GET', '/api/articles', { sid: sid('Z'), query: { articleId } });
  assert.equal(res.status, 200);
  const mine = (res.json?.items ?? []).filter((row) => row.articleId === articleId);
  assert.equal(mine.length, 1, '수집한 기사가 articleId 필터로 정확히 1행 조회돼야 한다');
  return mine[0];
}

test('POST /api/collection/receive(토큰 미설정 서버) — 토큰 없이도 게이트를 지나 403 unregistered까지 간다', async () => {
  // 401이 아니라 403이라는 사실이 "토큰 게이트가 없다"는 증거다(미등록 판정은 서비스 계층에서 났다).
  const res = await api('POST', '/api/collection/receive', {
    body: { sourceId: unique('ct-src-never'), payload: '무토큰 수신\n본문' },
  });

  assert.equal(res.status, 403);
  assert.equal(res.json?.reason, 'unregistered');
  assert.deepEqual(Object.keys(res.json).sort(), ['ok', 'reason']);

  record('collection-receive', 'forbidden', {
    ...fromResponse(res), caseId: 'open-unregistered-no-token',
  });
});

test('POST /api/collection/receive(토큰 미설정 서버) — 등록 소스는 토큰 없이 200으로 수신된다', async () => {
  const { sourceId } = await createReceiverConfig();
  const title = unique('ct-open-title');

  const res = await api('POST', '/api/collection/receive', {
    body: { sourceId, payload: `${title}\n${title} 본문` },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json?.ok, true);
  assert.deepEqual(Object.keys(res.json).sort(), ['articleId', 'ok']);

  const row = await readContentsRow(res.json.articleId);
  assert.equal(row.title, title);
  assert.equal(row.attribute, AUTO_ATTRIBUTE);
  assert.equal(row.status, 'RDS');

  record('collection-receive', 'success', {
    ...fromResponse(res, { values: { attribute: AUTO_ATTRIBUTE, status: 'RDS', tokenSent: false } }),
    caseId: 'open-success-no-token',
  });
});

test('POST /api/collection/receive(토큰 미설정 서버) — 아무 값의 x-collection-token 헤더도 무시된다(200)', async () => {
  const { sourceId } = await createReceiverConfig();
  const title = unique('ct-open-ignored');

  const res = await api('POST', '/api/collection/receive', {
    headers: { 'x-collection-token': IGNORED_TOKEN },
    body: { sourceId, payload: `${title}\n${title} 본문` },
  });

  assert.equal(res.status, 200, '서버가 토큰을 설정하지 않았으면 헤더 값을 비교하지 않는다(401 아님)');
  assert.equal(res.json?.ok, true);

  const row = await readContentsRow(res.json.articleId);
  assert.equal(row.title, title);
  assert.equal(row.attribute, AUTO_ATTRIBUTE);

  record('collection-receive', 'success', {
    ...fromResponse(res, { values: { attribute: AUTO_ATTRIBUTE, tokenSent: true, tokenIgnored: true } }),
    caseId: 'open-success-token-ignored',
  });
});
