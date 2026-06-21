import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { useState } from 'react';
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

  it('편집 중 구조 변경(Ctrl+D 라인삭제 등)으로 remount되면 편집 div에 focus()를 복원한다(연속 Ctrl+D 북마크 방지)', () => {
    const { rerender } = render(
      <Editor blocks={[textBlock('첫줄'), textBlock('둘째'), textBlock('셋째')]} onKeyDown={() => {}} onTextChange={() => {}} />,
    );
    const box = screen.getByRole('textbox', { name: '본문' });
    // jsdom은 contentEditable div를 native focus하지 않으므로 activeElement를 강제로 에디터로 둔다(편집 중 상태 모사).
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => box });
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      // 부모가 Ctrl+D로 라인 하나를 제거한 blocks를 다시 내려준다(구조 변경 → remount).
      rerender(
        <Editor blocks={[textBlock('첫줄'), textBlock('셋째')]} onKeyDown={() => {}} onTextChange={() => {}} />,
      );
      // remount 후 편집 div가 포커스를 되찾아야 다음 Ctrl+D가 에디터에서 처리된다(북마크로 새지 않음).
      expect(focusSpy).toHaveBeenCalled();
    } finally {
      focusSpy.mockRestore();
      delete document.activeElement;
    }
  });

  it('편집 div가 포커스가 아닐 때(외부 로드·blur) 구조 변경은 focus()를 가로채지 않는다', () => {
    const { rerender } = render(
      <Editor blocks={[textBlock('첫줄'), textBlock('둘째')]} onKeyDown={() => {}} onTextChange={() => {}} />,
    );
    // activeElement는 기본값(에디터 아님) — 포커스 복원 대상이 아니어야 한다.
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      rerender(<Editor blocks={[textBlock('첫줄')]} onKeyDown={() => {}} onTextChange={() => {}} />);
      expect(focusSpy).not.toHaveBeenCalled();
    } finally {
      focusSpy.mockRestore();
    }
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

// 타이핑 중 재렌더로 캐럿이 초기화되지 않도록(uncontrolled 편집) — 회귀 방지.
// 부모가 매 입력마다 같은 텍스트로 blocks를 갱신(echo)해도 편집 div가 remount되면 안 된다(캐럿 튐·크래시 원인).
describe('Editor — 타이핑 중 편집 div 안정(캐럿 보존)', () => {
  it('타이핑 echo(같은 텍스트로 blocks 갱신)는 편집 div를 remount하지 않는다', async () => {
    const { container, rerender } = render(
      <Editor blocks={[textBlock('헤')]} onTextChange={() => {}} />,
    );
    const before = container.querySelector('.yh-editor');
    // 사용자가 '헤드'까지 친 상황 모사: 라인 DOM 텍스트를 바꾸고 input 발생(→ 내부 lastEmitted='헤드').
    container.querySelector('.yh-editor__line').textContent = '헤드';
    fireEvent.input(before);
    // 부모가 같은 텍스트로 blocks를 갱신(echo).
    rerender(<Editor blocks={[textBlock('헤드')]} onTextChange={() => {}} />);

    await waitFor(() => {
      const after = container.querySelector('.yh-editor');
      expect(after).toBe(before); // 동일 노드 → remount 없음 → 브라우저 캐럿/입력 보존
    });
    expect(container.querySelector('.yh-editor__line').textContent).toBe('헤드'); // DOM 입력 보존
  });

  it('외부/구조 변경(다른 텍스트로 blocks 갱신)은 편집 div를 remount해 내용을 갱신한다', async () => {
    const { container, rerender } = render(
      <Editor blocks={[textBlock('제목'), textBlock('본문')]} onTextChange={() => {}} />,
    );
    const before = container.querySelector('.yh-editor');
    // 타이핑 echo가 아닌 외부 변경(예: 라인 삭제)으로 blocks가 바뀜.
    rerender(<Editor blocks={[textBlock('제목')]} onTextChange={() => {}} />);

    await waitFor(() => expect(
      Array.from(container.querySelectorAll('.yh-editor__line')).map((el) => el.textContent),
    ).toEqual(['제목']));
    expect(container.querySelector('.yh-editor')).not.toBe(before); // remount(새 노드) → 깨끗한 DOM 재구성
  });
});

// 개행 보존(버그 수정): 브라우저가 Enter/붙여넣기로 만든 <br>·클래스 없는 중첩 div가 섞인 DOM에서도
// input 시 onTextChange가 줄 수만큼의 텍스트 블록을 emit해야 한다(여러 줄이 한 블록으로 합쳐지지 않음).
describe('Editor — 거친 DOM(<br>/중첩 div) 개행 복원', () => {
  it('<br>로 두 줄이 표현된 라인 div에서 input은 두 개의 텍스트 블록을 emit한다', () => {
    const onTextChange = vi.fn();
    const { container } = render(<Editor blocks={[textBlock('줄1줄2')]} onTextChange={onTextChange} />);
    const box = container.querySelector('.yh-editor');
    // 브라우저가 라인 div 안에 <br>를 넣어 두 줄로 만든 상황 모사.
    container.querySelector('.yh-editor__line').innerHTML = '줄1<br>줄2';
    fireEvent.input(box);
    expect(onTextChange).toHaveBeenCalledWith('줄1\n줄2', [
      { type: 'text', text: '줄1' },
      { type: 'text', text: '줄2' },
    ]);
  });

  it('클래스 없는 중첩 div로 둘째 줄이 표현된 DOM에서 input은 두 개의 텍스트 블록을 emit한다', () => {
    const onTextChange = vi.fn();
    const { container } = render(<Editor blocks={[textBlock('줄1')]} onTextChange={onTextChange} />);
    const box = container.querySelector('.yh-editor');
    // 브라우저가 둘째 줄을 클래스 없는 div로 래핑한 상황 모사(최상위 형제 div).
    const extra = document.createElement('div');
    extra.textContent = '줄2';
    box.appendChild(extra);
    fireEvent.input(box);
    const blocks = onTextChange.mock.calls[0][1];
    expect(blocks.map((b) => b.text)).toEqual(['줄1', '줄2']); // 개행 보존(합쳐지지 않음)
  });

  it('맨 앞 bare 텍스트노드 + 라인 div가 섞여도 줄 순서/개행을 보존한다', () => {
    const onTextChange = vi.fn();
    const { container } = render(<Editor blocks={[textBlock('줄2')]} onTextChange={onTextChange} />);
    const box = container.querySelector('.yh-editor');
    // 라인 div 앞에 bare 텍스트노드(줄1)를 넣어 [text, lineDiv] 구성.
    box.insertBefore(document.createTextNode('줄1'), box.firstChild);
    // 두 줄 사이 경계를 위해 <br> 삽입(bare 텍스트 + br + lineDiv).
    box.insertBefore(document.createElement('br'), container.querySelector('.yh-editor__line'));
    fireEvent.input(box);
    const blocks = onTextChange.mock.calls[0][1];
    expect(blocks.map((b) => b.text)).toEqual(['줄1', '줄2']);
  });
});

// Enter 줄 분할(버그 수정): Enter는 브라우저 기본 줄바꿈 대신 블록 모델로 분할하고 새 줄에 캐럿을 둔다.
describe('Editor — Enter 줄 분할(블록 모델)', () => {
  function Harness({ initial }) {
    const [blocks, setBlocks] = useState(initial);
    return (
      <Editor
        blocks={blocks}
        onTextChange={(t, b) => setBlocks(b)}
        onKeyDown={() => {}}
      />
    );
  }

  it('줄 중간 Enter는 그 줄을 두 줄로 분할하고 remount 후 새 줄에 캐럿을 둔다', async () => {
    const { container } = render(<Harness initial={[textBlock('AB CD')]} />);
    caretAtLine(container, 0, false); // 줄 시작
    // 캐럿을 텍스트노드 offset 2(AB 뒤)로 정확히 둔다.
    const tnode = container.querySelector('.yh-editor__line').firstChild;
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(tnode, 2);
    range.collapse(true);
    sel.addRange(range);

    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: 'Enter' });
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).toHaveBeenCalled(); // 브라우저 기본 줄바꿈 차단
    await waitFor(() => expect(
      Array.from(container.querySelectorAll('.yh-editor__line')).map((el) => el.textContent),
    ).toEqual(['AB', ' CD']));
  });

  // 회귀(코드리뷰 major): 한 .yh-editor__line 안에 <br>가 생긴 dirty 상태(예: 브라우저 Backspace 줄 병합)에서도
  // Enter는 readCaretForInsert(블록 모델과 같은 줄 기준)로 캐럿 위치에서 정확히 분할해야 한다.
  it('줄 안 <br>로 거칠어진 줄에서도 Enter가 캐럿 위치(블록 모델)에서 정확히 분할한다', async () => {
    const { container } = render(<Harness initial={[textBlock('AB')]} />);
    const line = container.querySelector('.yh-editor__line');
    line.innerHTML = 'A<br>B'; // 한 라인 div 안에 A·B 두 시각 줄(<br> 경계)
    const bNode = line.lastChild; // 'B' 텍스트노드
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(bNode, 1); // 'B' 뒤에 캐럿
    range.collapse(true);
    sel.addRange(range);

    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'Enter' }));

    // 캐럿이 B 뒤 → B 다음에서 분할: ['A','B','']. (구버전 readCaret은 ['A','','B']로 오분할)
    await waitFor(() => expect(
      Array.from(container.querySelectorAll('.yh-editor__line')).map((el) => el.textContent),
    ).toEqual(['A', 'B', '']));
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

  it('조합이 아니면 input이 본문을 동기화한다(정상 타이핑 경로 — 텍스트 + 블록 전달)', () => {
    const onTextChange = vi.fn();
    render(<Editor blocks={[textBlock('헤드')]} onTextChange={onTextChange} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    fireEvent.input(box);
    // 1번째 인자: 본문 텍스트, 2번째 인자: 커서 위치 보존용 인터리브 블록.
    expect(onTextChange).toHaveBeenCalledWith('헤드', [{ type: 'text', text: '헤드' }]);
  });
});

