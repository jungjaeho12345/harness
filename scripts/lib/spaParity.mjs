// SPA 응답 대조기의 **순수 판정부** (phase 76 step3) — 요청 표 · 관측 헤더 상수 · 허용 diff 분류 · 리포트 비교 ·
// 원시 HTTP 응답 파서. 부수효과(spawn·fs·net·env)는 여기 두지 않는다 — 전부 scripts/spa-parity.mjs 의 몫이다.
//
// 왜 별도 모듈인가: scripts/spa-parity.mjs 는 import 시점에 main() 을 실행하므로(spring-contract.mjs 와 같은 이유)
// 그 안의 함수를 가져다 시험할 수 없다. 여기 있는 것은 **틀리면 대조가 조용히 공허해지는** 종류의 코드다 —
// 관측 헤더를 하나 빠뜨리거나 허용 목록에 CSP 를 넣으면 diffs 0 이 아무 뜻도 없어진다(step3 변이 N4·N8).
// 잠금은 scripts/lib/spaParity.self-test.mjs 가 한다(`node --test scripts/lib/spaParity.self-test.mjs`).
//
// CRITICAL(허용 diff 는 결정이다): ALLOWED_DIFFS 를 늘리려면 docs/cutover-p3.md §2 에 축·현재 값·이유·대체 방어선을
//   함께 적어라. 그리고 어떤 경우에도 **조용히 빼지 않는다** — 허용 diff 도 전부 리포트·요약 줄에 센다.
// CRITICAL(리포트 위생): 관측 레코드에는 요청 이름·메서드·요청 경로·상태·헤더 원문·본문 sha256/길이/불리언만 싣는다.
//   본문 내용·절대경로·세션 토큰은 싣지 않는다(경로 탈출 시험은 "내용이 실렸는가" 불리언으로만 기록한다).

import { createHash } from 'node:crypto';

// --- 관측 헤더 (Node 응답 실측으로 확정 — 2026-09-07 원시 소켓, helmet@8.2.0) ---
// 계획서의 추정 11종에 `x-xss-protection`(helmet 이 `0` 으로 보낸다)을 더한 12종이 실측 집합이다.
// `strict-transport-security` 는 Node 도 비프로덕션에서 보내지 않지만 **부재를 관측**하기 위해 둔다(HSTS 가
// 어느 쪽에든 켜지면 diff 로 드러나야 한다 — 평문 LAN 배치에서 접속이 깨지는 축이다).
export const CSP_HEADER = 'content-security-policy';

export const SECURITY_HEADERS = Object.freeze([
  CSP_HEADER,
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

// 캐시·조건부 요청 축 — 알려진 divergence(Node 만 ETag·Cache-Control 을 낸다)지만 **빼지 않고** 허용 diff 로 센다.
export const CACHE_HEADERS = Object.freeze(['accept-ranges', 'cache-control', 'etag', 'last-modified']);

export const OBSERVED_HEADERS = Object.freeze([...SECURITY_HEADERS, ...CACHE_HEADERS]);

// 관측 레코드의 비교 필드(헤더 제외). 순서는 리포트 출력 순서다.
export const RECORD_FIELDS = Object.freeze([
  'status', 'contentType', 'hasContentLength', 'bodySha256', 'bodyLength', 'isIndex',
  'leaks.packageJson', 'leaks.sqlite',
]);

const headerField = (name) => `headers.${name}`;

// --- 경로군 · 요청 클래스 ---
// 경로군은 Node isSpaFallbackRequest 의 예약 접두사 규칙과 같은 판정이다(소문자화 · 정확 일치 또는 하위 경로).
export const PATH_GROUPS = Object.freeze(['spa', 'api', 'uploads']);

export function classifyPath(rawPath) {
  const question = rawPath.indexOf('?');
  const lower = (question < 0 ? rawPath : rawPath.slice(0, question)).toLowerCase();
  for (const [prefix, group] of [['/api', 'api'], ['/uploads', 'uploads']]) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) return group;
  }
  return 'spa';
}

