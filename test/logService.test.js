import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogService, formatTimestamp, LOG_LEVELS } from '../src/services/logService.js';

// 결정적 테스트를 위한 주입 시계 — now()를 직접 제어한다(Date.now() 미사용).
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
}

const KST_OFFSET_MIN = 540; // UTC+9
const KST_OFFSET_MS = KST_OFFSET_MIN * 60 * 1000;

// KST 벽시계 시각 → epoch ms (테스트에서 경계 ms를 직접 계산한다).
function kstMs(y, mo, d, h, mi, s = 0, ms = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - KST_OFFSET_MS;
}

test('LOG_LEVELS: log4j 스타일 서열(낮음→높음)로 고정되어 있다', () => {
  assert.deepEqual([...LOG_LEVELS], ['DEBUG', 'INFO', 'WARN', 'ERROR']);
  assert.ok(Object.isFrozen(LOG_LEVELS));
});

test('info: record 1건이 버퍼에 쌓이고 line이 LOGS.md 포맷에 매치한다', () => {
  const clock = makeClock(kstMs(2026, 7, 6, 9, 30, 15));
  const svc = createLogService({ now: clock.now });
  const rec = svc.info('x');
  const snap = svc.snapshot();
  assert.equal(snap.length, 1);
  assert.match(rec.line, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[INFO\] x$/);
  assert.equal(rec.line, '[2026-07-06 09:30:15] [INFO] x');
});

test('formatTimestamp: 고정 ts + tzOffsetMinutes:540에서 기대 문자열(0-pad 포함)을 낸다', () => {
  assert.equal(formatTimestamp(kstMs(2026, 7, 6, 6, 0, 0), KST_OFFSET_MIN), '2026-07-06 06:00:00');
  assert.equal(formatTimestamp(kstMs(2026, 1, 2, 3, 4, 5), KST_OFFSET_MIN), '2026-01-02 03:04:05');
  // 오프셋 0(UTC)에서도 UTC getter 기반으로 동일 규칙이 적용된다.
  assert.equal(formatTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5), 0), '2026-01-02 03:04:05');
});

test('레벨 서열: debug/info/warn/error 래퍼가 올바른 level을 record에 넣는다', () => {
  const clock = makeClock();
  const svc = createLogService({ now: clock.now });
  assert.equal(svc.debug('d').level, 'DEBUG');
  assert.equal(svc.info('i').level, 'INFO');
  assert.equal(svc.warn('w').level, 'WARN');
  assert.equal(svc.error('e').level, 'ERROR');
});

test('log: level은 대문자화·검증하고 미지값은 INFO로 강제한다', () => {
  const clock = makeClock();
  const svc = createLogService({ now: clock.now });
  assert.equal(svc.log('warn', 'x').level, 'WARN');
  assert.equal(svc.log('FATAL', 'x').level, 'INFO');
  assert.equal(svc.log(undefined, 'x').level, 'INFO');
});

test('log: 비문자열 message는 String(...)으로 강제한다', () => {
  const clock = makeClock();
  const svc = createLogService({ now: clock.now });
  assert.equal(svc.info(42).message, '42');
  assert.equal(svc.info(null).message, 'null');
});

test('seq: 1부터 단조 증가한다', () => {
  const clock = makeClock();
  const svc = createLogService({ now: clock.now });
  const seqs = [svc.info('a'), svc.info('b'), svc.info('c')].map((r) => r.seq);
  assert.deepEqual(seqs, [1, 2, 3]);
});

test('record shape: seq/ts/level/message/line 필드를 가진다', () => {
  const clock = makeClock(kstMs(2026, 7, 6, 12, 0, 0));
  const svc = createLogService({ now: clock.now });
  const rec = svc.info('hello');
  assert.deepEqual(rec, {
    seq: 1,
    ts: kstMs(2026, 7, 6, 12, 0, 0),
    level: 'INFO',
    message: 'hello',
    line: '[2026-07-06 12:00:00] [INFO] hello',
  });
});

test('링 버퍼: cap 초과 시 가장 오래된 record부터 evict하고 길이는 cap을 넘지 않는다', () => {
  const clock = makeClock();
  const svc = createLogService({ now: clock.now, cap: 3 });
  for (let i = 1; i <= 5; i++) svc.info(`m${i}`);
  const snap = svc.snapshot();
  assert.equal(svc.size(), 3);
  assert.deepEqual(snap.map((r) => r.seq), [3, 4, 5], '최신 3건만 유지(오래된→최신)');
  // evict 후에도 seq는 재사용하지 않는다.
  assert.equal(svc.info('m6').seq, 6);
  assert.equal(svc.size(), 3);
});

