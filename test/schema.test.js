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
    'coAuthor', 'category', 'region', 'attribute', 'keyword',
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
  assert.ok(cols.includes('category'), '누락된 category 컬럼이 추가되어야 함');
  const row = db.prepare("SELECT * FROM Contents WHERE articleId='a1'").get();
  assert.equal(row.title, '옛 기사', '기존 데이터는 보존되어야 함');
  assert.equal(row.category, null, '기존 행의 category는 NULL(미설정 — 정상)');
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
  for (const t of ['Article', 'ArticleHistory', 'Contents', 'DistributionTarget', 'Photo', 'ReceiverConfig', 'User']) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.equal(fks.length, 0, `${t}에 FK가 없어야 함`);
  }
});

test('createSchema: Photo 테이블과 컬럼을 생성한다 (사진DB — additive 신규)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('Photo'), 'Photo 테이블이 있어야 함');
  const cols = columns(db, 'Photo');
  for (const c of ['id', 'src', 'caption', 'sourceArticleId', 'registeredBy', 'createdAt']) {
    assert.ok(cols.includes(c), `Photo.${c}`);
  }
});

test('createSchema: Photo.id는 INTEGER PRIMARY KEY (ROWID alias 자동증가)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const idCol = db.prepare('PRAGMA table_info(Photo)').all().find((c) => c.name === 'id');
  assert.equal(idCol.pk, 1, 'id가 PK여야 함');
  assert.equal(idCol.type, 'INTEGER', 'id 타입은 INTEGER여야 함');
  db.prepare("INSERT INTO Photo (src, caption) VALUES ('/uploads/a.png', '캡션1')").run();
  db.prepare("INSERT INTO Photo (src, caption) VALUES ('/uploads/b.png', '캡션2')").run();
  const ids = db.prepare('SELECT id FROM Photo ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(ids, [1, 2], 'id가 자동 증가해야 함');
});

test('createSchema: Photo가 없는 구버전 DB에 additive로 생기고 기존 행이 보존된다', () => {
  const db = new DatabaseSync(':memory:');
  // 구버전: Photo 테이블 없이 다른 테이블 + 기존 행만 있는 DB.
  db.exec('CREATE TABLE Contents (articleId VARCHAR PRIMARY KEY, title VARCHAR)');
  db.prepare("INSERT INTO Contents (articleId, title) VALUES ('a1', '옛 기사')").run();

  createSchema(db);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('Photo'), 'Photo 테이블이 additive로 생겨야 함');
  const row = db.prepare("SELECT * FROM Contents WHERE articleId='a1'").get();
  assert.equal(row.title, '옛 기사', '기존 행은 보존되어야 함 (비파괴)');
});

test('createSchema: DistributionTarget 테이블과 컬럼을 생성한다 (배부 대상 — additive 신규)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('DistributionTarget'), 'DistributionTarget 테이블이 있어야 함');
  const cols = columns(db, 'DistributionTarget');
  for (const c of ['id', 'name', 'kind', 'spoolDir', 'active', 'createdAt', 'updatedAt']) {
    assert.ok(cols.includes(c), `DistributionTarget.${c}`);
  }
});

test('createSchema: DistributionTarget.id는 INTEGER PRIMARY KEY (ROWID alias 자동증가)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const idCol = db.prepare('PRAGMA table_info(DistributionTarget)').all().find((c) => c.name === 'id');
  assert.equal(idCol.pk, 1, 'id가 PK여야 함');
  assert.equal(idCol.type, 'INTEGER', 'id 타입은 INTEGER여야 함');
  db.prepare("INSERT INTO DistributionTarget (name, kind) VALUES ('연합뉴스TV', 'press')").run();
  db.prepare("INSERT INTO DistributionTarget (name, kind) VALUES ('공공기관', 'nonpress')").run();
  const ids = db.prepare('SELECT id FROM DistributionTarget ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(ids, [1, 2], 'id가 자동 증가해야 함');
});

