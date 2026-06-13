import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  return createUserModel(db);
}

test('userModel: insert 후 findById가 raw row(비밀번호 포함)를 반환한다', () => {
  const users = setup();
  users.insert({
    userId: 'kim', name: '김기자', password: 'hash#1',
    role: 'R', department: '정치부', departmentCode: 'POL', active: 'Y',
  });
  const row = users.findById('kim');
  assert.equal(row.userId, 'kim');
  assert.equal(row.name, '김기자');
  assert.equal(row.password, 'hash#1', 'raw row이므로 비밀번호를 포함한다(정제는 서비스 책임)');
  assert.equal(row.role, 'R');
});

test('userModel: findById는 없는 사용자에 undefined를 반환한다', () => {
  const users = setup();
  assert.equal(users.findById('nobody'), undefined);
});

test('userModel: query는 AND 동등 필터를 적용한다 (부서 등)', () => {
  const users = setup();
  users.insert({ userId: 'a', role: 'R', department: '정치부', active: 'Y' });
  users.insert({ userId: 'b', role: 'D', department: '정치부', active: 'Y' });
  users.insert({ userId: 'c', role: 'R', department: '경제부', active: 'Y' });

  const pol = users.query({ department: '정치부' });
  assert.deepEqual(pol.map((u) => u.userId).sort(), ['a', 'b']);

  const polReporters = users.query({ department: '정치부', role: 'R' });
  assert.deepEqual(polReporters.map((u) => u.userId), ['a']);
});

test('userModel: query는 필터가 없으면 전체를 반환한다', () => {
  const users = setup();
  users.insert({ userId: 'a' });
  users.insert({ userId: 'b' });
  assert.equal(users.query().length, 2);
});

test('userModel: update는 일부 필드만 갱신한다', () => {
  const users = setup();
  users.insert({ userId: 'kim', name: '김기자', role: 'R', active: 'Y' });
  const changes = users.update('kim', { role: 'D', active: 'N' });
  assert.equal(changes, 1);
  const row = users.findById('kim');
  assert.equal(row.role, 'D');
  assert.equal(row.active, 'N');
  assert.equal(row.name, '김기자', '갱신하지 않은 필드는 보존된다');
});

test('userModel: update에 갱신 필드가 없으면 0을 반환한다', () => {
  const users = setup();
  users.insert({ userId: 'kim', role: 'R' });
  assert.equal(users.update('kim', {}), 0);
});

test('userModel: 삭제(delete/remove) 함수를 노출하지 않는다 (DB 비파괴)', () => {
  const users = setup();
  assert.equal(users.delete, undefined);
  assert.equal(users.remove, undefined);
  assert.deepEqual(Object.keys(users).sort(), ['findById', 'insert', 'query', 'update']);
});
