import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MetaSelectDialog } from './MetaSelectDialog.jsx';

// 공통정보 지역/내용/속성 선택 다이얼로그 — 순수 표시/폼 컴포넌트(ADR-003).
// groups/limit/title은 부모(Step 3 WriterPage)가 metaTaxonomy.metaFieldConfig로 뽑아 주입한다 —
//   테스트는 소형 fixture groups를 주입하고 onSubmit(조인 문자열)/onClose 위임만 단언한다.
// noop 콜백 묶음 — 각 테스트가 관심 있는 콜백만 vi.fn()으로 덮어쓴다(TableEditDialog 컨벤션).
function noopProps(overrides = {}) {
  return {
    open: true,
    title: '지역',
    groups: [{ label: 'g1', items: ['a', 'b', 'c'] }],
    limit: 5,
    value: '',
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

const item = (name) => screen.getByRole('checkbox', { name });

describe('MetaSelectDialog — 선택 토글', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    render(<MetaSelectDialog {...noopProps({ open: false })} />);
    expect(screen.queryByTestId('meta-dialog')).toBeNull();
  });

  it("열리면 dialog(aria-label=title)·그룹 헤더·항목 체크박스가 렌더되고, value='a'면 a 체크·b/c 미체크로 초기화된다", () => {
    render(<MetaSelectDialog {...noopProps({ value: 'a' })} />);
    expect(screen.getByRole('dialog', { name: '지역' })).toBeInTheDocument();
    expect(screen.getByText('g1')).toBeInTheDocument();
    expect(item('a')).toBeChecked();
    expect(item('b')).not.toBeChecked();
    expect(item('c')).not.toBeChecked();
  });

  it('항목 클릭으로 체크/해제가 토글된다', () => {
    render(<MetaSelectDialog {...noopProps()} />);
    fireEvent.click(item('b'));
    expect(item('b')).toBeChecked();
    fireEvent.click(item('b'));
    expect(item('b')).not.toBeChecked();
  });
});

describe('MetaSelectDialog — 한도(limit)', () => {
  it("limit=1, value='a' → 미체크 항목 b/c는 disabled, 체크된 a는 해제 가능(disabled 아님), 카운터 '1/1'", () => {
    render(<MetaSelectDialog {...noopProps({ limit: 1, value: 'a' })} />);
    expect(screen.getByTestId('meta-dialog-counter')).toHaveTextContent('1/1');
    expect(item('b')).toBeDisabled();
    expect(item('c')).toBeDisabled();
    expect(item('a')).not.toBeDisabled();
  });

  it('한도 도달 후 체크 해제하면 다른 항목이 다시 활성화된다(교체 허용)', () => {
    render(<MetaSelectDialog {...noopProps({ limit: 1, value: 'a' })} />);
    fireEvent.click(item('a'));
    expect(screen.getByTestId('meta-dialog-counter')).toHaveTextContent('0/1');
    expect(item('b')).not.toBeDisabled();
    fireEvent.click(item('b'));
    expect(item('b')).toBeChecked();
  });

  // ② 검토 minor 보강 — 시작부터 한도 초과여도 기존 데이터를 강제 삭감하지 않는다(비파괴 제출).
  it("시작부터 한도 초과(limit=1, value='a, b') → 카운터 '2/1', 미체크 c disabled, 체크된 a/b는 해제 가능, 그대로 적용 시 onSubmit('a, b')", () => {
    const onSubmit = vi.fn();
    render(<MetaSelectDialog {...noopProps({ limit: 1, value: 'a, b', onSubmit })} />);
    expect(screen.getByTestId('meta-dialog-counter')).toHaveTextContent('2/1');
    expect(item('c')).toBeDisabled();
    expect(item('a')).not.toBeDisabled();
    expect(item('b')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('meta-dialog-submit'));
    expect(onSubmit).toHaveBeenCalledWith('a, b');
  });
});

describe('MetaSelectDialog — 레거시(기존 값) 보존', () => {
  it("groups에 없는 value='zzz'는 '기존 값' 섹션에 체크 상태로 노출된다", () => {
    render(<MetaSelectDialog {...noopProps({ value: 'zzz' })} />);
    const legacy = screen.getByTestId('meta-dialog-legacy');
    expect(legacy).toBeInTheDocument();
    expect(item('zzz')).toBeChecked();
  });

  it('레거시 토큰을 해제하면 제출 문자열에서 빠진다(해제할 때만 제거 — 조용한 소실 금지)', () => {
    const onSubmit = vi.fn();
    render(<MetaSelectDialog {...noopProps({ value: 'zzz, a', onSubmit })} />);
    fireEvent.click(item('zzz'));
    fireEvent.click(screen.getByTestId('meta-dialog-submit'));
    expect(onSubmit).toHaveBeenCalledWith('a');
  });

  it("레거시도 한도 카운트에 포함된다 — limit=1, value='zzz'면 그룹 항목 전부 disabled", () => {
    render(<MetaSelectDialog {...noopProps({ limit: 1, value: 'zzz' })} />);
    expect(screen.getByTestId('meta-dialog-counter')).toHaveTextContent('1/1');
    expect(item('a')).toBeDisabled();
    expect(item('b')).toBeDisabled();
    expect(item('c')).toBeDisabled();
    expect(item('zzz')).not.toBeDisabled(); // 레거시는 항상 해제 가능
  });

  it('레거시 토큰이 없으면 기존 값 섹션을 렌더하지 않는다', () => {
    render(<MetaSelectDialog {...noopProps({ value: 'a' })} />);
    expect(screen.queryByTestId('meta-dialog-legacy')).toBeNull();
  });
});

