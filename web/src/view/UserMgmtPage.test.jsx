import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { UserMgmtPage } from './UserMgmtPage.jsx';
import { createFakeModel } from '../test/fakeModel.js';

function setup(seed, identity = { userId: 'boss', role: 'Z' }) {
  const model = createFakeModel(seed);
  const utils = render(
    <AppContext.Provider value={{ model, identity, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      <UserMgmtPage />
    </AppContext.Provider>,
  );
  return { model, ...utils };
}

describe('UserMgmtPage (Z 전용 CRUD)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('사용자 목록을 조회하되 비밀번호는 어디에도 표시하지 않는다', async () => {
    setup({ users: [{ userId: 'kim', name: '김기자', role: 'R', department: '정치', password: 'secret' }] });
    await waitFor(() => expect(screen.getByText('김기자')).toBeInTheDocument());
    expect(screen.queryByText('secret')).toBeNull();
  });

  it('사용자를 생성하면 createUser를 호출한다', async () => {
    const { model } = setup({ users: [] });
    const create = vi.spyOn(model, 'createUser');

    await userEvent.type(screen.getByLabelText('유저아이디'), 'lee');
    await userEvent.type(screen.getByLabelText('이름'), '이데스크');
    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'lee', name: '이데스크' })));
  });

  it('수정 시 빈 비밀번호는 변경하지 않는다(payload에서 제거)', async () => {
    const { model } = setup({ users: [{ userId: 'kim', name: '김기자', role: 'R', department: '정치' }] });
    const update = vi.spyOn(model, 'updateUser');

    await waitFor(() => expect(screen.getByText('김기자')).toBeInTheDocument());
    // 표의 수정 버튼(편집 진입) — 이 시점엔 제출 버튼이 '생성'이라 '수정'은 행 버튼뿐.
    await userEvent.click(screen.getByRole('button', { name: '수정' }));

    // 비밀번호는 빈칸으로 두고 제출(폼 내부 '수정' 버튼).
    const form = screen.getByTestId('user-form');
    await userEvent.click(within(form).getByRole('button', { name: '수정' }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    const [userId, patch] = update.mock.calls[0];
    expect(userId).toBe('kim');
    expect(patch.password).toBeUndefined();
  });
});
