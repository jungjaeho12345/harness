// 에디터 찾기/바꾸기(Ctrl+F) 다이얼로그 — 순수 표시/폼 컴포넌트(ADR-003).
// 검색/치환 엔진(Step 0 editorFind)·본문 변경·캐럿 이동은 하지 않는다. 모든 동작은 props 콜백으로 위임하고,
// 폼 상태(query/replacement/caseSensitive)만 내부 state로 둔다. WriterPage 결선은 Step 2.
// window/document/transport(model/fetch) 호출 없음. 조회페이지 ContextMenu와 무관한 yh-find-replace 전용 클래스/testid를 쓴다.

import { useEffect, useState } from 'react';

export function FindReplaceDialog({
  open,
  matchCount = 0, // 현재 query의 전체 매치 수(부모가 Step 0 findMatches로 계산해 주입)
  activeIndex = -1, // 활성 매치 0-base 인덱스(-1이면 없음)
  onQueryChange, // (query, { caseSensitive }) => void — 입력/체크박스 변경 시
  onFindNext,
  onFindPrev,
  onReplaceOne, // (replacement) => void
  onReplaceAll, // (replacement) => void
  onClose,
}) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);

  // 새로 열릴 때(open false→true)만 폼을 초기화한다. open이 true로 유지되는 동안에는 타이핑 입력을 보존한다.
  useEffect(() => {
    if (open) {
      setQuery('');
      setReplacement('');
      setCaseSensitive(false);
    }
  }, [open]);

  if (!open) return null;

  // query/caseSensitive 변경은 즉시 부모에 알린다(부모가 matchCount/activeIndex를 재계산해 되돌려준다).
  const changeQuery = (nextQuery, nextCase) => {
    setQuery(nextQuery);
    setCaseSensitive(nextCase);
    if (onQueryChange) onQueryChange(nextQuery, { caseSensitive: nextCase });
  };

  // 매치 현황: 매치가 있으면 'pos/total'(activeIndex 없으면 1로 표시), 없으면 query가 있을 때만 '검색 결과 없음'.
  let status = '';
  if (matchCount > 0) {
    const pos = activeIndex + 1 > 0 ? activeIndex + 1 : 1;
    status = `${pos}/${matchCount}`;
  } else if (query) {
    status = '검색 결과 없음';
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose();
  };

  return (
    <div
      className="yh-find-replace"
      role="dialog"
      aria-label="찾기/바꾸기"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-find-replace__title">찾기/바꾸기</h2>

      <div className="yh-find-replace__fields">
        <div className="yh-field">
          <label htmlFor="find-query">찾을 내용</label>
          <input
            id="find-query"
            data-testid="find-query"
            type="text"
            aria-label="찾을 내용"
            value={query}
            onChange={(e) => changeQuery(e.target.value, caseSensitive)}
          />
        </div>
        <div className="yh-field">
          <label htmlFor="find-replacement">바꿀 내용</label>
          <input
            id="find-replacement"
            data-testid="find-replacement"
            type="text"
            aria-label="바꿀 내용"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
        </div>
        <div className="yh-field yh-find-replace__case">
          <label htmlFor="find-case">대소문자 구분</label>
          <input
            id="find-case"
            data-testid="find-case"
            type="checkbox"
            aria-label="대소문자 구분"
            checked={caseSensitive}
            onChange={(e) => changeQuery(query, e.target.checked)}
          />
        </div>
      </div>

      <div className="yh-find-replace__status" data-testid="find-status">{status}</div>

      <div className="yh-find-replace__actions">
        <button type="button" className="yh-btn" data-testid="find-prev" onClick={() => onFindPrev && onFindPrev()}>이전 찾기</button>
        <button type="button" className="yh-btn" data-testid="find-next" onClick={() => onFindNext && onFindNext()}>다음 찾기</button>
        <button type="button" className="yh-btn" data-testid="find-replace-one" onClick={() => onReplaceOne && onReplaceOne(replacement)}>바꾸기</button>
        <button type="button" className="yh-btn" data-testid="find-replace-all" onClick={() => onReplaceAll && onReplaceAll(replacement)}>모두 바꾸기</button>
        <button type="button" className="yh-btn yh-btn--primary" data-testid="find-close" onClick={() => onClose && onClose()}>닫기</button>
      </div>
    </div>
  );
}

export default FindReplaceDialog;
