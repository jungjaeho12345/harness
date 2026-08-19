// 계약 인벤토리 드리프트 검사 (phase 67 step0 — 기계 게이트 1).
// 하는 일 3가지:
//  1. server/**의 라우트 등록(app.<method>('<path>'))을 텍스트로 추출해
//     docs/api-contract/endpoints.json의 (method, path) 집합과 양방향 비교한다.
//     한쪽에만 있으면 그 목록을 출력하고 exit 1. — 라우트가 늘거나 줄면 인벤토리가 즉시 red가 된다.
//  2. endpoints.json 자체 검증: 최상위 shape({version,routes}) · 39행 · id 유일 ·
//     필드 필수값 · expect 태그 고정 어휘 · **expect 최소 규칙**(아래 EXPECT 최소 규칙 절) ·
//     method 분포(GET 16/POST 19/PUT 3/DELETE 1) ·
//     id가 'x-'로 시작하지 않을 것(x-는 리포트의 "인벤토리 밖 관측" 전용 채널 — decisions (23)).
//  3. docs/api-contract/openapi.yaml의 paths 절에서 (method, path) 오퍼레이션을 추출해
//     인벤토리 39행과 양방향 비교한다. 인벤토리는 Express 실측 표기(':id'), OpenAPI는 표준
//     중괄호 표기('{id}')이므로 **두 표기를 정규화해** 맞춘다(step12).
//     기본은 경고만(step3~step11이 채우는 중) — --require-spec-paths 플래그가 있을 때만 실패.
//
// 서버 코드는 읽기만 한다(무수정). YAML 파서 등 새 의존성 금지(decisions (3)) —
// openapi.yaml 검사는 텍스트 포함 여부까지만 자동 판정한다.
// scripts/**는 eslint ignore 대상이므로 인자 가드는 직접 짠다(값 플래그 없음 — 불리언 1개뿐).
//
// 라우트 추출의 전제(알고 쓰는 한계 — 2026-08-19 리뷰 반영):
//  - 스캔 범위는 server/ 아래 .js 파일 전부다(현행 실측: 라우트 39건 전부 server/index.js).
//    src/**의 서비스·모델은 라우트를 등록하지 않으므로 스캔하지 않는다.
//  - 표기 전제: `app.<method>('<path>'` — **홑따옴표 리터럴**이고 Express 앱 변수명이 `app`이다.
//    express.Router() 분리·쌍따옴표/백틱·동적 경로 조립을 도입하면 그 라우트는 추출되지 않는다.
//  - 실패 방향은 안전하다: 기존 라우트가 추출되지 않으면 "route in inventory but missing in server"로
//    red가 난다(조용한 통과가 아니다). 다만 **새 라우트를 위 전제 밖 표기로 추가**하면 양쪽 모두에서
//    보이지 않아 조용히 통과한다 — 라우팅 표기를 바꾸는 변경은 이 추출기를 함께 고쳐야 한다.

import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SERVER_DIR = fileURLToPath(new URL('../server/', import.meta.url));
const INVENTORY_FILE = new URL('../docs/api-contract/endpoints.json', import.meta.url);
const OPENAPI_FILE = new URL('../docs/api-contract/openapi.yaml', import.meta.url);

const EXPECTED_TOTAL = 39;
const EXPECTED_BY_METHOD = { GET: 16, POST: 19, PUT: 3, DELETE: 1 };
const METHODS = new Set(Object.keys(EXPECTED_BY_METHOD));
const AUTH_SET = new Set(['public', 'session', 'session-role', 'admin', 'token', 'lock-holder']);
const PROFILE_SET = new Set(['default', 'minimal', 'failclosed', 'auth-negative', 'prod-cookie']);
const EXPECT_TAGS = new Set([
  'success', 'unauthenticated', 'forbidden', 'not-found', 'validation',
  'conflict', 'disabled', 'locked', 'rate-limited', 'graceful',
]);
const ROLE_SET = new Set(['R', 'D', 'Z']);

