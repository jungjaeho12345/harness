import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  EditorToolBar,
  TOOLBAR_BUTTONS,
  TOOLBAR_FONTS,
  TOOLBAR_SIZES,
} from './EditorToolBar.jsx';

describe('TOOLBAR config (news.md 기사 에디터 툴바)', () => {
  it('13개 버튼을 명세 순서대로 정의한다', () => {
    expect(TOOLBAR_BUTTONS.map((b) => b.label)).toEqual([
      '새문서', '불러오기', '저장하기', '인쇄', '인쇄미리보기',
      '찾기/바꾸기', '맞춤법검사', '약물입력', '약어변환',
      '표 삽입', '그림삽입', '유튜브영상 삽입', '메모장',
    ]);
  });

  it('각 버튼은 안정 id와 label을 갖는다', () => {
    for (const btn of TOOLBAR_BUTTONS) {
      expect(typeof btn.id).toBe('string');
      expect(typeof btn.label).toBe('string');
    }
  });

  it('글꼴·글씨크기 옵션을 제공한다', () => {
    expect(TOOLBAR_FONTS.length).toBeGreaterThan(0);
    expect(TOOLBAR_SIZES.length).toBeGreaterThan(0);
  });
});

describe('EditorToolBar — 에디터 툴바(쉘, 비활성 placeholder)', () => {
  it('툴바를 렌더한다', () => {
    render(<EditorToolBar />);
    expect(screen.getByTestId('toolbar')).toBeInTheDocument();
  });

  it('글꼴·글씨크기 셀렉트 2개를 옵션과 함께 렌더한다', () => {
    render(<EditorToolBar />);
    const font = screen.getByTestId('tool-font');
    const size = screen.getByTestId('tool-size');
    expect(font.tagName).toBe('SELECT');
    expect(size.tagName).toBe('SELECT');
    expect(font.querySelectorAll('option').length).toBe(TOOLBAR_FONTS.length);
    expect(size.querySelectorAll('option').length).toBe(TOOLBAR_SIZES.length);
  });

  it('명세 13개 버튼을 모두 렌더한다', () => {
    render(<EditorToolBar />);
    for (const btn of TOOLBAR_BUTTONS) {
      expect(screen.getByTestId(`tool-${btn.label}`)).toBeInTheDocument();
    }
  });

  it('버튼은 모두 비활성(disabled) placeholder다', () => {
    render(<EditorToolBar />);
    for (const btn of TOOLBAR_BUTTONS) {
      expect(screen.getByTestId(`tool-${btn.label}`)).toBeDisabled();
    }
  });

  it('비활성 버튼 클릭은 onSelect를 호출하지 않는다 (쉘 — 액션 미결선)', async () => {
    const onSelect = vi.fn();
    render(<EditorToolBar onSelect={onSelect} />);
    await userEvent.click(screen.getByTestId('tool-새문서'));
    await userEvent.click(screen.getByTestId('tool-저장하기'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('글꼴 셀렉트 선택은 표시값만 바꾸고 부수효과가 없다 (model 미주입)', async () => {
    const onSelect = vi.fn();
    render(<EditorToolBar onSelect={onSelect} />);
    const font = screen.getByTestId('tool-font');
    await userEvent.selectOptions(font, TOOLBAR_FONTS[1]);
    expect(font).toHaveValue(TOOLBAR_FONTS[1]);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// 마우스 전용 chrome — Tab으로 툴바에 도달할 수 없다(키보드는 본문 편집 전용).
describe('EditorToolBar — 마우스 전용(키보드 제어 제거)', () => {
  it('글꼴·글씨크기 셀렉트는 Tab 포커스 대상이 아니다(tabIndex=-1)', () => {
    render(<EditorToolBar />);
    expect(screen.getByTestId('tool-font')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('tool-size')).toHaveAttribute('tabindex', '-1');
  });

  it('13개 버튼 모두 tabIndex=-1이다', () => {
    render(<EditorToolBar />);
    for (const btn of TOOLBAR_BUTTONS) {
      expect(screen.getByTestId(`tool-${btn.label}`)).toHaveAttribute('tabindex', '-1');
    }
  });
});
