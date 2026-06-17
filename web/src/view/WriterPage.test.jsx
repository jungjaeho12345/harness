import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  render, screen, waitFor, fireEvent, createEvent,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { WriterPage } from './WriterPage.jsx';
import { PENDING_EDIT_KEY } from '../controller/useViewController.js';
import { createFakeModel } from '../test/fakeModel.js';
import { serialize, deserialize, textBlock, embedBlock, blocksToText } from './editorContent.js';

function setup({ identity = { userId: 'kim', name: '김기자', role: 'R', department: '정치' }, pendingEdit, seed } = {}) {
  if (pendingEdit) sessionStorage.setItem(PENDING_EDIT_KEY, JSON.stringify(pendingEdit));
  const model = createFakeModel(seed);
  const utils = render(
    <AppContext.Provider value={{ model, identity, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      <WriterPage />
    </AppContext.Provider>,
  );
  return { model, ...utils };
}

const actionBtn = (name) => screen.queryByRole('button', { name });

describe('WriterPage — 레이아웃', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  it('좌 에디터 : 우 메타 = 60:40 레이아웃', () => {
    const { container } = setup();
    expect(container.querySelector('.yh-writer__editor')).toBeTruthy();
    expect(container.querySelector('.yh-writer__meta')).toBeTruthy();
    // 메타 4탭.
    for (const t of ['공통정보', '이미지', '영상', '글기사']) {
      expect(screen.getByRole('button', { name: t })).toBeInTheDocument();
    }
  });
});

describe('WriterPage — 송고/보류/KILL 버튼 진리표(권한×상태×진입)', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  it('신규(미저장): 송고·보류만, KILL 숨김', () => {
    setup({ identity: { role: 'R' } });
    expect(actionBtn('송고')).toBeInTheDocument();
    expect(actionBtn('보류')).toBeInTheDocument();
    expect(actionBtn('KILL')).toBeNull();
  });

  it('RDS(편집) R: 송고·보류·KILL', async () => {
    setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: 't', body: 't\n본문', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y' }] },
    });
    await waitFor(() => expect(actionBtn('KILL')).toBeInTheDocument());
    expect(actionBtn('송고')).toBeInTheDocument();
    expect(actionBtn('보류')).toBeInTheDocument();
  });

  it('DDH(편집) R: 버튼 없음 / D: 송고·KILL(보류 없음)', async () => {
    const r = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR2', title: 't', body: 't', status: 'DDH' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR2', status: 'DDH', lockYN: 'Y' }] },
    });
    await waitFor(() => expect(r.container.querySelector('[data-testid="action-bar"]')).toBeTruthy());
    expect(actionBtn('송고')).toBeNull();
    expect(actionBtn('보류')).toBeNull();
    expect(actionBtn('KILL')).toBeNull();
    r.unmount();
    sessionStorage.clear();

    setup({
      identity: { role: 'D' },
      pendingEdit: { article: { articleId: 'AKR2', title: 't', body: 't', status: 'DDH' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR2', status: 'DDH', lockYN: 'Y' }] },
    });
    await waitFor(() => expect(actionBtn('KILL')).toBeInTheDocument());
    expect(actionBtn('송고')).toBeInTheDocument();
    expect(actionBtn('보류')).toBeNull();
  });

  it('DPS 포털고침 진입 D: 송고·보류(KILL 없음)', async () => {
    setup({
      identity: { role: 'D' },
      pendingEdit: { article: { articleId: 'AKR3', title: 't', body: 't', status: 'DPS' }, mode: 'portalRevise' },
      seed: { articles: [{ articleId: 'AKR3', status: 'DPS', lockYN: 'Y' }] },
    });
    await waitFor(() => expect(actionBtn('송고')).toBeInTheDocument());
    expect(actionBtn('보류')).toBeInTheDocument();
    expect(actionBtn('KILL')).toBeNull();
  });
});

