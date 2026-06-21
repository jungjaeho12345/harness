import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { AppContext } from '../app/context.js';
import { useViewController, buildMenuFilter, VIEW_MENUS, PENDING_EDIT_KEY, PAGE_SIZE } from './useViewController.js';
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

  it('desk unsent → RDS·DDH, default 전체; honors department selection', () => {
    expect(buildMenuFilter('deskUnsent', me, null)).toEqual({ status: ['RDS', 'DDH'] });
    expect(buildMenuFilter('deskUnsent', me, ['정치'])).toEqual({ status: ['RDS', 'DDH'], departments: ['정치'] });
  });
  it('dept write → excludes DPS·RRH, default 전체 (no department), honors explicit selection', () => {
    expect(buildMenuFilter('deptWrite', me, null)).toEqual({ excludeStatus: ['DPS', 'RRH'] });
    expect(buildMenuFilter('deptWrite', me, ['정치', '경제'])).toEqual({ excludeStatus: ['DPS', 'RRH'], departments: ['정치', '경제'] });
  });
  it('dept send → DPS only, multi-select departments', () => {
    expect(buildMenuFilter('deptSend', me, ['정치', '경제'])).toEqual({ status: ['DPS'], departments: ['정치', '경제'] });
    expect(buildMenuFilter('deptSend', me, null)).toEqual({ status: ['DPS'] });
  });
  it('personal → logged-in author, RDS·RRK', () => {
    expect(buildMenuFilter('personal', me, null)).toEqual({ author: '김기자', status: ['RDS', 'RRK'] });
  });
  it('kill articles → KILL 계열(RRK·DDK·EEK)만, 부서 무관(부서 키 없음)', () => {
    // KILL기사는 부서 무관 전체 KILL 목록 — departments를 줘도 부서 키를 붙이지 않는다(personal 패턴).
    expect(buildMenuFilter('killArticles', me, null)).toEqual({ status: ['RRK', 'DDK', 'EEK'] });
    expect(buildMenuFilter('killArticles', me, ['정치'])).toEqual({ status: ['RRK', 'DDK', 'EEK'] });
  });
});

