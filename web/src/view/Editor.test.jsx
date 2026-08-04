import {
  describe, it, expect, vi, afterEach,
} from 'vitest';
import { useState } from 'react';
import {
  render, screen, fireEvent, createEvent, waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Editor, readCaret } from './Editor.jsx';
import { textBlock, embedBlock } from './editorContent.js';
import { COLORS } from './editorColoring.js';
import { selectAllInEditor, selectLineInEditor, selectParagraphInEditor } from './editorSelect.js';

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

// 캐럿을 지정 노드/오프셋의 collapsed selection으로 둔다(하이라이트 span-aware 캐럿 테스트용).
function setCaret(node, offset) {
  const sel = window.getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.addRange(range);
}

// 정방향 선택(anchor=start, focus=end)을 만든다 — 마우스 드래그·Shift 이동의 일반형.
function selectRange(startNode, startOffset, endNode, endOffset) {
  const sel = window.getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  sel.addRange(range);
}

// 역방향 선택(anchor가 뒤, focus가 앞) — 위로 드래그한 경우.
function selectBackward(anchorNode, anchorOffset, focusNode, focusOffset) {
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
}

// 텍스트-줄(.yh-editor__line)의 텍스트 노드.
function lineText(container, lineIndex) {
  return container.querySelectorAll('.yh-editor__line')[lineIndex].firstChild;
}

// 일반 텍스트 클립보드(이미지 item 없음) paste 이벤트.
function pastePlainEvent(el, text) {
  const ev = createEvent.paste(el, {});
  Object.defineProperty(ev, 'clipboardData', {
    value: { items: [], getData: () => text },
  });
  return ev;
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

  // Step 3(40-editor-lang-inputmode): lang 속성 prop화(표시 전용 — spellcheck prop 동형).
  it('lang prop 미지정이면 편집 div lang 속성은 기본 "ko"다', () => {
    render(<Editor blocks={[textBlock('x')]} />);
    expect(screen.getByRole('textbox', { name: '본문' }).getAttribute('lang')).toBe('ko');
  });

  it('lang="en"이면 편집 div lang 속성이 "en"으로 주입된다', () => {
    render(<Editor blocks={[textBlock('x')]} lang="en" />);
    expect(screen.getByRole('textbox', { name: '본문' }).getAttribute('lang')).toBe('en');
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

// 이미지 붙여넣기 → raw File 위임(handlePaste + onPasteImageFile). base64(data URL)를 만들지 않고
// 감지한 File과 동기 캐럿({lineIndex})을 상위로 넘긴다(업로드→경로 임베드는 WriterPage가 model.uploadFile로 수행).
// 일반 텍스트면 preventDefault 안 함 + 핸들러 미호출. "(끝)" 뒤 붙여넣기 차단은 그대로 유지.
describe('Editor — 이미지 붙여넣기 → raw File 위임(onPasteImageFile)', () => {
  const realFileReader = globalThis.FileReader;
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

  it('이미지 붙여넣기 → preventDefault + onPasteImageFile로 raw File을 전달(FileReader 미사용)', () => {
    // FileReader가 호출되면 즉시 실패(Editor가 base64를 만들지 않음을 보증).
    globalThis.FileReader = class { readAsDataURL() { throw new Error('Editor must not create base64'); } };
    const onPasteImageFile = vi.fn();
    render(<Editor blocks={[textBlock('헤드'), textBlock('본문')]} onTextChange={() => {}} onPasteImageFile={onPasteImageFile} />);
    const box = screen.getByRole('textbox', { name: '본문' });

    const ev = pasteImageEvent(box);
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).toHaveBeenCalled();
    expect(onPasteImageFile).toHaveBeenCalledTimes(1);
    const file = onPasteImageFile.mock.calls[0][0];
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe('image/png');
  });

  it('이미지 붙여넣기 → onPasteImageFile 2번째 인자로 캐럿({lineIndex})을 전달한다', () => {
    const onPasteImageFile = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('헤드'), textBlock('본문')]} onTextChange={() => {}} onPasteImageFile={onPasteImageFile} />,
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
    expect(onPasteImageFile).toHaveBeenCalledTimes(1);
    expect(onPasteImageFile.mock.calls[0][1]).toMatchObject({ lineIndex: 0 });
  });

  it('일반 텍스트 붙여넣기 → preventDefault 안 함 + onPasteImageFile 미호출', () => {
    const onPasteImageFile = vi.fn();
    render(<Editor blocks={[textBlock('헤드'), textBlock('본문')]} onTextChange={() => {}} onPasteImageFile={onPasteImageFile} />);
    const box = screen.getByRole('textbox', { name: '본문' });

    const ev = pasteTextEvent(box);
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).not.toHaveBeenCalled();
    expect(onPasteImageFile).not.toHaveBeenCalled();
  });

  it('"(끝)" 줄에서도 이미지 붙여넣기는 위임된다(임베드는 마커 앞 정규화 — 마커 차단은 텍스트만)', () => {
    const onPasteImageFile = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('헤드'), textBlock('본문'), textBlock('(끝)')]} onTextChange={() => {}} onPasteImageFile={onPasteImageFile} />,
    );
    const box = screen.getByRole('textbox', { name: '본문' });
    // "(끝)" 줄에 캐럿 — 문서 끝 클릭 후 붙여넣기(가장 흔한 시나리오).
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

    // 텍스트와 달리 이미지는 차단하지 않는다 — 삽입 위치 정규화("(끝)" 최종 유지)는 insertEmbedAfterLine이 담당.
    expect(prevent).toHaveBeenCalled();
    expect(onPasteImageFile).toHaveBeenCalledTimes(1);
    expect(onPasteImageFile.mock.calls[0][1]).toMatchObject({ lineIndex: 2 });
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

