// scripts/lib/qtClientDiag.mjs · scripts/lib/qtClientEnv.mjs 의 순수 판정부 자기검사 (phase 77 step6).
//
// 왜 여기에 있고 npm test 가 돌지 않는가: package.json·test/** 는 이 phase 의 무접촉 목록이고 `npm test` 는
// "test/**/*.test.js" 만 훑는다. scripts/verify-qt-client.mjs 가 **시작할 때 이 파일을 스스로 돌린다**
// (빨간 판정부로는 서버도 클라도 띄우지 않는다 — spa-parity.mjs 선례). 그 결선이 끊기면
// test/harness-vacuity-guards.test.js 가 이 파일을 고아로 판정해 npm test 가 red 다.
// 실행: node --test scripts/lib/qtClientDiag.self-test.mjs
//
// 무엇을 잠그는가(각각 드라이버가 공허하게 green 이 되는 길 하나씩이다):
//   · diag JSONL 형식 계약(client-qt/src/shell/diag.h — 1줄 1객체 · LF 종결 · ts ISO · 값은 스칼라만)
//   · 시퀀스 판정의 순서 의미론(같은 줄이 두 항목을 채우지 못한다) · 빈 시퀀스/빈 허용 집합/최소 0 은 거부
//   · 라우트 원장 ①~④ — 특히 ④ 정확 횟수(폴링 클라 배제)가 **지정 라우트에만** 걸리는가
//   · 부팅 경로 A/B 판정이 step5 실측 diag 에 green 이고, 이벤트 하나를 빼거나 더하면 red 인가
//   · Qt 자식 env 가 부모 PATH 를 상속하지 않고 Qt bin 을 싣는가(--qt-bin 오지정이 무음 green 이 되는 길)

import test from 'node:test';
import assert from 'node:assert/strict';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOOT_ALLOWED_EVENTS, BOOT_MIN_EVENTS, CLIENT_FORBIDDEN_ROUTE_IDS,
  bootSequences, contractRouteIds, diffSnapshots, findSequence, judgeBoot, judgeEventNames,
  judgeObservationCount, judgeRouteLedger, loadContractRouteIds, parseDiagLines,
} from './qtClientDiag.mjs';
import { qtClientEnv } from './qtClientEnv.mjs';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ENDPOINTS_JSON = nodePath.resolve(HERE, '..', '..', 'docs', 'api-contract', 'endpoints.json');

const TS = '2026-09-11T13:00:00.000Z';
const line = (event, fields = {}) => `${JSON.stringify({ ts: TS, event, ...fields })}\n`;
const ORIGIN = 'http://127.0.0.1:45123';

// step5 실측 부팅 diag(스크래치 노트 「진행 상태」 — A 는 두 번째 인스턴스까지 돈 뒤의 첫 인스턴스 파일).
const STEP5_BOOT_A = [
  line('app-ready'),
  line('config-loaded', { hasServerUrl: true }),
  line('app-window', { origin: ORIGIN }),
  line('second-instance'),
].join('');
const STEP5_BOOT_B = [
  line('app-ready'),
  line('config-loaded', { hasServerUrl: false }),
  line('local-window', { page: 'setup' }),
  line('setup-shown', { reason: 'no-config' }),
].join('');

const parsed = (text) => parseDiagLines(text);
const linesOf = (text) => parseDiagLines(text).lines;

// --- parseDiagLines: diag JSONL 형식 계약 ---

test('빈 입력은 0줄·거부 0이다(파일이 아직 없을 때)', () => {
  assert.deepEqual(parsed(''), { lines: [], rejected: [] });
});

test('step4 정본 바이트 대조 줄을 그대로 읽는다', () => {
  const canonical = '{"ts":"1970-01-01T00:00:00.000Z","event":"probe","ok":true,"url":"http://h:3001/api/health"}\n';
  const r = parsed(canonical);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.lines, [{ ts: '1970-01-01T00:00:00.000Z', event: 'probe', ok: true, url: 'http://h:3001/api/health' }]);
});

