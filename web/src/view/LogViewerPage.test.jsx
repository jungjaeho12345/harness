import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { LogViewerPage } from './LogViewerPage.jsx';
import { createFakeModel } from '../test/fakeModel.js';

const entry = (level, msg, ts = '2026-07-05 10:00:00') => ({
  ts, level, message: msg, line: `[${ts}] [${level}] ${msg}`,
});

function setup(seed) {
  const model = createFakeModel(seed);
  const utils = render(
    <AppContext.Provider value={{ model, identity: { userId: 'kim', role: 'R' }, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      <LogViewerPage />
    </AppContext.Provider>,
  );
  return { model, ...utils };
}

describe('LogViewerPage (실시간 로그 뷰어)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('시드 백로그 라인을 포맷 문자열(line)로 렌더한다', async () => {
    setup({ logs: [entry('INFO', '서버 시작')] });
    await waitFor(() => expect(screen.getByText('[2026-07-05 10:00:00] [INFO] 서버 시작')).toBeInTheDocument());
  });

  it('연결 상태 배지를 표시한다(연결됨)', async () => {
    setup({ logs: [] });
    await waitFor(() => expect(screen.getByTestId('log-connection')).toHaveTextContent('연결됨'));
  });

  it('로그가 없으면 빈 상태 안내를 보여준다', async () => {
    setup({ logs: [] });
    await waitFor(() => expect(screen.getByTestId('log-empty')).toHaveTextContent('아직 로그가 없습니다'));
  });

  it('신규 라인이 실시간으로 append 된다', async () => {
    const { model } = setup({ logs: [] });
    await waitFor(() => expect(screen.getByTestId('log-empty')).toBeInTheDocument());
    act(() => { model.logLine(entry('WARN', '지연 발생')); });
    await waitFor(() => expect(screen.getByText('[2026-07-05 10:00:00] [WARN] 지연 발생')).toBeInTheDocument());
  });

  it('레벨 필터로 특정 레벨 라인을 표시에서 숨긴다', async () => {
    setup({ logs: [entry('INFO', '정보성'), entry('ERROR', '치명적')] });
    await waitFor(() => expect(screen.getByText(/정보성/)).toBeInTheDocument());

    // INFO 필터 체크 해제 → INFO 라인은 사라지고 ERROR 라인은 남는다.
    await userEvent.click(screen.getByTestId('log-filter-INFO'));
    await waitFor(() => expect(screen.queryByText(/정보성/)).toBeNull());
    expect(screen.getByText(/치명적/)).toBeInTheDocument();
  });

  it('로그 메시지를 텍스트 노드로 렌더한다(HTML 주입 방지, dangerouslySetInnerHTML 미사용)', async () => {
    const { container } = setup({ logs: [entry('INFO', '<b>주입</b>')] });
    await waitFor(() => expect(screen.getByText(/<b>주입<\/b>/)).toBeInTheDocument());
    // 실제 <b> 엘리먼트로 파싱되지 않고 리터럴 텍스트로 남아야 한다(XSS 표면 차단).
    expect(container.querySelector('b')).toBeNull();
  });
});
