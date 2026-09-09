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
//   · **헤더 총계 ↔ 표 줄 교차 검사** — 표 줄 형식이 바뀌어 한 줄도 안 읽히면 「일치 · 불일치 0 · 0행」이라는
//     공허한 green 이 된다(리허설의 필수 산출물인 규모 수치가 통째로 0으로 접힌다)
//   · 셀 수 = Σ(행 × 컬럼) — 규모 기록의 단위(75 는 178행·81컬럼·2,878셀로 남겼다)
//   · md5·크기 무변 판정 — 어느 한쪽이 없거나 다르면 문제로 남는다

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIDECAR_SUFFIXES, cellsOf, digestProblems, parseVerifyReport, sidecarsOf, totalsOf,
} from './loadRehearsal.mjs';

// 실측 출력(2026-09-09 리허설 · 7테이블 178행 81컬럼)을 그대로 옮긴 것이다 — 헤더 총계와 표 줄이 **맞아떨어진다**.
const TABLE_LINES = [
  'User                 소스    11행 · 대상    11행 · 컬럼 10 · 불일치 0',
  'Article              소스    77행 · 대상    77행 · 컬럼  5 · 불일치 0',
  'Contents             소스    77행 · 대상    77행 · 컬럼 29 · 불일치 0',
  'ArticleHistory       소스    12행 · 대상    12행 · 컬럼 12 · 불일치 0',
  'ReceiverConfig       소스     0행 · 대상     0행 · 컬럼 12 · 불일치 0',
  'DistributionTarget   소스     0행 · 대상     0행 · 컬럼  7 · 불일치 0',
  'Photo                소스     1행 · 대상     1행 · 컬럼  6 · 불일치 0',
];

const MATCHED = [
  'news-migrator verify (phase 75 / P2)',
  '시각: 2026-09-09T00:00:00Z',
  '소스: D:\\agents\\76s8-work\\rehearsal-source.db',
  '대상: jdbc target',
  '판정: 일치',
  '대조 테이블 수: 7 · 소스 총 178행 · 대상 총 178행',
  '제외(대조 대상 아님): flyway_schema_history',
  '',
  ...TABLE_LINES,
  '',
].join('\n');

const MISMATCHED = [
  '판정: 불일치',
  '대조 테이블 수: 2 · 소스 총 121행 · 대상 총 122행',
  '제외(대조 대상 아님): flyway_schema_history',
  'User                 소스    37행 · 대상    38행 · 컬럼 10 · 불일치 3',
  'Article              소스    84행 · 대상    84행 · 컬럼  5 · 불일치 0',
  '',
  '구조 문제',
  '  - 대상에 정본 밖 테이블이 있다: Bogus',
  '',
].join('\n');

/** 표 줄 형식만 바뀐 출력 — 헤더·판정 줄은 그대로다(형식 변경의 현실적 모양). */
function withRenderedTables(lines) {
  return [
    '판정: 일치',
    '대조 테이블 수: 7 · 소스 총 178행 · 대상 총 178행',
    '제외(대조 대상 아님): flyway_schema_history',
    '',
    ...lines,
    '',
  ].join('\n');
}

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
  assert.equal(parsed.tableCount, 7);
  assert.equal(parsed.tables.length, 7);
  assert.deepEqual(parsed.tables[0], { table: 'User', sourceRows: 11, targetRows: 11, columns: 10, diffs: 0 });
  assert.deepEqual(parsed.structural, []);
  assert.equal(parsed.diffs, 0);
  assert.deepEqual(parsed.parseIncomplete, [], '헤더 총계와 표 줄이 맞아떨어지면 파싱 문제가 없다');
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

test('표 줄 형식이 통째로 바뀌면 「일치 · 불일치 0」으로 읽지 않는다 — 규모 0은 green 이 아니다', () => {
  const parsed = parseVerifyReport(withRenderedTables([
    'User                 rows 11/11 cols 10 diffs 0',
    'Article              rows 77/77 cols  5 diffs 0',
  ]));
  assert.equal(parsed.verdict, '일치', '판정 줄과 헤더는 그대로 읽힌다 — 그래서 위험하다');
  assert.equal(parsed.tables.length, 0);
  assert.equal(parsed.diffs, 0, '표가 없으니 불일치 합은 0이 된다(공허한 0)');
  assert.equal(parsed.matched, false, '헤더 총계와 어긋나면 일치로 판정하지 않는다');
  assert.ok(parsed.parseIncomplete.length > 0);
  assert.match(parsed.parseIncomplete.join(' '), /7/, '기대한 테이블 수를 메시지에 남긴다');
});

test('표 줄이 일부만 안 읽혀도 테이블 수·행 합이 어긋나 잡힌다', () => {
  const parsed = parseVerifyReport(withRenderedTables([
    ...TABLE_LINES.slice(0, 6),
    'Photo                rows 1/1 cols 6 diffs 0',
  ]));
  assert.equal(parsed.tables.length, 6);
  assert.equal(parsed.matched, false);
  assert.equal(parsed.parseIncomplete.length, 3, '테이블 수(6≠7) · 소스 행 합(177≠178) · 대상 행 합(177≠178)');
});

test('헤더 총계 줄 자체가 없으면 일치로 읽지 않는다', () => {
  const parsed = parseVerifyReport(['판정: 일치', ...TABLE_LINES].join('\n'));
  assert.equal(parsed.tableCount, null);
  assert.equal(parsed.matched, false);
  assert.ok(parsed.parseIncomplete.length > 0);
});

test('셀 수는 Σ(소스 행 × 컬럼)이다 — 행만 세면 컬럼 결손이 보이지 않는다', () => {
  const parsed = parseVerifyReport(MATCHED);
  assert.equal(cellsOf(parsed.tables), 11 * 10 + 77 * 5 + 77 * 29 + 12 * 12 + 1 * 6);
  assert.deepEqual(totalsOf(parsed.tables), { tables: 7, rows: 178, columns: 81, cells: 2878 });
});

test('md5·크기가 같으면 문제 0, 다르거나 없으면 문제로 남는다', () => {
  const before = { size: 606208, md5: '7247e9e0dfe5cc8cd040ebb1dc9fb967' };
  assert.deepEqual(digestProblems('소스 사본', before, { ...before }), []);
  assert.equal(digestProblems('소스 사본', before, { size: 606208, md5: 'ffff' }).length, 1);
  assert.equal(digestProblems('소스 사본', before, { size: 1, md5: before.md5 }).length, 1);
  assert.equal(digestProblems('소스 사본', before, null).length, 1);
  assert.equal(digestProblems('소스 사본', null, before).length, 1);
});
