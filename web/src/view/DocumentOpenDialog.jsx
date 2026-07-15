// 파일>문서열기 다이얼로그 — DB 기사 피커(controlled·순수, ADR-003). 목록/검색으로 기사를 골라
//   편집 진입(부모의 openArticle)에 위임한다. model/fetch/window/document/localStorage 호출 없음 —
//   표시와 이벤트 위임만 한다(검색어는 onSearch(문자열), 선택은 onPick(기사), 닫기는 onClose).
// MetaSelectDialog와 동형의 계약: 부모가 open/데이터/열림을 소유(controlled), `if (!open) return null`,
//   useFocusOnOpen으로 열림 시 포커스 이전, Esc→onClose, yh-editor-dialog 중앙 모달 + 전용 클래스/testid.
// 잠금/dedup/'편집중입니다.' 처리는 부모의 openArticle이 단일 지점에서 강제한다 — 여기서 재구현하지 않는다.
// 다른 다이얼로그(yh-meta-dialog/yh-table-dialog 등)와 충돌하지 않게 전용 클래스(yh-doc-open-dialog)·testid(doc-open-dialog)를 쓴다.

import { useRef, useState } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';

export function DocumentOpenDialog({
  open,
  articles = [], // 표시할 기사 목록(부모가 queryArticles/searchArticles로 채움). 각 행: articleId·제목·상태.
  onSearch, // (query: string) => void — 검색 제출 시 위임(빈 문자열이면 부모가 전체 목록으로 되돌림).
  onPick, // (article) => void — 행 선택(클릭/Enter) 시 위임(부모가 openArticle로 편집 진입).
  onClose, // () => void — 닫기 버튼/Esc.
}) {
  const [query, setQuery] = useState('');

  // 열림 시 포커스를 검색 입력으로 이전 — 포커스가 에디터 본문(contentEditable)에 남으면 타이핑이 기사 본문에
  // 삽입되고 Esc 닫기가 발화하지 않는다(MetaSelectDialog/useFocusOnOpen 계약과 동형).
  const focusRef = useRef(null);
  useFocusOnOpen(focusRef, open);

  if (!open) return null;

  const submit = () => { if (onSearch) onSearch(query); };
  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose();
  };

  return (
    <div
      className="yh-editor-dialog yh-doc-open-dialog"
      role="dialog"
      aria-label="문서열기"
      data-testid="doc-open-dialog"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-doc-open-dialog__title">문서열기</h2>

      <div className="yh-doc-open-dialog__search">
        <input
          ref={focusRef}
          data-testid="doc-open-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="기사 제목으로 검색"
          aria-label="기사 검색"
        />
        <button type="button" className="yh-btn" data-testid="doc-open-search-btn" onClick={submit}>
          검색
        </button>
      </div>

      <div className="yh-doc-open-dialog__list" data-testid="doc-open-list">
        {articles.length === 0 ? (
          <div className="yh-doc-open-dialog__empty" data-testid="doc-open-empty">기사가 없습니다.</div>
        ) : (
          articles.map((a, i) => (
            // 행 표시는 있는 필드로 방어적 렌더(없으면 '—'). 버튼이라 클릭·Enter 모두 onPick으로 이어진다.
            <button
              type="button"
              className="yh-doc-open-dialog__row"
              key={a.articleId ?? i}
              data-testid={`doc-open-row-${i}`}
              onClick={() => onPick && onPick(a)}
            >
              <span className="yh-doc-open-dialog__id">{a.articleId || '—'}</span>
              <span className="yh-doc-open-dialog__row-title">{a.title || '—'}</span>
              <span className="yh-doc-open-dialog__status">{a.status || '—'}</span>
            </button>
          ))
        )}
      </div>

      <div className="yh-doc-open-dialog__actions">
        <button type="button" className="yh-btn" data-testid="doc-open-close" onClick={() => onClose && onClose()}>
          닫기
        </button>
      </div>
    </div>
  );
}

export default DocumentOpenDialog;
