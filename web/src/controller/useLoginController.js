// 로그인/로그아웃 컨트롤러 — Model만 호출한다(transport 직접 호출 금지, ADR-003).
// 성공 시 신원을 컨텍스트에 반영하고 기사 작성페이지(writer.do)로 이동한다(news.md 로그인 워크플로우).
// 실패 시 알림 신호(error)를 노출한다(ALERT 표시는 View 책임 — step12).

import { useCallback, useState } from 'react';
import { useAppContext } from '../app/context.js';

export function useLoginController() {
  const { model, navigate, setSession } = useAppContext();
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  const login = useCallback(async (userId, password) => {
    setPending(true);
    setError(null);
    const r = await model.login(userId, password);
    setPending(false);
    if (r && r.ok) {
      setSession(r.user);
      navigate('writer.do');
    } else {
      setError((r && r.reason) || 'login-failed');
    }
    return r;
  }, [model, navigate, setSession]);

  const logout = useCallback(async () => {
    const r = await model.logout();
    setSession(null);
    navigate('login.do');
    return r;
  }, [model, navigate, setSession]);

  return { login, logout, error, pending };
}
