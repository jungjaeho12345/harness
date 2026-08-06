import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { ListPage } from './ListPage.jsx';
import { createFakeModel } from '../test/fakeModel.js';
import { setDateFormat, DEFAULT_DATE_FORMAT } from './listFormat.js';

function setup(seed, identity = { userId: 'kim', name: '김기자', role: 'D', department: '정치' }) {
  const model = createFakeModel(seed);
  const navigate = vi.fn();
  const utils = render(
    <AppContext.Provider value={{ model, identity, navigate, replace: vi.fn(), setSession: vi.fn() }}>
      <ListPage />
    </AppContext.Provider>,
  );
  return { model, navigate, ...utils };
}

const rds = (n) => Array.from({ length: n }, (_, i) => ({
  articleId: `AKR${i}`, title: `t${i}`, status: 'RDS', author: 'kim',
  createdAt: '2026-06-14T03:09:06Z', editedAt: '2026-06-14T04:00:00Z', lockYN: 'N',
}));

const bodyRows = (c) => c.querySelectorAll('tbody tr');

describe('ListPage', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  // 마운트 effect가 module-level 날짜형식을 바꾸므로(setDateFormat) 테스트 간 누수를 막기 위해 기본으로 복원.
  afterEach(() => { setDateFormat(DEFAULT_DATE_FORMAT); });

  it('4개 메뉴와 실시간 상태바를 보여준다', async () => {
    setup({ articles: [] });
    for (const m of ['데스크 미송고', '부서별 작성', '부서별 송고', '개인별 수정']) {
      expect(screen.getByRole('button', { name: m })).toBeInTheDocument();
    }
    // 상태바는 하드코딩이 아니라 실제 SSE 연결 상태를 반영한다 — fake 스트림은 즉시 연결됨(onStatus true).
    await waitFor(() => {
      const live = screen.getByTestId('live-status');
      expect(live).toHaveClass('yh-live--on');
      expect(live).toHaveTextContent('실시간');
    });
  });

  it('KILL기사 메뉴 버튼을 보여주고(5번째 탭), 선택 시 RRK·DDK·EEK를 조회하며 부서 셀렉터가 있다', async () => {
    const { model } = setup({ articles: [] });
    expect(screen.getByRole('button', { name: 'KILL기사' })).toBeInTheDocument();
    const spy = vi.spyOn(model, 'queryArticles');
    await userEvent.click(screen.getByRole('button', { name: 'KILL기사' }));
    // 진입 시 기본 '전체'(부서 미지정) — status만으로 조회하고, 부서 멀티셀렉트로 좁힐 수 있다.
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ status: ['RRK', 'DDK', 'EEK'] }));
    expect(await screen.findByTestId('dept-selector')).toBeInTheDocument();
  });

  it('엠바고 관리 메뉴 버튼을 보여주고(6번째 탭), 선택 시 DES·EPS를 조회하며 부서 셀렉터가 있다', async () => {
    const { model } = setup({ articles: [] });
    expect(screen.getByRole('button', { name: '엠바고 관리' })).toBeInTheDocument();
    const spy = vi.spyOn(model, 'queryArticles');
    await userEvent.click(screen.getByRole('button', { name: '엠바고 관리' }));
    // 진입 시 기본 '전체'(부서 미지정) — status만으로 조회하고, 부서 멀티셀렉트로 좁힐 수 있다.
    // 배부 전 대기(DES) + 배부 진행(EPS)을 함께 조회한다(phase48 step5).
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ status: ['DES', 'EPS'] }));
    expect(await screen.findByTestId('dept-selector')).toBeInTheDocument();
  });

  it('엠바고 관리 메뉴는 권한 D/Z에게만 보이고, 권한 R에게는 숨긴다', async () => {
    const { unmount } = setup({ articles: [] }, { userId: 'park', name: '박기자', role: 'R', department: '정치' });
    // 권한 R: 엠바고 관리 탭이 없고 KILL기사까지 5개 메뉴만 보인다.
    expect(await screen.findByRole('button', { name: 'KILL기사' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '엠바고 관리' })).toBeNull();
    unmount();
    // 권한 D: 엠바고 관리 탭이 보인다.
    setup({ articles: [] }, { userId: 'kim', name: '김데스크', role: 'D', department: '정치' });
    expect(await screen.findByRole('button', { name: '엠바고 관리' })).toBeInTheDocument();
  });

  it('KILL기사에서 부서를 좁히면 status와 departments로 재조회한다', async () => {
    const { model } = setup({
      articles: [],
      users: [{ userId: 'kim', name: '김기자', department: '정치' }, { userId: 'lee', name: '이기자', department: '경제' }],
    });
    await userEvent.click(screen.getByRole('button', { name: 'KILL기사' }));
    await userEvent.click(await screen.findByTestId('dept-trigger')); // 부서 드롭다운 열기
    await screen.findByLabelText('경제');
    const spy = vi.spyOn(model, 'queryArticles');
    // 기본 '전체'에서 경제를 끄면 정치만 남아 departments=['정치']로 재조회한다.
    await userEvent.click(screen.getByLabelText('경제'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ status: ['RRK', 'DDK', 'EEK'], departments: ['정치'] }));
  });

  // DES(배부 전 대기)·EPS(배부 진행) 어느 행이든 편집 진입이 동작해야 한다(phase48 step5 파라미터화).
  for (const status of ['DES', 'EPS']) {
    it(`엠바고 관리 ${status} 행 우클릭 편집 → 잠금 획득 후 writer.do로 편집 진입한다(edit 모드)`, async () => {
      const articleId = `AKR-${status}`;
      const { model, navigate, container } = setup({ articles: [{ articleId, title: 't', status, lockYN: 'N' }] });
      const lock = vi.spyOn(model, 'lockArticle');

      await userEvent.click(screen.getByRole('button', { name: '엠바고 관리' }));
      await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

      fireEvent.contextMenu(bodyRows(container)[0]);
      await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));

      // edit 모드 진입(enterEditor 'edit'): 잠금 획득(revise lock) 후 writer.do로 이동.
      await waitFor(() => expect(lock).toHaveBeenCalledWith(articleId, 'revise'));
      expect(navigate).toHaveBeenCalledWith('writer.do', { articleId });
    });
  }

  it('데스크 미송고에서도 부서 Select(기본 전체)를 보여주고, 열면 체크박스가 나온다', async () => {
    setup({
      articles: [],
      users: [{ userId: 'kim', name: '김기자', department: '정치' }, { userId: 'lee', name: '이기자', department: '경제' }],
    });
    // 기본 메뉴(데스크 미송고)에서 부서 Select 드롭다운이 보이고, 트리거에 기본값 '전체'가 요약된다.
    expect(await screen.findByTestId('dept-selector')).toBeInTheDocument();
    const trigger = screen.getByTestId('dept-trigger');
    expect(trigger).toHaveTextContent('전체');
    // 드롭다운을 열면 '전체'(체크) + 부서 체크박스(사용자 목록에서 도출)가 나온다.
    await userEvent.click(trigger);
    expect(screen.getByLabelText('전체')).toBeChecked();
    expect(await screen.findByLabelText('정치')).toBeInTheDocument();
    expect(screen.getByLabelText('경제')).toBeInTheDocument();
  });

  it('데스크 미송고에서 부서를 좁히면 departments로 재조회한다', async () => {
    const { model } = setup({
      articles: [],
      users: [{ userId: 'kim', name: '김기자', department: '정치' }, { userId: 'lee', name: '이기자', department: '경제' }],
    });
    await screen.findByTestId('dept-trigger');
    await userEvent.click(screen.getByTestId('dept-trigger')); // 드롭다운 열기
    await screen.findByLabelText('경제');
    const spy = vi.spyOn(model, 'queryArticles');
    // 기본은 '전체'(전 부서) — 경제를 끄면 정치만 남아 departments=['정치']로 재조회한다.
    await userEvent.click(screen.getByLabelText('경제'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ status: ['RDS', 'DDH'], departments: ['정치'] }));
  });

  it('기본(데스크 미송고)에서 10개씩 페이징한다', async () => {
    const { container } = setup({ articles: rds(25) });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(10));
    expect(screen.getByTestId('pager')).toHaveTextContent('1 / 3');
  });

  it('작성시간을 YYYY-MM-DD HH:mm로 표시한다(저장값 없으면 기본 형식)', async () => {
    const { container } = setup({ articles: rds(1) });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    expect(container).toHaveTextContent('2026-06-14 03:09');
  });

  it('마운트 시 저장된 날짜형식(editorPrefs.dateFormat)을 적용해 날짜 셀을 그 형식으로 표시한다', async () => {
    localStorage.setItem('yh.editorPrefs', JSON.stringify({ dateFormat: 'YYYY.MM.DD' }));
    const { container } = setup({ articles: rds(1) });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    expect(container).toHaveTextContent('2026.06.14');
    expect(container).not.toHaveTextContent('2026-06-14 03:09');
  });

  it('상태 배지에 UI_GUIDE 색(RDS=회색)을 적용한다', async () => {
    setup({ articles: rds(1) });
    const badge = await screen.findByTestId('status-badge');
    expect(badge).toHaveTextContent('RDS');
    expect(badge.style.backgroundColor).toBe('rgb(232, 232, 232)'); // #e8e8e8
  });

  it('행을 클릭하면 상세보기 새 창(720×800)을 연다', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
    });
    const { container } = setup({ articles: rds(1) });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    await userEvent.click(bodyRows(container)[0]);
    expect(open).toHaveBeenCalledWith('', '_blank', expect.stringContaining('width=720'));
  });

  it('행을 클릭하면 getArticle로 본문을 받아 상세보기 새 창에 제목+본문을 쓴다', async () => {
    // 목록 행(Contents 전용)에는 본문(markupVersion)이 없다 — 상세보기 직전 model.getArticle(id)로
    // 본문까지 갖춘 전체 기사를 받아와 렌더해야 제목(본문 첫 줄)과 본문이 보인다.
    const written = [];
    const win = { document: { open: vi.fn(), write: (h) => written.push(h), close: vi.fn() } };
    vi.spyOn(window, 'open').mockReturnValue(win);

    // markupVersion: 첫 줄=제목, 둘째 줄=본문(yh-editor 블록 JSON).
    const markup = JSON.stringify({
      format: 'yh-editor',
      version: 1,
      blocks: [{ type: 'text', text: '제목줄입니다' }, { type: 'text', text: '본문 단락 텍스트' }],
    });
    const { model, container } = setup({ articles: [{ articleId: 'AKR0', title: 't0', status: 'RDS', lockYN: 'N' }] });
    // 목록 행에는 markupVersion이 없고, getArticle만이 본문을 채워 돌려준다.
    const getArticle = vi.spyOn(model, 'getArticle').mockResolvedValue({
      ok: true,
      article: { articleId: 'AKR0', title: '제목줄입니다', markupVersion: markup },
      contents: { articleId: 'AKR0', author: '관리자' },
    });

    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    await userEvent.click(bodyRows(container)[0]);

    await waitFor(() => expect(getArticle).toHaveBeenCalledWith('AKR0'));
    await waitFor(() => expect(written.length).toBeGreaterThan(0));
    const html = written.join('');
    expect(html).toContain('제목줄입니다'); // 본문 첫 줄(=제목)
    expect(html).toContain('본문 단락 텍스트'); // 본문 블록
  });

  it('상세보기 새 창에 editorPrefs.byline(작성자 부가 라인)을 주입한다', async () => {
    // 날짜형식 적용과 동일한 call-site prefs 패턴 — 상세보기 렌더에 뷰어 브라우저의 byline을 넘긴다.
    localStorage.setItem('yh.editorPrefs', JSON.stringify({
      byline: { email: true, emailValue: 'hong@yna.co.kr', blog: false, blogValue: '' },
    }));
    const written = [];
    const win = { document: { open: vi.fn(), write: (h) => written.push(h), close: vi.fn() } };
    vi.spyOn(window, 'open').mockReturnValue(win);

    const { model, container } = setup({ articles: [{ articleId: 'AKR0', title: 't0', status: 'RDS', lockYN: 'N' }] });
    vi.spyOn(model, 'getArticle').mockResolvedValue({
      ok: true,
      article: { articleId: 'AKR0', title: '제목', markupVersion: '' },
      contents: { articleId: 'AKR0', author: '홍길동' },
    });

    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    await userEvent.click(bodyRows(container)[0]);

    await waitFor(() => expect(written.length).toBeGreaterThan(0));
    expect(written.join('')).toContain('hong@yna.co.kr');
  });

  it('실시간 SSE 신호가 오면 목록을 재조회한다', async () => {
    const { model, container } = setup({ articles: rds(1) });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    await act_save(model);
    await waitFor(() => expect(bodyRows(container)).toHaveLength(2));
  });

  it("부서 선택 화면의 '조회' 버튼을 누르면 재조회한다(news.md 81행)", async () => {
    const { model, container } = setup({ articles: [{ articleId: 'AKR9', title: 't', status: 'DPS', lockYN: 'N' }] });
    await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    const spy = vi.spyOn(model, 'queryArticles');
    await userEvent.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });

  it('우클릭 삭제요청(DPS+D/Z) → approveDelete를 호출한다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model, container } = setup({ articles: [{ articleId: 'AKR9', title: 't', status: 'DPS', lockYN: 'N' }] });
    const apply = vi.spyOn(model, 'applyAction');

    await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '삭제요청' }));
    expect(apply).toHaveBeenCalledWith('AKR9', 'approveDelete');
  });

  it("부서 선택: 기본 '전체'(전 부서 체크)에서 개별 부서로 좁히고 '전체'로 되돌린다", async () => {
    const seed = {
      users: [{ userId: 'a', department: '정치' }, { userId: 'b', department: '경제' }],
      articles: [{ articleId: 'AKR9', title: 't', status: 'DPS', lockYN: 'N' }],
    };
    const { model } = setup(seed);
    await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));
    await userEvent.click(await screen.findByTestId('dept-trigger')); // 부서 Select 열기
    await screen.findByLabelText('정치'); // 부서 옵션(queryUsers) 렌더 대기

    // 기본값: '전체' + 모든 부서가 체크돼 전 부서로 조회된다(빈 선택 = 부서 미지정).
    expect(screen.getByLabelText('전체')).toBeChecked();
    expect(screen.getByLabelText('정치')).toBeChecked();
    expect(screen.getByLabelText('경제')).toBeChecked();

    // 개별 부서를 끄면 그 부서만 빠지고(좁힘) departments로 재조회한다.
    const spy = vi.spyOn(model, 'queryArticles');
    await userEvent.click(screen.getByLabelText('경제'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ status: ['DPS'], departments: ['정치'] }),
    ));
    expect(screen.getByLabelText('전체')).not.toBeChecked();
    expect(screen.getByLabelText('정치')).toBeChecked();
    expect(screen.getByLabelText('경제')).not.toBeChecked();

    // '전체'를 누르면 전 부서로 리셋된다(모든 박스 체크).
    await userEvent.click(screen.getByLabelText('전체'));
    await waitFor(() => expect(screen.getByLabelText('경제')).toBeChecked());
    expect(screen.getByLabelText('정치')).toBeChecked();
  });

  it('부서 Select: 바깥을 클릭하면 패널이 닫힌다', async () => {
    setup({
      articles: [],
      users: [{ userId: 'kim', name: '김기자', department: '정치' }, { userId: 'lee', name: '이기자', department: '경제' }],
    });
    await userEvent.click(await screen.findByTestId('dept-trigger')); // 열기
    expect(await screen.findByLabelText('정치')).toBeInTheDocument(); // 패널 열림 확인
    // 패널 바깥(메뉴바 컨테이너 — 비인터랙티브) 클릭 → mousedown 핸들러가 패널을 닫는다(메뉴 전환 등 부작용 없음).
    await userEvent.click(screen.getByTestId('menubar'));
    await waitFor(() => expect(screen.queryByLabelText('정치')).toBeNull());
  });

  it('부서 Select: 부분 선택 시 트리거 요약이 부서명/N개 부서로 표시된다', async () => {
    const seed = {
      users: [{ userId: 'a', department: '정치' }, { userId: 'b', department: '경제' }, { userId: 'c', department: '사회' }],
      articles: [],
    };
    setup(seed);
    const trigger = await screen.findByTestId('dept-trigger');
    expect(trigger).toHaveTextContent('전체'); // 기본값
    await userEvent.click(trigger);
    await screen.findByLabelText('사회');
    // 경제를 끄면 정치·사회 2개 → 'N개 부서' 요약.
    await userEvent.click(screen.getByLabelText('경제'));
    await waitFor(() => expect(trigger).toHaveTextContent('2개 부서'));
    // 정치도 끄면 사회 1개만 → 부서명 그대로 요약.
    await userEvent.click(screen.getByLabelText('정치'));
    await waitFor(() => expect(trigger).toHaveTextContent('사회'));
  });

  it('잠긴 행의 우클릭 Lock해제(D/Z) → force-unlock을 호출한다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model, container } = setup({ articles: [{ articleId: 'AKR5', title: 't', status: 'RDS', lockYN: 'Y' }] });
    const force = vi.spyOn(model, 'forceUnlockArticle');

    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Lock해제' }));
    expect(force).toHaveBeenCalledWith('AKR5');
  });

  it('우클릭 이력보기 → 이력 모달에 행을 렌더한다', async () => {
    const seed = {
      articles: [{ articleId: 'AKR9', title: 't', status: 'RDS', lockYN: 'N' }],
      histories: {
        AKR9: [
          { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS', actorUserId: '김기자', createdAt: '2026-06-14T03:09:06Z' },
        ],
      },
    };
    const { container } = setup(seed);
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '이력보기' }));

    const dialog = await screen.findByRole('dialog', { name: '이력보기' });
    expect(dialog).toHaveTextContent('2026-06-14 03:09');
    expect(dialog).toHaveTextContent('김기자');
  });

  it('우클릭 이력보기 → 이력이 없으면 안내를 보여준다', async () => {
    const { container } = setup({ articles: [{ articleId: 'AKR9', title: 't', status: 'RDS', lockYN: 'N' }] });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '이력보기' }));

    const dialog = await screen.findByRole('dialog', { name: '이력보기' });
    expect(dialog).toHaveTextContent('이력이 없습니다');
  });

  it('우클릭 송고이력보기 → sendOnly로 조회한다', async () => {
    const seed = {
      articles: [{ articleId: 'AKR9', title: 't', status: 'DPS', lockYN: 'N' }],
      histories: {
        AKR9: [
          { eventType: 'status', action: 'send', actorUserId: 'kim', createdAt: '2026-06-14T03:00:00Z' },
          { eventType: 'edit', action: 'edit', actorUserId: 'lee', createdAt: '2026-06-14T02:00:00Z' },
        ],
      },
    };
    const { model, container } = setup(seed);
    const spy = vi.spyOn(model, 'queryHistory');

    await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '송고이력보기' }));
    await screen.findByRole('dialog', { name: '송고이력보기' });
    expect(spy).toHaveBeenCalledWith('AKR9', { sendOnly: true });
  });

  it('우클릭 후속기사작성 → deriveArticle(followUp) 후 새 기사로 편집 진입한다', async () => {
    const navigate = vi.fn();
    const model = createFakeModel({ articles: [{ articleId: 'AKR9', title: 't', status: 'DPS', lockYN: 'N' }] });
    const derive = vi.spyOn(model, 'deriveArticle');
    const { container } = render(
      <AppContext.Provider value={{ model, identity: { userId: 'kim', name: '김기자', role: 'D', department: '정치' }, navigate, replace: vi.fn(), setSession: vi.fn() }}>
        <ListPage />
      </AppContext.Provider>,
    );

    await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '후속기사작성' }));
    await waitFor(() => expect(derive).toHaveBeenCalledWith('AKR9', 'followUp'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('writer.do', expect.objectContaining({ articleId: expect.not.stringMatching('AKR9') })));
  });

  it('우클릭 계속기사작성 → deriveArticle(continue) 후 새 기사로 편집 진입한다', async () => {
    // 후속기사작성 테스트와 동형 — 차이는 (1) 메뉴 항목 '계속기사작성', (2) 모드 'continue'.
    // navigate 스텁 + createFakeModel + deriveArticle 스파이. 원본(AKR9) 비파괴 → 새 articleId로 writer.do 진입.
    const navigate = vi.fn();
    const model = createFakeModel({ articles: [{ articleId: 'AKR9', title: 't', status: 'DPS', lockYN: 'N' }] });
    const derive = vi.spyOn(model, 'deriveArticle');
    const { container } = render(
      <AppContext.Provider value={{ model, identity: { userId: 'kim', name: '김기자', role: 'D', department: '정치' }, navigate, replace: vi.fn(), setSession: vi.fn() }}>
        <ListPage />
      </AppContext.Provider>,
    );

    await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '계속기사작성' }));
    await waitFor(() => expect(derive).toHaveBeenCalledWith('AKR9', 'continue'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('writer.do', expect.objectContaining({ articleId: expect.not.stringMatching('AKR9') })));
  });

  it('우클릭 재송(DPS+D/Z) → 확인 후 send 액션을 호출한다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model, container } = setup({ articles: [{ articleId: 'AKR9', title: 't', status: 'DPS', lockYN: 'N' }] });
    const apply = vi.spyOn(model, 'applyAction');

    await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '재송' }));
    expect(apply).toHaveBeenCalledWith('AKR9', 'send');
  });

  it('우클릭 번역 → 번역 결과 모달에 번역문을 보여준다', async () => {
    const seed = {
      articles: [{ articleId: 'AKR9', title: 'Hello', status: 'RDS', lockYN: 'N' }],
      translations: { AKR9: '안녕하세요' },
    };
    const { container } = setup(seed);
    // 번역 항목은 부서별 작성/송고·개인별 메뉴에 노출된다(deskUnsent 제외).
    await userEvent.click(screen.getByRole('button', { name: '부서별 작성' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));

    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '번역' }));

    const dialog = await screen.findByRole('dialog', { name: '번역' });
    expect(dialog).toHaveTextContent('안녕하세요');
  });

  it('우클릭 번역 → 키 없음(graceful)이면 원문과 안내를 보여준다(throw 없음)', async () => {
    const { model, container } = setup({ articles: [{ articleId: 'AKR9', title: 'orig', status: 'RDS', lockYN: 'N' }] });
    vi.spyOn(model, 'translate').mockResolvedValue({ ok: false, reason: 'no-key', translatedText: 'orig' });

    await userEvent.click(screen.getByRole('button', { name: '부서별 작성' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '번역' }));

    const dialog = await screen.findByRole('dialog', { name: '번역' });
    expect(dialog).toHaveTextContent('orig'); // 원문 표시
    expect(dialog).toHaveTextContent('번역을 사용할 수 없습니다'); // graceful 안내
  });

  it('헤더 우클릭 시 컬럼 설정 모달이 열린다', async () => {
    const { container } = setup({ articles: rds(1) });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    fireEvent.contextMenu(container.querySelector('thead tr'));
    expect(screen.getByRole('dialog', { name: '컬럼 설정' })).toBeInTheDocument();
  });

  // --- 이력보기 모달 컬럼 카탈로그 결선(phase 56, news.md 114~115행) ---
  // 단언 스코프 규칙: 모달 오픈 후의 헤더/셀 단언은 within(dialog)로 스코프한다 —
  // bodyRows(container)는 목록 tbody와 모달 tbody가 섞이므로 모달 오픈 '전'에만 쓴다.
  describe('이력보기 모달 — 기본 5열 + 이력 목록설정', () => {
    const HIST_ARTICLE = {
      articleId: 'AKR9', title: 't', status: 'RDS', lockYN: 'N',
      author: 'kim', department: '정치', createdAt: '2026-06-14T01:00:00Z', sentAt: '2026-06-14T05:00:00Z',
    };
    // 서버가 주는 shape 그대로(step2 계약) — title/version/status는 서버 파생, blob 없음.
    const HIST_ROWS = [
      {
        id: 3, articleId: 'AKR9', eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS',
        actorUserId: '김기자', createdAt: '2026-06-14T03:09:06Z', hasSnapshot: 0,
        title: '헤드라인', version: 2, status: 'DPS',
      },
      {
        id: 2, articleId: 'AKR9', eventType: 'edit', action: null, actorUserId: '이기자',
        createdAt: '2026-06-14T02:00:00Z', hasSnapshot: 1, title: '헤드라인', version: 2, status: 'RDS',
      },
    ];
    const histSeed = () => ({
      articles: [{ ...HIST_ARTICLE }],
      histories: { AKR9: HIST_ROWS.map((r) => ({ ...r })) },
    });

    // 이력 모달 오픈 — bodyRows는 모달이 열리기 전이라 안전하다.
    async function openHistory(container, name = '이력보기') {
      await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
      fireEvent.contextMenu(bodyRows(container)[0]);
      await userEvent.click(screen.getByRole('menuitem', { name }));
      return screen.findByRole('dialog', { name });
    }

    // 이력 모달 콘텐츠 영역 우클릭 → 이력 목록설정 모달.
    async function openSettings(dialog) {
      fireEvent.contextMenu(dialog);
      return screen.findByRole('dialog', { name: '이력 목록설정' });
    }

    const headerTexts = (dialog) => within(dialog).getAllByRole('columnheader').map((th) => th.textContent);
    const rowCells = (dialog, i) => [...dialog.querySelectorAll('tbody tr')[i].querySelectorAll('td')]
      .map((td) => td.textContent);

    it('케이스1: 이력보기 헤더가 정확히 수정시간/제목/수정자/상태/버전(순서 포함)이다', async () => {
      const { container } = setup(histSeed());
      const dialog = await openHistory(container);
      expect(headerTexts(dialog)).toEqual(['수정시간', '제목', '수정자', '상태', '버전']);
    });

    it('케이스2: 첫 행에 수정시간·제목·수정자·상태·버전 값이 보인다', async () => {
      const { container } = setup(histSeed());
      const dialog = await openHistory(container);
      expect(rowCells(dialog, 0)).toEqual(['2026-06-14 03:09', '헤드라인', '김기자', 'DPS', 'v2']);
    });

    it("케이스3: title이 빈 문자열·version 없음인 행은 해당 셀이 '—'다", async () => {
      const seed = histSeed();
      seed.histories.AKR9 = [{
        id: 1, articleId: 'AKR9', eventType: 'edit', action: null, actorUserId: '박기자',
        createdAt: '2026-06-14T01:30:00Z', hasSnapshot: 0, title: '', status: '',
      }];
      const { container } = setup(seed);
      const dialog = await openHistory(container);
      expect(rowCells(dialog, 0)).toEqual(['2026-06-14 01:30', '—', '박기자', '—', '—']);
    });

    it("케이스4: 이력 모달 안 우클릭 → '이력 목록설정'이 열리고 이력 모달은 그대로다", async () => {
      const { container } = setup(histSeed());
      const dialog = await openHistory(container);
      const settings = await openSettings(dialog);
      expect(settings).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: '이력보기' })).toBeInTheDocument();
    });

    it('케이스5: 이력 0건(이력이 없습니다) 상태에서도 우클릭으로 설정 모달이 열린다', async () => {
      const { container } = setup({ articles: [{ ...HIST_ARTICLE }] });
      const dialog = await openHistory(container);
      expect(dialog).toHaveTextContent('이력이 없습니다');
      const settings = await openSettings(dialog);
      expect(settings).toBeInTheDocument();
    });

    it("케이스6: 설정에서 '종류'를 체크하면 헤더에 종류가 추가되고 셀에 원값이 보인다", async () => {
      const { container } = setup(histSeed());
      const dialog = await openHistory(container);
      const settings = await openSettings(dialog);
      await userEvent.click(within(settings).getByLabelText('종류'));
      expect(headerTexts(dialog)).toEqual(['수정시간', '제목', '수정자', '상태', '버전', '종류']);
      expect(rowCells(dialog, 0)[5]).toBe('status');
      expect(rowCells(dialog, 1)[5]).toBe('edit');
    });

    it("케이스7: 설정에서 기본 컬럼 '버전'을 해제하면 헤더에서 사라진다", async () => {
      const { container } = setup(histSeed());
      const dialog = await openHistory(container);
      const settings = await openSettings(dialog);
      await userEvent.click(within(settings).getByLabelText('버전'));
      expect(headerTexts(dialog)).toEqual(['수정시간', '제목', '수정자', '상태']);
    });

    it('케이스8: 컬럼 변경은 영속돼 같은 종류(이력보기)를 다시 열면 유지된다', async () => {
      const { container } = setup(histSeed());
      let dialog = await openHistory(container);
      const settings = await openSettings(dialog);
      await userEvent.click(within(settings).getByLabelText('버전')); // 해제
      await userEvent.click(within(settings).getByLabelText('종류')); // 추가
      await userEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '이력보기' })).toBeNull());

      dialog = await openHistory(container);
      expect(headerTexts(dialog)).toEqual(['수정시간', '제목', '수정자', '상태', '종류']);
    });

    it('케이스9: 이력보기에서 켠 컬럼은 송고이력보기에 적용되지 않는다(종류별 저장)', async () => {
      const seed = histSeed();
      seed.articles[0].status = 'DPS'; // 부서별 송고 목록에 노출 + 송고이력보기 항목이 있는 메뉴.
      const { container } = setup(seed);
      await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));

      let dialog = await openHistory(container, '이력보기');
      const settings = await openSettings(dialog);
      await userEvent.click(within(settings).getByLabelText('종류'));
      expect(headerTexts(dialog)).toContain('종류');
      await userEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '이력보기' })).toBeNull());

      dialog = await openHistory(container, '송고이력보기');
      expect(headerTexts(dialog)).toEqual(['수정시간', '제목', '수정자', '상태', '버전']);
    });

    it("케이스10: 이력 설정 변경이 목록 테이블 헤더·'컬럼 설정' 모달과 격리된다", async () => {
      const { container } = setup(histSeed());
      const dialog = await openHistory(container);
      const settings = await openSettings(dialog);
      await userEvent.click(within(settings).getByLabelText('버전'));
      await userEvent.click(within(settings).getByLabelText('종류'));
      await userEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '이력보기' })).toBeNull());

      // 목록 테이블 헤더는 그대로다(모달이 닫혀 thead는 목록 테이블뿐).
      expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
        '기사아이디', '제목', '작성자', '수정자', '부서', '부서코드',
        '작성시간', '수정시간', '송고시간', '기사상태', 'LockYN',
      ]);
      // 헤더 우클릭으로 열리는 '컬럼 설정' 모달의 체크 상태도 오염되지 않는다(전부 기본 체크).
      fireEvent.contextMenu(container.querySelector('thead tr'));
      const colModal = screen.getByRole('dialog', { name: '컬럼 설정' });
      expect(within(colModal).getByLabelText('제목')).toBeChecked();
      expect(within(colModal).getByLabelText('기사상태')).toBeChecked();
      expect(within(colModal).getByLabelText('송고시간')).toBeChecked();
    });

    it('케이스11: 설정 모달 백드롭 클릭은 설정만 닫고 이력 모달은 남긴다', async () => {
      const { container } = setup(histSeed());
      const dialog = await openHistory(container);
      await openSettings(dialog);
      const backdrops = container.querySelectorAll('.yh-modal__backdrop');
      fireEvent.click(backdrops[backdrops.length - 1]); // 설정 모달 백드롭(마지막 형제)
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '이력 목록설정' })).toBeNull());
      expect(screen.getByRole('dialog', { name: '이력보기' })).toBeInTheDocument();
    });

    it('케이스12: 설정 모달을 열어 둔 채 이력 모달을 닫으면 설정 모달도 함께 사라진다', async () => {
      const { container } = setup(histSeed());
      const dialog = await openHistory(container);
      await openSettings(dialog);
      await userEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '이력보기' })).toBeNull());
      expect(screen.queryByRole('dialog', { name: '이력 목록설정' })).toBeNull();
    });

    it('케이스13: 모든 컬럼을 해제하면 안내 문구가 보이고, 그 상태에서도 설정을 다시 열 수 있다', async () => {
      const { container } = setup(histSeed());
      const dialog = await openHistory(container);
      let settings = await openSettings(dialog);
      for (const label of ['수정시간', '제목', '수정자', '상태', '버전']) {
        await userEvent.click(within(settings).getByLabelText(label));
      }
      expect(dialog).toHaveTextContent('표시할 컬럼이 없습니다');
      await userEvent.click(within(settings).getByRole('button', { name: '닫기' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '이력 목록설정' })).toBeNull());
      // 표가 없어도 컨테이너 우클릭으로 재진입할 수 있다(막다른 골목 없음).
      settings = await openSettings(dialog);
      expect(settings).toBeInTheDocument();
    });

    it('케이스14: 송고이력보기 — sendOnly 조회가 유지되고 새 모달에서 제목/버전이 렌더된다', async () => {
      const seed = histSeed();
      seed.articles[0].status = 'DPS';
      const { model, container } = setup(seed);
      const spy = vi.spyOn(model, 'queryHistory');
      await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));

      const dialog = await openHistory(container, '송고이력보기');
      expect(spy).toHaveBeenCalledWith('AKR9', { sendOnly: true });
      expect(headerTexts(dialog)).toEqual(['수정시간', '제목', '수정자', '상태', '버전']);
      expect(dialog.querySelectorAll('tbody tr')).toHaveLength(1); // send 행만
      expect(rowCells(dialog, 0)).toEqual(['2026-06-14 03:09', '헤드라인', '김기자', 'DPS', 'v2']);
    });

    it('케이스15: 기사 그룹 컬럼(작성자·작성시간)은 목록 행 값으로 모든 이력 행에 렌더되고 추가 조회가 없다', async () => {
      const { model, container } = setup(histSeed());
      const dialog = await openHistory(container);
      // 모달 오픈 이후 어떤 추가 기사 조회도 없어야 한다(목록 행 객체 재사용 — N+1 금지).
      const qa = vi.spyOn(model, 'queryArticles');
      const ga = vi.spyOn(model, 'getArticle');
      const settings = await openSettings(dialog);
      await userEvent.click(within(settings).getByLabelText('작성자'));
      await userEvent.click(within(settings).getByLabelText('작성시간'));

      expect(headerTexts(dialog)).toEqual(['수정시간', '제목', '수정자', '상태', '버전', '작성자', '작성시간']);
      const rows = dialog.querySelectorAll('tbody tr');
      expect(rows).toHaveLength(2);
      for (let i = 0; i < rows.length; i += 1) {
        const cells = rowCells(dialog, i);
        expect(cells[5]).toBe('kim'); // article.author — 모든 행 동일 반복
        expect(cells[6]).toBe('2026-06-14 01:00'); // article.createdAt(작성시간) — 이력 행 시각과 다르다
      }
      expect(qa).not.toHaveBeenCalled();
      expect(ga).not.toHaveBeenCalled();
    });

    it('케이스16: 설정 모달 백드롭이 문서 순서상 이력 모달 백드롭보다 뒤다(같은 z-index에서 위에 그려짐)', async () => {
      const { container } = setup(histSeed());
      const dialog = await openHistory(container);
      await openSettings(dialog);
      const backdrops = [...container.querySelectorAll('.yh-modal__backdrop')];
      expect(backdrops).toHaveLength(2);
      expect(within(backdrops[0]).getByRole('dialog', { name: '이력보기' })).toBeInTheDocument();
      expect(within(backdrops[backdrops.length - 1]).getByRole('dialog', { name: '이력 목록설정' }))
        .toBeInTheDocument();
    });
  });
});

// 모델 변경 신호를 발생시켜 SSE 무효화를 흉내낸다(act로 감싼다).
async function act_save(model) {
  const { act } = await import('@testing-library/react');
  await act(async () => { model.saveArticle({ title: 'new', status: 'RDS' }); });
}
