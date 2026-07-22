import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UiLanguageDialog } from './UiLanguageDialog.jsx';
import { createTranslator } from './i18n.js';

// UI 언어 설정 다이얼로그 — 순수 controlled 컴포넌트(ADR-003).
// open/value/onSelect/onClose는 부모(Step 3 WriterPage)가 소유한다 — 내부 state·localStorage·model·fetch 없음.
// t(key, fallback?)는 Step 0 createTranslator 결과. 미주입 시 ko 원문으로 저하되어야 한다(ko 불변식).
function noopProps(overrides = {}) {
  return {
    open: true,
    value: 'ko',
    t: undefined,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('UiLanguageDialog — UI 언어 설정 다이얼로그(controlled)', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<UiLanguageDialog {...noopProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면 dialog('UI 언어 설정')와 testid ui-language-dialog, ko/en 두 옵션이 보인다", () => {
    render(<UiLanguageDialog {...noopProps()} />);
    expect(screen.getByRole('dialog', { name: 'UI 언어 설정' })).toBeInTheDocument();
    expect(screen.getByTestId('ui-language-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('ui-language-option-ko')).toBeInTheDocument();
    expect(screen.getByTestId('ui-language-option-en')).toBeInTheDocument();
  });

  it('value=ko(기본)이면 ko 옵션이, value=en이면 en 옵션이 선택(checked) 표시된다', () => {
    const { rerender } = render(<UiLanguageDialog {...noopProps({ value: 'ko' })} />);
    expect(screen.getByTestId('ui-language-option-ko')).toBeChecked();
    expect(screen.getByTestId('ui-language-option-en')).not.toBeChecked();

    rerender(<UiLanguageDialog {...noopProps({ value: 'en' })} />);
    expect(screen.getByTestId('ui-language-option-en')).toBeChecked();
    expect(screen.getByTestId('ui-language-option-ko')).not.toBeChecked();
  });

  it("ko 옵션 선택 시 onSelect('ko'), en 옵션 선택 시 onSelect('en')가 호출된다", () => {
    const onSelect = vi.fn();
    // en이 현재값일 때 ko 옵션을 클릭하면 onSelect('ko')
    const { rerender } = render(
      <UiLanguageDialog {...noopProps({ value: 'en', onSelect })} />,
    );
    fireEvent.click(screen.getByTestId('ui-language-option-ko'));
    expect(onSelect).toHaveBeenCalledWith('ko');

    // ko가 현재값일 때 en 옵션을 클릭하면 onSelect('en')
    onSelect.mockClear();
    rerender(<UiLanguageDialog {...noopProps({ value: 'ko', onSelect })} />);
    fireEvent.click(screen.getByTestId('ui-language-option-en'));
    expect(onSelect).toHaveBeenCalledWith('en');
  });

  it("'닫기' 클릭·Escape 키에서 onClose가 호출된다", () => {
    const onClose = vi.fn();
    render(<UiLanguageDialog {...noopProps({ onClose })} />);

    fireEvent.click(screen.getByTestId('ui-language-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('onSelect/onClose 미전달 시 선택/닫기/Esc가 예외를 던지지 않는다', () => {
    render(<UiLanguageDialog open value="ko" />);
    expect(() => fireEvent.click(screen.getByTestId('ui-language-option-en'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('ui-language-close'))).not.toThrow();
    expect(() =>
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }),
    ).not.toThrow();
  });

  // 번역 반영 — 자기 자신도 t로 렌더된다. t 미주입/ko면 한글 원문, en이면 영문.
  it('t 미주입 시 제목/라벨/버튼이 ko 원문으로 렌더된다(폴백)', () => {
    render(<UiLanguageDialog {...noopProps({ t: undefined })} />);
    expect(screen.getByRole('dialog', { name: 'UI 언어 설정' })).toBeInTheDocument();
    expect(screen.getByText('한국어')).toBeInTheDocument();
    expect(screen.getByText('영어')).toBeInTheDocument();
    expect(screen.getByTestId('ui-language-close')).toHaveTextContent('닫기');
  });

  it("createTranslator('ko') 주입 시에도 ko 원문으로 렌더된다", () => {
    render(<UiLanguageDialog {...noopProps({ t: createTranslator('ko') })} />);
    expect(screen.getByRole('dialog', { name: 'UI 언어 설정' })).toBeInTheDocument();
    expect(screen.getByText('한국어')).toBeInTheDocument();
    expect(screen.getByText('영어')).toBeInTheDocument();
    expect(screen.getByTestId('ui-language-close')).toHaveTextContent('닫기');
  });

  it("createTranslator('en') 주입 시 제목/라벨/버튼이 영문으로 렌더된다", () => {
    render(<UiLanguageDialog {...noopProps({ t: createTranslator('en') })} />);
    expect(screen.getByRole('dialog', { name: 'UI Language' })).toBeInTheDocument();
    expect(screen.getByText('Korean')).toBeInTheDocument();
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.getByTestId('ui-language-close')).toHaveTextContent('Close');
  });

  it('open false→true 재렌더 시 다이얼로그가 나타난다', () => {
    const { container, rerender } = render(
      <UiLanguageDialog {...noopProps({ open: false })} />,
    );
    expect(container.firstChild).toBeNull();
    rerender(<UiLanguageDialog {...noopProps({ open: true, value: 'en' })} />);
    expect(screen.getByRole('dialog', { name: 'UI 언어 설정' })).toBeInTheDocument();
    expect(screen.getByTestId('ui-language-option-en')).toBeChecked();
  });

  // 열림 시 포커스 이전 — focusable 요소('닫기' 버튼, 비-변이 컨트롤)로 이전한다.
  // 포커스가 에디터 본문에 남으면 타이핑이 기사 본문에 삽입되고 Esc 닫기가 발화하지 않는다(useFocusOnOpen 주석).
  it('open=true로 렌더된 직후 document.activeElement가 focusable 요소(닫기 버튼)다', () => {
    render(<UiLanguageDialog {...noopProps()} />);
    expect(document.activeElement).toBe(screen.getByTestId('ui-language-close'));
  });
});

// 도구 메뉴 팝업 공통 — 화면 중앙 모달 스타일(yh-editor-dialog 공용 클래스).
describe('UiLanguageDialog — 중앙 모달 공통 스타일', () => {
  it('루트가 yh-editor-dialog 공용 + 전용 yh-editor-ui-language 클래스를 가진다', () => {
    render(<UiLanguageDialog {...noopProps()} />);
    const root = screen.getByTestId('ui-language-dialog');
    expect(root).toHaveClass('yh-editor-dialog');
    expect(root).toHaveClass('yh-editor-ui-language');
  });
});
