import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { DistMgmtPage } from './DistMgmtPage.jsx';
import { createFakeModel } from '../test/fakeModel.js';

// seed 행에는 active를 명시한다(fakeModel은 seed를 stamp하지 않는다). 매 테스트 새 객체를 만든다.
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

// prepare(model): render 전에 model 메서드를 mock할 때 쓴다(마운트 시 조회 실패 재현 등).
function setup(seed = { distributionTargets: seedRows() }, identity = { userId: 'boss', role: 'Z' }, prepare) {
  const model = createFakeModel(seed);
  prepare?.(model);
  const utils = render(
    <AppContext.Provider value={{ model, identity, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      <DistMgmtPage />
    </AppContext.Provider>,
  );
  return { model, ...utils };
}

describe('DistMgmtPage (Z 전용 배부 대상 관리)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('마운트 시 목록을 조회하고 비활성 행도 함께 표시한다', async () => {
    setup();
    await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());
    // 비활성(active='N') 행을 숨기지 않는다 — 재활성화 대상이다.
    expect(screen.getByText('나다협회')).toBeInTheDocument();
    expect(within(screen.getByTestId('dist-row-8')).getByText('N')).toBeInTheDocument();
  });

  it('유형을 한글 라벨(언론사/비언론사)로 표시한다', async () => {
    setup();
    await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());
    expect(within(screen.getByTestId('dist-row-7')).getByText('언론사')).toBeInTheDocument();
    expect(within(screen.getByTestId('dist-row-8')).getByText('비언론사')).toBeInTheDocument();
  });

  it('미지의 kind 값은 원문 그대로 표시한다', async () => {
    setup({ distributionTargets: [{ id: 9, name: '마바사', kind: 'wire', spoolDir: 'mabasa', active: 'Y' }] });
    await waitFor(() => expect(screen.getByText('마바사')).toBeInTheDocument());
    expect(within(screen.getByTestId('dist-row-9')).getByText('wire')).toBeInTheDocument();
  });

  it('등록하면 createDistributionTarget을 호출하고 폼을 초기화한다', async () => {
    const { model } = setup({ distributionTargets: [] });
    const create = vi.spyOn(model, 'createDistributionTarget');

    await userEvent.type(screen.getByLabelText('수신처명'), '다라방송');
    await userEvent.selectOptions(screen.getByLabelText('유형'), 'nonpress');
    await userEvent.type(screen.getByLabelText('스풀 폴더'), 'darabc');
    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    // id·타임스탬프는 서버가 정한다 — 폼이 싣는 필드는 정확히 4개다.
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      name: '다라방송', kind: 'nonpress', spoolDir: 'darabc', active: 'Y',
    }));
    await waitFor(() => expect(screen.getByLabelText('수신처명')).toHaveValue(''));
    expect(screen.getByLabelText('스풀 폴더')).toHaveValue('');
    expect(screen.getByLabelText('유형')).toHaveValue('press');
  });

  it('수정 버튼이 폼에 값을 채우고 제출 시 updateDistributionTarget(id, fields)를 호출한다', async () => {
    const { model } = setup();
    const update = vi.spyOn(model, 'updateDistributionTarget');
    await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());

    // 편집 진입 전 제출 버튼은 '생성'이라 표의 '수정' 버튼만 잡힌다.
    await userEvent.click(within(screen.getByTestId('dist-row-7')).getByRole('button', { name: '수정' }));

    expect(screen.getByLabelText('수신처명')).toHaveValue('가나일보');
    expect(screen.getByLabelText('유형')).toHaveValue('press');
    expect(screen.getByLabelText('스풀 폴더')).toHaveValue('gana');
    expect(screen.getByLabelText('활성')).toHaveValue('Y');

    const form = screen.getByTestId('dist-form');
    await userEvent.clear(screen.getByLabelText('수신처명'));
    await userEvent.type(screen.getByLabelText('수신처명'), '가나일보(수정)');
    await userEvent.click(within(form).getByRole('button', { name: '수정' }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    const [id, fields] = update.mock.calls[0];
    expect(id).toBe(7); // 행 객체에서 온 숫자 id — 서버·fake 모두 엄격 비교다.
    expect(fields).toEqual({ name: '가나일보(수정)', kind: 'press', spoolDir: 'gana', active: 'Y' });
    expect(fields.id).toBeUndefined(); // id는 body에 싣지 않는다.
  });

  it('수정 폼의 활성 select로 비활성 행을 재활성화한다', async () => {
    const { model } = setup();
    const update = vi.spyOn(model, 'updateDistributionTarget');
    await waitFor(() => expect(screen.getByText('나다협회')).toBeInTheDocument());

    await userEvent.click(within(screen.getByTestId('dist-row-8')).getByRole('button', { name: '수정' }));
    expect(screen.getByLabelText('활성')).toHaveValue('N');
    await userEvent.selectOptions(screen.getByLabelText('활성'), 'Y');
    await userEvent.click(within(screen.getByTestId('dist-form')).getByRole('button', { name: '수정' }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(8, expect.objectContaining({ active: 'Y' })));
    await waitFor(() => expect(within(screen.getByTestId('dist-row-8')).getByText('Y')).toBeInTheDocument());
  });

  it('취소 버튼이 편집 모드를 벗어나 폼을 초기화한다', async () => {
    setup();
    await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '취소' })).toBeNull();

    await userEvent.click(within(screen.getByTestId('dist-row-7')).getByRole('button', { name: '수정' }));
    await userEvent.click(screen.getByRole('button', { name: '취소' }));

    expect(screen.getByLabelText('수신처명')).toHaveValue('');
    expect(within(screen.getByTestId('dist-form')).getByRole('button', { name: '생성' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '취소' })).toBeNull();
  });

  it('비활성 버튼은 행을 지우지 않고 활성 열만 N으로 바꾼다', async () => {
    const { model } = setup();
    const deactivate = vi.spyOn(model, 'deactivateDistributionTarget');
    await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());

    await userEvent.click(within(screen.getByTestId('dist-row-7')).getByRole('button', { name: '비활성' }));

    expect(deactivate).toHaveBeenCalledWith(7);
    // 행이 목록에 남는다(soft delete — DB 비파괴).
    await waitFor(() => expect(within(screen.getByTestId('dist-row-7')).getByText('N')).toBeInTheDocument());
    expect(screen.getByText('가나일보')).toBeInTheDocument();
  });

  it('이미 비활성인 행에는 비활성 버튼이 없다(수정 폼으로만 재활성화)', async () => {
    setup();
    await waitFor(() => expect(screen.getByText('나다협회')).toBeInTheDocument());

    const inactive = within(screen.getByTestId('dist-row-8'));
    expect(inactive.queryByRole('button', { name: '비활성' })).toBeNull();
    expect(inactive.getByRole('button', { name: '수정' })).toBeInTheDocument();
  });

  it('삭제 버튼이 존재하지 않는다(서버에 삭제 경로가 없다 — 회귀 가드)', async () => {
    const { model } = setup();
    await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '삭제' })).toBeNull();
    expect(model.deleteDistributionTarget).toBeUndefined();
  });

  it('서버 거부 사유를 한글 메시지로 보여주고 입력값을 유지한다', async () => {
    const { model } = setup({ distributionTargets: [] });
    vi.spyOn(model, 'createDistributionTarget').mockResolvedValueOnce({ ok: false, reason: 'duplicate-spool-dir' });

    await userEvent.type(screen.getByLabelText('수신처명'), '다라방송');
    await userEvent.type(screen.getByLabelText('스풀 폴더'), 'gana');
    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    await waitFor(() => expect(screen.getByTestId('dist-error')).toHaveTextContent('이미 사용 중인 스풀 폴더'));
    // 실패 시 폼을 비우지 않는다 — 고쳐서 재제출할 수 있어야 한다.
    expect(screen.getByLabelText('수신처명')).toHaveValue('다라방송');

    // 재제출이 성공하면 메시지가 사라지고 폼이 초기화된다.
    await userEvent.clear(screen.getByLabelText('스풀 폴더'));
    await userEvent.type(screen.getByLabelText('스풀 폴더'), 'darabc');
    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    await waitFor(() => expect(screen.queryByTestId('dist-error')).toBeNull());
    expect(screen.getByLabelText('수신처명')).toHaveValue('');
  });

  it('나머지 거부 사유도 각각의 안내 문구로 표시한다', async () => {
    const reasons = [
      ['unauthenticated', '로그인'],
      ['forbidden', '권한'],
      ['not-found', '찾을 수 없'],
      ['invalid-name', '수신처명'],
      ['invalid-kind', '유형'],
      ['invalid-spool-dir', '스풀 폴더'],
      ['invalid-active', '활성'],
      // step8: 전역 에러 핸들러·httpModel 정규화 토큰도 안내 문구로 매핑한다.
      ['internal-error', '서버 오류'],
      ['network-error', '연결하지 못했습니다'],
      ['invalid-response', '서버 응답'],
    ];
    for (const [reason, needle] of reasons) {
      const { model, unmount } = setup({ distributionTargets: [] });
      vi.spyOn(model, 'createDistributionTarget').mockResolvedValue({ ok: false, reason });
      await userEvent.click(screen.getByRole('button', { name: '생성' }));
      await waitFor(() => expect(screen.getByTestId('dist-error')).toHaveTextContent(needle));
      unmount();
    }
  });

  it('알 수 없는 사유는 원문 reason을 그대로 노출한다', async () => {
    const { model } = setup({ distributionTargets: [] });
    vi.spyOn(model, 'createDistributionTarget').mockResolvedValue({ ok: false, reason: 'teapot' });

    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    await waitFor(() => expect(screen.getByTestId('dist-error')).toHaveTextContent('teapot'));
  });

  it('비활성 실패 사유도 같은 자리에 표시한다', async () => {
    const { model } = setup();
    vi.spyOn(model, 'deactivateDistributionTarget').mockResolvedValue({ ok: false, reason: 'forbidden' });
    await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());

    await userEvent.click(within(screen.getByTestId('dist-row-7')).getByRole('button', { name: '비활성' }));

    await waitFor(() => expect(screen.getByTestId('dist-error')).toHaveTextContent('권한'));
  });

  // --- step8: 조회 실패 표시 + 쓰기 실패 메시지 타이밍 회귀 가드 ---

  it('진입 시 목록 조회가 실패하면 에러 영역에 네트워크 문구를 띄운다', async () => {
    setup({ distributionTargets: [] }, undefined, (m) => {
      vi.spyOn(m, 'queryDistributionTargets').mockResolvedValue({ ok: false, reason: 'network-error' });
    });
    await waitFor(() => expect(screen.getByTestId('dist-error')).toHaveTextContent('서버에 연결하지 못했습니다'));
  });

  it('쓰기 실패 메시지는 컨트롤러 내부 재조회가 성공해도 남는다(타이밍 회귀 가드)', async () => {
    // createTarget은 실패, 컨트롤러가 내부적으로 부르는 목록 조회는 성공({ ok:true, items }) —
    // 성공한 내부 재조회가 쓰기 실패 메시지를 지우면 안 된다.
    const { model } = setup();
    vi.spyOn(model, 'createDistributionTarget').mockResolvedValue({ ok: false, reason: 'forbidden' });
    await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    expect(await screen.findByTestId('dist-error')).toHaveTextContent('권한');
    // 내부 재조회는 성공했고(목록 표시 유지) 실패 메시지는 그대로 남는다.
    expect(screen.getByText('가나일보')).toBeInTheDocument();
    expect(screen.getByTestId('dist-error')).toHaveTextContent('권한');
  });

  // --- phase 54 step6: 비문자열 사유 회귀 + 중복 제출 가드 ---

  it('reason 없는 실패 응답도 일반 문구로 안내한다((null)·(undefined) 노출 금지)', async () => {
    const { model } = setup({ distributionTargets: [] });
    vi.spyOn(model, 'createDistributionTarget').mockResolvedValue({ ok: false });

    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    const err = await screen.findByTestId('dist-error');
    expect(err).toHaveTextContent('요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    expect(err.textContent).not.toContain('(null)');
    expect(err.textContent).not.toContain('(undefined)');
  });

  it('진입 조회가 null을 돌려줘도 일반 문구를 띄운다', async () => {
    setup({ distributionTargets: [] }, undefined, (m) => {
      vi.spyOn(m, 'queryDistributionTargets').mockResolvedValue(null);
    });
    const err = await screen.findByTestId('dist-error');
    expect(err).toHaveTextContent('요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    expect(err.textContent).not.toContain('(null)');
    expect(err.textContent).not.toContain('(undefined)');
  });

  it('제출 중 재클릭은 무시된다 — 더블클릭이 대상을 두 벌 만들지 않는다', async () => {
    const { model } = setup({ distributionTargets: [] });
    let resolveCreate;
    const create = vi.spyOn(model, 'createDistributionTarget')
      .mockImplementation(() => new Promise((res) => { resolveCreate = res; }));

    await userEvent.type(screen.getByLabelText('수신처명'), '다라방송');
    await userEvent.type(screen.getByLabelText('스풀 폴더'), 'darabc');
    const btn = screen.getByRole('button', { name: '생성' });
    await userEvent.click(btn);
    await userEvent.click(btn); // 더블클릭 — in-flight 가드가 막아야 한다.

    expect(create).toHaveBeenCalledTimes(1);
    expect(btn).toBeDisabled();

    await act(async () => { resolveCreate({ ok: true }); });
    await waitFor(() => expect(screen.getByLabelText('수신처명')).toHaveValue(''));
    expect(btn).toBeEnabled();
  });

  it('수정 제출도 더블클릭에서 한 번만 나간다', async () => {
    const { model } = setup();
    let resolveUpdate;
    const update = vi.spyOn(model, 'updateDistributionTarget')
      .mockImplementation(() => new Promise((res) => { resolveUpdate = res; }));
    await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());

    await userEvent.click(within(screen.getByTestId('dist-row-7')).getByRole('button', { name: '수정' }));
    const submit = within(screen.getByTestId('dist-form')).getByRole('button', { name: '수정' });
    await userEvent.click(submit);
    await userEvent.click(submit);

    expect(update).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();

    await act(async () => { resolveUpdate({ ok: true }); });
    await waitFor(() => expect(screen.getByLabelText('수신처명')).toHaveValue(''));
  });

  it('버튼 disabled를 우회한 연속 submit 이벤트도 1회만 요청한다(핸들러 가드)', async () => {
    const { model } = setup({ distributionTargets: [] });
    let resolveCreate;
    const create = vi.spyOn(model, 'createDistributionTarget')
      .mockImplementation(() => new Promise((res) => { resolveCreate = res; }));

    const form = screen.getByTestId('dist-form');
    fireEvent.submit(form);
    fireEvent.submit(form); // Enter 연타·프로그램적 제출 — disabled 버튼으로는 막지 못하는 경로.

    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => { resolveCreate({ ok: true }); });
  });

  it('실패로 끝난 뒤에는 다시 제출할 수 있다(영구 잠금 아님)', async () => {
    const { model } = setup({ distributionTargets: [] });
    const create = vi.spyOn(model, 'createDistributionTarget').mockResolvedValue({ ok: false, reason: 'invalid-name' });

    await userEvent.type(screen.getByLabelText('수신처명'), '다라방송');
    await userEvent.click(screen.getByRole('button', { name: '생성' }));
    await waitFor(() => expect(screen.getByTestId('dist-error')).toHaveTextContent('수신처명'));
    expect(screen.getByRole('button', { name: '생성' })).toBeEnabled();
    expect(screen.getByLabelText('수신처명')).toHaveValue('다라방송');

    await userEvent.click(screen.getByRole('button', { name: '생성' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });

  it('비활성 버튼에는 제출 가드가 걸리지 않는다(연속 비활성 가능)', async () => {
    const { model } = setup();
    const deactivate = vi.spyOn(model, 'deactivateDistributionTarget');
    await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());

    await userEvent.click(within(screen.getByTestId('dist-row-7')).getByRole('button', { name: '비활성' }));
    await waitFor(() => expect(within(screen.getByTestId('dist-row-7')).getByText('N')).toBeInTheDocument());
    // 재활성화 후 다시 비활성 — 가드가 남아 있으면 두 번째 호출이 막힌다.
    await userEvent.click(within(screen.getByTestId('dist-row-8')).getByRole('button', { name: '수정' }));
    await userEvent.selectOptions(screen.getByLabelText('활성'), 'Y');
    await userEvent.click(within(screen.getByTestId('dist-form')).getByRole('button', { name: '수정' }));
    await waitFor(() => expect(within(screen.getByTestId('dist-row-8')).getByText('Y')).toBeInTheDocument());
    await userEvent.click(within(screen.getByTestId('dist-row-8')).getByRole('button', { name: '비활성' }));

    await waitFor(() => expect(deactivate).toHaveBeenCalledTimes(2));
  });

  // --- phase 57 MVP-4: 미해소 배부 실패 목록 + 재전송 + 수동 tick ---

  // 서버 list 응답 shape 그대로(spoolDir/파일 경로 없음). 매 테스트 새 객체.
  const seedFailures = () => ([
    {
      articleId: 'AKR1', targetId: 3, kind: 'press', reason: 'spool-write-failed',
      failedAt: '2026-08-01T09:30:00.000Z', historyId: 11,
      targetName: '가나일보', targetActive: 'Y', targetKind: 'press', kindDistributed: true,
    },
    {
      articleId: 'AKR2', targetId: 4, kind: 'nonpress', reason: 'invalid-spool-dir',
      failedAt: '2026-08-02T10:00:00.000Z', historyId: 12,
      targetName: '나다협회', targetActive: 'Y', targetKind: 'nonpress', kindDistributed: true,
    },
  ]);
  const failSeed = () => ({ distributionTargets: seedRows(), distributionFailures: seedFailures() });

  describe('배부 실패 목록 · 재전송 · 수동 tick', () => {
    it('진입 시 배부 대상 목록과 실패 목록을 함께 조회한다', async () => {
      let targetsSpy;
      let failuresSpy;
      setup(failSeed(), undefined, (m) => {
        targetsSpy = vi.spyOn(m, 'queryDistributionTargets');
        failuresSpy = vi.spyOn(m, 'queryDistributionFailures');
      });
      await waitFor(() => expect(screen.getByTestId('dist-fail-row-11')).toBeInTheDocument());
      expect(targetsSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(failuresSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('실패 항목이 표에 렌더된다(기사아이디·수신처명·유형 한글 라벨·사유 한글 문구·실패시각)', async () => {
      setup(failSeed());
      const row = within(await screen.findByTestId('dist-fail-row-11'));
      expect(row.getByText('AKR1')).toBeInTheDocument();
      expect(row.getByText('가나일보')).toBeInTheDocument();
      expect(row.getByText('언론사')).toBeInTheDocument();
      // 사유는 reasonMessage()를 거친 한글 문구다 — 영문 토큰을 그대로 노출하지 않는다(코드리뷰 반려 [low]).
      expect(row.getByText(/스풀 기록에 실패/)).toBeInTheDocument();
      expect(row.queryByText('spool-write-failed')).toBeNull();
      expect(row.getByText('2026-08-01 09:30')).toBeInTheDocument(); // formatDateTime 기본 형식과 동형.
      expect(within(screen.getByTestId('dist-fail-row-12')).getByText('비언론사')).toBeInTheDocument();
      expect(within(screen.getByTestId('dist-fail-row-12')).queryByText('invalid-spool-dir')).toBeNull();
    });

    it('실패 표 사유: 알려진 토큰 3종 전부 한글 문구, 미지 토큰은 원문 단서를 유지한다', async () => {
      setup({
        distributionTargets: seedRows(),
        distributionFailures: [
          { ...seedFailures()[0], historyId: 21, reason: 'spool-write-failed' },
          { ...seedFailures()[0], historyId: 22, reason: 'invalid-spool-dir' },
          { ...seedFailures()[0], historyId: 23, reason: 'invalid-article-id' },
          { ...seedFailures()[0], historyId: 24, reason: 'mystery-token' },
        ],
      });
      await screen.findByTestId('dist-fail-row-21');
      expect(within(screen.getByTestId('dist-fail-row-21')).getByText(/스풀 기록에 실패/)).toBeInTheDocument();
      expect(within(screen.getByTestId('dist-fail-row-22')).getByText(/스풀 폴더/)).toBeInTheDocument();
      expect(within(screen.getByTestId('dist-fail-row-23')).getByText(/기사 ID/)).toBeInTheDocument();
      // 미지 토큰은 mgmtMessages 규약대로 원문을 단서로 남긴다(운영자가 새 서버 사유를 발견하는 경로).
      expect(within(screen.getByTestId('dist-fail-row-24')).getByText(/mystery-token/)).toBeInTheDocument();
    });

    it('실패 0건이면 안내 문구가 보이고 실패 행이 렌더되지 않는다', async () => {
      setup();
      await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());
      expect(screen.getByText('배부 실패가 없습니다.')).toBeInTheDocument();
      expect(document.querySelector('[data-testid^="dist-fail-row-"]')).toBeNull();
    });

    it('실패 조회가 forbidden이면 오류 문구가 alert로 보인다', async () => {
      setup({ distributionTargets: seedRows() }, undefined, (m) => {
        vi.spyOn(m, 'queryDistributionFailures').mockResolvedValue({ ok: false, reason: 'forbidden' });
      });
      const err = await screen.findByTestId('dist-fail-error');
      expect(err).toHaveTextContent('권한');
      expect(err).toHaveAttribute('role', 'alert');
    });

    it('재전송 클릭 → confirm 승인 시 retryDistribution이 (historyId)로 호출된다 — 목록의 키 그대로', async () => {
      const { model } = setup(failSeed());
      const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      const retry = vi.spyOn(model, 'retryDistribution');

      const row = within(await screen.findByTestId('dist-fail-row-11'));
      await userEvent.click(row.getByRole('button', { name: '재전송' }));

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(retry).toHaveBeenCalledWith(11));
    });

    it('confirm 취소 시 재전송 호출 0회', async () => {
      const { model } = setup(failSeed());
      vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
      const retry = vi.spyOn(model, 'retryDistribution');

      const row = within(await screen.findByTestId('dist-fail-row-11'));
      await userEvent.click(row.getByRole('button', { name: '재전송' }));

      expect(retry).not.toHaveBeenCalled();
      expect(screen.getByTestId('dist-fail-row-11')).toBeInTheDocument();
    });

    it('재전송 성공 후 그 행이 목록에서 사라진다(컨트롤러 재조회 경유)', async () => {
      setup(failSeed());
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);

      const row = within(await screen.findByTestId('dist-fail-row-11'));
      await userEvent.click(row.getByRole('button', { name: '재전송' }));

      await waitFor(() => expect(screen.queryByTestId('dist-fail-row-11')).toBeNull());
      expect(screen.getByTestId('dist-fail-row-12')).toBeInTheDocument();
    });

    it('재전송 실패(status-changed)면 그 사유의 한글 문구가 보이고 행은 남는다', async () => {
      const { model } = setup(failSeed());
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      vi.spyOn(model, 'retryDistribution').mockResolvedValue({ ok: false, reason: 'status-changed' });

      const row = within(await screen.findByTestId('dist-fail-row-11'));
      await userEvent.click(row.getByRole('button', { name: '재전송' }));

      await waitFor(() => expect(screen.getByTestId('dist-fail-error')).toHaveTextContent('기사 상태가 배부할 수 없는 상태'));
      expect(screen.getByTestId('dist-fail-row-11')).toBeInTheDocument();
    });

    it('비활성 수신처 항목은 재전송 버튼이 disabled이고 비활성 안내가 보인다(서버 inactive 거부의 이중 방어)', async () => {
      setup({ distributionTargets: seedRows(), distributionFailures: [{ ...seedFailures()[0], targetActive: 'N' }] });
      const row = within(await screen.findByTestId('dist-fail-row-11'));
      expect(row.getByRole('button', { name: '재전송' })).toBeDisabled();
      expect(row.getByText(/비활성 수신처/)).toBeInTheDocument();
    });

    it('수신처 유형이 실패 당시와 다르면 재전송 버튼이 disabled이고 유형 변경 안내가 보인다(kind-changed 이중 방어)', async () => {
      setup({ distributionTargets: seedRows(), distributionFailures: [{ ...seedFailures()[0], targetKind: 'nonpress' }] });
      const row = within(await screen.findByTestId('dist-fail-row-11'));
      expect(row.getByRole('button', { name: '재전송' })).toBeDisabled();
      expect(row.getByText(/유형이 실패 당시와 달라/)).toBeInTheDocument();
    });

    it('대상 행이 사라진 항목(targetKind null)은 유형 변경 오안내가 아니라 찾을 수 없음 안내다(방어 분기)', async () => {
      setup({
        distributionTargets: seedRows(),
        distributionFailures: [{ ...seedFailures()[0], targetName: null, targetActive: 'N', targetKind: null }],
      });
      const row = within(await screen.findByTestId('dist-fail-row-11'));
      expect(row.getByRole('button', { name: '재전송' })).toBeDisabled();
      expect(row.getByText(/수신처 정보를 찾을 수 없습니다/)).toBeInTheDocument();
      expect(row.queryByText(/유형이 실패 당시와 달라/)).toBeNull();
      expect(row.queryByText(/비활성 수신처/)).toBeNull();
    });

    it('서버가 kind-changed로 거부하면 그 한글 문구가 보인다(화면 가드 우회 대비 — 서버가 진실)', async () => {
      const { model } = setup(failSeed());
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      vi.spyOn(model, 'retryDistribution').mockResolvedValue({ ok: false, reason: 'kind-changed' });

      const row = within(await screen.findByTestId('dist-fail-row-11'));
      await userEvent.click(row.getByRole('button', { name: '재전송' }));

      await waitFor(() => expect(screen.getByTestId('dist-fail-error')).toHaveTextContent('유형이 실패 당시와 달라'));
    });

    it('서버가 stale-cycle로 거부하면 재송고 사이클 안내 한글 문구가 보인다 (코드리뷰 반려 [high] 어휘)', async () => {
      const { model } = setup(failSeed());
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      vi.spyOn(model, 'retryDistribution').mockResolvedValue({ ok: false, reason: 'stale-cycle' });

      const row = within(await screen.findByTestId('dist-fail-row-11'));
      await userEvent.click(row.getByRole('button', { name: '재전송' }));

      const err = await screen.findByTestId('dist-fail-error');
      expect(err).toHaveTextContent('재송고');
      expect(err.textContent).not.toContain('stale-cycle');
    });

    it('서버가 retry-in-flight로 거부하면 진행 중 안내 한글 문구가 보인다 (동시 재전송 어휘)', async () => {
      const { model } = setup(failSeed());
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      vi.spyOn(model, 'retryDistribution').mockResolvedValue({ ok: false, reason: 'retry-in-flight' });

      const row = within(await screen.findByTestId('dist-fail-row-11'));
      await userEvent.click(row.getByRole('button', { name: '재전송' }));

      const err = await screen.findByTestId('dist-fail-error');
      expect(err).toHaveTextContent('진행 중');
      expect(err.textContent).not.toContain('retry-in-flight');
    });

    it('kindDistributed=false 항목의 확인창에만 중복 배부 경고가 포함된다', async () => {
      setup({ distributionTargets: seedRows(), distributionFailures: [{ ...seedFailures()[0], kindDistributed: false }] });
      const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false); // 문구만 확인.

      const row = within(await screen.findByTestId('dist-fail-row-11'));
      await userEvent.click(row.getByRole('button', { name: '재전송' }));

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      const msg = confirmSpy.mock.calls[0][0];
      expect(msg).toContain('미배부로 기록');
      expect(msg).toContain('전 대상에 배부');
    });

    it('kindDistributed=true 항목의 확인창에는 중복 배부 경고가 없다(경고 남발 금지)', async () => {
      setup(failSeed()); // kindDistributed: true
      const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);

      const row = within(await screen.findByTestId('dist-fail-row-11'));
      await userEvent.click(row.getByRole('button', { name: '재전송' }));

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(confirmSpy.mock.calls[0][0]).not.toContain('미배부로 기록');
    });

    it('재전송 연타로 retryDistribution이 2회 호출되지 않는다(in-flight 가드)', async () => {
      const { model } = setup(failSeed());
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      let resolveRetry;
      const retry = vi.spyOn(model, 'retryDistribution')
        .mockImplementation(() => new Promise((res) => { resolveRetry = res; }));

      const row = within(await screen.findByTestId('dist-fail-row-11'));
      const btn = row.getByRole('button', { name: '재전송' });
      await userEvent.click(btn);
      await userEvent.click(btn); // 연타 — in-flight 가드가 막아야 한다.

      expect(retry).toHaveBeenCalledTimes(1);
      expect(btn).toBeDisabled();

      await act(async () => { resolveRetry({ ok: true }); });
      await waitFor(() => expect(row.getByRole('button', { name: '재전송' })).toBeEnabled());
    });

    it('tick 버튼 → confirm 취소 시 0회, 승인 시 인자 없이 1회 호출된다', async () => {
      const { model } = setup();
      const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
      const tick = vi.spyOn(model, 'runDistributionTick');
      await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());

      const btn = screen.getByRole('button', { name: '배부 실행(tick)' });
      await userEvent.click(btn);
      expect(tick).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      await userEvent.click(btn);
      await waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
      expect(tick).toHaveBeenCalledWith(); // 인자 없음 — 파라미터를 클라가 정하면 엠바고 무력화.
    });

    it('tick 성공 후 스캔·배부·실패 건수 요약이 응답 값과 일치한다', async () => {
      setup({
        distributionTargets: seedRows(),
        tickResult: {
          ok: true, at: '2026-08-06T01:00:00.000Z', scanned: 5,
          distributed: [
            { articleId: 'AKR1', kinds: ['press'], status: 'DPS' },
            { articleId: 'AKR2', kinds: ['press', 'nonpress'], status: 'DPS' },
          ],
          failed: [{ articleId: 'AKR3', targetId: 4, kind: 'press', reason: 'spool-write-failed' }],
          invalid: [],
        },
      });
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: '배부 실행(tick)' }));

      const summary = await screen.findByTestId('dist-tick-summary');
      expect(summary).toHaveTextContent('스캔 5건');
      expect(summary).toHaveTextContent('배부 2건');
      expect(summary).toHaveTextContent('실패 1건');
    });

    it('tick이 spool-disabled면 스풀 미설정 문구가 보인다', async () => {
      const { model } = setup();
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      vi.spyOn(model, 'runDistributionTick').mockResolvedValue({ ok: false, reason: 'spool-disabled' });
      await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: '배부 실행(tick)' }));

      await waitFor(() => expect(screen.getByTestId('dist-tick-error')).toHaveTextContent('배부 스풀이 설정되지 않았습니다'));
    });

    it('tick 응답에 skipped:in-progress가 있으면 이미 실행 중 안내가 보인다(무음 금지)', async () => {
      setup({
        distributionTargets: seedRows(),
        tickResult: { ok: true, at: 't', scanned: 0, distributed: [], failed: [], invalid: [], skipped: 'in-progress' },
      });
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: '배부 실행(tick)' }));

      await waitFor(() => expect(screen.getByTestId('dist-tick-summary')).toHaveTextContent('이미 실행 중'));
    });

    it('tick 실행 중 버튼이 disabled — 연타로 2회 호출되지 않는다', async () => {
      const { model } = setup();
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      let resolveTick;
      const tick = vi.spyOn(model, 'runDistributionTick')
        .mockImplementation(() => new Promise((res) => { resolveTick = res; }));
      await waitFor(() => expect(screen.getByText('가나일보')).toBeInTheDocument());

      const btn = screen.getByRole('button', { name: '배부 실행(tick)' });
      await userEvent.click(btn);
      await userEvent.click(btn);

      expect(tick).toHaveBeenCalledTimes(1);
      expect(btn).toBeDisabled();

      await act(async () => {
        resolveTick({ ok: true, at: 't', scanned: 0, distributed: [], failed: [], invalid: [] });
      });
      await waitFor(() => expect(btn).toBeEnabled());
    });

    it('tick 실행 후 실패 목록이 재조회된다(tick이 새 실패를 만들었을 수 있다)', async () => {
      const { model } = setup(failSeed());
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      await screen.findByTestId('dist-fail-row-11'); // 진입 조회 완료 후 스파이 설치.
      const failSpy = vi.spyOn(model, 'queryDistributionFailures');

      await userEvent.click(screen.getByRole('button', { name: '배부 실행(tick)' }));

      await waitFor(() => expect(failSpy).toHaveBeenCalledTimes(1));
    });

    it('실패 표 서브트리에는 스풀 경로·폴더 슬러그가 없다(응답 위생이 화면까지 유지 — 대상 표의 spoolDir 표시는 기존 계약)', async () => {
      setup(failSeed());
      await screen.findByTestId('dist-fail-row-11');

      const rows = document.querySelectorAll('[data-testid^="dist-fail-row-"]');
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.textContent).not.toContain('gana'); // 배부 대상 표에는 있는 슬러그가 실패 표엔 없다.
        expect(row.textContent).not.toContain('nada');
        expect(row.textContent).not.toMatch(/spoolDir|DIST_SPOOL/i);
      }
      // 배부 대상 표의 spoolDir 슬러그 표시는 Z 전용 기존 계약 그대로다(이 단언의 스코프 밖).
      expect(within(screen.getByTestId('dist-row-7')).getByText('gana')).toBeInTheDocument();
    });
  });
});
