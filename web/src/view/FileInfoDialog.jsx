// 파일 정보 다이얼로그 — 순수 표시(읽기전용) 컴포넌트(ADR-003).
// 현재 기사 본문의 통계를 props(stats)로만 받아 표시한다. 입력 폼·onSubmit·onPick 없음(읽기전용).
// 통계 계산(editorStats/blocks)은 부모(Step 1 WriterPage)가 열 때 수행해 props로 주입한다 —
//   이 컴포넌트는 계산하지 않는다(editorStats/editorContent import 없음).
// model/fetch/localStorage/window/document/Date 호출 없음. 약물입력(yh-glyph-input)·URL임베드(yh-url-embed)·
//   찾기(yh-find-replace)·약물바(yh-editor-glyphbar)와 충돌하지 않게 전용 클래스(yh-file-info)·testid(file-info)를 쓴다.

import { useRef } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';

export function FileInfoDialog({
  open,
  stats, // { chars, words, bytes, lines, embeds, paragraph, row, column } — 부모가 계산해 주입
  onClose, // () => void
}) {
  // 열림 시 포커스를 '닫기' 버튼으로 이전(읽기전용 — 입력 없음) — 포커스가 에디터 본문에 남으면
  // Esc 닫기가 발화하지 않고 타이핑이 본문에 들어간다(Step 0 27-editor-critical-fixes).
  const closeRef = useRef(null);
  useFocusOnOpen(closeRef, open);

  if (!open) return null;

  // stats 미주입/일부 누락이어도 죽지 않게 안전 폴백한다(누락 수치 → 0, 줄/캐럿 좌표 → 1).
  // 부모가 통계 미주입 상태로 열어도 렌더가 깨지지 않게 한다.
  const s = stats || {};
  const chars = s.chars ?? 0;
  const words = s.words ?? 0;
  const bytes = s.bytes ?? 0;
  const lineNum = s.lines ?? 1;
  const embeds = s.embeds ?? 0;
  const paragraph = s.paragraph ?? 1;
  const row = s.row ?? 1;
  const column = s.column ?? 1;

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose();
  };

  return (
    <div
      className="yh-file-info"
      role="dialog"
      aria-label="파일 정보"
      data-testid="file-info"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-file-info__title">파일 정보</h2>

      <dl className="yh-file-info__list">
        <div className="yh-file-info__row">
          <dt className="yh-file-info__label">글자수</dt>
          <dd className="yh-file-info__value" data-testid="file-info-chars">{chars}</dd>
        </div>
        <div className="yh-file-info__row">
          <dt className="yh-file-info__label">단어수</dt>
          <dd className="yh-file-info__value" data-testid="file-info-words">{words}</dd>
        </div>
        <div className="yh-file-info__row">
          <dt className="yh-file-info__label">UTF-8 바이트</dt>
          <dd className="yh-file-info__value" data-testid="file-info-bytes">{bytes}</dd>
        </div>
        <div className="yh-file-info__row">
          <dt className="yh-file-info__label">줄 수</dt>
          <dd className="yh-file-info__value" data-testid="file-info-lines">{lineNum}</dd>
        </div>
        <div className="yh-file-info__row">
          <dt className="yh-file-info__label">임베드 개수</dt>
          <dd className="yh-file-info__value" data-testid="file-info-embeds">{embeds}</dd>
        </div>
        <div className="yh-file-info__row">
          <dt className="yh-file-info__label">캐럿 위치</dt>
          <dd className="yh-file-info__value" data-testid="file-info-caret">
            {paragraph}단락 {row}행 {column}열
          </dd>
        </div>
      </dl>

      <div className="yh-file-info__actions">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="file-info-close"
          ref={closeRef}
          onClick={() => onClose && onClose()}
        >
          닫기
        </button>
      </div>
    </div>
  );
}

export default FileInfoDialog;
