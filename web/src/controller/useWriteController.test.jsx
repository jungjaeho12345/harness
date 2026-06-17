import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { AppContext } from '../app/context.js';
import { useWriteController, PENDING_NEW_KEY } from './useWriteController.js';
import { PENDING_EDIT_KEY } from './useViewController.js';
import { createFakeModel } from '../test/fakeModel.js';
import { appendEmbedToBody } from '../view/writerBody.js';
import { serialize, deserialize, blocksToText, textBlock, embedBlock } from '../view/editorContent.js';

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
  coAuthor: '박기자', region: '서울', attribute: '단독', keyword: '키워드',
  internalComment: '내부메모', externalComment: '외부메모',
  attachmentFile: '/uploads/a.pdf', referenceFile: '/uploads/r.docx',
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
      coAuthor: '박기자', region: '서울', attribute: '단독', keyword: '키워드',
      internalComment: '내부메모', externalComment: '외부메모',
      attachmentFile: '/uploads/a.pdf', referenceFile: '/uploads/r.docx',
    });
    // 읽기전용 보존 — 기사아이디/수정자/송고자/부서/부서코드/시간들.
    expect(tab.readOnly).toMatchObject({
      articleId: 'AKR1', modifier: 'lee', sender: 'park', department: '경제', departmentCode: 'EC',
    });
    expect(tab.readOnly.title).toBeUndefined();
    // 잠금 획득 시 편집 탭별 clientId가 x-edit-client로 함께 전달된다(편집 잠금 계약).
    expect(lock).toHaveBeenCalledWith('AKR1', 'revise', expect.stringMatching(/^c-/));
    // 발급된 clientId는 이 편집 탭에 보관돼 저장/해제에서 동일하게 쓰인다.
    expect(tab.clientId).toEqual(expect.stringMatching(/^c-/));
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

  it('openArticle shows "편집중입니다." and does not open a tab when another session holds the lock', async () => {
    const { result, model } = setup({ articles: [{ ...FULL }] });
    // 다른 세션이 편집 중 — 서버 acquireEditLock이 { ok:false, reason:'locked' }를 돌려준다.
    vi.spyOn(model, 'lockArticle').mockResolvedValue({ ok: false, reason: 'locked' });
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    let returned;
    await act(async () => { returned = await result.current.openArticle({ ...FULL }, 'edit'); });

    expect(alert).toHaveBeenCalledWith('편집중입니다.');
    expect(returned).toBeNull();
    // 편집 탭이 열리지 않는다 — 빈 새 기사 탭만 유지된다.
    expect(result.current.tabs.some((t) => t.articleId === 'AKR1')).toBe(false);
    expect(result.current.activeTab.articleId).toBeNull();
  });

  // ── 편집 탭별 clientId(x-edit-client) ─────────────────────────────────────
  it('generates a per-edit-tab clientId on open and reuses it for save and unlock', async () => {
    const { result, model } = setup({ articles: [{ ...FULL }] });
    const lock = vi.spyOn(model, 'lockArticle');
    const save = vi.spyOn(model, 'saveArticle');
    const unlock = vi.spyOn(model, 'unlockArticle');

    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });
    const clientId = result.current.activeTab.clientId;
    expect(clientId).toEqual(expect.stringMatching(/^c-/));
    // 획득 시 보낸 clientId가 탭에 보관됐다.
    expect(lock).toHaveBeenCalledWith('AKR1', 'revise', clientId);

    // 저장(PUT)·해제는 같은 탭의 clientId를 그대로 사용한다(보유 탭 식별 — 2번째 탭 차단/보유자 해제).
    await act(async () => { await result.current.save(); });
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ articleId: 'AKR1' }), clientId);

    await act(async () => { await result.current.submit('hold'); });
    expect(unlock).toHaveBeenCalledWith('AKR1', clientId);
  });

  it('gives different edit tabs different clientIds (one-tab-per-session enforcement on the server)', async () => {
    const { result } = setup({
      articles: [{ ...FULL }, { ...FULL, articleId: 'AKR2' }],
    });
    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });
    const first = result.current.tabs.find((t) => t.articleId === 'AKR1').clientId;
    await act(async () => { await result.current.openArticle({ ...FULL, articleId: 'AKR2' }, 'edit'); });
    const second = result.current.tabs.find((t) => t.articleId === 'AKR2').clientId;

    expect(first).toEqual(expect.stringMatching(/^c-/));
    expect(second).toEqual(expect.stringMatching(/^c-/));
    expect(first).not.toBe(second); // 탭마다 고유 — 서버가 탭 단위로 잠금을 식별한다.
  });

  it('on lock conflict it still alerts "편집중입니다." and does not open (PR #20 behavior preserved)', async () => {
    const { result, model } = setup({ articles: [{ ...FULL }] });
    // 다른 탭/세션이 잠금 보유 — 새 clientId로는 acquire가 locked로 거부된다.
    vi.spyOn(model, 'lockArticle').mockResolvedValue({ ok: false, reason: 'locked' });
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    let returned;
    await act(async () => { returned = await result.current.openArticle({ ...FULL }, 'edit'); });

    expect(alert).toHaveBeenCalledWith('편집중입니다.');
    expect(returned).toBeNull();
    expect(result.current.tabs.some((t) => t.articleId === 'AKR1')).toBe(false);
  });

  it('updateField only mutates editable fields', async () => {
    const { result } = setup({ articles: [{ ...FULL }] });
    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });
    act(() => { result.current.updateField('title', '새 제목'); });
    act(() => { result.current.updateField('articleId', 'HACK'); }); // 읽기전용 → 무시
    expect(result.current.activeTab.fields.title).toBe('새 제목');
    expect(result.current.activeTab.articleId).toBe('AKR1');
  });

  it('updateField mutates the new common-info fields (coAuthor/region/attribute/keyword/comments/files)', async () => {
    const { result } = setup({ articles: [{ ...FULL }] });
    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });
    for (const [k, v] of [
      ['coAuthor', '새공동'], ['region', '부산'], ['attribute', '기획'], ['keyword', 'kw'],
      ['internalComment', '내부'], ['externalComment', '외부'],
      ['attachmentFile', '/uploads/x.pdf'], ['referenceFile', '/uploads/y.docx'],
    ]) {
      act(() => { result.current.updateField(k, v); });
      expect(result.current.activeTab.fields[k]).toBe(v);
    }
  });

  it('a blank new tab seeds the new common-info fields as empty strings', () => {
    const { result } = setup({});
    const f = result.current.activeTab.fields;
    for (const k of ['coAuthor', 'region', 'attribute', 'keyword', 'internalComment', 'externalComment', 'attachmentFile', 'referenceFile']) {
      expect(f[k]).toBe('');
    }
  });

  it('updateField in mapping mode rejects the new common-info fields too (body-only invariant)', async () => {
    const { result } = setup({ articles: [{ ...FULL }] });
    await act(async () => { await result.current.openArticle({ ...FULL }, 'mapping'); });
    act(() => { result.current.updateField('coAuthor', '해킹'); });
    act(() => { result.current.updateField('attachmentFile', '/uploads/hack.pdf'); });
    act(() => { result.current.updateField('internalComment', '해킹'); });
    expect(result.current.activeTab.fields.coAuthor).toBe('박기자');
    expect(result.current.activeTab.fields.attachmentFile).toBe('/uploads/a.pdf');
    expect(result.current.activeTab.fields.internalComment).toBe('내부메모');
  });

  it('closeTab releases the lock and keeps one blank tab when closing the last', async () => {
    const { result, model } = setup({ articles: [{ ...FULL }] });
    const unlock = vi.spyOn(model, 'unlockArticle');
    await act(async () => { await result.current.openArticle({ ...FULL }, 'edit'); });
    const id = result.current.activeTab.id;
    await act(async () => { result.current.closeTab(id); });

    // 닫을 때 해제 요청은 이 탭의 clientId를 함께 보낸다(보유 탭만 해제 — not-holder 차단).
    expect(unlock).toHaveBeenCalledWith('AKR1', expect.stringMatching(/^c-/));
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTab.articleId).toBeNull();
  });

  it('save/submit send the body under the server-persisted markupVersion key (not body)', async () => {
    const { result, model } = setup({});
    const save = vi.spyOn(model, 'saveArticle');
    act(() => { result.current.updateField('title', '제목'); });
    act(() => { result.current.updateField('body', '제목\n본문\n(끝)'); });

    await act(async () => { await result.current.save(); });
    // 신규 탭은 잠금이 없어 clientId가 null로 동행한다(서버 POST는 헤더 무시 — 무해).
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ markupVersion: '제목\n본문\n(끝)' }), null);
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
    // 브라우저 닫힘 해제도 편집 탭의 clientId를 함께 보낸다.
    expect(unlock).toHaveBeenCalledWith('AKR1', expect.stringMatching(/^c-/));
  });

  // step11: 매핑(mapping) — 임베드 전용 제한 편집 모드.
  it('openArticle(mapping) opens a mapping tab, fills body, and acquires the (revise) lock without applyAction', async () => {
    const { result, model } = setup({ articles: [{ ...FULL }] });
    const lock = vi.spyOn(model, 'lockArticle');
    const apply = vi.spyOn(model, 'applyAction');
    await act(async () => { await result.current.openArticle({ ...FULL }, 'mapping'); });

    const tab = result.current.activeTab;
    expect(tab.mode).toBe('mapping');
    expect(tab.articleId).toBe('AKR1');
    expect(tab.fields.body).toBe('본문'); // getArticle로 본문 채움(편집 진입과 동일)
    // 매핑은 전이 없는 잠금(revise)을 재사용한다 — 서버 게이트가 실제 인가를 강제. clientId 동행.
    expect(lock).toHaveBeenCalledWith('AKR1', 'revise', expect.stringMatching(/^c-/));
    expect(apply).not.toHaveBeenCalled(); // 순수 편집 진입 — 상태 전이 없음
  });

  it('updateField in mapping mode rejects common-info fields but allows body (embed path)', async () => {
    const { result } = setup({ articles: [{ ...FULL }] });
    await act(async () => { await result.current.openArticle({ ...FULL }, 'mapping'); });

    // 공통정보 필드(제목/작성자/엠바고/2차엠바고) 변경 시도 → 거부(변화 없음).
    act(() => { result.current.updateField('title', '해킹 제목'); });
    act(() => { result.current.updateField('author', '해킹 작성자'); });
    act(() => { result.current.updateField('embargoAt', 'HACK'); });
    act(() => { result.current.updateField('secondEmbargoAt', 'HACK'); });
    expect(result.current.activeTab.fields.title).toBe('제목');
    expect(result.current.activeTab.fields.author).toBe('원작성자');
    expect(result.current.activeTab.fields.embargoAt).toBe('2026-01-01T00:00:00Z');
    expect(result.current.activeTab.fields.secondEmbargoAt).toBe('2026-01-02T00:00:00Z');

    // body 갱신(임베드 추가/삭제 경로)은 매핑 모드에서도 허용된다.
    act(() => { result.current.updateField('body', '본문\n[임베드]'); });
    expect(result.current.activeTab.fields.body).toBe('본문\n[임베드]');
  });

  it('save in mapping mode does a PUT (saveArticle with articleId) and never applyAction', async () => {
    const { result, model } = setup({ articles: [{ ...FULL }] });
    const save = vi.spyOn(model, 'saveArticle');
    const apply = vi.spyOn(model, 'applyAction');
    await act(async () => { await result.current.openArticle({ ...FULL }, 'mapping'); });
    act(() => { result.current.updateField('body', '본문\n[임베드]'); });
    await act(async () => { await result.current.save(); });

    const dto = save.mock.calls[0][0];
    expect(dto.articleId).toBe('AKR1'); // PUT — 기사아이디 포함
    expect(dto.markupVersion).toBe('본문\n[임베드]');
    expect(dto.body).toBeUndefined();
    expect(dto.role).toBeUndefined(); // 인가는 서버 세션(ADR-004)
    expect(apply).not.toHaveBeenCalled(); // 상태 전이 없음
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

  // ── 매핑(mapping) 진입 + 텍스트 보존 저장 ─────────────────────────────────────
  // 본문: 텍스트 2줄 + "(끝)" 마커의 markupVersion. 매핑은 임베드만 추가하고 텍스트는 절대 안 바뀐다.
  const MAPPING_MARKUP = serialize([
    textBlock('첫 줄'), textBlock('둘째 줄'), textBlock('(끝)'),
  ]);

  it('consumes a pendingEdit(mapping) on mount → opens a mapping edit tab and acquires the lock', async () => {
    // 매핑은 편집 진입 계열(PENDING_EDIT_KEY) — 신규 채널(PENDING_NEW)이 아니다. 잠금을 획득한다.
    sessionStorage.setItem(PENDING_EDIT_KEY, JSON.stringify({
      article: { articleId: 'AKR1', title: '제목', status: 'DPS' }, mode: 'mapping',
    }));
    const { result, model } = setup({ articles: [{ articleId: 'AKR1', title: '제목', markupVersion: MAPPING_MARKUP, status: 'DPS' }] });
    const lock = vi.spyOn(model, 'lockArticle');

    await waitFor(() => expect(result.current.tabs.some((t) => t.mode === 'mapping')).toBe(true));
    expect(sessionStorage.getItem(PENDING_EDIT_KEY)).toBeNull(); // 소비됨

    const tab = result.current.tabs.find((t) => t.mode === 'mapping');
    expect(tab.articleId).toBe('AKR1'); // 기존 기사 편집 — articleId 유지
    expect(tab.fields.body).toBe(MAPPING_MARKUP); // 재조회로 원본 본문이 채워짐
    await waitFor(() => expect(lock).toHaveBeenCalledWith('AKR1', 'revise', expect.stringMatching(/^c-/))); // 편집 잠금 획득(clientId 동행)
  });

  it('openArticle(mapping) re-uses the edit path: getArticle + lockArticle, keeps articleId', async () => {
    const { result, model } = setup({ articles: [{ articleId: 'AKR1', title: '제목', markupVersion: MAPPING_MARKUP, status: 'DPS' }] });
    const getArticle = vi.spyOn(model, 'getArticle');
    const lock = vi.spyOn(model, 'lockArticle');
    await act(async () => { await result.current.openArticle({ articleId: 'AKR1', title: '제목', status: 'DPS' }, 'mapping'); });

    const tab = result.current.activeTab;
    expect(tab.mode).toBe('mapping');
    expect(tab.articleId).toBe('AKR1');
    expect(tab.fields.body).toBe(MAPPING_MARKUP);
    expect(getArticle).toHaveBeenCalledWith('AKR1');
    expect(lock).toHaveBeenCalledWith('AKR1', 'revise', expect.stringMatching(/^c-/));
  });

  it('saveMapping persists body via PUT(markupVersion) preserving text blocks, adding only the embed; no applyAction', async () => {
    const { result, model } = setup({ articles: [{ articleId: 'AKR1', title: '제목', markupVersion: MAPPING_MARKUP, status: 'DPS' }] });
    const save = vi.spyOn(model, 'saveArticle');
    const apply = vi.spyOn(model, 'applyAction');
    await act(async () => { await result.current.openArticle({ articleId: 'AKR1', title: '제목', status: 'DPS' }, 'mapping'); });

    // 임베드 1개를 본문에 추가(텍스트 블록은 건드리지 않는 appendEmbedToBody 경로).
    const embed = embedBlock({ embedType: 'image', mediaId: 'IMG1', url: 'http://x/y.jpg' });
    const withEmbed = appendEmbedToBody(result.current.activeTab.fields.body, embed);
    act(() => { result.current.updateField('body', withEmbed); });

    await act(async () => { await result.current.saveMapping(); });

    expect(save).toHaveBeenCalled();
    const dto = save.mock.calls[save.mock.calls.length - 1][0];
    expect(dto.articleId).toBe('AKR1'); // PUT(articleId 포함)
    expect(dto.body).toBeUndefined(); // body 키 미전송 — markupVersion으로만
    expect(dto.role).toBeUndefined(); // role 미포함(ADR-004)

    // 텍스트 블록 불변(blocksToText), 임베드만 1개 증가.
    const origBlocks = deserialize(MAPPING_MARKUP);
    const savedBlocks = deserialize(dto.markupVersion);
    expect(blocksToText(savedBlocks)).toBe(blocksToText(origBlocks)); // 텍스트 비파괴
    const origEmbeds = origBlocks.filter((b) => b.type === 'embed').length;
    const savedEmbeds = savedBlocks.filter((b) => b.type === 'embed').length;
    expect(savedEmbeds).toBe(origEmbeds + 1); // 임베드만 1개 추가

    expect(apply).not.toHaveBeenCalled(); // 매핑은 생애주기 전이가 없다
  });

  it('saveMapping unlocks and resets the tab to a blank new-article tab on success', async () => {
    const { result, model } = setup({ articles: [{ articleId: 'AKR1', title: '제목', markupVersion: MAPPING_MARKUP, status: 'DPS' }] });
    const unlock = vi.spyOn(model, 'unlockArticle');
    const apply = vi.spyOn(model, 'applyAction');
    await act(async () => { await result.current.openArticle({ articleId: 'AKR1', title: '제목', status: 'DPS' }, 'mapping'); });

    await act(async () => { await result.current.saveMapping(); });

    expect(unlock).toHaveBeenCalledWith('AKR1', expect.stringMatching(/^c-/)); // 저장 성공 후 잠금 해제(보유 탭 clientId)
    expect(apply).not.toHaveBeenCalled(); // 전이 없음
    // 매핑 탭은 빈 새 기사 탭으로 정리된다 — 더 이상 편집 컨텍스트(articleId)가 남지 않는다.
    await waitFor(() => expect(result.current.tabs.some((t) => t.articleId === 'AKR1')).toBe(false));
    expect(result.current.activeTab.mode).toBe('new');
    expect(result.current.activeTab.articleId).toBeNull();
    expect(result.current.activeTab.fields.body).toBe('');
  });
});
