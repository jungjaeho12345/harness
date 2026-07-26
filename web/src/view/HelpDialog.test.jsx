import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HelpDialog } from './HelpDialog.jsx';
import { createTranslator } from './i18n.js';

// 도움말 열기 다이얼로그 — 순수 표시(읽기전용) 컴포넌트(ADR-003).
// 단축키/기능 안내를 정적으로 보여준다. 입력 폼·onSubmit·model 없음. controlled(open/onClose).
function baseProps(overrides = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('HelpDialog — 도움말 열기 다이얼로그(읽기전용)', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<HelpDialog {...baseProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면 dialog('도움말 열기')와 testid help-dialog를 보여준다", () => {
    render(<HelpDialog {...baseProps()} />);
    expect(screen.getByRole('dialog', { name: '도움말 열기' })).toBeInTheDocument();
    expect(screen.getByTestId('help-dialog')).toBeInTheDocument();
  });

  it('단축키 섹션과 실제 단축키 조합을 표시한다(predicate와 일치)', () => {
    render(<HelpDialog {...baseProps()} />);
    // 실제 editorShortcuts predicate와 일치하는 조합(글리프는 언어 무관).
    expect(screen.getByText('Alt+Y')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Y')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+D')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+F')).toBeInTheDocument();
    expect(screen.getByText('Alt+O')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Z')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Shift+Z')).toBeInTheDocument();
    // 이번 phase 신설 — 삽입/수정 토글.
    expect(screen.getByText('Insert')).toBeInTheDocument();
  });

  it('t 미전달 시 ko 폴백으로 제목/본문을 렌더한다', () => {
    render(<HelpDialog {...baseProps()} />);
    expect(screen.getByText('도움말 열기')).toBeInTheDocument();
    expect(screen.getByText('단축키')).toBeInTheDocument();
    // 단축키 설명(ko 폴백).
    expect(screen.getByText('삽입/수정 모드 전환')).toBeInTheDocument();
  });

  it("t=createTranslator('en') 전달 시 제목/본문이 영문으로 렌더된다", () => {
    render(<HelpDialog {...baseProps({ t: createTranslator('en') })} />);
    expect(screen.getByRole('dialog', { name: 'Open Help' })).toBeInTheDocument();
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
    expect(screen.getByText('Toggle Insert/Overwrite Mode')).toBeInTheDocument();
    // 단축키 글리프는 언어 무관 — 그대로.
    expect(screen.getByText('Alt+Y')).toBeInTheDocument();
  });

  it('닫기 버튼 클릭 → onClose 호출, Esc 키 → onClose 호출', () => {
    const onClose = vi.fn();
    render(<HelpDialog {...baseProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('help-dialog-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('onClose 미전달 시 닫기/Esc가 예외를 던지지 않는다', () => {
    render(<HelpDialog open />);
    expect(() => fireEvent.click(screen.getByTestId('help-dialog-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });

  it('읽기전용 — 입력 필드(input/textarea)가 없다', () => {
    const { container } = render(<HelpDialog {...baseProps()} />);
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('open false→true 재렌더 시 다이얼로그가 나타난다', () => {
    const { container, rerender } = render(<HelpDialog {...baseProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
    rerender(<HelpDialog {...baseProps({ open: true })} />);
    expect(screen.getByRole('dialog', { name: '도움말 열기' })).toBeInTheDocument();
  });

  it('open=true로 렌더된 직후 document.activeElement가 닫기 버튼이다(열림 시 포커스 이전)', () => {
    render(<HelpDialog {...baseProps()} />);
    expect(document.activeElement).toBe(screen.getByTestId('help-dialog-close'));
  });

  it('루트가 yh-editor-dialog 공용 클래스 + 전용 yh-editor-help 클래스를 가진다(중앙 모달)', () => {
    render(<HelpDialog {...baseProps()} />);
    const root = screen.getByTestId('help-dialog');
    expect(root).toHaveClass('yh-editor-dialog');
    expect(root).toHaveClass('yh-editor-help');
  });
});
