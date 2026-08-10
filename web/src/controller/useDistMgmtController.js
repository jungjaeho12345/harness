// 배부 대상 관리 컨트롤러 (distMgmt.do, Z 전용 — 서버 게이트가 강제한다, ADR-004).
// 프론트 라우트 가드는 UX일 뿐이고 실제 인가는 서버 세션 Z 게이트가 강제한다 — "Z가 아니면 호출을 안 하니 안전"이 아니다.
// 비활성은 soft delete이며 행은 남는다(ADR-008 · DB 비파괴) — 목록에서 사라지지 않고 active='N'이 된다.
// 서버 응답({ ok, reason })은 가공하지 않고 그대로 반환한다(에러 표시 정책은 View 책임).

import { useCallback, useState } from 'react';
import { useAppContext } from '../app/context.js';

export function useDistMgmtController() {
  const { model } = useAppContext();
  const [targets, setTargets] = useState([]);
  // 미해소 배부 실패 목록(phase 57 MVP-4) — targets와 합치지 않는다: 호출 시점·실패 표시 정책이 다르다.
  const [failures, setFailures] = useState([]);

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

  // 실패 목록에도 SSE 신호가 없다 — 쓰기(재전송·tick) 후 직접 재조회해야 화면이 갱신된다.
  // 응답은 가공하지 않고 원본 그대로 반환한다(사유 토큰→문구 변환·요약 생성은 View 책임).
  const refreshFailures = useCallback(async () => {
    const r = await model.queryDistributionFailures();
    setFailures((r && r.items) || []);
    return r;
  }, [model]);

  // 성공/실패 무관하게 재조회한다 — 거부(no-failure 등)는 목록이 낡았다는 신호이기도 하다.
  // 식별자는 실패 목록의 키(historyId)다 — 기사·수신처·kind는 서버가 그 실패 행에서 도출한다(ADR-004).
  const retryTarget = useCallback(async (historyId) => {
    const r = await model.retryDistribution(historyId);
    await refreshFailures();
    return r;
  }, [model, refreshFailures]);

  // 실행 트리거는 사용자의 명시 조작뿐이다 — 여기에 setInterval/자동 폴링을 두지 마라(ADR-008 (3)).
  // tick이 새 실패를 만들었을 수 있으므로 실행 후 실패 목록을 재조회한다.
  const runTick = useCallback(async () => {
    const r = await model.runDistributionTick();
    await refreshFailures();
    return r;
  }, [model, refreshFailures]);

  return {
    targets, refresh, createTarget, updateTarget, deactivateTarget,
    failures, refreshFailures, retryTarget, runTick,
  };
}
