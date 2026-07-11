// 표 편집 다이얼로그 — 순수 표시/폼 컴포넌트(ADR-003). 그리드 입력 UI만 담당한다.
// 표 삽입(table.insert — initialRows 없이 기본 그리드)과 본문 표 더블클릭 편집(initialRows) 양쪽에 쓰인다.
// 임베드 생성(makeTableEmbed)·삽입·본문 블록 교체·타겟 탐색·클립보드는 부모(Step 3 WriterPage)가 한다 —
//   확정 시 onSubmit(rows)로 정규화된 2차원 문자열 배열만 넘긴다. 셀 값은 원본 문자열만 보관한다
//   (HTML 이스케이프는 렌더 레이어(step1) 책임 — 이중 이스케이프 방지).
// 그리드 변형은 tableModel의 순수 헬퍼만 사용한다(step0 단일 출처 — 자체 구현 금지).
// model/fetch/localStorage/window/document 호출 없음. 찾기(yh-find-replace)·약물입력(yh-glyph-input)·
//   URL임베드(yh-url-embed)와 충돌하지 않게 전용 클래스(yh-table-dialog)·testid(table-dialog)를 쓴다.

import { useEffect, useRef, useState } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';
import {
  makeEmptyTableRows,
  normalizeTableRows,
  insertRow,
  insertCol,
  deleteRow,
  deleteCol,
  setCell,
} from './tableModel.js';

// 삽입 기본 그리드 크기 — 합리적 소형(최소 1×1은 tableModel 헬퍼가 보장).
const DEFAULT_ROWS = 2;
const DEFAULT_COLS = 2;

function initialGrid(initialRows) {
  const normalized = normalizeTableRows(initialRows);
  return normalized.length > 0 ? normalized : makeEmptyTableRows(DEFAULT_ROWS, DEFAULT_COLS);
}

export function TableEditDialog({
  open,
  initialRows, // string[][] | undefined — 편집 시 기존 rows, 삽입 시 undefined(기본 그리드로 시작)
  onSubmit, // (rows: string[][]) => void — '적용' 클릭 또는 셀에서 Enter 시(정규화된 2차원 배열)
  onClose, // () => void
}) {
  // 로컬 그리드 state — 항상 비어 있지 않은 직사각형(첫 렌더부터 첫 셀이 존재해야 열림 시 포커스가 잡힌다).
  const [rows, setRows] = useState(() => initialGrid(initialRows));

  // open false→true 전환 시에만 initialRows(정규화)/기본 그리드로 재초기화한다 — 재오픈 시 이전 편집 잔존 금지.
  // 열려 있는 동안 initialRows 참조가 바뀌어도 편집 중인 그리드를 리셋하지 않는다(wasOpen 가드).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setRows(initialGrid(initialRows));
    wasOpen.current = open;
  }, [open, initialRows]);

  // 열림 시 포커스를 첫 셀(논리적 첫 입력)로 이전 — 포커스가 에디터 본문에 남으면
  // 셀 타이핑이 기사 본문에 삽입되고 Esc 닫기가 발화하지 않는다(27-editor-critical-fixes).
  const firstCellRef = useRef(null);
  useFocusOnOpen(firstCellRef, open);

  if (!open) return null;

  // 모든 셀이 공백이어도 표 구조(행/열)는 유효하므로 그대로 제출한다(URL 다이얼로그의 빈 값 no-op과 다름).
  // 닫기는 부모에 맡긴다(onSubmit 후 부모가 open을 내린다).
  const submit = () => {
    if (onSubmit) onSubmit(normalizeTableRows(rows));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (onClose) onClose();
    } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      // 셀 입력에서만 Enter=적용 — 버튼 위 Enter는 클릭(닫기 등)과 이중 발화하므로 제외.
      submit();
    }
  };

  return (
    <div
      className="yh-editor-dialog yh-table-dialog"
      role="dialog"
      aria-label="표 편집"
      data-testid="table-dialog"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-table-dialog__title">표 편집</h2>

      <table className="yh-table-dialog__grid">
        <tbody>
          {rows.map((row, r) => (
            // 그리드는 위치 기반이라 인덱스 key가 안정적이다(행/열 추가·삭제는 끝에서만 일어난다).
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c}>
                  <input
                    type="text"
                    ref={r === 0 && c === 0 ? firstCellRef : undefined}
                    aria-label={`셀 ${r + 1},${c + 1}`}
                    data-testid={`table-dialog-cell-${r}-${c}`}
                    value={cell}
                    onChange={(e) => setRows((prev) => setCell(prev, r, c, e.target.value))}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="yh-table-dialog__structure">
        <button
          type="button"
          className="yh-btn"
          data-testid="table-dialog-add-row"
          onClick={() => setRows((prev) => insertRow(prev, prev.length))}
        >
          행 추가
        </button>
        <button
          type="button"
          className="yh-btn"
          data-testid="table-dialog-add-col"
          onClick={() => setRows((prev) => insertCol(prev, prev[0]?.length ?? 0))}
        >
          열 추가
        </button>
        <button
          type="button"
          className="yh-btn"
          data-testid="table-dialog-del-row"
          onClick={() => setRows((prev) => deleteRow(prev, prev.length - 1))}
        >
          행 삭제
        </button>
        <button
          type="button"
          className="yh-btn"
          data-testid="table-dialog-del-col"
          onClick={() => setRows((prev) => deleteCol(prev, (prev[0]?.length ?? 1) - 1))}
        >
          열 삭제
        </button>
      </div>

      <div className="yh-table-dialog__actions">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="table-dialog-submit"
          onClick={submit}
        >
          적용
        </button>
        <button
          type="button"
          className="yh-btn"
          data-testid="table-dialog-close"
          onClick={() => onClose && onClose()}
        >
          닫기
        </button>
      </div>
    </div>
  );
}

export default TableEditDialog;
