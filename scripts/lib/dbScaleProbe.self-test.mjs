// scripts/lib/dbScaleProbe.mjs 의 순수 판정부 자기검사 (phase 76 step8 작업 B).
//
// npm test 는 이 파일을 돌리지 않는다(package.json 무수정 · "test/**/*.test.js" 만 훑는다).
// scripts/db-scale-probe.mjs 가 시작할 때 스스로 돌린다. 실행: node --test scripts/lib/dbScaleProbe.self-test.mjs
//
// 무엇을 잠그는가(운영 규모에서만 드러나는 축들이고, 틀리면 "문제 0"이 조용히 나온다):
//   · 기반선 파싱 — VARCHAR(n) 상한과 텍스트 PK 를 **정본 파일에서** 읽는다(수치를 손으로 베끼면 낡는다)
//   · 글자와 바이트를 섞지 않는다(markupVersion 165,802바이트 = 한글 55,268자 — baseline 함정 (i))
//   · 4바이트 이모지(astral)와 **짝 없는 서로게이트**를 따로 센다(후자는 UTF-8 로 옮길 수 없다)
//   · NULL 과 빈 문자열을 **구분**해서 센다(둘을 합치면 divergence 축 하나가 사라진다)
//   · 상한 초과 판정은 `>` 다 — 768자는 통과, 769자는 초과(1406 의 경계)
//   · 정본 밖 테이블/컬럼 — sqlite 내부 테이블은 제외하고, 대소문자는 무시한다

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ALLOWED_PACKET, TEXT_PK_LIMIT, mergeSummaries, parseBaselineTables, stringStats, summariseColumn, unknownNames,
} from './dbScaleProbe.mjs';

const BASELINE = [
  '-- 주석',
  'CREATE TABLE IF NOT EXISTS User (',
  '  userId VARCHAR(768) NOT NULL PRIMARY KEY,',
  '  name LONGTEXT,',
  "  active LONGTEXT DEFAULT ('Y')",
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;',
  '',
  'CREATE TABLE IF NOT EXISTS ArticleHistory (',
  '  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,',
  '  markupVersion LONGTEXT',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;',
].join('\n');

test('기반선에서 테이블·컬럼·VARCHAR 상한·PK 를 읽는다', () => {
  const tables = parseBaselineTables(BASELINE);
  assert.deepEqual(tables.map((t) => t.name), ['User', 'ArticleHistory']);
  assert.deepEqual(tables[0].columns[0], { name: 'userId', type: 'VARCHAR(768)', maxChars: 768, primaryKey: true });
  assert.deepEqual(tables[0].columns[1], { name: 'name', type: 'LONGTEXT', maxChars: null, primaryKey: false });
  assert.equal(tables[0].columns[2].name, 'active');
  assert.equal(tables[1].columns[0].primaryKey, true);
  assert.equal(tables[1].columns[0].maxChars, null, 'BIGINT 에는 글자 상한이 없다');
});

test('텍스트 PK 상한은 기반선이 정한다 — 이 값이 1406 의 경계다', () => {
  assert.equal(TEXT_PK_LIMIT, 768);
  assert.equal(MAX_ALLOWED_PACKET, 67108864);
});

test('글자 수와 바이트 수를 섞지 않는다', () => {
  assert.deepEqual(stringStats('abc'), { chars: 3, bytes: 3, astral: 0, loneSurrogates: 0 });
  const korean = stringStats('가나다');
  assert.equal(korean.chars, 3);
  assert.equal(korean.bytes, 9, '한글 한 글자는 UTF-8 3바이트다');
});

test('4바이트 이모지와 짝 없는 서로게이트를 따로 센다', () => {
  const emoji = stringStats('a\u{1F600}b');
  assert.equal(emoji.astral, 1);
  assert.equal(emoji.loneSurrogates, 0);
  assert.equal(emoji.chars, 3, '코드포인트 기준으로 센다(UTF-16 단위가 아니다)');
  assert.equal(emoji.bytes, 6, '이모지 하나가 UTF-8 4바이트다');
  const lone = stringStats('a\uD800b');
  assert.equal(lone.loneSurrogates, 1);
  assert.equal(lone.astral, 0);
});

