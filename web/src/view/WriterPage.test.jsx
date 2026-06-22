import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render, screen, waitFor, fireEvent, createEvent, within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { WriterPage } from './WriterPage.jsx';
import { PENDING_EDIT_KEY } from '../controller/useViewController.js';
import { createFakeModel } from '../test/fakeModel.js';
import { serialize, deserialize, textBlock, embedBlock, blocksToText } from './editorContent.js';
import { loadEditorPrefs, saveEditorPrefs, DEFAULT_EDITOR_PREFS } from './editorPrefs.js';
import { saveDraft, loadDraft } from './editorDraft.js';
import { colorForRole, resetEditorColors } from './editorColoring.js';

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

// Step 3: 에디터 크롬(메뉴바·툴바·상태표시줄) 배치 + 보이기 토글.
describe('WriterPage — 에디터 크롬(메뉴바/툴바/상태표시줄) 배치·토글', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  // 본문(markupVersion)을 가진 기사로 편집 진입한 WriterPage를 띄운다.
  async function openWith(blocks) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  it('메뉴바·툴바·상태표시줄이 좌측 에디터 영역에 보인다', () => {
    const { container } = setup({ identity: { role: 'R' } });
    const editorCol = container.querySelector('.yh-writer__editor');
    expect(within(editorCol).getByTestId('menubar')).toBeInTheDocument();
    expect(within(editorCol).getByTestId('toolbar')).toBeInTheDocument();
    expect(within(editorCol).getByRole('status', { name: '에디터 상태' })).toBeInTheDocument();
  });

  it('본문 텍스트가 상태표시줄 단어수/Byte에 반영된다', async () => {
    const { getByTestId } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    // blocksToText = "헤드라인\n본문" → 단어 2개, UTF-8 19바이트(한글 3B×6 + 개행 1B).
    expect(getByTestId('stat-words')).toHaveTextContent('2단어');
    expect(getByTestId('stat-bytes')).toHaveTextContent('19B');
  });

  it('toggle-menubar/toggle-toolbar로 메뉴바·툴바를 숨기고 다시 보일 수 있다', async () => {
    const { getByTestId, queryByTestId } = setup({ identity: { role: 'R' } });
    expect(queryByTestId('menubar')).toBeInTheDocument();
    expect(queryByTestId('toolbar')).toBeInTheDocument();

    await userEvent.click(getByTestId('toggle-menubar'));
    expect(queryByTestId('menubar')).toBeNull();
    await userEvent.click(getByTestId('toggle-toolbar'));
    expect(queryByTestId('toolbar')).toBeNull();

    await userEvent.click(getByTestId('toggle-menubar'));
    expect(queryByTestId('menubar')).toBeInTheDocument();
    await userEvent.click(getByTestId('toggle-toolbar'));
    expect(queryByTestId('toolbar')).toBeInTheDocument();
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

  // 회귀: 제목 FIELD만 있고 본문 첫 줄이 비어도 제목으로 인정해야 한다(둘 중 하나라도 있으면 통과).
  // markupVersion 본문은 빈 첫 줄 + "(끝)"로 시작해 bodyTitle은 ''이지만 fields.title은 채워진 기사로 진입.
  const TITLE_FIELD_ONLY = {
    pendingEdit: { article: { articleId: 'AKR1', title: '필드제목', status: 'RDS' }, mode: 'edit' },
  };

  it('제목 FIELD만 있고 본문 첫 줄이 비어도 송고가 진행된다(제목 ALERT 없음)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const body = serialize([textBlock(''), textBlock('본문'), textBlock('(끝)')]);
    const { model } = setup({
      ...TITLE_FIELD_ONLY,
      identity: { role: 'R' },
      seed: { articles: [{ articleId: 'AKR1', title: '필드제목', status: 'RDS', lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(actionBtn('송고')).toBeInTheDocument());
    const apply = vi.spyOn(model, 'applyAction');
    await userEvent.click(actionBtn('송고'));
    await waitFor(() => expect(apply).toHaveBeenCalledWith('AKR1', 'send'));
    expect(alert).not.toHaveBeenCalledWith(expect.stringContaining('제목'));
  });

  it('제목 FIELD만 있고 본문 첫 줄이 비어도 보류가 진행된다("(끝)" 불필요)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const body = serialize([textBlock(''), textBlock('본문')]); // (끝) 없음 — 보류는 무관
    const { model } = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '필드제목', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', title: '필드제목', status: 'RDS', lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(actionBtn('보류')).toBeInTheDocument());
    const apply = vi.spyOn(model, 'applyAction');
    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(apply).toHaveBeenCalledWith('AKR1', 'hold'));
    expect(alert).not.toHaveBeenCalled();
  });

  it('본문 첫 줄이 있고 "(끝)"이 없으면 송고는 (끝) ALERT로 막히고 보류는 진행된다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { model } = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '헤드', body: '헤드라인\n본문', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y' }] },
    });
    await waitFor(() => expect(actionBtn('송고')).toBeInTheDocument());
    const apply = vi.spyOn(model, 'applyAction');

    await userEvent.click(actionBtn('송고'));
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('(끝)'));
    expect(apply).not.toHaveBeenCalled();

    await userEvent.click(actionBtn('보류')); // 보류는 (끝) 불필요 → 진행
    await waitFor(() => expect(apply).toHaveBeenCalledWith('AKR1', 'hold'));
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

  // 회귀: 삭제할 텍스트 라인이 없어도 Ctrl+D는 브라우저 기본동작(북마크 추가)을 막아야 한다.
  // (라인이 없을 때 preventDefault를 빼먹으면 두 번째 Ctrl+D에서 북마크 창이 떴다.)
  it('삭제할 텍스트 라인이 없어도 Ctrl+D는 기본동작(북마크)을 차단한다', async () => {
    const body = serialize([embedBlock({ embedType: 'image', src: 'x.png' })]); // 텍스트 블록 없음
    const { container } = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());

    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: 'd', ctrlKey: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(spy).toHaveBeenCalled(); // 삭제는 못 해도 북마크 기본동작은 막는다
  });
});

// Ctrl+V 이미지 붙여넣기 — 텍스트를 직렬화하지 않고 캐럿 위치에만 임베드를 삽입한다(news.md 156행).
describe('WriterPage — Ctrl+V 이미지 붙여넣기: 커서 위치 삽입', () => {
  const realFileReader = globalThis.FileReader;

  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    class FakeFileReader {
      readAsDataURL() {
        this.result = 'data:image/png;base64,AAA';
        setTimeout(() => { if (this.onload) this.onload({ target: this }); }, 0);
      }
    }
    globalThis.FileReader = FakeFileReader;
  });
  afterEach(() => { globalThis.FileReader = realFileReader; });

  function pasteImageEvent(el) {
    const ev = createEvent.paste(el, {});
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
    });
    return ev;
  }

  function caretAtLine(container, lineIndex) {
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(lineEls[lineIndex]);
    range.collapse(true);
    sel.addRange(range);
  }

  // 에디터 내부 블록(라인 div + 임베드 figure)을 DOM 순서대로 타입 배열로 읽는다.
  const blockTypes = (container) => Array.from(
    container.querySelectorAll('.yh-editor .yh-editor__line, .yh-editor .yh-embed'),
  ).map((el) => (el.classList.contains('yh-embed') ? 'embed' : 'text'));

  async function openWith(blocks) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  it('첫 줄에 캐럿을 두고 붙여넣으면 그 줄 바로 뒤에 임베드가 삽입된다(맨 뒤가 아님)', async () => {
    const { container } = await openWith([textBlock('제목'), textBlock('본문')]);
    caretAtLine(container, 0); // 제목 줄
    const box = container.querySelector('.yh-editor');
    fireEvent(box, pasteImageEvent(box));

    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());
    expect(blockTypes(container)).toEqual(['text', 'embed', 'text', 'text']); // 제목 → [이미지] → 빈 줄 → 본문
  });

  it('붙여넣은 이미지는 이후 타이핑(input)에도 커서 위치에 보존된다(끝으로 밀리지 않음)', async () => {
    const { container } = await openWith([textBlock('제목'), textBlock('본문')]);
    caretAtLine(container, 0);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, pasteImageEvent(box));
    await waitFor(() => expect(blockTypes(container)).toEqual(['text', 'embed', 'text', 'text']));

    // 본문을 수정(input)해도 임베드는 제목과 본문 사이에 그대로 남는다.
    fireEvent.input(box);
    await waitFor(() => expect(blockTypes(container)).toEqual(['text', 'embed', 'text', 'text']));
  });
});

