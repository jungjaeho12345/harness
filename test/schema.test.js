import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

test('createSchema: User/Article/Contents/ReceiverConfig 4개 테이블을 생성한다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of ['Article', 'Contents', 'ReceiverConfig', 'User']) {
    assert.ok(tables.includes(t), `${t} 테이블이 있어야 함`);
  }
});

test('createSchema: User 컬럼 (TEXT)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const cols = columns(db, 'User');
  for (const c of ['userId', 'name', 'password', 'role', 'department', 'departmentCode', 'active']) {
    assert.ok(cols.includes(c), `User.${c}`);
  }
});

test('createSchema: Article 컬럼', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const cols = columns(db, 'Article');
  for (const c of ['articleId', 'title', 'content', 'markupVersion', 'modifier']) {
    assert.ok(cols.includes(c), `Article.${c}`);
  }
});

test('createSchema: Contents 컬럼 (공통정보·생애주기·편집잠금)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const cols = columns(db, 'Contents');
  const expected = [
    'articleId', 'title', 'content', 'author', 'modifier', 'sender',
    'department', 'departmentCode', 'createdAt', 'editedAt', 'sentAt',
    'distributedAt', 'embargoAt', 'secondEmbargoAt', 'status',
    'lockYN', 'lockerUserId', 'lockerSessionId', 'lockedAt',
    'coAuthor', 'region', 'attribute', 'keyword',
    'internalComment', 'externalComment', 'attachmentFile', 'referenceFile',
  ];
  for (const c of expected) assert.ok(cols.includes(c), `Contents.${c}`);
});

test('createSchema: ReceiverConfig 컬럼', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const cols = columns(db, 'ReceiverConfig');
  const expected = [
    'id', 'sourceId', 'type', 'name', 'host', 'port', 'username',
    'password', 'apiEndpoint', 'apiKey', 'active', 'createdAt',
  ];
  for (const c of expected) assert.ok(cols.includes(c), `ReceiverConfig.${c}`);
});

test('createSchema: ArticleHistory 테이블을 생성한다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('ArticleHistory'), 'ArticleHistory 테이블이 있어야 함');
  assert.ok(columns(db, 'ArticleHistory').length > 0, 'ArticleHistory 컬럼이 비어 있지 않아야 함');
});

test('createSchema: ArticleHistory 컬럼 (이벤트 로그)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const cols = columns(db, 'ArticleHistory');
  const expected = [
    'id', 'articleId', 'eventType', 'action',
    'fromStatus', 'toStatus', 'actorUserId', 'createdAt',
  ];
  for (const c of expected) assert.ok(cols.includes(c), `ArticleHistory.${c}`);
});

test('createSchema: ArticleHistory.id 는 INTEGER PRIMARY KEY (자동 증가 ROWID alias)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, createdAt) VALUES ('a1', 'edit', '2026-06-16T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, createdAt) VALUES ('a1', 'status', '2026-06-16T00:01:00Z')",
  ).run();
  const ids = db.prepare('SELECT id FROM ArticleHistory ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(ids, [1, 2], 'id가 자동 증가해야 함');
});

test('createSchema: ArticleHistory — markupVersion 본문 스냅샷 컬럼이 없다 (범위 밖)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  assert.ok(
    !columns(db, 'ArticleHistory').includes('markupVersion'),
    'ArticleHistory에 markupVersion 컬럼이 없어야 함',
  );
});

test('createSchema: 멱등 — 2회 호출해도 오류 없이 데이터를 보존한다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  db.prepare("INSERT INTO User (userId, name, role) VALUES ('u1', '홍길동', 'R')").run();
  assert.doesNotThrow(() => createSchema(db));
  assert.equal(db.prepare("SELECT name FROM User WHERE userId='u1'").get().name, '홍길동');
});

test('createSchema: 기본값 — active=Y, lockYN=N', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  db.prepare("INSERT INTO User (userId) VALUES ('u2')").run();
  assert.equal(db.prepare("SELECT active FROM User WHERE userId='u2'").get().active, 'Y');
  db.prepare("INSERT INTO Contents (articleId) VALUES ('a1')").run();
  assert.equal(db.prepare("SELECT lockYN FROM Contents WHERE articleId='a1'").get().lockYN, 'N');
});

test('createSchema: 누락 컬럼을 ALTER ADD COLUMN으로 추가하고 기존 행을 보존한다 (additive 마이그레이션)', () => {
  const db = new DatabaseSync(':memory:');
  // 옛 버전: 일부 컬럼만 있는 테이블 + 기존 데이터
  db.exec('CREATE TABLE Contents (articleId VARCHAR PRIMARY KEY, title VARCHAR)');
  db.prepare("INSERT INTO Contents (articleId, title) VALUES ('a1', '옛 기사')").run();
  createSchema(db);
  const cols = columns(db, 'Contents');
  assert.ok(cols.includes('status'), '누락된 status 컬럼이 추가되어야 함');
  assert.ok(cols.includes('lockYN'), '누락된 lockYN 컬럼이 추가되어야 함');
  assert.equal(
    db.prepare("SELECT title FROM Contents WHERE articleId='a1'").get().title,
    '옛 기사',
    '기존 데이터는 보존되어야 함',
  );
});

test('createSchema: 보조 인덱스를 만들지 않는다 (PK 자동 인덱스만)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  // 명시적으로 CREATE INDEX된 인덱스는 sql이 NULL이 아님 (PK 자동 인덱스는 sql=NULL)
  const explicit = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
    .all();
  assert.equal(explicit.length, 0, '명시적 보조 인덱스가 없어야 함');
});

test('createSchema: FK 제약을 선언하지 않는다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  for (const t of ['Article', 'ArticleHistory', 'Contents', 'ReceiverConfig', 'User']) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.equal(fks.length, 0, `${t}에 FK가 없어야 함`);
  }
});
