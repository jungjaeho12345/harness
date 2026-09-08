// scripts/lib/tickCutover.mjs 의 순수 판정부 자기검사 (phase 76 step7 — tick-cutover).
//
// 왜 여기에 있고 npm test 가 돌지 않는가: package.json 은 무수정 목록이고 `npm test` 는 "test/**/*.test.js" 만 훑는다.
// scripts/tick-cutover-probe.mjs 는 시작할 때 이 파일을 스스로 돌린다(빨간 채로는 서버를 띄우지 않는다).
// 실행: node --test scripts/lib/tickCutover.self-test.mjs
//
// 무엇을 잠그는가(각각 step7 변이의 방어선이다):
//   · 레이트리밋 산술 — 15분/10회 고정 창에서 주기 p초의 호출 수 = ceil(900/p) · 임계 주기 90초(S 산술표의 근거)
//   · 왕복 표 판정 — 기대치와 다르면 red · Node≠Spring 이면 red · 측정 누락은 'not-measured' 로 red(공허 통과 금지)
//   · 경로 비노출 판정 — 계약 assertNoSpoolPath 와 같은 4축(spoolDir 키 · 슬러그 · .json · 경로 구분자)
//   · 스풀 파일 수 — 파일명 규칙(<articleId>_<stamp>.json)으로 기사별 개수 · .tmp 제외 · 중복 기사 목록
//   · A-2 다중 인스턴스 표 — Node 2번째 기동은 exit 1 이어야 하고(S6) · 교차 세션은 401 · 순차 tick 은 파일 1→1 · 동시 tick 은 수치 기록
//   · ps1 정적 검사 — 실제 packaging/server/tick-distribution-spring.ps1 이 자격 평문·토큰 로그·Origin 헤더·상주 루프·락 부재·비0 종료코드 부재 0건(S4·S5)
//   · ps1 인코딩 — 비ASCII 가 있는 ps1 은 UTF-8 BOM 이 있어야 한다(Windows PowerShell 5.1 은 BOM 없으면 ANSI 로 읽는다)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISTRIBUTED_ITEM_KEYS, EXPECTED_ROUNDTRIP, LOGIN_RATE_LIMIT, PS1_ENV, PS1_EXIT, ROUNDTRIP_ROW_IDS, TICK_KEYS,
  countSpoolFiles, criticalPeriodSec, describeLogin, describeTick, duplicateArticles, formatMultiInstance,
  formatRateLimitTable, formatSideBySide, judgeMultiInstance, judgeRoundtrip, loginsPerWindow, outputLeaks,
  ps1EncodingFinding, ps1StaticFindings, rateLimitTable, spoolPathLeaks,
} from './tickCutover.mjs';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const PS1 = nodePath.resolve(HERE, '..', '..', 'packaging', 'server', 'tick-distribution-spring.ps1');

// --- 상수 ---

test('TICK_KEYS 는 계약의 6키(정렬)이고 distributed 원소는 3키다', () => {
  assert.deepEqual([...TICK_KEYS], ['at', 'distributed', 'failed', 'invalid', 'ok', 'scanned']);
  assert.deepEqual([...DISTRIBUTED_ITEM_KEYS], ['articleId', 'kinds', 'status']);
  assert.deepEqual(LOGIN_RATE_LIMIT, { limit: 10, windowMs: 15 * 60 * 1000 });
  assert.deepEqual(PS1_ENV, { base: 'NEWS_TICK_BASE', user: 'NEWS_TICK_USER', password: 'NEWS_TICK_PASSWORD' });
  assert.deepEqual(PS1_EXIT, { ok: 0, config: 2, login: 3, tick: 4, network: 5, lock: 6 });
});

// --- 레이트리밋 산술 ---

test('loginsPerWindow — 고정 창 15분에 주기 p초면 ceil(900/p)회 · 임계 주기 90초', () => {
  assert.equal(loginsPerWindow(60), 15);
  assert.equal(loginsPerWindow(300), 3);
  assert.equal(loginsPerWindow(90), 10);
  assert.equal(loginsPerWindow(89), 11);
  assert.equal(loginsPerWindow(900), 1);
  assert.equal(loginsPerWindow(1800), 1);
  assert.equal(criticalPeriodSec(), 90);
  assert.throws(() => loginsPerWindow(0), /주기/);
  assert.throws(() => loginsPerWindow(-5), /주기/);
  assert.throws(() => loginsPerWindow('60'), /주기/);
});

