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

// Step 2(21-editor-tools-memo): enabledIds 패턴(EditorMenuBar와 동일 규약) — 지정한 버튼만 활성.
// 하위호환: enabledIds 미전달 시 전 버튼 disabled(위 쉘 테스트가 잠금).
describe('EditorToolBar — enabledIds 활성화(메모 버튼 결선)', () => {
  it("enabledIds=['tool.memo']면 '메모장' 버튼이 활성이고 클릭 시 onSelect('tool.memo')를 1회 호출한다", async () => {
    const onSelect = vi.fn();
    render(<EditorToolBar onSelect={onSelect} enabledIds={['tool.memo']} />);
    const memo = screen.getByTestId('tool-메모장');
    expect(memo).toBeEnabled();
    await userEvent.click(memo);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('tool.memo');
  });

  it("enabledIds=['tool.memo']여도 그 외 버튼(새문서 등)은 여전히 disabled다", () => {
    render(<EditorToolBar onSelect={vi.fn()} enabledIds={['tool.memo']} />);
    expect(screen.getByTestId('tool-새문서')).toBeDisabled();
    expect(screen.getByTestId('tool-저장하기')).toBeDisabled();
    expect(screen.getByTestId('tool-찾기/바꾸기')).toBeDisabled();
  });

  it('enabledIds에 Set을 넘겨도 동일하게 동작한다(메뉴바 규약)', async () => {
    const onSelect = vi.fn();
    render(<EditorToolBar onSelect={onSelect} enabledIds={new Set(['tool.memo'])} />);
    await userEvent.click(screen.getByTestId('tool-메모장'));
    expect(onSelect).toHaveBeenCalledWith('tool.memo');
  });
});
