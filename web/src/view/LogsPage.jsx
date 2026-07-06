// 실시간 로그 뷰어 페이지(logs.do, 권한 Z 전용 — LOGS.md "웹 페이지에서 실시간으로 발생하는 LOG 확인").
// 비-Z 접근은 App 라우트 가드가 list.do로 보내고, 실제 강제는 서버 Z 게이트다(ADR-004 이중 강제).
// 순수 뷰 — useLogsController만 소비한다. record.line 포맷의 단일 출처는 서버 logService(클라는 표시만,
// 레벨 색 구분은 record.level 기준 클래스만).

import { useEffect, useRef } from 'react';
import { useLogsController } from '../controller/useLogsController.js';

export function LogsPage() {
  const { lines, live } = useLogsController();
  const viewRef = useRef(null);

  // 새 로그 도착 시 스크롤 컨테이너를 맨 아래로 (자동 스크롤).
  useEffect(() => {
    const el = viewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <main className="yh-page yh-logs">
      <h1>실시간 로그</h1>
      <div className="yh-card yh-logs__card">
        <div className="yh-logs__bar">
          {/* 연결 상태 — ListPage 실시간 상태바와 동일 패턴. 끊기면 EventSource가 자동 재연결(ADR-005/007). */}
          <span
            className={`yh-live ${live ? 'yh-live--on' : ''}`}
            data-testid="live-status"
            title={live ? '실시간 연결됨' : '실시간 연결 끊김 — 자동 재연결 시도 중'}
          >
            <span className="yh-live__dot" /> {live ? '실시간' : '연결 끊김'}
          </span>
        </div>
        <div className="yh-logs__view" data-testid="log-view" ref={viewRef}>
          {lines.length === 0 ? (
            <p className="yh-logs__empty">로그 없음 — 새 로그 대기 중</p>
          ) : (
            lines.map((r) => (
              <div key={r.seq} className={`yh-log__line yh-log__line--${String(r.level).toLowerCase()}`}>
                {r.line}
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  );
}

export default LogsPage;