test('rateLimitTable — 한도 초과 여부가 행마다 붙고 60초는 초과 · 90초·300초는 통과', () => {
  const rows = rateLimitTable([60, 90, 300]);
  assert.deepEqual(rows, [
    { periodSec: 60, callsPerWindow: 15, exceeds: true },
    { periodSec: 90, callsPerWindow: 10, exceeds: false },
    { periodSec: 300, callsPerWindow: 3, exceeds: false },
  ]);
  const lines = formatRateLimitTable(rows);
  assert.ok(lines[0].startsWith('|'), '마크다운 표');
  assert.ok(lines.some((l) => l.includes('| 60 |') && l.includes('15') && l.includes('429')), '초과 행에 429 표기');
  assert.ok(lines.some((l) => l.includes('| 300 |') && l.includes('| 3 |')), '통과 행');
});

// --- 왕복 표 판정 ---

function allExpected() {
  const side = {};
  for (const id of ROUNDTRIP_ROW_IDS) side[id] = EXPECTED_ROUNDTRIP[id];
  return side;
}

test('judgeRoundtrip — 전 행이 기대와 같고 Node=Spring 이면 ok', () => {
  const r = judgeRoundtrip({ node: allExpected(), spring: allExpected() });
  assert.equal(r.ok, true, r.failures.join('\n'));
  assert.equal(r.rows.length, ROUNDTRIP_ROW_IDS.length);
  assert.ok(r.rows.every((row) => row.same && row.nodeOk && row.springOk));
  const lines = formatSideBySide(r.rows);
  assert.ok(lines[0].includes('node') && lines[0].includes('spring'));
  assert.equal(lines.length, r.rows.length + 2, '헤더 2줄 + 행');
});

test('judgeRoundtrip — Spring 한 행이 다르면 red 이고 실패 메시지가 행 id 를 가리킨다', () => {
  const spring = allExpected();
  spring['tick-no-session'] = '200 ok=true';
  const r = judgeRoundtrip({ node: allExpected(), spring });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('tick-no-session') && f.includes('spring')));
  const row = r.rows.find((x) => x.id === 'tick-no-session');
  assert.equal(row.same, false);
  assert.equal(row.nodeOk, true);
  assert.equal(row.springOk, false);
});

test('judgeRoundtrip — 측정이 빠진 행은 not-measured 로 red(공허 통과 금지)', () => {
  const node = allExpected();
  delete node['login-11th'];
  const r = judgeRoundtrip({ node, spring: allExpected() });
  assert.equal(r.ok, false);
  assert.equal(r.rows.find((x) => x.id === 'login-11th').node, 'not-measured');
  assert.ok(r.failures.some((f) => f.includes('login-11th') && f.includes('not-measured')));
});

test('judgeRoundtrip — 두 서버가 같은 방향으로 틀리면(same 이지만 기대≠) red', () => {
  const node = allExpected();
  const spring = allExpected();
  node['tick-non-z'] = 'R=200 D=200';
  spring['tick-non-z'] = 'R=200 D=200';
  const r = judgeRoundtrip({ node, spring });
  assert.equal(r.ok, false);
  const row = r.rows.find((x) => x.id === 'tick-non-z');
  assert.equal(row.same, true);
  assert.equal(row.nodeOk, false);
});

// --- 관측 정규화 ---

test('describeLogin / describeTick — 상태·sessionId 형·키 집합·distributed 원소를 문자열 한 줄로', () => {
  assert.equal(describeLogin({ status: 200, json: { ok: true, sessionId: 'abc', user: {} } }), '200 sessionId=string');
  assert.equal(describeLogin({ status: 401, json: { ok: false, reason: 'invalid-credentials' } }), '401 sessionId=undefined');
  const tick = { status: 200, json: { ok: true, at: '2026-09-08T00:00:00.000Z', scanned: 1, distributed: [{ articleId: 'A1', kinds: ['press'], status: 'DPS' }], failed: [], invalid: [] } };
  assert.equal(describeTick(tick, 'A1'), 'keys=at,distributed,failed,invalid,ok,scanned item=articleId,kinds,status kinds=press status=DPS');
  assert.equal(describeTick({ status: 503, json: { ok: false, reason: 'spool-disabled' } }, 'A1'), 'keys=ok,reason item=absent');
});

