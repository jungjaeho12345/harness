import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppContext } from '../app/context.js';
import { useRcvMgmtController } from './useRcvMgmtController.js';
import { createFakeModel } from '../test/fakeModel.js';

function setup(seed) {
  const model = createFakeModel(seed);
  const wrapper = ({ children }) => (
    <AppContext.Provider value={{ model, identity: { role: 'Z' }, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      {children}
    </AppContext.Provider>
  );
  const { result } = renderHook(() => useRcvMgmtController(), { wrapper });
  return { result, model };
}

describe('useRcvMgmtController', () => {
  it('refresh loads the receiver configs', async () => {
    const { result } = setup({ receiverConfigs: [{ id: 1, sourceId: 'src-a', type: 'FTP' }] });
    await act(async () => { await result.current.refresh(); });
    expect(result.current.configs).toHaveLength(1);
    expect(result.current.configs[0].sourceId).toBe('src-a');
  });

  it('createConfig adds a config then refreshes', async () => {
    const { result, model } = setup({ receiverConfigs: [] });
    const spy = vi.spyOn(model, 'createReceiverConfig');
    await act(async () => { await result.current.createConfig({ sourceId: 'src-b', type: 'API' }); });
    expect(spy).toHaveBeenCalledWith({ sourceId: 'src-b', type: 'API' });
    expect(result.current.configs.some((c) => c.sourceId === 'src-b')).toBe(true);
  });

  it('deleteConfig removes a config then refreshes', async () => {
    const { result, model } = setup({ receiverConfigs: [{ id: 7, sourceId: 'src-c', type: 'FTP' }] });
    const spy = vi.spyOn(model, 'deleteReceiverConfig');
    await act(async () => { await result.current.deleteConfig(7); });
    expect(spy).toHaveBeenCalledWith(7);
    expect(result.current.configs).toHaveLength(0);
  });
});
