// fakeModel 로그 seam(subscribeLogs/getLogsDigest) 모사 검증 — 서버 로그 API(step2)의 shape을
// in-memory로 흉내낸다. seed는 읽기 전용(원본 불변)이며 replay/조회 모두 record 복사본을 돌려준다.
import { describe, it, expect, vi } from 'vitest';
import { createFakeModel } from './fakeModel.js';

const LOGS = [
  { seq: 1, ts: 1000, level: 'INFO', message: 'boot', line: '[2026-07-06 09:00:00] [INFO] boot' },
  { seq: 2, ts: 2000, level: 'WARN', message: 'slow', line: '[2026-07-06 09:00:01] [WARN] slow' },
];

describe('createFakeModel logs (getLogsDigest / subscribeLogs)', () => {
  it('getLogsDigest returns seeded logs as { ok, items } copies without mutating the seed', async () => {
    const seed = { logs: LOGS.map((r) => ({ ...r })) };
    const fake = createFakeModel(seed);

    const r = await fake.getLogsDigest();
    expect(r.ok).toBe(true);
    expect(r.items).toEqual(LOGS);

    // 반환 item을 고쳐도 seed/다음 조회는 그대로다(읽기 전용 모사).
    r.items[0].message = 'tampered';
    expect((await fake.getLogsDigest()).items[0].message).toBe('boot');
    expect(seed.logs[0].message).toBe('boot');
  });

  it('getLogsDigest prefers the logsDigest seed over logs when given', async () => {
    const digest = [{ seq: 9, ts: 9000, level: 'ERROR', message: 'old', line: '[2026-07-05 12:00:00] [ERROR] old' }];
    const fake = createFakeModel({ logs: LOGS, logsDigest: digest });

    const r = await fake.getLogsDigest();
    expect(r.ok).toBe(true);
    expect(r.items).toEqual(digest);
  });

  it('subscribeLogs replays seeded logs to onLog, reports onStatus(true), and returns { connected, unsubscribe }', () => {
    const fake = createFakeModel({ logs: LOGS });
    const onLog = vi.fn();
    const onStatus = vi.fn();

    const sub = fake.subscribeLogs(onLog, onStatus);

    // 접속 시 seed 전량 replay(서버 replay 모사) + 즉시 연결됨.
    expect(onLog.mock.calls.map(([record]) => record.seq)).toEqual([1, 2]);
    expect(onStatus).toHaveBeenCalledWith(true);
    expect(sub.connected()).toBe(true);

    // replay된 record는 복사본 — 고쳐도 seed는 불변이라 다음 구독의 replay가 원본을 받는다.
    onLog.mock.calls[0][0].message = 'tampered';
    const again = vi.fn();
    fake.subscribeLogs(again);
    expect(again.mock.calls[0][0].message).toBe('boot');

    // unsubscribe는 등록된 핸들러를 제거한다(Set.delete — 첫 호출 true, 재호출 false).
    expect(sub.unsubscribe()).toBe(true);
    expect(sub.unsubscribe()).toBe(false);
  });

  it('subscribeLogs works with no seed and without onStatus', () => {
    const fake = createFakeModel();
    const onLog = vi.fn();

    const sub = fake.subscribeLogs(onLog);
    expect(onLog).not.toHaveBeenCalled();
    expect(sub.connected()).toBe(true);
    expect(sub.unsubscribe()).toBe(true);
  });
});
