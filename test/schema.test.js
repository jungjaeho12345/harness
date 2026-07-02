import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema, backfillEmptyDepartments } from '../src/db/schema.js';

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

test('createSchema: User 계정잠금 컬럼 (additive — failedLoginCount, lockedUntil)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const cols = columns(db, 'User');
  for (const c of ['failedLoginCount', 'lockedUntil']) {
    assert.ok(cols.includes(c), `User.${c}`);
  }
  // 계정 잠금 컬럼이 Contents의 편집잠금(lockYN)과 이름이 겹치지 않는다.
  assert.ok(!cols.includes('lockYN'), 'User에 Contents 편집잠금 컬럼(lockYN)을 두지 않는다');
});

test('createSchema: User 계정잠금 컬럼을 기존 행에 additive로 추가하고 데이터를 보존한다', () => {
  const db = new DatabaseSync(':memory:');
  // 옛 버전: 계정잠금 컬럼이 없는 User + 기존 행
  db.exec('CREATE TABLE User (userId TEXT PRIMARY KEY, name TEXT, password TEXT)');
  db.prepare("INSERT INTO User (userId, name, password) VALUES ('old', '옛 사용자', 'h')").run();
  createSchema(db);
  const cols = columns(db, 'User');
  assert.ok(cols.includes('failedLoginCount'), '누락된 failedLoginCount 컬럼이 추가되어야 함');
  assert.ok(cols.includes('lockedUntil'), '누락된 lockedUntil 컬럼이 추가되어야 함');
  const row = db.prepare("SELECT * FROM User WHERE userId='old'").get();
  assert.equal(row.name, '옛 사용자', '기존 데이터는 보존되어야 함');
  assert.equal(row.failedLoginCount, '0', '신규 컬럼은 기본값 0으로 채워진다');
  assert.equal(row.lockedUntil, null, 'lockedUntil 기본값은 비어 있다');
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

test('createSchema: ArticleHistory — markupVersion 본문 스냅샷 컬럼이 있다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  assert.ok(
    columns(db, 'ArticleHistory').includes('markupVersion'),
    'ArticleHistory에 markupVersion 컬럼이 있어야 함',
  );
});

test('createSchema: 구버전 ArticleHistory(markupVersion 없음)에 additive 마이그레이션 시 기존 행 보존', () => {
  const db = new DatabaseSync(':memory:');
  // 옛 버전: 스냅샷 컬럼이 없는 ArticleHistory + 기존 행
  db.exec(
    'CREATE TABLE ArticleHistory (id INTEGER PRIMARY KEY, articleId VARCHAR, eventType VARCHAR, action VARCHAR, fromStatus VARCHAR, toStatus VARCHAR, actorUserId VARCHAR, createdAt VARCHAR)',
  );
  db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, action, createdAt) VALUES ('a1', 'status', 'send', '2026-06-16T00:00:00Z')",
  ).run();

  createSchema(db);

  assert.ok(columns(db, 'ArticleHistory').includes('markupVersion'), '누락된 markupVersion 컬럼이 추가되어야 함');
  const row = db.prepare("SELECT * FROM ArticleHistory WHERE articleId='a1'").get();
  assert.equal(row.action, 'send', '기존 행은 보존되어야 함');
  assert.equal(row.markupVersion, null, '기존 행의 스냅샷은 NULL(비교 불가 — 정상)');
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

