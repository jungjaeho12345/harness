// 실시간 로그 뷰어 페이지(logs.do) — 순수 표시 컴포넌트. useLogViewController로 라인/연결 상태를 받아
// 모노스페이스 목록으로 렌더하고, 레벨 필터(표시 토글)·연결 상태 배지·빈 상태를 보여준다.
// 읽기 전용: 본문/DB/캐럿 변경 없음. transport 직접 호출 없음(훅/모델 경유, ADR-003).
// XSS 방지: 로그 라인은 임의 텍스트이므로 React 텍스트 노드로만 렌더한다(dangerouslySetInnerHTML 금지).

import { useState } from 'react';
import { useLogViewController } from '../controller/useLogViewController.js';
import { LOG_LEVELS, logLevelClass } from './logLevelBadge.js';

export function LogViewerPage() {
  const { lines, live } = useLogViewController();
  // 표시에서 숨길 레벨 집합(기본: 전부 표시). 필터는 순수 표시 관심사라 View 로컬 상태로 둔다.
  const [hidden, setHidden] = useState(() => new Set());

  const toggleLevel = (level) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  // 알 수 없는 레벨은 항상 표시하고, 알려진 레벨만 필터 토글 대상으로 삼는다.
  const visible = lines.filter(
    (e) => !LOG_LEVELS.includes(e.level) || !hidden.has(e.level),
  );

  return (
    <main className="yh-page">
      <div className="yh-log-header">
        <h1>실시간 로그</h1>
        <span
          className={`yh-log-status ${live ? 'yh-log-status--on' : 'yh-log-status--off'}`}
          data-testid="log-connection"
        >
          {live ? '연결됨' : '끊김'}
        </span>
      </div>

      <div className="yh-log-filters" role="group" aria-label="로그 레벨 필터">
        {LOG_LEVELS.map((level) => (
          <label key={level} className="yh-log-filter">
            <input
              type="checkbox"
              checked={!hidden.has(level)}
              onChange={() => toggleLevel(level)}
              data-testid={`log-filter-${level}`}
            />
            <span className={`yh-log-badge ${logLevelClass(level)}`}>{level}</span>
          </label>
        ))}
      </div>

      {lines.length === 0 && (
        <p className="yh-log-empty" data-testid="log-empty">아직 로그가 없습니다.</p>
      )}
      {lines.length > 0 && visible.length === 0 && (
        <p className="yh-log-empty" data-testid="log-filtered-empty">필터에 해당하는 로그가 없습니다.</p>
      )}
      {visible.length > 0 && (
        <ul className="yh-log-list" data-testid="log-list">
          {visible.map((e, i) => (
            <li key={`${e.ts ?? ''}-${i}`} className="yh-log-line">
              <span className={`yh-log-badge ${logLevelClass(e.level)}`}>{e.level}</span>
              <span className="yh-log-text">{e.line ?? e.message ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default LogViewerPage;