// 35-1: 보기 정렬 — 텍스트 줄을 data-align + text-align으로 렌더하고, 타이핑 라운드트립에서 되읽어 살린다.
// (임베드가 data-embed-key로 생존하는 것과 동형 — align도 DOM에 실어야 매 입력 재구성에서 유실되지 않는다.)
describe('Editor — 보기 정렬(data-align/text-align 렌더·라운드트립)', () => {
  it('정렬된 텍스트 블록은 data-align + text-align 스타일로 렌더하고, 미정렬 블록은 속성/스타일이 없다', () => {
    const { container } = render(
      <Editor blocks={[textBlock('제목'), textBlock('가운데', 'center')]} onTextChange={() => {}} />,
    );
    const lines = container.querySelectorAll('.yh-editor__line');
    // 미정렬(제목) 줄 — data-align 속성 없음, textAlign 비어 있음(현행 DOM과 동일 — 회귀 안전).
    expect(lines[0].getAttribute('data-align')).toBeNull();
    expect(lines[0].style.textAlign).toBe('');
    // 정렬된 줄 — data-align="center" + textAlign 'center'.
    expect(lines[1].getAttribute('data-align')).toBe('center');
    expect(lines[1].style.textAlign).toBe('center');
  });

  it('무효 align은 화이트리스트에서 걸러져 렌더에 반영되지 않는다(속성/스타일 생략)', () => {
    const { container } = render(
      <Editor blocks={[textBlock('제목'), { type: 'text', text: '무효', align: 'middle' }]} onTextChange={() => {}} />,
    );
    const lines = container.querySelectorAll('.yh-editor__line');
    expect(lines[1].getAttribute('data-align')).toBeNull();
    expect(lines[1].style.textAlign).toBe('');
  });

  it('타이핑(input) 라운드트립에서 정렬된 줄의 align이 보존된다(DOM data-align 되읽기)', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('제목'), textBlock('가운데', 'center')]} onTextChange={onTextChange} />,
    );
    // 매 입력마다 readEditorBlocks가 DOM에서 블록을 재구성한다 — data-align이 살아 있어야 align이 살아남는다.
    fireEvent.input(container.querySelector('.yh-editor'));
    const blocks = onTextChange.mock.calls[0][1];
    expect(blocks[1]).toMatchObject({ type: 'text', text: '가운데', align: 'center' });
    expect(blocks[0].align).toBeUndefined(); // 미정렬 줄은 align 키가 없다.
  });

  it('정렬만 바뀐 blocks(같은 텍스트/임베드)는 remount되어 DOM 정렬이 갱신된다(alignSig structural)', async () => {
    const { container, rerender } = render(
      <Editor blocks={[textBlock('제목'), textBlock('본문')]} onTextChange={() => {}} />,
    );
    // 텍스트·임베드는 동일하고 둘째 줄 정렬만 추가 — alignSig가 달라 remount되어야 화면에 반영된다.
    rerender(
      <Editor blocks={[textBlock('제목'), textBlock('본문', 'right')]} onTextChange={() => {}} />,
    );
    await waitFor(() => {
      const lines = container.querySelectorAll('.yh-editor__line');
      expect(lines[1].getAttribute('data-align')).toBe('right');
      expect(lines[1].style.textAlign).toBe('right');
    });
  });

  it('정렬·텍스트 모두 그대로면 재렌더(remount)하지 않는다(회귀 — alignSig 오탐 없음)', async () => {
    const { container, rerender } = render(
      <Editor blocks={[textBlock('제목'), textBlock('본문', 'center')]} onTextChange={() => {}} />,
    );
    const before = container.querySelector('.yh-editor');
    rerender(
      <Editor blocks={[textBlock('제목'), textBlock('본문', 'center')]} onTextChange={() => {}} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.yh-editor')).toBe(before); // 동일 노드 → remount 없음
    });
  });
});

