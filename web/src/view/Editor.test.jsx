import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import {
  render, screen, fireEvent, createEvent, waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Editor } from './Editor.jsx';
import { textBlock, embedBlock } from './editorContent.js';
import { COLORS } from './editorColoring.js';

// 캐럿을 lineIndex번째 라인 div에 둔다(toEnd면 줄 끝, 아니면 줄 시작). jsdom의 Selection/Range로 직접 설정.
function caretAtLine(container, lineIndex, toEnd = true) {
  const lineEls = container.querySelectorAll('.yh-editor__line');
  const sel = window.getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(lineEls[lineIndex]);
  range.collapse(!toEnd);
  sel.addRange(range);
}

// 이벤트를 dispatch하되 preventDefault 호출 여부를 스파이로 잡는다(이벤트 cancelable 여부와 무관하게 결선 검증).
function fireWithPreventSpy(el, type, init = {}) {
  const ev = createEvent[type](el, init);
  const spy = vi.spyOn(ev, 'preventDefault');
  fireEvent(el, ev);
  return spy;
}

describe('Editor', () => {
  it('exposes aria-label="본문" but shows no visible "본문" label text', () => {
    render(<Editor blocks={[textBlock('제목')]} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    expect(box).toBeInTheDocument();
    // 본문 영역 위에 '본문' 라벨 텍스트는 없다(접근성 aria-label만 유지).
    expect(screen.queryByText('본문')).toBeNull();
  });

  it('colors title/subtitle/body lines per the structure rule', () => {
    render(<Editor blocks={[textBlock('제목'), textBlock('부제'), textBlock('본문1'), textBlock('본문2'), textBlock('본문3'), textBlock('본문4'), textBlock('본문5')]} />);
    expect(screen.getByText('제목')).toHaveStyle({ color: COLORS.title });
    expect(screen.getByText('부제')).toHaveStyle({ color: COLORS.subtitle });
    expect(screen.getByText('본문5')).toHaveStyle({ color: COLORS.body });
  });

  it('renders embeds and wires the × button to onRemoveEmbed with the block index', async () => {
    const onRemoveEmbed = vi.fn();
    render(
      <Editor
        blocks={[textBlock('제목'), embedBlock({ embedType: 'image', src: 'x.png' })]}
        onRemoveEmbed={onRemoveEmbed}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '임베드 삭제' }));
    expect(onRemoveEmbed).toHaveBeenCalledWith(1);
  });

  it('reflects the spellcheck prop and forwards keydown', async () => {
    const onKeyDown = vi.fn();
    render(<Editor blocks={[textBlock('x')]} spellcheck onKeyDown={onKeyDown} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    expect(box).toHaveAttribute('spellcheck', 'true');
    box.focus();
    await userEvent.keyboard('a');
    expect(onKeyDown).toHaveBeenCalled();
  });
});

