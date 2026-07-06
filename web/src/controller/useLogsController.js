// 실시간 로그 뷰어 컨트롤러 (logs.do, Z 전용 — 라우트 가드는 UX, 실제 강제는 서버 Z 게이트, ADR-004).
// Model 계약의 subscribeLogs만 호출한다 — transport(EventSource)는 httpModel 뒤에만(ADR-003).
// 서버가 접속마다 버퍼를 replay하므로(step2) record seq(단조 증가)로 이미 본 항목을 거른다.

import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../app/context.js';

// 클라이언트 메모리 캡(링) — 무한 append 금지. 넘치면 오래된 라인부터 버린다.
export const MAX_LINES = 2000;

export function useLogsController() {
  const { model } = useAppContext();
  const [lines, setLines] = useState([]); // record[] (최신이 뒤)
  const [live, setLive] = useState(false);
  // 재연결 replay 중복 제거 — dedup 판정·갱신은 setState 업데이터 밖에서(업데이터는 순수하게 유지,
  // StrictMode 이중 호출 시 record 유실 방지). ref라 effect 재실행에도 유지된다.
  const maxSeqRef = useRef(-Infinity);

  useEffect(() => {
    setLive(false);
    const sub = model.subscribeLogs((record) => {
      if (record.seq <= maxSeqRef.current) return; // 이미 본 seq(재연결 replay) → 무시
      maxSeqRef.current = record.seq;
      setLines((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev;
        return [...next, record];
      });
    }, setLive);
    return () => { setLive(false); sub.unsubscribe(); };
  }, [model]);

  return { lines, live };
}
