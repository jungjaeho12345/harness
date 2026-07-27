// 배부 대상 관리 컨트롤러 (distMgmt.do, Z 전용 — 서버 게이트가 강제한다, ADR-004).
// 프론트 라우트 가드는 UX일 뿐이고 실제 인가는 서버 세션 Z 게이트가 강제한다 — "Z가 아니면 호출을 안 하니 안전"이 아니다.
// 비활성은 soft delete이며 행은 남는다(ADR-008 · DB 비파괴) — 목록에서 사라지지 않고 active='N'이 된다.
// 서버 응답({ ok, reason })은 가공하지 않고 그대로 반환한다(에러 표시 정책은 View 책임).

import { useCallback, useState } from 'react';
import { useAppContext } from '../app/context.js';

export function useDistMgmtController() {
  const { model } = useAppContext();
  const [targets, setTargets] = useState([]);

  // 전체 재조회 — 비활성 행을 걸러내지 않는다(재활성화 대상이라 숨기면 복구 경로가 사라진다).
  const refresh = useCallback(async () => {
    const r = await model.queryDistributionTargets();
    setTargets((r && r.items) || []);
    return r;
  }, [model]);

  // 배부 대상 변경에는 SSE 무효화 신호가 없다 — 쓰기 후 직접 재조회해야 화면이 갱신된다(수신 설정 관리와 동형).
  const createTarget = useCallback(async (entry) => {
    const r = await model.createDistributionTarget(entry);
    await refresh();
    return r;
  }, [model, refresh]);

  const updateTarget = useCallback(async (id, fields) => {
    const r = await model.updateDistributionTarget(id, fields);
    await refresh();
    return r;
  }, [model, refresh]);

  const deactivateTarget = useCallback(async (id) => {
    const r = await model.deactivateDistributionTarget(id);
    await refresh();
    return r;
  }, [model, refresh]);

  return { targets, refresh, createTarget, updateTarget, deactivateTarget };
}