// --- 인자 가드 (불리언 플래그 1개만 허용 — 미지 인자는 즉시 실패) ---
let requireSpecPaths = false;
for (const arg of process.argv.slice(2)) {
  if (arg === '--require-spec-paths') { requireSpecPaths = true; continue; }
  process.stderr.write(`unknown argument: ${arg}\nusage: node scripts/contract-inventory-check.mjs [--require-spec-paths]\n`);
  process.exit(1);
}

const errors = [];
const warnings = [];

// --- 1. 서버 라우트 표 추출 (텍스트 실측 — 코드가 정본) ---
// 전제와 한계는 파일 머리말 "라우트 추출의 전제" 참조.
function serverJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...serverJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const ROUTE_RE = /^\s*app\.(get|post|put|delete)\(\s*'([^']+)'/gm;
const serverRoutes = new Map(); // "METHOD path" -> true
for (const file of serverJsFiles(SERVER_DIR)) {
  for (const m of fs.readFileSync(file, 'utf8').matchAll(ROUTE_RE)) {
    serverRoutes.set(`${m[1].toUpperCase()} ${m[2]}`, true);
  }
}

// --- 2. 인벤토리 자체 검증 ---
let inventory;
try {
  inventory = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
} catch (e) {
  process.stderr.write(`endpoints.json parse failed: ${e.message}\n`);
  process.exit(1);
}

const topKeys = Object.keys(inventory ?? {}).sort();
if (topKeys.join(',') !== 'routes,version') {
  errors.push(`top-level shape must be exactly {version, routes} — got keys: ${topKeys.join(', ')}`);
}
if (inventory?.version !== 1) errors.push(`version must be 1 — got ${JSON.stringify(inventory?.version)}`);
const routes = Array.isArray(inventory?.routes) ? inventory.routes : [];
if (!Array.isArray(inventory?.routes)) errors.push('routes must be an array');
if (routes.length !== EXPECTED_TOTAL) {
  errors.push(`routes length must be ${EXPECTED_TOTAL} — got ${routes.length}`);
}

