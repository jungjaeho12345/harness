import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { RcvMgmtPage } from './RcvMgmtPage.jsx';
import { createFakeModel } from '../test/fakeModel.js';

// prepare(model): render 전에 model 메서드를 mock할 때 쓴다(마운트 시 조회 실패 재현 등).
function setup(seed, identity = { userId: 'boss', role: 'Z' }, prepare) {
  const model = createFakeModel(seed);
  prepare?.(model);
  const utils = render(
    <AppContext.Provider value={{ model, identity, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      <RcvMgmtPage />
    </AppContext.Provider>,
  );
  return { model, ...utils };
}

describe('RcvMgmtPage (Z 전용 CRUD)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('마운트 시 수신 설정 목록을 조회한다', async () => {
    setup({ receiverConfigs: [{ id: 1, sourceId: 'AP', type: 'API', name: '연합', host: '', port: '', active: 'Y' }] });
    await waitFor(() => expect(screen.getByText('AP')).toBeInTheDocument());
  });

  it('설정을 생성하면 createReceiverConfig를 호출한다', async () => {
    const { model } = setup({ receiverConfigs: [] });
    const create = vi.spyOn(model, 'createReceiverConfig');

    await userEvent.type(screen.getByLabelText('소스아이디'), 'NEWS1');
    await userEvent.type(screen.getByLabelText('이름'), '소스');
    await userEvent.click(screen.getByRole('button', { name: '설정 생성' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'NEWS1', name: '소스' })));
  });

  it('생성 폼에 사용자명/비밀번호/API키/활성 입력이 있고 createReceiverConfig로 전달한다 (#5)', async () => {
    const { model } = setup({ receiverConfigs: [] });
    const create = vi.spyOn(model, 'createReceiverConfig');

    await userEvent.type(screen.getByLabelText('소스아이디'), 'NEWS1');
    await userEvent.type(screen.getByLabelText('사용자명'), 'u1');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'p1');
    await userEvent.type(screen.getByLabelText('API 키'), 'k1');
    await userEvent.selectOptions(screen.getByLabelText('활성'), 'N');
    await userEvent.click(screen.getByRole('button', { name: '설정 생성' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'NEWS1', username: 'u1', password: 'p1', apiKey: 'k1', active: 'N',
    })));
  });

  it('삭제하면 설정 행만 deleteReceiverConfig로 지운다(수집 기사 비파괴)', async () => {
    const { model } = setup({ receiverConfigs: [{ id: 7, sourceId: 'AP', type: 'FTP', name: 'x', host: '', port: '', active: 'Y' }] });
    const del = vi.spyOn(model, 'deleteReceiverConfig');
    await waitFor(() => expect(screen.getByText('AP')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '삭제' }));
    expect(del).toHaveBeenCalledWith(7);
  });

  // --- step8: 실패 인라인 표시(role="alert" · data-testid="rcv-error") ---

  it('생성이 거부되면 rcv-error에 권한 문구를 띄우고 입력값을 유지한다', async () => {
    const { model } = setup({ receiverConfigs: [] });
    vi.spyOn(model, 'createReceiverConfig').mockResolvedValue({ ok: false, reason: 'forbidden' });

    await userEvent.type(screen.getByLabelText('소스아이디'), 'NEWS1');
    await userEvent.click(screen.getByRole('button', { name: '설정 생성' }));

    await waitFor(() => expect(screen.getByTestId('rcv-error')).toHaveTextContent('권한'));
    expect(screen.getByTestId('rcv-error')).toHaveAttribute('role', 'alert');
    // 실패 시 폼을 비우지 않는다 — 고쳐서 재제출할 수 있어야 한다.
    expect(screen.getByLabelText('소스아이디')).toHaveValue('NEWS1');
  });

  it('쓰기 실패 메시지는 컨트롤러 내부 재조회가 성공해도 남는다(타이밍 회귀 가드)', async () => {
    // createConfig는 실패, 컨트롤러가 내부적으로 부르는 목록 조회는 성공({ ok:true, items }) —
    // 성공한 내부 재조회가 쓰기 실패 메시지를 지우면 안 된다.
    const { model } = setup({ receiverConfigs: [{ id: 1, sourceId: 'AP', type: 'API', name: '연합', host: '', port: '', active: 'Y' }] });
    vi.spyOn(model, 'createReceiverConfig').mockResolvedValue({ ok: false, reason: 'forbidden' });
    await waitFor(() => expect(screen.getByText('AP')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '설정 생성' }));

    expect(await screen.findByTestId('rcv-error')).toHaveTextContent('권한');
    // 내부 재조회는 성공했고(목록 표시 유지) 실패 메시지는 그대로 남는다.
    expect(screen.getByText('AP')).toBeInTheDocument();
    expect(screen.getByTestId('rcv-error')).toHaveTextContent('권한');
  });

  it('삭제 실패 사유도 같은 자리에 표시한다', async () => {
    const { model } = setup({ receiverConfigs: [{ id: 7, sourceId: 'AP', type: 'FTP', name: 'x', host: '', port: '', active: 'Y' }] });
    vi.spyOn(model, 'deleteReceiverConfig').mockResolvedValue({ ok: false, reason: 'internal-error' });
    await waitFor(() => expect(screen.getByText('AP')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '삭제' }));

    await waitFor(() => expect(screen.getByTestId('rcv-error')).toHaveTextContent('서버 오류'));
  });

  it('진입 시 목록 조회가 실패하면 에러 영역에 네트워크 문구를 띄운다', async () => {
    setup({ receiverConfigs: [] }, undefined, (m) => {
      vi.spyOn(m, 'queryReceiverConfig').mockResolvedValue({ ok: false, reason: 'network-error' });
    });
    await waitFor(() => expect(screen.getByTestId('rcv-error')).toHaveTextContent('서버에 연결하지 못했습니다'));
  });

  it('실패 후 재제출이 성공하면 메시지가 사라지고 폼이 초기화된다', async () => {
    const { model } = setup({ receiverConfigs: [] });
    vi.spyOn(model, 'createReceiverConfig').mockResolvedValueOnce({ ok: false, reason: 'forbidden' });

    await userEvent.type(screen.getByLabelText('소스아이디'), 'NEWS1');
    await userEvent.click(screen.getByRole('button', { name: '설정 생성' }));
    await waitFor(() => expect(screen.getByTestId('rcv-error')).toBeInTheDocument());

    // 두 번째 제출은 원래 fake 구현(성공)으로 떨어진다.
    await userEvent.click(screen.getByRole('button', { name: '설정 생성' }));
    await waitFor(() => expect(screen.queryByTestId('rcv-error')).toBeNull());
    expect(screen.getByLabelText('소스아이디')).toHaveValue('');
  });

  it('알 수 없는 사유는 폴백 문구로 표시한다', async () => {
    const { model } = setup({ receiverConfigs: [] });
    vi.spyOn(model, 'createReceiverConfig').mockResolvedValue({ ok: false, reason: 'weird-reason' });

    await userEvent.click(screen.getByRole('button', { name: '설정 생성' }));

    await waitFor(() => expect(screen.getByTestId('rcv-error')).toHaveTextContent('요청을 처리하지 못했습니다 (weird-reason).'));
  });
});
