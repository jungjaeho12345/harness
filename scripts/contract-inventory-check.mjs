// 계약 인벤토리 드리프트 검사 (phase 67 step0 — 기계 게이트 1).
// 하는 일 3가지:
//  1. server/index.js의 라우트 등록(app.<method>('<path>'))을 텍스트로 추출해
//     docs/api-contract/endpoints.json의 (method, path) 집합과 양방향 비교한다.
//     한쪽에만 있으면 그 목록을 출력하고 exit 1. — 라우트가 늘거나 줄면 인벤토리가 즉시 red가 된다.
//  2. endpoints.json 자체 검증: 최상위 shape({version,routes}) · 39행 · id 유일 ·
//     필드 필수값 · expect 태그 고정 어휘 · method 분포(GET 16/POST 19/PUT 3/DELETE 1) ·
//     id가 'x-'로 시작하지 않을 것(x-는 리포트의 "인벤토리 밖 관측" 전용 채널 — decisions (23)).
//  3. docs/api-contract/openapi.yaml에 인벤토리의 모든 path 문자열이 등장하는지 확인한다.
//     기본은 경고만(step3~step11이 채우는 중) — --require-spec-paths 플래그가 있을 때만 실패.
//
// 서버 코드는 읽기만 한다(무수정). YAML 파서 등 새 의존성 금지(decisions (3)) —
// openapi.yaml 검사는 텍스트 포함 여부까지만 자동 판정한다.
// scripts/**는 eslint ignore 대상이므로 인자 가드는 직접 짠다(값 플래그 없음 — 불리언 1개뿐).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SERVER_FILE = new URL('../server/index.js', import.meta.url);
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
const serverText = fs.readFileSync(SERVER_FILE, 'utf8');
const ROUTE_RE = /^\s*app\.(get|post|put|delete)\(\s*'([^']+)'/gm;
const serverRoutes = new Map(); // "METHOD path" -> true
for (const m of serverText.matchAll(ROUTE_RE)) {
  serverRoutes.set(`${m[1].toUpperCase()} ${m[2]}`, true);
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

// --- 3. openapi.yaml 경로 존재 검사 (기본 경고 — --require-spec-paths에서만 실패) ---
let specText = '';
try {
  specText = fs.readFileSync(OPENAPI_FILE, 'utf8');
} catch (e) {
  (requireSpecPaths ? errors : warnings).push(`openapi.yaml unreadable: ${e.message}`);
}
const specMissing = routes
  .filter((r) => typeof r.path === 'string' && !specText.includes(r.path))
  .map((r) => `${r.method} ${r.path}`);
const specPresent = routes.length - specMissing.length;
if (specMissing.length > 0) {
  if (requireSpecPaths) {
    for (const k of specMissing) errors.push(`path missing in openapi.yaml: ${k}`);
  } else {
    warnings.push(`openapi.yaml is missing ${specMissing.length} path(s) — informational until --require-spec-paths (step12)`);
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
