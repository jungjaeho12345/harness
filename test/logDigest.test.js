// 순수 다이제스트 코어 테스트 (26-realtime-log-viewer step2).
// 검증: digestWindow 경계(전날 06:00:00.000 ~ 당일 05:59:59.999), computeLogDigest의
//   경계 포함/제외·byLevel·total·lines(시각순)·결정성·입력 비변형·빈 윈도우·parseDateParam.
// 외부 의존 0·시각은 인자로만(순수). 로컬 Date 컴포넌트 기반이라 tz 무관 결정적.

import test from 'node:test';
import assert from 'node:assert/strict';
import { digestWindow, computeLogDigest, parseDateParam } from '../src/services/logDigest.js';

// 집계 실행일(06:00 트리거가 도는 그날): 2026-07-05 10:30 로컬.
const runDate = new Date(2026, 6, 5, 10, 30, 0);

// 순수 테스트용 엔트리 팩토리(step0 entries() shape).
function entry(ts, level, message) {
  return { ts, level, message, line: `[line] [${level}] ${message}` };
}

test('digestWindow: 전날 06:00:00.000 ~ 당일 05:59:59.999', () => {
  const { start, end } = digestWindow(runDate);
  assert.equal(start, new Date(2026, 6, 4, 6, 0, 0, 0).getTime());
  assert.equal(end, new Date(2026, 6, 5, 5, 59, 59, 999).getTime());
});

test('digestWindow: 월/년 경계에서도 하루 뺀 06:00을 준다', () => {
  // runDate = 2026-01-01 → 전날 = 2025-12-31 06:00:00.
  const { start, end } = digestWindow(new Date(2026, 0, 1, 8, 0, 0));
  assert.equal(start, new Date(2025, 11, 31, 6, 0, 0, 0).getTime());
  assert.equal(end, new Date(2026, 0, 1, 5, 59, 59, 999).getTime());
});

test('computeLogDigest: 경계 포함/제외(전날06:00포함·05:59:59제외, 당일05:59:59포함·06:00:00제외)', () => {
  const before = new Date(2026, 6, 4, 5, 59, 59, 0).getTime();  // 전날 05:59:59 → 제외
  const atStart = new Date(2026, 6, 4, 6, 0, 0, 0).getTime();   // 전날 06:00:00 → 포함
  const atEnd = new Date(2026, 6, 5, 5, 59, 59, 999).getTime(); // 당일 05:59:59.999 → 포함
  const afterEnd = new Date(2026, 6, 5, 6, 0, 0, 0).getTime();  // 당일 06:00:00 → 제외

  const digest = computeLogDigest([
    entry(before, 'INFO', 'before'),
    entry(atStart, 'INFO', 'at-start'),
    entry(atEnd, 'WARN', 'at-end'),
    entry(afterEnd, 'ERROR', 'after-end'),
  ], runDate);

  assert.equal(digest.total, 2);
  assert.deepEqual(digest.byLevel, { INFO: 1, WARN: 1 });
  assert.equal(digest.lines.length, 2);
  assert.equal(digest.date, '2026-07-05');
  assert.equal(digest.window.start, new Date(2026, 6, 4, 6, 0, 0, 0).getTime());
  assert.equal(digest.window.end, new Date(2026, 6, 5, 5, 59, 59, 999).getTime());
});

test('computeLogDigest: lines는 시각 오름차순, 입력을 변형하지 않는다(결정적)', () => {
  const atStart = new Date(2026, 6, 4, 6, 0, 0, 0).getTime();
  const atEnd = new Date(2026, 6, 5, 5, 0, 0, 0).getTime();
  // 일부러 시각 역순으로 넣는다 — 코어가 정렬하되 입력 배열은 건드리지 않아야 한다.
  const input = [entry(atEnd, 'WARN', 'later'), entry(atStart, 'INFO', 'earlier')];
  const snapshot = JSON.parse(JSON.stringify(input));

  const a = computeLogDigest(input, runDate);
  const b = computeLogDigest(input, runDate);

  assert.deepEqual(a, b);                        // 결정성
  assert.deepEqual(input, snapshot);             // 입력 비변형(append-only 불변)
  assert.deepEqual(a.lines, ['[line] [INFO] earlier', '[line] [WARN] later']); // 시각순
});

test('computeLogDigest: 빈 윈도우는 total 0·byLevel {}·lines []', () => {
  const digest = computeLogDigest([], runDate);
  assert.equal(digest.total, 0);
  assert.deepEqual(digest.byLevel, {});
  assert.deepEqual(digest.lines, []);
});

test('computeLogDigest: 여러 날이 섞여도 대상 윈도우만 집계한다', () => {
  const twoDaysAgo = new Date(2026, 6, 3, 12, 0, 0).getTime(); // 윈도우 밖(과거)
  const yesterdayNoon = new Date(2026, 6, 4, 12, 0, 0).getTime(); // 윈도우 안
  const todayEarly = new Date(2026, 6, 5, 3, 0, 0).getTime(); // 윈도우 안(당일 05:59 이전)
  const tomorrow = new Date(2026, 6, 6, 12, 0, 0).getTime(); // 윈도우 밖(미래)

  const digest = computeLogDigest([
    entry(twoDaysAgo, 'INFO', 'a'),
    entry(yesterdayNoon, 'INFO', 'b'),
    entry(todayEarly, 'ERROR', 'c'),
    entry(tomorrow, 'WARN', 'd'),
  ], runDate);

  assert.equal(digest.total, 2);
  assert.deepEqual(digest.byLevel, { INFO: 1, ERROR: 1 });
});

test('parseDateParam: 유효 YYYY-MM-DD는 로컬 Date, 형식/범위 오류는 null', () => {
  const d = parseDateParam('2026-07-05');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 6);
  assert.equal(d.getDate(), 5);
  assert.equal(parseDateParam('foo'), null);
  assert.equal(parseDateParam('2026-13-01'), null); // 잘못된 월
  assert.equal(parseDateParam('2026-02-30'), null); // 존재하지 않는 날
  assert.equal(parseDateParam('2026-7-5'), null);   // zero-pad 아님
});
