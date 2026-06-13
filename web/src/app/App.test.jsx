import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import App from './App.jsx';
import { createFakeModel } from '../test/fakeModel.js';

// 복원 결과(restoreSession)를 제어하기 위해 fakeModel을 감싸 override 한다(나머지 키는 계약 충족).
function modelReturning(restore) {
  return { ...createFakeModel(), restoreSession: () => restore };
}

function go(path) {
  window.history.pushState({}, '', path);
}

describe('App — session restore gate + routing', () => {
  beforeEach(() => {
    sessionStorage.clear();
    go('/');
  });
  afterEach(() => {
    go('/');
  });

  it('does not redirect to login before restoreSession resolves', async () => {
    let resolveRestore;
    const model = modelReturning(new Promise((res) => { resolveRestore = res; }));
    go('/list.do');

    render(<App model={model} />);
    // 복원 중에는 라우트가 그려지지 않고 로딩 표시만 — login으로 강제 이동하지 않는다.
    expect(screen.getByTestId('restoring')).toBeInTheDocument();
    expect(screen.queryByTestId('route')).toBeNull();

    await act(async () => { resolveRestore({ ok: false, reason: 'unauthenticated' }); });
    await waitFor(() => expect(screen.getByTestId('route')).toBeInTheDocument());
    // 복원 결과 비로그인 → login.do.
    expect(screen.getByTestId('route')).toHaveAttribute('data-route', 'login.do');
  });

  it('routes a logged-in user to the requested page after restore', async () => {
    const model = modelReturning({ ok: true, user: { userId: 'kim', role: 'R', department: '정치' } });
    go('/writer.do');
    render(<App model={model} />);
    await waitFor(() => expect(screen.getByTestId('route')).toHaveAttribute('data-route', 'writer.do'));
  });

  it('sends an undefined path to login.do when logged out', async () => {
    const model = modelReturning({ ok: false });
    go('/totally-unknown');
    render(<App model={model} />);
    await waitFor(() => expect(screen.getByTestId('route')).toHaveAttribute('data-route', 'login.do'));
  });

  it('guards Z-only routes: a non-Z user lands on list.do', async () => {
    const model = modelReturning({ ok: true, user: { userId: 'kim', role: 'R' } });
    go('/rcvMgmt.do');
    render(<App model={model} />);
    await waitFor(() => expect(screen.getByTestId('route')).toHaveAttribute('data-route', 'list.do'));
    // 가드 리다이렉트가 주소창에도 반영된다.
    await waitFor(() => expect(window.location.pathname).toBe('/list.do'));
  });

  it('lets a Z user into a Z-only route', async () => {
    const model = modelReturning({ ok: true, user: { userId: 'boss', role: 'Z' } });
    go('/userMgmt.do');
    render(<App model={model} />);
    await waitFor(() => expect(screen.getByTestId('route')).toHaveAttribute('data-route', 'userMgmt.do'));
  });
});