// 요청 클래스 — 핸들러 **앞단**(컨테이너 커넥터 · express.static 의 리다이렉트)이 응답을 만드는 항목의 표식.
//  malformed: Tomcat 커넥터가 요청줄 단계에서 400 으로 거절하는 URI(`..` 상위 탈출 · `%2f` · 백슬래시 · `%00`).
//             Express 는 정적 미들웨어가 거부한 뒤 next() 로 흘려 SPA 폴백 200 을 준다. 양쪽 다 루트 밖 내용을
//             싣지 않는다(leaks.* 는 이 클래스에서도 실패 diff 다).
//  directory: 실재하는 디렉토리 경로(`/assets`). express.static 은 `redirect:true` 로 301 → `/assets/` 를 내고
//             Spring 리소스 핸들러는 디렉토리를 못 찾은 자산으로 보아 SPA 폴백 200 을 준다.
export const REQUEST_CLASSES = Object.freeze(['malformed', 'directory']);

// --- 허용 diff 분류 (scope × field) — 이 표가 "이 phase 가 알고도 남겨 둔 차이" 의 전부다 ---
// scope 형태: `group:<spa|api|uploads>` (요청 경로로 판정) · `status:404` (양쪽 상태가 모두 404) · `class:<cls>`.
// 한 diff 는 적용 가능한 scope 중 하나라도 그 field 를 허용하면 허용 diff 다. **CSP 는 `group:spa` 에 없다** —
// SPA 문서·자산(200) 의 CSP 차이는 실패 diff 다(step2 작업 D 와 같은 경계).
const SECURITY_WITHOUT_CSP = SECURITY_HEADERS.filter((name) => name !== CSP_HEADER).map(headerField);
const CACHE_FIELDS = CACHE_HEADERS.map(headerField);
const CSP_FIELD = headerField(CSP_HEADER);

export const ALLOWED_DIFFS = Object.freeze([
  {
    scope: 'group:spa',
    fields: Object.freeze([...SECURITY_WITHOUT_CSP, ...CACHE_FIELDS]),
    reason: 'Node helmet 의 보안 헤더 10종(+HSTS 부재 관측)과 express.static 의 ETag·Cache-Control 을 Spring 은 내지 않는다 — 3연속 이월(excluded (d) ②)',
    defense: 'CSP 는 이 경로군에서 실패 diff · 상태·content-type·본문 sha256 은 실패 diff',
  },
  {
    scope: 'group:api',
    fields: Object.freeze([CSP_FIELD, ...SECURITY_WITHOUT_CSP, ...CACHE_FIELDS]),
    reason: 'Spring /api 응답에는 보안 헤더가 없다(현재 설계 · 런북 §0 낭독 대상) · Node 만 JSON 에 ETag 를 붙인다',
    defense: '39 라우트 응답 shape 은 계약 313관측이 잠근다',
  },
  {
    scope: 'group:uploads',
    fields: Object.freeze([CSP_FIELD, ...SECURITY_WITHOUT_CSP, ...CACHE_FIELDS]),
    reason: 'Spring /uploads 응답에는 보안 헤더가 없다(현재 설계 · CSP 경계는 SpaServingWireTest 가 잠근다)',
    defense: '상태·content-type·본문 sha256 은 실패 diff(UploadsStaticWireTest 와 이중)',
  },
  {
    scope: 'status:404',
    fields: Object.freeze(['bodySha256', 'bodyLength', CSP_FIELD]),
    reason: 'Node 404 는 express finalhandler(요청 경로를 본문에 반향 · CSP default-src none) · Spring 404 는 HtmlErrors(입력 비반향 고정 본문 · P1 결정) — 본문은 계약이 아니다',
    defense: '상태 404 · content-type 원문(text/html; charset=utf-8) · isIndex=false 는 실패 diff',
  },
  {
    scope: 'class:malformed',
    fields: Object.freeze(['status', 'contentType', 'bodySha256', 'bodyLength', 'isIndex', CSP_FIELD]),
    reason: 'Tomcat 커넥터가 요청줄 단계에서 400 으로 거절(완화하면 보안 하향) · Express 는 fallthrough 로 SPA 200',
    defense: 'leaks.packageJson·leaks.sqlite 는 실패 diff — 양쪽 다 루트 밖 내용을 싣지 않아야 한다',
  },
  {
    scope: 'class:directory',
    fields: Object.freeze(['status', 'contentType', 'bodySha256', 'bodyLength', 'isIndex', CSP_FIELD]),
    reason: 'express.static redirect:true 의 301 → /assets/ 대 Spring 의 SPA 폴백 200 — 디렉토리 목록은 양쪽 다 없다',
    defense: 'leaks.* 는 실패 diff · /assets/ (끝 슬래시) 는 양쪽 다 200 index.html 로 strict 비교된다',
  },
]);

