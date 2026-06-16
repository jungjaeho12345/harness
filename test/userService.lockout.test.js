import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createUserService } from '../src/services/userService.js';

// 가짜 시계: clock.now()를 advance로 전진시켜 잠금 만료를 결정적으로 검증한다.
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function setup(opts = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const userModel = createUserModel(db);
  const service = createUserService({ userModel, ...opts });
  return { userModel, service };
}

function seed(userModel, over = {}) {
  userModel.insert({
    userId: 'kim', name: '김기자', password: bcrypt.hashSync('pw1234', 10),
    role: 'R', department: '정치부', departmentCode: 'POL', active: 'Y',
    ...over,
  });
}

test('lockout: 실패가 임계치 미만이면 카운트만 오르고 잠기지 않는다', async () => {
  const clock = fakeClock(1_000);
  const { userModel, service } = setup({ now: clock.now, lockoutThreshold: 5 });
  seed(userModel);

  for (let i = 0; i < 4; i++) {
    const r = await service.login('kim', 'wrong');
    assert.equal(r.reason, 'invalid-credentials');
  }
  const row = userModel.findById('kim');
  assert.equal(row.failedLoginCount, '4', '실패 카운트가 4로 누적');
  assert.ok(!row.lockedUntil, '임계치 미만이므로 잠금 미설정');

  // 임계치 미만 상태에서는 올바른 비밀번호로 정상 로그인 가능
  const ok = await service.login('kim', 'pw1234');
  assert.equal(ok.ok, true);
});

test('lockout: 임계치 도달 시 lockedUntil 설정되고 올바른 비밀번호여도 locked', async () => {
  const clock = fakeClock(10_000);
  const windowMs = 15 * 60 * 1000;
  const { userModel, service } = setup({
    now: clock.now, lockoutThreshold: 5, lockoutWindowMs: windowMs,
  });
  seed(userModel);

  for (let i = 0; i < 5; i++) {
    const r = await service.login('kim', 'wrong');
    assert.equal(r.reason, 'invalid-credentials');
  }
  const row = userModel.findById('kim');
  assert.equal(row.failedLoginCount, '5');
  assert.equal(row.lockedUntil, String(10_000 + windowMs), 'lockedUntil = now + 기간');

  // 잠금 중에는 올바른 비밀번호로도 거부
  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'locked');
});

test('lockout: lockedUntil 경과(시계 전진) 후에는 다시 로그인 가능 — 행 삭제 없음', async () => {
  const clock = fakeClock(0);
  const windowMs = 15 * 60 * 1000;
  const { userModel, service } = setup({
    now: clock.now, lockoutThreshold: 5, lockoutWindowMs: windowMs,
  });
  seed(userModel);

  for (let i = 0; i < 5; i++) await service.login('kim', 'wrong');
  assert.equal((await service.login('kim', 'pw1234')).reason, 'locked');

  // 잠금 기간 경과
  clock.advance(windowMs + 1);

  // 행은 여전히 존재(삭제 없음)하고 잠금이 만료되어 로그인 가능
  assert.ok(userModel.findById('kim'), '행이 삭제되지 않음');
  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, true);
});

test('lockout: 로그인 성공 시 카운트/잠금이 리셋된다', async () => {
  const clock = fakeClock(500);
  const { userModel, service } = setup({ now: clock.now, lockoutThreshold: 5 });
  seed(userModel);

  await service.login('kim', 'wrong');
  await service.login('kim', 'wrong');
  assert.equal(userModel.findById('kim').failedLoginCount, '2');

  const ok = await service.login('kim', 'pw1234');
  assert.equal(ok.ok, true);

  const row = userModel.findById('kim');
  assert.equal(row.failedLoginCount, '0', '성공 시 카운트 0으로 리셋');
  assert.ok(!row.lockedUntil, '성공 시 lockedUntil 비움');
  assert.ok(!row.lastFailedLoginAt, '성공 시 lastFailedLoginAt 비움');
});

test('lockout: 비활성(active=N)은 잠금 카운트와 무관하게 inactive를 반환한다', async () => {
  const clock = fakeClock(0);
  const { userModel, service } = setup({ now: clock.now });
  // 이미 잠긴 상태의 비활성 사용자
  seed(userModel, {
    active: 'N', failedLoginCount: '9', lockedUntil: String(60 * 60 * 1000),
  });

  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'inactive', '비활성 체크가 잠금보다 우선');

  // 비활성 거부는 잠금 카운트를 올리지 않는다
  assert.equal(userModel.findById('kim').failedLoginCount, '9');
});

test('lockout: 응답에 password/failedLoginCount/lockedUntil이 노출되지 않는다', async () => {
  const clock = fakeClock(0);
  const { userModel, service } = setup({ now: clock.now });
  seed(userModel);
  const r = await service.login('kim', 'pw1234');
  assert.equal(r.ok, true);
  assert.ok(!('password' in r.user));
  assert.ok(!('failedLoginCount' in r.user));
  assert.ok(!('lockedUntil' in r.user));
  assert.ok(!('lastFailedLoginAt' in r.user));
});
