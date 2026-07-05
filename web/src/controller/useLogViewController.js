// 실시간 로그 뷰어 컨트롤러(logs.do) — step4 Model 계약(subscribeLogs)을 구독해 수신 라인을
// 경계 있는 in-memory 배열로 유지하고 연결 상태(live)를 보유한다. 언마운트 시 unsubscribe(누수 방지).
// View(LogViewerPage)는 이 훅만 소비한다 — transport 직접 호출 없음(ADR-003).

import { useEffect, useState } from 'react';
import { useAppContext } from '../app/context.js';

// 브라우저 메모리 보호를 위한 라인 상한(무한 증가 금지). 초과 시 오래된 앞 라인을 버린다.
export const MAX_LINES = 500;

// append + 상한(순수 헬퍼). 상한 초과 시 최근 max개만 남긴다. 입력 배열은 변형하지 않는다.
export function boundedAppend(prev, entry, max = MAX_LINES) {
  const next = prev.length >= max ? prev.slice(prev.length - max + 1) : prev.slice();
  next.push(entry);
  return next;
}

export function useLogViewController() {
  const { model } = useAppContext();
  const [lines, setLines] = useState([]);
  const [live, setLive] = useState(false);

  // 로그는 무효화 신호가 아니라 컨텐츠 push다(useViewController의 subscribe와 다른 점) —
  // 재조회하지 않고 수신 엔트리를 상한 있게 누적한다. 언마운트 시 구독 해제.
  useEffect(() => {
    setLive(false);
    const sub = model.subscribeLogs(
      (entry) => setLines((prev) => boundedAppend(prev, entry)),
      setLive,
    );
    return () => { setLive(false); sub.unsubscribe(); };
  }, [model]);

  return { lines, live };
}
