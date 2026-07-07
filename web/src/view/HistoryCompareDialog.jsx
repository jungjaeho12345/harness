// 기사 이력 비교(도구>기사이력비교) 다이얼로그 — 순수 표시(읽기전용) 컴포넌트(ADR-003). FileInfoDialog 구조를 본뜬다.
// 비교 대상 목록(entries)·선택 key(leftKey/rightKey)·비교용 텍스트(leftText/rightText)는 부모(Step 2 WriterPage)가
//   props로 주입한다 — 이 컴포넌트는 httpModel/fetch/model을 호출하지 않는다(스냅샷 조회·텍스트 변환은 부모 몫).
// diff 계산은 순수 함수 diffLines만 쓰고, 본문/캐럿/임베드는 절대 바꾸지 않는다(입력폼·onSubmit·onPick 없음 — 표시 전용).
// 다른 패널(yh-file-info/yh-find-replace 등)과 충돌하지 않게 전용 클래스(yh-history-compare)·testid(history-compare)를 쓴다.

import { useRef } from 'react';
import { diffLines } from './historyDiff.js';
import { useFocusOnOpen } from './useFocusOnOpen.js';

export function HistoryCompareDialog({
  open,
  entries, // [{ key, label }] — 부모가 '현재 본문' + 스냅샷 이력을 합쳐 주입
  leftKey, // 왼쪽(이전) 선택 대상 key — 부모 소유
  rightKey, // 오른쪽(이후) 선택 대상 key — 부모 소유
  leftText, // 왼쪽 비교용 텍스트(부모가 조회·변환해 주입, 미준비면 null)
  rightText, // 오른쪽 비교용 텍스트(미준비면 null)
  onSelectLeft, // (key) => void
  onSelectRight, // (key) => void
  onClose, // () => void
}) {
  // 열림 시 포커스를 '닫기' 버튼으로 이전 — select는 entries<2면 렌더되지 않아 항상 실재하는 닫기 버튼을 쓴다.
  // 포커스가 에디터 본문에 남으면 Esc 닫기가 발화하지 않는다(Step 0 27-editor-critical-fixes).
  const closeRef = useRef(null);
  useFocusOnOpen(closeRef, open);

  if (!open) return null;

  // entries 미주입/비배열이어도 죽지 않게 안전 폴백한다. 비교는 대상이 2개 이상일 때만 가능하다.
  const list = Array.isArray(entries) ? entries : [];
  const comparable = list.length >= 2;

  // select 옵션 value는 문자열이라, 변경 시 String(key)이 일치하는 entry를 찾아 원래 key로 콜백한다.
  const handleSelect = (callback) => (e) => {
    const entry = list.find((en) => String(en.key) === e.target.value);
    if (entry && callback) callback(entry.key);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose();
  };

  const ready = leftText !== null && leftText !== undefined && rightText !== null && rightText !== undefined;
  const segments = ready ? diffLines(leftText, rightText) : [];

  return (
    <div
      className="yh-editor-dialog yh-history-compare"
      role="dialog"
      aria-label="기사 이력 비교"
      data-testid="history-compare"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-history-compare__title">기사 이력 비교</h2>

      {!comparable ? (
        <p className="yh-history-compare__empty" data-testid="history-compare-empty">
          비교할 이력이 없습니다.
        </p>
      ) : (
        <>
          <div className="yh-history-compare__controls">
            <select
              className="yh-history-compare__select"
              aria-label="왼쪽 비교 대상"
              data-testid="history-compare-left"
              value={leftKey === null || leftKey === undefined ? '' : String(leftKey)}
              onChange={handleSelect(onSelectLeft)}
            >
              <option value="">선택</option>
              {list.map((en) => (
                <option key={String(en.key)} value={String(en.key)}>{en.label}</option>
              ))}
            </select>
            <select
              className="yh-history-compare__select"
              aria-label="오른쪽 비교 대상"
              data-testid="history-compare-right"
              value={rightKey === null || rightKey === undefined ? '' : String(rightKey)}
              onChange={handleSelect(onSelectRight)}
            >
              <option value="">선택</option>
              {list.map((en) => (
                <option key={String(en.key)} value={String(en.key)}>{en.label}</option>
              ))}
            </select>
          </div>

          {ready ? (
            <div className="yh-history-compare__diff" data-testid="history-compare-diff">
              {segments.map((seg, idx) => (
                <div
                  key={idx}
                  className={`yh-history-compare__line yh-history-compare__line--${seg.type}`}
                  data-type={seg.type}
                  data-testid="history-compare-segment"
                >
                  {seg.text === '' ? '\u00A0' : seg.text}
                </div>
              ))}
            </div>
          ) : (
            <p className="yh-history-compare__pending" data-testid="history-compare-pending">
              비교할 대상을 선택하세요 — 본문을 불러오는 중이면 잠시 후 표시됩니다.
            </p>
          )}
        </>
      )}

      <div className="yh-history-compare__actions">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="history-compare-close"
          ref={closeRef}
          onClick={() => onClose && onClose()}
        >
          닫기
        </button>
      </div>
    </div>
  );
}

export default HistoryCompareDialog;