// 39-1: 맞춤법 하이라이트 표시전용 렌더 — 세그먼트는 내부 스냅샷(highlightSnapRef)에서만 읽고
// 변화는 remount로만 반영한다. 캐럿/echo/IME 기존 불변식을 깨지 않는 것이 계약(적대적 검증).
describe('Editor — 맞춤법 하이라이트 렌더(spellHighlights)', () => {
  it('하이라이트 구간을 굵게 span으로 감싸고 줄 텍스트는 원문과 동일하다(비-hl 세그먼트는 bare 텍스트 노드)', () => {
    // '제목\n본문AB'에서 절대 오프셋 5..7 = 둘째 줄 'AB'.
    const { container } = render(
      <Editor
        blocks={[textBlock('제목'), textBlock('본문AB')]}
        onTextChange={() => {}}
        spellHighlights={[{ start: 5, end: 7 }]}
        spellHighlightStyle="bold"
      />,
    );
    const spans = container.querySelectorAll('.yh-editor__spell');
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent).toBe('AB');
    expect(spans[0].classList.contains('yh-editor__spell--bold')).toBe(true);
    const lines = container.querySelectorAll('.yh-editor__line');
    expect(lines[1].textContent).toBe('본문AB'); // 세그먼트를 이어붙이면 원문 그대로
    expect(lines[1].childNodes[0].nodeType).toBe(3); // 비-hl 앞 세그먼트는 bare 텍스트 노드(span 아님)
    expect(lines[0].textContent).toBe('제목');
    expect(lines[0].childNodes).toHaveLength(1); // 하이라이트 없는 줄은 단일 텍스트 노드(오늘과 동일)
  });

  it("spellHighlightStyle='underline'이면 underline 클래스로 렌더한다", () => {
    const { container } = render(
      <Editor
        blocks={[textBlock('제목오탈')]}
        onTextChange={() => {}}
        spellHighlights={[{ start: 2, end: 4 }]}
        spellHighlightStyle="underline"
      />,
    );
    const span = container.querySelector('.yh-editor__spell');
    expect(span.classList.contains('yh-editor__spell--underline')).toBe(true);
    expect(span.classList.contains('yh-editor__spell--bold')).toBe(false);
    expect(span.textContent).toBe('오탈');
  });

  it('spellHighlights가 비면 span 0개 + 각 텍스트 줄은 단일 텍스트 노드다(미사용 DOM 동일성 — 회귀 가드)', () => {
    const { container } = render(
      <Editor blocks={[textBlock('제목'), textBlock('본문')]} onTextChange={() => {}} spellHighlights={[]} />,
    );
    expect(container.querySelectorAll('.yh-editor__spell')).toHaveLength(0);
    for (const line of container.querySelectorAll('.yh-editor__line')) {
      expect(line.childNodes).toHaveLength(1);
      expect(line.firstChild.nodeType).toBe(3);
    }
  });

  it('하이라이트가 있어도 타이핑 echo는 remount하지 않고 onTextChange가 span 투과 텍스트로 발화한다', async () => {
    const onTextChange = vi.fn();
    const { container, rerender } = render(
      <Editor blocks={[textBlock('제목'), textBlock('본문AB')]} onTextChange={onTextChange} spellHighlights={[{ start: 5, end: 7 }]} />,
    );
    const before = container.querySelector('.yh-editor');
    // span이 있는 줄 뒤에 글자가 추가된 타이핑 모사(브라우저 DOM 변형).
    container.querySelectorAll('.yh-editor__line')[1].appendChild(document.createTextNode('C'));
    fireEvent.input(before);
    // span 투과 추출 — 정확한 텍스트로 emit(하이라이트가 텍스트 추출을 오염시키지 않음).
    expect(onTextChange).toHaveBeenCalledWith('제목\n본문ABC', [
      { type: 'text', text: '제목' },
      { type: 'text', text: '본문ABC' },
    ]);
    // 부모 echo(같은 텍스트 + 같은 내용의 하이라이트 새 배열) — remount 없음(캐럿/입력 보존).
    rerender(
      <Editor blocks={[textBlock('제목'), textBlock('본문ABC')]} onTextChange={onTextChange} spellHighlights={[{ start: 5, end: 7 }]} />,
    );
    await waitFor(() => expect(container.querySelector('.yh-editor')).toBe(before));
    expect(container.querySelectorAll('.yh-editor__line')[1].textContent).toBe('본문ABC'); // DOM 입력 보존
  });

  it('정렬 줄(center/right)에 하이라이트가 걸려도 data-align/text-align/role 색이 보존된다', () => {
    // '제목\n가운데\n오른쪽' — 가운(3..5)·오른(7..9) 하이라이트.
    const { container } = render(
      <Editor
        blocks={[textBlock('제목'), textBlock('가운데', 'center'), textBlock('오른쪽', 'right')]}
        onTextChange={() => {}}
        spellHighlights={[{ start: 3, end: 5 }, { start: 7, end: 9 }]}
      />,
    );
    const lines = container.querySelectorAll('.yh-editor__line');
    expect(lines[1].getAttribute('data-align')).toBe('center');
    expect(lines[1].style.textAlign).toBe('center');
    expect(lines[1]).toHaveStyle({ color: COLORS.subtitle }); // role 색 보존
    expect(lines[1].querySelector('.yh-editor__spell').textContent).toBe('가운');
    expect(lines[1].querySelector('.yh-editor__spell').style.color).toBe(''); // span은 색 미지정(줄 색 상속)
    expect(lines[1].textContent).toBe('가운데');
    expect(lines[2].getAttribute('data-align')).toBe('right');
    expect(lines[2].style.textAlign).toBe('right');
    expect(lines[2].querySelector('.yh-editor__spell').textContent).toBe('오른');
    expect(lines[2].textContent).toBe('오른쪽');
  });
});

// 39-1: span-aware readCaret — offsetInLine은 "줄 시작부터 캐럿까지 document-order로 앞서는
// 모든 텍스트 길이"(하이라이트 span 내부 포함). 반환에 col(줄 내 열)이 추가된다.
describe('Editor — span-aware readCaret(col)', () => {
  // 둘째 줄 'ABCDEF'가 [텍스트 'AB', <span>CD</span>, 텍스트 'EF']로 렌더되는 하이라이트 구성.
  function renderSpanLine() {
    const utils = render(
      <Editor blocks={[textBlock('XY'), textBlock('ABCDEF')]} onTextChange={() => {}} spellHighlights={[{ start: 5, end: 7 }]} />,
    );
    const root = utils.container.querySelector('.yh-editor');
    const line = utils.container.querySelectorAll('.yh-editor__line')[1];
    return { root, line };
  }

  it('(a) anchor가 span 뒤 텍스트 노드면 col에 앞 span 길이가 포함된다', () => {
    const { root, line } = renderSpanLine();
    expect(Array.from(line.childNodes).map((n) => n.textContent)).toEqual(['AB', 'CD', 'EF']);
    setCaret(line.childNodes[2], 1); // 'EF' offset 1 → col = 2('AB') + 2('CD') + 1 = 5
    expect(readCaret(root)).toEqual({ lineIndex: 1, offset: 8, col: 5 }); // offset = 'XY\n'(3) + 5
  });

  it('(b) anchor가 span 내부 텍스트 노드면 col이 정확하다', () => {
    const { root, line } = renderSpanLine();
    setCaret(line.childNodes[1].firstChild, 1); // span 'CD' offset 1 → col = 2('AB') + 1 = 3
    expect(readCaret(root)).toEqual({ lineIndex: 1, offset: 6, col: 3 });
  });

  it('단일 텍스트 노드 줄에서는 기존값 불변이다(하위호환)', () => {
    const { container } = render(
      <Editor blocks={[textBlock('XY'), textBlock('ABCDEF')]} onTextChange={() => {}} />,
    );
    const root = container.querySelector('.yh-editor');
    const line = container.querySelectorAll('.yh-editor__line')[1];
    expect(line.childNodes).toHaveLength(1);
    setCaret(line.firstChild, 2);
    expect(readCaret(root)).toEqual({ lineIndex: 1, offset: 5, col: 2 });
  });
});

// 39-1: span-aware readCaretForInsert — 하이라이트 span 안 캐럿에서 Enter 분할 위치가 정확해야 한다.
describe('Editor — span-aware readCaretForInsert(하이라이트 span 안 Enter)', () => {
  it('span 안 캐럿에서 Enter가 캐럿 위치에서 정확히 분할한다', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('ABCDEF')]} onTextChange={onTextChange} spellHighlights={[{ start: 2, end: 4 }]} />,
    );
    const line = container.querySelector('.yh-editor__line');
    setCaret(line.childNodes[1].firstChild, 1); // span 'CD' 안 'C' 뒤(전체 col 3)
    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: 'Enter' });
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);
    expect(prevent).toHaveBeenCalled();
    // 구버전 walkBlock은 span 내부 캐럿을 못 봐(caretLine=null) 마지막 줄 끝 폴백으로 오분할된다.
    expect(onTextChange).toHaveBeenCalledWith('ABC\nDEF', [
      { type: 'text', text: 'ABC' },
      { type: 'text', text: 'DEF' },
    ]);
  });
});

