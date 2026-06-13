// 로그인 페이지(login.do) — 아이디/암호 입력, 실패 시 ALERT (news.md 로그인 워크플로우).
// 데이터는 useLoginController 경유(transport 직접 호출 금지). 성공 시 컨트롤러가 writer.do로 이동한다.

import { useState } from 'react';
import { useLoginController } from '../controller/useLoginController.js';

export function LoginPage() {
  const { login, pending } = useLoginController();
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');

  const onSubmit = async (e) => {
    e.preventDefault();
    const r = await login(userId, password);
    // 실패 사유와 함께 ALERT (성공 시 컨트롤러가 라우팅).
    if (!r || !r.ok) {
      window.alert(`로그인 실패: ${(r && r.reason) || 'login-failed'}`);
    }
  };

  return (
    <main className="yh-login">
      <form className="yh-card" onSubmit={onSubmit}>
        <h1 className="yh-login__title">
          <span className="yh-topbar__rule" aria-hidden="true" />
          기사 작성기 로그인
        </h1>
        <div className="yh-field">
          <label htmlFor="login-id">아이디</label>
          <input
            id="login-id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="아이디를 입력하세요"
            autoComplete="username"
          />
        </div>
        <div className="yh-field">
          <label htmlFor="login-pw">암호</label>
          <input
            id="login-pw"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="암호를 입력하세요"
            autoComplete="current-password"
          />
        </div>
        <button type="submit" className="yh-btn yh-btn--primary" disabled={pending}>
          로그인
        </button>
      </form>
    </main>
  );
}

export default LoginPage;