describe('VIEW_MENUS', () => {
  it('5개 메뉴 — killArticles가 기존 4개 뒤에 추가된다', () => {
    expect(VIEW_MENUS).toHaveLength(5);
    expect(VIEW_MENUS).toEqual(['deskUnsent', 'deptWrite', 'deptSend', 'personal', 'killArticles']);
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

  it('desk-unsent supports a department multi-select (departments on selection; 기본 전체)', async () => {
    const { result, model } = setup({ articles: [] });
    const spy = vi.spyOn(model, 'queryArticles');
    // 데스크 미송고에서 부서를 고르면 departments로 재조회한다(기본은 전체 → 선택 시 부서 지정).
    await act(async () => { result.current.setDepartments(['정치']); });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ status: ['RDS', 'DDH'], departments: ['정치'] }));
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
    await act(async () => { await result.current.editArticle({ articleId: 'AKR0', title: 't0' }); });

    expect(navigate).toHaveBeenCalledWith('writer.do', { articleId: 'AKR0' });
    const pending = JSON.parse(sessionStorage.getItem(PENDING_EDIT_KEY));
    expect(pending).toEqual({ article: { articleId: 'AKR0', title: 't0' }, mode: 'edit' });
  });

  it('reviseArticle marks portalRevise/revise mode', async () => {
    const { result } = setup({ articles: rds(1) });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => { await result.current.reviseArticle({ articleId: 'AKR0' }, true); });
    expect(JSON.parse(sessionStorage.getItem(PENDING_EDIT_KEY)).mode).toBe('portalRevise');
  });

  it('mapArticle stashes a pendingEdit in mapping mode and navigates to writer.do (step11)', async () => {
    const { result, navigate } = setup({ articles: rds(1) });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => { await result.current.mapArticle({ articleId: 'AKR0', title: 't0' }); });

    expect(navigate).toHaveBeenCalledWith('writer.do', { articleId: 'AKR0' });
    const pending = JSON.parse(sessionStorage.getItem(PENDING_EDIT_KEY));
    expect(pending).toEqual({ article: { articleId: 'AKR0', title: 't0' }, mode: 'mapping' });
  });

  it('편집 진입 시 다른 세션이 편집 중(locked)이면 ALERT만 띄우고 이동하지 않는다(목록 유지)', async () => {
    const { result, model, navigate } = setup({ articles: rds(1) });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    vi.spyOn(model, 'lockArticle').mockResolvedValue({ ok: false, reason: 'locked' });
    const alertSpy = vi.spyOn(globalThis, 'alert').mockImplementation(() => {});

    await act(async () => { await result.current.editArticle({ articleId: 'AKR0', title: 't0' }); });

    expect(alertSpy).toHaveBeenCalledWith('편집중입니다.');
    expect(navigate).not.toHaveBeenCalled(); // 목록 페이지에 그대로 머문다(이동 없음)
    expect(sessionStorage.getItem(PENDING_EDIT_KEY)).toBeNull(); // pendingEdit도 남기지 않음
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

  it('loadHistory queries model.queryHistory and returns items', async () => {
    const seed = {
      articles: [{ articleId: 'AKR9', status: 'RDS' }],
      histories: {
        AKR9: [
          { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS', actorUserId: 'kim', createdAt: '2026-06-14T03:00:00Z' },
          { eventType: 'edit', action: 'edit', actorUserId: 'lee', createdAt: '2026-06-14T02:00:00Z' },
        ],
      },
    };
    const { result, model } = setup(seed);
    const spy = vi.spyOn(model, 'queryHistory');

    let items;
    await act(async () => { items = await result.current.loadHistory({ articleId: 'AKR9' }); });
    expect(spy).toHaveBeenCalledWith('AKR9', { sendOnly: false });
    expect(items).toHaveLength(2);
  });

  it('loadHistory with sendOnly filters to send events', async () => {
    const seed = {
      articles: [{ articleId: 'AKR9', status: 'RDS' }],
      histories: {
        AKR9: [
          { eventType: 'status', action: 'send', actorUserId: 'kim', createdAt: '2026-06-14T03:00:00Z' },
          { eventType: 'edit', action: 'edit', actorUserId: 'lee', createdAt: '2026-06-14T02:00:00Z' },
        ],
      },
    };
    const { result, model } = setup(seed);
    const spy = vi.spyOn(model, 'queryHistory');

    let items;
    await act(async () => { items = await result.current.loadHistory({ articleId: 'AKR9' }, { sendOnly: true }); });
    expect(spy).toHaveBeenCalledWith('AKR9', { sendOnly: true });
    expect(items).toHaveLength(1);
    expect(items[0].action).toBe('send');
  });

  it('loadHistory returns an empty array when there is no history', async () => {
    const { result } = setup({ articles: [{ articleId: 'AKR9', status: 'RDS' }] });
    let items;
    await act(async () => { items = await result.current.loadHistory({ articleId: 'AKR9' }); });
    expect(items).toEqual([]);
  });

  it('createFollowUp derives a followUp article and enters editor with the new id', async () => {
    const { result, model, navigate } = setup({ articles: [{ articleId: 'AKR9', title: 't', status: 'DPS' }] });
    const derive = vi.spyOn(model, 'deriveArticle');

    let r;
    await act(async () => { r = await result.current.createFollowUp({ articleId: 'AKR9' }); });
    expect(derive).toHaveBeenCalledWith('AKR9', 'followUp');
    expect(r.ok).toBe(true);
    // 파생된 새 기사로 편집 진입(원본 AKR9가 아닌 새 articleId).
    expect(navigate).toHaveBeenCalledWith('writer.do', { articleId: r.articleId });
    expect(r.articleId).not.toBe('AKR9');
    const pending = JSON.parse(sessionStorage.getItem(PENDING_EDIT_KEY));
    expect(pending).toEqual({ article: { articleId: r.articleId }, mode: 'edit' });
  });

  it('createContinue derives in continue mode', async () => {
    const { result, model } = setup({ articles: [{ articleId: 'AKR9', title: 't', status: 'DPS' }] });
    const derive = vi.spyOn(model, 'deriveArticle');
    await act(async () => { await result.current.createContinue({ articleId: 'AKR9' }); });
    expect(derive).toHaveBeenCalledWith('AKR9', 'continue');
  });

  it('resend confirms then applies the send action without a role', async () => {
    const { result, model } = setup({ articles: [{ articleId: 'AKR9', status: 'DPS' }] });
    const apply = vi.spyOn(model, 'applyAction');
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    await act(async () => { await result.current.resend({ articleId: 'AKR9' }); });
    expect(apply).toHaveBeenCalledWith('AKR9', 'send'); // role 미전송 — 서버 세션 도출(ADR-004).
  });

  it('resend does not send when the confirm is cancelled', async () => {
    const { result, model } = setup({ articles: [{ articleId: 'AKR9', status: 'DPS' }] });
    const apply = vi.spyOn(model, 'applyAction');
    vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    let r;
    await act(async () => { r = await result.current.resend({ articleId: 'AKR9' }); });
    expect(apply).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('runTranslate calls model.translate and returns translatedText', async () => {
    const seed = {
      articles: [{ articleId: 'AKR9', title: 'Hello', status: 'RDS' }],
      translations: { AKR9: '안녕하세요' },
    };
    const { result, model } = setup(seed);
    const spy = vi.spyOn(model, 'translate');

    let r;
    await act(async () => { r = await result.current.runTranslate({ articleId: 'AKR9' }); });
    expect(spy).toHaveBeenCalledWith('AKR9', 'ko');
    expect(r.ok).toBe(true);
    expect(r.translatedText).toBe('안녕하세요');
  });

  it('runTranslate honors the targetLang argument', async () => {
    const { result, model } = setup({ articles: [{ articleId: 'AKR9', title: 'Hi', status: 'RDS' }] });
    const spy = vi.spyOn(model, 'translate');
    await act(async () => { await result.current.runTranslate({ articleId: 'AKR9' }, 'en'); });
    expect(spy).toHaveBeenCalledWith('AKR9', 'en');
  });

  it('runTranslate does not throw on graceful ok:false and returns the original text', async () => {
    const { result, model } = setup({ articles: [{ articleId: 'AKR9', title: 'orig', status: 'RDS' }] });
    // 키 없음/외부 실패 시 서버는 throw 없이 graceful 객체를 준다(step5/6).
    vi.spyOn(model, 'translate').mockResolvedValue({ ok: false, reason: 'no-key', translatedText: 'orig' });

    let r;
    await act(async () => { r = await result.current.runTranslate({ articleId: 'AKR9' }); });
    expect(r).toEqual({ ok: false, reason: 'no-key', translatedText: 'orig' });
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
