import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GlyphInputDialog } from './GlyphInputDialog.jsx';

// 약물입력(Alt+O) 다이얼로그 — 순수 표시/폼 컴포넌트(ADR-003). 자주쓰는 약물(favorites)을 선택하면
// onPick(glyph)로 삽입을 위임하고, 사용자 키보드 약물(keymap)은 참조 표시만 한다(키조합 인터셉트 없음).
// 약물 삽입(블록/캐럿 계산)·결선(Step 4)은 여기서 호출하지 않는다.
// noop 콜백 묶음 — 각 테스트가 관심 있는 콜백만 vi.fn()으로 덮어쓴다.
function noopProps(overrides = {}) {
  return {
    open: true,
    favorites: [],
    keymap: [],
    onPick: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('GlyphInputDialog — 약물입력 다이얼로그', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<GlyphInputDialog {...noopProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면 dialog('약물 입력')와 favorites 약물 버튼 2개를 보여준다", () => {
    render(<GlyphInputDialog {...noopProps({ favorites: ['※', '◇'] })} />);
    expect(screen.getByRole('dialog', { name: '약물 입력' })).toBeInTheDocument();
    expect(screen.getByTestId('glyph-input')).toBeInTheDocument();
    expect(screen.getByTestId('glyph-input-fav-0')).toHaveTextContent('※');
    expect(screen.getByTestId('glyph-input-fav-1')).toHaveTextContent('◇');
  });

  it("favorites 약물 버튼 클릭 시 onPick이 그 약물로 호출된다('◇' → onPick('◇'))", () => {
    const onPick = vi.fn();
    render(<GlyphInputDialog {...noopProps({ favorites: ['※', '◇'], onPick })} />);
    fireEvent.click(screen.getByTestId('glyph-input-fav-1'));
    expect(onPick).toHaveBeenCalledWith('◇');
  });

  it("keymap={[{keys:'Ctrl+1', glyph:'★'}]}이면 'Ctrl+1 → ★' 참조 표시가 보인다", () => {
    render(<GlyphInputDialog {...noopProps({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }] })} />);
    expect(screen.getByTestId('glyph-input-key-0')).toHaveTextContent('Ctrl+1 → ★');
  });

  it('keymap 참조 항목 클릭 시 onPick이 그 glyph로 호출된다(편의 삽입)', () => {
    const onPick = vi.fn();
    render(<GlyphInputDialog {...noopProps({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }], onPick })} />);
    fireEvent.click(screen.getByTestId('glyph-input-key-0'));
    expect(onPick).toHaveBeenCalledWith('★');
  });

  it('닫기 버튼 클릭 → onClose 호출, Esc 키 → onClose 호출', () => {
    const onClose = vi.fn();
    render(<GlyphInputDialog {...noopProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('glyph-input-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('favorites/keymap 빈 배열이어도 크래시 없이 렌더되고 "등록된 약물 없음" 안내를 보여준다', () => {
    render(<GlyphInputDialog {...noopProps({ favorites: [], keymap: [] })} />);
    expect(screen.getByRole('dialog', { name: '약물 입력' })).toBeInTheDocument();
    expect(screen.getByTestId('glyph-input-fav-empty')).toBeInTheDocument();
    expect(screen.getByTestId('glyph-input-key-empty')).toBeInTheDocument();
  });

  it('onPick 미전달 시 약물 버튼 클릭이 예외를 던지지 않는다', () => {
    render(
      <GlyphInputDialog
        open
        favorites={['※']}
        keymap={[{ keys: 'Ctrl+1', glyph: '★' }]}
        onClose={vi.fn()}
      />,
    );
    expect(() => fireEvent.click(screen.getByTestId('glyph-input-fav-0'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('glyph-input-key-0'))).not.toThrow();
  });

  it('onClose 미전달 시 닫기/Esc가 예외를 던지지 않는다', () => {
    render(<GlyphInputDialog open favorites={['※']} keymap={[]} onPick={vi.fn()} />);
    expect(() => fireEvent.click(screen.getByTestId('glyph-input-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });

  it('중복 약물(favorites)도 인덱스로 안정 렌더한다(키 충돌 없음)', () => {
    render(<GlyphInputDialog {...noopProps({ favorites: ['※', '※'] })} />);
    expect(screen.getByTestId('glyph-input-fav-0')).toHaveTextContent('※');
    expect(screen.getByTestId('glyph-input-fav-1')).toHaveTextContent('※');
  });

  it('open false→true 재렌더 시 다이얼로그가 나타나고 favorites가 그대로 렌더된다', () => {
    const { container, rerender } = render(
      <GlyphInputDialog {...noopProps({ open: false, favorites: ['※', '◇'] })} />,
    );
    expect(container.firstChild).toBeNull();

    rerender(<GlyphInputDialog {...noopProps({ open: true, favorites: ['※', '◇'] })} />);
    expect(screen.getByRole('dialog', { name: '약물 입력' })).toBeInTheDocument();
    expect(screen.getByTestId('glyph-input-fav-0')).toHaveTextContent('※');
    expect(screen.getByTestId('glyph-input-fav-1')).toHaveTextContent('◇');
  });

  it('멀티문자 약물(\'※※\')도 한 버튼으로 렌더하고 그 문자열로 onPick을 호출한다', () => {
    const onPick = vi.fn();
    render(<GlyphInputDialog {...noopProps({ favorites: ['※※'], onPick })} />);
    expect(screen.getByTestId('glyph-input-fav-0')).toHaveTextContent('※※');
    fireEvent.click(screen.getByTestId('glyph-input-fav-0'));
    expect(onPick).toHaveBeenCalledWith('※※');
  });

  it('favorites 다수일 때 각 버튼이 testid 인덱스로 독립 매핑되어 해당 약물로 onPick한다', () => {
    const onPick = vi.fn();
    const favorites = ['①', '②', '③', '④'];
    render(<GlyphInputDialog {...noopProps({ favorites, onPick })} />);
    favorites.forEach((glyph, i) => {
      expect(screen.getByTestId(`glyph-input-fav-${i}`)).toHaveTextContent(glyph);
    });
    fireEvent.click(screen.getByTestId('glyph-input-fav-2'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('③');
  });

  it('keymap 다수 항목도 각 행이 testid 인덱스로 독립 표시·삽입되고 중복 glyph도 안정적이다', () => {
    const onPick = vi.fn();
    const keymap = [
      { keys: 'Ctrl+1', glyph: '★' },
      { keys: 'Ctrl+2', glyph: '☆' },
      { keys: 'Ctrl+3', glyph: '★' }, // 같은 glyph 중복 → 인덱스로 안정화
    ];
    render(<GlyphInputDialog {...noopProps({ keymap, onPick })} />);
    expect(screen.getByTestId('glyph-input-key-0')).toHaveTextContent('Ctrl+1 → ★');
    expect(screen.getByTestId('glyph-input-key-1')).toHaveTextContent('Ctrl+2 → ☆');
    expect(screen.getByTestId('glyph-input-key-2')).toHaveTextContent('Ctrl+3 → ★');
    fireEvent.click(screen.getByTestId('glyph-input-key-2'));
    expect(onPick).toHaveBeenCalledWith('★');
  });

  // Step 0(27-editor-critical-fixes): 열림 시 포커스 이전 — 텍스트 입력이 없으므로 '닫기' 버튼으로 포커스한다.
  // 약물 버튼에 초기 포커스를 두면 열림 직후 Space/Enter로 약물이 본문에 우발 삽입된다(액션 버튼 금지 규칙).
  it('open=true로 렌더된 직후 document.activeElement가 닫기 버튼이다(열림 시 포커스 이전)', () => {
    render(<GlyphInputDialog {...noopProps({ favorites: ['※', '◇'] })} />);
    expect(document.activeElement).toBe(screen.getByTestId('glyph-input-close'));
  });
});
