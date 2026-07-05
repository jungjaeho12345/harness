// 다이제스트 스케줄러 테스트 (26-realtime-log-viewer step3).
// 주입한 가짜 clock/setTimer/sendDigest로 실제 시간 흐름 없이 결정적으로 검증한다.
//   - msUntilNextRun: 다음 06:00까지의 지연 계산(오늘 06:00 이전/이후).
//   - 스케줄러 기본 off(생성만으로 예약 없음), start() 시에만 예약.
//   - 발화 시 step2 코어(computeLogDigest)로 집계해 sendDigest 호출 + 재예약.
//   - sendDigest 예외 격리(스케줄러가 죽지 않고 재예약).
//   - stop()이 예약을 취소.

import test from 'node:test';
import assert from 'node:assert/strict';
import { msUntilNextRun, createDigestScheduler } from '../src/services/digestScheduler.js';

// 가짜 타이머 — 예약된 콜백을 캡처해 테스트가 수동으로 발화시킨다(실시간 없음).
function fakeTimer() {
  const scheduled = []; // { fn, delay, id, cleared }
  let nextId = 1;
  const setTimer = (fn, delay) => {
    const rec = { fn, delay, id: nextId++, cleared: false };
    scheduled.push(rec);
    return rec.id;
  };
  const clearTimer = (id) => {
    const rec = scheduled.find((r) => r.id === id);
    if (rec) rec.cleared = true;
  };
  return {
    setTimer,
    clearTimer,
    scheduled,
    // 가장 최근 예약을 수동 발화(발화 전 목록에서 제거해 재예약과 구분).
    fireLast: () => {
      const rec = scheduled.pop();
      rec.fn();
      return rec;
    },
  };
}

test('msUntilNextRun: now가 오늘 06:00 이전이면 오늘 06:00까지', () => {
  const now = new Date(2026, 6, 5, 3, 0, 0, 0); // 03:00
  const target = new Date(2026, 6, 5, 6, 0, 0, 0); // 오늘 06:00
  assert.equal(msUntilNextRun(now), target.getTime() - now.getTime());
  assert.equal(msUntilNextRun(now), 3 * 60 * 60 * 1000);
});

test('msUntilNextRun: now가 오늘 06:00 이후면 내일 06:00까지', () => {
  const now = new Date(2026, 6, 5, 9, 0, 0, 0); // 09:00
  const target = new Date(2026, 6, 6, 6, 0, 0, 0); // 내일 06:00
  assert.equal(msUntilNextRun(now), target.getTime() - now.getTime());
  assert.equal(msUntilNextRun(now), 21 * 60 * 60 * 1000);
});

test('msUntilNextRun: hour 인자 커스터마이즈', () => {
  const now = new Date(2026, 6, 5, 3, 0, 0, 0);
  const target = new Date(2026, 6, 5, 8, 0, 0, 0);
  assert.equal(msUntilNextRun(now, 8), target.getTime() - now.getTime());
});

test('생성만으로는 아무 것도 예약하지 않는다(기본 off)', () => {
  const timer = fakeTimer();
  createDigestScheduler({
    logService: { entries: () => [] },
    sendDigest: () => {},
    clock: () => new Date(2026, 6, 5, 3, 0, 0, 0),
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });
  assert.equal(timer.scheduled.length, 0);
});

test('start()는 다음 06:00까지 지연으로 예약한다', () => {
  const timer = fakeTimer();
  const now = new Date(2026, 6, 5, 3, 0, 0, 0);
  const s = createDigestScheduler({
    logService: { entries: () => [] },
    sendDigest: () => {},
    clock: () => now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });
  s.start();
  assert.equal(timer.scheduled.length, 1);
  assert.equal(timer.scheduled[0].delay, 3 * 60 * 60 * 1000);
});

test('발화 시 step2 코어로 집계해 sendDigest를 호출하고 재예약한다', () => {
  const timer = fakeTimer();
  // runDate = 2026-07-05 06:00. 윈도우 = 2026-07-04 06:00 ~ 2026-07-05 05:59:59.999.
  const runDate = new Date(2026, 6, 5, 6, 0, 0, 0);
  const inWindow = new Date(2026, 6, 4, 10, 0, 0, 0).getTime(); // 윈도우 내
  const outWindow = new Date(2026, 6, 3, 10, 0, 0, 0).getTime(); // 윈도우 밖(전전날)
  const entries = [
    { ts: inWindow, level: 'INFO', line: '[in] a' },
    { ts: outWindow, level: 'ERROR', line: '[out] b' },
  ];
  const sent = [];
  const s = createDigestScheduler({
    logService: { entries: () => entries },
    sendDigest: (d) => sent.push(d),
    clock: () => runDate,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });
  s.start();
  timer.fireLast(); // 06:00 발화 수동 트리거

  assert.equal(sent.length, 1);
  assert.equal(sent[0].total, 1); // 윈도우 내 1건만
  assert.deepEqual(sent[0].byLevel, { INFO: 1 });
  assert.deepEqual(sent[0].lines, ['[in] a']);
  assert.equal(sent[0].date, '2026-07-05');
  // 재예약 확인 — 발화 후 다음 06:00 예약이 다시 걸린다.
  assert.equal(timer.scheduled.length, 1);
});

test('sendDigest가 throw해도 스케줄러가 죽지 않고 재예약한다(격리)', () => {
  const timer = fakeTimer();
  const now = new Date(2026, 6, 5, 6, 0, 0, 0);
  const s = createDigestScheduler({
    logService: { entries: () => [] },
    sendDigest: () => { throw new Error('slack down'); },
    clock: () => now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });
  s.start();
  assert.doesNotThrow(() => timer.fireLast());
  assert.equal(timer.scheduled.length, 1); // 예외에도 재예약됨
});

test('stop()은 예약을 취소한다', () => {
  const timer = fakeTimer();
  const now = new Date(2026, 6, 5, 3, 0, 0, 0);
  const s = createDigestScheduler({
    logService: { entries: () => [] },
    sendDigest: () => {},
    clock: () => now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });
  s.start();
  const rec = timer.scheduled[0];
  s.stop();
  assert.equal(rec.cleared, true);
});

test('stop()은 예약 없이 호출해도 안전하다', () => {
  const timer = fakeTimer();
  const s = createDigestScheduler({
    logService: { entries: () => [] },
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    clock: () => new Date(2026, 6, 5, 3, 0, 0, 0),
  });
  assert.doesNotThrow(() => s.stop());
});
