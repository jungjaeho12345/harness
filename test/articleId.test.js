import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { generateArticleId } from '../src/db/articleId.js';

function today() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

test('generateArticleId: AKR + YYYYMMDD + 9자리 난수 포맷', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const id = generateArticleId(db);
  assert.match(id, /^AKR\d{8}\d{9}$/);
  assert.equal(id.slice(3, 11), today(), '날짜 부분이 오늘(UTC)이어야 함');
});

test('generateArticleId: 여러 번 생성해도 중복되지 않는다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(generateArticleId(db));
  assert.equal(ids.size, 200);
});

test('generateArticleId: Article·Contents 양쪽의 기존 아이디는 피해 재생성한다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const d = today();
  const a = `AKR${d}000000001`;
  const c = `AKR${d}000000002`;
  db.prepare('INSERT INTO Article (articleId) VALUES (?)').run(a);
  db.prepare('INSERT INTO Contents (articleId) VALUES (?)').run(c);

  // Math.random을 고정해 첫 두 후보를 강제 충돌시키고 세 번째에서 비어있는 값을 받는다.
  const seq = [1e-9, 2e-9, 0.5]; // → 000000001(a), 000000002(c), 500000000(free)
  let i = 0;
  const orig = Math.random;
  Math.random = () => seq[i++];
  try {
    const id = generateArticleId(db);
    assert.notEqual(id, a);
    assert.notEqual(id, c);
    assert.match(id, /^AKR\d{17}$/);
  } finally {
    Math.random = orig;
  }
});
