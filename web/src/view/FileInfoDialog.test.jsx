import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileInfoDialog } from './FileInfoDialog.jsx';

// 파일 정보 다이얼로그 — 순수 표시(읽기전용) 컴포넌트(ADR-003).
// 통계는 props(stats)로만 받아 표시한다. 입력 폼·onSubmit·onPick 없음.
function noopProps(overrides = {}) {
  return {
    open: true,
    stats: {
      chars: 0,
      words: 0,
      bytes: 0,
      lines: 1,
      embeds: 0,
      paragraph: 1,
      row: 1,
      column: 1,
    },
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('FileInfoDialog — 파일 정보 다이얼로그(읽기전용)', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<FileInfoDialog {...noopProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면 dialog('파일 정보')와 testid file-info를 보여준다", () => {
    render(<FileInfoDialog {...noopProps()} />);
    expect(screen.getByRole('dialog', { name: '파일 정보' })).toBeInTheDocument();
    expect(screen.getByTestId('file-info')).toBeInTheDocument();
  });

  it('주입한 통계를 각 testid에 표시한다', () => {
    const stats = {
      chars: 12,
      words: 3,
      bytes: 30,
      lines: 4,
      embeds: 2,
      paragraph: 2,
      row: 4,
      column: 5,
    };
    render(<FileInfoDialog {...noopProps({ stats })} />);
    expect(screen.getByTestId('file-info-chars')).toHaveTextContent('12');
    expect(screen.getByTestId('file-info-words')).toHaveTextContent('3');
    expect(screen.getByTestId('file-info-bytes')).toHaveTextContent('30');
    expect(screen.getByTestId('file-info-lines')).toHaveTextContent('4');
    expect(screen.getByTestId('file-info-embeds')).toHaveTextContent('2');
    expect(screen.getByTestId('file-info-caret')).toHaveTextContent('2단락 4행 5열');
  });

  it('stats 미주입(undefined)이어도 예외 없이 0/기본값으로 렌더한다', () => {
    render(<FileInfoDialog open stats={undefined} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: '파일 정보' })).toBeInTheDocument();
    expect(screen.getByTestId('file-info-chars')).toHaveTextContent('0');
    expect(screen.getByTestId('file-info-caret')).toHaveTextContent('1단락 1행 1열');
  });

  it('stats 일부 필드 누락이어도 누락 값은 안전 폴백(0/1)으로 렌더한다', () => {
    render(<FileInfoDialog open stats={{ chars: 5 }} onClose={vi.fn()} />);
    expect(screen.getByTestId('file-info-chars')).toHaveTextContent('5');
    expect(screen.getByTestId('file-info-words')).toHaveTextContent('0');
    expect(screen.getByTestId('file-info-caret')).toHaveTextContent('1단락 1행 1열');
  });

  it('닫기 버튼 클릭 → onClose 호출, Esc 키 → onClose 호출', () => {
    const onClose = vi.fn();
    render(<FileInfoDialog {...noopProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('file-info-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('onClose 미전달 시 닫기/Esc가 예외를 던지지 않는다', () => {
    render(<FileInfoDialog open stats={{}} />);
    expect(() => fireEvent.click(screen.getByTestId('file-info-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });

  it('읽기전용 — 입력 필드(input/textarea)가 없다', () => {
    const { container } = render(<FileInfoDialog {...noopProps()} />);
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('open false→true 재렌더 시 다이얼로그가 나타난다', () => {
    const { container, rerender } = render(<FileInfoDialog {...noopProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
    rerender(<FileInfoDialog {...noopProps({ open: true })} />);
    expect(screen.getByRole('dialog', { name: '파일 정보' })).toBeInTheDocument();
  });

  // Step 0(27-editor-critical-fixes): 열림 시 포커스 이전 — 읽기전용(입력 없음)이라 '닫기' 버튼으로 포커스한다.
  // 포커스가 에디터 본문에 남으면 Esc 닫기가 발화하지 않고 타이핑이 본문에 들어간다.
  it('open=true로 렌더된 직후 document.activeElement가 닫기 버튼이다(열림 시 포커스 이전)', () => {
    render(<FileInfoDialog {...noopProps()} />);
    expect(document.activeElement).toBe(screen.getByTestId('file-info-close'));
  });
});