test('NULL 과 빈 문자열을 구분해서 세고, 상한 초과는 > 로 판정한다', () => {
  const summary = summariseColumn([null, '', 'x'.repeat(768), 'y'.repeat(769), '가'], { maxChars: 768 });
  assert.equal(summary.total, 5);
  assert.equal(summary.nulls, 1);
  assert.equal(summary.empties, 1);
  assert.equal(summary.overlong, 1, '768자는 통과 · 769자만 초과다');
  assert.equal(summary.maxChars, 769);
  assert.equal(summary.maxBytes, 769);
  assert.equal(summary.astralRows, 0);
  assert.equal(summary.loneSurrogateRows, 0);
});

test('상한 판정은 **글자**다 — 한글 768자(2,304바이트)는 초과가 아니다', () => {
  // 왜 이 케이스가 따로 있는가: ASCII 픽스처만 있으면 chars===bytes 라서 판정을 bytes 로 바꿔도 전부 green 이다.
  // MySQL VARCHAR(768) 의 상한은 글자이고(768 이라는 숫자 자체가 utf8mb4 3072바이트 인덱스 한계 / 4 에서 왔다),
  // 1406 은 **글자 초과**에서 난다. 이 리포가 반복해 밟은 「바이트 vs 글자」 함정의 방어선이다.
  const korean768 = '가'.repeat(768);
  assert.equal(stringStats(korean768).chars, 768);
  assert.equal(stringStats(korean768).bytes, 2304, '한글 768자는 UTF-8 2,304바이트 — 768바이트를 훌쩍 넘는다');
  const summary = summariseColumn([korean768], { maxChars: 768 });
  assert.equal(summary.overlong, 0, '바이트로 재면 여기가 1이 된다(그 변이를 이 단언이 잡는다)');
  assert.equal(summary.maxChars, 768);
  assert.equal(summary.maxBytes, 2304);

  const korean769 = summariseColumn(['가'.repeat(769)], { maxChars: 768 });
  assert.equal(korean769.overlong, 1, '한 글자 더 넘으면 초과다 — 그 경계가 MySQL 1406 의 경계다');
  assert.equal(korean769.maxBytes, 2307);
});

test('상한이 없는 컬럼은 초과가 0이고 최대 바이트는 그대로 잰다', () => {
  const summary = summariseColumn(['가'.repeat(10)], { maxChars: null });
  assert.equal(summary.overlong, 0);
  assert.equal(summary.maxChars, 10);
  assert.equal(summary.maxBytes, 30);
});

test('숫자·불리언 값도 문자열로 재되 NULL 로 세지 않는다', () => {
  const summary = summariseColumn([0, 12345], { maxChars: null });
  assert.equal(summary.nulls, 0);
  assert.equal(summary.empties, 0);
  assert.equal(summary.maxChars, 5);
});

test('덩어리로 나눠 세도 한 번에 센 것과 같다 — 운영 규모는 한 번에 못 읽는다', () => {
  const values = [null, '', 'x'.repeat(769), '\u{1F600}', '가나'];
  const whole = summariseColumn(values, { maxChars: 768 });
  const merged = [values.slice(0, 2), values.slice(2, 4), values.slice(4)]
    .map((chunk) => summariseColumn(chunk, { maxChars: 768 }))
    .reduce(mergeSummaries);
  assert.deepEqual(merged, whole);
});

test('정본 밖 이름을 대소문자 무시로 골라내고 sqlite 내부 테이블은 뺀다', () => {
  assert.deepEqual(
    unknownNames(['user', 'Article', 'Bogus', 'sqlite_sequence'], ['User', 'Article']),
    ['Bogus'],
  );
  assert.deepEqual(unknownNames(['User'], ['User', 'Article']), []);
});