// 임베드 위치 보존: 텍스트 사이에 임베드가 있어도 타이핑 input은 임베드를 그 자리에 둔 블록을 내보낸다.
describe('Editor — 임베드 위치 보존(타이핑 시 인터리브 블록 emit)', () => {
  it('input은 텍스트 사이의 임베드를 끝으로 옮기지 않고 DOM 순서대로 내보낸다', () => {
    const onTextChange = vi.fn();
    render(
      <Editor
        blocks={[textBlock('제목'), embedBlock({ embedType: 'image', src: 'data:image/png;base64,AAA' }), textBlock('본문')]}
        onTextChange={onTextChange}
      />,
    );
    const box = screen.getByRole('textbox', { name: '본문' });
    fireEvent.input(box);
    const blocks = onTextChange.mock.calls[0][1];
    expect(blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text']);
    expect(blocks[1].src).toBe('data:image/png;base64,AAA');
  });

  // 회귀: 임베드 2개 중 하나를 인라인으로(× 버튼 아닌 경로) 삭제해도, 남은 임베드에 엉뚱한 데이터가
  // 매칭되지 않아야 한다(data-embed-key 안정적 매칭). 등장 순서 매칭이면 살아남은 임베드가 뒤바뀐다.
  it('임베드 하나를 인라인 삭제해도 살아남은 임베드 데이터가 뒤바뀌지 않는다', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor
        blocks={[
          textBlock('A'),
          embedBlock({ embedType: 'image', src: 'data:image/png;base64,XXX' }),
          embedBlock({ embedType: 'image', src: 'data:image/png;base64,YYY' }),
          textBlock('B'),
        ]}
        onTextChange={onTextChange}
      />,
    );
    // 첫 번째 임베드 figure를 DOM에서 제거(인라인 선택-삭제 모사).
    container.querySelectorAll('.yh-embed')[0].remove();
    fireEvent.input(container.querySelector('.yh-editor'));

    const embeds = onTextChange.mock.calls[0][1].filter((b) => b.type === 'embed');
    expect(embeds).toHaveLength(1);
    expect(embeds[0].src).toBe('data:image/png;base64,YYY'); // 남은 건 YYY(XXX로 되살아나지 않음)
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

  it('이미지 붙여넣기 → onPasteEmbed 2번째 인자로 캐럿({lineIndex})을 전달한다', async () => {
    const onPasteEmbed = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('헤드'), textBlock('본문')]} onTextChange={() => {}} onPasteEmbed={onPasteEmbed} />,
    );
    const box = screen.getByRole('textbox', { name: '본문' });
    // 첫 줄(헤드)에 캐럿을 둔다.
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(lineEls[0]);
    range.collapse(true);
    sel.addRange(range);

    fireEvent(box, pasteImageEvent(box));
    await waitFor(() => expect(onPasteEmbed).toHaveBeenCalled());
    expect(onPasteEmbed.mock.calls[0][1]).toMatchObject({ lineIndex: 0 });
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

// Step 2: 캐럿 보고(onCaretChange) — 캐럿 이동 이벤트에서 현재 텍스트-줄 인덱스를 부모로 보고.
// blur 계약: 에디터 안에 캐럿이 있으면(readCaret 비-null) 마지막 캐럿을 보고하고, 밖이면(null) 보고하지 않는다.
describe('Editor — 캐럿 보고(onCaretChange)', () => {
  it('캐럿 이동 이벤트(keyUp)에서 현재 lineIndex로 onCaretChange를 호출한다', () => {
    const onCaretChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('a'), textBlock('b'), textBlock('c')]} onTextChange={() => {}} onCaretChange={onCaretChange} />,
    );
    const box = screen.getByRole('textbox', { name: '본문' });
    caretAtLine(container, 2); // 셋째 줄
    fireEvent.keyUp(box, { key: 'ArrowDown' });
    expect(onCaretChange).toHaveBeenCalledWith(expect.objectContaining({ lineIndex: 2 }));
  });

  it('마우스업에서도 현재 lineIndex로 onCaretChange를 호출한다', () => {
    const onCaretChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('a'), textBlock('b')]} onTextChange={() => {}} onCaretChange={onCaretChange} />,
    );
    const box = screen.getByRole('textbox', { name: '본문' });
    caretAtLine(container, 1);
    fireEvent.mouseUp(box);
    expect(onCaretChange).toHaveBeenCalledWith(expect.objectContaining({ lineIndex: 1 }));
  });

  it('blur 시 selection이 에디터 안이면 마지막 lineIndex로 onCaretChange를 호출한다', () => {
    const onCaretChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('a'), textBlock('b')]} onTextChange={() => {}} onCaretChange={onCaretChange} />,
    );
    const box = screen.getByRole('textbox', { name: '본문' });
    caretAtLine(container, 1);
    onCaretChange.mockClear();
    fireEvent.blur(box);
    expect(onCaretChange).toHaveBeenCalledWith(expect.objectContaining({ lineIndex: 1 }));
  });

  it('blur 시 selection이 에디터 밖(root 미포함)이면 onCaretChange를 호출하지 않는다', () => {
    const onCaretChange = vi.fn();
    render(<Editor blocks={[textBlock('a')]} onTextChange={() => {}} onCaretChange={onCaretChange} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    // selection을 에디터 밖 노드로 이동(검색패널 클릭 모사).
    const outside = document.createElement('div');
    outside.textContent = '밖';
    document.body.appendChild(outside);
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(outside);
    range.collapse(true);
    sel.addRange(range);

    fireEvent.blur(box);
    expect(onCaretChange).not.toHaveBeenCalled(); // null이면 마지막 캐럿을 지우지 않는다(부모 lastCaret 유지)
    outside.remove();
  });
});