// 15-A: "(끝)" 마커 뒤 삽입 차단 결선(isInputBlocked). 삭제/이동/선택은 차단하지 않는다(news.md 162행).
describe('Editor — "(끝)" 마커 뒤 입력 차단 결선', () => {
  const markered = [textBlock('헤드'), textBlock('본문'), textBlock('(끝)')];

  it('마커 줄(이후)에서 문자 입력을 차단한다', () => {
    const { container } = render(<Editor blocks={markered} onTextChange={() => {}} onKeyDown={() => {}} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    caretAtLine(container, 2); // "(끝)" 줄
    expect(fireWithPreventSpy(box, 'keyDown', { key: 'a' })).toHaveBeenCalled();
  });

  it('마커 줄에서 Enter 삽입을 차단한다', () => {
    const { container } = render(<Editor blocks={markered} onTextChange={() => {}} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    caretAtLine(container, 2);
    expect(fireWithPreventSpy(box, 'keyDown', { key: 'Enter' })).toHaveBeenCalled();
  });

  it('마커 앞 줄에서는 문자 입력을 차단하지 않는다', () => {
    const { container } = render(<Editor blocks={markered} onTextChange={() => {}} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    caretAtLine(container, 0, false); // 첫 줄 시작
    expect(fireWithPreventSpy(box, 'keyDown', { key: 'a' })).not.toHaveBeenCalled();
  });

  it('마커 뒤라도 삭제(Backspace)는 차단하지 않는다', () => {
    const { container } = render(<Editor blocks={markered} onTextChange={() => {}} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    caretAtLine(container, 2);
    expect(fireWithPreventSpy(box, 'keyDown', { key: 'Backspace' })).not.toHaveBeenCalled();
  });

  it('마커 뒤에서 붙여넣기/IME 시작을 차단한다', () => {
    const { container } = render(<Editor blocks={markered} onTextChange={() => {}} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    caretAtLine(container, 2);
    expect(fireWithPreventSpy(box, 'paste', {})).toHaveBeenCalled();
    caretAtLine(container, 2);
    expect(fireWithPreventSpy(box, 'compositionStart', {})).toHaveBeenCalled();
  });

  it('마커가 없으면 어떤 입력도 차단하지 않는다', () => {
    const { container } = render(<Editor blocks={[textBlock('헤드'), textBlock('본문')]} onTextChange={() => {}} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    caretAtLine(container, 1);
    expect(fireWithPreventSpy(box, 'keyDown', { key: 'a' })).not.toHaveBeenCalled();
  });
});

// 15-C: IME 조합 중 재색칠 금지 결선(shouldRecolor). 색칠만 미루고 텍스트는 조합 완료 시 반영한다(news.md 168행).
describe('Editor — IME 조합 중 재색칠 금지 결선', () => {
  it('조합 중 input은 본문 동기화를 미루고, 조합 완료 시 동기화한다', () => {
    const onTextChange = vi.fn();
    render(<Editor blocks={[textBlock('가')]} onTextChange={onTextChange} />);
    const box = screen.getByRole('textbox', { name: '본문' });

    fireEvent.compositionStart(box);
    fireEvent.input(box); // 조합 중 — 동기화/재색칠 미룸
    expect(onTextChange).not.toHaveBeenCalled();

    fireEvent.compositionEnd(box); // 조합 완료 — 본문 반영
    expect(onTextChange).toHaveBeenCalled();
  });

  it('조합이 아니면 input이 본문을 동기화한다(정상 타이핑 경로)', () => {
    const onTextChange = vi.fn();
    render(<Editor blocks={[textBlock('헤드')]} onTextChange={onTextChange} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    fireEvent.input(box);
    expect(onTextChange).toHaveBeenCalledWith('헤드');
  });
});

// 이미지 붙여넣기 → 임베드 결선(handlePaste + onPasteEmbed + embedFromPaste).
// 이미지 item이면 preventDefault + FileReader로 data:image URL을 읽어 image 임베드를 onPasteEmbed로 전달한다.
// 일반 텍스트면 preventDefault 안 함 + onPasteEmbed 미호출. "(끝)" 뒤 붙여넣기 차단은 그대로 유지.
describe('Editor — 이미지 붙여넣기 → 임베드 결선', () => {
  const realFileReader = globalThis.FileReader;

  beforeEach(() => {
    // FileReader 스텁 — readAsDataURL 호출 시 data:image URL을 비동기로 onload에 넘긴다.
    class FakeFileReader {
      readAsDataURL() {
        this.result = 'data:image/png;base64,AAA';
        // 비동기 콜백 — waitFor로 기다린다.
        setTimeout(() => { if (this.onload) this.onload({ target: this }); }, 0);
      }
    }
    globalThis.FileReader = FakeFileReader;
  });

  afterEach(() => { globalThis.FileReader = realFileReader; });

  // 이미지 item 1개를 가진 clipboardData를 단 paste 이벤트를 만든다.
  function pasteImageEvent(el) {
    const ev = createEvent.paste(el, {});
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
    });
    return ev;
  }

  function pasteTextEvent(el) {
    const ev = createEvent.paste(el, {});
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
    });
    return ev;
  }

  it('이미지 붙여넣기 → preventDefault + onPasteEmbed로 image 임베드(data:image src)를 전달', async () => {
    const onPasteEmbed = vi.fn();
    render(<Editor blocks={[textBlock('헤드'), textBlock('본문')]} onTextChange={() => {}} onPasteEmbed={onPasteEmbed} />);
    const box = screen.getByRole('textbox', { name: '본문' });

    const ev = pasteImageEvent(box);
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).toHaveBeenCalled();
    await waitFor(() => expect(onPasteEmbed).toHaveBeenCalled());
    const embed = onPasteEmbed.mock.calls[0][0];
    expect(embed.embedType).toBe('image');
    expect(embed.src).toMatch(/^data:image\//);
  });

  it('일반 텍스트 붙여넣기 → preventDefault 안 함 + onPasteEmbed 미호출', () => {
    const onPasteEmbed = vi.fn();
    render(<Editor blocks={[textBlock('헤드'), textBlock('본문')]} onTextChange={() => {}} onPasteEmbed={onPasteEmbed} />);
    const box = screen.getByRole('textbox', { name: '본문' });

    const ev = pasteTextEvent(box);
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).not.toHaveBeenCalled();
    expect(onPasteEmbed).not.toHaveBeenCalled();
  });

  it('"(끝)" 뒤에서는 이미지 붙여넣기도 차단된다(caret 차단 유지)', () => {
    const onPasteEmbed = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('헤드'), textBlock('본문'), textBlock('(끝)')]} onTextChange={() => {}} onPasteEmbed={onPasteEmbed} />,
    );
    const box = screen.getByRole('textbox', { name: '본문' });
    // "(끝)" 줄에 캐럿.
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(lineEls[2]);
    range.collapse(true);
    sel.addRange(range);

    const ev = pasteImageEvent(box);
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).toHaveBeenCalled(); // 차단됨
    expect(onPasteEmbed).not.toHaveBeenCalled(); // 임베드 추가 안 함
  });
});