const seenIds = new Set();
const seenMethodPath = new Set();
const methodCount = { GET: 0, POST: 0, PUT: 0, DELETE: 0 };
routes.forEach((r, i) => {
  const at = `routes[${i}]${r?.id ? ` (${r.id})` : ''}`;
  if (!r || typeof r !== 'object') { errors.push(`${at}: not an object`); return; }
  const allowedKeys = new Set(['id', 'method', 'path', 'auth', 'roles', 'profile', 'expect', 'sse', 'notes']);
  for (const k of Object.keys(r)) if (!allowedKeys.has(k)) errors.push(`${at}: unknown field '${k}'`);

  if (typeof r.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(r.id)) errors.push(`${at}: id must be non-empty kebab-case`);
  if (typeof r.id === 'string' && r.id.startsWith('x-')) errors.push(`${at}: id must not start with 'x-' (reserved for out-of-inventory observations)`);
  if (seenIds.has(r.id)) errors.push(`${at}: duplicate id '${r.id}'`);
  seenIds.add(r.id);

  if (!METHODS.has(r.method)) errors.push(`${at}: method must be GET|POST|PUT|DELETE — got ${JSON.stringify(r.method)}`);
  else methodCount[r.method] += 1;
  if (typeof r.path !== 'string' || !r.path.startsWith('/api/')) errors.push(`${at}: path must start with '/api/'`);
  const key = `${r.method} ${r.path}`;
  if (seenMethodPath.has(key)) errors.push(`${at}: duplicate (method, path) '${key}'`);
  seenMethodPath.add(key);

  if (!AUTH_SET.has(r.auth)) errors.push(`${at}: auth must be one of ${[...AUTH_SET].join('|')}`);
  if (r.roles !== undefined) {
    if (!Array.isArray(r.roles) || r.roles.length === 0 || r.roles.some((x) => !ROLE_SET.has(x))) {
      errors.push(`${at}: roles must be a non-empty array of R|D|Z`);
    }
    if (r.auth !== 'session-role') errors.push(`${at}: roles is only allowed with auth 'session-role'`);
  } else if (r.auth === 'session-role') {
    errors.push(`${at}: auth 'session-role' requires roles`);
  }
  if (!PROFILE_SET.has(r.profile)) errors.push(`${at}: profile must be one of ${[...PROFILE_SET].join('|')}`);
  if (!Array.isArray(r.expect) || r.expect.length === 0) {
    errors.push(`${at}: expect must be a non-empty array`);
  } else {
    for (const tag of r.expect) if (!EXPECT_TAGS.has(tag)) errors.push(`${at}: unknown expect tag '${tag}'`);
    if (new Set(r.expect).size !== r.expect.length) errors.push(`${at}: expect has duplicate tags`);

    // --- EXPECT 최소 규칙 (2026-08-19 리뷰 반영) ---
    // expect는 커버리지 게이트의 **입력**이다. 태그를 지우면 그 축이 조용히 미검증이 되고,
    // 게이트는 여전히 39/39 green을 낸다. 아래 두 규칙은 그 편집을 red로 만든다.
    const expectSet = new Set(r.expect);
    // (a) 보호 라우트는 미인증 거부 계약을 반드시 동결한다.
    if (r.auth !== 'public' && !expectSet.has('unauthenticated')) {
      errors.push(`${at}: auth '${r.auth}'는 보호 라우트다 — expect에 'unauthenticated'가 있어야 한다(미인증 축을 지우면 커버리지 게이트가 그 공백을 못 본다)`);
    }
    // (b) 역할 게이트가 있는 라우트는 인가 거부(403) 계약을 반드시 동결한다.
    //     대상: auth 'admin'(Z 전용) + auth 'session-role' 중 roles가 R/D/Z 전부는 아닌 행.
    //     **제외: roles가 R·D·Z 전부인 행**(현행 실측 3행 — articles-create·articles-action·articles-derive).
    //     근거: 정상 사용자 role이 전부 허용이라 403(unknown-role)에 도달할 HTTP 경로가 없다.
    //     가짜 role 계정을 만들어 로그인하는 것은 로그인 예산 규율(decisions (8))과 충돌해 스위트가
    //     만들 수 없는 상태다(README '미검증·미동결 목록'에 소유자와 함께 기록돼 있다).
    //     이 3행에 forbidden을 요구하면 도달 불가 태그가 커버리지 게이트를 영구 red로 만든다.
    const rolesCoverAllRoles = Array.isArray(r.roles)
      && [...ROLE_SET].every((role) => r.roles.includes(role));
    const roleGated = r.auth === 'admin' || (r.auth === 'session-role' && !rolesCoverAllRoles);
    if (roleGated && !expectSet.has('forbidden')) {
      const rolesNote = Array.isArray(r.roles) ? ` roles=${r.roles.join(',')}` : '';
      errors.push(`${at}: 역할 게이트 라우트다(auth '${r.auth}'${rolesNote}) — expect에 'forbidden'이 있어야 한다`);
    }
  }
  if (r.sse !== undefined && r.sse !== true) errors.push(`${at}: sse must be true or omitted`);
  if (typeof r.notes !== 'string' || !r.notes.trim()) errors.push(`${at}: notes must be a non-empty string`);
});

for (const [method, expected] of Object.entries(EXPECTED_BY_METHOD)) {
  if (methodCount[method] !== expected) {
    errors.push(`method distribution: ${method} must be ${expected} — got ${methodCount[method]}`);
  }
}

// --- 1(계속). 양방향 비교: 서버 라우트 표 <-> 인벤토리 ---
const missingInInventory = [...serverRoutes.keys()].filter((k) => !seenMethodPath.has(k));
const missingInServer = [...seenMethodPath].filter((k) => !serverRoutes.has(k));
for (const k of missingInInventory) errors.push(`route in server but missing in inventory: ${k}`);
for (const k of missingInServer) errors.push(`route in inventory but missing in server: ${k}`);

