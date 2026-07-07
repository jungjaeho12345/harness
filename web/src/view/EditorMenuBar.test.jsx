import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

// Step 1(9-editor-text-transforms): enabledIds로 결선된 항목만 활성화.
describe('EditorMenuBar — enabledIds 항목 활성화(결선)', () => {
  it('enabledIds 미전달 시 모든 드롭다운 항목이 비활성이다(phase 8 하위호환)', async () => {
    render(<EditorMenuBar />);
    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    expect(screen.getByText('(끝)삽입').closest('button')).toBeDisabled();
    expect(screen.getByText('(계속)삽입').closest('button')).toBeDisabled();
  });

  it("enabledIds=['edit.insertContinue']면 그 항목만 활성·클릭 시 onSelect를 호출한다", async () => {
    const onSelect = vi.fn();
    render(<EditorMenuBar onSelect={onSelect} enabledIds={['edit.insertContinue']} />);
    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    expect(screen.getByText('(계속)삽입').closest('button')).toBeEnabled();
    expect(screen.getByText('(끝)삽입').closest('button')).toBeDisabled(); // 미결선 항목은 여전히 비활성
    await userEvent.click(screen.getByText('(계속)삽입'));
    expect(onSelect).toHaveBeenCalledWith('edit.insertContinue');
  });

  it('enabledIds를 Set으로도 받을 수 있다', async () => {
    const onSelect = vi.fn();
    render(<EditorMenuBar onSelect={onSelect} enabledIds={new Set(['view.toUpper'])} />);
    await userEvent.click(screen.getByRole('menuitem', { name: '보기' }));
    expect(screen.getByText('대문자로 바꾸기').closest('button')).toBeEnabled();
    await userEvent.click(screen.getByText('대문자로 바꾸기'));
    expect(onSelect).toHaveBeenCalledWith('view.toUpper');
  });

  // Step 1(11-editor-color-prefs): 도움말>환경설정(help.preferences) 결선.
  it("enabledIds=['help.preferences']면 도움말>환경설정이 활성·클릭 시 onSelect를 호출한다", async () => {
    const onSelect = vi.fn();
    render(<EditorMenuBar onSelect={onSelect} enabledIds={['help.preferences']} />);
    await userEvent.click(screen.getByRole('menuitem', { name: '도움말' }));
    expect(screen.getByText('환경설정').closest('button')).toBeEnabled();
    await userEvent.click(screen.getByText('환경설정'));
    expect(onSelect).toHaveBeenCalledWith('help.preferences');
  });
});

// 마우스 전용 chrome — 키보드는 항상 본문 편집에 남는다. Tab으로 메뉴바에 도달할 수 없고,
// 클릭(mousedown)이 에디터 포커스/캐럿을 뺏지 않는다(캐럿 위치 삽입 기능의 전제).
describe('EditorMenuBar — 마우스 전용(키보드 제어 제거)', () => {
  it('상단 메뉴 버튼 7개 모두 Tab 포커스 대상이 아니다(tabIndex=-1)', () => {
    render(<EditorMenuBar />);
    for (const label of ['파일', '편집', '보기', '맞춤법', '표', '도구', '도움말']) {
      expect(screen.getByRole('menuitem', { name: label })).toHaveAttribute('tabindex', '-1');
    }
  });

  it('드롭다운 항목 버튼도 tabIndex=-1이다(활성/비활성 무관)', async () => {
    render(<EditorMenuBar enabledIds={['file.new']} />);
    await userEvent.click(screen.getByRole('menuitem', { name: '파일' }));
    expect(screen.getByText('새문서').closest('button')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByText('인쇄').closest('button')).toHaveAttribute('tabindex', '-1');
  });

  it('상단 메뉴 mousedown은 기본동작(포커스 이동)을 막는다 — 에디터 캐럿 보존', () => {
    render(<EditorMenuBar />);
    // fireEvent는 preventDefault되면 false를 반환한다.
    expect(fireEvent.mouseDown(screen.getByRole('menuitem', { name: '파일' }))).toBe(false);
  });

  it('드롭다운 항목 mousedown도 포커스를 뺏지 않고, 클릭 동작은 유지된다', async () => {
    const onSelect = vi.fn();
    render(<EditorMenuBar onSelect={onSelect} enabledIds={['file.new']} />);
    await userEvent.click(screen.getByRole('menuitem', { name: '파일' }));
    const item = screen.getByText('새문서').closest('button');
    expect(fireEvent.mouseDown(item)).toBe(false);
    await userEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith('file.new');
  });
});
