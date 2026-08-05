import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { UserMgmtPage } from './UserMgmtPage.jsx';
import { createFakeModel } from '../test/fakeModel.js';

// prepare(model): render 전에 model 메서드를 mock할 때 쓴다(마운트 시 조회 실패 재현 등).
function setup(seed, identity = { userId: 'boss', role: 'Z' }, prepare) {
  const model = createFakeModel(seed);
  prepare?.(model);
  const utils = render(
    <AppContext.Provider value={{ model, identity, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      <UserMgmtPage />
    </AppContext.Provider>,
  );
  return { model, ...utils };
}

describe('UserMgmtPage (Z 전용 CRUD)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('사용자 목록을 조회하되 비밀번호는 어디에도 표시하지 않는다', async () => {
    setup({ users: [{ userId: 'kim', name: '김기자', role: 'R', department: '정치', password: 'secret' }] });
    await waitFor(() => expect(screen.getByText('김기자')).toBeInTheDocument());
    expect(screen.queryByText('secret')).toBeNull();
  });

  it('사용자를 생성하면 createUser를 호출한다', async () => {
    const { model } = setup({ users: [] });
    const create = vi.spyOn(model, 'createUser');

    await userEvent.type(screen.getByLabelText('유저아이디'), 'lee');
    await userEvent.type(screen.getByLabelText('이름'), '이데스크');
    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'lee', name: '이데스크' })));
  });

  it('수정 시 빈 비밀번호는 변경하지 않는다(payload에서 제거)', async () => {
    const { model } = setup({ users: [{ userId: 'kim', name: '김기자', role: 'R', department: '정치' }] });
    const update = vi.spyOn(model, 'updateUser');

    await waitFor(() => expect(screen.getByText('김기자')).toBeInTheDocument());
    // 표의 수정 버튼(편집 진입) — 이 시점엔 제출 버튼이 '생성'이라 '수정'은 행 버튼뿐.
    await userEvent.click(screen.getByRole('button', { name: '수정' }));

    // 비밀번호는 빈칸으로 두고 제출(폼 내부 '수정' 버튼).
    const form = screen.getByTestId('user-form');
    await userEvent.click(within(form).getByRole('button', { name: '수정' }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    const [userId, patch] = update.mock.calls[0];
    expect(userId).toBe('kim');
    expect(patch.password).toBeUndefined();
  });

  // --- step8: 실패 인라인 표시(role="alert" · data-testid="user-error") ---

  it('생성이 거부되면 user-error에 권한 문구를 띄우고 폼을 유지한다', async () => {
    const { model } = setup({ users: [] });
    vi.spyOn(model, 'createUser').mockResolvedValue({ ok: false, reason: 'forbidden' });

    await userEvent.type(screen.getByLabelText('유저아이디'), 'lee');
    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    await waitFor(() => expect(screen.getByTestId('user-error')).toHaveTextContent('권한'));
    expect(screen.getByTestId('user-error')).toHaveAttribute('role', 'alert');
    // 실패 시 폼을 비우지 않는다 — 고쳐서 재제출할 수 있어야 한다.
    expect(screen.getByLabelText('유저아이디')).toHaveValue('lee');
  });

  it('수정이 거부되면 편집 상태와 폼을 유지한 채 user-error를 띄운다', async () => {
    const { model } = setup({ users: [{ userId: 'kim', name: '김기자', role: 'R', department: '정치' }] });
    vi.spyOn(model, 'updateUser').mockResolvedValue({ ok: false, reason: 'internal-error' });
    await waitFor(() => expect(screen.getByText('김기자')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '수정' })); // 행 버튼 — 편집 진입
    const form = screen.getByTestId('user-form');
    await userEvent.click(within(form).getByRole('button', { name: '수정' }));

    await waitFor(() => expect(screen.getByTestId('user-error')).toHaveTextContent('서버 오류'));
    // 실패 시 setForm(BLANK)/setEditing(false)를 하지 않는다 — 편집 상태·입력값 유지.
    expect(screen.getByLabelText('유저아이디')).toHaveValue('kim');
    expect(within(form).getByRole('button', { name: '수정' })).toBeInTheDocument();
  });

  it('쓰기 실패 메시지는 컨트롤러 내부 재조회가 성공해도 남는다(타이밍 회귀 가드)', async () => {
    // createUser는 실패, 컨트롤러가 내부적으로 부르는 목록 조회는 성공({ ok:true, items }) —
    // 성공한 내부 재조회가 쓰기 실패 메시지를 지우면 안 된다.
    const { model } = setup({ users: [{ userId: 'kim', name: '김기자', role: 'R', department: '정치' }] });
    vi.spyOn(model, 'createUser').mockResolvedValue({ ok: false, reason: 'forbidden' });
    await waitFor(() => expect(screen.getByText('김기자')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('유저아이디'), 'lee');
    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    expect(await screen.findByTestId('user-error')).toHaveTextContent('권한');
    // 내부 재조회는 성공했고(목록 표시 유지) 실패 메시지는 그대로 남는다.
    expect(screen.getByText('김기자')).toBeInTheDocument();
    expect(screen.getByTestId('user-error')).toHaveTextContent('권한');
  });

  it('진입 시 목록 조회가 실패하면 에러 영역에 네트워크 문구를 띄운다', async () => {
    setup({ users: [] }, undefined, (m) => {
      vi.spyOn(m, 'queryUsers').mockResolvedValue({ ok: false, reason: 'network-error' });
    });
    await waitFor(() => expect(screen.getByTestId('user-error')).toHaveTextContent('서버에 연결하지 못했습니다'));
  });

  it('실패 후 재제출이 성공하면 메시지가 사라지고 폼이 초기화된다', async () => {
    const { model } = setup({ users: [] });
    vi.spyOn(model, 'createUser').mockResolvedValueOnce({ ok: false, reason: 'forbidden' });

    await userEvent.type(screen.getByLabelText('유저아이디'), 'lee');
    await userEvent.click(screen.getByRole('button', { name: '생성' }));
    await waitFor(() => expect(screen.getByTestId('user-error')).toBeInTheDocument());

    // 두 번째 제출은 원래 fake 구현(성공)으로 떨어진다.
    await userEvent.click(screen.getByRole('button', { name: '생성' }));
    await waitFor(() => expect(screen.queryByTestId('user-error')).toBeNull());
    expect(screen.getByLabelText('유저아이디')).toHaveValue('');
  });

  it('알 수 없는 사유는 폴백 문구로 표시한다', async () => {
    const { model } = setup({ users: [] });
    vi.spyOn(model, 'createUser').mockResolvedValue({ ok: false, reason: 'weird-reason' });

    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    await waitFor(() => expect(screen.getByTestId('user-error')).toHaveTextContent('요청을 처리하지 못했습니다 (weird-reason).'));
  });

  it('실패 메시지·DOM 어디에도 입력한 비밀번호가 나타나지 않는다', async () => {
    const { model, container } = setup({ users: [] });
    vi.spyOn(model, 'createUser').mockResolvedValue({ ok: false, reason: 'forbidden' });

    await userEvent.type(screen.getByLabelText('유저아이디'), 'lee');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'secret-pw');
    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    await waitFor(() => expect(screen.getByTestId('user-error')).toBeInTheDocument());
    expect(container.textContent).not.toContain('secret-pw');
  });

  // --- phase 54 step6: 비문자열 사유 회귀 + 중복 제출 가드 ---

  it('reason 없는 실패 응답도 일반 문구로 안내한다((null)·(undefined) 노출 금지)', async () => {
    const { model } = setup({ users: [] });
    vi.spyOn(model, 'createUser').mockResolvedValue({ ok: false });

    await userEvent.click(screen.getByRole('button', { name: '생성' }));

    const err = await screen.findByTestId('user-error');
    expect(err).toHaveTextContent('요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    expect(err.textContent).not.toContain('(null)');
    expect(err.textContent).not.toContain('(undefined)');
  });

  it('진입 조회가 null을 돌려줘도 일반 문구를 띄운다', async () => {
    setup({ users: [] }, undefined, (m) => {
      vi.spyOn(m, 'queryUsers').mockResolvedValue(null);
    });
    const err = await screen.findByTestId('user-error');
    expect(err).toHaveTextContent('요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    expect(err.textContent).not.toContain('(null)');
    expect(err.textContent).not.toContain('(undefined)');
  });

  it('제출 중 재클릭은 무시된다 — 더블클릭이 사용자를 두 벌 만들지 않는다', async () => {
    const { model } = setup({ users: [] });
    let resolveCreate;
    const create = vi.spyOn(model, 'createUser')
      .mockImplementation(() => new Promise((res) => { resolveCreate = res; }));

    await userEvent.type(screen.getByLabelText('유저아이디'), 'lee');
    const btn = screen.getByRole('button', { name: '생성' });
    await userEvent.click(btn);
    await userEvent.click(btn); // 더블클릭 — in-flight 가드가 막아야 한다.

    expect(create).toHaveBeenCalledTimes(1);
    expect(btn).toBeDisabled();

    await act(async () => { resolveCreate({ ok: true }); });
    await waitFor(() => expect(screen.getByLabelText('유저아이디')).toHaveValue(''));
    expect(btn).toBeEnabled();
  });

  it('수정 제출도 더블클릭에서 한 번만 나간다', async () => {
    const { model } = setup({ users: [{ userId: 'kim', name: '김기자', role: 'R', department: '정치' }] });
    let resolveUpdate;
    const update = vi.spyOn(model, 'updateUser')
      .mockImplementation(() => new Promise((res) => { resolveUpdate = res; }));
    await waitFor(() => expect(screen.getByText('김기자')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '수정' })); // 행 버튼 — 편집 진입
    const submit = within(screen.getByTestId('user-form')).getByRole('button', { name: '수정' });
    await userEvent.click(submit);
    await userEvent.click(submit);

    expect(update).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();

    await act(async () => { resolveUpdate({ ok: true }); });
    await waitFor(() => expect(screen.getByLabelText('유저아이디')).toHaveValue(''));
  });

  it('버튼 disabled를 우회한 연속 submit 이벤트도 1회만 요청한다(핸들러 가드)', async () => {
    const { model } = setup({ users: [] });
    let resolveCreate;
    const create = vi.spyOn(model, 'createUser')
      .mockImplementation(() => new Promise((res) => { resolveCreate = res; }));

    const form = screen.getByTestId('user-form');
    fireEvent.submit(form);
    fireEvent.submit(form); // Enter 연타·프로그램적 제출 — disabled 버튼으로는 막지 못하는 경로.

    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => { resolveCreate({ ok: true }); });
  });

  it('실패로 끝난 뒤에는 다시 제출할 수 있다(영구 잠금 아님)', async () => {
    const { model } = setup({ users: [] });
    const create = vi.spyOn(model, 'createUser').mockResolvedValue({ ok: false, reason: 'forbidden' });

    await userEvent.type(screen.getByLabelText('유저아이디'), 'lee');
    await userEvent.click(screen.getByRole('button', { name: '생성' }));
    await waitFor(() => expect(screen.getByTestId('user-error')).toHaveTextContent('권한'));
    expect(screen.getByRole('button', { name: '생성' })).toBeEnabled();
    expect(screen.getByLabelText('유저아이디')).toHaveValue('lee');

    await userEvent.click(screen.getByRole('button', { name: '생성' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });

  it('수정 진입(행 버튼)은 제출 가드와 무관하게 동작한다', async () => {
    setup({ users: [{ userId: 'kim', name: '김기자', role: 'R', department: '정치' }] });
    await waitFor(() => expect(screen.getByText('김기자')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '수정' }));

    expect(screen.getByLabelText('유저아이디')).toHaveValue('kim');
    expect(screen.getByLabelText(/비밀번호/)).toHaveValue(''); // 비밀번호는 항상 빈칸.
    expect(within(screen.getByTestId('user-form')).getByRole('button', { name: '수정' })).toBeEnabled();
  });
});