test('step5 실측 부팅 diag 2벌은 전부 유효 줄이다', () => {
  for (const text of [STEP5_BOOT_A, STEP5_BOOT_B]) {
    const r = parsed(text);
    assert.equal(r.rejected.length, 0);
    assert.equal(r.lines.length, 4);
  }
});

test('LF 로 끝나지 않은 마지막 조각은 unterminated 로 버리고 앞 줄은 살린다(쓰는 중인 줄)', () => {
  const r = parsed(`${line('app-ready')}{"ts":"${TS}","ev`);
  assert.equal(r.lines.length, 1);
  assert.deepEqual(r.rejected, [{ lineNo: 2, reason: 'unterminated' }]);
});

test('깨진 줄은 이유와 줄 번호를 달고 버려진다', () => {
  const cases = [
    [`${JSON.stringify({ ts: TS, event: 'app-ready' })}\r\n`, 'crlf'],
    ['{not json}\n', 'invalid-json'],
    ['[1,2]\n', 'not-object'],
    ['null\n', 'not-object'],
    ['42\n', 'not-object'],
    [`${JSON.stringify({ ts: TS })}\n`, 'no-event'],
    [`${JSON.stringify({ ts: TS, event: '' })}\n`, 'no-event'],
    [`${JSON.stringify({ ts: TS, event: 7 })}\n`, 'no-event'],
    [`${JSON.stringify({ event: 'app-ready' })}\n`, 'bad-ts'],
    [`${JSON.stringify({ ts: '2026-09-11 13:00:00', event: 'app-ready' })}\n`, 'bad-ts'],
    [`${JSON.stringify({ ts: '2026-09-11T13:00:00Z', event: 'app-ready' })}\n`, 'bad-ts'],
    [`${JSON.stringify({ ts: TS, event: 'probe', detail: { a: 1 } })}\n`, 'non-scalar'],
    [`${JSON.stringify({ ts: TS, event: 'probe', list: [1] })}\n`, 'non-scalar'],
  ];
  for (const [text, reason] of cases) {
    const r = parsed(`${line('app-ready')}${text}`);
    assert.equal(r.lines.length, 1, `${reason}: 앞의 유효 줄이 사라졌다`);
    assert.deepEqual(r.rejected, [{ lineNo: 2, reason }], JSON.stringify(text));
  }
});

test('중간의 빈 줄은 empty 로 센다(1줄 1객체 계약 위반)', () => {
  const r = parsed(`${line('app-ready')}\n${line('config-loaded', { hasServerUrl: true })}`);
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.rejected, [{ lineNo: 2, reason: 'empty' }]);
});

test('parseDiagLines 는 문자열이 아니면 던진다(버퍼를 그대로 넘기는 실수)', () => {
  assert.throws(() => parseDiagLines(Buffer.from('x')), TypeError);
  assert.throws(() => parseDiagLines(undefined), TypeError);
});

// --- findSequence ---

test('findSequence: 순서대로 있으면 ok · 순서가 뒤집히면 첫 누락 이름', () => {
  const lines = linesOf(STEP5_BOOT_A);
  assert.deepEqual(findSequence(lines, ['app-ready', 'config-loaded', 'app-window']), { ok: true });
  assert.deepEqual(findSequence(lines, ['app-window', 'app-ready']), { ok: false, missing: 'app-ready' });
  assert.deepEqual(findSequence(lines, ['app-ready', 'probe']), { ok: false, missing: 'probe' });
});

test('findSequence: [이름, 술어] 는 술어까지 맞아야 하고 한 줄이 두 항목을 채우지 못한다', () => {
  const lines = linesOf(STEP5_BOOT_A);
  assert.equal(findSequence(lines, [['config-loaded', (l) => l.hasServerUrl === true]]).ok, true);
  assert.deepEqual(findSequence(lines, [['config-loaded', (l) => l.hasServerUrl === false]]), { ok: false, missing: 'config-loaded' });
  assert.deepEqual(findSequence(lines, ['app-ready', 'app-ready']), { ok: false, missing: 'app-ready' });
});

