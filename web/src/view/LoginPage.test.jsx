import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { LoginPage } from './LoginPage.jsx';
import { createFakeModel } from '../test/fakeModel.js';

function setup(seed) {
  const model = createFakeModel(seed);
  const navigate = vi.fn();
  const setSession = vi.fn();
  render(
    <AppContext.Provider value={{ model, identity: null, navigate, replace: vi.fn(), setSession }}>
      <LoginPage />
    </AppContext.Provider>,
  );
  return { model, navigate, setSession };
}

describe('LoginPage', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('아이디/암호 안내 문구를 표시한다', () => {
    setup({});
    expect(screen.getByPlaceholderText('아이디를 입력하세요')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('암호를 입력하세요')).toBeInTheDocument();
  });

  it('로그인 실패 시 ALERT를 띄운다', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { navigate } = setup({ users: [{ userId: 'kim', password: 'pw', role: 'R' }] });

    await userEvent.type(screen.getByPlaceholderText('아이디를 입력하세요'), 'kim');
    await userEvent.type(screen.getByPlaceholderText('암호를 입력하세요'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));

    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('로그인 성공 시 세션을 설정하고 writer.do로 이동한다', async () => {
    const { navigate, setSession } = setup({ users: [{ userId: 'kim', password: 'pw', role: 'R', department: '정치' }] });

    await userEvent.type(screen.getByPlaceholderText('아이디를 입력하세요'), 'kim');
    await userEvent.type(screen.getByPlaceholderText('암호를 입력하세요'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('writer.do'));
    expect(setSession).toHaveBeenCalled();
  });
});
