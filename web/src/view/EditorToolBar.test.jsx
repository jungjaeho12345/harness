import React from 'react';
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

  // controlled 전환(phase 44 step0): 셀렉트는 value+onChange로 상위에 값을 알린다.
  // 부수효과는 콜백뿐 — model/fetch 없음(순수 UI 규약 유지). value는 prop을 따른다.
  it('글꼴 선택은 onFontChange 콜백만 호출한다(model/fetch 없는 controlled)', async () => {
    const onFontChange = vi.fn();
    const onFontSizeChange = vi.fn();
    render(
      <EditorToolBar
        font="기본"
        fontSize="기본"
        onFontChange={onFontChange}
        onFontSizeChange={onFontSizeChange}
      />,
    );
    const font = screen.getByTestId('tool-font');
    await userEvent.selectOptions(font, '바탕');
    expect(onFontChange).toHaveBeenCalledWith('바탕');
    expect(onFontSizeChange).not.toHaveBeenCalled();
  });

  it('글씨크기 선택은 onFontSizeChange 콜백만 호출한다', async () => {
    const onFontChange = vi.fn();
    const onFontSizeChange = vi.fn();
    render(
      <EditorToolBar
        font="기본"
        fontSize="기본"
        onFontChange={onFontChange}
        onFontSizeChange={onFontSizeChange}
      />,
    );
    const size = screen.getByTestId('tool-size');
    await userEvent.selectOptions(size, '16');
    expect(onFontSizeChange).toHaveBeenCalledWith('16');
    expect(onFontChange).not.toHaveBeenCalled();
  });

  it('controlled value는 prop을 반영한다(stateful 하네스)', async () => {
    function Harness() {
      const [font, setFont] = React.useState('기본');
      const [fontSize, setFontSize] = React.useState('기본');
      return (
        <EditorToolBar
          font={font}
          fontSize={fontSize}
          onFontChange={setFont}
          onFontSizeChange={setFontSize}
        />
      );
    }
    render(<Harness />);
    const font = screen.getByTestId('tool-font');
    const size = screen.getByTestId('tool-size');
    expect(font).toHaveValue('기본');
    await userEvent.selectOptions(font, '돋움');
    expect(font).toHaveValue('돋움'); // 상위 state가 value에 반영
    await userEvent.selectOptions(size, '12');
    expect(size).toHaveValue('12');
  });

  it('font/fontSize prop 미전달·onChange 미전달 시에도 렌더가 깨지지 않는다(기본 prop 기본)', async () => {
    render(<EditorToolBar />);
    const font = screen.getByTestId('tool-font');
    const size = screen.getByTestId('tool-size');
    expect(font).toHaveValue('기본'); // 기본 prop = '기본'
    expect(size).toHaveValue('기본');
    // onChange 미전달이어도 선택 시 throw하지 않는다.
    await userEvent.selectOptions(font, '바탕');
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