// 39-1: 하이라이트-only 클리어(while focused) — remount 후 캐럿을 줄 시작이 아닌 원래 열(col)로 복원.
describe('Editor — 하이라이트 클리어의 열-정확 캐럿 복원(focusCaretAt)', () => {
  it('포커스 중 하이라이트 클리어 → remount + 캐럿이 원래 col로 복원되고 span이 사라진다', async () => {
    const { container, rerender } = render(
      <Editor blocks={[textBlock('ABCDEF')]} onTextChange={() => {}} spellHighlights={[{ start: 2, end: 4 }]} />,
    );
    const before = container.querySelector('.yh-editor');
    // 편집 중(포커스 보유) 상태 모사 — 현재 DOM의 편집 div를 activeElement로.
    Object.defineProperty(document, 'activeElement', {
      configurable: true, get: () => container.querySelector('.yh-editor'),
    });
    try {
      const line = container.querySelector('.yh-editor__line');
      setCaret(line.childNodes[2], 1); // span 뒤 'EF' offset 1 → col 5
      rerender(<Editor blocks={[textBlock('ABCDEF')]} onTextChange={() => {}} spellHighlights={[]} />);
      await waitFor(() => {
        expect(container.querySelectorAll('.yh-editor__spell')).toHaveLength(0); // span 사라짐
        expect(container.querySelector('.yh-editor')).not.toBe(before); // remount(renderTick 증가)
        const newLine = container.querySelector('.yh-editor__line');
        const sel = window.getSelection();
        expect(sel.anchorNode).toBe(newLine.firstChild); // 클리어 후 단일 텍스트 노드
        expect(sel.anchorOffset).toBe(5); // 줄 시작(0)이 아니라 col 5
      });
    } finally {
      delete document.activeElement;
    }
  });
});

// 39-1 [high-2]: 하이라이트 존재 상태에서 첫 입력이 한글 조합 — 조합 중 remount/클리어 금지·글자 무손실·
// compositionend 이후 클리어-remount에서 열-정확 복원(news.md L168·L176 계열).
describe('Editor — 하이라이트 + IME 조합(조합 중 클리어-remount 금지)', () => {
  async function runComposition({ caretOffsetInSpan, mutate, emitted, caretAfter, colAfter }) {
    const onTextChange = vi.fn();
    const { container, rerender } = render(
      <Editor blocks={[textBlock('ABCDEF')]} onTextChange={onTextChange} spellHighlights={[{ start: 2, end: 4 }]} />,
    );
    const before = container.querySelector('.yh-editor');
    Object.defineProperty(document, 'activeElement', {
      configurable: true, get: () => container.querySelector('.yh-editor'),
    });
    try {
      const cdText = container.querySelector('.yh-editor__spell').firstChild; // span 안 'CD'
      setCaret(cdText, caretOffsetInSpan);
      fireEvent.compositionStart(before);
      mutate(cdText); // 브라우저가 조합 글자를 캐럿 위치(span 텍스트 노드)에 삽입한 상황 모사
      fireEvent.input(before);
      // 조합 중 — emit 금지 + remount 없음(renderTick 불변 = 동일 노드) + 하이라이트 클리어 없음.
      expect(onTextChange).not.toHaveBeenCalled();
      expect(container.querySelector('.yh-editor')).toBe(before);
      expect(container.querySelector('.yh-editor__spell')).not.toBeNull();
      fireEvent.compositionEnd(before);
      // 조합 완료 — 정확한 텍스트로 emit(무손실·무중복).
      expect(onTextChange).toHaveBeenCalledWith(emitted, [{ type: 'text', text: emitted }]);
      // 조합 후 캐럿(조합 글자 뒤) 모사 후, step2 클리어(같은 텍스트 echo + 빈 하이라이트).
      setCaret(cdText, caretAfter);
      rerender(<Editor blocks={[textBlock(emitted)]} onTextChange={onTextChange} spellHighlights={[]} />);
      await waitFor(() => {
        expect(container.querySelectorAll('.yh-editor__spell')).toHaveLength(0);
        const newLine = container.querySelector('.yh-editor__line');
        expect(newLine.textContent).toBe(emitted); // 조합 글자 무손실·무중복
        const sel = window.getSelection();
        expect(sel.anchorNode).toBe(newLine.firstChild);
        expect(sel.anchorOffset).toBe(colAfter); // 열-정확(줄 시작으로 튀지 않음)
      });
    } finally {
      delete document.activeElement;
    }
  }

  it('캐럿이 span 경계(끝)일 때 — 조합 중 remount 없음·완료 후 열-정확 클리어', async () => {
    await runComposition({
      caretOffsetInSpan: 2, // 'CD' 끝(span 경계)
      mutate: (t) => { t.textContent = 'CD가'; },
      emitted: 'ABCD가EF',
      caretAfter: 3, // 'CD가'의 '가' 뒤
      colAfter: 5, // 'AB'(2) + 3
    });
  });

  it('캐럿이 span 내부일 때 — 조합 중 remount 없음·완료 후 열-정확 클리어', async () => {
    await runComposition({
      caretOffsetInSpan: 1, // 'CD' 안 'C' 뒤
      mutate: (t) => { t.textContent = 'C가D'; },
      emitted: 'ABC가DEF',
      caretAfter: 2, // 'C가D'의 '가' 뒤
      colAfter: 4, // 'AB'(2) + 2
    });
  });
});