describe('WriterPage — 송고/보류 가드 + 확인창', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  it('제목(첫 줄)이 비면 송고를 ALERT로 차단한다', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { model } = setup({ identity: { role: 'R' } }); // 신규 빈 탭 → 제목 없음
    const save = vi.spyOn(model, 'saveArticle');
    await userEvent.click(actionBtn('송고'));
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('제목'));
    expect(save).not.toHaveBeenCalled();
  });

  it('본문에 "(끝)"이 없으면 송고를 ALERT로 차단한다', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { model } = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '헤드', body: '헤드라인\n본문내용', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y' }] },
    });
    await waitFor(() => expect(actionBtn('송고')).toBeInTheDocument());
    const apply = vi.spyOn(model, 'applyAction');
    await userEvent.click(actionBtn('송고'));
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('(끝)'));
    expect(apply).not.toHaveBeenCalled();
  });

  it('제목+"(끝)"이 있고 확인하면 송고 전이를 호출한다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model } = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '헤드', body: '헤드라인\n본문\n(끝)', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y' }] },
    });
    await waitFor(() => expect(actionBtn('송고')).toBeInTheDocument());
    const apply = vi.spyOn(model, 'applyAction');
    await userEvent.click(actionBtn('송고'));
    await waitFor(() => expect(apply).toHaveBeenCalledWith('AKR1', 'send'));
  });

  it('확인창에서 취소하면 아무 것도 전송하지 않는다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { model } = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '헤드', body: '헤드라인\n본문\n(끝)', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y' }] },
    });
    await waitFor(() => expect(actionBtn('송고')).toBeInTheDocument());
    const apply = vi.spyOn(model, 'applyAction');
    await userEvent.click(actionBtn('송고'));
    expect(apply).not.toHaveBeenCalled();
  });
});

// 3-mapping step3: 매핑 모드 — 본문 readOnly·메타 탭 임베드 추가 활성·액션바 '저장'→saveMapping 결선.
describe('WriterPage — 매핑 모드(mode:mapping)', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  // 본문(markupVersion)을 가진 기사로 매핑 진입한 WriterPage를 띄운다.
  async function openMapping(blocks, { mediaItems = [], articles = [] } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role: 'R', name: '김기자' },
      pendingEdit: { article: { articleId: 'AKR9', title: '제목', status: 'DPS' }, mode: 'mapping' },
      seed: {
        articles: [{ articleId: 'AKR9', status: 'DPS', lockYN: 'Y', markupVersion: body }, ...articles],
        mediaItems,
      },
    });
    // 매핑 진입 완료 = 액션바에 '저장' 버튼이 뜸.
    await waitFor(() => expect(actionBtn('저장')).toBeInTheDocument());
    return utils;
  }

  it('본문 에디터가 readOnly(contentEditable=false)로 잠긴다', async () => {
    const { container } = await openMapping([textBlock('헤드라인'), textBlock('본문내용')]);
    const editor = container.querySelector('.yh-editor');
    expect(editor).toBeTruthy();
    expect(editor.getAttribute('contenteditable')).toBe('false');
  });

  it('공통정보 메타 입력(작성자/엠바고/2차엠바고)도 readOnly로 잠긴다', async () => {
    const { container } = await openMapping([textBlock('헤드라인'), textBlock('본문내용')]);
    for (const id of ['meta-author', 'meta-embargo', 'meta-embargo2']) {
      const input = container.querySelector(`#${id}`);
      expect(input).toBeTruthy();
      expect(input.readOnly).toBe(true);
    }
  });

  it("액션바에 '저장'만 있고 송고/보류/KILL은 없다", async () => {
    await openMapping([textBlock('헤드라인'), textBlock('본문')]);
    expect(actionBtn('저장')).toBeInTheDocument();
    expect(actionBtn('송고')).toBeNull();
    expect(actionBtn('보류')).toBeNull();
    expect(actionBtn('KILL')).toBeNull();
  });

  it('이미지 메타 탭에서 검색 결과 클릭 시 본문에 임베드만 추가되고 텍스트 블록은 보존된다', async () => {
    const { model } = await openMapping(
      [textBlock('헤드라인'), textBlock('본문내용'), textBlock('(끝)')],
      { mediaItems: [{ type: 'image', src: 'pic.png', title: '사진' }] },
    );
    const save = vi.spyOn(model, 'saveArticle');

    await userEvent.click(screen.getByRole('button', { name: '이미지' }));
    await userEvent.type(screen.getByLabelText('image 검색어'), '사진');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    await screen.findByRole('img', { name: '사진' });
    await userEvent.click(screen.getByRole('img', { name: '사진' }).closest('button'));

    // 저장 → PUT으로 실린 본문에서 텍스트 블록 불변 + 임베드 1개 추가 확인.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());

    const dto = save.mock.calls[save.mock.calls.length - 1][0];
    const blocks = deserialize(dto.markupVersion);
    expect(blocksToText(blocks)).toBe('헤드라인\n본문내용\n(끝)'); // 텍스트 보존(blocksToText 불변)
    expect(blocks.some((b) => b.type === 'embed' && b.embedType === 'image')).toBe(true);
  });

  it("'저장' 클릭은 saveMapping(PUT)을 호출하고 applyAction(송고)을 호출하지 않는다", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model } = await openMapping([textBlock('헤드라인'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');
    const apply = vi.spyOn(model, 'applyAction');

    await userEvent.click(actionBtn('저장'));

    await waitFor(() => expect(save).toHaveBeenCalled());
    // PUT(articleId 포함) — 매핑은 기존 기사 저장.
    expect(save.mock.calls[0][0].articleId).toBe('AKR9');
    expect(apply).not.toHaveBeenCalled(); // 전이 없음
  });

  it("'저장'은 송고 가드(제목/(끝))를 적용하지 않는다", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    // 제목 없음·"(끝)" 없음이어도 저장은 막히지 않는다.
    const { model } = await openMapping([textBlock(''), textBlock('본문만')]);
    const save = vi.spyOn(model, 'saveArticle');

    await userEvent.click(actionBtn('저장'));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(alert).not.toHaveBeenCalled();
  });

  it("'저장' 확인창에서 취소하면 saveMapping(PUT)을 호출하지 않는다(DB 비파괴)", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { model } = await openMapping([textBlock('헤드라인'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');
    const apply = vi.spyOn(model, 'applyAction');

    await userEvent.click(actionBtn('저장'));

    expect(save).not.toHaveBeenCalled(); // 취소 → PUT 미전송(원본 본문 무변경)
    expect(apply).not.toHaveBeenCalled();
  });

  it('일반 편집(edit) 모드는 무회귀 — 에디터 편집 가능 + 송고/보류 버튼', async () => {
    setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: 't', body: 't\n본문', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y' }] },
    });
    await waitFor(() => expect(actionBtn('송고')).toBeInTheDocument());
    expect(actionBtn('저장')).toBeNull();
    const editor = document.querySelector('.yh-editor');
    expect(editor.getAttribute('contenteditable')).toBe('true');
  });
});

