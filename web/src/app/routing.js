// .do SPA 라우팅 (news.md 페이지) — 모든 경로·가드·주소창 동기화를 한 곳에 모은다.
// 순수 함수(parseLocation/resolveRoute/buildPath)는 단위 테스트 대상이고, useRouter는 브라우저
// history(popstate)와 location 상태를 잇는다. 라우트 가드는 UX일 뿐 — 실제 강제는 서버 Z 게이트(step8).

import { useCallback, useEffect, useState } from 'react';

export const ROUTES = Object.freeze(['login.do', 'writer.do', 'list.do', 'rcvMgmt.do', 'userMgmt.do', 'logs.do']);
export const Z_ONLY_ROUTES = Object.freeze(['rcvMgmt.do', 'userMgmt.do', 'logs.do']);
export const DEFAULT_ROUTE = 'login.do';

// 현재 location → { route, articleId }. 정의되지 않은 경로는 login.do로 떨어진다(news.md).
export function parseLocation({ pathname = '', search = '' } = {}) {
  const seg = String(pathname).replace(/^\/+/, '').replace(/\/+$/, '');
  const route = ROUTES.includes(seg) ? seg : DEFAULT_ROUTE;
  let articleId = null;
  try {
    articleId = new URLSearchParams(search).get('articleId') || null;
  } catch {
    articleId = null; // search 파싱 불가 — articleId 없음.
  }
  return { route, articleId };
}

// 라우트 가드 — 복원된 신원(identity)에 따라 실제 진입 라우트를 결정한다.
// 비로그인(identity 없음) → login.do. 로그인 상태에서 login.do로 가려 하면 list.do.
// Z 전용 라우트인데 비-Z면 list.do (역할은 복원된 세션 신원에서만 읽는다, ADR-004).
export function resolveRoute(route, identity) {
  const target = ROUTES.includes(route) ? route : DEFAULT_ROUTE;
  if (!identity) return DEFAULT_ROUTE;
  if (target === 'login.do') return 'list.do';
  if (Z_ONLY_ROUTES.includes(target) && identity.role !== 'Z') return 'list.do';
  return target;
}

// 라우트(+편집 탭 기사아이디) → 주소창 경로. 새 기사 탭(articleId 없음)이면 쿼리를 제거한다.
export function buildPath(route, { articleId } = {}) {
  const path = `/${route}`;
  return articleId ? `${path}?articleId=${encodeURIComponent(articleId)}` : path;
}

// 브라우저 history와 location 상태를 잇는 훅 — 뒤로/앞으로(popstate) 지원.
export function useRouter() {
  const [location, setLocation] = useState(() => parseLocation(window.location));

  useEffect(() => {
    const onPop = () => setLocation(parseLocation(window.location));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 새 항목을 history에 push (뒤로가기 대상이 된다) — 페이지 전환.
  const navigate = useCallback((route, opts = {}) => {
    window.history.pushState({}, '', buildPath(route, opts));
    setLocation(parseLocation(window.location));
  }, []);

  // 현재 항목 교체 (탭 전환·가드 리다이렉트 — 뒤로가기 히스토리를 남기지 않는다).
  const replace = useCallback((route, opts = {}) => {
    window.history.replaceState({}, '', buildPath(route, opts));
    setLocation(parseLocation(window.location));
  }, []);

  return { location, navigate, replace };
}
