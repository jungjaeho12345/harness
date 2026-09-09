// scripts/lib/spaParity.mjs 의 순수 판정부 자기검사 (phase 76 step3).
//
// 왜 여기에 있고 npm test 가 돌지 않는가: package.json 은 무수정 목록이고 `npm test` 는 "test/**/*.test.js" 만 훑는다.
// scripts/spa-parity.mjs 는 시작할 때 이 파일을 스스로 돌린다(빨간 채로는 서버를 띄우지 않는다).
// 실행: node --test scripts/lib/spaParity.self-test.mjs
//
// 무엇을 잠그는가(각각 step3 변이의 방어선이다):
//   · 관측 헤더 상수의 **집합**(N8 — 개수만 세면 하나를 빼고 하나를 넣어도 통과한다)
//   · 허용 diff 분류 표의 **집합**(N4·N9 — CSP 를 spa 경로군에 넣거나 uploads 경로군을 지우면 red)
//   · 요청 표의 중복 name 즉시 실패 · 최소 관측 수(N5)
//   · 같은 리포트 2벌 → 0 · 한 값만 다른 2벌 → 1 · 허용 diff 가 요약 줄에 실제로 세어지는가

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_DIFFS, CACHE_HEADERS, CSP_HEADER, HTML_ACCEPT, MIN_REQUESTS, OBSERVED_HEADERS, PATH_GROUPS, RECORD_FIELDS,
  REQUESTS, REQUEST_CLASSES, SECURITY_HEADERS, UPLOAD_FIXTURE_NAME,
  classifyPath, compareReports, comparedFields, decodeChunked, extractAssetPaths, formatDiffLines, formatSummary,
  observe, parseHttpResponse, resolveRequestTable, scopesFor, sha256Hex, validateRequestTable,
} from './spaParity.mjs';

// --- 관측 헤더 집합 (Node helmet@8.2.0 실측 2026-09-07) ---

test('관측 헤더 상수는 보안 12종 + 캐시 4종의 정확한 집합이다', () => {
  assert.deepEqual([...SECURITY_HEADERS], [
    'content-security-policy',
    'cross-origin-opener-policy',
    'cross-origin-resource-policy',
    'origin-agent-cluster',
    'referrer-policy',
    'strict-transport-security',
    'x-content-type-options',
    'x-dns-prefetch-control',
    'x-download-options',
    'x-frame-options',
    'x-permitted-cross-domain-policies',
    'x-xss-protection',
  ]);
  assert.deepEqual([...CACHE_HEADERS], ['accept-ranges', 'cache-control', 'etag', 'last-modified']);
  assert.deepEqual([...OBSERVED_HEADERS], [...SECURITY_HEADERS, ...CACHE_HEADERS]);
  assert.equal(CSP_HEADER, 'content-security-policy');
  assert.equal(new Set(OBSERVED_HEADERS).size, OBSERVED_HEADERS.length, '중복 헤더 이름');
});

test('비교 필드는 레코드 8필드 + 관측 헤더 16개다', () => {
  assert.deepEqual([...RECORD_FIELDS], [
    'status', 'contentType', 'hasContentLength', 'bodySha256', 'bodyLength', 'isIndex', 'leaks.packageJson', 'leaks.sqlite',
  ]);
  assert.deepEqual(comparedFields(), [...RECORD_FIELDS, ...OBSERVED_HEADERS.map((n) => `headers.${n}`)]);
});

// --- 허용 diff 분류 표 (scope × field) ---

const h = (name) => `headers.${name}`;
const SECURITY_WITHOUT_CSP = SECURITY_HEADERS.filter((n) => n !== CSP_HEADER).map(h);
const CACHE = CACHE_HEADERS.map(h);