// 39-1: "(끝)" 마커 차단 판정 — span-aware offset 덕분에 하이라이트가 있어도 오탐/미탐이 없어야 한다.
describe('Editor — 하이라이트 + "(끝)" 마커 차단 판정(span-aware offset)', () => {
  it('span 뒤 마커 영역 캐럿은 차단(미탐 없음), span 안 마커 앞 캐럿은 허용(오탐 없음)', () => {
    // 한 줄 '본문(끝)' — 마커는 offset 2부터, '본문'(0..2)이 span으로 감싸인다.
    const { container } = render(
      <Editor blocks={[textBlock('본문(끝)')]} onTextChange={() => {}} spellHighlights={[{ start: 0, end: 2 }]} />,
    );
    const box = screen.getByRole('textbox', { name: '본문' });
    const line = container.querySelector('.yh-editor__line');
    // 마커 텍스트 노드('(끝)') offset 1 → 실제 offset 3(≥2) — 앞 span 길이를 빼먹으면 1(<2)로 미탐.
    setCaret(line.childNodes[1], 1);
    expect(fireWithPreventSpy(box, 'keyDown', { key: 'a' })).toHaveBeenCalled();
    // span 안('본문') offset 1 → 실제 offset 1(<2) — 허용.
    setCaret(line.childNodes[0].firstChild, 1);
    expect(fireWithPreventSpy(box, 'keyDown', { key: 'a' })).not.toHaveBeenCalled();
  });
});

// 53-1(A 결함): Enter·여러 줄 붙여넣기는 preventDefault로 브라우저 기본 대체(선택 삭제 후 삽입)를 막으므로,
// 선택 범위 삭제를 우리 경로(replaceRangeInBlocks)가 직접 해야 한다. 선택이 한 점으로 취급되면 선택 텍스트가
// 그대로 남아 본문이 파손된다('hello A' / 'Bworld').
describe('Editor — 선택 범위 삭제 결선(텍스트 노드 앵커)', () => {
  it('선택 후 여러 줄 붙여넣기는 선택 텍스트를 지우고 그 자리에 삽입한다', () => {
    const onTextChange = vi.fn();
    const { container } = render(<Editor blocks={[textBlock('hello world')]} onTextChange={onTextChange} />);
    const box = container.querySelector('.yh-editor');
    const t = lineText(container, 0);
    selectRange(t, 6, t, 11); // 'world'

    const ev = pastePlainEvent(box, 'A\nB');
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).toHaveBeenCalled();
    expect(onTextChange).toHaveBeenCalledTimes(1);
    expect(onTextChange.mock.calls[0][0]).toBe('hello A\nB');
  });

  it('선택 후 Enter는 선택 텍스트를 지우고 그 자리에서 분할한다', () => {
    const onTextChange = vi.fn();
    const { container } = render(<Editor blocks={[textBlock('hello world')]} onTextChange={onTextChange} />);
    const box = container.querySelector('.yh-editor');
    const t = lineText(container, 0);
    selectRange(t, 6, t, 11);

    fireEvent(box, createEvent.keyDown(box, { key: 'Enter' }));

    expect(onTextChange).toHaveBeenCalledTimes(1);
    expect(onTextChange.mock.calls[0][0]).toBe('hello \n');
  });

  it('두 줄에 걸친 선택 + Enter는 두 줄을 병합·분할한다(step0 규칙과 동일)', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('AB'), textBlock('CD')]} onTextChange={onTextChange} />,
    );
    const box = container.querySelector('.yh-editor');
    selectRange(lineText(container, 0), 1, lineText(container, 1), 1); // 'B' + '\n' + 'C'

    fireEvent(box, createEvent.keyDown(box, { key: 'Enter' }));

    expect(onTextChange.mock.calls[0][0]).toBe('A\nD');
  });

  it('역방향 선택(anchor가 뒤)도 정방향과 같은 결과를 낸다', () => {
    const onTextChange = vi.fn();
    const { container } = render(<Editor blocks={[textBlock('hello world')]} onTextChange={onTextChange} />);
    const box = container.querySelector('.yh-editor');
    const t = lineText(container, 0);
    selectBackward(t, 11, t, 6); // 'world'를 오른쪽에서 왼쪽으로 선택

    fireEvent(box, pastePlainEvent(box, 'A\nB'));

    expect(onTextChange.mock.calls[0][0]).toBe('hello A\nB');
  });

  it('focus가 에디터 밖이면 삭제 없이 anchor 위치에 삽입한다(폴백)', () => {
    const onTextChange = vi.fn();
    const { container } = render(<Editor blocks={[textBlock('hello world')]} onTextChange={onTextChange} />);
    const box = container.querySelector('.yh-editor');
    const outside = document.createElement('div');
    outside.textContent = '바깥';
    document.body.appendChild(outside);
    try {
      selectBackward(lineText(container, 0), 6, outside.firstChild, 2);
      fireEvent(box, pastePlainEvent(box, 'A\nB'));
      expect(onTextChange.mock.calls[0][0]).toBe('hello A\nBworld'); // 선택 삭제 없음(오늘 동작 유지)
    } finally {
      outside.remove();
    }
  });

  it('anchor를 환산할 수 없으면(에디터 밖) focus가 유효해도 범위를 지어내지 않고 캐럿 미상 폴백을 탄다', () => {
    const onTextChange = vi.fn();
    const { container } = render(<Editor blocks={[textBlock('hello world')]} onTextChange={onTextChange} />);
    const box = container.querySelector('.yh-editor');
    const outside = document.createElement('div');
    outside.textContent = '바깥';
    document.body.appendChild(outside);
    try {
      selectBackward(outside.firstChild, 0, lineText(container, 0), 11);
      fireEvent(box, pastePlainEvent(box, 'A\nB'));
      expect(onTextChange.mock.calls[0][0]).toBe('hello worldA\nB'); // 마지막 텍스트 줄 끝 덧붙임(폴백)
    } finally {
      outside.remove();
    }
  });

  it('마커에 걸친 선택 + Enter는 "(끝)" 줄을 온전히 남긴다(step0 clamp 결선)', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('본문'), textBlock('(끝)')]} onTextChange={onTextChange} />,
    );
    const box = container.querySelector('.yh-editor');
    selectRange(lineText(container, 0), 1, lineText(container, 1), 3); // '문' ~ 마커 끝

    fireEvent(box, createEvent.keyDown(box, { key: 'Enter' }));

    expect(onTextChange).toHaveBeenCalledTimes(1);
    const [text, blocks] = onTextChange.mock.calls[0];
    expect(text).toBe('본\n\n(끝)');
    expect(blocks.filter((b) => b.text === '(끝)')).toHaveLength(1); // 마커 정확히 하나·오염 없음
  });

  it('역방향 선택으로 anchor가 마커 뒤면 기존 차단(caretBlocked)이 그대로 걸려 본문이 바뀌지 않는다', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('본문'), textBlock('(끝)')]} onTextChange={onTextChange} />,
    );
    const box = container.querySelector('.yh-editor');
    selectBackward(lineText(container, 1), 3, lineText(container, 0), 1); // anchor가 마커 줄

    expect(fireWithPreventSpy(box, 'keyDown', { key: 'Enter' })).toHaveBeenCalled();
    expect(onTextChange).not.toHaveBeenCalled(); // 보수적 no-op(A-3 결정)
  });

  it('collapsed 캐럿의 여러 줄 붙여넣기는 기존대로 그 자리에서 분할한다(회귀)', () => {
    const onTextChange = vi.fn();
    const { container } = render(<Editor blocks={[textBlock('hello world')]} onTextChange={onTextChange} />);
    const box = container.querySelector('.yh-editor');
    setCaret(lineText(container, 0), 6);

    fireEvent(box, pastePlainEvent(box, 'A\nB'));

    expect(onTextChange.mock.calls[0][0]).toBe('hello A\nBworld');
  });

  it('한 줄 붙여넣기는 선택이 있어도 네이티브 위임 그대로다(preventDefault·onTextChange 없음)', () => {
    const onTextChange = vi.fn();
    const { container } = render(<Editor blocks={[textBlock('hello world')]} onTextChange={onTextChange} />);
    const box = container.querySelector('.yh-editor');
    const t = lineText(container, 0);
    selectRange(t, 6, t, 11);

    const ev = pastePlainEvent(box, 'X');
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).not.toHaveBeenCalled();
    expect(onTextChange).not.toHaveBeenCalled();
  });
});