describe('MetaSelectDialog — 제출/닫기', () => {
  it("적용 클릭 시 onSubmit이 조인 문자열로 호출되고 기존 토큰의 상대 순서가 유지된다(value='b'에서 a 추가 → 'b, a')", () => {
    const onSubmit = vi.fn();
    render(<MetaSelectDialog {...noopProps({ value: 'b', onSubmit })} />);
    fireEvent.click(item('a'));
    fireEvent.click(screen.getByTestId('meta-dialog-submit'));
    expect(onSubmit).toHaveBeenCalledWith('b, a');
  });

  it("Esc 키 또는 '닫기' 버튼으로 onClose가 호출되고 onSubmit은 호출되지 않는다(폐기)", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<MetaSelectDialog {...noopProps({ onSubmit, onClose })} />);
    fireEvent.click(screen.getByTestId('meta-dialog-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('onSubmit/onClose 미전달 시 적용/닫기/Esc가 예외를 던지지 않는다', () => {
    render(<MetaSelectDialog open title="지역" groups={[{ label: 'g1', items: ['a'] }]} limit={5} value="" />);
    expect(() => fireEvent.click(screen.getByTestId('meta-dialog-submit'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('meta-dialog-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });
});

describe('MetaSelectDialog — 재초기화(wasOpen 가드)', () => {
  it('open false→true 재전환 시 새 value로 재초기화된다(이전 편집 미잔존)', () => {
    const { rerender } = render(<MetaSelectDialog {...noopProps({ value: 'a' })} />);
    fireEvent.click(item('b')); // 편집 잔존 시도
    rerender(<MetaSelectDialog {...noopProps({ open: false, value: 'b' })} />);
    rerender(<MetaSelectDialog {...noopProps({ open: true, value: 'b' })} />);
    expect(item('b')).toBeChecked();
    expect(item('a')).not.toBeChecked();
  });

  it('열려 있는 동안 value가 바뀌어도 편집 중 선택을 리셋하지 않는다', () => {
    const { rerender } = render(<MetaSelectDialog {...noopProps({ value: 'a' })} />);
    fireEvent.click(item('b'));
    rerender(<MetaSelectDialog {...noopProps({ open: true, value: 'c' })} />);
    expect(item('a')).toBeChecked();
    expect(item('b')).toBeChecked();
    expect(item('c')).not.toBeChecked();
  });
});

// 27-editor-critical-fixes: 열림 시 포커스 이전 — 포커스가 에디터 본문(contentEditable)에 남으면
// 타이핑이 기사 본문에 삽입되고 Esc 닫기도 발화하지 않는다.
describe('MetaSelectDialog — 열림 시 포커스 이전', () => {
  it('open=true로 렌더된 직후 document.activeElement가 첫 체크박스다', () => {
    render(<MetaSelectDialog {...noopProps()} />);
    expect(document.activeElement).toBe(item('a'));
  });

  it('닫힘→열림(open false→true) 전이에서도 포커스가 첫 체크박스로 이동한다', () => {
    const { rerender } = render(<MetaSelectDialog {...noopProps({ open: false })} />);
    rerender(<MetaSelectDialog {...noopProps({ open: true })} />);
    expect(document.activeElement).toBe(item('a'));
  });

  it("항목이 없으면 '닫기' 버튼으로 포커스한다", () => {
    render(<MetaSelectDialog {...noopProps({ groups: [{ label: 'g1', items: [] }], value: '' })} />);
    expect(document.activeElement).toBe(screen.getByTestId('meta-dialog-close'));
  });

  // 리뷰 게이트 MINOR — 열림 시점에 이미 한도 도달이면 첫 항목(미체크)이 disabled라 focus()가 no-op →
  // 포커스가 다이얼로그 밖에 남아 Esc 닫기가 발화하지 않는다. 첫 '비-disabled' focusable로 가야 한다.
  it("한도 도달 오픈(limit=1, value='b') — 첫 항목 a는 disabled, 포커스는 체크된 b로 가고 Escape가 onClose를 발화한다", () => {
    const onClose = vi.fn();
    render(<MetaSelectDialog {...noopProps({ limit: 1, value: 'b', onClose })} />);
    expect(item('a')).toBeDisabled();
    expect(document.activeElement).toBe(item('b'));
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("그룹 항목이 전부 disabled면(limit=1, value='zzz') 포커스는 항상 해제 가능한 첫 레거시 체크박스로 간다", () => {
    render(<MetaSelectDialog {...noopProps({ limit: 1, value: 'zzz' })} />);
    expect(item('a')).toBeDisabled();
    expect(document.activeElement).toBe(item('zzz'));
  });
});

// 도구 메뉴 팝업 공통 — 화면 중앙 모달 스타일(yh-editor-dialog 공용 클래스) + 전용 클래스(yh-meta-dialog).
describe('MetaSelectDialog — 중앙 모달 공통 스타일', () => {
  it('루트가 yh-editor-dialog 공용 + yh-meta-dialog 전용 클래스를 가진다', () => {
    render(<MetaSelectDialog {...noopProps()} />);
    const root = screen.getByTestId('meta-dialog');
    expect(root).toHaveClass('yh-editor-dialog');
    expect(root).toHaveClass('yh-meta-dialog');
  });
});
