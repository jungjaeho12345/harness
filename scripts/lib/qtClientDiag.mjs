// scripts/verify-qt-client.mjs 의 순수 판정부 (phase 77 step6 — Qt 네이티브 클라 자동 검증 v1).
// 부수효과 없는 판정만 둔다. 파일 읽기는 loadContractRouteIds 가 **인자로 받은 경로 하나**만 읽는다.
// 자기검사: node --test scripts/lib/qtClientDiag.self-test.mjs (드라이버가 시작 시 스스로 돌린다).
//
// 왜 이 판정이 필요한가: 네이티브 클라에는 CDP 가 없다. 앱이 한 일의 기계 판독 가능한 기록은
// diag JSONL(client-qt/src/shell/diag.h — client/diag.js 계약 승계) 하나뿐이고, 드라이버는 그것을
// 서버 측 사실(/api/health · 데이터 스냅샷 · 임시 폴더의 디스크 사실)과 교차해 판정한다(ADR-018 (2)).
// diag 는 앱의 자기 신고라 **여기의 판정만으로 green 을 내지 않는다** — 교차는 드라이버가 소유한다.
//
// 공허 통과 차단 규율(test/harness-vacuity-guards.test.js 와 같은 축): 빈 시퀀스 · 빈 허용 집합 ·
// 최소 관측 0 · 계약에 없는 금지/기대 라우트는 판정 전에 **던진다**(항상 ok 가 되는 판정을 만들 수 없게).

import fs from 'node:fs';

// --- diag JSONL 형식 계약 ---
// ts 는 diag.cpp isoTimestamp 의 형식(UTC · 밀리초 3자리 · Z) 그대로다.
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// JSONL → { lines: [{ts,event,...}], rejected: [{lineNo, reason}] }. 깨진 줄은 이유와 함께 버린다.
// 계약(diag.h): 1줄 1객체 · 정확히 LF 하나로 끝난다(CRLF 금지) · 값은 string/number/boolean/null 만.
// 마지막 조각이 LF 로 끝나지 않으면 'unterminated' — 폴링 중에는 쓰는 중인 줄이고, 자식 종료 후의
// 최종 판정에서는 계약 위반이다(그 구분은 호출부가 언제 읽었는지로 한다).
export function parseDiagLines(text) {
  if (typeof text !== 'string') throw new TypeError('parseDiagLines: text 는 문자열이어야 한다(utf8 로 읽어서 넘겨라).');
  const lines = [];
  const rejected = [];
  if (text === '') return { lines, rejected };
  const parts = text.split('\n');
  const tail = parts.pop();
  parts.forEach((raw, i) => {
    const lineNo = i + 1;
    const reason = rejectReason(raw);
    if (reason) rejected.push({ lineNo, reason });
    else lines.push(JSON.parse(raw));
  });
  if (tail !== '') rejected.push({ lineNo: parts.length + 1, reason: 'unterminated' });
  return { lines, rejected };
}

function rejectReason(raw) {
  if (raw === '') return 'empty';
  if (raw.endsWith('\r')) return 'crlf';
  let obj;
  try { obj = JSON.parse(raw); } catch { return 'invalid-json'; }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 'not-object';
  if (typeof obj.event !== 'string' || obj.event === '') return 'no-event';
  if (typeof obj.ts !== 'string' || !ISO_TS.test(obj.ts)) return 'bad-ts';
  for (const v of Object.values(obj)) if (v !== null && typeof v === 'object') return 'non-scalar';
  return null;
}

// --- 시퀀스 ---
// 이벤트 이름 또는 [이름, 술어] 가 diag 에 "그 순서로" 있는가(strictly increasing index — 한 줄이 두 항목을
// 채우지 못한다). verify-client.mjs findSequence 와 같은 의미론이고 그 파일은 import 금지라 새로 쓴다.
export function findSequence(lines, sequence) {
  if (!Array.isArray(sequence) || sequence.length === 0) throw new Error('findSequence: 빈 시퀀스는 항상 ok 다 — 거부한다.');
  const items = sequence.map((item) => {
    const [name, pred] = Array.isArray(item) ? item : [item, null];
    if (typeof name !== 'string' || name === '' || (pred !== null && typeof pred !== 'function')) {
      throw new Error(`findSequence: 시퀀스 항목은 이름 또는 [이름, 술어] 다: ${String(item)}`);
    }
    return [name, pred];
  });
  let from = 0;
  for (const [name, pred] of items) {
    const idx = lines.findIndex((l, i) => i >= from && l.event === name && (!pred || pred(l)));
    if (idx < 0) return { ok: false, missing: name };
    from = idx + 1;
  }
  return { ok: true };
}

