import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FindReplaceDialog } from './FindReplaceDialog.jsx';

// 찾기/바꾸기 다이얼로그 — 순수 표시/폼 컴포넌트(ADR-003). 검색/치환은 props 콜백으로 위임하고
// 폼 상태(query/replacement/caseSensitive)만 내부 state로 둔다. 엔진(Step 0)·결선(Step 2)은 여기서 호출하지 않는다.
// noop 콜백 묶음 — 각 테스트가 관심 있는 콜백만 vi.fn()으로 덮어쓴다.
function noopProps(overrides = {}) {
  return {
    open: true,
    onQueryChange: vi.fn(),
    onFindNext: vi.fn(),
    onFindPrev: vi.fn(),
    onReplaceOne: vi.fn(),
    onReplaceAll: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('FindReplaceDialog — 찾기/바꾸기 다이얼로그', () => {
  it('open=false면 렌더하지 않는다', () => {
    const { container } = render(<FindReplaceDialog {...noopProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it('열리면 dialog와 입력/체크박스/버튼 5종을 보여준다', () => {
    render(<FindReplaceDialog {...noopProps()} />);
    expect(screen.getByRole('dialog', { name: '찾기/바꾸기' })).toBeInTheDocument();
    expect(screen.getByTestId('find-query')).toBeInTheDocument();
    expect(screen.getByTestId('find-replacement')).toBeInTheDocument();
    expect(screen.getByTestId('find-case')).toBeInTheDocument();
    expect(screen.getByTestId('find-next')).toBeInTheDocument();
    expect(screen.getByTestId('find-prev')).toBeInTheDocument();
    expect(screen.getByTestId('find-replace-one')).toBeInTheDocument();
    expect(screen.getByTestId('find-replace-all')).toBeInTheDocument();
    expect(screen.getByTestId('find-close')).toBeInTheDocument();
  });

  it("find-query에 'foo' 입력 시 onQueryChange가 ('foo', { caseSensitive:false })로 호출된다", () => {
    const onQueryChange = vi.fn();
    render(<FindReplaceDialog {...noopProps({ onQueryChange })} />);
    fireEvent.change(screen.getByTestId('find-query'), { target: { value: 'foo' } });
    expect(onQueryChange).toHaveBeenCalledWith('foo', { caseSensitive: false });
  });

  it('find-case 체크 시 onQueryChange가 현재 query와 caseSensitive:true로 호출된다', () => {
    const onQueryChange = vi.fn();
    render(<FindReplaceDialog {...noopProps({ onQueryChange })} />);
    fireEvent.change(screen.getByTestId('find-query'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('find-case'));
    expect(onQueryChange).toHaveBeenLastCalledWith('abc', { caseSensitive: true });
  });

  it('find-next/find-prev 클릭 → onFindNext/onFindPrev 호출', () => {
    const onFindNext = vi.fn();
    const onFindPrev = vi.fn();
    render(<FindReplaceDialog {...noopProps({ onFindNext, onFindPrev })} />);
    fireEvent.click(screen.getByTestId('find-next'));
    fireEvent.click(screen.getByTestId('find-prev'));
    expect(onFindNext).toHaveBeenCalledTimes(1);
    expect(onFindPrev).toHaveBeenCalledTimes(1);
  });

  it("find-replacement에 'bar' 입력 후 바꾸기/모두 바꾸기 → onReplaceOne/onReplaceAll('bar')", () => {
    const onReplaceOne = vi.fn();
    const onReplaceAll = vi.fn();
    render(<FindReplaceDialog {...noopProps({ onReplaceOne, onReplaceAll })} />);
    fireEvent.change(screen.getByTestId('find-replacement'), { target: { value: 'bar' } });
    fireEvent.click(screen.getByTestId('find-replace-one'));
    fireEvent.click(screen.getByTestId('find-replace-all'));
    expect(onReplaceOne).toHaveBeenCalledWith('bar');
    expect(onReplaceAll).toHaveBeenCalledWith('bar');
  });

  it('find-close 클릭 → onClose 호출, Esc 키 → onClose 호출', () => {
    const onClose = vi.fn();
    render(<FindReplaceDialog {...noopProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('find-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('matchCount={12} activeIndex={2} → find-status에 3/12 표시', () => {
    render(<FindReplaceDialog {...noopProps({ matchCount: 12, activeIndex: 2 })} />);
    expect(screen.getByTestId('find-status')).toHaveTextContent('3/12');
  });

  it('matchCount={0} + query 입력 → 검색 결과 없음', () => {
    render(<FindReplaceDialog {...noopProps({ matchCount: 0 })} />);
    expect(screen.getByTestId('find-status')).toHaveTextContent('');
    fireEvent.change(screen.getByTestId('find-query'), { target: { value: 'zzz' } });
    expect(screen.getByTestId('find-status')).toHaveTextContent('검색 결과 없음');
  });

  it('open이 false→true로 새로 열리면 폼이 초기화된다', () => {
    const { rerender } = render(<FindReplaceDialog {...noopProps()} />);
    fireEvent.change(screen.getByTestId('find-query'), { target: { value: 'keep' } });
    expect(screen.getByTestId('find-query')).toHaveValue('keep');

    rerender(<FindReplaceDialog {...noopProps({ open: false })} />);
    rerender(<FindReplaceDialog {...noopProps({ open: true })} />);
    expect(screen.getByTestId('find-query')).toHaveValue('');
  });

  // Step 0(27-editor-critical-fixes): 열림 시 포커스 이전 — 포커스가 에디터 본문(contentEditable)에 남으면
  // 검색어 타이핑이 기사 본문에 삽입되고(오염) 루트 onKeyDown의 Esc 닫기도 발화하지 않는다.
  it('open=true로 렌더된 직후 document.activeElement가 find-query다(열림 시 포커스 이전)', () => {
    render(<FindReplaceDialog {...noopProps()} />);
    expect(document.activeElement).toBe(screen.getByTestId('find-query'));
  });

  it('닫힘→열림(open false→true) 전이에서도 포커스가 find-query로 이동한다', () => {
    const { rerender } = render(<FindReplaceDialog {...noopProps({ open: false })} />);
    rerender(<FindReplaceDialog {...noopProps({ open: true })} />);
    expect(document.activeElement).toBe(screen.getByTestId('find-query'));
  });
});