// 15-B: Ctrl+D / 빈 줄 Backspace 라인 삭제 + 임베드 동반 삭제 결선(isDeleteLine/deleteLineAt/lineAtOffset).
describe('WriterPage — 라인 삭제(Ctrl+D/Backspace) + 임베드 동반 삭제 결선', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  // 캐럿을 lineIndex번째 라인 div에 둔다.
  function caretAtLine(container, lineIndex) {
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(lineEls[lineIndex]);
    range.collapse(true);
    sel.addRange(range);
  }

  // 본문(markupVersion)을 가진 기사로 편집 진입한 WriterPage를 띄운다.
  async function openWith(blocks) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(screen.getByText('다음')).toBeInTheDocument());
    return utils;
  }

  // 에디터 라인 div들의 텍스트(탭 라벨 등 다른 '제목'과 혼동 없이 본문만 본다).
  const editorLines = (container) => Array.from(
    container.querySelectorAll('.yh-editor .yh-editor__line'),
  ).map((el) => el.textContent);

  it('Ctrl+D는 활성 라인과 바로 뒤 임베드를 함께 삭제한다', async () => {
    const { container } = await openWith([
      textBlock('제목'), textBlock('본문'), embedBlock({ embedType: 'image', src: 'x.png' }), textBlock('다음'),
    ]);
    expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy();

    caretAtLine(container, 1); // "본문" 라인
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'd', ctrlKey: true });

    await waitFor(() => expect(editorLines(container)).toEqual(['제목', '다음']));
    expect(container.querySelector('[data-embed-type="image"]')).toBeNull();
  });

  it('빈 줄에서 Backspace는 그 줄과 동반 임베드를 삭제한다', async () => {
    const { container } = await openWith([
      textBlock('제목'), textBlock(''), embedBlock({ embedType: 'image', src: 'x.png' }), textBlock('다음'),
    ]);
    expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy();

    caretAtLine(container, 1); // 빈 줄
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'Backspace' });

    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeNull());
    expect(editorLines(container)).toEqual(['제목', '다음']);
  });

  it('비어 있지 않은 줄의 Backspace(문자 삭제)는 개입하지 않는다(임베드 보존)', async () => {
    const { container } = await openWith([
      textBlock('제목'), textBlock('본문'), embedBlock({ embedType: 'image', src: 'x.png' }), textBlock('다음'),
    ]);
    caretAtLine(container, 1); // "본문" — 비어 있지 않음

    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: 'Backspace' });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(spy).not.toHaveBeenCalled(); // 기본 동작 유지
    expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy();
    expect(editorLines(container)).toContain('본문');
  });
});

