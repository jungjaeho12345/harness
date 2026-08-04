// 세션 가드 — 매 요청 DB 재조회로 비활성/역할 변경을 기존 세션에 즉시 반영한다.
// (2026-08-03 전수감사 [high]: 세션에 고정된 role/active 스냅샷이 최대 1시간 슬라이딩으로 유지되던 구멍)
// sessionService는 순수 in-memory 스토어로 두고, 같은 인터페이스의 데코레이터가 User 행을 재조회한다.
// in-memory DatabaseSync(':memory:') + 가짜 시계 주입으로 결정적으로 검증한다(프로덕션 DB 미바인딩).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createSessionGuard } from '../src/services/sessionGuard.js';

const MIN = 60 * 1000;

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const userModel = createUserModel(db);
  const clock = makeClock();
  const sessionService = createSessionService({ now: clock.now });
  const guard = createSessionGuard({ sessionService, userModel });
  return { db, userModel, sessionService, guard, clock };
}

// bcrypt 로그인 경로는 불필요하다 — 모델에 직접 insert 한다.
function seed(userModel, over = {}) {
  const row = {
    userId: 'kim',
    name: '김기자',
    password: 'bcrypt-hash-should-never-leak',
    role: 'Z',
    department: '정치부',
    departmentCode: 'POL',
    active: 'Y',
    failedLoginCount: '3',
    lockedUntil: '99999999',
    lastFailedLoginAt: '123456',
    ...over,
  };
  userModel.insert(row);
  return row;
}

// --- 공격/보안 시나리오 ---

test('가드 1: active=N으로 바뀐 사용자의 세션은 즉시 무효화되고 되살아나지 않는다', () => {
  const { userModel, guard } = setup();
  seed(userModel);
  const sid = guard.createSession({ userId: 'kim', role: 'Z' });
  assert.ok(guard.touchSession(sid), '비활성화 전에는 유효');

  userModel.update('kim', { active: 'N' });
  assert.equal(guard.touchSession(sid), undefined, '비활성 계정은 즉시 차단');
  assert.equal(guard.touchSession(sid), undefined, '같은 토큰 재시도도 계속 차단');

  userModel.update('kim', { active: 'Y' });
  assert.equal(guard.touchSession(sid), undefined, '되돌려도 그 토큰은 부활하지 않는다(재로그인 필요)');
});

test('가드 2: 역할 강등(Z→R)이 기존 세션에 반영된다', () => {
  const { userModel, guard } = setup();
  seed(userModel, { role: 'Z' });
  const sid = guard.createSession({ userId: 'kim', role: 'Z' });
  assert.equal(guard.touchSession(sid).role, 'Z');

  userModel.update('kim', { role: 'R' });
  assert.equal(guard.touchSession(sid).role, 'R', 'DB 최신값에서 역할을 재도출한다');
});

test('가드 3: 역할 승격(R→Z)도 대칭으로 반영된다', () => {
  const { userModel, guard } = setup();
  seed(userModel, { role: 'R' });
  const sid = guard.createSession({ userId: 'kim', role: 'R' });
  assert.equal(guard.touchSession(sid).role, 'R');

  userModel.update('kim', { role: 'Z' });
  assert.equal(guard.touchSession(sid).role, 'Z');
});

test('가드 4: User 행이 없는 세션은 undefined + 무효화된다', () => {
  const { userModel, guard } = setup();
  const sid = guard.createSession({ userId: 'ghost', role: 'Z' });
  assert.equal(guard.touchSession(sid), undefined, '행이 없으면 거부');

  seed(userModel, { userId: 'ghost' });
  assert.equal(guard.touchSession(sid), undefined, '뒤늦게 행이 생겨도 무효화된 토큰은 부활하지 않는다');
});

test('가드 5: 반환 신원에 비밀번호·잠금 필드가 없다(화이트리스트 투영)', () => {
  const { userModel, guard } = setup();
  seed(userModel);
  const sid = guard.createSession({ userId: 'kim', role: 'Z' });

  const id = guard.touchSession(sid);
  assert.deepEqual(id, {
    userId: 'kim', role: 'Z', department: '정치부', departmentCode: 'POL', name: '김기자',
  });
  for (const leak of ['password', 'failedLoginCount', 'lockedUntil', 'lastFailedLoginAt', 'active']) {
    assert.ok(!(leak in id), `신원에 ${leak} 키가 없다`);
  }
  assert.deepEqual(guard.peekSession(sid), id, 'peek도 동일한 투영');
});

test('가드 6: peekSession도 비활성 차단·역할 재도출을 한다', () => {
  const { userModel, guard } = setup();
  seed(userModel, { role: 'Z' });
  const sid = guard.createSession({ userId: 'kim', role: 'Z' });
  assert.equal(guard.peekSession(sid).role, 'Z');

  userModel.update('kim', { role: 'R' });
  assert.equal(guard.peekSession(sid).role, 'R', 'peek도 DB 최신 역할');

  userModel.update('kim', { active: 'N' });
  assert.equal(guard.peekSession(sid), undefined, 'peek도 비활성 즉시 차단');
  assert.equal(guard.touchSession(sid), undefined, '무효화됐으므로 touch로도 통과 못한다');
});

