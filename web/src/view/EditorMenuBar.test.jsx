import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorMenuBar, EDITOR_MENUS } from './EditorMenuBar.jsx';

describe('EDITOR_MENUS — 메뉴 config (news.md 기사 상단 메뉴바)', () => {
  it('7개 상단 메뉴를 순서대로 정의한다', () => {
    expect(EDITOR_MENUS.map((m) => m.label)).toEqual([
      '파일', '편집', '보기', '맞춤법', '표', '도구', '도움말',
    ]);
  });

  it('각 메뉴는 항목 목록을 가지고, 항목은 id·label을 갖는다', () => {
    for (const menu of EDITOR_MENUS) {
      expect(menu.items.length).toBeGreaterThan(0);
      for (const item of menu.items) {
        expect(typeof item.id).toBe('string');
        expect(typeof item.label).toBe('string');
      }
    }
  });

  it('파일 메뉴는 명세의 8개 항목을 갖는다', () => {
    const file = EDITOR_MENUS.find((m) => m.label === '파일');
    expect(file.items.map((i) => i.label)).toEqual([
      '새문서', '문서열기', '저장', '다른이름으로 저장', '복구', '인쇄', '인쇄미리보기', '닫기',
    ]);
  });

  it('편집 메뉴는 (끝)삽입·(계속)삽입의 단축키를 표기한다', () => {
    const edit = EDITOR_MENUS.find((m) => m.label === '편집');
    expect(edit.items.find((i) => i.label === '(끝)삽입').shortcut).toBe('Alt+Y');
    expect(edit.items.find((i) => i.label === '(계속)삽입').shortcut).toBe('Ctrl+Y');
  });
});

describe('EditorMenuBar — 상단 메뉴바(쉘, 비활성 placeholder)', () => {
  it('7개 상단 메뉴 버튼을 렌더한다', () => {
    render(<EditorMenuBar />);
    expect(screen.getByTestId('menubar')).toBeInTheDocument();
    for (const label of ['파일', '편집', '보기', '맞춤법', '표', '도구', '도움말']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });

  it("'파일' 클릭 시 드롭다운이 열리고 항목이 보인다", async () => {
    render(<EditorMenuBar />);
    expect(screen.queryByTestId('menu-파일')).toBeNull();
    await userEvent.click(screen.getByRole('menuitem', { name: '파일' }));
    expect(screen.getByTestId('menu-파일')).toBeInTheDocument();
    expect(screen.getByText('새문서')).toBeInTheDocument();
    expect(screen.getByText('인쇄')).toBeInTheDocument();
  });

  it('드롭다운 항목은 비활성(disabled) placeholder로 렌더된다', async () => {
    render(<EditorMenuBar />);
    await userEvent.click(screen.getByRole('menuitem', { name: '파일' }));
    expect(screen.getByText('새문서').closest('button')).toBeDisabled();
    expect(screen.getByText('인쇄').closest('button')).toBeDisabled();
  });

  it('같은 메뉴를 다시 클릭하면 닫힌다', async () => {
    render(<EditorMenuBar />);
    const file = screen.getByRole('menuitem', { name: '파일' });
    await userEvent.click(file);
    expect(screen.getByTestId('menu-파일')).toBeInTheDocument();
    await userEvent.click(file);
    expect(screen.queryByTestId('menu-파일')).toBeNull();
  });

  it('Esc로 드롭다운이 닫힌다', async () => {
    render(<EditorMenuBar />);
    await userEvent.click(screen.getByRole('menuitem', { name: '파일' }));
    expect(screen.getByTestId('menu-파일')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('menu-파일')).toBeNull();
  });

  it('바깥 클릭으로 드롭다운이 닫힌다', async () => {
    render(
      <div>
        <EditorMenuBar />
        <button type="button">밖</button>
      </div>,
    );
    await userEvent.click(screen.getByRole('menuitem', { name: '파일' }));
    expect(screen.getByTestId('menu-파일')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '밖' }));
    expect(screen.queryByTestId('menu-파일')).toBeNull();
  });

  it("'편집'을 열면 '파일' 드롭다운은 닫힌다 (단일 열림)", async () => {
    render(<EditorMenuBar />);
    await userEvent.click(screen.getByRole('menuitem', { name: '파일' }));
    expect(screen.getByTestId('menu-파일')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    expect(screen.queryByTestId('menu-파일')).toBeNull();
    expect(screen.getByTestId('menu-편집')).toBeInTheDocument();
  });

  it('상단 메뉴 버튼은 aria-haspopup·aria-expanded를 갖는다', async () => {
    render(<EditorMenuBar />);
    const file = screen.getByRole('menuitem', { name: '파일' });
    expect(file).toHaveAttribute('aria-haspopup', 'true');
    expect(file).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(file);
    expect(file).toHaveAttribute('aria-expanded', 'true');
  });

  it('비활성 항목 클릭은 onSelect를 호출하지 않는다 (쉘 — 액션 미결선)', async () => {
    const onSelect = vi.fn();
    render(<EditorMenuBar onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('menuitem', { name: '파일' }));
    await userEvent.click(screen.getByText('새문서'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