// 검색패널(이미지/영상/글기사) 임베드 — 마지막 커서 텍스트 줄 "뒤"에 삽입 + 빈 줄 + 커서를 빈 줄로 이동(edit 모드, news.md 156행).
describe('WriterPage — 검색패널 임베드: 커서 줄 뒤 삽입 + 개행 + 커서 이동', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  const blockTypes = (container) => Array.from(
    container.querySelectorAll('.yh-editor .yh-editor__line, .yh-editor .yh-embed'),
  ).map((el) => (el.classList.contains('yh-embed') ? 'embed' : 'text'));

  function caretAtLine(container, lineIndex) {
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(lineEls[lineIndex]);
    range.collapse(true);
    sel.addRange(range);
  }

  // 에디터(.yh-editor)에 focus()가 호출됐는지 기록한다(임베드 삽입 후 커서가 에디터로 이동 = focusLineStart 실행).
  // jsdom은 contentEditable의 native caret/selection을 신뢰성 있게 반영하지 않으므로(기존 Editor 테스트도 focus 스파이로 검증),
  // 커서 이동은 "에디터에 focus()가 걸렸는지"로 확인한다. 실제 빈 줄 캐럿 배치는 Editor.test.jsx의 pendingCaretLine 단위테스트가 보증.
  function spyEditorFocus() {
    const realFocus = HTMLElement.prototype.focus;
    const calls = [];
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function focusImpl(...args) {
      if (this.classList && this.classList.contains('yh-editor')) calls.push(this);
      return realFocus.apply(this, args);
    });
    return calls;
  }

  // 에디터 캐럿을 줄에 두고 caret 이벤트를 발생시켜 onCaretChange로 lastCaret을 갱신한다(검색패널 클릭 전 상태 모사).
  function focusCaretAtLine(container, lineIndex) {
    caretAtLine(container, lineIndex);
    fireEvent.keyUp(container.querySelector('.yh-editor')); // onCaretChange({lineIndex}) → lastCaretRef 갱신
  }

  async function openWith(blocks) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  async function searchAndInsertImage(model) {
    vi.spyOn(model, 'searchMedia').mockResolvedValue({
      ok: true, error: false, items: [{ type: 'image', src: 'https://img/x.png', title: '사진' }],
    });
    await userEvent.click(screen.getByRole('button', { name: '이미지' }));
    await userEvent.click(screen.getByPlaceholderText('검색어를 입력하세요'));
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    const result = await screen.findByRole('img', { name: '사진' });
    await userEvent.click(result.closest('button'));
  }

  it('마지막 캐럿 줄 다음에 임베드 + 빈 줄을 삽입하고 커서를 빈 줄로 옮긴다', async () => {
    const { container, model } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1); // "본문" 줄에 캐럿
    const editorFocuses = spyEditorFocus();

    await searchAndInsertImage(model);

    // 본문 줄 다음에 임베드 + 빈 줄: [헤드라인, 본문, embed, 빈 줄]
    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());
    expect(blockTypes(container)).toEqual(['text', 'text', 'embed', 'text']);
    const lines = container.querySelectorAll('.yh-editor__line');
    expect(lines[lines.length - 1].textContent).toBe(''); // 임베드 뒤 빈 줄
    await waitFor(() => expect(editorFocuses.length).toBeGreaterThanOrEqual(1)); // 커서가 에디터(새 빈 줄)로 이동
  });

  it('캐럿이 없으면(에디터 미포커스) 끝에만 추가한다(빈 줄/커서 이동 없음)', async () => {
    const { container, model } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    // 캐럿 이벤트를 발생시키지 않음 → lastCaretRef=null → append 폴백.
    await searchAndInsertImage(model);

    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());
    expect(blockTypes(container)).toEqual(['text', 'text', 'embed']); // 끝에 임베드만(빈 줄 없음)
  });

  it('같은 줄로 연속 2회 삽입해도 매번 임베드+빈 줄이 더해지고 커서가 빈 줄에 위치한다', async () => {
    const { container, model } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    const editorFocuses = spyEditorFocus();

    // 글기사는 검색 결과(버튼 '삽입')와 임베드(링크)가 구분돼 역할 충돌이 없다.
    vi.spyOn(model, 'searchArticles').mockResolvedValue({
      ok: true, items: [{ articleId: 'AKR100', title: '연합뉴스속보', status: 'DPS' }],
    });
    await userEvent.click(screen.getByRole('button', { name: '글기사' }));
    await userEvent.type(screen.getByLabelText('article 검색어'), '연합');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));

    await userEvent.click(await screen.findByRole('button', { name: '삽입' }));
    await waitFor(() => expect(container.querySelectorAll('[data-embed-type="article"]').length).toBe(1));

    // lastCaretRef는 첫 삽입 후에도 같은 줄(1) — 두 번째도 같은 줄 뒤에 삽입(검색 결과 '삽입' 버튼은 유지됨).
    await userEvent.click(screen.getByRole('button', { name: '삽입' }));
    await waitFor(() => expect(container.querySelectorAll('[data-embed-type="article"]').length).toBe(2));
    await waitFor(() => expect(editorFocuses.length).toBeGreaterThanOrEqual(2)); // 2회 모두 커서가 에디터(빈 줄)로 이동
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
    vi.spyOn(window, 'confirm').mockReturnValue(true); // 저장 확인창 통과(DB 비파괴 가드)
    const { model } = await openMapping([textBlock('제목'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');
    const apply = vi.spyOn(model, 'applyAction');
    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].articleId).toBe('AKR1');
    expect(apply).not.toHaveBeenCalled();
  });

  it('본문에 텍스트를 입력해도 body가 바뀌지 않는다(onTextChange 무력화)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true); // 저장 확인창 통과(DB 비파괴 가드)
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

  it("글기사 검색 결과는 제목 + '삽입' 버튼으로 표시되고, 삽입 클릭 시 본문에 기사 임베드가 추가된다", async () => {
    const { container, model } = await openMapping([textBlock('헤드라인'), textBlock('본문')]);
    vi.spyOn(model, 'searchArticles').mockResolvedValue({
      ok: true, items: [{ articleId: 'AKR100', title: '연합뉴스 속보 테스트', status: 'DPS' }],
    });
    await userEvent.click(screen.getByRole('button', { name: '글기사' }));
    await userEvent.type(screen.getByLabelText('article 검색어'), '연합뉴스');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));

    // 제목이 그대로 보이고, 같은 행에 '삽입' 버튼이 있다(깔끔한 행 디자인).
    await screen.findByText('연합뉴스 속보 테스트');
    await userEvent.click(screen.getByRole('button', { name: '삽입' }));

    await waitFor(() => expect(container.querySelector('[data-embed-type="article"]')).toBeTruthy());
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

// 공통정보 확장 — 공동작성/지역/속성/키워드(text) + 내부/외부코멘트(textarea) + 첨부/자료파일(file upload).
describe('WriterPage — 공통정보 확장 입력(공동작성/지역/속성/키워드/코멘트)', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  const LABELS = ['공동작성', '지역', '속성', '키워드', '내부코멘트', '외부코멘트'];

  it('새 공통정보 입력란이 모두 라벨로 노출된다', () => {
    setup({ identity: { role: 'R' } });
    for (const label of LABELS) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('내용(content) 별도 입력란은 추가하지 않는다(본문 에디터가 내용)', () => {
    setup({ identity: { role: 'R' } });
    expect(screen.queryByLabelText('내용')).toBeNull();
  });

  it('입력 변경이 dto(저장)에 반영된다(coAuthor/region/attribute/keyword/comments)', async () => {
    const { model } = setup({ identity: { role: 'R' } });
    const save = vi.spyOn(model, 'saveArticle');

    await userEvent.type(screen.getByLabelText('공동작성'), '박기자');
    await userEvent.type(screen.getByLabelText('지역'), '서울');
    await userEvent.type(screen.getByLabelText('속성'), '단독');
    await userEvent.type(screen.getByLabelText('키워드'), 'kw');
    await userEvent.type(screen.getByLabelText('내부코멘트'), '내부');
    await userEvent.type(screen.getByLabelText('외부코멘트'), '외부');

    // 제목을 넣고 송고(신규 → POST 저장) → dto 검사.
    await userEvent.type(screen.getByLabelText('작성자'), '김기자'); // 무관 필드(아무 입력)
    // 신규 빈 탭은 제목이 본문 첫 줄에서 나온다 → 제목 필드만 채워도 통과하도록 본문 대신 제목 필드 사용 불가.
    // 대신 송고가 아닌 저장 경로를 직접 타기 위해 보류(신규는 전이 없이 RDS 저장)로 dto를 만든다.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // 신규 보류는 제목(첫 줄) 필요 — 제목 필드를 채워 가드를 통과시킨다(send/hold 가드 수정 후 동작).
    // title 필드는 별도 입력란이 없으므로 본문 에디터 첫 줄로 제목을 만든다.
    const editor = screen.getByRole('textbox', { name: '본문' });
    editor.focus();
    await userEvent.type(editor, '제목줄');
    await userEvent.click(actionBtn('보류'));

    await waitFor(() => expect(save).toHaveBeenCalled());
    const dto = save.mock.calls[save.mock.calls.length - 1][0];
    expect(dto).toMatchObject({
      coAuthor: '박기자', region: '서울', attribute: '단독', keyword: 'kw',
      internalComment: '내부', externalComment: '외부',
    });
  });

  it('편집 진입 시 저장된 공통정보 확장 필드가 입력란에 로드된다', async () => {
    setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'RDS' }, mode: 'edit' },
      seed: {
        articles: [{
          articleId: 'AKR1', title: '제목', status: 'RDS', lockYN: 'Y', markupVersion: '제목\n본문',
          coAuthor: '공동기자', region: '대전', attribute: '기획', keyword: '키워드값',
          internalComment: '내부메모', externalComment: '외부메모',
        }],
      },
    });
    await waitFor(() => expect(screen.getByLabelText('공동작성')).toHaveValue('공동기자'));
    expect(screen.getByLabelText('지역')).toHaveValue('대전');
    expect(screen.getByLabelText('속성')).toHaveValue('기획');
    expect(screen.getByLabelText('키워드')).toHaveValue('키워드값');
    expect(screen.getByLabelText('내부코멘트')).toHaveValue('내부메모');
    expect(screen.getByLabelText('외부코멘트')).toHaveValue('외부메모');
  });

  it('매핑 모드에서는 새 공통정보 입력란이 readOnly로 잠긴다', async () => {
    setup({
      identity: { role: 'D' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'DPS' }, mode: 'mapping' },
      seed: { articles: [{ articleId: 'AKR1', title: '제목', status: 'DPS', lockYN: 'Y', markupVersion: '제목\n본문', coAuthor: '공동기자' }] },
    });
    await waitFor(() => expect(screen.getByLabelText('공동작성')).toBeInTheDocument());
    for (const label of LABELS) {
      expect(screen.getByLabelText(label)).toHaveAttribute('readonly');
    }
  });
});