test('findSequence: 빈 시퀀스와 잘못된 항목은 던진다(항상 ok 인 판정 금지)', () => {
  assert.throws(() => findSequence([], []), /빈 시퀀스/);
  assert.throws(() => findSequence([], [42]), /시퀀스 항목/);
  assert.throws(() => findSequence([], [['app-ready', 'not-a-function']]), /시퀀스 항목/);
});

// --- judgeEventNames ---

test('judgeEventNames: 허용 집합 밖 이벤트는 위치와 함께 위반이다', () => {
  const lines = linesOf(STEP5_BOOT_A + line('probe', { ok: false }));
  assert.deepEqual(judgeEventNames(lines, BOOT_ALLOWED_EVENTS.A), { ok: false, violations: [{ index: 4, event: 'probe' }] });
  assert.deepEqual(judgeEventNames(linesOf(STEP5_BOOT_A), BOOT_ALLOWED_EVENTS.A), { ok: true, violations: [] });
});

test('judgeEventNames: 빈 허용 집합은 던진다', () => {
  assert.throws(() => judgeEventNames([], []), /허용 집합/);
  assert.throws(() => judgeEventNames([], undefined), /허용 집합/);
});

// --- judgeObservationCount ---

test('judgeObservationCount: 관측 0건은 최소 1 에서도 실패다 · 최소치 0 은 공허해서 거부', () => {
  assert.deepEqual(judgeObservationCount([], 1), { ok: false, count: 0, minCount: 1 });
  assert.deepEqual(judgeObservationCount(linesOf(STEP5_BOOT_B), 4), { ok: true, count: 4, minCount: 4 });
  assert.deepEqual(judgeObservationCount(linesOf(STEP5_BOOT_B), 5), { ok: false, count: 4, minCount: 5 });
  assert.throws(() => judgeObservationCount([], 0), /최소치/);
  assert.throws(() => judgeObservationCount([], 1.5), /최소치/);
  assert.throws(() => judgeObservationCount('x', 1), /lines/);
});

// --- 계약 라우트 목록 ---

test('contractRouteIds: endpoints.json 모양에서 id 목록을 만든다 · 중복·빈 목록·id 없음은 던진다', () => {
  assert.deepEqual(contractRouteIds({ version: 1, routes: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  assert.throws(() => contractRouteIds({ routes: [{ id: 'a' }, { id: 'a' }] }), /중복/);
  assert.throws(() => contractRouteIds({ routes: [] }), /비었다/);
  assert.throws(() => contractRouteIds({ routes: [{ path: '/x' }] }), /id/);
  assert.throws(() => contractRouteIds({}), /routes/);
  assert.throws(() => contractRouteIds(null), /routes/);
});

test('실제 계약 파일을 읽으면 금지 2행과 P4 가 부를 라우트가 들어 있다(하드코딩 아님 — 파일이 정본)', () => {
  const ids = loadContractRouteIds(ENDPOINTS_JSON);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...CLIENT_FORBIDDEN_ROUTE_IDS], ['collection-receive', 'collection-pull']);
  for (const id of [...CLIENT_FORBIDDEN_ROUTE_IDS, 'health', 'login', 'session', 'articles-list', 'stream']) {
    assert.ok(ids.includes(id), `계약에 ${id} 가 없다`);
  }
});

// --- judgeRouteLedger ---

const KNOWN = ['health', 'login', 'session', 'articles-list', 'articles-get', 'stream', 'collection-receive', 'collection-pull'];
const FORBIDDEN = ['collection-receive', 'collection-pull'];
const req = (route, extra = {}) => line('net-request', { route, method: 'GET', status: 200, ms: 3, ...extra });
const ledger = (text, spec = {}) => judgeRouteLedger(linesOf(text), { knownRouteIds: KNOWN, forbiddenRouteIds: FORBIDDEN, ...spec });

test('원장: net-request 가 없으면 ok · 요청 0건으로 보고한다(부팅 경로)', () => {
  const r = ledger(STEP5_BOOT_A);
  assert.equal(r.ok, true);
  assert.equal(r.requestCount, 0);
  assert.deepEqual(r.failures, []);
});

test('원장 ①: 계약 밖 라우트는 실패 · 경로 템플릿 철자도 id 가 아니므로 계약 밖이다(어휘는 id — step8)', () => {
  const r = ledger(req('login') + req('articles-bogus') + req('/api/articles/:id'));
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures, [
    { kind: 'unknown-route', route: 'articles-bogus', index: 1 },
    { kind: 'unknown-route', route: '/api/articles/:id', index: 2 },
  ]);
  assert.deepEqual(r.counts, { login: 1, 'articles-bogus': 1, '/api/articles/:id': 1 });
});

