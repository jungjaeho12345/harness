import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { ListPage } from './ListPage.jsx';
import { createFakeModel } from '../test/fakeModel.js';

function setup(seed, identity = { userId: 'kim', name: '김기자', role: 'D', department: '정치' }) {
  const model = createFakeModel(seed);
  const navigate = vi.fn();
  const utils = render(
    <AppContext.Provider value={{ model, identity, navigate, replace: vi.fn(), setSession: vi.fn() }}>
      <ListPage />
    </AppContext.Provider>,
  );
  return { model, navigate, ...utils };
}

const rds = (n) => Array.from({ length: n }, (_, i) => ({
  articleId: `AKR${i}`, title: `t${i}`, status: 'RDS', author: 'kim',
  createdAt: '2026-06-14T03:09:06Z', editedAt: '2026-06-14T04:00:00Z', lockYN: 'N',
}));

const bodyRows = (c) => c.querySelectorAll('tbody tr');

describe('ListPage', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('4개 메뉴와 실시간 상태바를 보여준다', () => {
    setup({ articles: [] });
    for (const m of ['데스크 미송고', '부서별 작성', '부서별 송고', '개인별 수정']) {
      expect(screen.getByRole('button', { name: m })).toBeInTheDocument();
    }
    expect(screen.getByTestId('live-status')).toBeInTheDocument();
  });

  it('기본(데스크 미송고)에서 10개씩 페이징한다', async () => {
    const { container } = setup({ articles: rds(25) });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(10));
    expect(screen.getByTestId('pager')).toHaveTextContent('1 / 3');
  });

  it('작성시간을 YYYY-MM-DD HH:mm로 표시한다', async () => {
    const { container } = setup({ articles: rds(1) });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    expect(container).toHaveTextContent('2026-06-14 03:09');
  });

  it('상태 배지에 UI_GUIDE 색(RDS=회색)을 적용한다', async () => {
    setup({ articles: rds(1) });
    const badge = await screen.findByTestId('status-badge');
    expect(badge).toHaveTextContent('RDS');
    expect(badge.style.backgroundColor).toBe('rgb(232, 232, 232)'); // #e8e8e8
  });

  it('행을 클릭하면 상세보기 새 창(720×800)을 연다', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({
      document: { write: vi.fn(), close: vi.fn() },
    });
    const { container } = setup({ articles: rds(1) });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    await userEvent.click(bodyRows(container)[0]);
    expect(open).toHaveBeenCalledWith('', '_blank', expect.stringContaining('width=720'));
  });

  it('실시간 SSE 신호가 오면 목록을 재조회한다', async () => {
    const { model, container } = setup({ articles: rds(1) });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    await act_save(model);
    await waitFor(() => expect(bodyRows(container)).toHaveLength(2));
  });

  it('우클릭 삭제요청(DPS+D/Z) → approveDelete를 호출한다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model, container } = setup({ articles: [{ articleId: 'AKR9', title: 't', status: 'DPS', lockYN: 'N' }] });
    const apply = vi.spyOn(model, 'applyAction');

    await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '삭제요청' }));
    expect(apply).toHaveBeenCalledWith('AKR9', 'approveDelete');
  });

  it('잠긴 행의 우클릭 Lock해제(D/Z) → force-unlock을 호출한다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model, container } = setup({ articles: [{ articleId: 'AKR5', title: 't', status: 'RDS', lockYN: 'Y' }] });
    const force = vi.spyOn(model, 'forceUnlockArticle');

    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Lock해제' }));
    expect(force).toHaveBeenCalledWith('AKR5');
  });

  it('우클릭 이력보기 → 새 창(720×800)을 동기 오픈하고 이력을 write한다', async () => {
    const write = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue({ document: { write, close: vi.fn() } });
    const histories = [
      { articleId: 'AKR0', eventType: 'create', actorUserId: 'kim', actorRole: 'R', toStatus: 'RDS' },
    ];
    const { container } = setup({ articles: rds(1), histories });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '이력보기' }));

    // 팝업 차단 회피 — window.open이 동기적으로 먼저 호출된다.
    expect(open).toHaveBeenCalledWith('', '_blank', expect.stringContaining('width=720'));
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(write.mock.calls[0][0]).toContain('create');
    expect(write.mock.calls[0][0]).toContain('kim');
  });

  it('우클릭 후속기사작성 → 기사작성 페이지로 이동(followUpArticle)', async () => {
    const { navigate, container } = setup({ articles: [{ articleId: 'AKR3', title: 't', status: 'DPS', lockYN: 'N' }] });
    await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '후속기사작성' }));
    expect(navigate).toHaveBeenCalledWith('writer.do', {});
  });

  it('우클릭 계속기사작성 → 기사작성 페이지로 이동(continueArticle)', async () => {
    const { navigate, container } = setup({ articles: [{ articleId: 'AKR4', title: 't', status: 'DPS', lockYN: 'N' }] });
    await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '계속기사작성' }));
    expect(navigate).toHaveBeenCalledWith('writer.do', {});
  });

  it('우클릭 재송(DPS+D) → confirm 후 applyAction(id, send)을 호출한다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model, container } = setup({ articles: [{ articleId: 'AKR8', title: 't', status: 'DPS', lockYN: 'N' }] });
    const apply = vi.spyOn(model, 'applyAction');

    await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '재송' }));
    expect(apply).toHaveBeenCalledWith('AKR8', 'send');
  });

  it('헤더 우클릭 시 컬럼 설정 모달이 열린다', async () => {
    const { container } = setup({ articles: rds(1) });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    fireEvent.contextMenu(container.querySelector('thead tr'));
    expect(screen.getByRole('dialog', { name: '컬럼 설정' })).toBeInTheDocument();
  });
});

// 모델 변경 신호를 발생시켜 SSE 무효화를 흉내낸다(act로 감싼다).
async function act_save(model) {
  const { act } = await import('@testing-library/react');
  await act(async () => { model.saveArticle({ title: 'new', status: 'RDS' }); });
}
