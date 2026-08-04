import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionService } from '../src/services/sessionService.js';

// 결정적 테스트를 위한 주입 시계 — now()를 직접 제어한다(Date.now() 미사용).
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const MIN = 60 * 1000;

test('createSession: 토큰은 무작위이며 권한 정보를 담지 않는다', () => {
  const svc = createSessionService();
  const a = svc.createSession({ userId: 'kim', role: 'Z' });
  const b = svc.createSession({ userId: 'lee', role: 'Z' });
  assert.notEqual(a, b, '매번 다른 토큰');
  assert.match(a, /^[0-9a-f]{64}$/, '무작위 hex 토큰');
  assert.ok(!a.includes('Z'), '토큰 문자열에 권한이 담기지 않는다');
});

test('touchSession: 정제된 신원만 반환하고 비밀번호는 포함하지 않는다', () => {
  const clock = makeClock();
  const svc = createSessionService({ now: clock.now });
  const sid = svc.createSession({
    userId: 'kim', name: '김기자', role: 'D',
    department: '정치부', departmentCode: 'POL', password: 'secret-hash',
  });
  const id = svc.touchSession(sid);
  assert.deepEqual(id, {
    userId: 'kim', role: 'D', department: '정치부', departmentCode: 'POL', name: '김기자',
  });
  assert.equal(id.password, undefined, '신원에 비밀번호가 없다');
});

test('touchSession: 없는 세션은 undefined', () => {
  const svc = createSessionService();
  assert.equal(svc.touchSession('nope'), undefined);
});

test('touchSession: 59분엔 유효(슬라이딩 갱신), 갱신 없이 61분 지나면 만료', () => {
  const clock = makeClock();
  const svc = createSessionService({ now: clock.now });
  const sid = svc.createSession({ userId: 'kim', role: 'R' });

  clock.advance(59 * MIN);
  assert.ok(svc.touchSession(sid), '59분 시점: 유효 (만료 시점이 +60분으로 갱신됨)');

  clock.advance(61 * MIN);
  assert.equal(svc.touchSession(sid), undefined, '마지막 활동 후 61분 경과: 만료');
});

test('touchSession: 활동이 있는 한(슬라이딩) 세션이 유지된다', () => {
  const clock = makeClock();
  const svc = createSessionService({ now: clock.now });
  const sid = svc.createSession({ userId: 'kim', role: 'R' });
  for (let i = 1; i <= 5; i++) {
    clock.advance(50 * MIN);
    assert.ok(svc.touchSession(sid), `${i * 50}분 시점에도 활동으로 유지`);
  }
});

test('createSession: 같은 사용자의 기존 세션을 무효화하고 새 토큰을 발급한다', () => {
  const clock = makeClock();
  const svc = createSessionService({ now: clock.now });
  const first = svc.createSession({ userId: 'kim', role: 'R' });
  const second = svc.createSession({ userId: 'kim', role: 'R' });
  assert.notEqual(first, second, '새 토큰 발급');
  assert.equal(svc.touchSession(first), undefined, '기존 세션은 무효화');
  assert.ok(svc.touchSession(second), '새 세션은 유효');
});

test('invalidate: 로그아웃하면 세션이 사라진다', () => {
  const svc = createSessionService();
  const sid = svc.createSession({ userId: 'kim', role: 'R' });
  assert.ok(svc.touchSession(sid));
  svc.invalidate(sid);
  assert.equal(svc.touchSession(sid), undefined);
});

// --- peekSession: 만료를 연장하지 않는 조회 (SSE처럼 반복 확인하는 경로용) ---

test('peekSession: 유효 세션이면 touchSession과 같은 정제 신원을 반환한다', () => {
  const clock = makeClock();
  const svc = createSessionService({ now: clock.now });
  const sid = svc.createSession({
    userId: 'kim', name: '김기자', role: 'D',
    department: '정치부', departmentCode: 'POL', password: 'secret-hash',
  });
  const id = svc.peekSession(sid);
  assert.deepEqual(id, {
    userId: 'kim', role: 'D', department: '정치부', departmentCode: 'POL', name: '김기자',
  });
  assert.ok(!('password' in id), '신원에 비밀번호 키가 없다');
});

test('peekSession: 없는 세션은 undefined', () => {
  const svc = createSessionService();
  assert.equal(svc.peekSession('nope'), undefined);
});

test('peekSession: 만료를 연장하지 않는다(peek만 반복하면 1시간 뒤 만료)', () => {
  const clock = makeClock();
  const svc = createSessionService({ now: clock.now });
  const sid = svc.createSession({ userId: 'kim', role: 'R' });

  clock.advance(30 * MIN);
  assert.ok(svc.peekSession(sid), '30분 시점: 아직 유효');
  clock.advance(31 * MIN);
  assert.equal(svc.peekSession(sid), undefined, '발급 후 61분: peek는 연장하지 않으므로 만료');
});

test('peekSession: 만료된 세션은 스토어에서 제거된다(touchSession도 undefined)', () => {
  const clock = makeClock();
  const svc = createSessionService({ now: clock.now });
  const sid = svc.createSession({ userId: 'kim', role: 'R' });

  clock.advance(61 * MIN);
  assert.equal(svc.peekSession(sid), undefined, '만료');
  assert.equal(svc.touchSession(sid), undefined, '제거됐으므로 touch로도 부활하지 않는다');
});

test('peekSession: 반환 신원은 사본이라 스토어를 오염시키지 않는다', () => {
  const svc = createSessionService();
  const sid = svc.createSession({ userId: 'kim', role: 'R' });
  const id = svc.peekSession(sid);
  id.role = 'Z';
  assert.equal(svc.peekSession(sid).role, 'R', '외부 변형이 세션 스토어에 반영되지 않는다');
});
