import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppContext } from '../app/context.js';
import { useDistMgmtController } from './useDistMgmtController.js';
import { createFakeModel } from '../test/fakeModel.js';

// seed 행에는 active를 반드시 명시한다 — fakeModel은 seed를 stamp하지 않으므로 없으면 active 필터에서 빠진다.
// 매번 새 객체를 만든다(fake는 배열만 복사하고 행 객체는 공유하므로 테스트 간 변형이 새면 안 된다).
const seedRows = () => ([
  {
    id: 7, name: '가나일보', kind: 'press', spoolDir: 'gana', active: 'Y',
    createdAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-07-27T00:00:00.000Z',
  },
  {
    id: 8, name: '나다협회', kind: 'nonpress', spoolDir: 'nada', active: 'N',
    createdAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-07-27T00:00:00.000Z',
  },
]);

function setup(seed) {
  const model = createFakeModel(seed);
  const wrapper = ({ children }) => (
    <AppContext.Provider value={{ model, identity: { role: 'Z' }, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      {children}
    </AppContext.Provider>
  );
  const { result } = renderHook(() => useDistMgmtController(), { wrapper });
  return { result, model };
}

describe('useDistMgmtController', () => {
  it('refresh가 배부 대상 목록을 로드한다(비활성 행도 포함)', async () => {
    const { result } = setup({ distributionTargets: seedRows() });
    await act(async () => { await result.current.refresh(); });

    expect(result.current.targets).toHaveLength(2);
    expect(result.current.targets.map((t) => t.spoolDir)).toEqual(['gana', 'nada']);
    // 비활성 행을 걸러내지 않는다 — 재활성화 대상이다.
    expect(result.current.targets.some((t) => t.active === 'N')).toBe(true);
  });

  it('createTarget이 payload 그대로 호출하고 자동 refresh 후 목록에 나타난다', async () => {
    const { result, model } = setup({ distributionTargets: [] });
    const spy = vi.spyOn(model, 'createDistributionTarget');

    let r;
    await act(async () => {
      r = await result.current.createTarget({ name: '다라방송', kind: 'press', spoolDir: 'darabc', active: 'Y' });
    });

    expect(spy).toHaveBeenCalledWith({ name: '다라방송', kind: 'press', spoolDir: 'darabc', active: 'Y' });
    expect(r.ok).toBe(true);
    expect(result.current.targets).toHaveLength(1);
    expect(result.current.targets[0]).toEqual(expect.objectContaining({ id: r.id, spoolDir: 'darabc', active: 'Y' }));
  });

  it('updateTarget이 (id, fields)로 호출되고 refresh 후 값이 반영된다', async () => {
    const { result, model } = setup({ distributionTargets: seedRows() });
    const spy = vi.spyOn(model, 'updateDistributionTarget');

    await act(async () => { await result.current.updateTarget(7, { name: '가나일보(수정)', active: 'N' }); });

    expect(spy).toHaveBeenCalledWith(7, { name: '가나일보(수정)', active: 'N' });
    const row = result.current.targets.find((t) => t.id === 7);
    expect(row.name).toBe('가나일보(수정)');
    expect(row.active).toBe('N');
    expect(row.spoolDir).toBe('gana'); // present-only — 미전달 필드는 불변.
  });

  it('deactivateTarget 후에도 항목이 사라지지 않고 active만 N이 된다(soft delete)', async () => {
    const { result, model } = setup({ distributionTargets: seedRows() });
    const spy = vi.spyOn(model, 'deactivateDistributionTarget');

    await act(async () => { await result.current.deactivateTarget(7); });

    expect(spy).toHaveBeenCalledWith(7);
    expect(result.current.targets).toHaveLength(2); // 행이 남는다.
    expect(result.current.targets.find((t) => t.id === 7).active).toBe('N');
  });

  it('비활성 대상도 updateTarget으로 재활성화할 수 있다', async () => {
    const { result } = setup({ distributionTargets: seedRows() });

    await act(async () => { await result.current.updateTarget(8, { active: 'Y' }); });

    expect(result.current.targets.find((t) => t.id === 8).active).toBe('Y');
  });

  it('실패 응답을 삼키지 않고 그대로 반환한다', async () => {
    const { result, model } = setup({ distributionTargets: [] });
    vi.spyOn(model, 'createDistributionTarget').mockResolvedValue({ ok: false, reason: 'invalid-spool-dir' });

    let r;
    await act(async () => { r = await result.current.createTarget({ name: 'x', kind: 'press', spoolDir: 'BAD DIR' }); });

    expect(r).toEqual({ ok: false, reason: 'invalid-spool-dir' });
    expect(result.current.targets).toHaveLength(0);
  });

  it('update/deactivate의 not-found도 그대로 반환한다', async () => {
    const { result } = setup({ distributionTargets: seedRows() });

    let up;
    let de;
    await act(async () => { up = await result.current.updateTarget(999, { name: 'z' }); });
    await act(async () => { de = await result.current.deactivateTarget(999); });

    expect(up).toEqual({ ok: false, reason: 'not-found' });
    expect(de).toEqual({ ok: false, reason: 'not-found' });
  });
});