// --- 요청 표 ---
// 각 항목 { name, method, rawPath | asset, headers, cls? }. rawPath 는 **원문 요청줄**에 그대로 들어간다(정규화 금지).
// asset:'script'|'style' 은 실행 시 index.html 에서 추출한 실제 해시 파일명으로 치환된다(해시를 하드코딩하지 않는다).
export const HTML_ACCEPT = 'text/html,application/xhtml+xml,*/*;q=0.8';

export const UPLOAD_FIXTURE_NAME = '0123456789abcdef0123456789abcdef.png';

const BACKSLASH = String.fromCharCode(92);
const html = { Accept: HTML_ACCEPT };
const any = { Accept: '*/*' };

export const REQUESTS = Object.freeze([
  { name: 'root', method: 'GET', rawPath: '/', headers: {} },
  { name: 'do-login', method: 'GET', rawPath: '/login.do', headers: html },
  { name: 'do-writer', method: 'GET', rawPath: '/writer.do', headers: html },
  { name: 'do-list', method: 'GET', rawPath: '/list.do', headers: html },
  { name: 'do-rcvMgmt', method: 'GET', rawPath: '/rcvMgmt.do', headers: html },
  { name: 'do-userMgmt', method: 'GET', rawPath: '/userMgmt.do', headers: html },
  { name: 'do-logs', method: 'GET', rawPath: '/logs.do', headers: html },
  { name: 'do-distMgmt', method: 'GET', rawPath: '/distMgmt.do', headers: html },
  { name: 'do-writer-query', method: 'GET', rawPath: '/writer.do?articleId=A1', headers: html },
  { name: 'head-list', method: 'HEAD', rawPath: '/list.do', headers: html },
  { name: 'asset-script', method: 'GET', asset: 'script', headers: any },
  { name: 'asset-style', method: 'GET', asset: 'style', headers: { Accept: 'text/css,*/*;q=0.1' } },
  { name: 'asset-missing', method: 'GET', rawPath: '/assets/does-not-exist.js', headers: any },
  { name: 'index-html', method: 'GET', rawPath: '/index.html', headers: html },
  { name: 'assets-dir', method: 'GET', rawPath: '/assets', headers: html, cls: 'directory' },
  { name: 'assets-dir-slash', method: 'GET', rawPath: '/assets/', headers: html },
  { name: 'api-health', method: 'GET', rawPath: '/api/health', headers: html },
  { name: 'api-articles-unauth', method: 'GET', rawPath: '/api/articles', headers: html },
  { name: 'api-stream-unauth', method: 'GET', rawPath: '/api/stream', headers: html },
  { name: 'api-unknown', method: 'GET', rawPath: '/api/unknown-path', headers: html },
  { name: 'api-does-not-exist', method: 'GET', rawPath: '/api/does-not-exist', headers: html },
  { name: 'api-upper', method: 'GET', rawPath: '/API/unknown', headers: html },
  { name: 'uploads-missing', method: 'GET', rawPath: '/uploads/missing.png', headers: html },
  { name: 'uploads-existing', method: 'GET', rawPath: `/uploads/${UPLOAD_FIXTURE_NAME}`, headers: any },
  { name: 'post-list', method: 'POST', rawPath: '/list.do', headers: html },
  { name: 'escape-dotdot', method: 'GET', rawPath: '/../package.json', headers: html, cls: 'malformed' },
  { name: 'escape-encoded-slash', method: 'GET', rawPath: '/..%2f..%2fpackage.json', headers: html, cls: 'malformed' },
  { name: 'escape-encoded-dot', method: 'GET', rawPath: '/%2e%2e/%2e%2e/news.db', headers: html, cls: 'malformed' },
  { name: 'escape-double-encoded', method: 'GET', rawPath: '/%252e%252e/%252e%252e/package.json', headers: html },
  { name: 'escape-backslash', method: 'GET', rawPath: `/assets${BACKSLASH}..${BACKSLASH}..${BACKSLASH}package.json`, headers: html, cls: 'malformed' },
  { name: 'escape-encoded-backslash', method: 'GET', rawPath: '/assets%5c..%5c..%5cpackage.json', headers: html, cls: 'malformed' },
  { name: 'escape-null-byte', method: 'GET', rawPath: '/list.do%00', headers: html, cls: 'malformed' },
  { name: 'trailing-slash', method: 'GET', rawPath: '/list.do/', headers: html },
  { name: 'dotfile-dir', method: 'GET', rawPath: '/.hidden/x', headers: html },
  { name: 'dotfile-env', method: 'GET', rawPath: '/.env', headers: html },
  { name: 'matrix-param', method: 'GET', rawPath: '/list.do;a=b', headers: html },
  { name: 'case-variant', method: 'GET', rawPath: '/List.do', headers: html },
  { name: 'win-device-name', method: 'GET', rawPath: '/NUL', headers: html },
]);