test('원장 ②: 금지 라우트(수집 2행)는 계약 안이어도 실패다', () => {
  const r = ledger(req('collection-pull', { method: 'POST' }) + req('collection-receive', { method: 'POST' }));
  assert.deepEqual(r.failures.map((f) => [f.kind, f.route]), [['forbidden-route', 'collection-pull'], ['forbidden-route', 'collection-receive']]);
});

test('원장: route 필드가 없거나 문자열이 아니면 실패다(판정 불가를 통과로 두지 않는다)', () => {
  const r = ledger(line('net-request', { method: 'GET', status: 200 }) + line('net-request', { route: 7 }));
  assert.deepEqual(r.failures, [{ kind: 'no-route', index: 0 }, { kind: 'no-route', index: 1 }]);
});

test('원장 ③: 기대 라우트가 한 번도 없으면 실패', () => {
  const r = ledger(req('login'), { expectedRouteIds: ['login', 'articles-list'] });
  assert.deepEqual(r.failures, [{ kind: 'missing-expected', route: 'articles-list' }]);
  assert.equal(ledger(req('login') + req('articles-list'), { expectedRouteIds: ['login', 'articles-list'] }).ok, true);
});

test('원장 ④: 정확 횟수 — articles-list 2회 기대에 3회(폴링 클라)는 실패 · 2회는 ok', () => {
  const spec = { expectedCounts: { 'articles-list': 2 } };
  const twice = req('login') + req('articles-list') + req('articles-list');
  assert.equal(ledger(twice, spec).ok, true);
  const thrice = twice + req('articles-list');
  assert.deepEqual(ledger(thrice, spec).failures, [{ kind: 'count-mismatch', route: 'articles-list', expected: 2, actual: 3 }]);
  assert.deepEqual(ledger(req('login'), spec).failures, [{ kind: 'count-mismatch', route: 'articles-list', expected: 2, actual: 0 }]);
});

test('원장 ④는 지정한 라우트에만 걸린다 — 나머지는 몇 번이든 횟수를 보지 않는다', () => {
  const many = req('session') + req('session') + req('session') + req('articles-list') + req('articles-list');
  assert.equal(ledger(many, { expectedCounts: { 'articles-list': 2 } }).ok, true);
  assert.deepEqual(ledger(many).counts, { session: 3, 'articles-list': 2 });
});

test('원장 ④: 0회 기대는 「부르면 실패」다', () => {
  assert.deepEqual(ledger(req('stream'), { expectedCounts: { stream: 0 } }).failures,
    [{ kind: 'count-mismatch', route: 'stream', expected: 0, actual: 1 }]);
});