// step11: 매핑(mapping) — 본문 텍스트 차단 + 공통정보 readOnly + 임베드 추가/삭제만 허용.
describe('WriterPage — 매핑(mapping) 임베드 전용 제한 편집', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  // 본문(markupVersion)을 가진 기사로 매핑 진입한 WriterPage를 띄운다.
  async function openMapping(blocks) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { userId: 'kim', name: '김기자', role: 'D', department: '정치' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', author: '원작성자', status: 'DPS' }, mode: 'mapping' },
      seed: { articles: [{ articleId: 'AKR1', status: 'DPS', lockYN: 'Y', author: '원작성자', markupVersion: body }] },
    });
    await waitFor(() => expect(screen.getByTestId('meta-common')).toBeInTheDocument());
    return utils;
  }

  it('매핑은 송고/보류/KILL 액션바를 노출하지 않고 저장 버튼을 노출한다', async () => {
    await openMapping([textBlock('제목'), textBlock('본문')]);
    expect(actionBtn('송고')).toBeNull();
    expect(actionBtn('보류')).toBeNull();
    expect(actionBtn('KILL')).toBeNull();
    expect(actionBtn('저장')).toBeInTheDocument();
  });

  it('저장 버튼은 PUT(saveArticle with articleId)를 호출하고 applyAction은 호출하지 않는다', async () => {
    const { model } = await openMapping([textBlock('제목'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');
    const apply = vi.spyOn(model, 'applyAction');
    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].articleId).toBe('AKR1');
    expect(apply).not.toHaveBeenCalled();
  });

  it('본문에 텍스트를 입력해도 body가 바뀌지 않는다(onTextChange 무력화)', async () => {
    const original = serialize([textBlock('제목'), textBlock('본문')]);
    const { container, model } = await openMapping([textBlock('제목'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');
    const box = container.querySelector('.yh-editor');
    // 매핑 모드는 본문 텍스트 비편집 — contentEditable이 꺼져 있어야 한다.
    expect(box.getAttribute('contenteditable')).toBe('false');
    // 타이핑(input 이벤트)이 발생해도 본문 텍스트가 body에 커밋되지 않는다.
    box.querySelector('.yh-editor__line').textContent = '해킹된 텍스트';
    fireEvent.input(box);
    // 저장 시 원본 body가 그대로 PUT된다(텍스트 변경이 반영되지 않음).
    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original);
  });

  it('공통정보 입력란(작성자/엠바고/2차엠바고)이 readOnly다', async () => {
    await openMapping([textBlock('제목'), textBlock('본문')]);
    expect(screen.getByLabelText('작성자')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('엠바고 시간')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('2차 엠바고 시간')).toHaveAttribute('readonly');
  });

  it('이미지 검색 결과를 클릭하면 임베드가 본문에 추가된다', async () => {
    const { container, model } = await openMapping([textBlock('제목'), textBlock('본문')]);
    vi.spyOn(model, 'searchMedia').mockResolvedValue({
      ok: true, error: false, items: [{ type: 'image', src: 'https://img/x.png', title: '사진' }],
    });
    await userEvent.click(screen.getByRole('button', { name: '이미지' }));
    await userEvent.click(screen.getByPlaceholderText('검색어를 입력하세요'));
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    // 검색 결과 버튼 클릭 → 임베드 삽입.
    const result = await screen.findByRole('img', { name: '사진' });
    await userEvent.click(result.closest('button'));

    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());
  });

  it('임베드 × 삭제 버튼이 노출되고 클릭하면 임베드가 제거된다', async () => {
    const { container } = await openMapping([
      textBlock('제목'), textBlock('본문'), embedBlock({ embedType: 'image', src: 'https://img/x.png' }),
    ]);
    expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy();
    const removeBtn = screen.getByRole('button', { name: '임베드 삭제' });
    await userEvent.click(removeBtn);
    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeNull());
  });
});