// 첨부파일/자료파일 — 실제 파일 업로드(model.uploadFile, ADR-003). 반환 path를 dto에 보관한다.
describe('WriterPage — 첨부파일/자료파일 업로드', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  const file = (name) => new File(['x'], name, { type: 'application/pdf' });

  it('첨부파일 선택 시 model.uploadFile를 호출하고 반환 path를 dto에 싣는다', async () => {
    const { model } = setup({ identity: { role: 'R' } });
    const upload = vi.spyOn(model, 'uploadFile');
    const save = vi.spyOn(model, 'saveArticle');

    const input = screen.getByLabelText('첨부파일');
    await userEvent.upload(input, file('a.pdf'));
    await waitFor(() => expect(upload).toHaveBeenCalled());

    // 본문 제목 + 보류로 dto 저장.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const editor = screen.getByRole('textbox', { name: '본문' });
    editor.focus();
    await userEvent.type(editor, '제목줄');
    await userEvent.click(actionBtn('보류'));

    await waitFor(() => expect(save).toHaveBeenCalled());
    const dto = save.mock.calls[save.mock.calls.length - 1][0];
    expect(dto.attachmentFile).toBe('/uploads/fake-a.pdf');
  });

  it('자료파일 선택 시 model.uploadFile를 호출하고 반환 path를 dto에 싣는다', async () => {
    const { model } = setup({ identity: { role: 'R' } });
    const upload = vi.spyOn(model, 'uploadFile');
    const save = vi.spyOn(model, 'saveArticle');

    const input = screen.getByLabelText('자료파일');
    await userEvent.upload(input, file('r.docx'));
    await waitFor(() => expect(upload).toHaveBeenCalled());

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const editor = screen.getByRole('textbox', { name: '본문' });
    editor.focus();
    await userEvent.type(editor, '제목줄');
    await userEvent.click(actionBtn('보류'));

    await waitFor(() => expect(save).toHaveBeenCalled());
    const dto = save.mock.calls[save.mock.calls.length - 1][0];
    expect(dto.referenceFile).toBe('/uploads/fake-r.docx');
  });

  it('편집 진입 시 저장된 첨부/자료파일 path가 표시된다', async () => {
    setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'RDS' }, mode: 'edit' },
      seed: {
        articles: [{
          articleId: 'AKR1', title: '제목', status: 'RDS', lockYN: 'Y', markupVersion: '제목\n본문',
          attachmentFile: '/uploads/stored-a.pdf', referenceFile: '/uploads/stored-r.docx',
        }],
      },
    });
    await waitFor(() => expect(screen.getByText('/uploads/stored-a.pdf')).toBeInTheDocument());
    expect(screen.getByText('/uploads/stored-r.docx')).toBeInTheDocument();
  });

  it('매핑 모드에서는 첨부/자료파일 입력이 disabled로 잠긴다', async () => {
    setup({
      identity: { role: 'D' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'DPS' }, mode: 'mapping' },
      seed: { articles: [{ articleId: 'AKR1', title: '제목', status: 'DPS', lockYN: 'Y', markupVersion: '제목\n본문' }] },
    });
    await waitFor(() => expect(screen.getByLabelText('첨부파일')).toBeInTheDocument());
    expect(screen.getByLabelText('첨부파일')).toBeDisabled();
    expect(screen.getByLabelText('자료파일')).toBeDisabled();
  });
});

// 본문 개행 직렬화 버그 수정: 빈 새 기사에서 여러 줄 입력 후 Alt+Y를 눌러도 줄이 한 줄로 합쳐지지 않는다.
describe('WriterPage — 본문 개행 보존(여러 줄 입력 + Alt+Y)', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  const editor = (container) => container.querySelector('.yh-editor');
  const editorLines = (container) => Array.from(
    container.querySelectorAll('.yh-editor .yh-editor__line'),
  ).map((el) => el.textContent);

  // 캐럿을 lineIndex번째 라인의 텍스트 끝(텍스트노드 offset)에 둔다 — Enter 정확 분할용.
  function caretAtLineTextEnd(container, lineIndex) {
    const el = container.querySelectorAll('.yh-editor__line')[lineIndex];
    const tnode = el.firstChild;
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    if (tnode && tnode.nodeType === 3) range.setStart(tnode, tnode.textContent.length);
    else { range.selectNodeContents(el); range.collapse(false); }
    range.collapse(true);
    sel.addRange(range);
  }

  it('빈 본문에 "줄1 ⏎ 줄2 ⏎ 줄3" 입력 후 Alt+Y → 줄1\\n줄2\\n줄3\\n(끝)로 보존(합쳐지지 않음)', async () => {
    const { container } = setup({ identity: { role: 'R' } }); // 신규 빈 탭(body 없음)

    // 1) "줄1" 입력 모사 — 빈 에디터엔 라인 div가 없으므로 bare 텍스트노드로 넣고 input.
    editor(container).textContent = '줄1';
    fireEvent.input(editor(container));
    // 2) Enter — 라인 래퍼가 없어 캐럿 null → 끝에 빈 줄 추가 후 remount(라인 div 2개).
    fireEvent.keyDown(editor(container), { key: 'Enter' });
    await waitFor(() => expect(editorLines(container)).toEqual(['줄1', '']));

    // 3) 둘째 줄에 "줄2" 입력 + 줄 끝 캐럿 → Enter.
    container.querySelectorAll('.yh-editor__line')[1].textContent = '줄2';
    fireEvent.input(editor(container));
    caretAtLineTextEnd(container, 1);
    fireEvent.keyDown(editor(container), { key: 'Enter' });
    await waitFor(() => expect(editorLines(container)).toEqual(['줄1', '줄2', '']));

    // 4) 셋째 줄에 "줄3" 입력.
    container.querySelectorAll('.yh-editor__line')[2].textContent = '줄3';
    fireEvent.input(editor(container));
    await waitFor(() => expect(editorLines(container)).toEqual(['줄1', '줄2', '줄3']));

    // 5) Alt+Y → "(끝)"이 마지막 줄로 추가되고, 앞 줄들은 그대로 보존.
    fireEvent.keyDown(editor(container), { key: 'y', altKey: true });
    await waitFor(() => expect(editorLines(container)).toEqual(['줄1', '줄2', '줄3', '(끝)']));
  });
});