test('createSchema: DistributionTarget이 없는 구버전 DB에 additive로 생기고 기존 행이 보존된다', () => {
  const db = new DatabaseSync(':memory:');
  // 구버전: DistributionTarget 테이블 없이 다른 테이블 + 기존 행만 있는 DB.
  db.exec('CREATE TABLE Contents (articleId VARCHAR PRIMARY KEY, title VARCHAR)');
  db.prepare("INSERT INTO Contents (articleId, title) VALUES ('a1', '옛 기사')").run();

  createSchema(db);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('DistributionTarget'), 'DistributionTarget 테이블이 additive로 생겨야 함');
  const row = db.prepare("SELECT * FROM Contents WHERE articleId='a1'").get();
  assert.equal(row.title, '옛 기사', '기존 행은 보존되어야 함 (비파괴)');
});

// --- phase 57 step0: ArticleHistory 배부 실패 영속 컬럼 (targetId INTEGER · reason VARCHAR) ---

test('createSchema: ArticleHistory에 targetId·reason 컬럼이 있다 (배부 실패 영속 — additive)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const cols = columns(db, 'ArticleHistory');
  assert.ok(cols.includes('targetId'), 'ArticleHistory.targetId');
  assert.ok(cols.includes('reason'), 'ArticleHistory.reason');
  // targetId는 INTEGER 선언이어야 한다 — VARCHAR(TEXT affinity)면 숫자 id가 문자열로 저장되어
  // DistributionTarget.id(숫자)와의 === 매칭이 조용히 깨진다.
  const info = db.prepare('PRAGMA table_info(ArticleHistory)').all();
  assert.equal(info.find((c) => c.name === 'targetId').type, 'INTEGER', 'targetId는 INTEGER');
  assert.equal(info.find((c) => c.name === 'reason').type, 'VARCHAR', 'reason은 VARCHAR');
});

test('createSchema: 멱등 — 2회 호출해도 targetId·reason이 중복 생성되지 않는다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  assert.doesNotThrow(() => createSchema(db));
  const info = db.prepare('PRAGMA table_info(ArticleHistory)').all();
  assert.equal(info.filter((c) => c.name.toLowerCase() === 'targetid').length, 1, 'targetId는 1개만');
  assert.equal(info.filter((c) => c.name.toLowerCase() === 'reason').length, 1, 'reason은 1개만');
});

test('createSchema: 구버전 ArticleHistory(targetId·reason 없음)에 additive 마이그레이션 시 기존 행 보존', () => {
  const db = new DatabaseSync(':memory:');
  // 옛 버전: 배부 실패 컬럼이 없는 ArticleHistory + 기존 행
  db.exec(
    'CREATE TABLE ArticleHistory (id INTEGER PRIMARY KEY, articleId VARCHAR, eventType VARCHAR, action VARCHAR, fromStatus VARCHAR, toStatus VARCHAR, actorUserId VARCHAR, createdAt VARCHAR, markupVersion VARCHAR)',
  );
  db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, action, createdAt) VALUES ('a1', 'distribute', 'press', '2026-08-06T00:00:00Z')",
  ).run();

  createSchema(db);

  const cols = columns(db, 'ArticleHistory');
  assert.ok(cols.includes('targetId'), '누락된 targetId 컬럼이 추가되어야 함');
  assert.ok(cols.includes('reason'), '누락된 reason 컬럼이 추가되어야 함');
  const rows = db.prepare('SELECT * FROM ArticleHistory').all();
  assert.equal(rows.length, 1, '기존 행은 삭제되지 않는다 (비파괴)');
  assert.equal(rows[0].action, 'press', '기존 컬럼 값이 보존되어야 함');
  assert.equal(rows[0].targetId, null, '기존 행의 targetId는 NULL');
  assert.equal(rows[0].reason, null, '기존 행의 reason은 NULL');
});

// --- phase 58 step0: ArticleHistory 이력 표시제목 컬럼 (snapshotTitle VARCHAR — additive) ---

