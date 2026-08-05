// Contents 응답 투영(순수 모듈) 테스트 — phase 51 step0.
// 잠그는 것: "응답으로 나가는 Contents 행에는 세션 토큰/편집 탭 식별자가 절대 없다"(ADR-004 신뢰 경계).
// 컬럼 목록은 DB 스키마(PRAGMA table_info)에서 도출한다 — 테스트에 리터럴로 하드코딩하면
// 새 비밀 컬럼이 추가돼도 이 테스트가 통과해 조용한 노출을 놓친다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { PRIVATE_CONTENTS_COLS, toPublicContents } from '../src/services/contentsProjection.js';

// test/schema.test.js의 columns 헬퍼와 동형 — 스키마가 단일 출처다.
function contentsColumns() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  return db.prepare('PRAGMA table_info(Contents)').all().map((c) => c.name);
}

// 전 컬럼을 "빈 값이 아닌" 값으로 채운 행 — 값 누락으로 키가 사라지는 착시를 막는다.
function fullContentsRow() {
  const row = {};
  for (const name of contentsColumns()) row[name] = `v-${name}`;
  return row;
}

// 기대 제거 대상은 테스트가 독립적으로 못박는다(모듈 상수를 그대로 쓰면 상수를 줄이는 변이에
// 테스트가 함께 끌려가 red가 되지 않는다). 컬럼 "목록"은 스키마에서만 도출한다.
const MUST_REMOVE = ['lockerSessionId', 'lockerClientId'];

test('toPublicContents: 결과 키 집합은 [Contents 전 컬럼] - [토큰/탭 식별자]와 정확히 일치한다', () => {
  const cols = contentsColumns();
  assert.ok(cols.length > 0, 'PRAGMA로 Contents 컬럼을 읽어야 한다');
  for (const priv of MUST_REMOVE) {
    assert.ok(cols.includes(priv), `${priv}는 실제 Contents 컬럼이어야 한다(스키마 드리프트 감지)`);
  }

  const expected = cols.filter((c) => !MUST_REMOVE.includes(c)).sort();
  const actual = Object.keys(toPublicContents(fullContentsRow())).sort();
  // 새 컬럼이 스키마에 추가되면 이 단언이 그 컬럼을 자동으로 요구/금지 판정에 포함시킨다.
  assert.deepEqual(actual, expected);
  // 모듈 상수는 기대 제거 대상을 빠짐없이 담아야 한다(단일 출처와 기대의 일치).
  for (const priv of MUST_REMOVE) {
    assert.ok(PRIVATE_CONTENTS_COLS.includes(priv), `PRIVATE_CONTENTS_COLS에 ${priv}가 있어야 한다`);
  }
});

test('toPublicContents: 세션 토큰·편집 탭 식별자는 값도 키도 남지 않는다', () => {
  const pub = toPublicContents({
    articleId: 'AKR1', lockYN: 'Y', lockerUserId: 'desk1',
    lockerSessionId: 'secret-session-token', lockerClientId: 'tab-d',
    lockedAt: '2026-08-03T01:00:00.000Z',
  });
  assert.equal('lockerSessionId' in pub, false);
  assert.equal('lockerClientId' in pub, false);
  assert.equal(JSON.stringify(pub).includes('secret-session-token'), false);
  assert.equal(JSON.stringify(pub).includes('tab-d'), false);
});

test('toPublicContents: 잠금 표시 계약(lockYN/lockerUserId/lockedAt)과 일반 필드는 값까지 보존한다', () => {
  const pub = toPublicContents({
    articleId: 'AKR1', status: 'RDS', internalComment: '내부메모',
    lockYN: 'Y', lockerUserId: 'desk1', lockedAt: '2026-08-03T01:00:00.000Z',
    lockerSessionId: 'tok', lockerClientId: 'tab-d',
  });
  assert.equal(pub.articleId, 'AKR1');
  assert.equal(pub.status, 'RDS');
  assert.equal(pub.internalComment, '내부메모');
  assert.equal(pub.lockYN, 'Y');
  assert.equal(pub.lockerUserId, 'desk1');
  assert.equal(pub.lockedAt, '2026-08-03T01:00:00.000Z');
});