test('허용 diff 분류 표는 정확히 이 집합이다 — CSP 는 group:spa 에 없다', () => {
  assert.deepEqual(ALLOWED_DIFFS.map((r) => ({ scope: r.scope, fields: [...r.fields] })), [
    { scope: 'group:spa', fields: [...SECURITY_WITHOUT_CSP, ...CACHE] },
    { scope: 'group:api', fields: [h(CSP_HEADER), ...SECURITY_WITHOUT_CSP, ...CACHE] },
    { scope: 'group:uploads', fields: [h(CSP_HEADER), ...SECURITY_WITHOUT_CSP, ...CACHE] },
    { scope: 'status:404', fields: ['bodySha256', 'bodyLength', h(CSP_HEADER)] },
    { scope: 'class:malformed', fields: ['status', 'contentType', 'bodySha256', 'bodyLength', 'isIndex', h(CSP_HEADER)] },
    { scope: 'class:directory', fields: ['status', 'contentType', 'bodySha256', 'bodyLength', 'isIndex', h(CSP_HEADER)] },
  ]);
  for (const rule of ALLOWED_DIFFS) {
    assert.ok(rule.reason && rule.defense, `${rule.scope}: 이유·대체 방어선이 없다 — 허용 diff 는 결정이다`);
  }
  assert.deepEqual([...PATH_GROUPS], ['spa', 'api', 'uploads']);
  assert.deepEqual([...REQUEST_CLASSES], ['malformed', 'directory']);
});

test('어떤 scope 도 content-type·isIndex·leaks 를 spa/api/uploads 경로군에서 허용하지 않는다', () => {
  for (const rule of ALLOWED_DIFFS.filter((r) => r.scope.startsWith('group:'))) {
    for (const field of ['status', 'contentType', 'bodySha256', 'isIndex', 'leaks.packageJson', 'leaks.sqlite']) {
      assert.ok(!rule.fields.includes(field), `${rule.scope} 가 ${field} 를 허용한다`);
    }
  }
  for (const rule of ALLOWED_DIFFS) {
    assert.ok(!rule.fields.includes('leaks.packageJson') && !rule.fields.includes('leaks.sqlite'),
      `${rule.scope}: 루트 밖 내용 노출은 어떤 scope 에서도 허용 diff 가 아니다`);
  }
});

// --- 경로군 ---

test('classifyPath 는 Node 예약 접두사 규칙과 같다(소문자화 · 정확 일치 또는 하위 경로 · 쿼리 무시)', () => {
  for (const p of ['/api', '/api/', '/api/health', '/API/unknown', '/Api/x?y=1']) assert.equal(classifyPath(p), 'api', p);
  for (const p of ['/uploads', '/uploads/x.png', '/UPLOADS/x.png']) assert.equal(classifyPath(p), 'uploads', p);
  for (const p of ['/', '/list.do', '/apidocs', '/uploadsomething', '/assets/a.js', '/../package.json']) assert.equal(classifyPath(p), 'spa', p);
});

// --- 요청 표 ---

test('요청 표는 유효하고 최소 관측 수 이상이며 계획의 필수 항목을 담는다', () => {
  assert.ok(MIN_REQUESTS >= 30);
  assert.equal(validateRequestTable(REQUESTS), REQUESTS);
  assert.ok(REQUESTS.length >= MIN_REQUESTS, `${REQUESTS.length} < ${MIN_REQUESTS}`);
  const paths = REQUESTS.filter((r) => r.rawPath).map((r) => `${r.method} ${r.rawPath}`);
  for (const route of ['login', 'writer', 'list', 'rcvMgmt', 'userMgmt', 'logs', 'distMgmt']) {
    assert.ok(paths.includes(`GET /${route}.do`), `.do 7경로 중 ${route} 가 없다`);
  }
  for (const must of ['GET /', 'HEAD /list.do', 'GET /writer.do?articleId=A1', 'GET /assets/does-not-exist.js', 'GET /index.html',
    'GET /api/health', 'GET /api/articles', 'GET /api/unknown-path', 'GET /api/does-not-exist', 'GET /API/unknown',
    'GET /uploads/missing.png', `GET /uploads/${UPLOAD_FIXTURE_NAME}`, 'POST /list.do', 'GET /.hidden/x', 'GET /.env',
    'GET /list.do/', 'GET /list.do;a=b', 'GET /List.do']) {
    assert.ok(paths.includes(must), `필수 항목이 없다: ${must}`);
  }
  assert.ok(REQUESTS.filter((r) => r.name.startsWith('escape-')).length >= 6, '경로 탈출 변형 6종 이상');
  assert.ok(REQUESTS.some((r) => r.asset === 'script') && REQUESTS.some((r) => r.asset === 'style'), '실제 자산 2종');
  assert.equal(REQUESTS.find((r) => r.name === 'escape-backslash').rawPath.includes(String.fromCharCode(92)), true, '진짜 백슬래시');
  assert.equal(REQUESTS.find((r) => r.name === 'asset-missing').headers.Accept, '*/*');
  assert.equal(REQUESTS.find((r) => r.name === 'do-list').headers.Accept, HTML_ACCEPT);
  // Range 행 — 양쪽 다 accept-ranges 를 광고하는데 종전 표에는 조건부/부분 요청이 한 행도 없었다(⑤ 리뷰 2026-09-09).
  const range = REQUESTS.find((r) => r.name === 'asset-range');
  assert.ok(range, 'Range 요청 행이 없다 — 부분 응답 축을 아무도 보지 않는다');
  assert.equal(range.headers.Range, 'bytes=0-15');
  assert.equal(range.asset, 'script', '실재하는 자산이어야 206 이 나온다(해시는 실행 시 index.html 에서 뽑는다)');
});