// --- 허용 이벤트 이름 ---
export function judgeEventNames(lines, allowedNames) {
  const allowed = new Set(allowedNames ?? []);
  if (allowed.size === 0) throw new Error('judgeEventNames: 허용 집합이 비었다 — 모든 줄이 위반이 되거나 판정이 공허해진다.');
  const violations = [];
  lines.forEach((l, index) => { if (!allowed.has(l.event)) violations.push({ index, event: l.event }); });
  return { ok: violations.length === 0, violations };
}

// --- 관측 수 — 0건이 green 이 되는 길을 막는다 ---
export function judgeObservationCount(lines, minCount) {
  if (!Array.isArray(lines)) throw new TypeError('judgeObservationCount: lines 는 배열이어야 한다.');
  if (!Number.isInteger(minCount) || minCount < 1) throw new Error(`judgeObservationCount: 최소치는 1 이상 정수다(0 은 공허하다): ${minCount}`);
  return { ok: lines.length >= minCount, count: lines.length, minCount };
}

// --- 계약 라우트 목록 (docs/api-contract/endpoints.json 이 정본 — 하드코딩 금지) ---
export function contractRouteIds(doc) {
  if (!doc || !Array.isArray(doc.routes)) throw new Error('contractRouteIds: endpoints.json 에 routes 배열이 없다.');
  if (doc.routes.length === 0) throw new Error('contractRouteIds: routes 가 비었다 — 계약 밖 판정이 전부 실패하거나 공허해진다.');
  const ids = doc.routes.map((r, i) => {
    if (!r || typeof r.id !== 'string' || r.id === '') throw new Error(`contractRouteIds: routes[${i}] 에 id 가 없다.`);
    return r.id;
  });
  assertUnique(ids, 'contractRouteIds');
  return Object.freeze(ids);
}

export function loadContractRouteIds(filePath) {
  return contractRouteIds(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

// 네이티브 클라가 **절대 부르지 않는** 계약 라우트(decisions (4) · excluded (i)) — 수집은 서버-대-서버 토큰 경로다.
// 이것은 라우트 목록이 아니라 정책이다. 계약에 이 id 가 없으면 judgeRouteLedger 가 던진다(오타·개명이 공허한 금지가 되지 않게).
export const CLIENT_FORBIDDEN_ROUTE_IDS = Object.freeze(['collection-receive', 'collection-pull']);

// --- 라우트 원장 — net-request 이벤트의 route 값만 본다 ---
// ① 계약 밖 0 ② 금지 0 ③ 기대 집합 포함 ④ expectedCounts 정확 횟수(지정 라우트에만 — 나머지는 횟수를 보지 않는다).
// route 어휘는 **라우트 id** 다(step8 이 라우트 표를 계약 id 와 일치시킨다). 경로 템플릿 철자는 id 가 아니므로 ① 에 걸린다.
export function judgeRouteLedger(lines, { knownRouteIds, forbiddenRouteIds, expectedRouteIds = [], expectedCounts = {} } = {}) {
  if (!Array.isArray(knownRouteIds) || knownRouteIds.length === 0) throw new Error('judgeRouteLedger: knownRouteIds 가 비었다.');
  assertUnique(knownRouteIds, 'judgeRouteLedger knownRouteIds');
  if (!Array.isArray(forbiddenRouteIds) || forbiddenRouteIds.length === 0) {
    throw new Error('judgeRouteLedger: forbiddenRouteIds 가 비었다 — ② 판정이 공허하다.');
  }
  const known = new Set(knownRouteIds);
  const forbidden = new Set(forbiddenRouteIds);
  for (const id of forbidden) if (!known.has(id)) throw new Error(`judgeRouteLedger: 계약에 없는 금지 라우트: ${id}`);
  const assertExpectable = (id, label) => {
    if (!known.has(id)) throw new Error(`judgeRouteLedger: 계약에 없는 ${label} 라우트: ${id}`);
    if (forbidden.has(id)) throw new Error(`judgeRouteLedger: 금지 라우트를 ${label}할 수 없다: ${id}`);
  };
  for (const id of expectedRouteIds) assertExpectable(id, '기대');
  for (const [id, n] of Object.entries(expectedCounts)) {
    assertExpectable(id, '횟수 기대');
    if (!Number.isInteger(n) || n < 0) throw new Error(`judgeRouteLedger: 기대 횟수는 0 이상 정수다: ${id}=${n}`);
  }

  const failures = [];
  const counts = {};
  let requestCount = 0;
  lines.forEach((l, index) => {
    if (l.event !== 'net-request') return;
    requestCount += 1;
    if (typeof l.route !== 'string' || l.route === '') { failures.push({ kind: 'no-route', index }); return; }
    counts[l.route] = (counts[l.route] ?? 0) + 1;
    if (!known.has(l.route)) failures.push({ kind: 'unknown-route', route: l.route, index });
    else if (forbidden.has(l.route)) failures.push({ kind: 'forbidden-route', route: l.route, index });
  });
  for (const id of expectedRouteIds) if (!counts[id]) failures.push({ kind: 'missing-expected', route: id });
  for (const [id, n] of Object.entries(expectedCounts)) {
    const actual = counts[id] ?? 0;
    if (actual !== n) failures.push({ kind: 'count-mismatch', route: id, expected: n, actual });
  }
  return { ok: failures.length === 0, requestCount, counts, failures };
}

// --- 데이터 안전 전후 비교 — 스냅샷은 { 키: 문자열 } 평면 객체(수집은 드라이버 몫) ---
export function diffSnapshots(before, after) {
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isPlain(before) || !isPlain(after)) throw new Error('diffSnapshots: 스냅샷은 평면 객체여야 한다.');
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => before[k] !== after[k]).map((k) => ({ key: k, before: before[k], after: after[k] }));
}

