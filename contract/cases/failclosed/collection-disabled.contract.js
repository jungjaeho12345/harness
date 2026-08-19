// 계약 케이스: 수집 fail-closed — POST /api/collection/receive · /api/collection/pull.
// failclosed 프로파일 = 비-loopback 바인딩(HOST=0.0.0.0, 접속은 127.0.0.1) + COLLECTION_TOKEN **미설정**.
//
// 이 구성에서는 두 수집 라우트에 방어가 하나도 남지 않으므로 서버가 기능 자체를 제공하지 않는다:
// 503 collection-disabled(클라이언트 잘못이 아니라 서버 구성상 미가용 — 'spool-disabled' 503과 동형).
// 가드 순서 계약: 503 가드가 **최상단**이라 토큰 헤더 유무와 무관하며(401로 새지 않는다),
// 서비스 판정(미등록 403)·외부 호출(pull의 fetch)까지 가지 않는다.
//
// 이 파일은 이 프로파일의 유일한 케이스다 — 다른 도메인을 여기에 추가하지 마라(비-loopback 바인딩은
// 환경(방화벽)에 영향을 받는다: 그 환경 문제로 무관한 계약이 함께 무너지면 안 된다).

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';
import { sid } from '../../lib/session.js';
import { unique } from '../../lib/fixtures.js';

requireProfile('failclosed');

// 값 자체는 의미가 없다 — 503 가드가 토큰 검사보다 앞이라는 사실을 관측하기 위한 아무 값이다.
const ANY_TOKEN = 'contract-any-collection-token';

test('POST /api/collection/receive — 비-loopback 바인딩 + 토큰 미설정이면 503 collection-disabled', async () => {
  const res = await api('POST', '/api/collection/receive', {
    body: { sourceId: unique('ct-src-never'), payload: '차단된 수신\n본문' },
  });

  assert.equal(res.status, 503);
  assert.equal(res.json?.reason, 'collection-disabled');
  assert.deepEqual(Object.keys(res.json).sort(), ['ok', 'reason']);
  assert.equal(res.json.ok, false);

  record('collection-receive', 'disabled', {
    ...fromResponse(res), caseId: 'receive-disabled-no-token',
  });
});

test('POST /api/collection/receive — 토큰 헤더를 보내도 503이다(가드 순서: 503 → 401)', async () => {
  const res = await api('POST', '/api/collection/receive', {
    headers: { 'x-collection-token': ANY_TOKEN },
    body: { sourceId: unique('ct-src-never'), payload: '차단된 수신\n본문' },
  });

  assert.equal(res.status, 503, '토큰 헤더가 있어도 401이 아니라 503이다(fail-closed가 최상단 가드)');
  assert.equal(res.json?.reason, 'collection-disabled');

  record('collection-receive', 'disabled', {
    ...fromResponse(res), caseId: 'receive-disabled-with-token',
  });
});

test('POST /api/collection/pull — 같은 fail-closed 가드로 503 collection-disabled(외부 호출 없음)', async () => {
  const res = await api('POST', '/api/collection/pull', {
    body: { sourceId: unique('ct-src-never') },
  });

  assert.equal(res.status, 503);
  assert.equal(res.json?.reason, 'collection-disabled');
  assert.equal(res.json.ok, false);

  record('collection-pull', 'disabled', {
    ...fromResponse(res), caseId: 'pull-disabled-no-token',
  });
});

test('fail-closed는 수집 2 라우트만 닫는다 — health·세션 라우트는 같은 서버에서 정상이다', async () => {
  const health = await api('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true });

  const session = await api('GET', '/api/session', { sid: sid('Z') });
  assert.equal(session.status, 200);
  assert.equal(session.json?.ok, true);
  assert.equal(session.json.user?.role, 'Z');

  // 태그는 두 라우트의 필수 태그(success)를 쓰지 않는다 — 다른 step의 커버리지를 대신 채우지 않으면서
  // "fail-closed가 서버 전체를 죽이지 않는다"는 관측만 리포트에 남긴다.
  record('health', 'alive-when-collection-disabled', {
    ...fromResponse(health, { values: { ok: health.json.ok } }), caseId: 'health-alive',
  });
  record('session', 'alive-when-collection-disabled', {
    ...fromResponse(session, { values: { role: session.json.user.role } }), caseId: 'session-alive',
  });
});
