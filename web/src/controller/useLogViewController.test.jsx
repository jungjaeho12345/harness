import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { AppContext } from '../app/context.js';
import { useLogViewController, boundedAppend, MAX_LINES } from './useLogViewController.js';
import { createFakeModel } from '../test/fakeModel.js';

// subscribeLogs가 반환하는 sub의 unsubscribe를 관찰할 수 있게 감싼 fakeModel.
function withSubSpy(seed) {
  const model = createFakeModel(seed);
  const subs = [];
  const orig = model.subscribeLogs.bind(model);
  model.subscribeLogs = (onLine, onStatus) => {
    const sub = orig(onLine, onStatus);
    const spied = { connected: sub.connected, unsubscribe: vi.fn(sub.unsubscribe) };
    subs.push(spied);
    return spied;
  };
  return { model, subs };
}

function setup(model) {
  const wrapper = ({ children }) => (
    <AppContext.Provider value={{ model, identity: { userId: 'kim', role: 'R' }, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      {children}
    </AppContext.Provider>
  );
  return renderHook(() => useLogViewController(), { wrapper });
}

const entry = (level, msg, ts = '2026-07-05 10:00:00') => ({
  ts, level, message: msg, line: `[${ts}] [${level}] ${msg}`,
});

describe('boundedAppend (순수 상한 헬퍼)', () => {
  it('상한 미만이면 그대로 append 한다', () => {
    expect(boundedAppend([1, 2], 3, 5)).toEqual([1, 2, 3]);
  });

  it('상한을 넘으면 오래된 앞 항목을 버리고 최근 N개만 유지한다', () => {
    let acc = [];
    for (let i = 0; i < 7; i += 1) acc = boundedAppend(acc, i, 3);
    expect(acc).toEqual([4, 5, 6]);
    expect(acc).toHaveLength(3);
  });

  it('입력 배열을 변형하지 않는다(새 배열 반환)', () => {
    const prev = [1, 2];
    const next = boundedAppend(prev, 3, 5);
    expect(prev).toEqual([1, 2]);
    expect(next).not.toBe(prev);
  });

  it('MAX_LINES 상수를 노출한다(무한 증가 금지)', () => {
    expect(MAX_LINES).toBeGreaterThan(0);
  });
});

describe('useLogViewController', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('구독 시 연결 상태가 live=true 가 된다', async () => {
    const { model } = withSubSpy();
    const { result } = setup(model);
    await waitFor(() => expect(result.current.live).toBe(true));
  });

  it('시드 백로그를 lines 로 재생하고 신규 라인을 실시간 append 한다', async () => {
    const { model } = withSubSpy({ logs: [entry('INFO', '부팅')] });
    const { result } = setup(model);
    await waitFor(() => expect(result.current.lines).toHaveLength(1));
    expect(result.current.lines[0].message).toBe('부팅');

    act(() => { model.logLine(entry('ERROR', '폭발')); });
    await waitFor(() => expect(result.current.lines).toHaveLength(2));
    expect(result.current.lines[1].message).toBe('폭발');
  });

  it('상한(MAX_LINES)을 넘으면 오래된 라인이 제거된다', async () => {
    const { model } = withSubSpy();
    const { result } = setup(model);
    await waitFor(() => expect(result.current.live).toBe(true));

    act(() => {
      for (let i = 0; i < MAX_LINES + 5; i += 1) model.logLine(entry('INFO', `m${i}`));
    });
    await waitFor(() => expect(result.current.lines).toHaveLength(MAX_LINES));
    // 가장 오래된 5개는 밀려나고 최신이 마지막에 남는다.
    expect(result.current.lines[MAX_LINES - 1].message).toBe(`m${MAX_LINES + 4}`);
    expect(result.current.lines[0].message).toBe('m5');
  });

  it('언마운트 시 unsubscribe 를 호출한다(누수 방지)', async () => {
    const { model, subs } = withSubSpy();
    const { unmount, result } = setup(model);
    await waitFor(() => expect(result.current.live).toBe(true));
    unmount();
    expect(subs[0].unsubscribe).toHaveBeenCalledTimes(1);
  });
});