export const MIN_REQUESTS = 30;

// 표 검증 — 중복 name 은 **즉시 실패**다(조용한 덮어쓰기는 관측 수를 줄이면서 diffs 0 을 남긴다).
export function validateRequestTable(table) {
  if (!Array.isArray(table) || table.length < MIN_REQUESTS) {
    throw new Error(`요청 표가 너무 작다(${Array.isArray(table) ? table.length : '배열 아님'} < ${MIN_REQUESTS}) — 관측 수가 줄면 diffs 0 의 뜻이 줄어든다`);
  }
  const seen = new Set();
  for (const entry of table) {
    if (typeof entry.name !== 'string' || entry.name === '') throw new Error('요청 표 항목에 name 이 없다');
    if (seen.has(entry.name)) throw new Error(`요청 표에 중복 name 이 있다: ${entry.name} — 조용한 덮어쓰기 금지`);
    seen.add(entry.name);
    if (!['GET', 'HEAD', 'POST'].includes(entry.method)) throw new Error(`요청 표 ${entry.name}: 메서드가 유효하지 않다(${entry.method})`);
    const hasRaw = typeof entry.rawPath === 'string' && entry.rawPath.startsWith('/');
    const hasAsset = entry.asset === 'script' || entry.asset === 'style';
    if (hasRaw === hasAsset) throw new Error(`요청 표 ${entry.name}: rawPath('/...') 와 asset('script'|'style') 중 정확히 하나여야 한다`);
    if (entry.cls !== undefined && !REQUEST_CLASSES.includes(entry.cls)) throw new Error(`요청 표 ${entry.name}: 알 수 없는 cls(${entry.cls})`);
    if (entry.headers === null || typeof entry.headers !== 'object') throw new Error(`요청 표 ${entry.name}: headers 가 객체가 아니다`);
  }
  return table;
}