test('요청 표의 중복 name 은 즉시 실패다', () => {
  const dup = [...REQUESTS, { ...REQUESTS[1] }];
  assert.throws(() => validateRequestTable(dup), /중복 name/);
});

test('요청 표가 최소 관측 수보다 작으면 실패다(관측 수를 조용히 줄일 수 없다)', () => {
  assert.throws(() => validateRequestTable(REQUESTS.slice(0, MIN_REQUESTS - 1)), /너무 작다/);
});

test('요청 표 형태 오류(메서드·경로·cls·headers)는 실패다', () => {
  const base = REQUESTS.slice(0, MIN_REQUESTS - 1);
  assert.throws(() => validateRequestTable([...base, { name: 'x', method: 'PUT', rawPath: '/x', headers: {} }]), /메서드/);
  assert.throws(() => validateRequestTable([...base, { name: 'x', method: 'GET', rawPath: 'x', headers: {} }]), /rawPath/);
  assert.throws(() => validateRequestTable([...base, { name: 'x', method: 'GET', rawPath: '/x', asset: 'script', headers: {} }]), /정확히 하나/);
  assert.throws(() => validateRequestTable([...base, { name: 'x', method: 'GET', rawPath: '/x', headers: {}, cls: 'weird' }]), /cls/);
  assert.throws(() => validateRequestTable([...base, { name: 'x', method: 'GET', rawPath: '/x', headers: null }]), /headers/);
});

test('resolveRequestTable 은 asset 항목을 실제 경로로 치환하고 나머지는 그대로다', () => {
  const resolved = resolveRequestTable(REQUESTS, { script: '/assets/index-abc.js', style: '/assets/index-def.css' });
  assert.equal(resolved.length, REQUESTS.length);
  assert.equal(resolved.find((r) => r.name === 'asset-script').rawPath, '/assets/index-abc.js');
  assert.equal(resolved.find((r) => r.name === 'asset-style').rawPath, '/assets/index-def.css');
  assert.ok(resolved.every((r) => typeof r.rawPath === 'string' && r.asset === undefined));
  assert.throws(() => resolveRequestTable(REQUESTS, { script: '/a.js' }), /자산 경로/);
});

test('extractAssetPaths 는 index.html 의 스크립트·스타일 경로를 뽑는다', () => {
  const html = '<html><head><script type="module" crossorigin src="/assets/index-Q.js"></script>'
    + '<link rel="stylesheet" crossorigin href="/assets/index-R.css"></head></html>';
  assert.deepEqual(extractAssetPaths(html), { script: '/assets/index-Q.js', style: '/assets/index-R.css' });
  assert.throws(() => extractAssetPaths('<html></html>'), /script src/);
});

// --- 원시 응답 파서 ---

test('parseHttpResponse 는 상태·헤더 원문(소문자 이름)·Content-Length 본문을 읽는다', () => {
  const raw = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nX-Frame-Options: SAMEORIGIN\r\nContent-Length: 5\r\n\r\nhello', 'latin1');
  const res = parseHttpResponse(raw);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=UTF-8');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.body.toString(), 'hello');
});

