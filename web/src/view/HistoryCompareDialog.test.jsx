import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistoryCompareDialog } from './HistoryCompareDialog.jsx';

// 기사 이력 비교 다이얼로그 — 순수 표시(읽기전용) 컴포넌트(ADR-003).
// 비교 대상 목록(entries)·선택 key·비교용 텍스트는 부모가 props로 주입한다. transport/본문 변경 없음.
function baseProps(overrides = {}) {
  return {
    open: true,
    entries: [
      { key: 'current', label: '현재 본문' },
      { key: 7, label: '2026-07-01 10:00 홍길동' },
      { key: 8, label: '2026-07-02 11:00 김기자' },
    ],
    leftKey: 7,
    rightKey: 'current',
    leftText: null,
    rightText: null,
    onSelectLeft: vi.fn(),
    onSelectRight: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('HistoryCompareDialog — 기사 이력 비교 다이얼로그(읽기전용)', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<HistoryCompareDialog {...baseProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면 dialog('기사 이력 비교')와 testid history-compare를 보여준다", () => {
    render(<HistoryCompareDialog {...baseProps()} />);
    expect(screen.getByRole('dialog', { name: '기사 이력 비교' })).toBeInTheDocument();
    expect(screen.getByTestId('history-compare')).toBeInTheDocument();
  });

  it('entries를 좌/우 선택 컨트롤(select)에 옵션으로 표시한다', () => {
    render(<HistoryCompareDialog {...baseProps()} />);
    const left = screen.getByTestId('history-compare-left');
    const right = screen.getByTestId('history-compare-right');
    for (const sel of [left, right]) {
      const labels = Array.from(sel.querySelectorAll('option')).map((o) => o.textContent);
      expect(labels).toContain('현재 본문');
      expect(labels).toContain('2026-07-01 10:00 홍길동');
      expect(labels).toContain('2026-07-02 11:00 김기자');
    }
  });

  it('좌/우 선택 변경 시 onSelectLeft/onSelectRight가 원래 entry key로 호출된다', () => {
    const onSelectLeft = vi.fn();
    const onSelectRight = vi.fn();
    render(<HistoryCompareDialog {...baseProps({ onSelectLeft, onSelectRight })} />);
    fireEvent.change(screen.getByTestId('history-compare-left'), { target: { value: '8' } });
    expect(onSelectLeft).toHaveBeenCalledWith(8); // 문자열 '8'이 아닌 원래 key(숫자)로 복원
    fireEvent.change(screen.getByTestId('history-compare-right'), { target: { value: 'current' } });
    expect(onSelectRight).toHaveBeenCalledWith('current');
  });

  it('두 텍스트 주입 시 diffLines 결과를 표시한다(add/del/equal 세그먼트 렌더)', () => {
    render(
      <HistoryCompareDialog
        {...baseProps({ leftText: '제목\n이전 문장', rightText: '제목\n새 문장' })}
      />,
    );
    expect(screen.getByTestId('history-compare-diff')).toBeInTheDocument();
    const segs = screen.getAllByTestId('history-compare-segment');
    expect(segs.map((el) => el.getAttribute('data-type'))).toEqual(['equal', 'del', 'add']);
    expect(segs[1]).toHaveTextContent('이전 문장');
    expect(segs[2]).toHaveTextContent('새 문장');
  });

  it('텍스트가 아직 준비되지 않으면(null) diff 대신 안내 문구를 표시한다', () => {
    render(<HistoryCompareDialog {...baseProps({ leftText: null, rightText: '제목' })} />);
    expect(screen.queryByTestId('history-compare-diff')).toBeNull();
    expect(screen.getByTestId('history-compare-pending')).toBeInTheDocument();
  });

  it('비교 가능한 대상이 2개 미만이면 빈 상태를 표시한다(죽지 않음)', () => {
    render(
      <HistoryCompareDialog
        {...baseProps({ entries: [{ key: 'current', label: '현재 본문' }] })}
      />,
    );
    expect(screen.getByTestId('history-compare-empty')).toHaveTextContent('비교할 이력이 없습니다');
    expect(screen.queryByTestId('history-compare-diff')).toBeNull();
  });

  it('entries 미주입/빈 배열이어도 예외 없이 빈 상태로 렌더한다', () => {
    render(<HistoryCompareDialog open entries={undefined} onClose={vi.fn()} />);
    expect(screen.getByTestId('history-compare-empty')).toBeInTheDocument();
  });

  it('읽기전용 — 본문 입력용 input/textarea가 없다(선택용 select만 존재)', () => {
    const { container } = render(
      <HistoryCompareDialog {...baseProps({ leftText: 'a', rightText: 'b' })} />,
    );
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelectorAll('select')).toHaveLength(2);
  });

  it('닫기 버튼 클릭 → onClose 호출, Esc 키 → onClose 호출', () => {
    const onClose = vi.fn();
    render(<HistoryCompareDialog {...baseProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('history-compare-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('onClose 미전달 시 닫기/Esc가 예외를 던지지 않는다', () => {
    render(<HistoryCompareDialog open entries={[]} />);
    expect(() => fireEvent.click(screen.getByTestId('history-compare-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });

  // Step 0(27-editor-critical-fixes): 열림 시 포커스 이전 — select는 entries<2면 렌더되지 않으므로
  // 항상 실재하는 '닫기' 버튼으로 포커스한다. 포커스가 에디터 본문에 남으면 Esc 닫기가 발화하지 않는다.
  it('open=true로 렌더된 직후 document.activeElement가 닫기 버튼이다(열림 시 포커스 이전)', () => {
    render(<HistoryCompareDialog {...baseProps()} />);
    expect(document.activeElement).toBe(screen.getByTestId('history-compare-close'));
  });
});
