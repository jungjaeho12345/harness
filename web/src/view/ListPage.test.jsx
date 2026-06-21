import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { ListPage } from './ListPage.jsx';
import { createFakeModel } from '../test/fakeModel.js';

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

  it('KILL기사 메뉴 버튼을 보여주고(5번째 탭), 선택 시 RRK·DDK·EEK만 조회하며 부서 셀렉터가 없다', async () => {
    const { model } = setup({ articles: [] });
    expect(screen.getByRole('button', { name: 'KILL기사' })).toBeInTheDocument();
    const spy = vi.spyOn(model, 'queryArticles');
    await userEvent.click(screen.getByRole('button', { name: 'KILL기사' }));
    // KILL기사는 부서 무관 전체 KILL 목록 — 부서 키 없이 status만으로 조회한다.
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ status: ['RRK', 'DDK', 'EEK'] }));
    expect(screen.queryByTestId('dept-selector')).toBeNull();
  });

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

  it('작성시간을 YYYY-MM-DD HH:mm로 표시한다', async () => {
    const { container } = setup({ articles: rds(1) });
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    expect(container).toHaveTextContent('2026-06-14 03:09');
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
});

// 모델 변경 신호를 발생시켜 SSE 무효화를 흉내낸다(act로 감싼다).
async function act_save(model) {
  const { act } = await import('@testing-library/react');
  await act(async () => { model.saveArticle({ title: 'new', status: 'RDS' }); });
}