test('parseHttpResponse 는 Spring 의 이유구 없는 상태줄과 HEAD(본문 없음)를 처리한다', () => {
  const raw = Buffer.from('HTTP/1.1 200 \r\nContent-Length: 413\r\n\r\n', 'latin1');
  const res = parseHttpResponse(raw, { head: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 0);
  assert.equal(res.headers.has('content-length'), true);
});

test('parseHttpResponse 는 chunked 본문을 해독한다', () => {
  const raw = Buffer.from('HTTP/1.1 404 \r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n', 'latin1');
  assert.equal(parseHttpResponse(raw).body.toString(), 'Wikipedia');
  assert.equal(decodeChunked(Buffer.from('0\r\n\r\n', 'latin1')).length, 0);
  assert.throws(() => parseHttpResponse(Buffer.from('garbage', 'latin1')), /CRLFCRLF/);
});

// --- 관측 레코드 ---

const INDEX = Buffer.from('<!doctype html><html>SPA</html>');
const INDEX_SHA = sha256Hex(INDEX);

function response(status, headers, body = INDEX) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: map, body };
}

const NODE_CSP = "default-src 'self';script-src 'self';img-src 'self' data: https:";
const spaHeaders = { 'Content-Type': 'text/html; charset=UTF-8', 'Content-Length': '30', 'Content-Security-Policy': NODE_CSP, 'X-Frame-Options': 'SAMEORIGIN', ETag: 'W/"x"' };

test('observe 는 본문 내용을 싣지 않고 sha256·길이·isIndex·leak 불리언·관측 헤더만 싣는다', () => {
  const entry = { name: 'do-list', method: 'GET', rawPath: '/list.do', headers: {} };
  const record = observe(entry, response(200, spaHeaders), { indexSha256: INDEX_SHA });
  assert.deepEqual(Object.keys(record).sort(), ['bodyLength', 'bodySha256', 'cls', 'contentType', 'group', 'hasContentLength', 'headers', 'isIndex', 'leaks', 'method', 'name', 'rawPath', 'status']);
  assert.equal(record.group, 'spa');
  assert.equal(record.cls, null);
  assert.equal(record.isIndex, true);
  assert.equal(record.bodySha256, INDEX_SHA);
  assert.equal(record.bodyLength, INDEX.length);
  assert.equal(record.hasContentLength, true);
  assert.equal(record.contentType, 'text/html; charset=UTF-8');
  assert.deepEqual(record.leaks, { packageJson: false, sqlite: false });
  assert.deepEqual(Object.keys(record.headers), [...OBSERVED_HEADERS]);
  assert.equal(record.headers['content-security-policy'], NODE_CSP);
  assert.equal(record.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(record.headers['cache-control'], null);
  assert.equal(JSON.stringify(record).includes('SPA</html>'), false, '본문 내용이 리포트에 실렸다');
});

test('observe 는 루트 밖 내용 노출을 불리언으로만 기록한다', () => {
  const entry = { name: 'escape-dotdot', method: 'GET', rawPath: '/../package.json', headers: {}, cls: 'malformed' };
  const leaked = observe(entry, response(200, {}, Buffer.from('{"name":"article-production-system"}')), { indexSha256: INDEX_SHA });
  assert.equal(leaked.leaks.packageJson, true);
  assert.equal(leaked.isIndex, false);
  assert.equal(JSON.stringify(leaked).includes('article-production-system'), false, '내용이 실렸다(마커 문자열 자체가 리포트에 있다)');
  const db = observe(entry, response(200, {}, Buffer.from('SQLite format 3\0...')), { indexSha256: INDEX_SHA });
  assert.equal(db.leaks.sqlite, true);
});

// --- 리포트 비교 ---

function record(name, rawPath, overrides = {}, cls) {
  const entry = { name, method: 'GET', rawPath, headers: {}, cls };
  const base = observe(entry, response(200, spaHeaders), { indexSha256: INDEX_SHA });
  return { ...base, ...overrides, headers: { ...base.headers, ...(overrides.headers ?? {}) } };
}

function report(records) {
  return { target: 'x', observations: records };
}

test('같은 리포트 2벌 → 실패 0 · 허용 0', () => {
  const r = report([record('root', '/'), record('api-health', '/api/health')]);
  const result = compareReports(r, structuredClone(r));
  assert.equal(result.observationCount, 2);
  assert.equal(result.failures.length, 0);
  assert.equal(result.allowed.length, 0);
});

test('한 값만 다른 2벌 → 실패 diff 1', () => {
  const a = report([record('do-list', '/list.do')]);
  const b = report([record('do-list', '/list.do', { status: 404 })]);
  const result = compareReports(a, b);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0], { name: 'do-list', kind: 'value-diff', field: 'status', a: 200, b: 404, allowedBy: undefined });
});

