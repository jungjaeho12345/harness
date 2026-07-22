import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorMenuBar, EDITOR_MENUS } from './EditorMenuBar.jsx';
import { createTranslator } from './i18n.js';

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

  it('활성 항목 클릭 시 onSelect 호출 후 드롭다운이 닫힌다(선택 즉시 닫힘)', async () => {
    const onSelect = vi.fn();
    render(<EditorMenuBar onSelect={onSelect} enabledIds={['edit.insertContinue']} />);
    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    expect(screen.getByTestId('menu-편집')).toBeInTheDocument();

    await userEvent.click(screen.getByText('(계속)삽입'));

    expect(onSelect).toHaveBeenCalledWith('edit.insertContinue');
    expect(screen.queryByTestId('menu-편집')).toBeNull();
  });

  it('비활성(placeholder) 항목 클릭은 드롭다운을 닫지 않는다(no-op)', async () => {
    render(<EditorMenuBar enabledIds={['edit.insertContinue']} />);
    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    await userEvent.click(screen.getByText('(끝)삽입')); // disabled — no-op
    expect(screen.getByTestId('menu-편집')).toBeInTheDocument();
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

// Step 2(42-editor-ui-language): 상단 메뉴바 라벨을 번역기 t로 렌더한다.
// ko 불변식: t 미전달/ko일 때 원문 라벨 그대로. testid/구조 키는 언어 무관 불변(원문 유지).
describe('EditorMenuBar — i18n 라벨(t prop, ko 불변식·en 번역)', () => {
  it('t 미전달 시 모든 메뉴/항목 라벨이 원문(ko)과 바이트 동일이다', async () => {
    render(<EditorMenuBar />);
    // 상단 7개 메뉴
    for (const label of ['파일', '편집', '보기', '맞춤법', '표', '도구', '도움말']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
    // 도구 항목 라벨(원문)
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    expect(screen.getByTestId('menu-도구')).toBeInTheDocument();
    expect(screen.getByText('UI 언어 설정')).toBeInTheDocument();
    expect(screen.getByText('약어변환')).toBeInTheDocument();
  });

  it("createTranslator('ko') 전달 시에도 라벨이 원문과 동일하다", async () => {
    render(<EditorMenuBar t={createTranslator('ko')} />);
    for (const label of ['파일', '편집', '보기', '맞춤법', '표', '도구', '도움말']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole('menuitem', { name: '파일' }));
    expect(screen.getByText('새문서')).toBeInTheDocument();
  });

  it("createTranslator('en') 전달 시 상단 메뉴 라벨이 영문으로 렌더된다", () => {
    render(<EditorMenuBar t={createTranslator('en')} />);
    for (const name of ['File', 'Edit', 'View', 'Spelling', 'Table', 'Tools', 'Help']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
    // 원문 한글 라벨은 더 이상 노출되지 않는다.
    expect(screen.queryByRole('menuitem', { name: '도구' })).toBeNull();
  });

  it("en에서도 data-testid는 원문 키(menu-도구)로 드롭다운을 조회할 수 있다", async () => {
    render(<EditorMenuBar t={createTranslator('en')} />);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Tools' }));
    // 표시 텍스트는 영문이지만 testid는 원문 label 기준으로 불변.
    expect(screen.getByTestId('menu-도구')).toBeInTheDocument();
    expect(screen.getByText('UI Language')).toBeInTheDocument();
    expect(screen.getByText('Convert Abbreviation')).toBeInTheDocument();
    // 한글 항목 라벨은 노출되지 않는다.
    expect(screen.queryByText('UI 언어 설정')).toBeNull();
  });

  it('en에서 shortcut(키 표기)은 번역하지 않고 그대로 표시한다', async () => {
    render(<EditorMenuBar t={createTranslator('en')} />);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    // 라벨은 영문, shortcut은 언어 무관.
    expect(screen.getByText('Insert (End)')).toBeInTheDocument();
    expect(screen.getByText('Alt+Y')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Y')).toBeInTheDocument();
  });

  it('en에서도 enabledIds 결선(id 기반)은 그대로 동작한다', async () => {
    const onSelect = vi.fn();
    render(
      <EditorMenuBar
        t={createTranslator('en')}
        onSelect={onSelect}
        enabledIds={['tools.uiLanguage']}
      />,
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Tools' }));
    const item = screen.getByText('UI Language').closest('button');
    expect(item).toBeEnabled();
    await userEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith('tools.uiLanguage');
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