// Step 1(9-editor-text-transforms): (끝)/(계속)/대소문자 메뉴·단축키 결선.
describe('WriterPage — 텍스트 변환/마커 결선(EditorMenuBar·Ctrl+Y)', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  function caretAtLine(container, lineIndex) {
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(lineEls[lineIndex]);
    range.collapse(true);
    sel.addRange(range);
  }

  const editorLines = (container) => Array.from(
    container.querySelectorAll('.yh-editor .yh-editor__line'),
  ).map((el) => el.textContent);

  // 마지막 캐럿(lastCaretRef)을 lineIndex 줄로 갱신(keyUp→onCaretChange — 검색패널 클릭 전 상태와 동일 경로).
  function focusCaretAtLine(container, lineIndex) {
    caretAtLine(container, lineIndex);
    fireEvent.keyUp(container.querySelector('.yh-editor'));
  }

  async function openWith(blocks, { mode = 'edit', status = 'RDS', role = 'R' } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status }, mode },
      seed: { articles: [{ articleId: 'AKR1', status, lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  it("보기>'대문자로 바꾸기'(view.toUpper) 클릭 시 캐럿 줄 텍스트가 대문자로 바뀐다", async () => {
    const { container } = await openWith([textBlock('title abc'), textBlock('body def')]);
    focusCaretAtLine(container, 0);

    await userEvent.click(screen.getByRole('menuitem', { name: '보기' }));
    await userEvent.click(screen.getByText('대문자로 바꾸기'));

    await waitFor(() => expect(editorLines(container)[0]).toBe('TITLE ABC'));
    expect(editorLines(container)[1]).toBe('body def'); // 다른 줄 불변
  });

  it('Ctrl+Y keydown 시 본문에 "(계속)"이 삽입되고 preventDefault된다', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);

    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: 'y', ctrlKey: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(spy).toHaveBeenCalled(); // 브라우저 redo 가로채기
    await waitFor(() => expect(editorLines(container)).toContain('(계속)'));
  });

  it('Alt+Y는 여전히 "(끝)"을 삽입한다(회귀 없음)', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'y', altKey: true });
    await waitFor(() => expect(editorLines(container)).toContain('(끝)'));
  });

  it("편집>'(끝)삽입'(edit.insertEnd) 메뉴 클릭도 (끝)을 삽입한다(키보드와 공용 핸들러)", async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    await userEvent.click(screen.getByText('(끝)삽입'));
    await waitFor(() => expect(editorLines(container)).toContain('(끝)'));
  });

  it("편집>'(계속)삽입'(edit.insertContinue) 메뉴 클릭 시 캐럿 줄 다음에 (계속)이 삽입된다", async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 0); // 헤드 줄

    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    await userEvent.click(screen.getByText('(계속)삽입'));

    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '(계속)', '본문']));
  });

  it('활성 항목 외(표 삽입·잘라내기)는 여전히 비활성이다', async () => {
    // 14-editor-find-context step2에서 '찾기/바꾸기'(edit.findReplace)가 결선돼 활성이 됐으므로,
    // 미결선 예시는 여전히 비활성인 '잘라내기'(edit.cut)로 검증한다(표 삽입은 그대로).
    await openWith([textBlock('헤드'), textBlock('본문')]);
    // 드롭다운으로 스코프(툴바에도 같은 라벨 버튼이 있어 메뉴 항목만 본다).
    await userEvent.click(screen.getByRole('menuitem', { name: '표' }));
    expect(within(screen.getByTestId('menu-표')).getByText('표 삽입').closest('button')).toBeDisabled();
    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    expect(within(screen.getByTestId('menu-편집')).getByText('잘라내기').closest('button')).toBeDisabled();
  });

  it('Ctrl+D 라인 삭제는 회귀 없이 동작한다(Ctrl+Y 분기 추가 무영향)', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문'), textBlock('다음')]);
    focusCaretAtLine(container, 1); // 본문 줄
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'd', ctrlKey: true });
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '다음']));
  });

  it('매핑 모드에서는 메뉴 항목 클릭이 본문을 바꾸지 않는다(텍스트 잠금 가드)', async () => {
    const { container } = await openWith(
      [textBlock('title abc'), textBlock('본문')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    focusCaretAtLine(container, 0);

    await userEvent.click(screen.getByRole('menuitem', { name: '보기' }));
    await userEvent.click(screen.getByText('대문자로 바꾸기'));

    // 매핑은 본문-only 불변식 — 대문자 변환이 적용되지 않는다.
    expect(editorLines(container)[0]).toBe('title abc');
  });
});