// 53-1(요소 앵커): 편집 메뉴의 전체/문단/한 줄 선택은 텍스트 노드가 아니라 "요소 + 자식 경계 인덱스"를 앵커로
// 만든다(editorSelect.js). 요소 지점을 col 0으로 접거나 null로 흘리면 가장 흔한 제스처에서 선택이 지워지지 않는다.
// 실제 선택 함수를 그대로 호출해 앱과 같은 경로를 재현한다.
describe('Editor — 편집 메뉴 선택 제스처(요소 앵커) + 선택 삭제', () => {
  it('전체 선택(selectAllInEditor) + 여러 줄 붙여넣기는 본문을 통째로 대체한다', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('첫줄'), textBlock('둘째')]} onTextChange={onTextChange} />,
    );
    const box = container.querySelector('.yh-editor');
    selectAllInEditor(box); // selectNodeContents(root) — root 요소 앵커

    fireEvent(box, pastePlainEvent(box, 'A\nB'));

    expect(onTextChange.mock.calls[0][0]).toBe('A\nB'); // 선택 텍스트 0 잔존
  });

  it('전체 선택(selectAllInEditor) + Enter는 본문을 빈 두 줄로 만든다', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('첫줄'), textBlock('둘째')]} onTextChange={onTextChange} />,
    );
    const box = container.querySelector('.yh-editor');
    selectAllInEditor(box);

    fireEvent(box, createEvent.keyDown(box, { key: 'Enter' }));

    expect(onTextChange.mock.calls[0][0]).toBe('\n');
  });

  it('문단 선택(selectParagraphInEditor — setStartBefore/setEndAfter) + Enter는 선택 줄만 지운다', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('첫줄'), textBlock('둘째'), textBlock('셋째')]} onTextChange={onTextChange} />,
    );
    const box = container.querySelector('.yh-editor');
    selectParagraphInEditor(box, 0, 1); // root 앵커 + 자식 경계 인덱스

    fireEvent(box, createEvent.keyDown(box, { key: 'Enter' }));

    expect(onTextChange.mock.calls[0][0]).toBe('\n셋째'); // 0~1행 사라지고 셋째는 무손상
  });

  it('한 줄 선택(selectLineInEditor — 줄 요소 앵커) + 여러 줄 붙여넣기는 그 줄을 대체한다', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('첫줄'), textBlock('둘째')]} onTextChange={onTextChange} />,
    );
    const box = container.querySelector('.yh-editor');
    selectLineInEditor(box, 0); // selectNodeContents(lineEl)

    fireEvent(box, pastePlainEvent(box, 'X\nY'));

    expect(onTextChange.mock.calls[0][0]).toBe('X\nY\n둘째'); // collapsed로 접히면 'X\nY첫줄\n둘째'
  });

  it('전체 선택 + 마커 문서에서 붙여넣어도 "(끝)"이 정확히 하나 온전히 남는다', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('본문'), textBlock('(끝)')]} onTextChange={onTextChange} />,
    );
    const box = container.querySelector('.yh-editor');
    selectAllInEditor(box); // readCaret도 null이라 caretBlocked가 막지 않는 경로

    fireEvent(box, pastePlainEvent(box, 'A\nB'));

    expect(onTextChange).toHaveBeenCalledTimes(1);
    const [text, blocks] = onTextChange.mock.calls[0];
    expect(text).toBe('A\nB\n(끝)'); // 선택 본문은 사라지고 마커는 무손상
    expect(blocks.filter((b) => b.text === '(끝)')).toHaveLength(1); // '(끝)A' 오염 없음
  });
});

