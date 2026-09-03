import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildCanonicalSchema,
  serializeCanonicalSchema,
} from '../scripts/db-migrate/schema-spec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CANONICAL_PATH = resolve(REPO_ROOT, 'docs/db-migration/schema-canonical.json');
const SPEC_SCRIPT = resolve(REPO_ROOT, 'scripts/db-migrate/schema-spec.mjs');

const EXPECTED_TABLES = [
  'User',
  'Article',
  'Contents',
  'ArticleHistory',
  'ReceiverConfig',
  'DistributionTarget',
  'Photo',
];

function tableOf(spec, name) {
  return spec.tables.find((t) => t.name === name);
}

// 항목 1 — 정확히 7 테이블을 그 이름들로 담는다.
test('schema-spec: 정확히 7 테이블을 담는다', () => {
  const spec = buildCanonicalSchema();
  assert.equal(spec.tables.length, 7, '테이블 수는 7이어야 함');
  const names = spec.tables.map((t) => t.name);
  for (const t of EXPECTED_TABLES) {
    assert.ok(names.includes(t), `${t} 테이블이 명세에 있어야 함`);
  }
});

// 항목 2 — 각 테이블의 첫 컬럼이 PK이고 primaryKey와 일치한다(두 경로 교차 확인).
test('schema-spec: 각 테이블 첫 컬럼이 PK이고 primaryKey와 일치한다', () => {
  const spec = buildCanonicalSchema();
  for (const table of spec.tables) {
    const ordered = [...table.columns].sort((a, b) => a.ordinal - b.ordinal);
    assert.equal(ordered[0].ordinal, 0, `${table.name} 첫 컬럼 ordinal은 0`);
    assert.equal(
      table.primaryKey,
      ordered[0].name,
      `${table.name}: primaryKey(${table.primaryKey})가 첫 컬럼(${ordered[0].name})과 일치해야 함`,
    );
  }
});

// 항목 3 — 타입군 도출: targetId INTEGER 예외 + User/Contents 텍스트군.
test('schema-spec: ArticleHistory.targetId는 integer, User·Contents 전 컬럼은 text', () => {
  const spec = buildCanonicalSchema();
  const ah = tableOf(spec, 'ArticleHistory');
  const targetId = ah.columns.find((c) => c.name === 'targetId');
  assert.equal(targetId.typeClass, 'integer', 'targetId typeClass는 integer');
  const ahId = ah.columns.find((c) => c.name === 'id');
  assert.equal(ahId.typeClass, 'integer', 'ArticleHistory.id typeClass는 integer');

  for (const c of tableOf(spec, 'User').columns) {
    assert.equal(c.typeClass, 'text', `User.${c.name} typeClass는 text`);
  }
  for (const c of tableOf(spec, 'Contents').columns) {
    assert.equal(c.typeClass, 'text', `Contents.${c.name} typeClass는 text`);
  }
});

// 항목 4 — Contents가 lockerSessionId·lockerClientId를 명세에 담는다.
test('schema-spec: Contents가 lockerSessionId·lockerClientId 컬럼을 명세에 담는다', () => {
  const spec = buildCanonicalSchema();
  const cols = tableOf(spec, 'Contents').columns.map((c) => c.name);
  assert.ok(cols.includes('lockerSessionId'), 'Contents.lockerSessionId');
  assert.ok(cols.includes('lockerClientId'), 'Contents.lockerClientId');
});

// 항목 5 — 결정성: 두 번 직렬화하면 byte-identical.
test('schema-spec: serialize가 결정적(byte-identical)이다', () => {
  const a = serializeCanonicalSchema(buildCanonicalSchema());
  const b = serializeCanonicalSchema(buildCanonicalSchema());
  assert.equal(a, b, '두 직렬화 결과가 byte-identical이어야 함');
});

// 항목 6 — 잠금: 커밋된 정본이 재생성 결과와 byte-identical(= --check exit 0).
test('schema-spec: 커밋된 schema-canonical.json이 재생성 결과와 byte-identical(잠금)', () => {
  const committed = readFileSync(CANONICAL_PATH, 'utf8');
  const regenerated = serializeCanonicalSchema(buildCanonicalSchema());
  assert.equal(committed, regenerated, '커밋본이 재생성 결과와 갈리면 스키마 드리프트 신호다');
});

test('schema-spec: --check가 exit 0 (잠금 게이트)', () => {
  // 다르면 execFileSync가 exit 1로 throw한다.
  assert.doesNotThrow(() => {
    execFileSync('node', [SPEC_SCRIPT, '--check'], { stdio: 'pipe' });
  });
});

// 항목 7 — DB 비파괴: 생성기 실행이 정본 파일을 만들거나 고치지 않는다(build는 in-memory).
test('schema-spec: buildCanonicalSchema는 어떤 파일도 만들거나 고치지 않는다', () => {
  const before = statSync(CANONICAL_PATH).mtimeMs;
  const beforeBytes = readFileSync(CANONICAL_PATH);
  buildCanonicalSchema();
  buildCanonicalSchema();
  const after = statSync(CANONICAL_PATH).mtimeMs;
  const afterBytes = readFileSync(CANONICAL_PATH);
  assert.equal(after, before, 'build 호출이 정본 파일 mtime을 바꾸면 안 된다');
  assert.ok(beforeBytes.equals(afterBytes), 'build 호출이 정본 파일 바이트를 바꾸면 안 된다');
});
