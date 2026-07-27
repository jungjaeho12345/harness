import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

function setup(seed = { distributionTargets: seedRows() }, identity = { userId: 'boss', role: 'Z' }) {
  const model = createFakeModel(seed);
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
});
