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

// 시계와 잠금 정책을 주입한 setup
function setupLockout(nowFn, policy = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const userModel = createUserModel(db);
  const service = createUserService({ userModel, now: nowFn, ...policy });
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

test('login: 잠금 메타(lockedUntil 등)가 user 응답에 포함되지 않는다', async () => {
  const { userModel, service } = setup();
  seed(userModel);
  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, true);
  assert.ok(!('lockedUntil' in r.user), 'lockedUntil 미노출');
  assert.ok(!('failedLoginCount' in r.user), 'failedLoginCount 미노출');
  assert.ok(!('lastFailedLoginAt' in r.user), 'lastFailedLoginAt 미노출');
});

test('login: 실패 5회 후 6번째 시도는 locked를 반환한다', async () => {
  let t = 0;
  const { userModel, service } = setupLockout(() => t, { maxFailedAttempts: 5, lockDurationMs: 900000 });
  seed(userModel);

  for (let i = 0; i < 5; i++) {
    const r = await service.login('kim', 'wrong');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-credentials', `${i + 1}번째 실패는 invalid-credentials`);
  }

  // 6번째: 잠금 기간 내 → locked
  const r6 = await service.login('kim', 'wrong');
  assert.equal(r6.ok, false);
  assert.equal(r6.reason, 'locked');
});

test('login: lockDurationMs 경과 후 정상 로그인 시 카운터 리셋', async () => {
  let t = 0;
  const lockDurationMs = 900000;
  const { userModel, service } = setupLockout(() => t, { maxFailedAttempts: 3, lockDurationMs });
  seed(userModel);

  // 3회 실패 → 잠금 설정
  for (let i = 0; i < 3; i++) await service.login('kim', 'wrong');

  // 잠금 기간 경과
  t = lockDurationMs + 1;

  // 올바른 비밀번호로 로그인 성공
  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, true);

  // 카운터·lockedUntil 리셋 확인
  const row = userModel.findById('kim');
  assert.equal(row.failedLoginCount, '0');
  assert.ok(!row.lockedUntil, 'lockedUntil이 비워져야 함');
});

test('login: 성공 로그인이 failedLoginCount와 lockedUntil을 비운다', async () => {
  let t = 1000;
  const { userModel, service } = setupLockout(() => t, { maxFailedAttempts: 10 });
  seed(userModel);

  await service.login('kim', 'wrong');
  await service.login('kim', 'wrong');

  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, true);

  const row = userModel.findById('kim');
  assert.equal(row.failedLoginCount, '0');
  assert.ok(!row.lockedUntil, 'lockedUntil 초기화');
});

test('login: inactive 계정에는 잠금 카운터를 쌓지 않는다', async () => {
  let t = 0;
  const { userModel, service } = setupLockout(() => t, { maxFailedAttempts: 3 });
  seed(userModel, { active: 'N' });

  for (let i = 0; i < 5; i++) {
    const r = await service.login('kim', 'wrong');
    assert.equal(r.reason, 'inactive', 'inactive 계정은 항상 inactive 반환');
  }

  const row = userModel.findById('kim');
  assert.equal(row.failedLoginCount ?? '0', '0', '카운터가 올라가지 않아야 함');
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