// --- 3. openapi.yaml 오퍼레이션 대조 (기본 경고 — --require-spec-paths에서만 실패) ---
// 표기 정규화: 인벤토리는 Express 실측 표기('/api/articles/:id'), OpenAPI는 표준 템플릿 표기
// ('/api/articles/{id}')다. 예전 구현은 YAML **텍스트 전체**에 콜론 표기 문자열이 있는지만 봤는데,
// 그러면 주석 한 줄('# ... /api/users/:id ...')이 게이트를 통과시키고 그 주석이 병합 중 사라지면
// 아무도 건드리지 않은 게이트가 red가 된다(실제로 발생했다). 표기를 정규화해 비교하면 주석 의존이 사라진다.
function toSpecPath(expressPath) {
  return expressPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

// paths 절의 (path, method) 추출 — YAML 파서를 들이지 않는다는 제약(decisions (3)) 아래에서
// 가능한 가장 강한 검사다. 들여쓰기 규약에 기댄다: 경로 키 2칸, 메서드 키 4칸(이 문서의 실측 형식).
// 주석·x- 확장 키(x-express-path 등)는 오퍼레이션이 아니므로 자연히 걸러진다.
const HTTP_METHODS = 'get|post|put|delete|patch|head|options|trace';
function extractSpecOperations(text) {
  const ops = new Set();
  let inPaths = false;
  let currentPath = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^[^\s#]/.test(line)) { // 최상위 키 — paths 절 진입/이탈 판정
      inPaths = /^paths:\s*$/.test(line);
      currentPath = null;
      continue;
    }
    if (!inPaths) continue;
    const pathKey = line.match(/^ {2}(\/\S*):\s*(#.*)?$/);
    if (pathKey) { currentPath = pathKey[1]; continue; }
    const opKey = line.match(new RegExp(`^ {4}(${HTTP_METHODS}):\\s*(#.*)?$`));
    if (opKey && currentPath) ops.add(`${opKey[1].toUpperCase()} ${currentPath}`);
  }
  return ops;
}

let specText = '';
try {
  specText = fs.readFileSync(OPENAPI_FILE, 'utf8');
} catch (e) {
  (requireSpecPaths ? errors : warnings).push(`openapi.yaml unreadable: ${e.message}`);
}
const specOps = extractSpecOperations(specText);
const inventoryOps = new Map(); // "METHOD 스펙표기경로" -> "METHOD 실측(콜론)경로"
for (const r of routes) {
  if (typeof r.path !== 'string' || !METHODS.has(r.method)) continue;
  inventoryOps.set(`${r.method} ${toSpecPath(r.path)}`, `${r.method} ${r.path}`);
}
const specMissing = [...inventoryOps.entries()].filter(([specKey]) => !specOps.has(specKey)).map(([, expressKey]) => expressKey);
const specExtra = [...specOps].filter((k) => !inventoryOps.has(k));
const specPresent = inventoryOps.size - specMissing.length;
if (specMissing.length > 0 || specExtra.length > 0) {
  if (requireSpecPaths) {
    for (const k of specMissing) errors.push(`operation missing in openapi.yaml: ${k}`);
    for (const k of specExtra) errors.push(`operation in openapi.yaml but missing in inventory: ${k}`);
  } else {
    if (specMissing.length > 0) {
      warnings.push(`openapi.yaml is missing ${specMissing.length} operation(s) — informational until --require-spec-paths (step12)`);
    }
    for (const k of specExtra) warnings.push(`operation in openapi.yaml but missing in inventory: ${k}`);
  }
}

// --- 판정 ---
for (const w of warnings) process.stdout.write(`warn: ${w}\n`);
if (errors.length > 0) {
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  process.stderr.write(`inventory-drift errors=${errors.length} (root=${repoRoot})\n`);
  process.exit(1);
}
process.stdout.write(
  `inventory-ok routes=${routes.length} methods=GET:${methodCount.GET},POST:${methodCount.POST},`
  + `PUT:${methodCount.PUT},DELETE:${methodCount.DELETE} spec-paths=${specPresent}/${routes.length}\n`,
);
process.exit(0);
