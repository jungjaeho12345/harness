// 앱 셸 — 라우트 스위치 + 세션 복원 게이트 + 컨텍스트 배선.
// CRITICAL: 마운트 시 model.restoreSession()으로 서버 확인을 끝내기 전에는 login으로 보내지 않는다
// (news.md 세션 정책 — F5 복원). 실제 페이지 컴포넌트/마크업은 step12에서 채운다.

import { useEffect, useState } from 'react';
import { assertModel } from '../model/contract.js';
import { AppContext } from './context.js';
import { useRouter, resolveRoute } from './routing.js';

// 라우트별 자리표시자 — 이 step은 라우팅·복원·컨텍스트까지만 책임진다(컴포넌트는 다음 step).
function RoutePlaceholder({ route }) {
  return <main data-testid="route" data-route={route}>{route}</main>;
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
      <RoutePlaceholder route={route} />
    </AppContext.Provider>
  );
}
