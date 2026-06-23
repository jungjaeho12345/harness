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
});