// --- 부팅 경로 판정 (verify-client.mjs 시나리오 A/B 이식 · step5 실측 순서) ---
// A(설정 있음) = app-ready → config-loaded{hasServerUrl:true} → app-window{origin} (+ 두 번째 인스턴스의 second-instance 1줄)
// B(설정 없음) = app-ready → config-loaded{hasServerUrl:false} → local-window{page:setup} · setup-shown{reason:no-config}
//   — 정본(client/main.js)은 local-window 를 먼저 쓰지만 판정자는 이 둘의 순서를 보지 않는다(포트 스펙 X4).
// 두 경로 모두 부팅만으로 probe 가 없다(프로브는 사용자 액션뿐 — 정본 설계). 허용 집합은 client-qt diag 21종의 부분집합이다.
export const BOOT_ALLOWED_EVENTS = Object.freeze({
  A: Object.freeze(['app-ready', 'config-loaded', 'app-window', 'second-instance']),
  B: Object.freeze(['app-ready', 'config-loaded', 'local-window', 'setup-shown']),
});
export const BOOT_MIN_EVENTS = Object.freeze({ A: 4, B: 4 });

export function bootSequences(path, { origin } = {}) {
  if (path === 'A') {
    if (typeof origin !== 'string' || origin === '') throw new Error('bootSequences A: origin(드라이버가 띄운 서버) 이 필요하다.');
    return [[
      'app-ready',
      ['config-loaded', (l) => l.hasServerUrl === true],
      ['app-window', (l) => l.origin === origin],
    ]];
  }
  if (path === 'B') {
    const head = ['app-ready', ['config-loaded', (l) => l.hasServerUrl === false]];
    return [
      [...head, ['local-window', (l) => l.page === 'setup']],
      [...head, ['setup-shown', (l) => l.reason === 'no-config']],
    ];
  }
  throw new Error(`bootSequences: 알 수 없는 부팅 경로: ${path}`);
}

const SEQUENCE_LABELS = {
  A: ['A: app-ready→config-loaded{hasServerUrl:true}→app-window{origin=서버}'],
  B: ['B: app-ready→config-loaded{hasServerUrl:false}→local-window{page:setup}',
    'B: app-ready→config-loaded{hasServerUrl:false}→setup-shown{reason:no-config}'],
};