test('spoolPathLeaks — 계약 assertNoSpoolPath 의 4축', () => {
  const clean = { ok: true, at: '2026-09-08T00:00:00.000Z', scanned: 0, distributed: [], failed: [], invalid: [] };
  assert.deepEqual(spoolPathLeaks(clean, ['tc-press']), []);
  assert.deepEqual(spoolPathLeaks({ ...clean, failed: [{ spoolDir: 'x' }] }, ['tc-press']), ['spoolDir', 'separator'].filter((k) => k === 'spoolDir'));
  assert.ok(spoolPathLeaks({ ...clean, failed: [{ reason: 'tc-press' }] }, ['tc-press']).includes('slug'));
  assert.ok(spoolPathLeaks({ ...clean, failed: [{ reason: 'a.json' }] }, ['tc-press']).includes('.json'));
  assert.ok(spoolPathLeaks({ ...clean, failed: [{ reason: 'C:\\x' }] }, ['tc-press']).includes('separator'));
  assert.ok(spoolPathLeaks({ ...clean, failed: [{ reason: 'a/b' }] }, ['tc-press']).includes('separator'));
});

// --- 스풀 파일 수 ---

test('countSpoolFiles / duplicateArticles — 파일명 규칙으로 기사별 개수 · .tmp 제외', () => {
  const names = [
    'AKR20260908000000001_20260908T000000000Z.json',
    'AKR20260908000000001_20260908T000000001Z.json',
    '.AKR20260908000000001_20260908T000000002Z.json.tmp',
    'AKR20260908000000002_20260908T000000000Z.json',
    'garbage.txt',
  ];
  assert.equal(countSpoolFiles(names, 'AKR20260908000000001'), 2);
  assert.equal(countSpoolFiles(names, 'AKR20260908000000002'), 1);
  assert.equal(countSpoolFiles(names, 'AKR20260908000000003'), 0);
  assert.deepEqual(duplicateArticles(names), { AKR20260908000000001: 2 });
  assert.deepEqual(duplicateArticles([]), {});
});

// --- A-2 다중 인스턴스 표 ---

function goodMulti() {
  return {
    springSecondBoot: 'health-ok',
    nodeSecondBoot: { exitCode: 1, elapsedMs: 40, hint: true, firstStillHealthy: true },
    crossSession: { aTokenOnB: '401:unauthenticated', bOwnToken: '200' },
    sequential: { tickA: 'distributed', tickB: 'not-distributed', filesAfterA: 1, filesAfterB: 1 },
    concurrent: [
      { round: 1, files: 2, inA: true, inB: true },
      { round: 2, files: 1, inA: true, inB: false },
      { round: 3, files: 1, inA: false, inB: true },
    ],
  };
}

test('judgeMultiInstance — 정상 관측은 ok 이고 동시 tick 의 중복 회차·최대 파일 수를 센다(판정이 아니라 기록)', () => {
  const r = judgeMultiInstance(goodMulti());
  assert.equal(r.ok, true, r.failures.join('\n'));
  assert.equal(r.duplicateRounds, 1);
  assert.equal(r.maxFiles, 2);
  assert.equal(r.rounds, 3);
  const lines = formatMultiInstance(r);
  assert.ok(lines.some((l) => l.includes('exit 1') || l.includes('exit=1')), 'Node 2번째 기동 줄');
  assert.ok(lines.some((l) => l.includes('health-ok')), 'Spring 2번째 기동 줄');
  assert.ok(lines.some((l) => l.includes('1/3') || l.includes('중복 1')), '동시 tick 중복 회차');
});

test('judgeMultiInstance — Node 2번째가 살아 뜨면(exit≠1) red · 교차 세션 200 이면 red · 순차 tick 파일 1→2 면 red · 동시 0회면 red', () => {
  let obs = goodMulti();
  obs.nodeSecondBoot = { exitCode: 0, elapsedMs: 500, hint: false, firstStillHealthy: true };
  let r = judgeMultiInstance(obs);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('Node') && f.includes('ADR-012')));

  obs = goodMulti();
  obs.crossSession.aTokenOnB = '200';
  r = judgeMultiInstance(obs);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('교차 세션')));

  obs = goodMulti();
  obs.sequential.filesAfterB = 2;
  r = judgeMultiInstance(obs);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('순차')));

  obs = goodMulti();
  obs.springSecondBoot = 'failed:exit=1';
  r = judgeMultiInstance(obs);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('Spring 2번째')));

  obs = goodMulti();
  obs.concurrent = [];
  r = judgeMultiInstance(obs);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('동시')));
});

// --- ps1 정적 검사 (실제 파일) ---