test('원장 명세 오류는 판정 전에 던진다(공허한 금지·오타 기대 금지)', () => {
  const lines = [];
  assert.throws(() => judgeRouteLedger(lines, { knownRouteIds: [], forbiddenRouteIds: FORBIDDEN }), /knownRouteIds/);
  assert.throws(() => judgeRouteLedger(lines, { knownRouteIds: KNOWN, forbiddenRouteIds: [] }), /forbiddenRouteIds/);
  assert.throws(() => judgeRouteLedger(lines, { knownRouteIds: KNOWN, forbiddenRouteIds: ['collection-recieve'] }), /계약에 없는/);
  assert.throws(() => judgeRouteLedger(lines, { knownRouteIds: KNOWN, forbiddenRouteIds: FORBIDDEN, expectedRouteIds: ['artcles-list'] }), /계약에 없는/);
  assert.throws(() => judgeRouteLedger(lines, { knownRouteIds: KNOWN, forbiddenRouteIds: FORBIDDEN, expectedRouteIds: ['collection-pull'] }), /금지/);
  assert.throws(() => judgeRouteLedger(lines, { knownRouteIds: KNOWN, forbiddenRouteIds: FORBIDDEN, expectedCounts: { 'artcles-list': 2 } }), /계약에 없는/);
  assert.throws(() => judgeRouteLedger(lines, { knownRouteIds: KNOWN, forbiddenRouteIds: FORBIDDEN, expectedCounts: { 'collection-pull': 0 } }), /금지/);
  assert.throws(() => judgeRouteLedger(lines, { knownRouteIds: KNOWN, forbiddenRouteIds: FORBIDDEN, expectedCounts: { 'articles-list': -1 } }), /정수/);
  assert.throws(() => judgeRouteLedger(lines, { knownRouteIds: KNOWN, forbiddenRouteIds: FORBIDDEN, expectedCounts: { 'articles-list': 1.5 } }), /정수/);
  assert.throws(() => judgeRouteLedger(lines, { knownRouteIds: ['a', 'a'], forbiddenRouteIds: ['a'] }), /중복/);
});

// --- diffSnapshots (데이터 안전 전후 비교) ---

test('diffSnapshots: 같으면 [] · 값 변화·추가·삭제를 전부 키 순으로 보고한다', () => {
  const before = { 'repo:news.db': 'size=1', 'appdata:qt': 'absent', 'dist:a/data/x': 'size=2' };
  assert.deepEqual(diffSnapshots(before, { ...before }), []);
  const after = { 'repo:news.db': 'size=9', 'appdata:qt': 'absent', 'dist:a/data/y': 'size=1' };
  assert.deepEqual(diffSnapshots(before, after), [
    { key: 'dist:a/data/x', before: 'size=2', after: undefined },
    { key: 'dist:a/data/y', before: undefined, after: 'size=1' },
    { key: 'repo:news.db', before: 'size=1', after: 'size=9' },
  ]);
  assert.throws(() => diffSnapshots(null, {}), /스냅샷/);
  assert.throws(() => diffSnapshots({}, []), /스냅샷/);
});

// --- 부팅 경로 판정 (A 설정 있음 + 두 번째 인스턴스 · B 설정 없음) ---

const ROUTES = loadContractRouteIds(ENDPOINTS_JSON);
const boot = (path, text, extra = {}) => {
  const { lines, rejected } = parseDiagLines(text);
  return judgeBoot(path, { lines, rejected, origin: ORIGIN, routeIds: ROUTES, ...extra });
};
const failedNames = (checks) => checks.filter((c) => !c.ok).map((c) => c.name);

test('부팅 판정 상수: 허용 집합·최소 관측 수가 시퀀스와 맞물린다', () => {
  assert.deepEqual([...BOOT_ALLOWED_EVENTS.A], ['app-ready', 'config-loaded', 'app-window', 'second-instance']);
  assert.deepEqual([...BOOT_ALLOWED_EVENTS.B], ['app-ready', 'config-loaded', 'local-window', 'setup-shown']);
  assert.equal(BOOT_MIN_EVENTS.A, 4);
  assert.equal(BOOT_MIN_EVENTS.B, 4);
  assert.ok(!BOOT_ALLOWED_EVENTS.A.includes('probe') && !BOOT_ALLOWED_EVENTS.B.includes('probe'), '부팅 허용 집합에 probe 가 있다');
  assert.equal(bootSequences('A', { origin: ORIGIN }).length, 1);
  assert.equal(bootSequences('B').length, 2);
  assert.throws(() => bootSequences('A'), /origin/);
  assert.throws(() => bootSequences('C'), /경로/);
});

