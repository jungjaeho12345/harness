import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppContext } from '../app/context.js';
import { useUserMgmtController } from './useUserMgmtController.js';
import { createFakeModel } from '../test/fakeModel.js';

function setup(seed) {
  const model = createFakeModel(seed);
  const wrapper = ({ children }) => (
    <AppContext.Provider value={{ model, identity: { role: 'Z' }, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      {children}
    </AppContext.Provider>
  );
  const { result } = renderHook(() => useUserMgmtController(), { wrapper });
  return { result, model };
}

describe('useUserMgmtController', () => {
  it('refresh loads users without exposing passwords', async () => {
    const { result } = setup({ users: [{ userId: 'kim', password: 'secret', role: 'R' }] });
    await act(async () => { await result.current.refresh(); });
    expect(result.current.users).toHaveLength(1);
    expect(result.current.users[0].password).toBeUndefined();
  });

  it('createUser persists then refreshes the list', async () => {
    const { result, model } = setup({ users: [] });
    const spy = vi.spyOn(model, 'createUser');
    await act(async () => { await result.current.createUser({ userId: 'lee', password: 'x', role: 'D' }); });
    expect(spy).toHaveBeenCalledWith({ userId: 'lee', password: 'x', role: 'D' });
    expect(result.current.users.some((u) => u.userId === 'lee')).toBe(true);
  });

  it('updateUser drops an empty password (no change)', async () => {
    const { result, model } = setup({ users: [{ userId: 'kim', password: 'pw', role: 'R' }] });
    const spy = vi.spyOn(model, 'updateUser');
    await act(async () => { await result.current.updateUser('kim', { name: 'Kim', password: '' }); });
    expect(spy).toHaveBeenCalledWith('kim', { name: 'Kim' });
  });

  it('updateUser keeps a non-empty password', async () => {
    const { result, model } = setup({ users: [{ userId: 'kim', password: 'pw', role: 'R' }] });
    const spy = vi.spyOn(model, 'updateUser');
    await act(async () => { await result.current.updateUser('kim', { password: 'new' }); });
    expect(spy).toHaveBeenCalledWith('kim', { password: 'new' });
  });
});