test('ps1 — 실제 packaging/server/tick-distribution-spring.ps1 은 정적 검사 0건 · UTF-8 BOM', () => {
  assert.ok(fs.existsSync(PS1), `ps1 이 없다: ${PS1}`);
  const bytes = fs.readFileSync(PS1);
  assert.equal(ps1EncodingFinding(bytes), null);
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  assert.deepEqual(ps1StaticFindings(text), []);
  // 환경변수 이름 3개가 한 곳(주석 아님)에서 실제로 읽힌다.
  assert.ok(text.includes(`$env:${PS1_ENV.user}`) && text.includes(`$env:${PS1_ENV.password}`) && text.includes(`$env:${PS1_ENV.base}`));
});

test('ps1 정적 검사 — 변이 6종을 각각 이름으로 잡는다', () => {
  const text = fs.readFileSync(PS1, 'utf8').replace(/^\uFEFF/, '');
  // S5: 자격 평문
  assert.ok(ps1StaticFindings(text.replace('$secret = $env:NEWS_TICK_PASSWORD', '$secret = "hunter2"')).includes('literal-password'));
  assert.ok(ps1StaticFindings(text.replace('$user = $env:NEWS_TICK_USER', '$user = "admin"')).includes('literal-user'));
  // S4: 비0 종료코드 제거(전부 exit 0)
  assert.ok(ps1StaticFindings(text.replace(/exit \$code/g, 'exit 0')).includes('no-nonzero-exit'));
  // 토큰·자격 로그
  assert.ok(ps1StaticFindings(`${text}\nWrite-Output $login\n`).includes('login-response-logged'));
  assert.ok(ps1StaticFindings(`${text}\nWrite-Output "sid=$($login.json.sessionId)"\n`).includes('token-logged'));
  assert.ok(ps1StaticFindings(`${text}\nWrite-Output $secret\n`).includes('credential-logged'));
  // 브라우저 출처 헤더를 흉내내면 ADR-009 관용을 쓰지 않는 것이다
  assert.ok(ps1StaticFindings(text.replace("'x-session-id' =", "'Origin' = 'http://127.0.0.1:3001'; 'x-session-id' =")).includes('browser-origin-header'));
  // 상주 루프·타이머(앱 밖이라도 스크립트가 스스로 깨어나면 스케줄러 이중 실행 방지가 무의미해진다)
  assert.ok(ps1StaticFindings(`${text}\nwhile ($true) { Start-Sleep -Seconds 60 }\n`).includes('resident-loop'));
  assert.ok(ps1StaticFindings(`${text}\nStart-Sleep -Seconds 60\n`).includes('resident-loop'));
  assert.ok(ps1StaticFindings(`${text}\nStart-Sleep 60\n`).includes('resident-loop'));
  assert.ok(ps1StaticFindings(`${text}\nStart-Sleep -Milliseconds 60000\n`).includes('resident-loop'));
  assert.ok(!ps1StaticFindings(`${text}\nStart-Sleep -Milliseconds 200\n`).includes('resident-loop'), '락 재시도의 밀리초 대기는 상주 루프가 아니다');
  // 락 제거
  assert.ok(ps1StaticFindings(text.replace('[IO.FileShare]::None', '[IO.FileShare]::ReadWrite')).includes('no-lock'));
});

test('ps1EncodingFinding — 비ASCII + BOM 없음 → missing-utf8-bom · BOM 있으면 null · ASCII 만이면 null', () => {
  assert.equal(ps1EncodingFinding(Buffer.from('# 한글 주석\n', 'utf8')), 'missing-utf8-bom');
  assert.equal(ps1EncodingFinding(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('# 한글\n', 'utf8')])), null);
  assert.equal(ps1EncodingFinding(Buffer.from('# ascii only\n', 'utf8')), null);
});

// --- 출력 위생 ---

test('outputLeaks — 출력에 섞인 비밀·토큰·경로를 라벨로 돌려준다(값은 싣지 않는다)', () => {
  const leaks = outputLeaks('tick ok distributed=1 sid=abcdef0123456789 C:\\tmp\\spool', [
    { label: 'password', value: 'admin123' }, { label: 'session', value: 'abcdef0123456789' }, { label: 'spool', value: 'C:\\tmp\\spool' },
  ]);
  assert.deepEqual(leaks, ['session', 'spool']);
  assert.deepEqual(outputLeaks('tick ok distributed=1', [{ label: 'password', value: 'admin123' }]), []);
  assert.deepEqual(outputLeaks('x', [{ label: 'empty', value: '' }]), []);
});
