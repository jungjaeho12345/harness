// 앱 셸 — 라우트 스위치 + 세션 복원 게이트 + 컨텍스트 배선.
// CRITICAL: 마운트 시 model.restoreSession()으로 서버 확인을 끝내기 전에는 login으로 보내지 않는다
// (news.md 세션 정책 — F5 복원).

import { useEffect, useState } from 'react';
import { assertModel } from '../model/contract.js';
import { AppContext } from './context.js';
import { useRouter, resolveRoute } from './routing.js';
import { TopBar } from '../view/TopBar.jsx';
import { LoginPage } from '../view/LoginPage.jsx';
import { WriterPage } from '../view/WriterPage.jsx';
import { ListPage } from '../view/ListPage.jsx';
import { RcvMgmtPage } from '../view/RcvMgmtPage.jsx';
import { UserMgmtPage } from '../view/UserMgmtPage.jsx';
import { LogsPage } from '../view/LogsPage.jsx';
import { DistMgmtPage } from '../view/DistMgmtPage.jsx';

// 해석된 라우트 → 페이지 컴포넌트. login.do 외에는 공통 상단 헤더(TopBar)를 함께 그린다.
function RouteView({ route }) {
  let page = null;
  if (route === 'login.do') page = <LoginPage />;
  else if (route === 'writer.do') page = <WriterPage />;
  else if (route === 'list.do') page = <ListPage />;
  else if (route === 'rcvMgmt.do') page = <RcvMgmtPage />;
  else if (route === 'userMgmt.do') page = <UserMgmtPage />;
  else if (route === 'logs.do') page = <LogsPage />;
  else if (route === 'distMgmt.do') page = <DistMgmtPage />;
  return (
    <div data-testid="route" data-route={route}>
      {route !== 'login.do' && <TopBar />}
      {page}
    </div>
  );
}

export default function App({ model }) {
  assertModel(model); // 주입된 Model이 계약(MODEL_KEYS)을 만족하는지 런타임 검증(ADR-003).

  const { location, navigate, replace } = useRouter();
  const [identity, setIdentity] = useState(null);
  const [restoring, setRestoring] = useState(true);

  // F5 복원 — 서버에 신원을 묻는다. 복원이 끝나기 전엔 login 리다이렉트를 막는다.
  useEffect(() => {
    let alive = true;
    Promise.resolve(model.restoreSession()).then((r) => {
      if (!alive) return;
      setIdentity(r && r.ok && r.user ? r.user : null);
      setRestoring(false);
    });
    return () => { alive = false; };
  }, [model]);

  const route = resolveRoute(location.route, identity);

  // 가드 리다이렉트를 주소창에 반영 (resolve 결과가 URL과 다르면 교체 — 히스토리 오염 없이).
  useEffect(() => {
    if (restoring || route === location.route) return;
    replace(route, { articleId: route === 'writer.do' ? location.articleId : null });
  }, [restoring, route, location.route, location.articleId, replace]);

  if (restoring) {
    return <div data-testid="restoring">세션 복원 중…</div>;
  }

  return (
    <AppContext.Provider value={{ model, identity, navigate, replace, setSession: setIdentity }}>
      <RouteView route={route} />
    </AppContext.Provider>
  );
}
