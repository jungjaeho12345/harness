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

  it('바이트수를 표시한다 — 기본 unicode는 UTF-8', () => {
    render(<StatusBar text="한글" />);
    expect(screen.getByTestId('stat-bytes').textContent).toContain('6');
  });

  it('기본값은 삽입·한글(language 코드 ko의 라벨)', () => {
    render(<StatusBar text="" />);
    expect(screen.getByTestId('stat-mode').textContent).toBe('삽입');
    expect(screen.getByTestId('stat-language').textContent).toBe('한글');
  });

  it('overwrite=true면 수정, language 코드는 라벨로 표시한다', () => {
    render(<StatusBar text="" overwrite language="en" />);
    expect(screen.getByTestId('stat-mode').textContent).toBe('수정');
    expect(screen.getByTestId('stat-language').textContent).toBe('영어');
  });

  it('미지원 language 코드는 한글로 폴백한다', () => {
    render(<StatusBar text="" language="xx" />);
    expect(screen.getByTestId('stat-language').textContent).toBe('한글');
  });

  it('inputMode=ksc5601이면 EUC-KR 근사 바이트를 표시한다 — 비호환 0이면 stat-incompat 부재', () => {
    render(<StatusBar text="한글" inputMode="ksc5601" />);
    expect(screen.getByTestId('stat-bytes').textContent).toContain('4');
    expect(screen.queryByTestId('stat-incompat')).toBeNull();
  });

  it('inputMode=ksc5601에서 비호환 문자가 있으면 개수를 병기한다', () => {
    render(<StatusBar text="a😀" inputMode="ksc5601" />);
    expect(screen.getByTestId('stat-bytes').textContent).toContain('1');
    const incompat = screen.getByTestId('stat-incompat');
    expect(incompat.textContent).toContain('1');
  });

  it('unicode 모드는 비호환 문자가 있어도 UTF-8 바이트만 표시한다 — stat-incompat 부재', () => {
    render(<StatusBar text="a😀" />);
    expect(screen.getByTestId('stat-bytes').textContent).toContain('5');
    expect(screen.queryByTestId('stat-incompat')).toBeNull();
  });

  it('props 없이도(기본값) 렌더된다 — 단락 1행 1열', () => {
    render(<StatusBar />);
    const caretText = screen.getByTestId('stat-caret').textContent;
    expect(caretText).toContain('1단락');
    expect(caretText).toContain('1행');
    expect(caretText).toContain('1열');
  });
});
