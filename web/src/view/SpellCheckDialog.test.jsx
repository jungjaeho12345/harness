import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SpellCheckDialog } from './SpellCheckDialog.jsx';

// 맞춤법 검사 결과 목록 다이얼로그 — 순수 표시(읽기전용) 컴포넌트(ADR-003).
// issues(Step 0 Issue 계약 + snippet)·errorStyle은 부모가 props로 주입한다. 엔진 호출·본문 변경·자동교체 없음 —
// 항목 클릭(onSelect)·닫기(onClose)는 전부 콜백 위임(캐럿 이동 해석은 Step 2 부모 몫).
function baseIssues() {
  return [
    { start: 3, snippet: '역활', group: 'misuse', message: '오탈자 의심', suggestion: '역할' },
    { start: 10, snippet: '먹었다 먹었다', group: 'dupWord', message: '중복된 어절', suggestion: null },
    { start: 24, snippet: '정말!!!', group: 'punctuation', message: '문장부호 3연속 이상', suggestion: null },
  ];
}

function baseProps(overrides = {}) {
  return {
    open: true,
    issues: baseIssues(),
    errorStyle: 'bold',
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('SpellCheckDialog — 맞춤법 검사 결과 목록 다이얼로그(읽기전용)', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<SpellCheckDialog {...baseProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면 dialog('맞춤법 검사')와 testid spellcheck를 보여준다", () => {
    render(<SpellCheckDialog {...baseProps()} />);
    expect(screen.getByRole('dialog', { name: '맞춤법 검사' })).toBeInTheDocument();
    expect(screen.getByTestId('spellcheck')).toBeInTheDocument();
  });

  it('issues 개수만큼 항목 버튼과 오류 총 개수(N건)를 표시한다', () => {
    render(<SpellCheckDialog {...baseProps()} />);
    expect(screen.getByTestId('spellcheck-item-0')).toBeInTheDocument();
    expect(screen.getByTestId('spellcheck-item-1')).toBeInTheDocument();
    expect(screen.getByTestId('spellcheck-item-2')).toBeInTheDocument();
    expect(screen.getByTestId('spellcheck-count')).toHaveTextContent('3건');
  });

  it("errorStyle='bold'면 snippet 조각이 data-style='bold'로 렌더된다", () => {
    render(<SpellCheckDialog {...baseProps({ errorStyle: 'bold' })} />);
    const snippets = screen.getAllByTestId('spellcheck-snippet');
    expect(snippets).toHaveLength(3);
    for (const sn of snippets) expect(sn).toHaveAttribute('data-style', 'bold');
    expect(snippets[0]).toHaveTextContent('역활');
  });

  it("errorStyle='underline'이면 snippet 조각이 data-style='underline'으로 렌더된다", () => {
    render(<SpellCheckDialog {...baseProps({ errorStyle: 'underline' })} />);
    for (const sn of screen.getAllByTestId('spellcheck-snippet')) {
      expect(sn).toHaveAttribute('data-style', 'underline');
    }
  });

  it('suggestion이 있으면 → 제안을 함께 표시하고, null이면 제안을 렌더하지 않는다', () => {
    render(<SpellCheckDialog {...baseProps()} />);
    const withSuggestion = screen.getByTestId('spellcheck-item-0');
    expect(withSuggestion).toHaveTextContent('오탈자 의심');
    expect(withSuggestion).toHaveTextContent('→ 역할');
    const withoutSuggestion = screen.getByTestId('spellcheck-item-1');
    expect(withoutSuggestion).toHaveTextContent('중복된 어절');
    expect(within(withoutSuggestion).queryByTestId('spellcheck-suggestion')).toBeNull();
  });

  it('항목 클릭 → onSelect가 그 issue 객체로 호출된다(본문은 바꾸지 않음 — 위임만)', () => {
    const issues = baseIssues();
    const onSelect = vi.fn();
    render(<SpellCheckDialog {...baseProps({ issues, onSelect })} />);
    fireEvent.click(screen.getByTestId('spellcheck-item-1'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(issues[1]);
  });

  it('닫기 버튼 클릭 → onClose 호출, Esc 키 → onClose 호출', () => {
    const onClose = vi.fn();
    render(<SpellCheckDialog {...baseProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('spellcheck-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('issues가 빈 배열이면 빈 상태(spellcheck-empty)를 표시하고 항목/개수는 없다', () => {
    render(<SpellCheckDialog {...baseProps({ issues: [] })} />);
    expect(screen.getByTestId('spellcheck-empty')).toHaveTextContent('맞춤법 오류가 없습니다');
    expect(screen.queryByTestId('spellcheck-item-0')).toBeNull();
    expect(screen.queryByTestId('spellcheck-count')).toBeNull();
  });

  it('issues 미주입/비배열이어도 예외 없이 빈 상태로 렌더한다(Array.isArray 가드)', () => {
    render(<SpellCheckDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId('spellcheck-empty')).toBeInTheDocument();
    const { container } = render(
      <SpellCheckDialog open issues="비배열" onClose={vi.fn()} />,
    );
    expect(within(container).getByTestId('spellcheck-empty')).toBeInTheDocument();
  });

  it('onSelect/onClose 미전달 시 클릭·Esc가 예외를 던지지 않는다', () => {
    render(<SpellCheckDialog open issues={baseIssues()} />);
    expect(() => fireEvent.click(screen.getByTestId('spellcheck-item-0'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('spellcheck-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });

  // 자동교체 금지(news.md 확정 정책) — 버튼은 항목(캐럿 이동 위임) + 닫기뿐이고 입력폼이 없다.
  it('읽기전용 — input/textarea/form이 없고 버튼은 항목 N개 + 닫기 1개뿐이다(자동교체 버튼 없음)', () => {
    const { container } = render(<SpellCheckDialog {...baseProps()} />);
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(4); // 항목 3 + 닫기 1
    for (const btn of buttons) expect(btn).toHaveAttribute('type', 'button');
  });

  // Step 0(27-editor-critical-fixes): 열림 시 포커스 이전 — 포커스가 에디터 본문에 남으면
  // Esc 닫기가 발화하지 않고 타이핑이 본문에 들어간다. 항상 실재하는 '닫기' 버튼으로 포커스한다.
  it('open=true로 렌더된 직후 document.activeElement가 닫기 버튼이다(열림 시 포커스 이전)', () => {
    render(<SpellCheckDialog {...baseProps()} />);
    expect(document.activeElement).toBe(screen.getByTestId('spellcheck-close'));
  });
});

// 도구 메뉴 팝업 공통 — 화면 중앙 모달 스타일(yh-editor-dialog 공용 클래스, 2026-07-07 사용자 요청).
describe('SpellCheckDialog — 중앙 모달 공통 스타일', () => {
  it('루트가 yh-editor-dialog 공용 클래스 + 전용 yh-spellcheck 클래스를 가진다(다른 다이얼로그와 충돌 없음)', () => {
    render(<SpellCheckDialog {...baseProps()} />);
    const root = screen.getByTestId('spellcheck');
    expect(root).toHaveClass('yh-editor-dialog');
    expect(root).toHaveClass('yh-spellcheck');
  });
});
