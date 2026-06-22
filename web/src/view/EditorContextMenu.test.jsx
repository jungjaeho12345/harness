import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { EditorContextMenu, EDITOR_CONTEXT_ITEMS } from './EditorContextMenu.jsx';

// 에디터 본문 우클릭 컨텍스트 메뉴 — 순수 표시 컴포넌트(ADR-003).
// 활성/비활성은 enabledIds(EditorMenuBar 패턴)로만 결정하고, 동작은 onSelect(id)로 위임한다.
// 조회페이지 ContextMenu(yh-context-menu/buildContextMenuItems)와 충돌하지 않는 별도 컴포넌트/클래스/testid를 쓴다.
function noopProps(overrides = {}) {
  return {
    position: { x: 10, y: 20 },
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('EditorContextMenu — 에디터 우클릭 컨텍스트 메뉴', () => {
  it('EDITOR_CONTEXT_ITEMS가 news.md L173 순서의 12개 항목(라벨·shortcut)을 정의한다', () => {
    expect(EDITOR_CONTEXT_ITEMS.map((it) => [it.id, it.label, it.shortcut ?? null])).toEqual([
      ['ctx.companyCode', '기업코드변환', 'Ctrl+B'],
      ['ctx.cut', '잘라내기', 'Ctrl+X'],
      ['ctx.copy', '복사', 'Ctrl+C'],
      ['ctx.paste', '붙여넣기', 'Ctrl+V'],
      ['ctx.pasteOriginal', '원본 붙여넣기', 'Alt+V'],
      ['ctx.pasteText', '텍스트 붙여넣기', 'Ctrl+V'],
      ['ctx.symbolInput', '약물입력', 'Alt+O'],
      ['ctx.findReplace', '찾기/바꾸기', 'Ctrl+F'],
      ['ctx.selectAll', '전체 선택', 'Ctrl+A'],
      ['ctx.showMenuBar', '메뉴바 보이기', null],
      ['ctx.showToolBar', '툴바 보이기', null],
      ['ctx.showGlyphBar', '약물바 보이기', null],
    ]);
  });

  it('editor-context-menu testid와 yh-editor-context-menu 클래스로 렌더된다(조회페이지 ContextMenu와 분리)', () => {
    const { container } = render(<EditorContextMenu {...noopProps()} />);
    const menu = screen.getByTestId('editor-context-menu');
    expect(menu).toBeInTheDocument();
    expect(menu).toHaveClass('yh-editor-context-menu');
    // 조회페이지 메뉴 클래스를 절대 쓰지 않는다.
    expect(container.querySelector('.yh-context-menu')).toBeNull();
  });

  it('12개 항목을 모두 노출한다', () => {
    render(<EditorContextMenu {...noopProps()} />);
    for (const item of EDITOR_CONTEXT_ITEMS) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    }
  });

  it('enabledIds 미전달 시 전 항목이 비활성이다', () => {
    render(<EditorContextMenu {...noopProps()} />);
    for (const item of EDITOR_CONTEXT_ITEMS) {
      expect(screen.getByText(item.label).closest('button')).toBeDisabled();
    }
  });

  it("enabledIds=['ctx.findReplace']면 찾기/바꾸기만 활성이고 클릭 시 onSelect('ctx.findReplace')", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<EditorContextMenu {...noopProps({ enabledIds: ['ctx.findReplace'], onSelect, onClose })} />);

    const findBtn = screen.getByText('찾기/바꾸기').closest('button');
    expect(findBtn).toBeEnabled();
    // aux 항목은 비활성.
    expect(screen.getByText('기업코드변환').closest('button')).toBeDisabled();
    expect(screen.getByText('약물입력').closest('button')).toBeDisabled();
    expect(screen.getByText('전체 선택').closest('button')).toBeDisabled();

    fireEvent.click(findBtn);
    expect(onSelect).toHaveBeenCalledWith('ctx.findReplace');
    expect(onClose).toHaveBeenCalled();
  });

  it('비활성 항목 클릭은 onSelect를 호출하지 않는다', () => {
    const onSelect = vi.fn();
    render(<EditorContextMenu {...noopProps({ enabledIds: ['ctx.findReplace'], onSelect })} />);
    // disabled 버튼은 click이 먹지 않지만, 코드 가드도 검증한다(라벨 라우팅 금지·활성일 때만 위임).
    fireEvent.click(screen.getByText('기업코드변환').closest('button'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('enabledIds는 Set도 허용한다', () => {
    render(<EditorContextMenu {...noopProps({ enabledIds: new Set(['ctx.selectAll']) })} />);
    expect(screen.getByText('전체 선택').closest('button')).toBeEnabled();
    expect(screen.getByText('복사').closest('button')).toBeDisabled();
  });

  it("checkedIds=['ctx.showMenuBar']면 '메뉴바 보이기'에 체크 표식(aria-checked=true)이 보인다", () => {
    render(<EditorContextMenu {...noopProps({ enabledIds: ['ctx.showMenuBar'], checkedIds: ['ctx.showMenuBar'] })} />);
    const menuBarBtn = screen.getByText('메뉴바 보이기').closest('button');
    expect(menuBarBtn).toHaveAttribute('aria-checked', 'true');
    // 체크 표식(✓) 노출.
    expect(within(menuBarBtn).getByText('✓')).toBeInTheDocument();
    // 체크되지 않은 항목은 aria-checked=false.
    expect(screen.getByText('툴바 보이기').closest('button')).toHaveAttribute('aria-checked', 'false');
  });

  it('position.x/position.y로 절대 위치를 잡는다', () => {
    render(<EditorContextMenu {...noopProps({ position: { x: 33, y: 44 } })} />);
    const menu = screen.getByTestId('editor-context-menu');
    expect(menu.style.left).toBe('33px');
    expect(menu.style.top).toBe('44px');
  });

  it('Esc 키를 누르면 onClose가 호출된다', () => {
    const onClose = vi.fn();
    render(<EditorContextMenu {...noopProps({ onClose })} />);
    fireEvent.keyDown(screen.getByTestId('editor-context-menu'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('마우스가 메뉴를 벗어나면 onClose가 호출된다', () => {
    const onClose = vi.fn();
    render(<EditorContextMenu {...noopProps({ onClose })} />);
    fireEvent.mouseLeave(screen.getByTestId('editor-context-menu'));
    expect(onClose).toHaveBeenCalled();
  });
});