test('toPublicContents: 원본 객체를 변형하지 않는다(같은 행이 잠금 판정에 재사용된다)', () => {
  const row = { articleId: 'AKR1', lockerSessionId: 'tok', lockerClientId: 'tab-d' };
  const pub = toPublicContents(row);
  assert.equal(row.lockerSessionId, 'tok', '원본은 그대로여야 한다');
  assert.equal(row.lockerClientId, 'tab-d', '원본은 그대로여야 한다');
  assert.notEqual(pub, row, '새 객체를 반환한다');
});

test('toPublicContents: null/undefined/비객체 입력에 throw하지 않는다(투영이 호출자를 깨뜨리지 않는다)', () => {
  assert.equal(toPublicContents(null), null);
  assert.equal(toPublicContents(undefined), undefined);
  assert.equal(toPublicContents('row'), 'row');
});

// phase 54 step0 — 배열 오용이 무음 토큰 유출로 번지지 않게 하는 안전망.
// 수정 전에는 Object.entries([a, b])가 [['0', a], ['1', b]]를 돌려줘 결과가 { '0': 원본행, … }이 되고
// 원본 행의 lockerSessionId/lockerClientId가 그대로 실렸다(phase 51 step0이 닫은 권한 상승 표면과 동형).
test('toPublicContents: 배열 입력은 원소별로 투영해 배열로 돌려준다(토큰 문자열 0건)', () => {
  const rows = [
    { articleId: 'AKR1', lockYN: 'Y', lockerUserId: 'u1', lockerSessionId: 'tok', lockerClientId: 'c-1' },
    { articleId: 'AKR2', lockerSessionId: 'tok2' },
  ];
  const out = toPublicContents(rows);

  assert.equal(Array.isArray(out), true, '배열 입력에는 배열을 돌려줘야 한다');
  assert.equal(out.length, rows.length);
  assert.equal(out[0].articleId, 'AKR1');
  assert.equal(out[1].articleId, 'AKR2');
  for (const item of out) {
    assert.equal('lockerSessionId' in item, false);
    assert.equal('lockerClientId' in item, false);
  }
  assert.equal(out[0].lockYN, 'Y');
  assert.equal(out[0].lockerUserId, 'u1');

  const json = JSON.stringify(out);
  for (const needle of ['tok', 'tok2', 'lockerSessionId', 'lockerClientId']) {
    assert.equal(json.includes(needle), false, `직렬화 결과에 ${needle}가 남으면 안 된다`);
  }
});

test('toPublicContents: 배열 입력의 원본 배열·원소를 변형하지 않는다', () => {
  const rows = [
    { articleId: 'AKR1', lockerSessionId: 'tok', lockerClientId: 'c-1' },
    { articleId: 'AKR2', lockerSessionId: 'tok2' },
  ];
  const out = toPublicContents(rows);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].lockerSessionId, 'tok', '원본 원소는 그대로여야 한다(잠금 판정이 계속 쓴다)');
  assert.equal(rows[0].lockerClientId, 'c-1');
  assert.equal(rows[1].lockerSessionId, 'tok2');
  assert.notEqual(out, rows, '새 배열을 반환한다');
  assert.notEqual(out[0], rows[0], '새 원소 객체를 반환한다');
});

test('toPublicContents: 원소가 객체가 아닌 배열도 크래시 없이 원본 규칙대로 통과시킨다', () => {
  const out = toPublicContents([null, 'x', 3]);
  assert.equal(Array.isArray(out), true);
  assert.deepEqual(out, [null, 'x', 3]);
});

test('toPublicContents: 중첩 객체 필드는 깊은 복사 없이 참조 그대로 실린다(오늘 동작 유지)', () => {
  const meta = { desk: 'politics' };
  const single = toPublicContents({ articleId: 'AKR1', meta, lockerSessionId: 'tok' });
  assert.equal(single.meta, meta);
  const [fromArray] = toPublicContents([{ articleId: 'AKR1', meta, lockerSessionId: 'tok' }]);
  assert.equal(fromArray.meta, meta);
});

test('PRIVATE_CONTENTS_COLS: 제거 대상 목록의 단일 출처이며 동결돼 있다', () => {
  assert.deepEqual([...PRIVATE_CONTENTS_COLS].sort(), ['lockerClientId', 'lockerSessionId']);
  assert.equal(Object.isFrozen(PRIVATE_CONTENTS_COLS), true);
});
