import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppContext } from '../app/context.js';
import { useLoginController } from './useLoginController.js';
import { createFakeModel } from '../test/fakeModel.js';

function setup(seed) {
  const model = createFakeModel(seed);
  const navigate = vi.fn();
  const setSession = vi.fn();
  const wrapper = ({ children }) => (
    <AppContext.Provider value={{ model, navigate, setSession, identity: null, replace: vi.fn() }}>
      {children}
    </AppContext.Provider>
  );
  const { result } = renderHook(() => useLoginController(), { wrapper });
  return { result, navigate, setSession };
}

describe('useLoginController', () => {
  beforeEach(() => sessionStorage.clear());

  it('on success sets the session and navigates to the writer page', async () => {
    const { result, navigate, setSession } = setup({ users: [{ userId: 'kim', password: 'pw', role: 'R' }] });

    await act(async () => { await result.current.login('kim', 'pw'); });

    expect(setSession).toHaveBeenCalledWith(expect.objectContaining({ userId: 'kim', role: 'R' }));
    expect(navigate).toHaveBeenCalledWith('writer.do');
    expect(result.current.error).toBeNull();
  });

  it('on failure exposes an error signal and does not navigate', async () => {
    const { result, navigate, setSession } = setup({ users: [{ userId: 'kim', password: 'pw', role: 'R' }] });

    await act(async () => { await result.current.login('kim', 'wrong'); });

    expect(setSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(result.current.error).toBe('invalid-credentials');
  });

  it('logout clears the session and returns to login.do', async () => {
    const { result, navigate, setSession } = setup({ users: [{ userId: 'kim', password: 'pw', role: 'R' }] });
    await act(async () => { await result.current.login('kim', 'pw'); });
    setSession.mockClear();

    await act(async () => { await result.current.logout(); });

    expect(setSession).toHaveBeenCalledWith(null);
    expect(navigate).toHaveBeenCalledWith('login.do');
  });
});
