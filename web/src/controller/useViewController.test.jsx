import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { AppContext } from '../app/context.js';
import { useViewController, buildMenuFilter, PENDING_EDIT_KEY, PAGE_SIZE } from './useViewController.js';
import { createFakeModel } from '../test/fakeModel.js';

function setup(seed, identity = { userId: 'kim', name: '김기자', role: 'R', department: '정치' }) {
  const model = createFakeModel(seed);
  const navigate = vi.fn();
  const wrapper = ({ children }) => (
    <AppContext.Provider value={{ model, identity, navigate, replace: vi.fn(), setSession: vi.fn() }}>
      {children}
    </AppContext.Provider>
  );
  const { result } = renderHook(() => useViewController(), { wrapper });
  return { result, model, navigate };
}

const rds = (n) => Array.from({ length: n }, (_, i) => ({ articleId: `AKR${i}`, title: `t${i}`, status: 'RDS' }));

describe('buildMenuFilter', () => {
  const me = { userId: 'kim', name: '김기자', department: '정치' };

  it('desk unsent → RDS·DDH', () => {
    expect(buildMenuFilter('deskUnsent', me, null)).toEqual({ status: ['RDS', 'DDH'] });
  });
  it('dept write → my department, excluding DPS·RRH', () => {
    expect(buildMenuFilter('deptWrite', me, null)).toEqual({ excludeStatus: ['DPS', 'RRH'], departments: ['정치'] });
  });
  it('dept send → DPS only, multi-select departments', () => {
    expect(buildMenuFilter('deptSend', me, ['정치', '경제'])).toEqual({ status: ['DPS'], departments: ['정치', '경제'] });
    expect(buildMenuFilter('deptSend', me, null)).toEqual({ status: ['DPS'] });
  });
  it('personal → logged-in author, RDS·RRK', () => {
    expect(buildMenuFilter('personal', me, null)).toEqual({ author: '김기자', status: ['RDS', 'RRK'] });
  });
});

describe('useViewController', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('defaults to the desk-unsent menu and pages 10 items', async () => {
    const { result } = setup({ articles: rds(25) });
    await waitFor(() => expect(result.current.items).toHaveLength(25));
    expect(result.current.menu).toBe('deskUnsent');
    expect(result.current.pageItems).toHaveLength(PAGE_SIZE);
    expect(result.current.totalPages).toBe(3);

    act(() => { result.current.setPage(3); });
    expect(result.current.pageItems).toHaveLength(5);
  });

  it('clamps page into range when the list shrinks (no empty stuck page)', async () => {
    // 25건 → totalPages 3, page 3에 머무름. 그 뒤 SSE 재조회로 5건만 남으면(totalPages 1)
    // page가 1로 클램프되어 빈 화면에 갇히지 않아야 한다.
    const model = createFakeModel({ articles: rds(25) });
    let visible = rds(25);
    const orig = model.queryArticles.bind(model);
    vi.spyOn(model, 'queryArticles').mockImplementation((f) => {
      const r = orig(f);
      return { ...r, items: visible.slice() };
    });
    const navigate = vi.fn();
    const wrapper = ({ children }) => (
      <AppContext.Provider value={{ model, identity: { userId: 'kim', name: '김기자', role: 'R', department: '정치' }, navigate, replace: vi.fn(), setSession: vi.fn() }}>
        {children}
      </AppContext.Provider>
    );
    const { result } = renderHook(() => useViewController(), { wrapper });

    await waitFor(() => expect(result.current.items).toHaveLength(25));
    expect(result.current.totalPages).toBe(3);
    act(() => { result.current.setPage(3); });
    expect(result.current.pageItems).toHaveLength(5);

    // 목록이 5건으로 축소 → SSE 무효화 신호로 재조회 유발.
    visible = rds(5);
    await act(async () => { model.applyAction('AKR0', 'noop'); });

    await waitFor(() => expect(result.current.items).toHaveLength(5));
    expect(result.current.totalPages).toBe(1);
    expect(result.current.page).toBeLessThanOrEqual(result.current.totalPages);
    expect(result.current.pageItems.length).toBeGreaterThan(0);
  });

  it('does not clamp a page that is still within range', async () => {
    // 회귀 방지: 25건/page 2는 유효 범위이므로 클램프가 page를 깎으면 안 된다.
    const { result } = setup({ articles: rds(25) });
    await waitFor(() => expect(result.current.items).toHaveLength(25));
    act(() => { result.current.setPage(2); });
    await waitFor(() => expect(result.current.page).toBe(2));
    expect(result.current.page).toBe(2);
    expect(result.current.pageItems).toHaveLength(PAGE_SIZE);
  });

  it('selecting dept-send queries DPS only', async () => {
    const { result, model } = setup({ articles: [] });
    const spy = vi.spyOn(model, 'queryArticles');
    await act(async () => { result.current.selectMenu('deptSend'); });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ status: ['DPS'] }));
  });

  it('re-queries when an SSE invalidation signal arrives', async () => {
    const { result, model } = setup({ articles: rds(1) });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    // 다른 경로에서 기사가 생성됨 → notify → 컨트롤러가 자기 필터로 재조회.
    await act(async () => { model.saveArticle({ title: 'new', status: 'RDS' }); });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
  });

  it('editArticle stashes a pendingEdit and navigates to writer.do', async () => {
    const { result, navigate } = setup({ articles: rds(1) });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    act(() => { result.current.editArticle({ articleId: 'AKR0', title: 't0' }); });

    expect(navigate).toHaveBeenCalledWith('writer.do', { articleId: 'AKR0' });
    const pending = JSON.parse(sessionStorage.getItem(PENDING_EDIT_KEY));
    expect(pending).toEqual({ article: { articleId: 'AKR0', title: 't0' }, mode: 'edit' });
  });

  it('reviseArticle marks portalRevise/revise mode', async () => {
    const { result } = setup({ articles: rds(1) });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    act(() => { result.current.reviseArticle({ articleId: 'AKR0' }, true); });
    expect(JSON.parse(sessionStorage.getItem(PENDING_EDIT_KEY)).mode).toBe('portalRevise');
  });

  it('requestDelete is D/Z only and confirms before approveDelete', async () => {
    // requestDelete는 전달된 기사 객체로 동작한다(목록 필터와 무관) — DPS는 기본 메뉴에 안 보임.
    // 권한 R → 거부.
    const r = setup({ articles: [{ articleId: 'AKR9', status: 'DPS' }] }, { role: 'R' });
    let res;
    await act(async () => { res = await r.result.current.requestDelete({ articleId: 'AKR9' }); });
    expect(res).toEqual({ ok: false, reason: 'forbidden' });

    // 권한 D + 확인 → approveDelete.
    const d = setup({ articles: [{ articleId: 'AKR9', status: 'DPS' }] }, { role: 'D' });
    const apply = vi.spyOn(d.model, 'applyAction');
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    await act(async () => { await d.result.current.requestDelete({ articleId: 'AKR9' }); });
    expect(apply).toHaveBeenCalledWith('AKR9', 'approveDelete');
  });

  it('releaseLock force-unlocks for D/Z after confirm', async () => {
    const { result, model } = setup({ articles: [{ articleId: 'AKR9', status: 'RDS', lockYN: 'Y' }] }, { role: 'Z' });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    const spy = vi.spyOn(model, 'forceUnlockArticle');
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    await act(async () => { await result.current.releaseLock({ articleId: 'AKR9' }); });
    expect(spy).toHaveBeenCalledWith('AKR9');
  });
});
