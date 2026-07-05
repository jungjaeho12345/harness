// 상단 공통 헤더 — 좌측 로고/타이틀, 우측 로그인 사용자 정보('유저아이디 · 부서 · (권한)') + 로그아웃.
// 권한 Z에게는 수신설정 관리·사용자 관리 진입 링크를 추가로 보여준다(비-Z에게는 노출하지 않음).
// 데이터/네비게이션은 컨텍스트·컨트롤러 경유(transport 직접 호출 금지, ADR-003).

import { useAppContext } from '../app/context.js';
import { useLoginController } from '../controller/useLoginController.js';

export function TopBar() {
  const { identity, navigate } = useAppContext();
  const { logout } = useLoginController();

  const id = identity ? (identity.userId ?? '') : '';
  const dept = identity ? (identity.department ?? '') : '';
  const role = identity ? (identity.role ?? '') : '';
  const isZ = role === 'Z';

  return (
    <header className="yh-topbar">
      <div className="yh-topbar__brand">
        <span className="yh-topbar__rule" aria-hidden="true" />
        <span>기사 작성기</span>
      </div>
      <div className="yh-topbar__right">
        <nav className="yh-topbar__nav">
          <button type="button" className="yh-btn" onClick={() => navigate('writer.do')}>기사작성</button>
          <button type="button" className="yh-btn" onClick={() => navigate('list.do')}>기사조회</button>
          <button type="button" className="yh-btn" onClick={() => navigate('logs.do')}>실시간 로그</button>
          {isZ && (
            <>
              <button type="button" className="yh-btn" onClick={() => navigate('rcvMgmt.do')}>수신설정 관리</button>
              <button type="button" className="yh-btn" onClick={() => navigate('userMgmt.do')}>사용자 관리</button>
            </>
          )}
        </nav>
        <span className="yh-user-info" data-testid="user-info">
          {id} · {dept} · ({role})
        </span>
        <button type="button" className="yh-btn" onClick={() => logout()}>로그아웃</button>
      </div>
    </header>
  );
}

export default TopBar;
