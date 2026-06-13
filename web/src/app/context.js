// 앱 전역 컨텍스트 — 주입된 Model 계약(ADR-003)·복원된 세션 신원·라우팅 헬퍼를 공유한다.
// 컨트롤러 훅은 useAppContext로 model/identity/navigate에 접근하고, 절대 직접 transport를 호출하지 않는다.

import { createContext, useContext } from 'react';

export const AppContext = createContext(null);

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useAppContext must be used within <AppContext.Provider>');
  }
  return ctx;
}