// 자식 종료 후의 최종 diag 로 경로 하나를 판정한다 → [{ name, ok, detail }] (항목 수는 경로마다 고정).
export function judgeBoot(path, { lines, rejected, origin, routeIds } = {}) {
  if (path !== 'A' && path !== 'B') throw new Error(`judgeBoot: 알 수 없는 부팅 경로: ${path}`);
  if (!Array.isArray(routeIds) || routeIds.length === 0) throw new Error('judgeBoot: 원장 판정에 쓸 knownRouteIds(routeIds) 가 없다.');
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name: `${path}: ${name}`, ok, detail });
  const events = `events=[${lines.map((l) => l.event).join(',')}]`;
  const countOf = (name) => lines.filter((l) => l.event === name).length;

  add('diag 깨진 줄 0', rejected.length === 0, rejected.length ? JSON.stringify(rejected) : '');
  const obs = judgeObservationCount(lines, BOOT_MIN_EVENTS[path]);
  add(`관측 이벤트 수 ≥ ${obs.minCount}`, obs.ok, `관측 ${obs.count}`);

  const sequences = bootSequences(path, { origin });
  sequences.forEach((seq, i) => {
    const r = findSequence(lines, seq);
    checks.push({ name: SEQUENCE_LABELS[path][i], ok: r.ok, detail: r.ok ? '' : `missing=${r.missing} ${events}` });
  });

  if (path === 'A') {
    const after = findSequence(lines, [...sequences[0], 'second-instance']).ok;
    const n = countOf('second-instance');
    add('second-instance 정확히 1회(app-window 뒤)', after && n === 1, `second-instance=${n}`);
    const ready = countOf('app-ready');
    add('app-ready 정확히 1회(두 번째 인스턴스는 부팅하지 않는다)', ready === 1, `app-ready=${ready}`);
  }

  const probes = countOf('probe');
  add('부팅만으로 probe 0건', probes === 0, `probe=${probes}`);
  const names = judgeEventNames(lines, BOOT_ALLOWED_EVENTS[path]);
  add('허용 이벤트 집합 밖 0건', names.ok, names.ok ? `허용 ${BOOT_ALLOWED_EVENTS[path].length}종` : JSON.stringify(names.violations));
  const ledger = judgeRouteLedger(lines, { knownRouteIds: routeIds, forbiddenRouteIds: CLIENT_FORBIDDEN_ROUTE_IDS });
  add('라우트 원장(계약 밖·금지 0)', ledger.ok,
    `net-request ${ledger.requestCount}건${ledger.ok ? '' : ` ${JSON.stringify(ledger.failures)}`}`);
  return checks;
}

// --- 로그인 시나리오 판정 (step10 — --scenario login 의 두 클라 실행) ---
// success(L+) = 부팅 A 머리 → net-request{route:login,status:200} → login{status:200}
//               → net-request{route:session,status:200} → session{status:200}
//   신원은 로그인 응답이 아니라 GET /api/session 으로 **다시** 받는다(decisions (7) · override L123-128) — 로그인 뒤 화면
//   전환의 첫 동작이 그 요청이다(client-qt/src/shell/appshell.cpp onLoginSucceeded).
// rejected(L-) = 부팅 A 머리 → net-request{route:login,status:401} → login{status:401}, 그리고 **화면이 넘어가지 않는다**:
//   session 0 · net-request{route:session} 0 · list-loaded 0. step10 에는 목록 화면이 없어 list-loaded 는 원래 나올 수 없다 —
//   비공허한 증거는 「신원 재확인 요청이 없다」 쪽이다(화면 전환 = session 요청이므로 잘못 넘어가면 그 줄이 생긴다).
export const LOGIN_KINDS = Object.freeze(['success', 'rejected']);
export const LOGIN_ALLOWED_EVENTS = Object.freeze({
  success: Object.freeze(['app-ready', 'config-loaded', 'app-window', 'net-request', 'login', 'session']),
  rejected: Object.freeze(['app-ready', 'config-loaded', 'app-window', 'net-request', 'login']),
});
export const LOGIN_MIN_EVENTS = Object.freeze({ success: 7, rejected: 5 });
// 원장 — 이 시나리오가 부를 수 있는 라우트 **전부**와 그 정확 횟수. 여기 없는 라우트는 1회라도 red 다(목록·스트림은 step11).
export const LOGIN_ROUTE_COUNTS = Object.freeze({
  success: Object.freeze({ login: 1, session: 1 }),
  rejected: Object.freeze({ login: 1, session: 0 }),
});

const LOGIN_LABELS = Object.freeze({ success: 'L+', rejected: 'L-' });

function assertLoginKind(kind, fn) {
  if (!LOGIN_KINDS.includes(kind)) throw new Error(`${fn}: 알 수 없는 로그인 경로: ${kind}`);
}

export function loginSequences(kind, { origin } = {}) {
  assertLoginKind(kind, 'loginSequences');
  if (typeof origin !== 'string' || origin === '') throw new Error('loginSequences: origin(드라이버가 띄운 서버) 이 필요하다.');
  const head = ['app-ready', ['config-loaded', (l) => l.hasServerUrl === true], ['app-window', (l) => l.origin === origin]];
  if (kind === 'success') {
    return [[
      ...head,
      ['net-request', (l) => l.route === 'login' && l.status === 200],
      ['login', (l) => l.status === 200],
      ['net-request', (l) => l.route === 'session' && l.status === 200],
      ['session', (l) => l.status === 200],
    ]];
  }
  return [[...head, ['net-request', (l) => l.route === 'login' && l.status === 401], ['login', (l) => l.status === 401]]];
}