// Step 1(11-editor-color-prefs): 색상 환경설정 모달 결선(도움말>환경설정) + 적용/취소 + 배경 + 마운트 영속 적용.
// editorPrefs(localStorage) + editorColoring(module 상태)을 쓰므로 localStorage.clear()(마운트 effect 오염 차단) +
// resetEditorColors()(module 상태 복원)로 격리한다.
describe('WriterPage — 색상 환경설정(EditorPrefsDialog) 결선·적용', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { resetEditorColors(); });

  // 도움말 메뉴를 열고 '환경설정' 항목을 클릭한다.
  async function openPrefsViaMenu() {
    await userEvent.click(screen.getByRole('menuitem', { name: '도움말' }));
    await userEvent.click(screen.getByText('환경설정'));
  }

  async function openWith(blocks, { mode = 'edit', status = 'RDS', role = 'R' } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status }, mode },
      seed: { articles: [{ articleId: 'AKR1', status, lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  it('도움말>환경설정 클릭 시 EditorPrefsDialog가 열린다', async () => {
    setup({ identity: { role: 'R' } });
    expect(screen.queryByTestId('pref-color-title')).toBeNull();
    await openPrefsViaMenu();
    expect(screen.getByTestId('pref-color-title')).toBeInTheDocument();
  });

  it('매핑 모드에서도 환경설정이 열린다(매핑 가드 이전 처리 — 죽은 버튼 아님)', async () => {
    await openWith([textBlock('제목'), textBlock('본문')], { mode: 'mapping', status: 'DPS', role: 'D' });
    await openPrefsViaMenu();
    expect(screen.getByTestId('pref-color-title')).toBeInTheDocument();
  });

  it('편집 화면 배경(editor-canvas)이 저장된 바탕색을 반영한다', () => {
    saveEditorPrefs({ ...loadEditorPrefs(), colors: { ...loadEditorPrefs().colors, background: '#123456' } });
    const { getByTestId } = setup({ identity: { role: 'R' } });
    expect(getByTestId('editor-canvas')).toHaveStyle({ backgroundColor: '#123456' });
  });

  it('마운트 시 저장된 텍스트 색이 setEditorColors로 적용된다(colorForRole 저장색 반환)', () => {
    saveEditorPrefs({ ...loadEditorPrefs(), colors: { ...loadEditorPrefs().colors, subtitle: '#0000ff' } });
    setup({ identity: { role: 'R' } });
    expect(colorForRole('subtitle')).toBe('#0000ff');
  });

  it("부제목 색을 바꿔 '적용'하면 저장·module색·부제 줄 색이 새 값으로 반영된다(remount 없이)", async () => {
    const { container } = await openWith([textBlock('제목'), textBlock('부제')]);
    const editorBefore = container.querySelector('.yh-editor');
    const subtitleLine = () => Array.from(container.querySelectorAll('.yh-editor__line'))
      .find((el) => el.getAttribute('data-role') === 'subtitle');
    expect(subtitleLine().style.color).not.toBe('rgb(0, 255, 0)');

    await openPrefsViaMenu();
    fireEvent.change(screen.getByTestId('pref-color-subtitle'), { target: { value: '#00ff00' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    // 영속 + module 색 + 부제 줄 색이 새 값.
    await waitFor(() => expect(loadEditorPrefs().colors.subtitle).toBe('#00ff00'));
    expect(colorForRole('subtitle')).toBe('#00ff00');
    await waitFor(() => expect(subtitleLine().style.color).toBe('rgb(0, 255, 0)'));
    // 자연 재렌더 — Editor 노드는 그대로(색 반영을 위한 강제 remount/key 변경 없음).
    expect(container.querySelector('.yh-editor')).toBe(editorBefore);
    // 모달은 닫힘.
    expect(screen.queryByTestId('pref-color-subtitle')).toBeNull();
  });

  it("'취소' 시 저장·module색·배경 모두 불변이다", async () => {
    saveEditorPrefs({ ...loadEditorPrefs(), colors: { ...loadEditorPrefs().colors, background: '#abcdef' } });
    const { getByTestId } = setup({ identity: { role: 'R' } });
    await openPrefsViaMenu();
    fireEvent.change(screen.getByTestId('pref-color-subtitle'), { target: { value: '#00ff00' } });
    fireEvent.change(screen.getByTestId('pref-color-background'), { target: { value: '#111111' } });
    fireEvent.click(screen.getByTestId('prefs-cancel'));

    expect(loadEditorPrefs().colors.subtitle).toBe(DEFAULT_EDITOR_PREFS.colors.subtitle);
    expect(colorForRole('subtitle')).toBe(DEFAULT_EDITOR_PREFS.colors.subtitle);
    expect(getByTestId('editor-canvas')).toHaveStyle({ backgroundColor: '#abcdef' }); // 배경 불변
    expect(screen.queryByTestId('pref-color-subtitle')).toBeNull();
  });
});

// Step 4(16-editor-prefs-remaining): 편집>컬럼제한(edit.columnLimit) effect를 WriterPage 캔버스 래퍼(editor-canvas)
// 레벨에서 좌우 padding 10%로 적용(editorBg 패턴 — 마운트 적용 + onPrefsClose(applied) 게이트). Editor.jsx 무변경.
describe('WriterPage — 편집>컬럼제한(editor-canvas 좌우 여백) 적용', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { resetEditorColors(); });

  // 편집 탭의 columnLimit만 저장(다른 카테고리는 기본값 유지).
  const saveColumnLimit = (columnLimit) => saveEditorPrefs({
    ...loadEditorPrefs(),
    edit: { ...loadEditorPrefs().edit, columnLimit },
  });

  async function openPrefsViaMenu() {
    await userEvent.click(screen.getByRole('menuitem', { name: '도움말' }));
    await userEvent.click(screen.getByText('환경설정'));
  }

  it('columnLimit=true로 저장된 상태로 렌더하면 editor-canvas가 좌우 여백 10%를 반영한다', () => {
    saveColumnLimit(true);
    const { getByTestId } = setup({ identity: { role: 'R' } });
    expect(getByTestId('editor-canvas')).toHaveStyle({ paddingLeft: '10%', paddingRight: '10%' });
  });

  it('columnLimit=false(기본)면 좌우 여백이 적용되지 않는다(padding 없음)', () => {
    saveColumnLimit(false);
    const { getByTestId } = setup({ identity: { role: 'R' } });
    const canvas = getByTestId('editor-canvas');
    expect(canvas.style.paddingLeft).toBe('');
    expect(canvas.style.paddingRight).toBe('');
  });

  it('컬럼제한은 배경색(editorBg) 적용과 무관하게 함께 동작한다(배경 회귀 없음)', () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      colors: { ...loadEditorPrefs().colors, background: '#123456' },
      edit: { ...loadEditorPrefs().edit, columnLimit: true },
    });
    const { getByTestId } = setup({ identity: { role: 'R' } });
    const canvas = getByTestId('editor-canvas');
    expect(canvas).toHaveStyle({ backgroundColor: '#123456' });
    expect(canvas).toHaveStyle({ paddingLeft: '10%', paddingRight: '10%' });
  });

  it("편집 탭에서 컬럼제한을 켜고 '적용'하면 editor-canvas 좌우 여백이 반영된다", async () => {
    setup({ identity: { role: 'R' } });
    expect(screen.getByTestId('editor-canvas').style.paddingLeft).toBe(''); // 적용 전 여백 없음

    await openPrefsViaMenu();
    await userEvent.click(screen.getByTestId('prefs-tab-edit'));
    fireEvent.click(screen.getByTestId('pref-edit-columnLimit'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    await waitFor(() => expect(loadEditorPrefs().edit.columnLimit).toBe(true));
    await waitFor(() => expect(screen.getByTestId('editor-canvas')).toHaveStyle({ paddingLeft: '10%', paddingRight: '10%' }));
  });

  it("'취소' 시 컬럼제한 적용이 바뀌지 않는다(editorBg 게이트와 동일 — 적용 시에만 갱신)", async () => {
    setup({ identity: { role: 'R' } });
    await openPrefsViaMenu();
    await userEvent.click(screen.getByTestId('prefs-tab-edit'));
    fireEvent.click(screen.getByTestId('pref-edit-columnLimit'));
    fireEvent.click(screen.getByTestId('prefs-cancel'));

    expect(loadEditorPrefs().edit.columnLimit).toBe(false); // 저장 불변
    expect(screen.getByTestId('editor-canvas').style.paddingLeft).toBe(''); // 여백 불변
  });
});

// Step 1(13-editor-autosave): 자동저장 타이머(간격마다 활성 탭 초안 스냅샷) + 파일>복구 + 송고/저장 후 초안 무효화.
// editorPrefs(localStorage 자동저장 설정) + editorDraft(localStorage 초안)를 쓰므로 localStorage.clear()로 격리한다.
describe('WriterPage — 자동저장 타이머 + 파일>복구', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  // localStorage 초안 저장소(yh.editorDrafts) 원본을 파싱한다(키를 모르는 신규 탭 초안 검증용).
  const readDraftsStore = () => {
    try { return JSON.parse(localStorage.getItem('yh.editorDrafts')) || {}; }
    catch { return {}; }
  };

  const editorLines = (container) => Array.from(
    container.querySelectorAll('.yh-editor .yh-editor__line'),
  ).map((el) => el.textContent);

  // 자동저장 설정을 저장값으로 미리 심는다(마운트 시 useState 초기화가 이 값을 읽는다).
  const enableAutosave = (over = {}) => saveEditorPrefs({
    ...loadEditorPrefs(),
    autosave: { enabled: true, intervalSec: 30, retentionDays: 1, ...over },
  });

  it('자동저장이 켜져 있으면 간격마다 활성 탭 내용을 초안으로 저장한다', () => {
    enableAutosave();
    vi.useFakeTimers();
    const { container } = setup({ identity: { role: 'R' } }); // 신규 빈 탭
    const editor = container.querySelector('.yh-editor');
    editor.textContent = '자동저장본문';
    fireEvent.input(editor);

    expect(Object.keys(readDraftsStore())).toHaveLength(0); // 간격 전에는 저장 없음
    vi.advanceTimersByTime(30000);

    const store = readDraftsStore();
    const keys = Object.keys(store);
    expect(keys).toHaveLength(1); // 활성 탭 1개의 키로 초안 저장
    const draft = store[keys[0]].data;
    expect(blocksToText(deserialize(draft.body))).toContain('자동저장본문');
  });

  it('본문을 여러 번 바꿔도 저장된 초안은 초기값이 아니라 최신 본문이다(activeTabRef 미러)', () => {
    enableAutosave();
    vi.useFakeTimers();
    const { container } = setup({ identity: { role: 'R' } });
    const editor = container.querySelector('.yh-editor');

    editor.textContent = '첫번째본문';
    fireEvent.input(editor);
    editor.textContent = '두번째최신본문';
    fireEvent.input(editor);

    vi.advanceTimersByTime(30000);

    const store = readDraftsStore();
    const text = blocksToText(deserialize(store[Object.keys(store)[0]].data.body));
    expect(text).toContain('두번째최신본문');
    expect(text).not.toContain('첫번째본문');
  });

  it('자동저장이 꺼져 있으면 타이머가 진행돼도 초안을 저장하지 않는다', () => {
    enableAutosave({ enabled: false });
    vi.useFakeTimers();
    const { container } = setup({ identity: { role: 'R' } });
    const editor = container.querySelector('.yh-editor');
    editor.textContent = '본문';
    fireEvent.input(editor);

    vi.advanceTimersByTime(30000 * 5);
    expect(Object.keys(readDraftsStore())).toHaveLength(0);
  });

  it('본문/제목이 빈 탭은 간격이 지나도 스냅샷하지 않는다', () => {
    enableAutosave();
    vi.useFakeTimers();
    setup({ identity: { role: 'R' } }); // 빈 새 기사 탭(본문/제목 없음)

    vi.advanceTimersByTime(30000);
    expect(Object.keys(readDraftsStore())).toHaveLength(0);
  });

  it('unmount 시 자동저장 타이머를 정리한다(clearInterval — 누수 없음)', () => {
    enableAutosave();
    vi.useFakeTimers();
    const { container, unmount } = setup({ identity: { role: 'R' } });
    const editor = container.querySelector('.yh-editor');
    editor.textContent = '본문';
    fireEvent.input(editor);

    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    unmount();
    expect(clearSpy).toHaveBeenCalled();

    localStorage.clear();
    vi.advanceTimersByTime(30000 * 3); // unmount 후엔 더 이상 저장하지 않는다
    expect(Object.keys(readDraftsStore())).toHaveLength(0);
  });

  // 본문(markupVersion)을 가진 기사로 편집 진입한 WriterPage를 띄운다(키=articleId로 안정적 복구 검증).
  async function openEdit(blocks, { articleId = 'AKR1', status = 'RDS', role = 'R' } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId, title: '제목', status }, mode: 'edit' },
      seed: { articles: [{ articleId, status, lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  // 파일>복구 클릭. 메뉴는 항목 선택 후에도 열린 채 유지되므로(EditorMenuBar 규약), 이미 열려 있으면
  // '파일'을 다시 누르지 않는다(다시 누르면 토글로 닫힌다). 재복구(연속 호출)에서도 안전하게 동작한다.
  async function clickRecover() {
    if (!screen.queryByTestId('menu-파일')) {
      await userEvent.click(screen.getByRole('menuitem', { name: '파일' }));
    }
    await userEvent.click(within(screen.getByTestId('menu-파일')).getByText('복구'));
  }

  it('파일>복구: 초안이 있으면 confirm 후 본문/필드를 초안 값으로 복원하고 초안을 제거한다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const draftBody = serialize([textBlock('복구된제목'), textBlock('복구된본문')]);
    saveDraft('AKR1', { title: '복구된제목', body: draftBody, author: '초안작성자' }, 1000);

    const { container } = await openEdit([textBlock('원본제목'), textBlock('원본본문')]);
    expect(editorLines(container)).toEqual(['원본제목', '원본본문']); // 복구 전 — 원본

    await clickRecover();

    await waitFor(() => expect(editorLines(container)).toEqual(['복구된제목', '복구된본문']));
    expect(screen.getByLabelText('작성자')).toHaveValue('초안작성자');
    expect(loadDraft('AKR1')).toBeNull(); // 복구 후 초안 제거(재복구 부활 방지)

    // 재복구 시도 — 초안이 없으므로 alert.
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    await clickRecover();
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('없습니다'));
  });

  it('파일>복구: 초안이 없으면 alert만 띄우고 본문을 바꾸지 않는다', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { container } = await openEdit([textBlock('원본제목'), textBlock('원본본문')]);

    await clickRecover();

    expect(alert).toHaveBeenCalledWith(expect.stringContaining('복구할 자동저장 내용이 없습니다'));
    expect(editorLines(container)).toEqual(['원본제목', '원본본문']);
  });

  it('파일>복구: confirm 취소 시 본문을 복원하지 않고 초안도 유지한다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const draftBody = serialize([textBlock('복구된제목'), textBlock('복구된본문')]);
    saveDraft('AKR1', { title: '복구된제목', body: draftBody }, 1000);

    const { container } = await openEdit([textBlock('원본제목'), textBlock('원본본문')]);
    await clickRecover();

    expect(editorLines(container)).toEqual(['원본제목', '원본본문']); // 무변경
    expect(loadDraft('AKR1')).not.toBeNull(); // 초안 유지(취소 → 제거 안 함)
  });

  it('송고가 성공하면 해당 탭 키의 초안이 무효화된다(빈 새 기사 탭 부활 방지)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const body = serialize([textBlock('헤드'), textBlock('본문'), textBlock('(끝)')]);
    saveDraft('AKR1', { title: '헤드', body }, 1000);
    const { model } = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '헤드', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(actionBtn('송고')).toBeInTheDocument());
    const apply = vi.spyOn(model, 'applyAction');

    await userEvent.click(actionBtn('송고'));

    await waitFor(() => expect(apply).toHaveBeenCalledWith('AKR1', 'send'));
    await waitFor(() => expect(loadDraft('AKR1')).toBeNull());
  });

  it('매핑 저장이 성공하면 해당 탭 키의 초안이 무효화된다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const body = serialize([textBlock('제목'), textBlock('본문')]);
    saveDraft('AKR9', { title: '제목', body }, 1000);
    const { model } = setup({
      identity: { role: 'D', name: '김기자' },
      pendingEdit: { article: { articleId: 'AKR9', title: '제목', status: 'DPS' }, mode: 'mapping' },
      seed: { articles: [{ articleId: 'AKR9', status: 'DPS', lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(actionBtn('저장')).toBeInTheDocument());
    const save = vi.spyOn(model, 'saveArticle');

    await userEvent.click(actionBtn('저장'));

    await waitFor(() => expect(save).toHaveBeenCalled());
    await waitFor(() => expect(loadDraft('AKR9')).toBeNull());
  });
});

// Step 2(14-editor-find-context): 찾기/바꾸기(Ctrl+F·편집 메뉴) + 전체 선택 결선.
// Step 0 엔진(editorFind) + Step 1 다이얼로그(FindReplaceDialog)를 WriterPage 안전 본문 경로에 연결.
describe('WriterPage — 찾기/바꾸기 + 전체 선택 결선(editorFind·FindReplaceDialog)', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  async function openWith(blocks, { mode = 'edit', status = 'RDS', role = 'R' } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status }, mode },
      seed: { articles: [{ articleId: 'AKR1', status, lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  // 다이얼로그 자체(role=dialog '찾기/바꾸기')만 본다(메뉴 라벨 '찾기/바꾸기'와 혼동 방지).
  const findDialog = () => screen.queryByRole('dialog', { name: '찾기/바꾸기' });

  it('Ctrl+F keydown 시 찾기/바꾸기 다이얼로그가 열리고 preventDefault된다', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    expect(findDialog()).toBeNull();

    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: 'f', ctrlKey: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(spy).toHaveBeenCalled(); // 브라우저 기본 찾기 가로채기
    await waitFor(() => expect(findDialog()).toBeInTheDocument());
  });

  it("편집 메뉴 '찾기/바꾸기'(edit.findReplace) 클릭 시 다이얼로그가 열린다", async () => {
    await openWith([textBlock('헤드'), textBlock('본문')]);
    expect(findDialog()).toBeNull();

    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    // 편집 드롭다운 안의 항목만 본다(다이얼로그 라벨과 분리).
    await userEvent.click(within(screen.getByTestId('menu-편집')).getByText('찾기/바꾸기'));

    await waitFor(() => expect(findDialog()).toBeInTheDocument());
  });

  it("편집 메뉴 '찾기/바꾸기'·'전체 선택'이 활성(enabled)이다", async () => {
    await openWith([textBlock('헤드'), textBlock('본문')]);
    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    const menu = screen.getByTestId('menu-편집');
    expect(within(menu).getByText('찾기/바꾸기').closest('button')).toBeEnabled();
    expect(within(menu).getByText('전체 선택').closest('button')).toBeEnabled();
  });

  it("활성 항목 외(잘라내기·표 삽입)는 여전히 비활성이다(회귀)", async () => {
    await openWith([textBlock('헤드'), textBlock('본문')]);
    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    expect(within(screen.getByTestId('menu-편집')).getByText('잘라내기').closest('button')).toBeDisabled();
    await userEvent.click(screen.getByRole('menuitem', { name: '표' }));
    expect(within(screen.getByTestId('menu-표')).getByText('표 삽입').closest('button')).toBeDisabled();
  });

  // 다이얼로그에서 찾을 내용 입력 → 직렬화 본문 검증을 위해 updateField 경유 body를 saveArticle dto로 확인한다.
  // body를 직접 못 보므로, 모두 바꾸기 후 저장(보류)으로 PUT된 markupVersion을 deserialize해 검증한다.
  it("find-query='foo' + 모두 바꾸기('X') → 본문 모든 'foo'가 'X'로 바뀐다(임베드 불변)", async () => {
    const { container } = await openWith([
      textBlock('foo bar'),
      embedBlock({ embedType: 'image', src: 'x.png' }),
      textBlock('foo baz foo'),
    ]);

    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'f', ctrlKey: true }));
    await waitFor(() => expect(findDialog()).toBeInTheDocument());

    await userEvent.type(screen.getByTestId('find-query'), 'foo');
    await userEvent.type(screen.getByTestId('find-replacement'), 'X');
    await userEvent.click(screen.getByTestId('find-replace-all'));

    // 본문 텍스트 라인의 모든 foo가 X로 바뀐다(blocksToText 기준).
    await waitFor(() => {
      const lines = Array.from(container.querySelectorAll('.yh-editor .yh-editor__line')).map((el) => el.textContent);
      expect(lines).toEqual(['X bar', 'X baz X']);
    });
    // 임베드는 위치·내용 불변(이미지 1개 그대로).
    expect(container.querySelectorAll('[data-embed-type="image"]').length).toBe(1);
  });

  it("'바꾸기'(replaceOne)는 첫 매치만 치환한다", async () => {
    const { container } = await openWith([textBlock('foo and foo')]);

    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'f', ctrlKey: true }));
    await waitFor(() => expect(findDialog()).toBeInTheDocument());

    await userEvent.type(screen.getByTestId('find-query'), 'foo');
    await userEvent.type(screen.getByTestId('find-replacement'), 'X');
    await userEvent.click(screen.getByTestId('find-replace-one'));

    await waitFor(() => {
      const lines = Array.from(container.querySelectorAll('.yh-editor .yh-editor__line')).map((el) => el.textContent);
      expect(lines).toEqual(['X and foo']); // 첫 매치만
    });
  });

  it('빈 query로 바꾸기/모두 바꾸기 클릭 시 본문이 바뀌지 않는다(updateField 미호출)', async () => {
    const { container } = await openWith([textBlock('foo bar')]);

    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'f', ctrlKey: true }));
    await waitFor(() => expect(findDialog()).toBeInTheDocument());

    // query를 비운 채(바꿀 내용만 입력) 바꾸기/모두 바꾸기.
    await userEvent.type(screen.getByTestId('find-replacement'), 'X');
    await userEvent.click(screen.getByTestId('find-replace-one'));
    await userEvent.click(screen.getByTestId('find-replace-all'));

    // 본문 무변경.
    const lines = Array.from(container.querySelectorAll('.yh-editor .yh-editor__line')).map((el) => el.textContent);
    expect(lines).toEqual(['foo bar']);
  });

  it('매핑 모드: Ctrl+F는 다이얼로그를 열지 않고 preventDefault만 한다', async () => {
    const { container } = await openWith(
      [textBlock('foo bar')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );

    // 매핑은 onKeyDown이 Editor에 전달되지 않으므로(textEditable=false) Editor 위 Ctrl+F는 가로채지지 않는다.
    // 매핑에서 키로 다이얼로그가 열리지 않음을 확인한다(본문-only 불변식).
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'f', ctrlKey: true }));

    expect(findDialog()).toBeNull(); // 매핑은 다이얼로그 안 열림
  });

  // 보강(tester): 매핑 Ctrl+F의 핵심 불변식은 "다이얼로그 비개방"이 아니라 "본문 불변"이다.
  // WriterPage가 매핑 시 onKeyDown={undefined}로 Editor에 키 핸들러를 붙이지 않으므로(텍스트 잠금) Editor 위 Ctrl+F는
  // 부모로 전파되지 않는다 — 브라우저 기본 찾기(읽기 동작)는 본문을 바꾸지 않아 무해하다. 여기서는 매핑 중 Ctrl+F가
  // 본문(updateField('body'))을 절대 바꾸지 않음을 저장 PUT로 고정한다(다이얼로그 비개방 단언만으로는 본문 불변을 직접 보장하지 못함).
  it('매핑 모드: Ctrl+F는 본문(updateField body)을 바꾸지 않는다(저장 시 원본 PUT)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const original = serialize([textBlock('foo bar')]);
    const { container, model } = await openWith(
      [textBlock('foo bar')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    const save = vi.spyOn(model, 'saveArticle');

    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'f', ctrlKey: true }));
    expect(findDialog()).toBeNull();

    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original); // 본문 불변
  });

  it("매핑 모드: 메뉴 '찾기/바꾸기' 클릭도 다이얼로그를 열지 않고 본문(updateField)을 바꾸지 않는다", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const original = serialize([textBlock('foo bar')]);
    const { model } = await openWith(
      [textBlock('foo bar')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    const save = vi.spyOn(model, 'saveArticle');

    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    await userEvent.click(within(screen.getByTestId('menu-편집')).getByText('찾기/바꾸기'));

    expect(findDialog()).toBeNull(); // 매핑은 다이얼로그 안 열림

    // 저장 시 원본 body가 그대로 PUT된다(본문 무변경).
    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original);
  });

  it('닫기 버튼으로 다이얼로그가 닫힌다', async () => {
    const { container } = await openWith([textBlock('헤드')]);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'f', ctrlKey: true }));
    await waitFor(() => expect(findDialog()).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('find-close'));
    await waitFor(() => expect(findDialog()).toBeNull());
  });

  it('Alt+Y/(끝)·Ctrl+Y/(계속)·Ctrl+D 라인삭제는 회귀 없이 동작한다(isFindReplace 분기 추가 무영향)', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문'), textBlock('다음')]);
    const box = container.querySelector('.yh-editor');
    const editorLines = () => Array.from(container.querySelectorAll('.yh-editor .yh-editor__line')).map((el) => el.textContent);

    // Alt+Y → (끝). isFindReplace는 !altKey라 Alt+Y와 충돌하지 않는다.
    fireEvent.keyDown(box, { key: 'y', altKey: true });
    await waitFor(() => expect(editorLines()).toContain('(끝)'));
    expect(findDialog()).toBeNull(); // 찾기 다이얼로그는 안 열림
  });

  // 회귀(머지 게이트 fix): '이전 찾기'(find-prev)가 현재 활성 매치에 정체되지 않고 직전 매치로 이동해야 한다.
  // 버그: forward/backward 공통으로 fromOffset=cur.end를 써서 backward일 때 현재 매치가 start<cur.end를 항상 만족 →
  // nextMatchIndex가 자기 자신을 반환했다. 수정: backward는 fromOffset=cur.start(onReplaceOne과 일관).
  // find-status('pos/total')의 pos=activeIndex+1로 활성 인덱스를 검증한다.
  const findStatus = () => screen.getByTestId('find-status').textContent;
  it("'이전 찾기'는 직전 매치로 이동하고 처음 매치에서 누르면 마지막으로 wrap된다", async () => {
    const { container } = await openWith([textBlock('foo foo foo')]); // 매치 3개: [0,3],[4,7],[8,11]

    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'f', ctrlKey: true }));
    await waitFor(() => expect(findDialog()).toBeInTheDocument());

    await userEvent.type(screen.getByTestId('find-query'), 'foo');
    await waitFor(() => expect(findStatus()).toBe('1/3')); // activeIndex=0(첫 매치)

    // 첫 매치에서 '이전 찾기' → 마지막으로 wrap(3/3). 버그 상태였다면 1/3에 정체.
    await userEvent.click(screen.getByTestId('find-prev'));
    await waitFor(() => expect(findStatus()).toBe('3/3'));

    // 다시 '이전 찾기' → 직전 매치(2/3). 버그 상태였다면 3/3에 정체.
    await userEvent.click(screen.getByTestId('find-prev'));
    await waitFor(() => expect(findStatus()).toBe('2/3'));
  });

  it("'다음 찾기'는 회귀 없이 다음 매치로 이동하고 마지막에서 처음으로 wrap된다", async () => {
    const { container } = await openWith([textBlock('foo foo foo')]); // 매치 3개

    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'f', ctrlKey: true }));
    await waitFor(() => expect(findDialog()).toBeInTheDocument());

    await userEvent.type(screen.getByTestId('find-query'), 'foo');
    await waitFor(() => expect(findStatus()).toBe('1/3')); // activeIndex=0

    await userEvent.click(screen.getByTestId('find-next'));
    await waitFor(() => expect(findStatus()).toBe('2/3'));
    await userEvent.click(screen.getByTestId('find-next'));
    await waitFor(() => expect(findStatus()).toBe('3/3'));
    await userEvent.click(screen.getByTestId('find-next')); // 마지막 → 처음으로 wrap
    await waitFor(() => expect(findStatus()).toBe('1/3'));
  });
});