test('step5 실측 A diag 는 전 항목 green 이고 판정 항목 수는 0 이 아니다', () => {
  const checks = boot('A', STEP5_BOOT_A);
  assert.ok(checks.length >= 8, `판정 항목이 너무 적다: ${checks.length}`);
  assert.deepEqual(failedNames(checks), []);
  for (const c of checks) assert.ok(typeof c.name === 'string' && c.name.startsWith('A: '), c.name);
});

test('step5 실측 B diag 는 전 항목 green 이고 local-window/setup-shown 순서는 보지 않는다(X4)', () => {
  assert.deepEqual(failedNames(boot('B', STEP5_BOOT_B)), []);
  const swapped = [line('app-ready'), line('config-loaded', { hasServerUrl: false }), line('setup-shown', { reason: 'no-config' }), line('local-window', { page: 'setup' })].join('');
  assert.deepEqual(failedNames(boot('B', swapped)), []);
  assert.ok(boot('B', STEP5_BOOT_B).length >= 7);
});

test('A: diag 가 비면(즉시 종료 더미) 관측 수·시퀀스가 red 다 — M6-2 의 판정부 쪽 증거', () => {
  const failed = failedNames(boot('A', ''));
  assert.ok(failed.some((n) => n.includes('관측 이벤트 수')), JSON.stringify(failed));
  assert.ok(failed.some((n) => n.includes('app-window')), JSON.stringify(failed));
});

test('B: diag 가 비면 관측 수가 red 다', () => {
  assert.ok(failedNames(boot('B', '')).some((n) => n.includes('관측 이벤트 수')));
});

test('A: app-window 를 앱이 남기지 않으면 red(M6-3 의 판정부 쪽 증거)', () => {
  const text = [line('app-ready'), line('config-loaded', { hasServerUrl: true }), line('second-instance')].join('');
  const failed = failedNames(boot('A', text));
  assert.ok(failed.some((n) => n.includes('app-window')), JSON.stringify(failed));
});

test('A: app-window 의 origin 이 드라이버가 띄운 서버와 다르면 red(앱이 우리 config 를 읽었다는 교차 증거)', () => {
  const text = STEP5_BOOT_A.replace(ORIGIN, 'http://127.0.0.1:3001');
  assert.ok(failedNames(boot('A', text)).some((n) => n.includes('app-window')));
});

test('A: second-instance 가 없거나 두 번이면 red · 두 번째 인스턴스가 부팅했으면(app-ready 2회) red', () => {
  const noSecond = STEP5_BOOT_A.replace(line('second-instance'), '');
  assert.ok(failedNames(boot('A', noSecond)).some((n) => n.includes('second-instance')));
  const twice = STEP5_BOOT_A + line('second-instance');
  assert.ok(failedNames(boot('A', twice)).some((n) => n.includes('second-instance')));
  const booted = STEP5_BOOT_A + line('app-ready') + line('config-loaded', { hasServerUrl: true }) + line('app-window', { origin: ORIGIN });
  assert.ok(failedNames(boot('A', booted)).some((n) => n.includes('app-ready')));
});

test('A·B: 부팅 중 probe 는 probe 항목과 허용 집합 둘 다 red', () => {
  for (const [path, text] of [['A', STEP5_BOOT_A], ['B', STEP5_BOOT_B]]) {
    const failed = failedNames(boot(path, text + line('probe', { ok: false, reason: 'unreachable' })));
    assert.ok(failed.some((n) => n.includes('probe')), `${path}: ${JSON.stringify(failed)}`);
    assert.ok(failed.some((n) => n.includes('허용 이벤트')), `${path}: ${JSON.stringify(failed)}`);
  }
});

test('B: setup-shown 누락 · config-loaded{true} 는 red', () => {
  assert.ok(failedNames(boot('B', STEP5_BOOT_B.replace(line('setup-shown', { reason: 'no-config' }), ''))).some((n) => n.includes('setup-shown')));
  assert.ok(failedNames(boot('B', STEP5_BOOT_B.replace('"hasServerUrl":false', '"hasServerUrl":true'))).length > 0);
});

