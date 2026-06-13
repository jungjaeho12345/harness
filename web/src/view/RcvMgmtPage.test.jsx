import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { RcvMgmtPage } from './RcvMgmtPage.jsx';
import { createFakeModel } from '../test/fakeModel.js';

function setup(seed, identity = { userId: 'boss', role: 'Z' }) {
  const model = createFakeModel(seed);
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

  it('삭제하면 설정 행만 deleteReceiverConfig로 지운다(수집 기사 비파괴)', async () => {
    const { model } = setup({ receiverConfigs: [{ id: 7, sourceId: 'AP', type: 'FTP', name: 'x', host: '', port: '', active: 'Y' }] });
    const del = vi.spyOn(model, 'deleteReceiverConfig');
    await waitFor(() => expect(screen.getByText('AP')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '삭제' }));
    expect(del).toHaveBeenCalledWith(7);
  });
});
