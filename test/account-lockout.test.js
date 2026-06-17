// 계정 잠금(account-lockout) — userService.login의 실패 누적/잠금/자동해제/리셋 로직.
// 가짜 시계(now)와 in-memory userModel 주입으로 결정적으로 검증한다(프로덕션 DB 미바인딩).
// 잠금/실패 필드(failedLoginCount/lockedUntil)는 응답에 절대 노출되지 않아야 한다(정보 누출 방지).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import {
  createUserService,
  LOCKOUT_THRESHOLD,
  LOCKOUT_DURATION_MS,
} from '../src/services/userService.js';

function setup(start = 0) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const userModel = createUserModel(db);
  let clock = start;
  const now = () => clock;
  const advance = (ms) => { clock += ms; };
  const service = createUserService({ userModel, now });
  return { userModel, service, advance, setClock: (t) => { clock = t; } };
}

function seed(userModel, over = {}) {
  userModel.insert({
    userId: 'kim', name: '김기자', password: bcrypt.hashSync('pw1234', 10),
    role: 'R', department: '정치부', departmentCode: 'POL', active: 'Y',
    ...over,
  });
}

test('임계치 미만 연속 실패는 매번 invalid-credentials이고 failedLoginCount가 증가한다', async () => {
  const { userModel, service } = setup();
  seed(userModel);
  for (let i = 1; i < LOCKOUT_THRESHOLD; i += 1) {
    const r = await service.login('kim', 'wrong');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-credentials', `${i}회차는 invalid-credentials`);
    assert.equal(userModel.findById('kim').failedLoginCount, String(i));
  }
});

test('임계치 도달 후 다음 시도는 올바른 비밀번호여도 locked', async () => {
  const { userModel, service } = setup();
  seed(userModel);
  for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
    await service.login('kim', 'wrong');
  }
  // 잠금 시간 내에는 올바른 비밀번호도 거부.
  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'locked');
  assert.equal(r.user, undefined);
});

test('잠금 시간 경과 후에는 올바른 비밀번호로 다시 성공하고 카운터가 리셋된다', async () => {
  const { userModel, service, advance } = setup();
  seed(userModel);
  for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
    await service.login('kim', 'wrong');
  }
  assert.equal((await service.login('kim', 'pw1234')).reason, 'locked');

  advance(LOCKOUT_DURATION_MS + 1);
  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, true);
  assert.equal(r.user.userId, 'kim');
  assert.equal(userModel.findById('kim').failedLoginCount, '0');
  assert.equal(userModel.findById('kim').lockedUntil, null);
});

test('로그인 성공 시 failedLoginCount가 0으로 리셋되고 lockedUntil이 비워진다', async () => {
  const { userModel, service } = setup();
  seed(userModel);
  await service.login('kim', 'wrong');
  await service.login('kim', 'wrong');
  assert.equal(userModel.findById('kim').failedLoginCount, '2');

  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, true);
  assert.equal(userModel.findById('kim').failedLoginCount, '0');
  assert.equal(userModel.findById('kim').lockedUntil, null);
});

test('응답 user에 failedLoginCount/lockedUntil/password가 절대 포함되지 않는다', async () => {
  const { userModel, service } = setup();
  seed(userModel);
  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, true);
  assert.ok(!('password' in r.user));
  assert.ok(!('failedLoginCount' in r.user), '잠금 카운트는 응답에 노출 금지');
  assert.ok(!('lockedUntil' in r.user), '잠금 만료는 응답에 노출 금지');
});

test('active=N은 잠금 로직과 무관하게 inactive를 반환한다(기존 회귀)', async () => {
  const { userModel, service } = setup();
  seed(userModel, { active: 'N' });
  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'inactive');
});

test('존재하지 않는 사용자는 invalid-credentials이며 잠금되지 않는다(타이밍 평준화 경로)', async () => {
  const { userModel, service } = setup();
  for (let i = 0; i < LOCKOUT_THRESHOLD + 2; i += 1) {
    const r = await service.login('ghost', 'whatever');
    assert.equal(r.reason, 'invalid-credentials');
  }
  assert.equal(userModel.findById('ghost'), undefined, '없는 사용자는 행이 생기지 않는다');
});

test('failedLoginCount는 문자열 누적 버그 없이 숫자로 증가한다(0 + 1 !== 01)', async () => {
  const { userModel, service } = setup();
  seed(userModel);
  await service.login('kim', 'wrong');
  await service.login('kim', 'wrong');
  await service.login('kim', 'wrong');
  assert.equal(userModel.findById('kim').failedLoginCount, '3');
});