test('한쪽에만 있는 항목은 실패 diff 다(관측 수가 조용히 줄지 않는다)', () => {
  const a = report([record('root', '/'), record('do-list', '/list.do')]);
  const b = report([record('root', '/')]);
  const result = compareReports(a, b);
  assert.equal(result.observationCount, 1);
  assert.deepEqual(result.failures, [{ name: 'do-list', kind: 'only-in-A' }]);
  assert.deepEqual(compareReports(b, a).failures, [{ name: 'do-list', kind: 'only-in-B' }]);
});

test('CSP: spa 경로군의 200 응답에서는 실패 diff · api/uploads 경로군에서는 허용 diff(리포트에는 남는다)', () => {
  const spaA = record('do-list', '/list.do');
  const spaB = record('do-list', '/list.do', { headers: { [CSP_HEADER]: null } });
  const spa = compareReports(report([spaA]), report([spaB]));
  assert.equal(spa.failures.length, 1);
  assert.equal(spa.failures[0].field, h(CSP_HEADER));

  const apiA = record('api-health', '/api/health', { contentType: 'application/json; charset=utf-8', isIndex: false });
  const apiB = { ...apiA, headers: { ...apiA.headers, [CSP_HEADER]: null } };
  const api = compareReports(report([apiA]), report([apiB]));
  assert.equal(api.failures.length, 0);
  assert.equal(api.allowed.length, 1);
  assert.equal(api.allowed[0].allowedBy, 'group:api');

  const upA = record('uploads-existing', `/uploads/${UPLOAD_FIXTURE_NAME}`, { contentType: 'image/png', isIndex: false });
  const upB = { ...upA, headers: { ...upA.headers, [CSP_HEADER]: null } };
  const up = compareReports(report([upA]), report([upB]));
  assert.equal(up.failures.length, 0);
  assert.equal(up.allowed[0].allowedBy, 'group:uploads');
});

test('N9 양방향: uploads 경로군을 지우면 /uploads 200 의 CSP 차이가 오탐 실패가 되고, spa 경로군에 CSP 를 넣으면 N7 이 통과해 버린다', () => {
  const upA = record('uploads-existing', `/uploads/${UPLOAD_FIXTURE_NAME}`, { contentType: 'image/png', isIndex: false });
  const upB = { ...upA, headers: { ...upA.headers, [CSP_HEADER]: null } };
  const withoutUploads = ALLOWED_DIFFS.filter((r) => r.scope !== 'group:uploads');
  assert.equal(compareReports(report([upA]), report([upB]), withoutUploads).failures.length, 1, 'uploads 경로군이 없으면 오탐');

  const spaA = record('do-list', '/list.do');
  const spaB = record('do-list', '/list.do', { headers: { [CSP_HEADER]: null } });
  const spaAllowsCsp = ALLOWED_DIFFS.map((r) => (r.scope === 'group:spa' ? { ...r, fields: [...r.fields, h(CSP_HEADER)] } : r));
  assert.equal(compareReports(report([spaA]), report([spaB]), spaAllowsCsp).failures.length, 0, 'CSP 를 허용에 넣으면 부재가 조용히 통과한다(공허화)');
});

test('보안 헤더 10종·캐시 4종의 차이는 전 경로군에서 허용 diff 이되 전부 세어진다', () => {
  const a = record('do-list', '/list.do');
  const gone = {};
  for (const name of OBSERVED_HEADERS) if (name !== CSP_HEADER) gone[name] = null;
  const b = record('do-list', '/list.do', { headers: gone });
  const result = compareReports(report([a]), report([b]));
  assert.equal(result.failures.length, 0);
  // a 에 값이 있던 헤더만 diff 다(x-frame-options · etag) — 나머지는 양쪽 다 null 이라 같다.
  assert.deepEqual(result.allowed.map((d) => d.field).sort(), [h('etag'), h('x-frame-options')]);
  assert.match(formatSummary(result), /허용 diff 2건/);
});

