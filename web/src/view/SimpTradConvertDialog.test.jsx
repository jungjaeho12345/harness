import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SimpTradConvertDialog } from './SimpTradConvertDialog.jsx';

// 간↔번 방향 선택 다이얼로그 — 순수 표시(stateless) 컴포넌트(ADR-003).
// 방향만 onConvert(direction)로 부모에 위임한다(실제 본문 변환은 Step 1 WriterPage가 안전 경로로 수행). Enter 미인터셉트.
function noopProps(overrides = {}) {
  return {
    open: true,
    onConvert: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('SimpTradConvertDialog — 간↔번 방향 선택 다이얼로그', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<SimpTradConvertDialog {...noopProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면 dialog('간체/번체 변환')·testid·방향 2개·닫기·불완전 안내가 보인다", () => {
    render(<SimpTradConvertDialog {...noopProps()} />);
    expect(screen.getByRole('dialog', { name: '간체/번체 변환' })).toBeInTheDocument();
    expect(screen.getByTestId('simptrad-convert')).toBeInTheDocument();
    expect(screen.getByTestId('simptrad-to-trad')).toBeInTheDocument();
    expect(screen.getByTestId('simptrad-to-simp')).toBeInTheDocument();
    expect(screen.getByTestId('simptrad-close')).toBeInTheDocument();
    // 표 불완전 안내 문구.
    expect(screen.getByTestId('simptrad-convert')).toHaveTextContent(/미등록 문자는 원문이 유지/);
  });

  it("'간체→번체' 클릭 → onConvert('toTrad') 호출", () => {
    const onConvert = vi.fn();
    render(<SimpTradConvertDialog {...noopProps({ onConvert })} />);
    fireEvent.click(screen.getByTestId('simptrad-to-trad'));
    expect(onConvert).toHaveBeenCalledWith('toTrad');
  });

  it("'번체→간체' 클릭 → onConvert('toSimp') 호출", () => {
    const onConvert = vi.fn();
    render(<SimpTradConvertDialog {...noopProps({ onConvert })} />);
    fireEvent.click(screen.getByTestId('simptrad-to-simp'));
    expect(onConvert).toHaveBeenCalledWith('toSimp');
  });

  it('닫기 클릭·Esc → onClose 호출, Enter는 onConvert/onClose를 호출하지 않는다', () => {
    const onConvert = vi.fn();
    const onClose = vi.fn();
    render(<SimpTradConvertDialog {...noopProps({ onConvert, onClose })} />);
    fireEvent.click(screen.getByTestId('simptrad-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    // Enter는 가로채지 않는다.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConvert).not.toHaveBeenCalled();
  });

  it('onConvert/onClose 미전달 시 버튼 클릭/Esc가 예외를 던지지 않는다', () => {
    render(<SimpTradConvertDialog open />);
    expect(() => fireEvent.click(screen.getByTestId('simptrad-to-trad'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('simptrad-to-simp'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('simptrad-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });
});
