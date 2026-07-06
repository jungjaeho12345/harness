import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppContext } from '../app/context.js';
import { LogsPage } from './LogsPage.jsx';
import { MAX_LINES } from '../controller/useLogsController.js';
import { createFakeModel } from '../test/fakeModel.js';

// 서버 logService record 모사 — line 포맷의 단일 출처는 서버(클라는 표시만).
function rec(seq, level = 'INFO', message = `msg-${seq}`) {
  return {
    seq,
    ts: 1750000000000 + seq,
    level,
    message,
    line: `[2026-07-06 09:00:00] [${level}] ${message}`,
  };
}

function setup(seed, identity = { userId: 'boss', role: 'Z' }) {
  const model = createFakeModel(seed);
  const utils = render(
    <AppContext.Provider value={{ model, identity, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      <LogsPage />
    </AppContext.Provider>,
  );
  return { model, ...utils };
}

describe('LogsPage (logs.do, Z 전용 실시간 로그 뷰어)', () => {
  it('접속 replay된 시드 로그를 라인으로 표시한다 (record.line 그대로, 레벨별 클래스)', () => {
    setup({ logs: [rec(1, 'INFO', 'hello'), rec(2, 'ERROR', 'boom')] });

    const info = screen.getByText('[2026-07-06 09:00:00] [INFO] hello');
    const error = screen.getByText('[2026-07-06 09:00:00] [ERROR] boom');
    expect(info).toHaveClass('yh-log__line', 'yh-log__line--info');
    expect(error).toHaveClass('yh-log__line', 'yh-log__line--error');
  });

  it('subscribeLogs onStatus(true) → 연결 상태바가 연결됨으로 표시된다', () => {
    setup({ logs: [] });
    expect(screen.getByTestId('live-status')).toHaveClass('yh-live--on');
  });

  it('로그가 없으면 대기 안내를 보여준다', () => {
    setup({ logs: [] });
    expect(screen.getByText(/로그 없음/)).toBeInTheDocument();
  });

  it('MAX_LINES 링 캡 — 초과분 replay 시 오래된 라인부터 버려진다', () => {
    const seed = [];
    for (let i = 1; i <= MAX_LINES + 5; i += 1) seed.push(rec(i));
    const { container } = setup({ logs: seed });

    const rendered = container.querySelectorAll('.yh-log__line');
    expect(rendered.length).toBe(MAX_LINES);
    // 가장 오래된 5건은 버려지고, 가장 최신 건은 남는다.
    expect(screen.queryByText(rec(5).line)).toBeNull();
    expect(screen.getByText(rec(6).line)).toBeInTheDocument();
    expect(screen.getByText(rec(MAX_LINES + 5).line)).toBeInTheDocument();
  });

  it('seq 중복 제거 — 같은 seq record가 중복 replay돼도 한 번만 렌더한다', () => {
    const dup = rec(1, 'INFO', 'once');
    const { container } = setup({ logs: [dup, { ...dup }, rec(2, 'WARN', 'next')] });

    expect(screen.getAllByText(dup.line).length).toBe(1);
    expect(container.querySelectorAll('.yh-log__line').length).toBe(2);
  });
});