test('A·B: 깨진 줄이 하나라도 있으면 red(형식 계약 위반은 경고가 아니다)', () => {
  assert.ok(failedNames(boot('A', `${STEP5_BOOT_A}{broken}\n`)).some((n) => n.includes('깨진 줄')));
  assert.ok(failedNames(boot('B', `${STEP5_BOOT_B}{"ts":"x"`)).some((n) => n.includes('깨진 줄')));
});

test('A: 부팅 중 계약 밖·금지 net-request 는 원장 항목이 red', () => {
  const text = STEP5_BOOT_A + req('collection-pull', { method: 'POST' });
  assert.ok(failedNames(boot('A', text)).some((n) => n.includes('라우트 원장')));
});

test('judgeBoot 은 알 수 없는 경로·routeIds 누락을 던진다', () => {
  assert.throws(() => judgeBoot('C', { lines: [], rejected: [], routeIds: ROUTES }), /경로/);
  assert.throws(() => judgeBoot('B', { lines: [], rejected: [] }), /knownRouteIds/);
});

// --- qtClientEnv: Qt 자식 env 조립 ---

const PARENT = {
  SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', TEMP: 'C:\\Temp', TMP: 'C:\\Temp',
  PATH: 'C:\\other\\Qt\\5.15\\bin;C:\\Windows\\System32', QT_QPA_PLATFORM: 'offscreen', QT_PLUGIN_PATH: 'C:\\other\\plugins',
  NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1', CLIENT_USER_DATA: 'C:\\real\\user', CLIENT_DIAG_FILE: 'C:\\real\\diag',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
};
const QT_BIN = 'D:\\agents\\tools\\Qt\\6.8.3\\msvc2022_64\\bin';
const envOf = (extra = {}) => qtClientEnv({ parentEnv: PARENT, platform: 'win32', qtBinDir: QT_BIN, userDataDir: 'C:\\tmp\\ud-a', diagFile: 'C:\\tmp\\diag-a.jsonl', ...extra });

test('Qt 자식 PATH 는 Qt bin 이 맨 앞이고 부모 PATH 는 한 조각도 상속하지 않는다', () => {
  const env = envOf();
  const parts = env.PATH.split(';');
  assert.equal(parts[0], QT_BIN);
  assert.ok(!env.PATH.includes('other'), `부모 PATH 가 새었다: ${env.PATH}`);
  assert.deepEqual(parts, [QT_BIN, 'C:\\Windows\\System32', 'C:\\Windows']);
  assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH'), ['PATH'], 'PATH 키가 둘 이상이면 어느 쪽이 이길지 모른다');
});

test('Qt 자식 env 는 하네스 3키를 싣고 부모의 하네스 값·Qt/Node 조작 변수를 상속하지 않는다', () => {
  const env = envOf();
  assert.equal(env.CLIENT_USER_DATA, 'C:\\tmp\\ud-a');
  assert.equal(env.CLIENT_DIAG_FILE, 'C:\\tmp\\diag-a.jsonl');
  assert.equal(env.CLIENT_SELFTEST, '1');
  for (const k of ['QT_QPA_PLATFORM', 'QT_PLUGIN_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'APPDATA']) {
    assert.equal(env[k], undefined, `${k} 가 상속됐다`);
  }
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.TEMP, 'C:\\Temp');
});

test('Qt 자식 env 는 필수 값이 비면 조립을 거부한다(조용한 기본값 폴백 없음)', () => {
  assert.throws(() => envOf({ qtBinDir: '' }), /qtBinDir/);
  assert.throws(() => envOf({ qtBinDir: undefined }), /qtBinDir/);
  assert.throws(() => envOf({ userDataDir: '  ' }), /userDataDir/);
  assert.throws(() => envOf({ diagFile: null }), /diagFile/);
});
