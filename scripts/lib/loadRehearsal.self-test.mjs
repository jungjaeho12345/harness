// scripts/lib/loadRehearsal.mjs 의 순수 판정부 자기검사 (phase 76 step8).
//
// 왜 여기에 있고 npm test 가 돌지 않는가: package.json 은 무수정 목록이고 `npm test` 는 "test/**/*.test.js" 만 훑는다.
// scripts/load-rehearsal.mjs 는 시작할 때 이 파일을 스스로 돌린다(빨간 채로는 마이그레이터를 부르지 않는다).
// 실행: node --test scripts/lib/loadRehearsal.self-test.mjs
//
// 무엇을 잠그는가(리허설의 판정이 조용히 공허해지는 자리들이다):
//   · 부산물(-wal/-shm/-journal) 목록 — 하나라도 빠지면 "그대로가 아닌 사본"으로 리허설이 돈다
//   · verify 출력 파싱 — 「판정: 일치」만 보고 넘어가면 불일치 N건·구조 문제 M건이 수치로 남지 않는다
//   · 판정 줄이 아예 없는 출력(형식 변경·조기 종료)을 **일치로 읽지 않는다**
//   · 셀 수 = Σ(행 × 컬럼) — 규모 기록의 단위(75 는 178행·81컬럼·2,878셀로 남겼다)
//   · md5·크기 무변 판정 — 어느 한쪽이 없거나 다르면 문제로 남는다

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIDECAR_SUFFIXES, cellsOf, digestProblems, parseVerifyReport, sidecarsOf, totalsOf,
} from './loadRehearsal.mjs';

const MATCHED = [
  'news-migrator verify (phase 75 / P2)',
  '시각: 2026-09-09T00:00:00Z',
  '소스: D:\\agents\\76s8-work\\rehearsal-source.db',
  '대상: jdbc target',
  '판정: 일치',
  '대조 테이블 수: 7 · 소스 총 178행 · 대상 총 178행',
  '제외(대조 대상 아님): flyway_schema_history',
  '',
  'User                 소스    37행 · 대상    37행 · 컬럼 10 · 불일치 0',
  'Article              소스    84행 · 대상    84행 · 컬럼  5 · 불일치 0',
  '',
].join('\n');

const MISMATCHED = [
  '판정: 불일치',
  '대조 테이블 수: 2 · 소스 총 178행 · 대상 총 179행',
  '제외(대조 대상 아님): flyway_schema_history',
  'User                 소스    37행 · 대상    38행 · 컬럼 10 · 불일치 3',
  'Article              소스    84행 · 대상    84행 · 컬럼  5 · 불일치 0',
  '',
  '구조 문제',
  '  - 대상에 정본 밖 테이블이 있다: Bogus',
  '',
].join('\n');

test('부산물 접미사는 셋이고 그 목록이 단일 출처다', () => {
  assert.deepEqual(SIDECAR_SUFFIXES, ['-wal', '-shm', '-journal']);
});

test('사본 옆의 부산물을 전부 찾아낸다(하나만 있어도 잡는다)', () => {
  const present = new Set(['/tmp/a.db-wal', '/tmp/a.db-journal']);
  assert.deepEqual(sidecarsOf('/tmp/a.db', (p) => present.has(p)), ['/tmp/a.db-wal', '/tmp/a.db-journal']);
  assert.deepEqual(sidecarsOf('/tmp/a.db', () => false), []);
});

test('verify 일치 출력을 표로 읽는다', () => {
  const parsed = parseVerifyReport(MATCHED);
  assert.equal(parsed.verdict, '일치');
  assert.equal(parsed.matched, true);
  assert.equal(parsed.sourceRows, 178);
  assert.equal(parsed.targetRows, 178);
  assert.deepEqual(parsed.excluded, ['flyway_schema_history']);
  assert.equal(parsed.tables.length, 2);
  assert.deepEqual(parsed.tables[0], { table: 'User', sourceRows: 37, targetRows: 37, columns: 10, diffs: 0 });
  assert.deepEqual(parsed.structural, []);
  assert.equal(parsed.diffs, 0);
});

test('불일치 출력은 불일치 건수와 구조 문제를 함께 낸다', () => {
  const parsed = parseVerifyReport(MISMATCHED);
  assert.equal(parsed.matched, false);
  assert.equal(parsed.diffs, 3);
  assert.equal(parsed.structural.length, 1);
  assert.match(parsed.structural[0], /Bogus/);
});

test('판정 줄이 없는 출력을 일치로 읽지 않는다', () => {
  const parsed = parseVerifyReport('아무 말도 없는 출력\n');
  assert.equal(parsed.verdict, null);
  assert.equal(parsed.matched, false);
  assert.equal(parsed.tables.length, 0);
});

test('셀 수는 Σ(소스 행 × 컬럼)이다 — 행만 세면 컬럼 결손이 보이지 않는다', () => {
  const parsed = parseVerifyReport(MATCHED);
  assert.equal(cellsOf(parsed.tables), 37 * 10 + 84 * 5);
  assert.deepEqual(totalsOf(parsed.tables), { tables: 2, rows: 121, columns: 15, cells: 790 });
});

test('md5·크기가 같으면 문제 0, 다르거나 없으면 문제로 남는다', () => {
  const before = { size: 606208, md5: '7247e9e0dfe5cc8cd040ebb1dc9fb967' };
  assert.deepEqual(digestProblems('소스 사본', before, { ...before }), []);
  assert.equal(digestProblems('소스 사본', before, { size: 606208, md5: 'ffff' }).length, 1);
  assert.equal(digestProblems('소스 사본', before, { size: 1, md5: before.md5 }).length, 1);
  assert.equal(digestProblems('소스 사본', before, null).length, 1);
  assert.equal(digestProblems('소스 사본', null, before).length, 1);
});
