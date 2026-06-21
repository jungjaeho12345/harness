import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EditorPrefsDialog } from './EditorPrefsDialog.jsx';
import { loadEditorPrefs, DEFAULT_EDITOR_PREFS } from './editorPrefs.js';
import { colorForRole, resetEditorColors } from './editorColoring.js';

// 색상 환경설정 모달 — 폼/적용/취소/기본값. editorPrefs(localStorage) + editorColoring(module 상태)을 직접 호출하므로
// localStorage.clear()(영속 누수 차단) + resetEditorColors()(module 상태 복원)로 격리한다.
describe('EditorPrefsDialog — 색상 환경설정 모달', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { resetEditorColors(); });

  it('open=false면 렌더하지 않는다', () => {
    const { container } = render(<EditorPrefsDialog open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('열리면 제목/부제목/본문/바탕 색 입력 4개를 보여준다(end는 없음)', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId('pref-color-title')).toBeInTheDocument();
    expect(screen.getByTestId('pref-color-subtitle')).toBeInTheDocument();
    expect(screen.getByTestId('pref-color-body')).toBeInTheDocument();
    expect(screen.getByTestId('pref-color-background')).toBeInTheDocument();
    expect(screen.queryByTestId('pref-color-end')).toBeNull();
  });

  it("부제목 색을 바꾸고 '적용' 시 saveEditorPrefs로 저장되고 colorForRole도 새 값을 반환한다", () => {
    const onClose = vi.fn();
    render(<EditorPrefsDialog open onClose={onClose} />);

    fireEvent.change(screen.getByTestId('pref-color-subtitle'), { target: { value: '#00ff00' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    // 영속(saveEditorPrefs) + 적용(setEditorColors) 둘 다 반영.
    expect(loadEditorPrefs().colors.subtitle).toBe('#00ff00');
    expect(colorForRole('subtitle')).toBe('#00ff00');
    // applied=true로 닫힘.
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("'적용'은 바탕색을 텍스트 색(setEditorColors)으로 적용하지 않는다(저장에만 반영)", () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pref-color-background'), { target: { value: '#222222' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    expect(loadEditorPrefs().colors.background).toBe('#222222'); // 저장됨
    // 바탕색은 텍스트 색 화이트리스트가 아니므로 colorForRole(body)는 기본 본문색 유지.
    expect(colorForRole('body')).toBe(DEFAULT_EDITOR_PREFS.colors.body);
  });

  it("'취소' 시 저장/적용 없이 닫히고 색이 불변이다", () => {
    const onClose = vi.fn();
    render(<EditorPrefsDialog open onClose={onClose} />);

    fireEvent.change(screen.getByTestId('pref-color-subtitle'), { target: { value: '#00ff00' } });
    fireEvent.click(screen.getByTestId('prefs-cancel'));

    // 저장 안 됨(기본값 유지) + module 색 불변.
    expect(loadEditorPrefs().colors.subtitle).toBe(DEFAULT_EDITOR_PREFS.colors.subtitle);
    expect(colorForRole('subtitle')).toBe(DEFAULT_EDITOR_PREFS.colors.subtitle);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it("'기본값'은 폼 색을 DEFAULT_EDITOR_PREFS 색으로 되돌린다", () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    const subtitle = screen.getByTestId('pref-color-subtitle');

    fireEvent.change(subtitle, { target: { value: '#00ff00' } });
    expect(subtitle).toHaveValue('#00ff00');

    fireEvent.click(screen.getByTestId('prefs-reset'));
    expect(subtitle).toHaveValue(DEFAULT_EDITOR_PREFS.colors.subtitle);
  });
});