// Step 2: pendingCaretLine — 지정 텍스트-줄에 focus()+캐럿. remount 복원(refocusRef)보다 우선. textLocked면 무시.
describe('Editor — pendingCaretLine 지정 줄 포커스', () => {
  it('pendingCaretLine을 number로 rerender하면 focus()하고 그 줄에 캐럿(range)을 둔다', () => {
    const { container, rerender } = render(
      <Editor blocks={[textBlock('a'), textBlock('b'), textBlock('c')]} onTextChange={() => {}} />,
    );
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      rerender(
        <Editor blocks={[textBlock('a'), textBlock('b'), textBlock('c')]} onTextChange={() => {}} pendingCaretLine={1} />,
      );
      expect(focusSpy).toHaveBeenCalled();
      const lineEls = container.querySelectorAll('.yh-editor__line');
      expect(window.getSelection().anchorNode).toBe(lineEls[1]); // 둘째 줄 시작에 캐럿
    } finally {
      focusSpy.mockRestore();
    }
  });

  it('textLocked(readOnly)면 pendingCaretLine으로 focus()하지 않는다', () => {
    const { rerender } = render(
      <Editor blocks={[textBlock('a'), textBlock('b')]} readOnly />,
    );
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      rerender(<Editor blocks={[textBlock('a'), textBlock('b')]} readOnly pendingCaretLine={1} />);
      expect(focusSpy).not.toHaveBeenCalled();
    } finally {
      focusSpy.mockRestore();
    }
  });

  it('pendingCaretLine은 이전 포커스 여부와 무관하게(activeElement가 에디터가 아니어도) 동작한다', () => {
    const { container, rerender } = render(
      <Editor blocks={[textBlock('a'), textBlock('b')]} onTextChange={() => {}} />,
    );
    // activeElement는 기본값(에디터 아님) — wasFocused 경로가 아님에도 pendingCaretLine은 적용되어야 한다.
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      rerender(
        <Editor blocks={[textBlock('a'), textBlock('b')]} onTextChange={() => {}} pendingCaretLine={0} />,
      );
      expect(focusSpy).toHaveBeenCalled();
      const lineEls = container.querySelectorAll('.yh-editor__line');
      expect(window.getSelection().anchorNode).toBe(lineEls[0]);
    } finally {
      focusSpy.mockRestore();
    }
  });

  // Step 3 핵심 시나리오: body 변경(remount)과 pendingCaretLine을 같은 렌더에 함께 전달하면,
  // remount된 새 DOM의 지정 줄에 캐럿이 안착한다(검색 임베드 삽입 후 빈 줄로 포커스 이동).
  it('body 변경(remount)과 함께 온 pendingCaretLine은 remount 후 새 DOM의 그 줄에 캐럿을 둔다', async () => {
    const { container, rerender } = render(
      <Editor blocks={[textBlock('제목'), textBlock('본문')]} onTextChange={() => {}} />,
    );
    // 임베드 삽입 모사: 본문(텍스트-줄 1) 뒤에 임베드 + 빈 줄(텍스트-줄 2)이 생긴 새 body + 그 빈 줄(2)로 pendingCaretLine.
    rerender(
      <Editor
        blocks={[
          textBlock('제목'),
          textBlock('본문'),
          embedBlock({ embedType: 'image', src: 'data:image/png;base64,AAA' }),
          textBlock(''),
        ]}
        onTextChange={() => {}}
        pendingCaretLine={2}
      />,
    );
    await waitFor(() => {
      const lineEls = container.querySelectorAll('.yh-editor__line');
      expect(lineEls).toHaveLength(3); // 제목/본문/빈 줄
      expect(window.getSelection().anchorNode).toBe(lineEls[2]); // 새 DOM의 빈 줄(텍스트-줄 2)에 캐럿
    });
  });
});
