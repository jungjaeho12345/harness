import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AbbrevManageDialog } from './AbbrevManageDialog.jsx';

// 약어 관리 다이얼로그 — 순수 표시/CRUD(controlled) 컴포넌트(ADR-003).
// 커밋 목록(items)·영속은 부모 소유 — 내부 state는 미커밋 입력 2개뿐. Enter 미인터셉트(Escape만 닫기).
function noopProps(overrides = {}) {
  return {
    open: true,
    items: [],
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('AbbrevManageDialog — 약어 관리 다이얼로그', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<AbbrevManageDialog {...noopProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면 dialog('약어 관리')·testid·입력 2개·추가·닫기가 보인다", () => {
    render(<AbbrevManageDialog {...noopProps()} />);
    expect(screen.getByRole('dialog', { name: '약어 관리' })).toBeInTheDocument();
    expect(screen.getByTestId('abbrev-manage')).toBeInTheDocument();
    expect(screen.getByTestId('abbrev-manage-short')).toBeInTheDocument();
    expect(screen.getByTestId('abbrev-manage-long')).toBeInTheDocument();
    expect(screen.getByTestId('abbrev-manage-add')).toBeInTheDocument();
    expect(screen.getByTestId('abbrev-manage-close')).toBeInTheDocument();
  });

  it('items가 있으면 short → long 행과 삭제 버튼을 보여준다', () => {
    render(<AbbrevManageDialog {...noopProps({ items: [{ short: 'US', long: '미국' }] })} />);
    expect(screen.getByTestId('abbrev-manage-item-0')).toHaveTextContent('US → 미국');
    expect(screen.getByTestId('abbrev-manage-remove-0')).toBeInTheDocument();
  });

  it('짧은형·확장형 입력 후 추가 클릭 → onAdd(트림값) 호출 후 입력 클리어', () => {
    const onAdd = vi.fn();
    render(<AbbrevManageDialog {...noopProps({ onAdd })} />);
    const shortInput = screen.getByTestId('abbrev-manage-short');
    const longInput = screen.getByTestId('abbrev-manage-long');
    fireEvent.change(shortInput, { target: { value: '  US  ' } });
    fireEvent.change(longInput, { target: { value: ' 미국 ' } });
    fireEvent.click(screen.getByTestId('abbrev-manage-add'));
    expect(onAdd).toHaveBeenCalledWith('US', '미국');
    // 추가 후 두 입력이 비워진다(내부 state 클리어).
    expect(shortInput.value).toBe('');
    expect(longInput.value).toBe('');
  });

  it('짧은형만 입력하고 추가 → onAdd 미호출(no-op)', () => {
    const onAdd = vi.fn();
    render(<AbbrevManageDialog {...noopProps({ onAdd })} />);
    fireEvent.change(screen.getByTestId('abbrev-manage-short'), { target: { value: 'US' } });
    fireEvent.click(screen.getByTestId('abbrev-manage-add'));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('확장형만 입력하고 추가 → onAdd 미호출(no-op)', () => {
    const onAdd = vi.fn();
    render(<AbbrevManageDialog {...noopProps({ onAdd })} />);
    fireEvent.change(screen.getByTestId('abbrev-manage-long'), { target: { value: '미국' } });
    fireEvent.click(screen.getByTestId('abbrev-manage-add'));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('행 삭제 클릭 → onRemove(index) 호출', () => {
    const onRemove = vi.fn();
    render(<AbbrevManageDialog {...noopProps({ items: [{ short: 'US', long: '미국' }], onRemove })} />);
    fireEvent.click(screen.getByTestId('abbrev-manage-remove-0'));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it('닫기 클릭·Esc → onClose 호출, Enter는 onAdd/onClose를 호출하지 않는다', () => {
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(<AbbrevManageDialog {...noopProps({ onAdd, onClose })} />);
    fireEvent.click(screen.getByTestId('abbrev-manage-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    // Enter는 가로채지 않는다.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('onAdd/onRemove/onClose 미전달 시 추가/삭제/닫기/Esc가 예외를 던지지 않는다', () => {
    render(<AbbrevManageDialog open items={[{ short: 'US', long: '미국' }]} />);
    fireEvent.change(screen.getByTestId('abbrev-manage-short'), { target: { value: 'A' } });
    fireEvent.change(screen.getByTestId('abbrev-manage-long'), { target: { value: 'B' } });
    expect(() => fireEvent.click(screen.getByTestId('abbrev-manage-add'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('abbrev-manage-remove-0'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('abbrev-manage-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });

  it('중복 항목도 인덱스로 안정 렌더한다(키 충돌 없음)', () => {
    render(<AbbrevManageDialog {...noopProps({
      items: [{ short: 'US', long: '미국' }, { short: 'US', long: '미국' }],
    })}
    />);
    expect(screen.getByTestId('abbrev-manage-item-0')).toHaveTextContent('US → 미국');
    expect(screen.getByTestId('abbrev-manage-item-1')).toHaveTextContent('US → 미국');
  });

  // Step 0(27-editor-critical-fixes): 열림 시 포커스 이전 — 논리적 첫 텍스트 입력(짧은형 input)으로 포커스한다.
  // 포커스가 에디터 본문에 남으면 약어 타이핑이 기사 본문에 삽입되고 Esc 닫기도 발화하지 않는다.
  it('open=true로 렌더된 직후 document.activeElement가 짧은형 입력이다(열림 시 포커스 이전)', () => {
    render(<AbbrevManageDialog {...noopProps()} />);
    expect(document.activeElement).toBe(screen.getByTestId('abbrev-manage-short'));
  });
});