test('createSchema: ArticleHistory — snapshotTitle 표시제목 컬럼이 있다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  assert.ok(
    columns(db, 'ArticleHistory').includes('snapshotTitle'),
    'ArticleHistory에 snapshotTitle 컬럼이 있어야 함',
  );
});

test('createSchema: 구버전 ArticleHistory(snapshotTitle 없음)에 additive 마이그레이션 시 기존 행 보존', () => {
  const db = new DatabaseSync(':memory:');
  // 옛 버전: 표시제목 컬럼이 없는 ArticleHistory + 기존 행
  db.exec(
    'CREATE TABLE ArticleHistory (id INTEGER PRIMARY KEY, articleId VARCHAR, eventType VARCHAR, action VARCHAR, fromStatus VARCHAR, toStatus VARCHAR, actorUserId VARCHAR, createdAt VARCHAR, markupVersion VARCHAR)',
  );
  db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, createdAt, markupVersion) VALUES ('a1', 'edit', '2026-08-10T00:00:00Z', 'SNAP-OLD')",
  ).run();

  createSchema(db);

  assert.ok(columns(db, 'ArticleHistory').includes('snapshotTitle'), '누락된 snapshotTitle 컬럼이 추가되어야 함');
  const row = db.prepare("SELECT * FROM ArticleHistory WHERE articleId='a1'").get();
  assert.equal(row.markupVersion, 'SNAP-OLD', '기존 행은 보존되어야 함');
  assert.equal(row.snapshotTitle, null, '기존 행의 snapshotTitle은 NULL(레거시 — 조회 시 본문 파생 폴백 대상)');
});

test('createSchema: 멱등 — 2회 호출해도 snapshotTitle이 중복 생성되지 않고 데이터가 보존된다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, createdAt, snapshotTitle) VALUES ('a1', 'edit', '2026-08-10T00:00:00Z', '제목1')",
  ).run();
  assert.doesNotThrow(() => createSchema(db));
  const info = db.prepare('PRAGMA table_info(ArticleHistory)').all();
  assert.equal(info.filter((c) => c.name.toLowerCase() === 'snapshottitle').length, 1, 'snapshotTitle은 1개만');
  assert.equal(
    db.prepare("SELECT snapshotTitle FROM ArticleHistory WHERE articleId='a1'").get().snapshotTitle,
    '제목1',
    '기존 데이터는 보존되어야 함',
  );
});

test('createSchema: 부분 컬럼 구버전 DistributionTarget에 누락 컬럼을 추가하고 기존 행을 보존한다', () => {
  const db = new DatabaseSync(':memory:');
  // 구버전: id/name만 있는 DistributionTarget + 기존 행.
  db.exec('CREATE TABLE DistributionTarget (id INTEGER PRIMARY KEY, name VARCHAR)');
  db.prepare("INSERT INTO DistributionTarget (name) VALUES ('옛 대상')").run();

  createSchema(db);

  const cols = columns(db, 'DistributionTarget');
  for (const c of ['kind', 'spoolDir', 'active', 'createdAt', 'updatedAt']) {
    assert.ok(cols.includes(c), `누락된 DistributionTarget.${c} 컬럼이 추가되어야 함`);
  }
  const row = db.prepare("SELECT * FROM DistributionTarget WHERE name='옛 대상'").get();
  assert.equal(row.name, '옛 대상', '기존 데이터는 보존되어야 함');
  assert.equal(row.active, 'Y', "active는 상수 DEFAULT 'Y'로 기존 행에 채워진다");
  assert.equal(row.kind, null, '기존 행의 kind는 NULL(미설정 — 정상)');
  assert.equal(row.spoolDir, null, '기존 행의 spoolDir는 NULL(미설정 — 정상)');
  assert.equal(row.createdAt, null, '기존 행의 createdAt은 NULL');
  assert.equal(row.updatedAt, null, '기존 행의 updatedAt은 NULL');
});
