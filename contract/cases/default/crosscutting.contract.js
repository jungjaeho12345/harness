// 계약 케이스: 교차 계약(라우트가 아니라 미들웨어 축) — default 프로파일.
// 동결 축: CSRF Origin/Referer 게이트(ADR-009) · CORS allowlist/preflight(허용 헤더 4종) · 미정의 경로의 에러 shape.
// 리포트 태그는 라우트에 매달아야 하므로 **실제 호출한 라우트**의 routeId로 기록하고, 교차 계약이라는 사실은
// caseId('crosscutting/…')로 남긴다. 인벤토리에 없는 표면(미정의 경로)은 'x-' 접두사 routeId로 기록한다
// (decisions (23) — 커버리지 집계 제외 채널).
// 규율: 부수효과 없는 라우트로만 403을 유발한다(기사 저장·전이·tick 금지 — 게이트가 뚫려 있었다면 실제 데이터가 바뀐다).
//   POST /api/logout은 세션 토큰을 주지 않으면 아무것도 무효화하지 않고 항상 200이라 CSRF 프로브로 안전하다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';

requireProfile('default');

// 서버가 CORS/CSRF에서 공유하는 비프로덕션 기본 allowlist(server/index.js DEFAULT_ALLOWED_ORIGINS).
const ALLOWED_ORIGIN = 'http://localhost:5173';
const FOREIGN_ORIGIN = 'http://evil.example';
// cors 설정의 allowedHeaders 4종(server/index.js) — 소문자 정렬 비교.
const ALLOWED_REQUEST_HEADERS = ['content-type', 'x-collection-token', 'x-edit-client', 'x-session-id'];

function headerSet(value) {
  return String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .sort();
}

test('CSRF: 상태 변경 요청의 교차 출처 Origin은 403 forbidden-origin', async () => {
  const res = await api('POST', '/api/logout', { headers: { origin: FOREIGN_ORIGIN } });

  assert.equal(res.status, 403);
  assert.deepEqual(res.json, { ok: false, reason: 'forbidden-origin' });

  record('logout', 'forbidden', {
    ...fromResponse(res, { values: { originClass: 'foreign' } }),
    caseId: 'csrf-foreign-origin',
  });
});

test('CSRF: Origin 없이 허용 출처 Referer만 있어도 통과한다(Referer→origin 파싱)', async () => {
  const res = await api('POST', '/api/logout', { headers: { referer: `${ALLOWED_ORIGIN}/editor` } });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });

  record('logout', 'success', {
    ...fromResponse(res, { values: { originClass: 'referer-allowlisted' } }),
    caseId: 'csrf-referer-allowlisted',
  });
});

test('CSRF: 파싱 불가능한 Referer(Origin 없음)는 403 forbidden-origin', async () => {
  const res = await api('POST', '/api/logout', { headers: { referer: 'not-a-url' } });

  assert.equal(res.status, 403);
  assert.deepEqual(res.json, { ok: false, reason: 'forbidden-origin' });

  record('logout', 'forbidden', {
    ...fromResponse(res, { values: { originClass: 'referer-unparseable' } }),
    caseId: 'csrf-referer-unparseable',
  });
});

// 관용 규칙(Origin·Referer 둘 다 없으면 통과)은 auth.contract.js의 로그인/로그아웃이 이미 증명한다 —
// 계약 스위트 전체가 그 관용 위에서 돌고 있다는 사실 자체가 실증이다.

test('CORS: 허용 출처 preflight는 2xx + ACAO/ACAC + 허용 헤더 4종', async () => {
  const res = await api('OPTIONS', '/api/articles', {
    headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'GET' },
  });

  assert.ok(res.status < 300, `preflight는 2xx여야 한다(실제 ${res.status})`);
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  assert.deepEqual(headerSet(res.headers.get('access-control-allow-headers')), ALLOWED_REQUEST_HEADERS);

  record('articles-list', 'cors-preflight', {
    ...fromResponse(res, {
      // ACAO 헤더 값은 record.js가 URL이라 마스킹한다 — "요청 Origin을 그대로 되돌려준다"는 계약은
      // 불리언 파생값으로 남긴다(마스킹 규율을 우회하지 않으면서 diff에서 의미를 유지).
      values: {
        allowHeaders: ALLOWED_REQUEST_HEADERS.join(','),
        allowOriginEchoesRequest: res.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN,
        originClass: 'allowlisted',
      },
      headers: ['access-control-allow-origin', 'access-control-allow-credentials'],
    }),
    caseId: 'cors-preflight-allowlisted',
  });
});

test('CORS: 비허용 출처 preflight는 2xx이지만 ACAO 헤더가 없다', async () => {
  const res = await api('OPTIONS', '/api/articles', {
    headers: { origin: FOREIGN_ORIGIN, 'access-control-request-method': 'GET' },
  });

  assert.ok(res.status < 300, `preflight는 403이 아니라 2xx여야 한다(실제 ${res.status})`);
  assert.equal(res.headers.get('access-control-allow-origin'), null); // 헤더 부재 = 브라우저가 응답 판독을 막는다.

  record('articles-list', 'cors-preflight-denied', {
    ...fromResponse(res, {
      // ACAC(credentials)는 미허용 출처에도 실린다(실측) — 판독 차단은 ACAO 부재가 담당한다.
      values: { allowOriginPresent: res.headers.get('access-control-allow-origin') !== null, originClass: 'foreign' },
      headers: ['access-control-allow-origin', 'access-control-allow-credentials'],
    }),
    caseId: 'cors-preflight-foreign-origin',
  });
});

test('에러 shape: 미정의 경로는 404이며 본문이 JSON이 아니다(SPA 서빙 off 측정 조건)', async () => {
  const res = await api('GET', '/api/does-not-exist');

  assert.equal(res.status, 404);
  // 실측: express 기본 404 핸들러의 HTML이다 — "모든 응답이 JSON"이라는 클라이언트 관용 규칙의 예외이며,
  // 그 예외 자체가 계약이다(SPA_DIR 미설정 전제 — 설정되면 GET은 index.html 폴백 200이 된다).
  assert.equal(res.json, undefined);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);

  record('x-undefined-route', 'not-found', {
    ...fromResponse(res, { values: { bodyIsJson: false } }),
    caseId: 'undefined-api-path',
  });
});
