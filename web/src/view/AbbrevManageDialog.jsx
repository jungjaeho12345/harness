// 약어 관리 다이얼로그 — 순수 표시/CRUD(controlled) 컴포넌트(ADR-003).
// 커밋된 약어 목록(items)·영속·표시여부는 부모(Step 1 WriterPage)가 소유한다 — 내부 state는 "미커밋 입력 2개"뿐.
// 전용 yh-abbrev-manage/abbrev-manage className·testid로 다른 다이얼로그와 충돌 방지.
// Enter는 가로채지 않는다(추가는 '추가' 버튼으로만, Escape만 닫기 — UX 혼선 방지). abbrevStore/abbrevConvert를 import 하지 않는다.

import { useRef, useState } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';

export function AbbrevManageDialog({
  open,
  items = [], // { short, long }[] — 부모 소유(커밋된 목록)
  onAdd, // (short, long) => void — '추가' 클릭 시(둘 다 비면 no-op)
  onRemove, // (index) => void — 행 '삭제' 클릭 시
  onClose, // () => void — '닫기'/Esc
}) {
  const [shortInput, setShortInput] = useState('');
  const [longInput, setLongInput] = useState('');

  // 열림 시 포커스를 짧은형 input(논리적 첫 입력)으로 이전 — 포커스가 에디터 본문에 남으면
  // 약어 타이핑이 기사 본문에 삽입되고 Esc 닫기가 발화하지 않는다(Step 0 27-editor-critical-fixes).
  const shortRef = useRef(null);
  useFocusOnOpen(shortRef, open);

  if (!open) return null;

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose(); // Escape만 닫기(Enter 미인터셉트).
  };

  const handleAdd = () => {
    const short = shortInput.trim();
    const long = longInput.trim();
    if (!short || !long) return; // 하나라도 비면 no-op.
    if (onAdd) onAdd(short, long);
    setShortInput('');
    setLongInput('');
  };

  return (
    <div
      className="yh-abbrev-manage"
      role="dialog"
      aria-label="약어 관리"
      data-testid="abbrev-manage"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-abbrev-manage__title">약어 관리</h2>

      <div className="yh-abbrev-manage__form">
        <input
          className="yh-abbrev-manage__input"
          data-testid="abbrev-manage-short"
          ref={shortRef}
          type="text"
          aria-label="짧은형"
          placeholder="짧은형"
          value={shortInput}
          onChange={(e) => setShortInput(e.target.value)}
        />
        <input
          className="yh-abbrev-manage__input"
          data-testid="abbrev-manage-long"
          type="text"
          aria-label="확장형"
          placeholder="확장형"
          value={longInput}
          onChange={(e) => setLongInput(e.target.value)}
        />
        <button
          type="button"
          className="yh-btn"
          data-testid="abbrev-manage-add"
          onClick={handleAdd}
        >
          추가
        </button>
      </div>

      <ul className="yh-abbrev-manage__list" data-testid="abbrev-manage-list">
        {items.map((it, i) => (
          <li
            className="yh-abbrev-manage__item"
            key={`${it.short}-${it.long}-${i}`}
            data-testid={`abbrev-manage-item-${i}`}
          >
            <span className="yh-abbrev-manage__pair">{`${it.short} → ${it.long}`}</span>
            <button
              type="button"
              className="yh-btn"
              data-testid={`abbrev-manage-remove-${i}`}
              onClick={() => onRemove && onRemove(i)}
            >
              삭제
            </button>
          </li>
        ))}
      </ul>

      <div className="yh-abbrev-manage__actions">
        <button
          type="button"
          className="yh-btn"
          data-testid="abbrev-manage-close"
          onClick={() => onClose && onClose()}
        >
          닫기
        </button>
      </div>
    </div>
  );
}

export default AbbrevManageDialog;