// index.html 에서 자산 경로를 뽑는다(정본 E22 와 같은 정규식 — 해시를 하드코딩하지 않는다).
export function extractAssetPaths(indexHtml) {
  const script = /<script[^>]*\bsrc="([^"]+)"/.exec(indexHtml);
  const style = /<link[^>]*rel="stylesheet"[^>]*\bhref="([^"]+)"/.exec(indexHtml);
  if (!script) throw new Error('index.html 에 <script src> 가 없다 — 대조할 스크립트 자산이 없다');
  if (!style) throw new Error('index.html 에 <link rel="stylesheet" href> 가 없다 — 대조할 스타일 자산이 없다');
  return { script: script[1], style: style[1] };
}

export function resolveRequestTable(table, assets) {
  return validateRequestTable(table).map((entry) => {
    if (!entry.asset) return { ...entry };
    const rawPath = assets[entry.asset];
    if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) throw new Error(`자산 경로를 해석하지 못했다: ${entry.asset}`);
    const { asset, ...rest } = entry;
    return { ...rest, rawPath };
  });
}

// --- 원시 HTTP 응답 파서 (Connection: close · EOF 까지 읽은 바이트) ---
// 헤더 이름은 소문자화하되 **값은 원문**이다. 같은 이름이 여럿이면 첫 값만 둔다.
export function parseHttpResponse(buffer, { head = false } = {}) {
  const text = buffer.toString('latin1');
  const end = text.indexOf('\r\n\r\n');
  if (end < 0) throw new Error('HTTP 응답 헤더 종단(CRLFCRLF)이 없다');
  const lines = text.slice(0, end).split('\r\n');
  const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0]);
  if (!statusMatch) throw new Error(`상태줄을 읽지 못했다: ${JSON.stringify(lines[0].slice(0, 40))}`);
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).replace(/^ +/, '').replace(/[ \t]+$/, '');
    if (!headers.has(name)) headers.set(name, value);
  }
  let body = buffer.subarray(end + 4);
  if (head) body = Buffer.alloc(0);
  else if ((headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) body = decodeChunked(body);
  else if (headers.has('content-length')) body = body.subarray(0, Number(headers.get('content-length')));
  return { status: Number(statusMatch[1]), headers, body };
}

