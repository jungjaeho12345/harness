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
  const { result, rerender } = renderHook(() => useDistMgmtController(), { wrapper });
  return { result, rerender, model };
}

// 배부 실패 seed(phase 57 MVP-4) — 서버 list 응답 shape 그대로(spoolDir/파일 경로 없음).
const seedFailures = () => ([
  {
    articleId: 'AKR1', targetId: 3, kind: 'press', reason: 'spool-write-failed',
    failedAt: '2026-08-01T00:00:00.000Z', historyId: 11,
    targetName: '가나일보', targetActive: 'Y', targetKind: 'press', kindDistributed: true,
  },
  {
    articleId: 'AKR2', targetId: 4, kind: 'nonpress', reason: 'invalid-spool-dir',
    failedAt: '2026-08-02T00:00:00.000Z', historyId: 12,
    targetName: '나다협회', targetActive: 'Y', targetKind: 'nonpress', kindDistributed: false,
  },
]);

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

  // --- 배부 실패 목록·재전송·수동 tick(phase 57 MVP-4) — 실패 목록에도 SSE 신호가 없다: 쓰기 후 직접 재조회 ---
  describe('failures / retryTarget / runTick', () => {
    it('초기 failures는 []이고 refreshFailures()가 seed 항목을 로드한다', async () => {
      const { result } = setup({ distributionFailures: seedFailures() });
      expect(result.current.failures).toEqual([]);

      await act(async () => { await result.current.refreshFailures(); });
      expect(result.current.failures).toHaveLength(2);
      expect(result.current.failures.map((f) => f.articleId)).toEqual(['AKR1', 'AKR2']);
    });

    it('refreshFailures()는 서버 응답 객체를 그대로 반환한다(가공·필터 금지)', async () => {
      const { result, model } = setup({ distributionFailures: seedFailures() });
      const raw = { ok: true, items: [{ articleId: 'AKR9', targetId: 1, extra: 'passthrough' }] };
      vi.spyOn(model, 'queryDistributionFailures').mockResolvedValue(raw);

      let r;
      await act(async () => { r = await result.current.refreshFailures(); });
      expect(r).toBe(raw); // 원본 객체 그대로 — items만 뽑아 반환하면 안 된다.
      expect(result.current.failures).toEqual(raw.items);
    });

    it('조회 실패(forbidden)면 failures는 []로 두고 응답을 그대로 반환한다(throw 금지)', async () => {
      const { result, model } = setup({ distributionFailures: seedFailures() });
      await act(async () => { await result.current.refreshFailures(); });
      expect(result.current.failures).toHaveLength(2);

      vi.spyOn(model, 'queryDistributionFailures').mockResolvedValue({ ok: false, reason: 'forbidden' });
      let r;
      await act(async () => { r = await result.current.refreshFailures(); });
      expect(r).toEqual({ ok: false, reason: 'forbidden' });
      // "실패 0건"으로 오표시되지 않게 하는 건 View의 응답 검사 책임이지만, 상태는 빈 배열 폴백이다.
      expect(result.current.failures).toEqual([]);
    });

    it('retryTarget이 model.retryDistribution을 인자 그대로 호출한다', async () => {
      const { result, model } = setup({ distributionFailures: seedFailures() });
      const spy = vi.spyOn(model, 'retryDistribution');

      await act(async () => { await result.current.retryTarget('AKR1', 3); });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('AKR1', 3);
    });

    it('retryTarget 성공 후 내부 재조회 1회로 그 항목이 failures에서 사라진다', async () => {
      const { result, model } = setup({ distributionFailures: seedFailures() });
      await act(async () => { await result.current.refreshFailures(); });
      expect(result.current.failures).toHaveLength(2);

      const querySpy = vi.spyOn(model, 'queryDistributionFailures');
      let r;
      await act(async () => { r = await result.current.retryTarget('AKR1', 3); });

      expect(r.ok).toBe(true);
      expect(querySpy).toHaveBeenCalledTimes(1); // 쓰기 후 직접 재조회(SSE 신호 없음).
      expect(result.current.failures).toHaveLength(1);
      expect(result.current.failures[0].articleId).toBe('AKR2');
    });

    it('retryTarget 실패(no-failure)여도 재조회가 일어나고 응답이 그대로 반환된다', async () => {
      const { result, model } = setup({ distributionFailures: seedFailures() });
      const querySpy = vi.spyOn(model, 'queryDistributionFailures');

      let r;
      await act(async () => { r = await result.current.retryTarget('NOPE', 999); });
      expect(r).toEqual({ ok: false, reason: 'no-failure' }); // 실패를 삼키지 않는다.
      expect(querySpy).toHaveBeenCalledTimes(1); // 실패여도 재조회 — 목록이 이미 낡았다는 신호다.
    });

    it('runTick()이 인자 없이 tick을 부르고, 성공·실패 무관하게 실패 목록을 재조회한다', async () => {
      const { result, model } = setup({ distributionFailures: seedFailures() });
      const tickSpy = vi.spyOn(model, 'runDistributionTick');
      const querySpy = vi.spyOn(model, 'queryDistributionFailures');

      await act(async () => { await result.current.runTick(); });
      expect(tickSpy).toHaveBeenCalledTimes(1);
      expect(tickSpy).toHaveBeenCalledWith(); // 인자 없음 — 파라미터를 클라가 정하면 엠바고 무력화.
      expect(querySpy).toHaveBeenCalledTimes(1); // tick이 새 실패를 만들었을 수 있다.

      // 실패 tick(ok:false)에도 재조회한다 — 성공에만 재조회하면 부분 실행 실패가 화면에 안 남는다.
      tickSpy.mockResolvedValue({ ok: false, reason: 'spool-disabled' });
      await act(async () => { await result.current.runTick(); });
      expect(querySpy).toHaveBeenCalledTimes(2);
    });

    it('runTick()은 tick 응답 객체를 그대로 반환한다(요약 문구 생성 금지 — View 책임)', async () => {
      const raw = {
        ok: true, at: '2026-08-06T00:00:00.000Z', scanned: 3,
        distributed: [{ articleId: 'AKR1', kinds: ['press'], status: 'DPS' }],
        failed: [{ articleId: 'AKR2', targetId: 4, kind: 'press', reason: 'spool-write-failed' }],
        invalid: [],
      };
      const { result, model } = setup({});
      vi.spyOn(model, 'runDistributionTick').mockResolvedValue(raw);

      let r;
      await act(async () => { r = await result.current.runTick(); });
      expect(r).toBe(raw);
    });

    it('기존 5개 API가 그대로 있고 새 키 4개가 추가된다(회귀 잠금)', () => {
      const { result } = setup({});
      for (const key of ['targets', 'refresh', 'createTarget', 'updateTarget', 'deactivateTarget']) {
        expect(result.current[key]).toBeDefined();
      }
      expect(Array.isArray(result.current.failures)).toBe(true);
      for (const key of ['refreshFailures', 'retryTarget', 'runTick']) {
        expect(typeof result.current[key]).toBe('function');
      }
    });

    it('콜백은 useCallback으로 안정적이다 — 재렌더 후에도 함수 정체성이 유지된다', async () => {
      const { result, rerender } = setup({ distributionFailures: seedFailures() });
      const before = {
        refreshFailures: result.current.refreshFailures,
        retryTarget: result.current.retryTarget,
        runTick: result.current.runTick,
      };

      // 상태 변경(재렌더 유발) 후에도 같은 model이면 함수 정체성이 유지된다(무한 effect 루프 방지).
      await act(async () => { await result.current.refreshFailures(); });
      rerender();

      expect(result.current.refreshFailures).toBe(before.refreshFailures);
      expect(result.current.retryTarget).toBe(before.retryTarget);
      expect(result.current.runTick).toBe(before.runTick);
    });
  });
});
