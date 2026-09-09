// tools/collection-sweeper 의 순수 판정부 자기검사 + 소스 정적 스캔 (phase 76 step6 · ADR-017 결정 4).
//
// 왜 여기에 있고 npm test 가 돌지 않는가: package.json 은 무수정 목록이고 `npm test` 는 "test/**/*.test.js" 만 훑는다
// (기준선 1328 을 흔들지 않는다). 왕복 하네스(roundtrip.js)는 시작할 때 이 파일을 스스로 돌린다.
// 실행: node --test tools/collection-sweeper/sweeper.test.js
//
// 무엇을 잠그는가(각각 step6 변이 R1~R6 의 방어선이다):
//   · sourceId 도출 = Node watcher(server/ftpWatcher.js) 동형 — `/`·`\` 양쪽 구분자(R1) · 2세그먼트 미만 무시(R2) · 중첩 경로
//   · 안정화 판정(크기·mtime 연속 2회 동일) · 멱등 장부(최종 결과만 등재 · 깨진 줄 무시)(R3)
//   · 응답 분류(ingested / rejected(4xx 사유 토큰) / failed(재시도 대상)) · 종료코드 규약 0/1/2
//   · 토큰 argv 가드 — 값은 결과 어디에도 담기지 않는다(R5)
//   · **소스 정적 스캔** — 스위퍼 2파일에 타이머·watch·상주 루프가 0건(R6). 패턴 상수는 이 파일 한 곳이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT, FINAL_OUTCOMES, TOKEN_ENV, TOKEN_HEADER,
  classifyResponse, deriveSourceId, exitCodeFor, findTokenLikeArgv, formatLedgerLine, ledgerKey, parseLedger,
  pathIsInside, planScan, sameObservation, sha256Hex, splitSegments, summarize, sweepOnce,
} from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- 정적 스캔 대상·패턴 (단일 출처 — 예외 목록은 없다: 스위퍼는 상주하지 않는다) ---
const SCANNED_FILES = ['sweeper.js', 'lib.js'];
// 낱말 단위(bare word)로 잡는다 — `const t = setInterval; t(...)` 같은 별칭 대입, 주석 속 언급까지 전부 red 다
// (Adr008DisciplineTest 와 같은 규율: 철자가 있으면 이유를 묻지 않는다). 상수 조립(`globalThis['setInt'+'erval']`)·
// 동적 import·eval·require·워커·자식 프로세스는 이름이 사라지므로 **그 통로 자체**를 막는다.
const RESIDENCY_PATTERNS = [
  ['setInterval', /\bsetInterval\b/],
  ['setTimeout', /\bsetTimeout\b/],
  ['setImmediate', /\bsetImmediate\b/],
  ['timers module', /['"](node:)?timers(\/promises)?['"]/],
  ['fs watch / watchFile', /\bwatch(File)?\b/],
  ['chokidar', /\bchokidar\b/],
  ['infinite loop', /\bwhile\s*\(\s*(true|1|!0)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/],
  ['signal residency', /process\s*\.\s*(on|once|addListener)\s*\(\s*['"`]SIG/],
  ['stdin residency', /process\s*\.\s*stdin\b/],
  ['dynamic global lookup', /\b(globalThis|global)\s*\[/],
  ['eval / Function', /\b(eval|Function)\s*\(/],
  ['dynamic import', /\bimport\s*\(/],
  ['require / createRequire', /\brequire\s*\(|\bcreateRequire\b/],
  ['worker thread', /\bworker_threads\b|\bnew\s+Worker\s*\(/],
  ['child process', /\bchild_process\b/],
];
// 스캔의 비공허성 — 각 패턴이 자기 표본을 실제로 잡는지(패턴 오타로 스캔이 조용히 꺼지는 것을 막는다).
const RESIDENCY_SAMPLES = [
  'const tick = setInterval; tick(scanOnce, 60_000);',
  'setTimeout(() => loop(), 500);',
  'setImmediate(loop);',
  "import { setTimeout as sleep } from 'node:timers/promises';",
  'fs.watch(dir, { recursive: true }, onEvent);',
  "const chokidar = require('chokidar');",
  'while (true) { scan(); }',
  "process.once('SIGHUP', rescan);",
  'process.stdin.resume();',
  "globalThis['setInt' + 'erval'](scan, 1000);",
  "Function('return setInterval')()(scan, 1000);",
  "const timers = await import('node:' + 'timers/promises');",
  "const { setInterval: every } = createRequire(import.meta.url)('timers');",
  "new Worker(new URL('./loop.js', import.meta.url));",
  "import { fork } from 'node:child_process';",
];

// --- sourceId 도출 (R1 · R2) ---

test('deriveSourceId — <spool>/<sourceId>/<file> 의 첫 세그먼트가 sourceId 다(슬래시)', () => {
  assert.deepEqual(deriveSourceId('src-1/article.txt'), { sourceId: 'src-1', rel: 'src-1/article.txt' });
});

test('deriveSourceId — 백슬래시 구분자(Windows readdir·watcher 이벤트)도 같은 규칙이다 (R1)', () => {
  assert.deepEqual(deriveSourceId('src-1\\article.txt'), { sourceId: 'src-1', rel: 'src-1/article.txt' });
  assert.deepEqual(deriveSourceId('src-1\\nested/deep.txt'), { sourceId: 'src-1', rel: 'src-1/nested/deep.txt' });
});

test('deriveSourceId — 중첩 경로는 첫 세그먼트만 본다(watcher parts[0] 동형)', () => {
  assert.equal(deriveSourceId('src-1/a/b/c.txt').sourceId, 'src-1');
});

test('deriveSourceId — 2세그먼트 미만(최상위 항목)은 무시한다 = null (R2)', () => {
  assert.equal(deriveSourceId('toplevel.txt'), null);
  assert.equal(deriveSourceId(''), null);
  assert.equal(deriveSourceId(null), null);
  assert.equal(deriveSourceId(undefined), null);
  assert.equal(deriveSourceId('/'), null);
});

test('splitSegments — 선행·중복 구분자는 빈 조각으로 버린다(watcher filter(Boolean) 동형)', () => {
  assert.deepEqual(splitSegments('/src-1//x.txt'), ['src-1', 'x.txt']);
  assert.deepEqual(splitSegments('\\src-1\\\\x.txt'), ['src-1', 'x.txt']);
});

test('planScan — 후보(2세그먼트 이상)와 무시(최상위)를 가른다', () => {
  const plan = planScan(['a/x.txt', 'toplevel.txt', 'b\\sub\\y.txt', '.collection-sweeper-ledger.jsonl']);
  assert.deepEqual(plan.candidates, [
    { sourceId: 'a', rel: 'a/x.txt' },
    { sourceId: 'b', rel: 'b/sub/y.txt' },
  ]);
  assert.deepEqual(plan.ignored, ['toplevel.txt', '.collection-sweeper-ledger.jsonl']);
});

// --- 안정화 판정 (부분 파일 방어) ---

test('sameObservation — 크기·mtime 이 연속 2회 동일할 때만 안정', () => {
  assert.equal(sameObservation({ size: 10, mtimeMs: 1 }, { size: 10, mtimeMs: 1 }), true);
  assert.equal(sameObservation({ size: 10, mtimeMs: 1 }, { size: 11, mtimeMs: 1 }), false);
  assert.equal(sameObservation({ size: 10, mtimeMs: 1 }, { size: 10, mtimeMs: 2 }), false);
  assert.equal(sameObservation(null, { size: 10, mtimeMs: 1 }), false);
  assert.equal(sameObservation({ size: 10, mtimeMs: 1 }, null), false);
});

// --- 멱등 장부 (R3) ---

test('ledgerKey — 상대경로(구분자 정규화) + 내용 sha256', () => {
  const sha = sha256Hex('hello');
  assert.equal(ledgerKey('src-1\\a.txt', sha), `src-1/a.txt#${sha}`);
  assert.equal(ledgerKey('src-1/a.txt', sha), `src-1/a.txt#${sha}`);
  assert.equal(sha256Hex(Buffer.from('hello')), sha);
});

test('parseLedger — 최종 결과(ingested·rejected)만 등재하고 failed·빈 줄·깨진 줄은 건너뛴다', () => {
  const text = [
    formatLedgerLine({ key: 'a/x#1', outcome: 'ingested', articleId: 'A1' }),
    formatLedgerLine({ key: 'a/y#2', outcome: 'rejected', reason: 'unregistered' }),
    formatLedgerLine({ key: 'a/z#3', outcome: 'failed', reason: 'http-500' }),
    '',
    '{not json',
    formatLedgerLine({ outcome: 'ingested' }), // key 없음
  ].join('');
  const done = parseLedger(text);
  assert.deepEqual([...done.keys()], ['a/x#1', 'a/y#2']);
  assert.equal(done.get('a/x#1').articleId, 'A1');
  assert.deepEqual([...FINAL_OUTCOMES].sort(), ['ingested', 'rejected']);
});

test('formatLedgerLine — 한 줄 JSON + 개행(append 전용)', () => {
  const line = formatLedgerLine({ key: 'k', outcome: 'ingested' });
  assert.ok(line.endsWith('\n'));
  assert.equal(line.split('\n').length, 2);
  assert.deepEqual(JSON.parse(line), { key: 'k', outcome: 'ingested' });
});

// --- 응답 분류 ---

test('classifyResponse — 200 {ok:true, articleId} 는 ingested', () => {
  assert.deepEqual(classifyResponse(200, { ok: true, articleId: 'A1' }), { outcome: 'ingested', reason: null, articleId: 'A1' });
});

test('classifyResponse — 403 unregistered·inactive / 400 사유 토큰은 rejected(최종 · 재시도 안 함)', () => {
  assert.deepEqual(classifyResponse(403, { ok: false, reason: 'unregistered' }), { outcome: 'rejected', reason: 'unregistered', articleId: null });
  assert.deepEqual(classifyResponse(403, { ok: false, reason: 'inactive' }), { outcome: 'rejected', reason: 'inactive', articleId: null });
  assert.equal(classifyResponse(400, { ok: false, reason: 'bad-request' }).outcome, 'rejected');
});

test('classifyResponse — 401·503·5xx·비정상 본문·네트워크 오류는 failed(다음 실행에 재시도)', () => {
  assert.deepEqual(classifyResponse(401, { ok: false, reason: 'unauthenticated' }), { outcome: 'failed', reason: 'unauthenticated', articleId: null });
  assert.equal(classifyResponse(503, { ok: false, reason: 'collection-disabled' }).reason, 'collection-disabled');
  assert.equal(classifyResponse(500, { ok: false, reason: 'internal-error' }).outcome, 'failed');
  assert.deepEqual(classifyResponse(502, undefined), { outcome: 'failed', reason: 'http-502', articleId: null });
  assert.deepEqual(classifyResponse(200, { ok: false }), { outcome: 'failed', reason: 'malformed-response', articleId: null });
  assert.deepEqual(classifyResponse(200, { ok: true }), { outcome: 'failed', reason: 'malformed-response', articleId: null });
  assert.deepEqual(classifyResponse(null, undefined), { outcome: 'failed', reason: 'network', articleId: null });
  // 403 인데 사유 토큰이 없으면 최종으로 못 박지 않는다(무엇이 거부됐는지 모른다).
  assert.equal(classifyResponse(403, {}).outcome, 'failed');
});

// --- 종료코드 규약 ---

test('EXIT — 0 전건 성공/처리 0건 · 1 일부 실패(rejected·failed) · 2 설정 오류', () => {
  assert.deepEqual(EXIT, { OK: 0, PARTIAL: 1, CONFIG: 2 });
  assert.equal(exitCodeFor({}), 0);
  assert.equal(exitCodeFor({ ingested: 3, skipped: 2, deferred: 1, ignored: 4, 'dry-run': 1 }), 0);
  assert.equal(exitCodeFor({ ingested: 3, rejected: 1 }), 1);
  assert.equal(exitCodeFor({ failed: 1 }), 1);
});

test('summarize — 결과 배열을 outcome 별 건수로 접는다', () => {
  const counts = summarize([{ outcome: 'ingested' }, { outcome: 'ingested' }, { outcome: 'rejected' }, { outcome: 'deferred' }]);
  assert.deepEqual(counts, { ingested: 2, rejected: 1, deferred: 1 });
});

// --- 토큰 argv 가드 (R5) ---

test('findTokenLikeArgv — 토큰 플래그·헤더 표기·env 토큰 값이 argv 에 오면 위치만 돌려준다(값은 담지 않는다)', () => {
  const secret = 'rt-secret-token-0123456789abcdef';
  const cases = [
    ['--spool', 'x', '--token', secret],
    ['--collection-token=' + secret],
    ['--x-collection-token', secret],
    ['-token', secret],
    ['x-collection-token: ' + secret],
    ['X-Collection-Token=' + secret],
    ['--base', 'http://127.0.0.1:1/?' + secret],
  ];
  for (const argv of cases) {
    const hit = findTokenLikeArgv(argv, secret);
    assert.ok(hit, `가드가 잡아야 한다: ${JSON.stringify(argv.map((a) => a.replace(secret, '<v>')))}`);
    assert.equal(typeof hit.index, 'number');
    assert.ok(!JSON.stringify(hit).includes(secret), '가드 결과에 토큰 값이 담겼다');
  }
});

test('findTokenLikeArgv — 정상 인자는 통과한다 · env 토큰 미설정이면 값 규칙은 꺼진다', () => {
  assert.equal(findTokenLikeArgv(['--spool', 'D:/spool', '--base', 'http://127.0.0.1:3001', '--once', '--move-to', 'D:/done'], 'rt-secret-token-0123456789abcdef'), null);
  assert.equal(findTokenLikeArgv(['--spool', 'tokens/'], undefined), null);
  assert.equal(findTokenLikeArgv(['--spool', 'tokens/'], ''), null);
  assert.equal(findTokenLikeArgv([], 'x'), null);
});

test('토큰은 env COLLECTION_TOKEN 으로만 · 헤더 이름은 x-collection-token(서버 계약 동형)', () => {
  assert.equal(TOKEN_ENV, 'COLLECTION_TOKEN');
  assert.equal(TOKEN_HEADER, 'x-collection-token');
});

// --- 파일 루프 (sweepOnce — 의존성 주입으로 fs·HTTP 없이 실패 격리를 잠근다 · R4) ---

function fakeDeps(overrides = {}) {
  const posted = [];
  const ledger = [];
  const moved = [];
  const logs = [];
  const deps = {
    observe: () => ({ size: 1, mtimeMs: 1 }),
    readFile: (rel) => Buffer.from(`body of ${rel}`),
    post: async (sourceId, payload) => { posted.push({ sourceId, payload }); return { status: 200, json: { ok: true, articleId: `A-${posted.length}` } }; },
    ledgerHas: () => null,
    ledgerAppend: (entry) => { ledger.push(entry); },
    moveOut: (rel) => { moved.push(rel); return `done/${rel}`; },
    log: (line) => { logs.push(line); },
    dryRun: false,
    moveTo: null,
    ...overrides,
  };
  return { deps, posted, ledger, moved, logs };
}

const twoFiles = () => ({
  candidates: [{ sourceId: 'a', rel: 'a/1.txt' }, { sourceId: 'a', rel: 'a/2.txt' }],
  first: new Map([['a/1.txt', { size: 1, mtimeMs: 1 }], ['a/2.txt', { size: 1, mtimeMs: 1 }]]),
});

test('sweepOnce — 첫 파일 읽기가 예외를 던져도 둘째 파일은 처리된다(실패 격리 · R4a)', async () => {
  const { deps, posted, ledger } = fakeDeps({ readFile: (rel) => { if (rel === 'a/1.txt') throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return Buffer.from('x'); } });
  const { candidates, first } = twoFiles();
  const results = await sweepOnce(candidates, first, deps);
  assert.deepEqual(results.map((r) => r.outcome), ['failed', 'ingested']);
  assert.equal(results[0].reason, 'error:EBUSY');
  assert.equal(posted.length, 1);
  assert.equal(ledger.length, 1);
});

test('sweepOnce — 전송 결과가 거부/실패여도 다음 파일로 간다(R4b) · 최종 결과만 장부', async () => {
  let n = 0;
  const { deps, ledger } = fakeDeps({ post: async () => { n += 1; return n === 1 ? { status: 403, json: { ok: false, reason: 'unregistered' } } : { status: 500, json: { ok: false, reason: 'internal-error' } }; } });
  const { candidates, first } = twoFiles();
  const results = await sweepOnce(candidates, first, deps);
  assert.deepEqual(results.map((r) => `${r.outcome}:${r.reason}`), ['rejected:unregistered', 'failed:internal-error']);
  assert.deepEqual(ledger.map((e) => e.outcome), ['rejected']);
});

test('sweepOnce — 장부 기록 실패는 격리하지 않고 던진다(장부 없는 기사 = 다음 실행의 중복)', async () => {
  const { deps } = fakeDeps({ ledgerAppend: () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); } });
  const { candidates, first } = twoFiles();
  await assert.rejects(() => sweepOnce(candidates, first, deps), (err) => err.code === 'EIO');
});

test('sweepOnce — 안정화 실패는 deferred · 장부 적중은 skipped(articleId 전달) · dry-run 은 전송 0', async () => {
  const { candidates, first } = twoFiles();
  const unstable = fakeDeps({ observe: (rel) => (rel === 'a/1.txt' ? { size: 2, mtimeMs: 1 } : { size: 1, mtimeMs: 1 }) });
  const r1 = await sweepOnce(candidates, first, unstable.deps);
  assert.deepEqual(r1.map((r) => r.outcome), ['deferred', 'ingested']);
  assert.equal(r1[0].reason, 'unstable');

  const hit = fakeDeps({ ledgerHas: (key) => (key.startsWith('a/1.txt#') ? { outcome: 'ingested', articleId: 'OLD' } : null) });
  const r2 = await sweepOnce(candidates, first, hit.deps);
  assert.deepEqual(r2.map((r) => r.outcome), ['skipped', 'ingested']);
  assert.equal(r2[0].articleId, 'OLD');
  assert.equal(hit.posted.length, 1);

  const dry = fakeDeps({ dryRun: true });
  const r3 = await sweepOnce(candidates, first, dry.deps);
  assert.deepEqual(r3.map((r) => r.outcome), ['dry-run', 'dry-run']);
  assert.equal(dry.posted.length, 0);
  assert.equal(dry.ledger.length, 0);
});

test('sweepOnce — 이동 실패는 ingested 를 뒤집지 않는다(기사는 생겼고 장부에도 있다) · moveError 만 남긴다', async () => {
  const { deps, ledger } = fakeDeps({ moveTo: 'done', moveOut: (rel) => { if (rel === 'a/1.txt') throw Object.assign(new Error('x'), { code: 'EPERM' }); return `done/${rel}`; } });
  const { candidates, first } = twoFiles();
  const results = await sweepOnce(candidates, first, deps);
  assert.deepEqual(results.map((r) => r.outcome), ['ingested', 'ingested']);
  assert.equal(results[0].moveError, 'EPERM');
  assert.equal(results[1].moveError, null);
  assert.equal(results[1].movedTo, 'done/a/2.txt');
  assert.equal(ledger.length, 2);
});

test('sweepOnce — ingested 가 아닌 파일은 옮기지 않는다(rejected·failed·deferred·skipped·dry-run) — 원본은 수집 폴더에 남는다', async () => {
  // 왜 이 줄이 필요한가(④ 테스트 게이트 · 2026-09-09): 이동은 **기사가 생긴 파일만** 대상이다.
  // 이동이 ingested 밖으로 새면 (가) 거부·실패한 파일이 수집 폴더에서 사라져 **다음 실행이 재시도하지 못하고**
  // (나) 장부에도 없어서 어디로 갔는지 남지 않는다 — 무삭제·재시도 규율이 조용히 깨지는 자리다.
  // 종전 28항은 ingested 의 이동만 봤고, 이동을 if 블록 밖으로 옮겨도 전부 green 이었다.
  const { candidates, first } = twoFiles();

  const rejected = fakeDeps({ moveTo: 'done', post: async () => ({ status: 403, json: { ok: false, reason: 'unregistered' } }) });
  const r1 = await sweepOnce(candidates, first, rejected.deps);
  assert.deepEqual(r1.map((r) => r.outcome), ['rejected', 'rejected']);
  assert.deepEqual(rejected.moved, [], 'rejected 파일을 옮겼다');
  assert.deepEqual(r1.map((r) => r.movedTo), [null, null]);

  const failed = fakeDeps({ moveTo: 'done', post: async () => ({ status: 500, json: { ok: false, reason: 'internal-error' } }) });
  const r2 = await sweepOnce(candidates, first, failed.deps);
  assert.deepEqual(r2.map((r) => r.outcome), ['failed', 'failed']);
  assert.deepEqual(failed.moved, [], 'failed 파일을 옮겼다 — 다음 실행이 재시도할 원본이 사라진다');

  const deferred = fakeDeps({ moveTo: 'done', observe: () => ({ size: 99, mtimeMs: 99 }) });
  const r3 = await sweepOnce(candidates, first, deferred.deps);
  assert.deepEqual(r3.map((r) => r.outcome), ['deferred', 'deferred']);
  assert.deepEqual(deferred.moved, [], '아직 쓰이는 중인 파일을 옮겼다');

  const skipped = fakeDeps({ moveTo: 'done', ledgerHas: () => ({ outcome: 'ingested', articleId: 'OLD' }) });
  const r4 = await sweepOnce(candidates, first, skipped.deps);
  assert.deepEqual(r4.map((r) => r.outcome), ['skipped', 'skipped']);
  assert.deepEqual(skipped.moved, [], '장부 적중(이미 처리)은 이번 실행이 옮길 대상이 아니다');

  const dry = fakeDeps({ moveTo: 'done', dryRun: true });
  const r5 = await sweepOnce(candidates, first, dry.deps);
  assert.deepEqual(r5.map((r) => r.outcome), ['dry-run', 'dry-run']);
  assert.deepEqual(dry.moved, [], 'dry-run 이 파일을 옮겼다 — 그것은 dry 가 아니다');

  // 대조군: ingested 이고 --move-to 가 있을 때만 옮긴다. --move-to 가 없으면 ingested 여도 옮기지 않는다.
  const moving = fakeDeps({ moveTo: 'done' });
  const r6 = await sweepOnce(candidates, first, moving.deps);
  assert.deepEqual(r6.map((r) => r.outcome), ['ingested', 'ingested']);
  assert.deepEqual(moving.moved, ['a/1.txt', 'a/2.txt']);
  const noMoveTo = fakeDeps();
  const r7 = await sweepOnce(candidates, first, noMoveTo.deps);
  assert.deepEqual(r7.map((r) => r.outcome), ['ingested', 'ingested']);
  assert.deepEqual(noMoveTo.moved, [], '--move-to 없이 옮겼다(기본은 무이동이다)');
});

test('sweepOnce — payload 는 파일 바이트의 utf8 그대로 · 장부 키 = rel#sha256 · 로그에 payload 없음', async () => {
  const { deps, posted, ledger, logs } = fakeDeps({ readFile: () => Buffer.from('제목\n본문 secret-body') });
  const { candidates, first } = twoFiles();
  await sweepOnce(candidates, first, deps);
  assert.equal(posted[0].payload, '제목\n본문 secret-body');
  assert.equal(ledger[0].key, `a/1.txt#${sha256Hex(Buffer.from('제목\n본문 secret-body'))}`);
  assert.ok(logs.every((l) => !l.includes('secret-body')), '로그에 payload 가 실렸다');
});

// --- 경로 포함 판정 (--move-to 가 스풀 안이면 거부 — 이동한 파일이 다시 수집된다) ---

test('pathIsInside — win32 는 대소문자·구분자 무시, posix 는 구분', () => {
  assert.equal(pathIsInside('D:\\spool\\done', 'd:/spool', 'win32'), true);
  assert.equal(pathIsInside('D:\\spool', 'D:\\spool', 'win32'), true);
  assert.equal(pathIsInside('D:\\spool-done', 'D:\\spool', 'win32'), false);
  assert.equal(pathIsInside('/spool/done', '/spool', 'linux'), true);
  assert.equal(pathIsInside('/Spool/done', '/spool', 'linux'), false);
  assert.equal(pathIsInside('/spooler', '/spool', 'linux'), false);
});

// --- 소스 정적 스캔 (R6 — '앱 밖 · 주기 없음' 의 기계 방어선) ---

test('정적 스캔 — 스위퍼 2파일에 타이머·watch·상주 루프 패턴이 0건이다', () => {
  for (const name of SCANNED_FILES) {
    const file = path.join(HERE, name);
    assert.ok(fs.existsSync(file), `스캔 대상이 없다: ${name}`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.split('\n').length > 40, `${name} 이 비어 있다시피 하다 — 스캔이 공허하다`);
    for (const [label, pattern] of RESIDENCY_PATTERNS) {
      const m = text.match(pattern);
      // assert.ok — assert.equal 은 실패 시 파일 전문을 diff 로 쏟는다(오프셋·행만 남긴다).
      const line = m ? text.slice(0, m.index).split('\n').length : 0;
      assert.ok(m === null, `${name}:${line}: 상주 패턴 '${label}' 발견 — ${JSON.stringify(m && m[0])}`);
    }
  }
});

test('정적 스캔 — 패턴 하나하나가 자기 표본을 잡는다(비공허성)', () => {
  assert.equal(RESIDENCY_PATTERNS.length, RESIDENCY_SAMPLES.length);
  RESIDENCY_PATTERNS.forEach(([label, pattern], i) => {
    assert.ok(pattern.test(RESIDENCY_SAMPLES[i]), `패턴 '${label}' 이 표본을 못 잡는다: ${RESIDENCY_SAMPLES[i]}`);
  });
});

test('정적 스캔 — 스위퍼는 토큰을 argv 에서 읽지 않고 env 이름 한 곳에서만 읽는다', () => {
  const text = fs.readFileSync(path.join(HERE, 'sweeper.js'), 'utf8');
  const reads = text.match(/process\.env\.(\w+)/g) ?? [];
  assert.ok(reads.includes('process.env.COLLECTION_TOKEN'), '토큰 env 판독이 없다');
  assert.ok(!/process\.env\[/.test(text), '동적 env 판독은 금지(단일 출처가 흐려진다)');
  assert.ok(/findTokenLikeArgv\s*\(/.test(text), 'argv 토큰 가드가 배선되지 않았다');
});
