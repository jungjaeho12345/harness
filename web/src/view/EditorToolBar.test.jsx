import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  EditorToolBar,
  TOOLBAR_FONTS,
  TOOLBAR_SIZES,
} from './EditorToolBar.jsx';

describe('TOOLBAR config (news.md 기사 에디터 툴바)', () => {
  it('글꼴·글씨크기 옵션을 제공한다', () => {
    expect(TOOLBAR_FONTS.length).toBeGreaterThan(0);
    expect(TOOLBAR_SIZES.length).toBeGreaterThan(0);
  });
});

describe('EditorToolBar — 에디터 툴바(글꼴/크기 셀렉트만)', () => {
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

  it('기능 버튼군(새문서/저장하기/인쇄 등 placeholder)은 렌더하지 않는다 — 제거 회귀 가드', () => {
    render(<EditorToolBar />);
    // 구 TOOLBAR_BUTTONS 13개(전부 비활성 placeholder)는 사용자 요청으로 제거됨(2026-07-07).
    expect(screen.getByTestId('toolbar').querySelectorAll('button').length).toBe(0);
    for (const label of ['새문서', '불러오기', '저장하기', '인쇄', '메모장']) {
      expect(screen.queryByTestId(`tool-${label}`)).toBeNull();
    }
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
});