// Step 3(14-editor-find-context): 에디터 본문 우클릭 컨텍스트 메뉴(EditorContextMenu) + 바 보이기 토글 결선.
// editor-canvas 우클릭 → editor-context-menu. 활성: 찾기/바꾸기·전체 선택·보이기 토글·표준편집(비매핑).
// aux-tools 의존(기업코드변환/원본·텍스트 붙여넣기/약물입력)은 항상 비활성 placeholder. 약물바는 토글 상태만(실제 바 없음).
describe('WriterPage — 에디터 우클릭 컨텍스트 메뉴(EditorContextMenu) 결선', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  async function openWith(blocks, { mode = 'edit', status = 'RDS', role = 'R' } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status }, mode },
      seed: { articles: [{ articleId: 'AKR1', status, lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  // editor-canvas 래퍼를 우클릭(contextmenu)해 커스텀 메뉴를 띄운다. preventDefault 검증용 spy를 함께 반환.
  function rightClickCanvas(container) {
    const canvas = container.querySelector('[data-testid="editor-canvas"]');
    const ev = createEvent.contextMenu(canvas, { clientX: 50, clientY: 60 });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(canvas, ev);
    return spy;
  }

  const ctxMenu = () => screen.queryByTestId('editor-context-menu');
  const findDialog = () => screen.queryByRole('dialog', { name: '찾기/바꾸기' });
  const ctxItem = (label) => within(ctxMenu()).getByText(label).closest('button');

  it('editor-canvas 우클릭 시 editor-context-menu가 뜨고 브라우저 기본 메뉴가 막힌다(preventDefault)', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    expect(ctxMenu()).toBeNull();

    const spy = rightClickCanvas(container);

    expect(spy).toHaveBeenCalled(); // 브라우저 기본 컨텍스트 메뉴 차단
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());
    // 조회페이지 메뉴(yh-context-menu)는 뜨지 않는다.
    expect(container.querySelector('.yh-context-menu')).toBeNull();
  });

  it("컨텍스트 메뉴 '찾기/바꾸기' 클릭 시 찾기 다이얼로그가 열린다", async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());
    expect(findDialog()).toBeNull();

    await userEvent.click(ctxItem('찾기/바꾸기'));

    await waitFor(() => expect(findDialog()).toBeInTheDocument());
    expect(ctxMenu()).toBeNull(); // 선택 후 메뉴 닫힘
  });

  it("컨텍스트 메뉴 '메뉴바 보이기' 클릭 시 메뉴바가 토글된다", async () => {
    const { container, queryByTestId } = await openWith([textBlock('헤드')]);
    expect(queryByTestId('menubar')).toBeInTheDocument();

    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());
    await userEvent.click(ctxItem('메뉴바 보이기'));

    await waitFor(() => expect(queryByTestId('menubar')).toBeNull());
  });

  it("컨텍스트 메뉴 '약물바 보이기' 클릭은 에러 없이 토글 상태만 바꾼다(실제 바 없음·체크 표식 갱신)", async () => {
    const { container } = await openWith([textBlock('헤드')]);
    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());

    // 처음엔 약물바 off → aria-checked=false.
    expect(ctxItem('약물바 보이기')).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(ctxItem('약물바 보이기')); // 토글 — 에러 없이 동작
    expect(ctxMenu()).toBeNull(); // 선택 후 닫힘

    // 다시 열면 약물바 on → aria-checked=true(토글 상태 보존). 실제 약물바 컴포넌트는 렌더하지 않는다.
    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());
    expect(ctxItem('약물바 보이기')).toHaveAttribute('aria-checked', 'true');
    expect(container.querySelector('[data-testid="glyphbar"]')).toBeNull(); // 실제 바 미렌더
  });

  it('aux 항목(기업코드변환/약물입력/원본 붙여넣기/텍스트 붙여넣기)은 비활성으로 보인다', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());

    for (const label of ['기업코드변환', '약물입력', '원본 붙여넣기', '텍스트 붙여넣기']) {
      expect(ctxItem(label)).toBeDisabled();
    }
  });

  it('편집(비매핑) 모드: 잘라내기/복사/붙여넣기·찾기/바꾸기·전체 선택·보이기 토글이 활성이다', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());

    for (const label of ['잘라내기', '복사', '붙여넣기', '찾기/바꾸기', '전체 선택', '메뉴바 보이기', '툴바 보이기', '약물바 보이기']) {
      expect(ctxItem(label)).toBeEnabled();
    }
  });

  it('매핑 모드: 컨텍스트 찾기/바꾸기 클릭이 다이얼로그를 열지 않고 updateField(body)가 호출되지 않는다 + 잘라내기/붙여넣기 비활성', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const original = serialize([textBlock('foo bar')]);
    const { container, model } = await openWith(
      [textBlock('foo bar')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    const save = vi.spyOn(model, 'saveArticle');

    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());

    // 매핑: 잘라내기/붙여넣기 비활성(본문 텍스트 잠금).
    expect(ctxItem('잘라내기')).toBeDisabled();
    expect(ctxItem('붙여넣기')).toBeDisabled();

    await userEvent.click(ctxItem('찾기/바꾸기'));
    expect(findDialog()).toBeNull(); // 매핑은 다이얼로그 안 열림

    // 저장 시 원본 body가 그대로 PUT된다(updateField('body',…) 미호출 → 본문 무변경).
    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original);
  });

  it('Esc 키로 컨텍스트 메뉴가 닫힌다', async () => {
    const { container } = await openWith([textBlock('헤드')]);
    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());

    fireEvent.keyDown(ctxMenu(), { key: 'Escape' });
    await waitFor(() => expect(ctxMenu()).toBeNull());
  });

  // 보강(tester): 클립보드 항목(잘라내기/복사/붙여넣기)은 브라우저 기본 동작에 위임한다.
  // jsdom에는 document.execCommand가 없으므로(typeof undefined) 구현의 `typeof === 'function'` 가드 + try/catch가
  // 예외 없이 메뉴만 닫아야 한다. 핵심 회귀 방어: 클릭이 (1) 에러 없이 동작하고 (2) 본문(updateField('body'))을
  // 절대 바꾸지 않으며(contentEditable/블록 직접 조작 금지 — Editor.handlePaste의 (끝) 차단/이미지 임베드 경로 보호)
  // (3) 메뉴를 닫는다. 활성/비활성만 보던 기존 단언으로는 이 동작 회귀를 잡지 못한다.
  for (const label of ['복사', '잘라내기', '붙여넣기']) {
    it(`컨텍스트 메뉴 '${label}' 클릭은 에러 없이 메뉴를 닫고 본문(updateField body)을 바꾸지 않는다`, async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const original = serialize([textBlock('foo bar'), textBlock('(끝)')]);
      const { container, model } = await openWith([textBlock('foo bar'), textBlock('(끝)')]);
      const save = vi.spyOn(model, 'saveArticle');
      const linesBefore = Array.from(container.querySelectorAll('.yh-editor .yh-editor__line')).map((el) => el.textContent);

      rightClickCanvas(container);
      await waitFor(() => expect(ctxMenu()).toBeInTheDocument());

      // 클릭이 예외를 던지지 않아야 한다(jsdom: execCommand 미정의 → 가드로 no-op).
      await userEvent.click(ctxItem(label));

      // 메뉴가 닫힌다(항목 선택 → onClose).
      await waitFor(() => expect(ctxMenu()).toBeNull());

      // 본문(DOM 라인) 무변경 — 코드가 contentEditable 텍스트/블록을 직접 조작하지 않는다.
      const linesAfter = Array.from(container.querySelectorAll('.yh-editor .yh-editor__line')).map((el) => el.textContent);
      expect(linesAfter).toEqual(linesBefore);

      // 저장 시 원본 body가 그대로 PUT — updateField('body',…)가 호출되지 않았다(본문 직렬화 경로 미사용).
      await userEvent.click(actionBtn('보류'));
      await waitFor(() => expect(save).toHaveBeenCalled());
      expect(save.mock.calls[0][0].markupVersion).toBe(original);
    });
  }

  // 보강(tester): 클립보드 위임 — execCommand가 존재하는 환경(브라우저)에서는 그 명령으로 위임됨을 고정한다.
  // (구현은 에디터 root를 focus한 뒤 document.execCommand(cut|copy|paste)를 호출한다. 코드 직접 조작이 아님을 명시.)
  it('클립보드 항목은 execCommand가 존재하면 해당 명령(cut/copy/paste)으로 위임한다(직접 본문 조작 아님)', async () => {
    const { container } = await openWith([textBlock('foo bar')]);
    // jsdom에 없는 execCommand를 임시로 주입해 위임 경로를 검증한다(afterEach에서 restoreAllMocks로 정리됨).
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    try {
      rightClickCanvas(container);
      await waitFor(() => expect(ctxMenu()).toBeInTheDocument());
      await userEvent.click(ctxItem('복사'));
      expect(exec).toHaveBeenCalledWith('copy');

      rightClickCanvas(container);
      await waitFor(() => expect(ctxMenu()).toBeInTheDocument());
      await userEvent.click(ctxItem('잘라내기'));
      expect(exec).toHaveBeenCalledWith('cut');

      rightClickCanvas(container);
      await waitFor(() => expect(ctxMenu()).toBeInTheDocument());
      await userEvent.click(ctxItem('붙여넣기'));
      expect(exec).toHaveBeenCalledWith('paste');
    } finally {
      delete document.execCommand; // jsdom 기본(미정의) 상태로 되돌린다 — 다른 테스트의 가드 경로 보존.
    }
  });
});