export function decodeChunked(buffer) {
  const parts = [];
  let offset = 0;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', offset, 'latin1');
    if (lineEnd < 0) throw new Error('chunked 본문의 크기 줄이 없다');
    const size = parseInt(buffer.toString('latin1', offset, lineEnd).split(';')[0].trim(), 16);
    if (Number.isNaN(size)) throw new Error('chunked 크기를 읽지 못했다');
    offset = lineEnd + 2;
    if (size === 0) break;
    parts.push(buffer.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(parts);
}

// --- 관측 레코드 ---
export const LEAK_MARKERS = Object.freeze({
  packageJson: 'article-production-system', // 리포 package.json 의 name — 정본 C17 과 같은 표식
  sqlite: 'SQLite format 3', // SQLite 파일 매직
});

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function observe(entry, response, { indexSha256 }) {
  const latin1 = response.body.toString('latin1');
  const headers = {};
  for (const name of OBSERVED_HEADERS) headers[name] = response.headers.has(name) ? response.headers.get(name) : null;
  return {
    name: entry.name,
    method: entry.method,
    rawPath: entry.rawPath,
    group: classifyPath(entry.rawPath),
    cls: entry.cls ?? null,
    status: response.status,
    contentType: response.headers.has('content-type') ? response.headers.get('content-type') : null,
    hasContentLength: response.headers.has('content-length'),
    bodySha256: sha256Hex(response.body),
    bodyLength: response.body.length,
    isIndex: response.body.length > 0 && sha256Hex(response.body) === indexSha256,
    leaks: {
      packageJson: latin1.includes(LEAK_MARKERS.packageJson),
      sqlite: latin1.includes(LEAK_MARKERS.sqlite),
    },
    headers,
  };
}

function fieldValue(record, field) {
  if (field.startsWith('headers.')) return record.headers[field.slice('headers.'.length)];
  if (field.startsWith('leaks.')) return record.leaks[field.slice('leaks.'.length)];
  return record[field];
}

export function comparedFields() {
  return [...RECORD_FIELDS, ...OBSERVED_HEADERS.map(headerField)];
}

// 이 diff 에 적용되는 scope 들 — 경로군은 항상, status:404 는 양쪽 404 일 때, class 는 표에 적힌 항목만.
export function scopesFor(recordA, recordB) {
  const scopes = [`group:${recordA.group}`];
  if (recordA.status === 404 && recordB.status === 404) scopes.push('status:404');
  if (recordA.cls) scopes.push(`class:${recordA.cls}`);
  return scopes;
}

export function allowingRule(scopes, field, rules = ALLOWED_DIFFS) {
  for (const rule of rules) {
    if (scopes.includes(rule.scope) && rule.fields.includes(field)) return rule;
  }
  return null;
}

// 두 리포트 비교 — 반환 { observationCount, diffs, failures, allowed }.
// diff: { name, kind: 'only-in-A'|'only-in-B'|'value-diff', field?, a?, b?, allowedBy?: scope }
export function compareReports(reportA, reportB, rules = ALLOWED_DIFFS) {
  const byName = (report) => new Map((report.observations ?? []).map((o) => [o.name, o]));
  const a = byName(reportA);
  const b = byName(reportB);
  const diffs = [];
  for (const name of a.keys()) if (!b.has(name)) diffs.push({ name, kind: 'only-in-A' });
  for (const name of b.keys()) if (!a.has(name)) diffs.push({ name, kind: 'only-in-B' });
  const fields = comparedFields();
  for (const [name, recordA] of a) {
    const recordB = b.get(name);
    if (!recordB) continue;
    const scopes = scopesFor(recordA, recordB);
    for (const field of fields) {
      const va = fieldValue(recordA, field);
      const vb = fieldValue(recordB, field);
      if (va === vb) continue;
      const rule = allowingRule(scopes, field, rules);
      diffs.push({ name, kind: 'value-diff', field, a: va, b: vb, allowedBy: rule ? rule.scope : undefined });
    }
  }
  const failures = diffs.filter((d) => d.kind !== 'value-diff' || !d.allowedBy);
  const allowed = diffs.filter((d) => d.kind === 'value-diff' && d.allowedBy);
  const paired = [...a.keys()].filter((name) => b.has(name)).length;
  return { observationCount: paired, diffs, failures, allowed };
}

// 요약 줄 — 관측 수·실패 diff 수·허용 diff 수를 **항상** 낸다(0 이어도 숨기지 않는다).
export function formatSummary(result, labelA = 'node', labelB = 'spring') {
  return `spa-parity A=${labelA} B=${labelB} 관측 ${result.observationCount} · diffs ${result.failures.length} · 허용 diff ${result.allowed.length}건`;
}

const show = (v) => (v === null || v === undefined ? 'null' : JSON.stringify(String(v)));

// 실패 diff 는 한 줄씩, 허용 diff 는 (scope, field) 로 묶어 항목 이름을 나열한다(빠짐없이 — 조용히 빼지 않는다).
export function formatDiffLines(result) {
  const lines = [];
  for (const d of result.failures) {
    if (d.kind !== 'value-diff') lines.push(`  FAIL ${d.kind} ${d.name}`);
    else lines.push(`  FAIL ${d.name} ${d.field}: A=${show(d.a)} B=${show(d.b)}`);
  }
  const grouped = new Map();
  for (const d of result.allowed) {
    const key = `${d.allowedBy} ${d.field}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(d);
  }
  for (const [key, list] of grouped) {
    const sample = list[0];
    lines.push(`  allowed [${key}] ${list.length}건 (예: ${sample.name} A=${show(sample.a).slice(0, 60)} B=${show(sample.b).slice(0, 60)}) — ${list.map((d) => d.name).join(',')}`);
  }
  return lines;
}
