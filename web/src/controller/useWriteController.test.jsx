import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { AppContext } from '../app/context.js';
import { useWriteController, PENDING_NEW_KEY } from './useWriteController.js';
import { PENDING_EDIT_KEY } from './useViewController.js';
import { createFakeModel } from '../test/fakeModel.js';

const IDENTITY = { userId: 'kim', name: '김기자', role: 'D', department: '정치' };

function setup(seed) {
  const model = createFakeModel(seed);
  const wrapper = ({ children }) => (
    <AppContext.Provider value={{ model, identity: IDENTITY, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      {children}
    </AppContext.Provider>
  );
  const view = renderHook(() => useWriteController(), { wrapper });
  return { ...view, model };
}

const FULL = {
  articleId: 'AKR1', title: '제목', body: '본문', author: '원작성자',
  embargoAt: '2026-01-01T00:00:00Z', secondEmbargoAt: '2026-01-02T00:00:00Z',
  modifier: 'lee', sender: 'park', department: '경제', departmentCode: 'EC',
  createdAt: '2026-01-01T00:00:00Z', editedAt: '2026-01-01T01:00:00Z', sentAt: '2026-01-01T02:00:00Z',
  status: 'RDS', lockYN: 'N',
};

describe('useWriteController', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  it('starts with a single blank new-article tab', () => {
    const { result } = setup({});
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTab.mode).toBe('new');
    expect(result.current.activeTab.articleId).toBeNull();
  });

  it('addTab adds an independent tab and persists across remounts (sessionStorage)', () => {
    const { result, unmount } = setup({});
    act(() => { result.current.addTab(); });
    expect(result.current.tabs).toHaveLength(2);
    unmount();

    // 새 인스턴스(페이지 이동/remount)에서도 sessionStorage로 탭이 유지된다.
    const again = setup({});
    expect(again.result.current.tabs).toHaveLength(2);
  });

  it('openArticle maps editable vs read-only fields and acquires the lock', async () => {
    const { result, model } = setup({ articles: [{ ...FULL }] });
    const lock = vi.spyOn(model, 'lockArticle');
    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });

    const tab = result.current.activeTab;
    expect(tab.mode).toBe('edit');
    expect(tab.fields).toEqual({
      title: '제목', body: '본문', author: '원작성자',
      embargoAt: '2026-01-01T00:00:00Z', secondEmbargoAt: '2026-01-02T00:00:00Z',
    });
    // 읽기전용 보존 — 기사아이디/수정자/송고자/부서/부서코드/시간들.
    expect(tab.readOnly).toMatchObject({
      articleId: 'AKR1', modifier: 'lee', sender: 'park', department: '경제', departmentCode: 'EC',
    });
    expect(tab.readOnly.title).toBeUndefined();
    expect(lock).toHaveBeenCalledWith('AKR1', 'revise');
  });

  it('reopening an already-open article activates the same tab (dedup, no second lock)', async () => {
    const { result, model } = setup({ articles: [{ ...FULL }] });
    const lock = vi.spyOn(model, 'lockArticle');
    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });
    const firstId = result.current.activeTab.id;
    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });

    expect(result.current.tabs.filter((t) => t.articleId === 'AKR1')).toHaveLength(1);
    expect(result.current.activeTab.id).toBe(firstId);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('updateField only mutates editable fields', async () => {
    const { result } = setup({ articles: [{ ...FULL }] });
    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });
    act(() => { result.current.updateField('title', '새 제목'); });
    act(() => { result.current.updateField('articleId', 'HACK'); }); // 읽기전용 → 무시
    expect(result.current.activeTab.fields.title).toBe('새 제목');
    expect(result.current.activeTab.articleId).toBe('AKR1');
  });

  it('closeTab releases the lock and keeps one blank tab when closing the last', async () => {
    const { result, model } = setup({ articles: [{ ...FULL }] });
    const unlock = vi.spyOn(model, 'unlockArticle');
    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });
    const id = result.current.activeTab.id;
    await act(async () => { result.current.closeTab(id); });

    expect(unlock).toHaveBeenCalledWith('AKR1');
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTab.articleId).toBeNull();
  });

  it('save/submit send the body under the server-persisted markupVersion key (not body)', async () => {
    const { result, model } = setup({});
    const save = vi.spyOn(model, 'saveArticle');
    act(() => { result.current.updateField('title', '제목'); });
    act(() => { result.current.updateField('body', '제목\n본문\n(끝)'); });

    await act(async () => { await result.current.save(); });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ markupVersion: '제목\n본문\n(끝)' }));
    const dto = save.mock.calls[0][0];
    expect(dto.body).toBeUndefined(); // body 키는 서버가 버리므로 보내지 않는다(contract 일치).
    expect(dto.role).toBeUndefined(); // role은 서버 세션에서 도출(ADR-004).
  });

  it('openArticle re-fetches the full article (markupVersion) when the list row lacks a body', async () => {
    // 목록행에는 본문이 없다(Contents만). 단건 재조회(getArticle)로 markupVersion을 채워야 한다.
    const markup = JSON.stringify({ format: 'yh-editor', version: 1, blocks: [{ type: 'text', text: '본문라인' }] });
    const { result, model } = setup({ articles: [{ articleId: 'AKR9', title: '제목', markupVersion: markup, status: 'RDS' }] });
    const getArticle = vi.spyOn(model, 'getArticle');

    // 목록행(본문 없음)으로 편집 진입.
    await act(async () => { await result.current.openArticle({ articleId: 'AKR9', title: '제목', status: 'RDS' }, 'edit'); });

    expect(getArticle).toHaveBeenCalledWith('AKR9');
    expect(result.current.activeTab.fields.body).toBe(markup); // 재조회로 본문이 채워졌다.
  });

  it('submit on a new tab saves (RDS) without a lifecycle transition, then resets', async () => {
    const { result, model } = setup({});
    const save = vi.spyOn(model, 'saveArticle');
    const apply = vi.spyOn(model, 'applyAction');
    act(() => { result.current.updateField('title', '신규'); });
    await act(async () => { await result.current.submit('send'); });

    expect(save).toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled(); // 신규 최초 송고는 전이 없음(news.md)
    expect(result.current.activeTab.articleId).toBeNull(); // 작성 페이지 초기화
    expect(result.current.activeTab.fields.title).toBe('');
  });

  it('submit on an edit tab applies the lifecycle action and resets to a blank tab', async () => {
    const { result, model } = setup({ articles: [{ ...FULL }] });
    const apply = vi.spyOn(model, 'applyAction');
    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });
    await act(async () => { await result.current.submit('hold'); });

    expect(apply).toHaveBeenCalledWith('AKR1', 'hold');
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTab.articleId).toBeNull();
    expect(result.current.activeTab.mode).toBe('new');
  });

  it('auto-closes an edit tab when its lock is force-released elsewhere', async () => {
    const { result, model } = setup({ articles: [{ ...FULL }] });
    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });
    expect(result.current.tabs.some((t) => t.articleId === 'AKR1')).toBe(true);

    // 다른 창에서 강제 해제 → lockYN='N' + lock 신호 → 편집 탭 자동 종료.
    await act(async () => { model.forceUnlockArticle('AKR1'); });
    await waitFor(() => expect(result.current.tabs.some((t) => t.articleId === 'AKR1')).toBe(false));
  });

  it('on browser close (pagehide) it requests unlock for open edit tabs', async () => {
    const { result, model } = setup({ articles: [{ ...FULL }] });
    const unlock = vi.spyOn(model, 'unlockArticle');
    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(unlock).toHaveBeenCalledWith('AKR1');
  });

  it('consumes a pendingEdit from list.do on mount (opens an edit tab)', async () => {
    sessionStorage.setItem(PENDING_EDIT_KEY, JSON.stringify({ article: { ...FULL }, mode: 'edit' }));
    const { result } = setup({ articles: [{ ...FULL }] });
    await waitFor(() => expect(result.current.tabs.some((t) => t.articleId === 'AKR1')).toBe(true));
    expect(sessionStorage.getItem(PENDING_EDIT_KEY)).toBeNull(); // 소비됨
  });

  // ── 후속/계속(신규 기사 파생) 진입 ─────────────────────────────────────────
  it('consumes a pendingNew(followUp) on mount → opens a NEW tab (articleId:null) with copied fields + re-fetched body', async () => {
    // 목록행에는 본문이 없다. 단건 재조회(getArticle)로 markupVersion을 본문으로 채운다.
    const markup = JSON.stringify({ format: 'yh-editor', version: 1, blocks: [{ type: 'text', text: '본문라인' }] });
    sessionStorage.setItem(PENDING_NEW_KEY, JSON.stringify({
      article: {
        articleId: 'AKR1', title: '제목', author: '원작성자',
        embargoAt: '2026-01-01T00:00:00Z', secondEmbargoAt: '2026-01-02T00:00:00Z',
        sender: 'park', sentAt: '2026-01-01T02:00:00Z', modifier: 'lee', status: 'DPS',
      },
      mode: 'followUp',
    }));
    const { result } = setup({ articles: [{ articleId: 'AKR1', title: '제목', markupVersion: markup, status: 'DPS' }] });

    await waitFor(() => expect(result.current.tabs.some((t) => t.mode === 'followUp')).toBe(true));
    expect(sessionStorage.getItem(PENDING_NEW_KEY)).toBeNull(); // 소비됨

    const tab = result.current.tabs.find((t) => t.mode === 'followUp');
    expect(tab.articleId).toBeNull(); // 신규 발번을 위해 null
    expect(tab.status).toBeNull(); // 서버가 RDS 부여
    // 채널 페이로드엔 본문이 없었다 → body가 markup이면 getArticle 단건 재조회가 일어난 것.
    expect(tab.fields.title).toBe('제목');
    expect(tab.fields.author).toBe('원작성자');
    expect(tab.fields.embargoAt).toBe('2026-01-01T00:00:00Z');
    expect(tab.fields.secondEmbargoAt).toBe('2026-01-02T00:00:00Z');
    expect(tab.fields.body).toBe(markup); // 원본 markupVersion이 본문으로 복사됨
    // 원본 메타(송고자/송고시간/수정자/기사아이디)는 신규 탭으로 끌어오지 않는다.
    expect(tab.readOnly).toEqual({});
  });

  it('followUp entry does NOT acquire a lock on the source article (신규 생성이지 원본 편집 아님)', async () => {
    sessionStorage.setItem(PENDING_NEW_KEY, JSON.stringify({
      article: { articleId: 'AKR1', title: '제목', markupVersion: '본문' }, mode: 'followUp',
    }));
    const { result, model } = setup({ articles: [{ articleId: 'AKR1', title: '제목', markupVersion: '본문', status: 'DPS' }] });
    const lock = vi.spyOn(model, 'lockArticle');
    await waitFor(() => expect(result.current.tabs.some((t) => t.mode === 'followUp')).toBe(true));
    expect(lock).not.toHaveBeenCalled(); // 원본 미잠금
  });

  it('saving a followUp tab goes through the new POST path (no source articleId in dto → 원본 미수정)', async () => {
    sessionStorage.setItem(PENDING_NEW_KEY, JSON.stringify({
      article: { articleId: 'AKR1', title: '제목', markupVersion: '본문' }, mode: 'followUp',
    }));
    const { result, model } = setup({ articles: [{ articleId: 'AKR1', title: '제목', markupVersion: '본문', status: 'DPS' }] });
    const save = vi.spyOn(model, 'saveArticle');
    await waitFor(() => expect(result.current.tabs.some((t) => t.mode === 'followUp')).toBe(true));

    await act(async () => { await result.current.submit('send'); });
    expect(save).toHaveBeenCalled();
    const dto = save.mock.calls[0][0];
    expect(dto.articleId).toBeUndefined(); // 신규 POST — 원본 articleId 미포함
    expect(dto.markupVersion).toBe('본문'); // 본문은 markupVersion으로 실린다
    expect(dto.role).toBeUndefined(); // role 미포함(ADR-004)
  });

  it('consumes a pendingNew(continue) on mount → opens a NEW tab with mode continue', async () => {
    sessionStorage.setItem(PENDING_NEW_KEY, JSON.stringify({
      article: { articleId: 'AKR1', title: '제목', markupVersion: '본문' }, mode: 'continue',
    }));
    const { result } = setup({ articles: [{ articleId: 'AKR1', title: '제목', markupVersion: '본문', status: 'DPS' }] });
    await waitFor(() => expect(result.current.tabs.some((t) => t.mode === 'continue')).toBe(true));
    const tab = result.current.tabs.find((t) => t.mode === 'continue');
    expect(tab.articleId).toBeNull();
  });
});
