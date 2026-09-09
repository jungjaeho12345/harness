// scripts/lib/poolProbe.mjs 의 순수 판정부 자기검사 (phase 76 step9).
//
// 왜 여기에 있고 npm test 가 돌지 않는가: package.json 은 무수정 목록이고 `npm test` 는 "test/**/*.test.js" 만 훑는다.
// scripts/pool-ceiling-probe.mjs 는 시작할 때 이 파일을 스스로 돌린다(빨간 채로는 서버를 띄우지 않는다).
// 실행: node --test scripts/lib/poolProbe.self-test.mjs
//
// 무엇을 잠그는가(측정이 조용히 공허해지는 자리들이다):
//   · 분위수 — 평균이 아니라 p50/p95/최대다. 정의(최근접 순위)를 여기서 못 박는다
//   · **부하가 실제로 걸렸는가**(U2) — 동시 요청 수 1에서 천장이 관측되면 프로브가 잘못 잰 것이고,
//     계단마다 실제 동시 실행 수가 목표에 닿지 않았으면 그 계단의 수치는 거짓이다
//   · **769자 축의 기대표**(U3·U4) — Node 200 / Spring 500 이라는 divergence 와, 그 경계가
//     **바이트가 아니라 글자**라는 사실(한글 768자 = 2,304바이트인데 통과한다)
//   · 30초 천장까지 필요한 큐 깊이 산술 — "500이 안 났다"를 "천장이 없다"로 읽지 않기 위한 계산이다

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LADDER, USERID_CASES, buildUserIdCases, formatStageTable, formatUserIdTable,
  judgeLoadSelfCheck, judgeUserIdAxis, percentile, queueDepthForTimeout, summarise,
} from './poolProbe.mjs';

test('계단은 1부터 시작한다 — 1은 자기검사(U2)의 대조군이다', () => {
  assert.equal(LADDER[0], 1);
  assert.ok(LADDER.length >= 4, '계단이 셋 이하면 「계단식」이 아니다');
  for (let i = 1; i < LADDER.length; i += 1) assert.ok(LADDER[i] > LADDER[i - 1], '계단은 증가해야 한다');
});

test('분위수는 최근접 순위다 — 평균을 쓰지 않는다', () => {
  const values = [10, 20, 30, 40, 100];
  assert.equal(percentile(values, 50), 30);
  assert.equal(percentile(values, 95), 100);
  assert.equal(percentile([7], 50), 7);
  assert.equal(percentile([], 50), null, '표본이 없으면 값을 지어내지 않는다');
});

test('요약은 p50·p95·최대와 5xx 건수를 따로 낸다', () => {
  const s = summarise([
    { ms: 10, status: 200 }, { ms: 20, status: 200 }, { ms: 30, status: 200 },
    { ms: 900, status: 500 }, { ms: 40, status: 503 },
  ]);
  assert.equal(s.count, 5);
  assert.equal(s.p50, 30);
  assert.equal(s.max, 900);
  assert.equal(s.errors5xx, 2, '500 과 503 은 둘 다 5xx 다');
  assert.deepEqual(s.statuses, { 200: 3, 500: 1, 503: 1 });
});

test('요청이 하나도 성립하지 않으면 요약은 값을 지어내지 않는다', () => {
  const s = summarise([]);
  assert.equal(s.count, 0);
  assert.equal(s.p50, null);
  assert.equal(s.p95, null);
  assert.equal(s.max, null);
});

test('U2 — 동시 요청 수 1에서 천장이 관측되면 프로브가 틀린 것이다', () => {
  const ok = judgeLoadSelfCheck([
    { concurrency: 1, maxInFlight: 1, summary: summarise([{ ms: 5, status: 200 }]) },
    { concurrency: 4, maxInFlight: 4, summary: summarise([{ ms: 9, status: 200 }]) },
  ]);
  assert.deepEqual(ok, []);

  const ceilingAtOne = judgeLoadSelfCheck([
    { concurrency: 1, maxInFlight: 1, summary: summarise([{ ms: 5, status: 200 }, { ms: 7, status: 500 }]) },
  ]);
  assert.equal(ceilingAtOne.length, 1);
  assert.match(ceilingAtOne[0], /동시 요청 수 1/);
});

