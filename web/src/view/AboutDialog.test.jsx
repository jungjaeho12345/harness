import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AboutDialog, EDITOR_VERSION } from './AboutDialog.jsx';
import { createTranslator } from './i18n.js';

// 에디터 정보 다이얼로그 — 순수 표시(읽기전용) 컴포넌트(ADR-003).
// 이름·버전 등 정적 정보만 보여준다. Date/외부 fetch/model 없음. controlled(open/onClose).
function baseProps(overrides = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('AboutDialog — 에디터 정보 다이얼로그(읽기전용)', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<AboutDialog {...baseProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면 dialog('에디터 정보')와 testid about-dialog를 보여준다", () => {
    render(<AboutDialog {...baseProps()} />);
    expect(screen.getByRole('dialog', { name: '에디터 정보' })).toBeInTheDocument();
    expect(screen.getByTestId('about-dialog')).toBeInTheDocument();
  });

  it('t 미전달 시 ko 폴백으로 이름/버전 라벨과 정적 정보를 렌더한다', () => {
    render(<AboutDialog {...baseProps()} />);
    expect(screen.getByText('에디터 정보')).toBeInTheDocument();
    expect(screen.getByText('기사 작성기')).toBeInTheDocument();
    // 기본 버전 상수 표시.
    expect(screen.getByTestId('about-dialog-version')).toHaveTextContent(EDITOR_VERSION);
  });

  it('version prop을 주면 그 값을 표시한다(정적 주입)', () => {
    render(<AboutDialog {...baseProps({ version: '9.9.9' })} />);
    expect(screen.getByTestId('about-dialog-version')).toHaveTextContent('9.9.9');
  });

  it("t=createTranslator('en') 전달 시 라벨/이름이 영문으로 렌더된다", () => {
    render(<AboutDialog {...baseProps({ t: createTranslator('en') })} />);
    expect(screen.getByRole('dialog', { name: 'About Editor' })).toBeInTheDocument();
    expect(screen.getByText('Article Writer')).toBeInTheDocument();
    expect(screen.getByText('Version')).toBeInTheDocument();
  });

  it('닫기 버튼 클릭 → onClose 호출, Esc 키 → onClose 호출', () => {
    const onClose = vi.fn();
    render(<AboutDialog {...baseProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('about-dialog-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('onClose 미전달 시 닫기/Esc가 예외를 던지지 않는다', () => {
    render(<AboutDialog open />);
    expect(() => fireEvent.click(screen.getByTestId('about-dialog-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });

  it('읽기전용 — 입력 필드(input/textarea)가 없다', () => {
    const { container } = render(<AboutDialog {...baseProps()} />);
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('open false→true 재렌더 시 다이얼로그가 나타난다', () => {
    const { container, rerender } = render(<AboutDialog {...baseProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
    rerender(<AboutDialog {...baseProps({ open: true })} />);
    expect(screen.getByRole('dialog', { name: '에디터 정보' })).toBeInTheDocument();
  });

  it('open=true로 렌더된 직후 document.activeElement가 닫기 버튼이다(열림 시 포커스 이전)', () => {
    render(<AboutDialog {...baseProps()} />);
    expect(document.activeElement).toBe(screen.getByTestId('about-dialog-close'));
  });

  it('루트가 yh-editor-dialog 공용 클래스 + 전용 yh-editor-about 클래스를 가진다(중앙 모달)', () => {
    render(<AboutDialog {...baseProps()} />);
    const root = screen.getByTestId('about-dialog');
    expect(root).toHaveClass('yh-editor-dialog');
    expect(root).toHaveClass('yh-editor-about');
  });
});
