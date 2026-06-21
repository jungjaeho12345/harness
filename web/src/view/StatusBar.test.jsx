import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBar } from './StatusBar.jsx';

describe('StatusBar — 에디터 상태표시줄(순수 표시)', () => {
  it('단어수·행·열을 testid로 표시한다', () => {
    render(<StatusBar text="가 나" caret={{ lineIndex: 0, offset: 1 }} />);
    expect(screen.getByTestId('stat-words').textContent).toContain('2');
    const caretText = screen.getByTestId('stat-caret').textContent;
    expect(caretText).toContain('1행');
    expect(caretText).toContain('2열');
  });

  it('바이트수를 표시한다', () => {
    render(<StatusBar text="한글" />);
    expect(screen.getByTestId('stat-bytes').textContent).toContain('6');
  });

  it('기본값은 삽입·한국어(placeholder)', () => {
    render(<StatusBar text="" />);
    expect(screen.getByTestId('stat-mode').textContent).toBe('삽입');
    expect(screen.getByTestId('stat-language').textContent).toBe('한국어');
  });

  it('overwrite=true면 수정, language props를 그대로 표시한다', () => {
    render(<StatusBar text="" overwrite language="English" />);
    expect(screen.getByTestId('stat-mode').textContent).toBe('수정');
    expect(screen.getByTestId('stat-language').textContent).toBe('English');
  });

  it('props 없이도(기본값) 렌더된다 — 단락 1행 1열', () => {
    render(<StatusBar />);
    const caretText = screen.getByTestId('stat-caret').textContent;
    expect(caretText).toContain('1단락');
    expect(caretText).toContain('1행');
    expect(caretText).toContain('1열');
  });
});