test('snapshot: 버퍼 복사본을 반환한다 (반환 배열 변형이 내부 버퍼에 영향 없음)', () => {
  const clock = makeClock();
  const svc = createLogService({ now: clock.now });
  svc.info('a');
  const snap = svc.snapshot();
  snap.length = 0;
  assert.equal(svc.size(), 1);
});

test('subscribe: 기록 시 listener가 record로 호출되고 unsubscribe 후에는 호출되지 않는다', () => {
  const clock = makeClock();
  const svc = createLogService({ now: clock.now });
  const received = [];
  const unsubscribe = svc.subscribe((rec) => received.push(rec));
  const rec = svc.info('a');
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], rec);
  unsubscribe();
  svc.info('b');
  assert.equal(received.length, 1, 'unsubscribe 후에는 호출되지 않는다');
});

test('subscriberCount: 구독 2건이면 2, 각 unsubscribe 후 감소해 0으로 복귀한다', () => {
  const svc = createLogService();
  const un1 = svc.subscribe(() => {});
  const un2 = svc.subscribe(() => {});
  assert.equal(svc.subscriberCount(), 2);
  un1();
  assert.equal(svc.subscriberCount(), 1);
  un2();
  assert.equal(svc.subscriberCount(), 0);
  un2(); // 중복 해제는 무해하다
  assert.equal(svc.subscriberCount(), 0);
});

test('digest: [전날 06:00, 당일 06:00) 반열림 창(KST)만 반환한다', () => {
  const clock = makeClock();
  const svc = createLogService({ now: clock.now, tzOffsetMinutes: KST_OFFSET_MIN });

  // D = 2026-07-06 (KST). 창 = [2026-07-05 06:00:00.000, 2026-07-06 06:00:00.000)
  const points = [
    { ts: kstMs(2026, 7, 5, 5, 59, 0), msg: 'D-1 05:59', included: false },
    { ts: kstMs(2026, 7, 5, 6, 0, 0), msg: 'D-1 06:00', included: true },
    { ts: kstMs(2026, 7, 5, 12, 0, 0), msg: 'D-1 12:00', included: true },
    { ts: kstMs(2026, 7, 6, 5, 59, 59, 999), msg: 'D 05:59:59.999', included: true },
    { ts: kstMs(2026, 7, 6, 6, 0, 0), msg: 'D 06:00', included: false },
  ];
  for (const p of points) {
    clock.set(p.ts);
    svc.info(p.msg);
  }

  const result = svc.digest(kstMs(2026, 7, 6, 6, 0, 0));
  assert.deepEqual(
    result.map((r) => r.message),
    points.filter((p) => p.included).map((p) => p.msg),
  );
});

test('digest: 호출 시각이 06:00 이후 한낮이어도 직전 06:00을 경계로 삼는다', () => {
  const clock = makeClock();
  const svc = createLogService({ now: clock.now, tzOffsetMinutes: KST_OFFSET_MIN });
  clock.set(kstMs(2026, 7, 5, 7, 0, 0));
  svc.info('창 안 (D-1 07:00)');
  clock.set(kstMs(2026, 7, 6, 7, 0, 0));
  svc.info('경계 이후 (D 07:00)');

  // D일 14:30에 pull → 경계는 D일 06:00, 창은 [D-1 06:00, D 06:00)
  const result = svc.digest(kstMs(2026, 7, 6, 14, 30, 0));
  assert.deepEqual(result.map((r) => r.message), ['창 안 (D-1 07:00)']);
});

test('digest: atMs 생략 시 주입된 now() 기준으로 계산한다', () => {
  const clock = makeClock();
  const svc = createLogService({ now: clock.now, tzOffsetMinutes: KST_OFFSET_MIN });
  clock.set(kstMs(2026, 7, 5, 12, 0, 0));
  svc.info('전날 정오');
  clock.set(kstMs(2026, 7, 6, 6, 0, 0));
  assert.deepEqual(svc.digest().map((r) => r.message), ['전날 정오']);
});