// 53-1 보강(테스트 게이트): 임베드가 섞인 문서(사진 기사 — 가장 흔한 형태)의 요소 앵커 선택.
// 임베드는 blocksToText/replaceRangeInBlocks 좌표에 포함되지 않으므로(step0 좌표 계약), DOM→좌표 환산이
// 임베드를 텍스트 줄로 세면 lineIndex가 통째로 밀려 "선택했는데 안 지워지는"(A 결함 그대로) 결과가 된다.
// 순수 계층(editorNewline)의 임베드 테스트는 좌표가 이미 옳다고 가정하므로 이 결선 구간을 잡지 못한다.
describe('Editor — 임베드 포함 문서의 선택 삭제 결선(좌표 환산 계약)', () => {
  const img = () => embedBlock({ embedType: 'image', src: 'a.png' });

  it('임베드가 있어도 전체 선택 + 붙여넣기는 텍스트를 전부 대체한다(임베드는 무삭제·마커 무손상)', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('본문'), img(), textBlock('(끝)')]} onTextChange={onTextChange} />,
    );
    const box = container.querySelector('.yh-editor');
    selectAllInEditor(box);

    fireEvent(box, pastePlainEvent(box, 'A\nB'));

    expect(onTextChange).toHaveBeenCalledTimes(1);
    const [text, blocks] = onTextChange.mock.calls[0];
    expect(text).toBe('A\nB\n(끝)'); // 임베드를 텍스트 줄로 세면 'A\nB본문\n(끝)'(선택 미삭제)이 된다
    expect(blocks.filter((b) => b.type === 'embed')).toHaveLength(1); // 미디어 무음 소실 금지
    expect(blocks.filter((b) => b.text === '(끝)')).toHaveLength(1); // 마커 정확히 하나
  });

  it('임베드가 있어도 전체 선택 + Enter는 텍스트만 비운다(임베드 보존)', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('첫줄'), img(), textBlock('둘째')]} onTextChange={onTextChange} />,
    );
    const box = container.querySelector('.yh-editor');
    selectAllInEditor(box);

    fireEvent(box, createEvent.keyDown(box, { key: 'Enter' }));

    const [text, blocks] = onTextChange.mock.calls[0];
    expect(text).toBe('\n');
    expect(blocks.filter((b) => b.type === 'embed')).toHaveLength(1);
  });

  it('임베드를 사이에 둔 문단 선택 + 붙여넣기는 선택 줄만 대체하고 임베드·뒷줄은 남긴다', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor
        blocks={[textBlock('첫줄'), img(), textBlock('둘째'), textBlock('셋째')]}
        onTextChange={onTextChange}
      />,
    );
    const box = container.querySelector('.yh-editor');
    selectParagraphInEditor(box, 0, 1); // 텍스트-줄 기준 0~1행('첫줄'~'둘째') — 사이에 임베드가 있다

    fireEvent(box, pastePlainEvent(box, 'A\nB'));

    const [text, blocks] = onTextChange.mock.calls[0];
    expect(text).toBe('A\nB셋째'); // '첫줄'·'둘째'만 사라지고 '셋째'는 무손상
    expect(blocks.filter((b) => b.type === 'embed')).toHaveLength(1);
  });

  it('임베드 경계(root 자식 = 임베드)에서 시작한 선택은 앞 텍스트 줄의 끝으로 환산된다(문서화된 계약)', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('첫줄'), img(), textBlock('둘째')]} onTextChange={onTextChange} />,
    );
    const box = container.querySelector('.yh-editor');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(box, 1); // 임베드 바로 앞(root 자식 경계 인덱스)
    range.setEnd(box, box.childNodes.length); // 내용 끝
    sel.addRange(range);

    fireEvent(box, createEvent.keyDown(box, { key: 'Enter' }));

    const [text, blocks] = onTextChange.mock.calls[0];
    expect(text).toBe('첫줄\n'); // 앞 텍스트 줄('첫줄')은 보존되고 그 끝에서 분할된다
    expect(blocks.filter((b) => b.type === 'embed')).toHaveLength(1);
  });
});

