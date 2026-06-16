import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

const LOCKOUT_COLS = ['failedLoginCount', 'lockedUntil', 'lastFailedLoginAt'];

test('createSchema: User에 계정 잠금 컬럼 3개를 생성한다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const cols = columns(db, 'User');
  for (const c of LOCKOUT_COLS) {
    assert.ok(cols.includes(c), `User.${c} 컬럼이 있어야 함`);
  }
});

test('createSchema: failedLoginCount의 기본값은 문자열 0이다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  db.prepare("INSERT INTO User (userId) VALUES ('lk1')").run();
  assert.equal(
    db.prepare("SELECT failedLoginCount FROM User WHERE userId='lk1'").get().failedLoginCount,
    '0',
  );
});

test('createSchema: lockedUntil/lastFailedLoginAt 기본값은 NULL이다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  db.prepare("INSERT INTO User (userId) VALUES ('lk2')").run();
  const row = db.prepare("SELECT lockedUntil, lastFailedLoginAt FROM User WHERE userId='lk2'").get();
  assert.equal(row.lockedUntil, null);
  assert.equal(row.lastFailedLoginAt, null);
});

test('createSchema: 구버전 User 테이블에 잠금 컬럼만 ADD COLUMN하고 기존 행을 보존한다 (additive)', () => {
  const db = new DatabaseSync(':memory:');
  // 잠금 컬럼이 없던 옛 버전 User 테이블 + 기존 데이터
  db.exec(
    "CREATE TABLE User (userId TEXT PRIMARY KEY, name TEXT, password TEXT, role TEXT, department TEXT, departmentCode TEXT, active TEXT DEFAULT 'Y')",
  );
  db.prepare("INSERT INTO User (userId, name, role) VALUES ('old1', '홍길동', 'R')").run();
  const before = db.prepare('SELECT COUNT(*) AS n FROM User').get().n;

  createSchema(db);

  const cols = columns(db, 'User');
  for (const c of LOCKOUT_COLS) {
    assert.ok(cols.includes(c), `${c} 컬럼이 추가되어야 함`);
  }
  // 기존 행 보존: 행 수 불변, 기존 값 보존
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM User').get().n, before);
  assert.equal(db.prepare("SELECT name FROM User WHERE userId='old1'").get().name, '홍길동');
});

test('createSchema: 잠금 컬럼이 이미 있는 상태에서 2회 호출해도 오류 없이 데이터를 보존한다 (멱등)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  db.prepare(
    "INSERT INTO User (userId, name, failedLoginCount) VALUES ('lk3', '김철수', '2')",
  ).run();
  assert.doesNotThrow(() => createSchema(db));
  const row = db.prepare("SELECT name, failedLoginCount FROM User WHERE userId='lk3'").get();
  assert.equal(row.name, '김철수');
  assert.equal(row.failedLoginCount, '2');
});
