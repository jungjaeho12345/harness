import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoDialog } from './MemoDialog.jsx';

// 메모장 다이얼로그 — 순수 표시/입력(controlled) 컴포넌트(ADR-003).
// 값(value)·영속·표시여부는 부모(Step 1 WriterPage)가 소유한다 — 내부 state·localStorage·model 없음.
function noopProps(overrides = {}) {
  return {
    open: true,
    value: '',
    onChange: vi.fn(),
    onSave: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('MemoDialog — 메모장 다이얼로그(controlled 표시/입력)', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<MemoDialog {...noopProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면 dialog('메모장')와 testid editor-memo, textarea(editor-memo-text)가 보인다", () => {
    render(<MemoDialog {...noopProps()} />);
    expect(screen.getByRole('dialog', { name: '메모장' })).toBeInTheDocument();
    expect(screen.getByTestId('editor-memo')).toBeInTheDocument();
    expect(screen.getByTestId('editor-memo-text')).toBeInTheDocument();
  });

  it('textarea가 value prop을 그대로 표시한다(controlled)', () => {
    render(<MemoDialog {...noopProps({ value: '주입된 메모' })} />);
    expect(screen.getByTestId('editor-memo-text')).toHaveValue('주입된 메모');
  });

  it('textarea에 입력하면 onChange가 최신 문자열로 호출된다', () => {
    const onChange = vi.fn();
    render(<MemoDialog {...noopProps({ onChange })} />);
    fireEvent.change(screen.getByTestId('editor-memo-text'), { target: { value: '새 메모' } });
    expect(onChange).toHaveBeenCalledWith('새 메모');
  });

  it("'저장' 클릭 시 onSave, '닫기' 클릭 시 onClose, Esc 키에서 onClose가 호출된다", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<MemoDialog {...noopProps({ onSave, onClose })} />);

    fireEvent.click(screen.getByTestId('editor-memo-save'));
    expect(onSave).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('editor-memo-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('onChange/onSave/onClose 미전달 시 입력/저장/닫기/Esc가 예외를 던지지 않는다', () => {
    render(<MemoDialog open value="내용" />);
    expect(() =>
      fireEvent.change(screen.getByTestId('editor-memo-text'), { target: { value: 'x' } }),
    ).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('editor-memo-save'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('editor-memo-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });

  it('Enter 키는 개행 — onSave/onClose를 호출하지 않는다(인터셉트 안 함)', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<MemoDialog {...noopProps({ onSave, onClose })} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('open false→true 재렌더 시 다이얼로그가 나타난다', () => {
    const { container, rerender } = render(<MemoDialog {...noopProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
    rerender(<MemoDialog {...noopProps({ open: true, value: '보존된 메모' })} />);
    expect(screen.getByRole('dialog', { name: '메모장' })).toBeInTheDocument();
    expect(screen.getByTestId('editor-memo-text')).toHaveValue('보존된 메모');
  });

  // Step 0(27-editor-critical-fixes): 열림 시 포커스 이전 — 논리적 첫 텍스트 입력(textarea)으로 포커스한다.
  // 포커스가 에디터 본문에 남으면 메모 타이핑이 기사 본문에 삽입되고 Esc 닫기도 발화하지 않는다.
  it('open=true로 렌더된 직후 document.activeElement가 메모 textarea다(열림 시 포커스 이전)', () => {
    render(<MemoDialog {...noopProps()} />);
    expect(document.activeElement).toBe(screen.getByTestId('editor-memo-text'));
  });
});

// 도구 메뉴 팝업 공통 — 화면 중앙 모달 스타일(yh-editor-dialog 공용 클래스, 2026-07-07 사용자 요청).
describe('MemoDialog — 중앙 모달 공통 스타일', () => {
  it('루트가 yh-editor-dialog 공용 클래스를 가져 화면 가운데 팝업으로 뜬다', () => {
    render(<MemoDialog {...noopProps()} />);
    expect(screen.getByTestId('editor-memo')).toHaveClass('yh-editor-dialog');
  });
});