test('U2 — 목표 동시 수에 실제로 닿지 않은 계단은 거짓 수치다', () => {
  const problems = judgeLoadSelfCheck([
    { concurrency: 1, maxInFlight: 1, summary: summarise([{ ms: 5, status: 200 }]) },
    { concurrency: 16, maxInFlight: 3, summary: summarise([{ ms: 9, status: 200 }]) },
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /16/);
  assert.match(problems[0], /3/);
});

test('U3·U4 — 769자 축의 기대표는 「글자」 기준이다', () => {
  const byId = Object.fromEntries(USERID_CASES.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), ['ascii-768', 'ascii-769', 'korean-768', 'korean-769']);
  // 한글 768자는 2,304바이트다 — **바이트 상한이라면 여기서 터져야** 하고, 실제로는 통과한다.
  assert.equal(byId['korean-768'].chars, 768);
  assert.equal(byId['korean-768'].bytes, 2304);
  assert.equal(byId['korean-768'].spring, 200, 'VARCHAR(768) 의 상한은 글자다 — 한글 768자는 수락된다');
  assert.equal(byId['korean-769'].bytes, 2307);
  assert.equal(byId['korean-769'].spring, 500);
  assert.equal(byId['ascii-768'].spring, 200);
  assert.equal(byId['ascii-769'].spring, 500);
  for (const c of USERID_CASES) assert.equal(c.node, 200, 'SQLite 는 길이를 강제하지 않는다 — Node 는 언제나 200 이다');
});

test('U3·U4 — 실제 값의 글자 수·바이트 수가 기대표와 같다', () => {
  const cases = buildUserIdCases();
  assert.equal(cases.length, 4);
  for (const c of cases) {
    assert.equal([...c.userId].length, c.chars, `${c.id}: 글자 수가 기대와 다르다`);
    assert.equal(Buffer.byteLength(c.userId, 'utf8'), c.bytes, `${c.id}: 바이트 수가 기대와 다르다`);
  }
  const ids = new Set(cases.map((c) => c.userId));
  assert.equal(ids.size, 4, '네 값이 서로 달라야 PK 충돌 없이 한 번에 잰다');
});

test('769자 축 판정 — 기대와 다른 응답은 실패다(양쪽 방향)', () => {
  const asExpected = USERID_CASES.map((c) => ({ id: c.id, node: c.node, spring: c.spring }));
  assert.deepEqual(judgeUserIdAxis(asExpected).failures, []);
  assert.equal(judgeUserIdAxis(asExpected).ok, true);

  // Spring 이 769자를 받아들이면(=검증이 들어갔거나 상한이 바뀌었으면) 그것도 실패다.
  const accepted = asExpected.map((r) => (r.id === 'ascii-769' ? { ...r, spring: 200 } : r));
  const verdict = judgeUserIdAxis(accepted);
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join(' '), /ascii-769/);

  // 한글 768자가 500이면 「글자」가 아니라 「바이트」로 도는 것이다 — 그 회귀를 이 줄이 잡는다.
  const bytesRegression = asExpected.map((r) => (r.id === 'korean-768' ? { ...r, spring: 500 } : r));
  assert.equal(judgeUserIdAxis(bytesRegression).ok, false);

  // 관측이 없으면 통과가 아니다.
  assert.equal(judgeUserIdAxis([]).ok, false);
  assert.equal(judgeUserIdAxis(asExpected.slice(1)).ok, false);
});

test('30초 천장까지 필요한 큐 깊이는 산술로 낸다 — 「500이 안 났다」는 「천장이 없다」가 아니다', () => {
  assert.equal(queueDepthForTimeout({ serviceMs: 3, timeoutMs: 30000, poolSize: 1 }), 10000);
  assert.equal(queueDepthForTimeout({ serviceMs: 150, timeoutMs: 30000, poolSize: 1 }), 200);
  assert.equal(queueDepthForTimeout({ serviceMs: 150, timeoutMs: 30000, poolSize: 10 }), 2000);
  assert.equal(queueDepthForTimeout({ serviceMs: 0, timeoutMs: 30000, poolSize: 1 }), null, '0ms 로는 천장을 계산할 수 없다');
});

test('표는 계단마다 두 회차를 나란히 낸다 — 평균 한 줄로 접지 않는다', () => {
  const text = formatStageTable([
    { concurrency: 1, round: 1, target: 'node', summary: summarise([{ ms: 3, status: 200 }]), maxInFlight: 1 },
    { concurrency: 1, round: 2, target: 'node', summary: summarise([{ ms: 4, status: 200 }]), maxInFlight: 1 },
  ]);
  assert.match(text, /node/);
  assert.match(text, /\|\s*1\s*\|/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('|')).length, 4, '헤더 2줄 + 회차 2줄');
});

test('769자 축의 표는 글자 수와 바이트 수를 함께 싣는다', () => {
  const text = formatUserIdTable(USERID_CASES.map((c) => ({ id: c.id, node: c.node, spring: c.spring })));
  assert.match(text, /2304/, '한글 768자의 바이트 수가 표에 보여야 「글자 vs 바이트」가 읽힌다');
  assert.match(text, /korean-769/);
});