test('createSchema: ArticleHistory.id는 INTEGER PRIMARY KEY (ROWID alias 자동증가)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const info = db.prepare('PRAGMA table_info(ArticleHistory)').all();
  const idCol = info.find((c) => c.name === 'id');
  assert.equal(idCol.pk, 1, 'id가 PK여야 함');
  assert.equal(idCol.type, 'INTEGER', 'id 타입은 INTEGER여야 함');
  db.prepare("INSERT INTO ArticleHistory (articleId, eventType) VALUES ('a1', 'create')").run();
  db.prepare("INSERT INTO ArticleHistory (articleId, eventType) VALUES ('a1', 'edit')").run();
  const rows = db.prepare('SELECT id FROM ArticleHistory ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.id), [1, 2], 'id가 자동증가해야 함');
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

test('createSchema: User 계정잠금 컬럼 3개 (failedLoginCount·lockedUntil·lastFailedLoginAt)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const cols = columns(db, 'User');
  for (const c of ['failedLoginCount', 'lockedUntil', 'lastFailedLoginAt']) {
    assert.ok(cols.includes(c), `User.${c} 컬럼이 있어야 함`);
  }
});

test('createSchema: 구버전 User 테이블(7컬럼)에서 마이그레이션 시 기존 행 보존 + 3개 컬럼 추가', () => {
  const db = new DatabaseSync(':memory:');
  // 구버전: lockout 컬럼 없이 기존 7개 컬럼만 있는 테이블
  db.exec(
    'CREATE TABLE User (userId TEXT PRIMARY KEY, name TEXT, password TEXT, role TEXT, department TEXT, departmentCode TEXT, active TEXT DEFAULT \'Y\')',
  );
  db.prepare("INSERT INTO User (userId, name, role) VALUES ('u_old', '기존사용자', 'R')").run();

  createSchema(db);

  // 기존 행이 보존되어야 함
  const row = db.prepare("SELECT name, role FROM User WHERE userId='u_old'").get();
  assert.equal(row.name, '기존사용자', '기존 행의 name이 보존되어야 함');
  assert.equal(row.role, 'R', '기존 행의 role이 보존되어야 함');

  // 누락 컬럼이 추가되어야 함
  const cols = columns(db, 'User');
  for (const c of ['failedLoginCount', 'lockedUntil', 'lastFailedLoginAt']) {
    assert.ok(cols.includes(c), `마이그레이션 후 User.${c} 컬럼이 있어야 함`);
  }
});

test('createSchema: 레거시 대소문자 컬럼(LockYN)을 중복 추가하지 않고 보존한다 (대소문자 보정)', () => {
  const db = new DatabaseSync(':memory:');
  // 옛 DB: 편집잠금 컬럼이 'LockYN'(대문자 L) 표기로 존재 + 기존 행.
  db.exec("CREATE TABLE Contents (articleId VARCHAR PRIMARY KEY, LockYN VARCHAR DEFAULT 'N')");
  db.prepare("INSERT INTO Contents (articleId, LockYN) VALUES ('a1', 'Y')").run();

  // 대소문자만 다른 기존 컬럼에 ADD COLUMN을 시도하면 SQLite가 'duplicate column' 오류를 낸다 → 보정으로 회피.
  assert.doesNotThrow(() => createSchema(db));

  // lockYN이 케이스 무시로 정확히 하나만 존재해야 한다(중복 컬럼 없음).
  const lockCols = columns(db, 'Contents').filter((c) => c.toLowerCase() === 'lockyn');
  assert.equal(lockCols.length, 1, 'lockYN 컬럼이 케이스 무시로 하나만 있어야 함');
  // 기존 데이터·누락 컬럼 추가도 정상 동작.
  assert.equal(db.prepare("SELECT LockYN FROM Contents WHERE articleId='a1'").get().LockYN, 'Y', '기존 데이터 보존');
  assert.ok(columns(db, 'Contents').includes('status'), '누락 컬럼은 그대로 추가된다');
});

test('backfillEmptyDepartments: 빈 부서를 작성자의 User 부서로 채운다 (비파괴 — 빈 값만)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  db.prepare("INSERT INTO User (userId, name, department, departmentCode) VALUES ('u1','김기자','사회부','SOC')").run();
  // a1: 빈 부서(작성자 김기자) → 보정 / a2: 기존 부서 → 보존 / a3: 매칭 사용자 없음 → 그대로.
  db.prepare("INSERT INTO Contents (articleId, author, department) VALUES ('a1','김기자','')").run();
  db.prepare("INSERT INTO Contents (articleId, author, department) VALUES ('a2','김기자','문화부')").run();
  db.prepare("INSERT INTO Contents (articleId, author) VALUES ('a3','이름없는기자')").run();

  const changed = backfillEmptyDepartments(db);

  assert.equal(db.prepare("SELECT department FROM Contents WHERE articleId='a1'").get().department, '사회부');
  assert.equal(db.prepare("SELECT departmentCode FROM Contents WHERE articleId='a1'").get().departmentCode, 'SOC');
  assert.equal(db.prepare("SELECT department FROM Contents WHERE articleId='a2'").get().department, '문화부', '기존 부서는 보존');
  const a3 = db.prepare("SELECT department FROM Contents WHERE articleId='a3'").get().department;
  assert.ok(a3 === null || a3 === '', '매칭 사용자 없으면 빈 채로 둔다');
  assert.equal(changed, 1, '빈 부서 1건만 보정한다');
});

test('backfillEmptyDepartments: 멱등 — 두 번째 호출은 보정할 행이 없다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  db.prepare("INSERT INTO User (userId, name, department) VALUES ('u1','김기자','사회부')").run();
  db.prepare("INSERT INTO Contents (articleId, author, department) VALUES ('a1','김기자','')").run();
  assert.equal(backfillEmptyDepartments(db), 1, '첫 호출은 1건 보정');
  assert.equal(backfillEmptyDepartments(db), 0, '두 번째 호출은 0건(멱등)');
});

test('createSchema: FK 제약을 선언하지 않는다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  for (const t of ['Article', 'ArticleHistory', 'Contents', 'ReceiverConfig', 'User']) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.equal(fks.length, 0, `${t}에 FK가 없어야 함`);
  }
});