const LOGIN_SEQUENCE_LABELS = Object.freeze({
  success: 'app-ready→config-loaded{true}→app-window{origin}→net-request{login,200}→login{200}→net-request{session,200}→session{200}',
  rejected: 'app-ready→config-loaded{true}→app-window{origin}→net-request{login,401}→login{401}',
});

// 자식 종료 후의 최종 diag 로 로그인 실행 하나를 판정한다 → [{ name, ok, detail }] (항목 수는 경로마다 고정).
export function judgeLogin(kind, { lines, rejected, origin, routeIds } = {}) {
  assertLoginKind(kind, 'judgeLogin');
  if (!Array.isArray(routeIds) || routeIds.length === 0) throw new Error('judgeLogin: 원장 판정에 쓸 knownRouteIds(routeIds) 가 없다.');
  const label = LOGIN_LABELS[kind];
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name: `${label}: ${name}`, ok, detail });
  const events = `events=[${lines.map((l) => l.event).join(',')}]`;
  const countOf = (name) => lines.filter((l) => l.event === name).length;

  add('diag 깨진 줄 0', rejected.length === 0, rejected.length ? JSON.stringify(rejected) : '');
  const obs = judgeObservationCount(lines, LOGIN_MIN_EVENTS[kind]);
  add(`관측 이벤트 수 ≥ ${obs.minCount}`, obs.ok, `관측 ${obs.count}`);
  const seq = findSequence(lines, loginSequences(kind, { origin })[0]);
  add(LOGIN_SEQUENCE_LABELS[kind], seq.ok, seq.ok ? '' : `missing=${seq.missing} ${events}`);

  const logins = countOf('login');
  add('login 정확히 1회(훅은 컨트롤러를 한 번만 부른다)', logins === 1, `login=${logins}`);
  const sessions = countOf('session');
  const lists = countOf('list-loaded');
  if (kind === 'success') {
    add('session 정확히 1회(신원 재확인 — 로그인 응답의 신원을 캐시하지 않는다)', sessions === 1, `session=${sessions}`);
  } else {
    add('화면이 넘어가지 않았다(session 0 · list-loaded 0)', sessions === 0 && lists === 0, `session=${sessions} list-loaded=${lists}`);
  }

  const names = judgeEventNames(lines, LOGIN_ALLOWED_EVENTS[kind]);
  add('허용 이벤트 집합 밖 0건', names.ok, names.ok ? `허용 ${LOGIN_ALLOWED_EVENTS[kind].length}종` : JSON.stringify(names.violations));
  const expectedCounts = { ...LOGIN_ROUTE_COUNTS[kind] };
  const ledger = judgeRouteLedger(lines, { knownRouteIds: routeIds, forbiddenRouteIds: CLIENT_FORBIDDEN_ROUTE_IDS, expectedCounts });
  const stray = Object.keys(ledger.counts).filter((id) => !(id in expectedCounts));
  const ledgerOk = ledger.ok && stray.length === 0;
  add(`라우트 원장(계약 밖·금지 0 · ${Object.entries(expectedCounts).map(([id, n]) => `${id}=${n}`).join(' ')} · 그 밖 0)`, ledgerOk,
    `net-request ${ledger.requestCount}건${ledgerOk ? '' : ` ${JSON.stringify({ failures: ledger.failures, stray })}`}`);
  return checks;
}

// --- 비밀 유출 점검 — 문자열 속 비밀의 출현 수(원문 + JSON 이스케이프 형) ---
// 결과에 비밀 자체를 담지 않는다(보고가 곧 유출이 되지 않게 — 인덱스와 횟수만). 짧은 비밀은 거짓 양성·공허 판정이라 던진다.
export function countSecretOccurrences(text, secrets) {
  if (typeof text !== 'string') throw new TypeError('countSecretOccurrences: text 는 문자열이어야 한다.');
  if (!Array.isArray(secrets) || secrets.length === 0) throw new Error('countSecretOccurrences: 비밀 목록이 비었다 — 판정이 공허하다.');
  const bySecret = secrets.map((secret, index) => {
    if (typeof secret !== 'string' || secret.length < 4) throw new Error(`countSecretOccurrences: secrets[${index}] 는 4자 이상 문자열이어야 한다.`);
    const forms = [...new Set([secret, JSON.stringify(secret).slice(1, -1)])];
    let count = 0;
    for (const form of forms) {
      for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) count += 1;
    }
    return { index, count };
  });
  return { total: bySecret.reduce((sum, s) => sum + s.count, 0), bySecret };
}

function assertUnique(ids, label) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${label}: 중복 id: ${id}`);
    seen.add(id);
  }
}