// 53-2(B 결함): 편집 div에 onDrop/onDragOver가 없으면 브라우저가 드롭 지점(마커 줄 안쪽 포함)에 텍스트/DOM을
// 그대로 떨구고 handleInput이 본문으로 커밋한다 → '(끝)단어'가 되면 serializeBodyFromBlocks(trim 정확 비교)는
// 마커를 놓치는데 송고 가드 hasEndMarker(substring)는 통과해 오염된 본문이 송고·배부된다.
// 정책: 네이티브 드롭 전면 차단 + 이미지 파일만 onDropImageFile(file, caret)로 위임(news.md 192행).
describe('Editor — 드래그앤드롭 가드(네이티브 드롭 차단 + 이미지 파일만 위임)', () => {
  const realFileReader = globalThis.FileReader;
  afterEach(() => { globalThis.FileReader = realFileReader; });

  function imageFile() {
    return new File(['x'], 'pic.png', { type: 'image/png' });
  }

  // 드롭 이벤트 — dataTransfer를 붙여넣기 헬퍼(pasteImageEvent)와 동형으로 만든다.
  // items를 주지 않으면 files에서 파생한다(브라우저 기본형).
  function dropEvent(el, { files = [], items = null, text = 'dropped text' } = {}) {
    const ev = createEvent.drop(el, {});
    Object.defineProperty(ev, 'dataTransfer', {
      value: {
        files,
        items: items ?? files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
        getData: () => text,
      },
    });
    return ev;
  }

  // 이미지 없이 텍스트만 담긴 드롭(에디터 안팎에서 텍스트를 끌어다 놓는 경우).
  function textDropEvent(el, text = 'dropped text') {
    return dropEvent(el, { files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], text });
  }

  function lineTexts(container) {
    return Array.from(container.querySelectorAll('.yh-editor__line')).map((el) => el.textContent);
  }

  it('텍스트 드롭 → preventDefault로 차단되고 본문이 바뀌지 않는다(네이티브 삽입 금지)', () => {
    const onTextChange = vi.fn();
    const onDropImageFile = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('hello world')]} onTextChange={onTextChange} onDropImageFile={onDropImageFile} />,
    );
    const box = container.querySelector('.yh-editor');
    caretAtLine(container, 0);

    const ev = textDropEvent(box);
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).toHaveBeenCalledTimes(1);
    expect(onTextChange).not.toHaveBeenCalled();
    expect(onDropImageFile).not.toHaveBeenCalled();
    expect(lineTexts(container)).toEqual(['hello world']);
  });

  it('"(끝)" 줄에 텍스트를 드롭해도 마커가 오염되지 않는다(\'(끝)단어\' 경로 차단)', () => {
    const onTextChange = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('본문'), textBlock('(끝)')]} onTextChange={onTextChange} />,
    );
    const box = container.querySelector('.yh-editor');
    caretAtLine(container, 1); // 마커 줄 안쪽

    const ev = textDropEvent(box, '단어');
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).toHaveBeenCalled();
    expect(onTextChange).not.toHaveBeenCalled();
    expect(lineTexts(container)).toEqual(['본문', '(끝)']); // 마커 무손상
  });

  it('dragover에서 preventDefault를 호출한다(드롭 이벤트 수신 보장 + 네이티브 삽입 준비 차단)', () => {
    const { container } = render(<Editor blocks={[textBlock('hello')]} onTextChange={() => {}} />);
    const box = container.querySelector('.yh-editor');
    expect(fireWithPreventSpy(box, 'dragOver')).toHaveBeenCalled();
  });

  it('이미지 파일 드롭 → preventDefault 1회 + onDropImageFile(raw File, caret) 1회(FileReader 미사용·onTextChange 없음)', () => {
    // FileReader가 호출되면 즉시 실패(Editor가 base64를 만들지 않음을 보증 — phase 20 결정).
    globalThis.FileReader = class { readAsDataURL() { throw new Error('Editor must not create base64'); } };
    const onTextChange = vi.fn();
    const onDropImageFile = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('헤드'), textBlock('본문')]} onTextChange={onTextChange} onDropImageFile={onDropImageFile} />,
    );
    const box = container.querySelector('.yh-editor');
    caretAtLine(container, 0);

    const ev = dropEvent(box, { files: [imageFile()] });
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).toHaveBeenCalledTimes(1);
    expect(onDropImageFile).toHaveBeenCalledTimes(1);
    const [file, caret] = onDropImageFile.mock.calls[0];
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe('image/png');
    expect(caret).toMatchObject({ lineIndex: 0 });
    expect(onTextChange).not.toHaveBeenCalled(); // 본문 반영은 상위(업로드→경로 임베드) 책임
  });

  it('files 없이 items만 있는 이미지 드롭도 getAsFile로 위임한다(붙여넣기 판정과 같은 규칙)', () => {
    const onDropImageFile = vi.fn();
    const file = imageFile();
    const { container } = render(
      <Editor blocks={[textBlock('헤드')]} onTextChange={() => {}} onDropImageFile={onDropImageFile} />,
    );
    const box = container.querySelector('.yh-editor');
    caretAtLine(container, 0);

    fireEvent(box, dropEvent(box, { files: [], items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }));

    expect(onDropImageFile).toHaveBeenCalledTimes(1);
    expect(onDropImageFile.mock.calls[0][0]).toBe(file);
  });

  it('selection이 없으면 caret은 null로 넘어간다(삽입 위치 폴백은 상위 계약)', () => {
    const onDropImageFile = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('헤드')]} onTextChange={() => {}} onDropImageFile={onDropImageFile} />,
    );
    const box = container.querySelector('.yh-editor');
    window.getSelection().removeAllRanges();

    fireEvent(box, dropEvent(box, { files: [imageFile()] }));

    expect(onDropImageFile).toHaveBeenCalledTimes(1);
    expect(onDropImageFile.mock.calls[0][1]).toBeNull();
  });

  it('onDropImageFile prop이 없으면(환경설정 off) 이미지 드롭도 차단만 된다(본문 불변)', () => {
    const onTextChange = vi.fn();
    const { container } = render(<Editor blocks={[textBlock('헤드')]} onTextChange={onTextChange} />);
    const box = container.querySelector('.yh-editor');
    caretAtLine(container, 0);

    const ev = dropEvent(box, { files: [imageFile()] });
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).toHaveBeenCalled();
    expect(onTextChange).not.toHaveBeenCalled();
    expect(lineTexts(container)).toEqual(['헤드']);
  });

  it('"(끝)" 줄에서도 이미지 드롭은 위임된다(임베드는 마커 앞 정규화 — 마커 차단은 텍스트만)', () => {
    const onDropImageFile = vi.fn();
    const { container } = render(
      <Editor blocks={[textBlock('헤드'), textBlock('본문'), textBlock('(끝)')]} onTextChange={() => {}} onDropImageFile={onDropImageFile} />,
    );
    const box = container.querySelector('.yh-editor');
    caretAtLine(container, 2);

    fireEvent(box, dropEvent(box, { files: [imageFile()] }));

    expect(onDropImageFile).toHaveBeenCalledTimes(1);
    expect(onDropImageFile.mock.calls[0][1]).toMatchObject({ lineIndex: 2 });
  });

  it('읽기전용(readOnly)에서도 네이티브 드롭은 차단된다(위임 대상 prop이 없으면 콜백 0회)', () => {
    const { container } = render(<Editor blocks={[textBlock('헤드')]} readOnly />);
    const box = container.querySelector('.yh-editor');

    expect(fireWithPreventSpy(box, 'dragOver')).toHaveBeenCalled();
    const ev = textDropEvent(box);
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).toHaveBeenCalled();
    expect(lineTexts(container)).toEqual(['헤드']);
  });

  it('매핑(textEditable=false)에서도 이미지 드롭은 위임된다(임베드 삽입 허용 — onPasteImageFile과 같은 취급)', () => {
    const onTextChange = vi.fn();
    const onDropImageFile = vi.fn();
    const { container } = render(
      <Editor
        blocks={[textBlock('헤드')]}
        textEditable={false}
        onTextChange={onTextChange}
        onDropImageFile={onDropImageFile}
      />,
    );
    const box = container.querySelector('.yh-editor');
    caretAtLine(container, 0);

    const ev = dropEvent(box, { files: [imageFile()] });
    const prevent = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(prevent).toHaveBeenCalled();
    expect(onDropImageFile).toHaveBeenCalledTimes(1);
    expect(onTextChange).not.toHaveBeenCalled();
  });
});