test('가드 7: 재검증 결과를 캐시하지 않는다(touch 3회 → findById 정확히 3회)', () => {
  const { userModel, sessionService } = setup();
  seed(userModel);
  let calls = 0;
  const spyModel = {
    ...userModel,
    findById: (id) => { calls += 1; return userModel.findById(id); },
  };
  const guard = createSessionGuard({ sessionService, userModel: spyModel });
  const sid = guard.createSession({ userId: 'kim', role: 'Z' });

  assert.equal(calls, 0, 'createSession은 DB를 조회하지 않는다');
  guard.touchSession(sid);
  guard.touchSession(sid);
  guard.touchSession(sid);
  assert.equal(calls, 3, '매 호출마다 DB 재조회');
});

test('가드 8: 생성 후 교체된 sessionService.touchSession/peekSession을 호출한다(동적 호출)', () => {
  const { userModel, sessionService, guard } = setup();
  seed(userModel);
  const sid = guard.createSession({ userId: 'kim', role: 'Z' });

  const originalTouch = sessionService.touchSession;
  let touchedWith;
  sessionService.touchSession = (s) => { touchedWith = s; return originalTouch(s); };
  assert.ok(guard.touchSession(sid), '교체본을 통해서도 정상 통과');
  assert.equal(touchedWith, sid, '가드는 교체된 touchSession을 호출한다');

  const originalPeek = sessionService.peekSession;
  let peekedWith;
  sessionService.peekSession = (s) => { peekedWith = s; return originalPeek(s); };
  assert.ok(guard.peekSession(sid));
  assert.equal(peekedWith, sid, '가드는 교체된 peekSession을 호출한다');
});

// --- 정상 플로우 무손상(회귀) ---

test('가드 9: active=Y 정상 사용자는 매번 통과하고 슬라이딩 연장도 유지된다', () => {
  const { userModel, guard, clock } = setup();
  seed(userModel, { role: 'R' });
  const sid = guard.createSession({ userId: 'kim', role: 'R' });

  for (let i = 1; i <= 5; i++) {
    clock.advance(50 * MIN);
    assert.equal(guard.touchSession(sid).role, 'R', `${i * 50}분 시점에도 활동으로 유지`);
  }
  clock.advance(59 * MIN);
  assert.ok(guard.touchSession(sid), '마지막 활동 후 59분: 유효');
});

test('가드 10: active가 비어 있는 레거시 행은 차단하지 않는다(정확히 N일 때만 비활성)', () => {
  const { userModel, guard } = setup();
  seed(userModel, { role: 'D', active: null });
  const sid = guard.createSession({ userId: 'kim', role: 'D' });
  assert.equal(guard.touchSession(sid).role, 'D', 'active NULL 레거시 행은 통과');

  userModel.update('kim', { active: 'n' });
  assert.ok(guard.touchSession(sid), "소문자 'n'은 비활성 판정이 아니다(login 판정과 동형)");
});

test('가드 11: peekSession은 만료를 연장하지 않고 touchSession은 연장한다', () => {
  const peeked = setup();
  seed(peeked.userModel);
  const peekSid = peeked.guard.createSession({ userId: 'kim', role: 'Z' });
  peeked.clock.advance(30 * MIN);
  assert.ok(peeked.guard.peekSession(peekSid), '30분: 유효');
  peeked.clock.advance(31 * MIN);
  assert.equal(peeked.guard.peekSession(peekSid), undefined, '발급 후 61분: peek는 연장 없음 → 만료');

  const touched = setup();
  seed(touched.userModel);
  const touchSid = touched.guard.createSession({ userId: 'kim', role: 'Z' });
  touched.clock.advance(30 * MIN);
  assert.ok(touched.guard.touchSession(touchSid), '30분: 유효');
  touched.clock.advance(31 * MIN);
  assert.ok(touched.guard.touchSession(touchSid), '같은 조건에서 touch는 연장되어 유효');
});

test('가드 12: createSession/invalidate는 원본에 그대로 위임한다', () => {
  const { userModel, sessionService, guard } = setup();
  seed(userModel);
  const sid = guard.createSession({ userId: 'kim', role: 'Z' });
  assert.match(sid, /^[0-9a-f]{64}$/, '원본이 발급한 무작위 토큰');
  assert.ok(sessionService.touchSession(sid), '원본 스토어에 세션이 들어 있다');

  const second = guard.createSession({ userId: 'kim', role: 'Z' });
  assert.equal(guard.touchSession(sid), undefined, '같은 사용자의 기존 세션 무효화 계약 유지');

  assert.equal(guard.invalidate(second), true, 'invalidate는 원본 반환값을 그대로 돌려준다');
  assert.equal(guard.touchSession(second), undefined, '로그아웃 후 차단');
  assert.equal(guard.invalidate('nope'), false, '없는 세션 invalidate는 false');
});
