import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLogService, formatLogLine } from '../src/services/logService.js';

// 결정적 테스트를 위한 주입 시계 — clock()이 고정 Date/epoch를 반환한다(Date.now() 미사용).
function makeClock(start) {
  let t = start;
  return { clock: () => t, set: (ms) => { t = ms; }, advance: (ms) => { t += ms; } };
}

// 로컬 Date 컴포넌트로 생성 → 실행 머신 타임존과 무관하게 결정적.
const T_START = new Date(2026, 6, 5, 6, 0, 0).getTime(); // 2026-07-05 06:00:00 local

test('formatLogLine: 고정 시각을 정확한 포맷으로 만든다(zero-pad 포함)', () => {
  const ts = new Date(2026, 6, 5, 6, 0, 0).getTime();
  assert.equal(
    formatLogLine({ ts, level: 'INFO', message: '서버 시작' }),
    '[2026-07-05 06:00:00] [INFO] 서버 시작',
  );
});

test('formatLogLine: 한 자리 월/일/시/분/초를 2자리로 zero-pad 한다', () => {
  const ts = new Date(2026, 0, 3, 4, 5, 9).getTime(); // 2026-01-03 04:05:09
  assert.equal(
    formatLogLine({ ts, level: 'WARN', message: 'x' }),
    '[2026-01-03 04:05:09] [WARN] x',
  );
});

test('formatLogLine: level은 대문자화, message는 문자열로 강제한다', () => {
  const ts = new Date(2026, 6, 5, 6, 0, 0).getTime();
  assert.equal(
    formatLogLine({ ts, level: 'info', message: 42 }),
    '[2026-07-05 06:00:00] [INFO] 42',
  );
});

test('formatLogLine: 이상한 level/message에도 throw하지 않는다', () => {
  const ts = new Date(2026, 6, 5, 6, 0, 0).getTime();
  assert.doesNotThrow(() => formatLogLine({ ts, level: undefined, message: undefined }));
  assert.doesNotThrow(() => formatLogLine({ ts, level: null, message: { a: 1 } }));
});

test('log: 엔트리를 버퍼에 쌓고 entries()가 시각순 복사본을 돌려준다', () => {
  const { clock, advance } = makeClock(T_START);
  const svc = createLogService({ clock });
  svc.log('INFO', 'a');
  advance(1000);
  svc.log('WARN', 'b');

  const list = svc.entries();
  assert.equal(list.length, 2);
  assert.equal(list[0].message, 'a');
  assert.equal(list[1].message, 'b');
  assert.equal(list[0].ts < list[1].ts, true, '시각 오름차순');
  assert.equal(list[0].line, '[2026-07-05 06:00:00] [INFO] a');
});

test('log: 엔트리 구조는 { ts, level, message, line }', () => {
  const { clock } = makeClock(T_START);
  const svc = createLogService({ clock });
  const e = svc.log('error', '문제');
  assert.equal(e.ts, T_START);
  assert.equal(e.level, 'ERROR');
  assert.equal(e.message, '문제');
  assert.equal(e.line, '[2026-07-05 06:00:00] [ERROR] 문제');
});

test('entries(): 반환 배열을 변형해도 내부 버퍼가 오염되지 않는다(복사본)', () => {
  const { clock } = makeClock(T_START);
  const svc = createLogService({ clock });
  svc.log('INFO', 'a');
  const first = svc.entries();
  first.push({ ts: 0, level: 'X', message: 'y', line: 'z' });
  first[0].message = '변형됨';
  const second = svc.entries();
  assert.equal(second.length, 1, '외부 push가 내부에 반영되지 않음');
  assert.equal(second[0].message, 'a', '외부 필드 변형이 내부에 반영되지 않음');
});

test('capacity: 초과 시 가장 오래된 엔트리부터 제거(FIFO)', () => {
  const { clock, advance } = makeClock(T_START);
  const svc = createLogService({ capacity: 2, clock });
  svc.log('INFO', 'a');
  advance(1000);
  svc.log('INFO', 'b');
  advance(1000);
  svc.log('INFO', 'c');

  const list = svc.entries();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((e) => e.message), ['b', 'c'], '가장 오래된 a가 제거됨');
});

test('clock 주입으로 타임스탬프가 결정적이다', () => {
  const { clock, set } = makeClock(T_START);
  const svc = createLogService({ clock });
  const e1 = svc.log('INFO', 'a');
  set(new Date(2026, 6, 5, 7, 30, 15).getTime());
  const e2 = svc.log('INFO', 'b');
  assert.equal(e1.line, '[2026-07-05 06:00:00] [INFO] a');
  assert.equal(e2.line, '[2026-07-05 07:30:15] [INFO] b');
});

test('subscribe/unsubscribe: log 이벤트를 정확히 전달/해제한다', () => {
  const { clock } = makeClock(T_START);
  const svc = createLogService({ clock });
  const received = [];
  const unsubscribe = svc.subscribe((e) => received.push(e));

  svc.log('INFO', 'first');
  assert.equal(received.length, 1);
  assert.equal(received[0].message, 'first');

  unsubscribe();
  svc.log('INFO', 'second');
  assert.equal(received.length, 1, '구독 해제 후에는 더 이상 받지 않음');
});

test('subscribe: 여러 구독자가 각각 엔트리를 받는다(setMaxListeners 경고 없음)', () => {
  const { clock } = makeClock(T_START);
  const svc = createLogService({ clock });
  const a = [];
  const b = [];
  svc.subscribe((e) => a.push(e));
  svc.subscribe((e) => b.push(e));
  svc.log('INFO', 'x');
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});

test('emitter 주입: 외부 EventEmitter로 방출한다', () => {
  const { clock } = makeClock(T_START);
  const emitter = new EventEmitter();
  const svc = createLogService({ clock, emitter });
  const received = [];
  emitter.on('log', (e) => received.push(e));
  svc.log('INFO', 'x');
  assert.equal(received.length, 1);
  assert.equal(received[0].message, 'x');
});

test('entries({ since }): 경계 시각으로 올바르게 필터한다', () => {
  const { clock, set } = makeClock(T_START);
  const svc = createLogService({ clock });
  svc.log('INFO', 'a'); // ts = T_START
  set(T_START + 1000);
  svc.log('INFO', 'b'); // ts = T_START + 1000
  set(T_START + 2000);
  svc.log('INFO', 'c'); // ts = T_START + 2000

  const from = svc.entries({ since: T_START + 1000 });
  assert.deepEqual(from.map((e) => e.message), ['b', 'c'], 'since(포함) 이후만');
});

test('log: 이상한 level/message에도 throw하지 않고 흡수한다', () => {
  const { clock } = makeClock(T_START);
  const svc = createLogService({ clock });
  assert.doesNotThrow(() => svc.log(undefined, undefined));
  assert.doesNotThrow(() => svc.log(null, { a: 1 }));
  const list = svc.entries();
  assert.equal(list.length, 2, '흡수하되 엔트리는 남긴다');
});
