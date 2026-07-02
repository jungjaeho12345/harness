import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoDialog } from './MemoDialog.jsx';

// 메모장 다이얼로그 — 순수 표시/폼 컴포넌트(ADR-003). 텍스트는 부모가 주입(제어 컴포넌트)하고
// 변경/닫기는 콜백으로 위임한다. 자체 상태/영속화/본문 접근 없음. yh-memo 전용 클래스/testid.
function noopProps(overrides = {}) {
  return {
    open: true,
    text: '',
    onChange: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('MemoDialog — 메모장 다이얼로그', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<MemoDialog {...noopProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('memo')).toBeNull();
  });

  it("열리면 dialog('메모장')와 text 값을 표시하는 textarea를 보여준다", () => {
    render(<MemoDialog {...noopProps({ text: '취재 메모' })} />);
    expect(screen.getByRole('dialog', { name: '메모장' })).toBeInTheDocument();
    expect(screen.getByTestId('memo')).toBeInTheDocument();
    expect(screen.getByTestId('memo-textarea')).toHaveValue('취재 메모');
  });

  it('textarea 입력 시 onChange가 입력값으로 호출된다', () => {
    const onChange = vi.fn();
    render(<MemoDialog {...noopProps({ text: '', onChange })} />);
    fireEvent.change(screen.getByTestId('memo-textarea'), { target: { value: '새 메모' } });
    expect(onChange).toHaveBeenCalledWith('새 메모');
  });

  it('닫기 버튼 클릭 → onClose 호출, Esc 키 → onClose 호출', () => {
    const onClose = vi.fn();
    render(<MemoDialog {...noopProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('memo-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('onChange 미전달 시 textarea 입력이 예외를 던지지 않는다', () => {
    render(<MemoDialog open text="" onClose={vi.fn()} />);
    expect(() => fireEvent.change(screen.getByTestId('memo-textarea'), { target: { value: 'x' } })).not.toThrow();
  });

  it('onClose 미전달 시 닫기/Esc가 예외를 던지지 않는다', () => {
    render(<MemoDialog open text="" onChange={vi.fn()} />);
    expect(() => fireEvent.click(screen.getByTestId('memo-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });

  it('부모가 text를 갱신하면 textarea가 그 값을 반영한다(제어 컴포넌트)', () => {
    const { rerender } = render(<MemoDialog {...noopProps({ text: '이전' })} />);
    expect(screen.getByTestId('memo-textarea')).toHaveValue('이전');
    rerender(<MemoDialog {...noopProps({ text: '갱신됨' })} />);
    expect(screen.getByTestId('memo-textarea')).toHaveValue('갱신됨');
  });
});
