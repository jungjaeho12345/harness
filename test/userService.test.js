import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createUserService } from '../src/services/userService.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const userModel = createUserModel(db);
  const service = createUserService({ userModel });
  return { userModel, service };
}

function seed(userModel, over = {}) {
  userModel.insert({
    userId: 'kim', name: '김기자', password: bcrypt.hashSync('pw1234', 10),
    role: 'R', department: '정치부', departmentCode: 'POL', active: 'Y',
    ...over,
  });
}

test('login: 올바른 비밀번호면 성공하고 정제된 사용자(비밀번호 없음)를 반환한다', async () => {
  const { userModel, service } = setup();
  seed(userModel);
  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, true);
  assert.equal(r.user.userId, 'kim');
  assert.equal(r.user.role, 'R');
  assert.equal(r.user.department, '정치부');
  assert.ok(!('password' in r.user), '반환 사용자에 비밀번호(해시 포함) 없음');
});

test('login: 비밀번호가 틀리면 invalid-credentials', async () => {
  const { userModel, service } = setup();
  seed(userModel);
  const r = await service.login('kim', 'wrong');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-credentials');
  assert.equal(r.user, undefined);
});

test('login: 존재하지 않는 사용자도 오류 없이 invalid-credentials를 반환한다', async () => {
  const { service } = setup();
  const r = await service.login('nobody', 'whatever');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-credentials');
});

test('login: active=N 사용자는 올바른 비밀번호여도 로그인할 수 없다', async () => {
  const { userModel, service } = setup();
  seed(userModel, { active: 'N' });
  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'inactive');
});

test('query: 정제된 필드만 반환하고 비밀번호를 제외한다', () => {
  const { userModel, service } = setup();
  seed(userModel);
  userModel.insert({
    userId: 'lee', name: '이데스크', password: bcrypt.hashSync('x', 10),
    role: 'D', department: '정치부', departmentCode: 'POL', active: 'Y',
  });
  const list = service.query({ department: '정치부' });
  assert.equal(list.length, 2);
  for (const u of list) {
    assert.ok(!('password' in u), '목록 항목에 비밀번호 없음');
    assert.ok(u.userId);
  }
});
