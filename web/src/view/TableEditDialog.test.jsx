import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TableEditDialog } from './TableEditDialog.jsx';

// 표 편집 다이얼로그 — 순수 표시/폼 컴포넌트(ADR-003). 그리드 입력 UI만 담당하고 onSubmit(rows)로 위임한다.
// 임베드 생성(makeTableEmbed)·삽입·본문 반영·타겟 탐색·클립보드는 부모(Step 3 WriterPage)가 한다.
// noop 콜백 묶음 — 각 테스트가 관심 있는 콜백만 vi.fn()으로 덮어쓴다(UrlEmbedDialog 컨벤션).
function noopProps(overrides = {}) {
  return {
    open: true,
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

const cell = (r, c) => screen.getByTestId(`table-dialog-cell-${r}-${c}`);
const queryCell = (r, c) => screen.queryByTestId(`table-dialog-cell-${r}-${c}`);
const cellCount = () => screen.getAllByTestId(/^table-dialog-cell-\d+-\d+$/).length;

describe('TableEditDialog — 표 편집 다이얼로그', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<TableEditDialog {...noopProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면(initialRows 미전달) dialog('표 편집')와 기본 2×2 그리드·적용·닫기 버튼을 보여준다", () => {
    render(<TableEditDialog {...noopProps()} />);
    expect(screen.getByRole('dialog', { name: '표 편집' })).toBeInTheDocument();
    expect(screen.getByTestId('table-dialog')).toBeInTheDocument();
    expect(cell(0, 0)).toBeInTheDocument();
    expect(cell(1, 1)).toBeInTheDocument();
    expect(cellCount()).toBe(4);
    expect(screen.getByTestId('table-dialog-submit')).toBeInTheDocument();
    expect(screen.getByTestId('table-dialog-close')).toBeInTheDocument();
  });

  it('initialRows가 있으면 셀 입력에 기존 값이 채워져 보인다(편집 모드)', () => {
    render(<TableEditDialog {...noopProps({ initialRows: [['가', '나']] })} />);
    expect(cell(0, 0)).toHaveValue('가');
    expect(cell(0, 1)).toHaveValue('나');
    expect(cellCount()).toBe(2);
  });

  it('ragged initialRows는 normalizeTableRows로 직사각형 패딩되어 보인다', () => {
    render(<TableEditDialog {...noopProps({ initialRows: [['가'], ['나', '다']] })} />);
    expect(cellCount()).toBe(4);
    expect(cell(0, 0)).toHaveValue('가');
    expect(cell(0, 1)).toHaveValue(''); // 패딩 셀
    expect(cell(1, 1)).toHaveValue('다');
  });

  it("셀 입력에 타이핑 후 '적용' 클릭 시 onSubmit이 그 값을 반영한 2차원 배열로 호출된다", () => {
    const onSubmit = vi.fn();
    render(<TableEditDialog {...noopProps({ onSubmit, initialRows: [['가', '나']] })} />);
    fireEvent.change(cell(0, 1), { target: { value: '수정' } });
    fireEvent.click(screen.getByTestId('table-dialog-submit'));
    expect(onSubmit).toHaveBeenCalledWith([['가', '수정']]);
  });

  it('셀 입력에서 Enter로도 onSubmit이 호출된다', () => {
    const onSubmit = vi.fn();
    render(<TableEditDialog {...noopProps({ onSubmit, initialRows: [['가']] })} />);
    fireEvent.keyDown(cell(0, 0), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith([['가']]);
  });

  it("모든 셀이 공백이어도 '적용'은 onSubmit을 호출한다(빈 표 허용 — URL no-op 가드와 다름)", () => {
    const onSubmit = vi.fn();
    render(<TableEditDialog {...noopProps({ onSubmit })} />);
    fireEvent.click(screen.getByTestId('table-dialog-submit'));
    expect(onSubmit).toHaveBeenCalledWith([
      ['', ''],
      ['', ''],
    ]);
  });

  it("'행 추가' 클릭 시 행이 끝에 1개 늘고 기존 셀 값은 유지된다", () => {
    render(<TableEditDialog {...noopProps({ initialRows: [['가', '나']] })} />);
    fireEvent.click(screen.getByTestId('table-dialog-add-row'));
    expect(cellCount()).toBe(4);
    expect(cell(0, 0)).toHaveValue('가');
    expect(cell(1, 0)).toHaveValue('');
    expect(cell(1, 1)).toHaveValue('');
  });

  it("'열 추가' 클릭 시 열이 끝에 1개 늘고 기존 셀 값은 유지된다", () => {
    render(<TableEditDialog {...noopProps({ initialRows: [['가'], ['나']] })} />);
    fireEvent.click(screen.getByTestId('table-dialog-add-col'));
    expect(cellCount()).toBe(4);
    expect(cell(0, 0)).toHaveValue('가');
    expect(cell(0, 1)).toHaveValue('');
    expect(cell(1, 0)).toHaveValue('나');
  });

  it("'행 삭제'는 마지막 행을 지우되 최소 1행을 남긴다(1행에서 클릭 시 그대로)", () => {
    render(<TableEditDialog {...noopProps()} />);
    fireEvent.click(screen.getByTestId('table-dialog-del-row'));
    expect(cellCount()).toBe(2); // 2×2 → 1×2
    expect(queryCell(1, 0)).toBeNull();
    fireEvent.click(screen.getByTestId('table-dialog-del-row'));
    expect(cellCount()).toBe(2); // 최소 1행 유지 — 변화 없음
  });

  it("'열 삭제'는 마지막 열을 지우되 최소 1열을 남긴다(1열에서 클릭 시 그대로)", () => {
    render(<TableEditDialog {...noopProps()} />);
    fireEvent.click(screen.getByTestId('table-dialog-del-col'));
    expect(cellCount()).toBe(2); // 2×2 → 2×1
    expect(queryCell(0, 1)).toBeNull();
    fireEvent.click(screen.getByTestId('table-dialog-del-col'));
    expect(cellCount()).toBe(2); // 최소 1열 유지 — 변화 없음
  });

  it("Esc 키 또는 '닫기' 버튼으로 onClose가 호출된다", () => {
    const onClose = vi.fn();
    render(<TableEditDialog {...noopProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('table-dialog-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('open false→true 재전환 시 기본 그리드로 초기화된다(이전 편집 미잔존)', () => {
    const { rerender } = render(<TableEditDialog {...noopProps({ open: true })} />);
    fireEvent.change(cell(0, 0), { target: { value: '남은편집' } });
    fireEvent.click(screen.getByTestId('table-dialog-add-row'));
    expect(cellCount()).toBe(6);

    rerender(<TableEditDialog {...noopProps({ open: false })} />);
    rerender(<TableEditDialog {...noopProps({ open: true })} />);
    expect(cellCount()).toBe(4);
    expect(cell(0, 0)).toHaveValue('');
  });

  it('open false→true 재전환 시 initialRows로 초기화된다(편집 재진입)', () => {
    const initialRows = [['가', '나']];
    const { rerender } = render(<TableEditDialog {...noopProps({ initialRows })} />);
    fireEvent.change(cell(0, 0), { target: { value: '편집중' } });
    expect(cell(0, 0)).toHaveValue('편집중');

    rerender(<TableEditDialog {...noopProps({ open: false, initialRows })} />);
    rerender(<TableEditDialog {...noopProps({ open: true, initialRows })} />);
    expect(cell(0, 0)).toHaveValue('가');
    expect(cell(0, 1)).toHaveValue('나');
  });

  it('onSubmit 미전달 시 적용 클릭/Enter가 예외를 던지지 않는다', () => {
    render(<TableEditDialog open onClose={vi.fn()} />);
    expect(() => fireEvent.click(screen.getByTestId('table-dialog-submit'))).not.toThrow();
    expect(() => fireEvent.keyDown(cell(0, 0), { key: 'Enter' })).not.toThrow();
  });

  it('onClose 미전달 시 닫기/Esc가 예외를 던지지 않는다', () => {
    render(<TableEditDialog open onSubmit={vi.fn()} />);
    expect(() => fireEvent.click(screen.getByTestId('table-dialog-close'))).not.toThrow();
    expect(() =>
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }),
    ).not.toThrow();
  });

  // 27-editor-critical-fixes: 열림 시 포커스 이전 — 논리적 첫 입력(첫 셀)으로 포커스한다.
  // 포커스가 에디터 본문에 남으면 셀 타이핑이 기사 본문에 삽입되고 Esc 닫기도 발화하지 않는다.
  it('open=true로 렌더된 직후 document.activeElement가 첫 셀 입력이다(열림 시 포커스 이전)', () => {
    render(<TableEditDialog {...noopProps()} />);
    expect(document.activeElement).toBe(cell(0, 0));
  });

  it('닫힘→열림(open false→true) 전이에서도 포커스가 첫 셀 입력으로 이동한다', () => {
    const { rerender } = render(<TableEditDialog {...noopProps({ open: false })} />);
    rerender(<TableEditDialog {...noopProps({ open: true })} />);
    expect(document.activeElement).toBe(cell(0, 0));
  });
});

// 도구 메뉴 팝업 공통 — 화면 중앙 모달 스타일(yh-editor-dialog 공용 클래스) + 전용 클래스(yh-table-dialog).
describe('TableEditDialog — 중앙 모달 공통 스타일', () => {
  it('루트가 yh-editor-dialog 공용 + yh-table-dialog 전용 클래스를 가진다', () => {
    render(<TableEditDialog {...noopProps()} />);
    const root = screen.getByTestId('table-dialog');
    expect(root).toHaveClass('yh-editor-dialog');
    expect(root).toHaveClass('yh-table-dialog');
  });
});
