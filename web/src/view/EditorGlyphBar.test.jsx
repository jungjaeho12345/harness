import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorGlyphBar } from './EditorGlyphBar.jsx';

describe('EditorGlyphBar — 약물바(자주쓰는 약물 버튼군, 순수 표시)', () => {
  it('약물바를 전용 testid로 렌더한다', () => {
    render(<EditorGlyphBar items={['※']} />);
    expect(screen.getByTestId('glyph-bar')).toBeInTheDocument();
  });

  it('items의 각 약물을 버튼으로 렌더한다 (텍스트 표시)', () => {
    render(<EditorGlyphBar items={['※', '◇', '▲']} />);
    const bar = screen.getByTestId('glyph-bar');
    const buttons = bar.querySelectorAll('button');
    expect(buttons.length).toBe(3);
    expect(screen.getByTestId('glyph-bar-item-0')).toHaveTextContent('※');
    expect(screen.getByTestId('glyph-bar-item-1')).toHaveTextContent('◇');
    expect(screen.getByTestId('glyph-bar-item-2')).toHaveTextContent('▲');
  });

  it('약물 버튼 클릭 시 onPick이 그 약물 문자열로 호출된다', async () => {
    const onPick = vi.fn();
    render(<EditorGlyphBar items={['※', '◇', '▲']} onPick={onPick} />);
    await userEvent.click(screen.getByTestId('glyph-bar-item-1'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('◇');
  });

  it('빈 배열이어도 크래시 없이 렌더되고 버튼은 0개다', () => {
    render(<EditorGlyphBar items={[]} />);
    const bar = screen.getByTestId('glyph-bar');
    expect(bar).toBeInTheDocument();
    expect(bar.querySelectorAll('button').length).toBe(0);
  });

  it('items 미전달이어도 (기본값 []) 크래시 없이 렌더되고 버튼은 0개다', () => {
    render(<EditorGlyphBar />);
    const bar = screen.getByTestId('glyph-bar');
    expect(bar).toBeInTheDocument();
    expect(bar.querySelectorAll('button').length).toBe(0);
  });

  it('onPick 미전달 시 버튼 클릭이 예외를 던지지 않는다', async () => {
    render(<EditorGlyphBar items={['※']} />);
    await expect(userEvent.click(screen.getByTestId('glyph-bar-item-0'))).resolves.not.toThrow();
  });

  it('중복 약물도 인덱스로 안정 key를 갖고 각각 렌더된다', () => {
    render(<EditorGlyphBar items={['※', '※']} />);
    expect(screen.getByTestId('glyph-bar-item-0')).toHaveTextContent('※');
    expect(screen.getByTestId('glyph-bar-item-1')).toHaveTextContent('※');
  });

  it('role=toolbar와 aria-label을 갖는다 (접근성)', () => {
    render(<EditorGlyphBar items={['※']} />);
    const bar = screen.getByTestId('glyph-bar');
    expect(bar).toHaveAttribute('role', 'toolbar');
    expect(bar.getAttribute('aria-label')).toBeTruthy();
  });

  it('툴바(yh-editor-toolbar)와 다른 전용 클래스를 쓴다 (충돌 회피)', () => {
    render(<EditorGlyphBar items={['※']} />);
    const bar = screen.getByTestId('glyph-bar');
    expect(bar.className).toContain('yh-editor-glyphbar');
    expect(bar.className).not.toContain('yh-editor-toolbar');
  });

  // --- 보강: 첫 버튼 onPick 경로·버튼별 접근성 라벨·중복 약물 클릭 식별 ---

  it('첫 번째(index 0) 버튼 클릭도 그 약물로 onPick을 호출한다', async () => {
    const onPick = vi.fn();
    render(<EditorGlyphBar items={['※', '◇', '▲']} onPick={onPick} />);
    await userEvent.click(screen.getByTestId('glyph-bar-item-0'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('※');
  });

  it('각 약물 버튼은 그 약물을 가리키는 접근성 라벨을 갖는다', () => {
    render(<EditorGlyphBar items={['※', '◇']} />);
    expect(screen.getByTestId('glyph-bar-item-0').getAttribute('aria-label')).toContain('※');
    expect(screen.getByTestId('glyph-bar-item-1').getAttribute('aria-label')).toContain('◇');
  });

  it('약물 버튼은 type=button (form submit 부작용 없음)', () => {
    render(<EditorGlyphBar items={['※']} />);
    expect(screen.getByTestId('glyph-bar-item-0')).toHaveAttribute('type', 'button');
  });

  it('중복 약물도 클릭한 인덱스의 약물로 onPick을 호출한다', async () => {
    const onPick = vi.fn();
    render(<EditorGlyphBar items={['※', '※']} onPick={onPick} />);
    await userEvent.click(screen.getByTestId('glyph-bar-item-1'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('※');
  });
});