test('404 끼리의 본문·CSP 차이는 허용 diff 이고 상태·content-type·isIndex 차이는 실패 diff 다', () => {
  const a = record('api-unknown', '/api/unknown-path', { status: 404, contentType: 'text/html; charset=utf-8', isIndex: false, bodySha256: 'aa', bodyLength: 155, headers: { [CSP_HEADER]: "default-src 'none'" } });
  const b = { ...a, bodySha256: 'bb', bodyLength: 136, headers: { ...a.headers, [CSP_HEADER]: null } };
  const result = compareReports(report([a]), report([b]));
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.allowed.map((d) => d.field).sort(), ['bodyLength', 'bodySha256', h(CSP_HEADER)]);
  // spa 경로군의 404 도 같다(예: /assets/does-not-exist.js) — 본문은 허용, content-type 은 실패.
  const spaA = { ...a, name: 'asset-missing', rawPath: '/assets/does-not-exist.js', group: 'spa' };
  const spaB = { ...spaA, bodySha256: 'cc', contentType: 'text/html' };
  const spa = compareReports(report([spaA]), report([spaB]));
  assert.deepEqual(spa.failures.map((d) => d.field), ['contentType']);
  // 한쪽만 404 면 status:404 scope 가 붙지 않는다 — 상태 diff 자체가 실패다.
  assert.deepEqual(scopesFor({ group: 'spa', status: 404, cls: null }, { status: 200 }), ['group:spa']);
});

test('malformed 클래스: 상태·본문·content-type 차이는 허용 diff · 루트 밖 내용 노출은 실패 diff', () => {
  const a = record('escape-dotdot', '/../package.json', {}, 'malformed');
  const b = record('escape-dotdot', '/../package.json', { status: 400, contentType: 'text/html;charset=utf-8', bodySha256: 'zz', bodyLength: 435, isIndex: false, headers: { [CSP_HEADER]: null } }, 'malformed');
  const result = compareReports(report([a]), report([b]));
  assert.equal(result.failures.length, 0);
  assert.equal(result.allowed.length, 6);
  assert.ok(result.allowed.every((d) => d.allowedBy === 'class:malformed'));
  const leaked = { ...b, leaks: { packageJson: true, sqlite: false } };
  assert.deepEqual(compareReports(report([a]), report([leaked])).failures.map((d) => d.field), ['leaks.packageJson']);
  // cls 없는 같은 경로라면 상태 차이는 실패다 — 클래스 표식이 load-bearing 이다.
  const plainA = record('escape-plain', '/../package.json');
  const plainB = record('escape-plain', '/../package.json', { status: 400 });
  assert.equal(compareReports(report([plainA]), report([plainB])).failures.length, 1);
});

test('directory 클래스: 301 대 200 index 는 허용 diff 다', () => {
  const a = record('assets-dir', '/assets', { status: 301, isIndex: false, bodySha256: 'r', bodyLength: 156, headers: { [CSP_HEADER]: "default-src 'none'" } }, 'directory');
  const b = record('assets-dir', '/assets', {}, 'directory');
  const result = compareReports(report([a]), report([b]));
  assert.equal(result.failures.length, 0);
  assert.equal(result.allowed.length, 5);
});

test('요약 줄은 관측 수·실패 diff·허용 diff 건수를 항상 낸다', () => {
  const a = report([record('root', '/'), record('api-health', '/api/health', { contentType: 'application/json; charset=utf-8', isIndex: false })]);
  const b = structuredClone(a);
  b.observations[1].headers[CSP_HEADER] = null;
  const result = compareReports(a, b);
  assert.equal(formatSummary(result), 'spa-parity A=node B=spring 관측 2 · diffs 0 · 허용 diff 1건');
  const lines = formatDiffLines(result);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /allowed \[group:api headers\.content-security-policy\] 1건/);
  assert.match(lines[0], /api-health/);
  const failing = compareReports(a, report([b.observations[0]]));
  assert.match(formatSummary(failing), /diffs 1 · 허용 diff 0건/);
  assert.match(formatDiffLines(failing)[0], /FAIL only-in-A api-health/);
});
