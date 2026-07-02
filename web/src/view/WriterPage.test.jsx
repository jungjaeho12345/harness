import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render, screen, waitFor, fireEvent, createEvent, within, act,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { WriterPage } from './WriterPage.jsx';
import { PENDING_EDIT_KEY } from '../controller/useViewController.js';
import { createFakeModel } from '../test/fakeModel.js';
import { serialize, deserialize, textBlock, embedBlock, blocksToText } from './editorContent.js';
import { loadMemo } from './memoStore.js';
import { loadAbbrevs, saveAbbrevs } from './abbrevStore.js';
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

// Ctrl+V 이미지 붙여넣기 — Editor가 raw File을 위임하면 WriterPage가 model.uploadFile로 서버 업로드하고
// 반환 path(/uploads/...)로 image 임베드를 캐럿 줄에 삽입한다(base64 미생성 — news.md 156행, ADR-003).
describe('WriterPage — Ctrl+V 이미지 붙여넣기: 업로드→경로 임베드', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

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

  it('업로드 성공 → 반환 path로 이미지 임베드가 캐럿 줄 뒤에 삽입된다(본문 텍스트 불변·base64 없음)', async () => {
    const { container, model } = await openWith([textBlock('제목'), textBlock('본문')]);
    vi.spyOn(model, 'uploadFile').mockResolvedValue({ ok: true, path: '/uploads/abc.png' });
    caretAtLine(container, 0); // 제목 줄
    const box = container.querySelector('.yh-editor');
    fireEvent(box, pasteImageEvent(box));

    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());
    expect(blockTypes(container)).toEqual(['text', 'embed', 'text', 'text']); // 제목 → [이미지] → 빈 줄 → 본문
    // 반환 path가 임베드 src로 들어가고(=업로드 경유), base64(data:)가 아니다.
    const img = container.querySelector('[data-embed-type="image"] img');
    expect(img.getAttribute('src')).toBe('/uploads/abc.png');
    expect(container.querySelector('.yh-editor img[src^="data:"]')).toBeFalsy();
    // 본문 텍스트(제목/본문)는 불변.
    const texts = Array.from(container.querySelectorAll('.yh-editor__line')).map((el) => el.textContent);
    expect(texts).toContain('제목');
    expect(texts).toContain('본문');
  });

  it('업로드 실패(too-large) → 임베드 미삽입 + window.alert + base64 없음', async () => {
    const { container, model } = await openWith([textBlock('제목'), textBlock('본문')]);
    vi.spyOn(model, 'uploadFile').mockResolvedValue({ ok: false, reason: 'too-large' });
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    caretAtLine(container, 0);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, pasteImageEvent(box));

    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(container.querySelector('[data-embed-type="image"]')).toBeFalsy(); // 미삽입
    expect(blockTypes(container)).toEqual(['text', 'text']); // 본문 불변
    expect(container.querySelector('.yh-editor img[src^="data:"]')).toBeFalsy(); // base64 폴백 없음
  });

  it('붙여넣은 이미지는 이후 타이핑(input)에도 커서 위치에 보존된다(끝으로 밀리지 않음)', async () => {
    const { container, model } = await openWith([textBlock('제목'), textBlock('본문')]);
    vi.spyOn(model, 'uploadFile').mockResolvedValue({ ok: true, path: '/uploads/abc.png' });
    caretAtLine(container, 0);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, pasteImageEvent(box));
    await waitFor(() => expect(blockTypes(container)).toEqual(['text', 'embed', 'text', 'text']));

    // 본문을 수정(input)해도 임베드는 제목과 본문 사이에 그대로 남는다.
    fireEvent.input(box);
    await waitFor(() => expect(blockTypes(container)).toEqual(['text', 'embed', 'text', 'text']));
  });

  it('매핑 모드 → 업로드 성공 임베드는 "(끝)" 앞 append로 삽입된다(parity)', async () => {
    const { container, model } = await openWith(
      [textBlock('제목'), textBlock('본문'), textBlock('(끝)')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    vi.spyOn(model, 'uploadFile').mockResolvedValue({ ok: true, path: '/uploads/map.png' });
    const box = container.querySelector('.yh-editor');
    fireEvent(box, pasteImageEvent(box));

    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());
    // 캐럿 없음 + 매핑 → "(끝)" 앞 append: 제목·본문 → [이미지] → (끝)
    expect(blockTypes(container)).toEqual(['text', 'text', 'embed', 'text']);
    expect(container.querySelector('[data-embed-type="image"] img').getAttribute('src')).toBe('/uploads/map.png');
  });

  // 업로드는 네트워크 왕복(비동기)이라 대기 창이 넓다. 대기 중 상태가 바뀌면 붙여넣기 시점의 stale body/탭
  // 클로저로 덮어써 데이터가 유실될 수 있다 — 삽입 시점 최신 body를 읽고 붙여넣은 탭과 동일할 때만 삽입한다.
  it('연속 붙여넣기: 업로드 대기 중 두 번째 붙여넣기해도 두 이미지가 모두 보존된다(stale body 덮어쓰기 방지)', async () => {
    const { container, model } = await openWith([textBlock('제목'), textBlock('본문')]);
    const resolvers = [];
    vi.spyOn(model, 'uploadFile').mockImplementation(() => new Promise((res) => { resolvers.push(res); }));
    caretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, pasteImageEvent(box)); // 업로드 A in-flight
    fireEvent(box, pasteImageEvent(box)); // 업로드 B in-flight(같은 렌더 클로저 — stale body 위험 구간)
    await waitFor(() => expect(resolvers.length).toBe(2));
    await act(async () => { resolvers[0]({ ok: true, path: '/uploads/a.png' }); });
    await act(async () => { resolvers[1]({ ok: true, path: '/uploads/b.png' }); });
    // stale body로 덮어쓰면 A가 사라져 1개만 남는다. 최신 body 위에 얹으면 둘 다 보존.
    await waitFor(() => expect(container.querySelectorAll('[data-embed-type="image"]').length).toBe(2));
    const srcs = Array.from(container.querySelectorAll('[data-embed-type="image"] img')).map((i) => i.getAttribute('src'));
    expect(srcs).toContain('/uploads/a.png');
    expect(srcs).toContain('/uploads/b.png');
  });

  it('업로드 대기 중 다른 탭으로 이동하면 새 탭 본문이 파손되지 않는다(삽입 취소 + 안내)', async () => {
    const { container, model } = await openWith([textBlock('제목'), textBlock('본문')]);
    let resolveUpload;
    vi.spyOn(model, 'uploadFile').mockImplementation(() => new Promise((res) => { resolveUpload = res; }));
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    caretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, pasteImageEvent(box)); // T0에서 업로드 in-flight
    await waitFor(() => expect(typeof resolveUpload).toBe('function'));
    // 업로드 대기 중 새 작성 탭으로 전환(addTab → 새 탭 활성). 에디터에서 이전 탭 본문('제목')이
    // 사라지면 전환 완료(빈 탭은 본문 라인이 없을 수 있으므로 라인 존재가 아니라 텍스트 부재로 확인).
    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' }));
    await waitFor(() => {
      const lines = Array.from(container.querySelectorAll('.yh-editor__line')).map((el) => el.textContent);
      expect(lines).not.toContain('제목');
    });
    await act(async () => { resolveUpload({ ok: true, path: '/uploads/x.png' }); });
    // 탭이 바뀌었으므로 삽입은 취소되고 안내만 뜬다 — 새 탭에 이미지·이전 탭 텍스트가 새지 않는다.
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(container.querySelector('[data-embed-type="image"]')).toBeFalsy();
    const texts = Array.from(container.querySelectorAll('.yh-editor__line')).map((el) => el.textContent);
    expect(texts).not.toContain('제목'); // 이전 탭(T0) 본문이 새 탭으로 새지 않음
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

  // 보강(harness-tester): 라이브 apply 경로(onPrefsClose 게이트) 회귀.
  // 컬럼제한을 다이얼로그에서 켜고 '적용'하면 좌우 여백이 붙되, 저장돼 있던 배경색(editorBg)이 캔버스에서 사라지지 않아야 한다
  // (onPrefsClose가 background와 columnLimit을 둘 다 다시 읽으므로 — 한쪽 게이트 누락 회귀를 함께 못박는다).
  it("저장된 배경색이 있는 상태에서 컬럼제한을 켜고 '적용'해도 배경색이 캔버스에 보존된다(게이트 회귀)", async () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      colors: { ...loadEditorPrefs().colors, background: '#abcdef' },
    });
    setup({ identity: { role: 'R' } });
    expect(screen.getByTestId('editor-canvas')).toHaveStyle({ backgroundColor: '#abcdef' });

    await openPrefsViaMenu();
    await userEvent.click(screen.getByTestId('prefs-tab-edit'));
    fireEvent.click(screen.getByTestId('pref-edit-columnLimit'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    await waitFor(() => expect(screen.getByTestId('editor-canvas')).toHaveStyle({ paddingLeft: '10%', paddingRight: '10%' }));
    // 배경색은 그대로 — 컬럼제한 적용이 editorBg를 떨구지 않는다.
    expect(screen.getByTestId('editor-canvas')).toHaveStyle({ backgroundColor: '#abcdef' });
  });

  // 보강(harness-tester): 다이얼로그 apply의 setEditorPref 합성 회귀 — 컬럼제한만 켜도 다른 카테고리(맞춤법·약물·날짜형식)가 보존돼야 한다.
  it('컬럼제한만 켜서 적용해도 다른 카테고리(맞춤법/약물/날짜형식) 저장값이 보존된다(합성 회귀)', async () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      dateFormat: 'YYYY.MM.DD',
      spellcheck: { ...loadEditorPrefs().spellcheck, errorStyle: 'underline' },
      glyphFavorites: { items: ['℃'] },
    });
    setup({ identity: { role: 'R' } });

    await openPrefsViaMenu();
    await userEvent.click(screen.getByTestId('prefs-tab-edit'));
    fireEvent.click(screen.getByTestId('pref-edit-columnLimit'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    await waitFor(() => expect(loadEditorPrefs().edit.columnLimit).toBe(true));
    const prefs = loadEditorPrefs();
    expect(prefs.dateFormat).toBe('YYYY.MM.DD'); // 날짜형식 보존
    expect(prefs.spellcheck.errorStyle).toBe('underline'); // 맞춤법 보존
    expect(prefs.glyphFavorites.items).toEqual(['℃']); // 약물 보존
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
// aux-tools 의존(기업코드변환/원본·텍스트 붙여넣기/약물입력)은 항상 비활성 placeholder. 약물바 토글은 실제 바(glyph-bar)를 켜고 끈다(phase17 step2 결선).
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

  it("컨텍스트 메뉴 '약물바 보이기' 클릭은 토글 상태·실제 약물바 렌더를 토글한다(체크 표식 갱신)", async () => {
    // 자주쓰는 약물을 시드해 토글 ON 시 실제 바(glyph-bar)가 버튼과 함께 렌더됨을 검증한다.
    localStorage.clear();
    saveEditorPrefs({ ...loadEditorPrefs(), glyphFavorites: { items: ['※', '◇'] } });
    const { container } = await openWith([textBlock('헤드')]);
    // 처음엔 약물바 off → 바 미렌더.
    expect(screen.queryByTestId('glyph-bar')).toBeNull();

    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());

    // 처음엔 약물바 off → aria-checked=false.
    expect(ctxItem('약물바 보이기')).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(ctxItem('약물바 보이기')); // 토글 ON — 에러 없이 동작
    expect(ctxMenu()).toBeNull(); // 선택 후 닫힘

    // 토글 ON → 실제 약물바(glyph-bar, 하이픈)가 렌더되고 약물 버튼 2개가 보인다.
    const bar = await screen.findByTestId('glyph-bar');
    expect(within(bar).getAllByRole('button')).toHaveLength(2);

    // 다시 열면 약물바 on → aria-checked=true(토글 상태 보존).
    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());
    expect(ctxItem('약물바 보이기')).toHaveAttribute('aria-checked', 'true');

    // 다시 토글 OFF → 실제 약물바가 사라진다.
    await userEvent.click(ctxItem('약물바 보이기'));
    await waitFor(() => expect(screen.queryByTestId('glyph-bar')).toBeNull());
  });

  it('aux 항목(기업코드변환/원본 붙여넣기/텍스트 붙여넣기)은 비활성으로 보인다(약물입력은 phase17 step4에서 결선됨)', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());

    for (const label of ['기업코드변환', '원본 붙여넣기', '텍스트 붙여넣기']) {
      expect(ctxItem(label)).toBeDisabled();
    }
  });

  it('편집(비매핑) 모드: 잘라내기/복사/붙여넣기·찾기/바꾸기·전체 선택·약물입력·보이기 토글이 활성이다', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());

    for (const label of ['잘라내기', '복사', '붙여넣기', '찾기/바꾸기', '전체 선택', '약물입력', '메뉴바 보이기', '툴바 보이기', '약물바 보이기']) {
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

// Step 2(17-editor-glyph-tools): 약물바(EditorGlyphBar) 결선 — 자주쓰는 약물 렌더 + 캐럿 삽입(안전 경로) + 매핑 보호.
// glyphFavorites는 localStorage(editorPrefs)에 영속되므로 localStorage.clear()로 격리한다(마운트 lazy 초기화 오염 차단).
describe('WriterPage — 약물바(EditorGlyphBar) 결선', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });

  // 자주쓰는 약물을 시드한다(마운트 시 useState lazy 초기화가 이 값을 읽는다).
  const seedGlyphs = (items) => saveEditorPrefs({ ...loadEditorPrefs(), glyphFavorites: { items } });

  // 에디터 캐럿을 줄 시작에 두고 keyUp으로 onCaretChange를 발생시켜 lastCaretRef를 갱신한다(검색패널 삽입과 동일 경로).
  function focusCaretAtLine(container, lineIndex) {
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(lineEls[lineIndex]);
    range.collapse(true);
    sel.addRange(range);
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

  // editor-canvas 우클릭 → '약물바 보이기' 클릭으로 바를 켠다(phase14 컨텍스트 메뉴 토글 재사용).
  async function toggleGlyphBarOn(container) {
    const canvas = container.querySelector('[data-testid="editor-canvas"]');
    fireEvent.contextMenu(canvas, { clientX: 50, clientY: 60 });
    const menu = await screen.findByTestId('editor-context-menu');
    await userEvent.click(within(menu).getByText('약물바 보이기').closest('button'));
  }

  it('자주쓰는 약물을 시드하고 약물바를 켜면 약물 버튼이 렌더된다', async () => {
    seedGlyphs(['※', '◇']);
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    expect(screen.queryByTestId('glyph-bar')).toBeNull(); // 처음엔 꺼짐

    await toggleGlyphBarOn(container);

    const bar = await screen.findByTestId('glyph-bar');
    const buttons = within(bar).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent('※');
    expect(buttons[1]).toHaveTextContent('◇');
  });

  it('약물 버튼 클릭 시 마지막 캐럿 줄에 약물이 삽입된다(updateField body 안전 경로, 임베드 불변)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedGlyphs(['※']);
    const { container, model } = await openWith([
      textBlock('헤드'), embedBlock({ type: 'image', src: 'https://img/x.png' }), textBlock('본문'),
    ]);
    const save = vi.spyOn(model, 'saveArticle');

    await toggleGlyphBarOn(container);
    focusCaretAtLine(container, 1); // 텍스트-줄 1 = "본문"(임베드 제외 좌표) 시작에 캐럿

    const bar = await screen.findByTestId('glyph-bar');
    await userEvent.click(within(bar).getByRole('button', { name: '약물 ※ 삽입' }));

    // 저장 시 본문 텍스트 줄에 '※'가 삽입되고 임베드 블록은 그대로 보존된다.
    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text']); // 순서·개수 불변
    expect(blocksToText(blocks)).toBe('헤드\n※본문'); // 캐럿 줄 시작(col 0)에 삽입
  });

  it('매핑 모드에서는 약물바가 렌더되지 않아 본문이 바뀌지 않는다(본문-only 불변식)', async () => {
    seedGlyphs(['※']);
    const { container } = await openWith([textBlock('헤드')], { mode: 'mapping', status: 'DPS', role: 'D' });

    // 매핑 모드: 우클릭으로 약물바를 켜도 바 자체가 미렌더(매핑 가드).
    await toggleGlyphBarOn(container);
    expect(screen.queryByTestId('glyph-bar')).toBeNull();
  });

  it('등록된 약물이 없으면 약물바를 켜도 버튼 0개로 graceful', async () => {
    seedGlyphs([]);
    const { container } = await openWith([textBlock('헤드')]);

    await toggleGlyphBarOn(container);

    const bar = await screen.findByTestId('glyph-bar');
    expect(within(bar).queryAllByRole('button')).toHaveLength(0);
  });

  // 보강(harness-tester): 캐럿이 한 번도 잡히지 않은 상태(lastCaretRef.current === null) 약물 클릭 →
  // Step0 폴백("(끝)" 아닌 마지막 텍스트 줄 끝)으로 삽입되고 임베드 위치·내용·개수·순서가 불변임을 고정한다.
  // (캐럿을 세팅하지 않으므로 focusCaretAtLine 미호출 — 약물바 버튼은 onCaretChange를 발생시키지 않는다.)
  it('캐럿이 null이면 약물 클릭이 마지막 텍스트 줄 끝(Step0 폴백)에 삽입되고 임베드는 불변이다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedGlyphs(['※']);
    const embed = embedBlock({ type: 'image', src: 'https://img/y.png' });
    const { container, model } = await openWith([
      textBlock('첫줄'), embed, textBlock('마지막'),
    ]);
    const save = vi.spyOn(model, 'saveArticle');

    await toggleGlyphBarOn(container); // 캐럿은 세팅하지 않는다(lastCaretRef.current === null).
    const bar = await screen.findByTestId('glyph-bar');
    await userEvent.click(within(bar).getByRole('button', { name: '약물 ※ 삽입' }));

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text']); // 순서·개수 불변
    expect(blocks[1]).toEqual(embed); // 임베드 위치·내용 불변
    expect(blocksToText(blocks)).toBe('첫줄\n마지막※'); // 폴백 = 마지막 텍스트 줄 끝
  });

  // 보강(harness-tester): 여러 줄 본문에서 특정 줄 중간(offset)에 캐럿을 두고 삽입 시 그 컬럼에 정확히 들어가는지
  // (Step0 좌표 계약 — col = caret.offset - lineStart). 줄 시작(col 0)만 검증하던 기존 삽입 테스트의 공백 보강.
  it('여러 줄 본문에서 캐럿이 줄 중간(offset)이면 그 컬럼에 정확히 삽입된다(Step0 좌표 계약)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedGlyphs(['※']);
    // 텍스트 = "abcd\nefgh"(임베드 없음). 둘째 줄 'efgh' 시작 오프셋 5, offset 7 → 'ef' 다음 컬럼 2 → 'ef※gh'.
    const { container, model } = await openWith([textBlock('abcd'), textBlock('efgh')]);
    const save = vi.spyOn(model, 'saveArticle');

    await toggleGlyphBarOn(container);
    // 둘째 줄(텍스트-줄 1)에 캐럿을 두되 컬럼 2(offset 7)에 콜랩스한다(줄 시작이 아님).
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const textNode = lineEls[1].firstChild ?? lineEls[1];
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(textNode, 2); // 'efgh'의 컬럼 2
    range.collapse(true);
    sel.addRange(range);
    fireEvent.keyUp(container.querySelector('.yh-editor'));

    const bar = await screen.findByTestId('glyph-bar');
    await userEvent.click(within(bar).getByRole('button', { name: '약물 ※ 삽입' }));

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('abcd\nef※gh');
  });

  // 보강(harness-tester): 멀티문자 약물(예 '※※')도 그대로(분해/절단 없이) 삽입되는지 — 단일 약물만 보던 공백 보강.
  it("멀티문자 약물('※※')도 그대로 캐럿 줄에 삽입된다", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedGlyphs(['※※']);
    const { container, model } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');

    await toggleGlyphBarOn(container);
    focusCaretAtLine(container, 1); // 텍스트-줄 1 = "본문" 시작에 캐럿

    const bar = await screen.findByTestId('glyph-bar');
    await userEvent.click(within(bar).getByRole('button', { name: '약물 ※※ 삽입' }));

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드\n※※본문');
  });

  // 보강(harness-tester): 약물 삽입 후 임베드 블록의 위치·내용(전체 객체 동등)·개수가 모두 불변임을 못박는다.
  // (기존 삽입 테스트는 type 시퀀스만 검증 — embed의 src/속성 변형 회귀는 못 잡는다.)
  it('약물 삽입 후 임베드 블록의 위치·내용·개수가 모두 불변이다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedGlyphs(['※']);
    const embedA = embedBlock({ type: 'image', src: 'https://img/a.png', alt: '캡션' });
    const embedB = embedBlock({ type: 'video', src: 'https://v/b', title: '제목' });
    const { container, model } = await openWith([
      textBlock('헤드'), embedA, textBlock('본문'), embedB,
    ]);
    const save = vi.spyOn(model, 'saveArticle');

    await toggleGlyphBarOn(container);
    focusCaretAtLine(container, 1); // 텍스트-줄 1 = "본문"

    const bar = await screen.findByTestId('glyph-bar');
    await userEvent.click(within(bar).getByRole('button', { name: '약물 ※ 삽입' }));

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    expect(blocks.filter((b) => b.type === 'embed')).toHaveLength(2); // 개수 불변
    expect(blocks[1]).toEqual(embedA); // 위치·내용 불변(전체 객체 동등)
    expect(blocks[3]).toEqual(embedB);
    expect(blocksToText(blocks)).toBe('헤드\n※본문'); // 텍스트만 바뀜
  });

  // 보강(harness-tester): 환경설정에서 약물을 등록·'적용'하면 약물바가 onPrefsClose(applied)로 새 glyphFavorites를 즉시 반영한다
  // (별도 effect/구독 없이 lazy state + onPrefsClose 게이트만으로 갱신 — 마운트 후 동적 등록 반영 회귀 방어).
  it("환경설정에서 약물 등록 후 '적용'하면 약물바가 새 자주쓰는 약물로 즉시 갱신된다", async () => {
    seedGlyphs(['※']); // 초기 약물 1개
    const { container } = await openWith([textBlock('헤드')]);

    await toggleGlyphBarOn(container);
    let bar = await screen.findByTestId('glyph-bar');
    expect(within(bar).getAllByRole('button')).toHaveLength(1); // 초기 1개

    // 도움말>환경설정 → 자주쓰는 약물 탭에서 '◇' 추가 → 적용.
    await userEvent.click(screen.getByRole('menuitem', { name: '도움말' }));
    await userEvent.click(screen.getByText('환경설정'));
    await userEvent.click(screen.getByTestId('prefs-tab-glyphFavorites'));
    fireEvent.change(screen.getByTestId('pref-glyphFav-input'), { target: { value: '◇' } });
    fireEvent.click(screen.getByTestId('pref-glyphFav-add'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    // 적용 후 약물바가 새 약물(◇)을 포함해 버튼 2개로 갱신된다(별도 재오픈 없이 즉시 반영).
    bar = await screen.findByTestId('glyph-bar');
    await waitFor(() => expect(within(bar).getAllByRole('button')).toHaveLength(2));
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['※', '◇']);
  });
});

// Step 4(17-editor-glyph-tools): 약물입력 다이얼로그(GlyphInputDialog) 결선 —
// Alt+O / 도구 메뉴(tools.symbolInput) / 우클릭(ctx.symbolInput)으로 다이얼로그를 열고,
// 자주쓰는 약물(glyphFavorites) 선택 시 Step 2 onGlyphPick 안전 경로로 캐럿 위치에 삽입한다.
// keymap(glyphKeymap)은 참조 표시만. 매핑 모드에서는 열지 않고 본문도 바꾸지 않는다(본문-only 불변식).
// glyphFavorites/glyphKeymap은 localStorage(editorPrefs)에 영속되므로 localStorage.clear()로 격리한다.
describe('WriterPage — 약물입력 다이얼로그(GlyphInputDialog) 결선', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });

  // 자주쓰는 약물 + 사용자 키보드 약물을 함께 시드한다(마운트 lazy 초기화가 읽는다).
  const seedPrefs = ({ favorites = [], keymap = [] } = {}) => saveEditorPrefs({
    ...loadEditorPrefs(),
    glyphFavorites: { items: favorites },
    glyphKeymap: { items: keymap },
  });

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

  // 약물입력 다이얼로그 자체(role=dialog '약물 입력')만 본다.
  const glyphDialog = () => screen.queryByRole('dialog', { name: '약물 입력' });

  // 에디터 캐럿을 줄 시작에 두고 keyUp으로 onCaretChange를 발생시킨다(약물바 결선과 동일 경로).
  function focusCaretAtLine(container, lineIndex) {
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(lineEls[lineIndex]);
    range.collapse(true);
    sel.addRange(range);
    fireEvent.keyUp(container.querySelector('.yh-editor'));
  }

  function rightClickCanvas(container) {
    const canvas = container.querySelector('[data-testid="editor-canvas"]');
    fireEvent.contextMenu(canvas, { clientX: 50, clientY: 60 });
  }

  it('Alt+O keydown 시 약물입력 다이얼로그가 열리고 preventDefault된다', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    expect(glyphDialog()).toBeNull();

    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: 'o', altKey: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(spy).toHaveBeenCalled(); // Alt+O 가로채기
    await waitFor(() => expect(glyphDialog()).toBeInTheDocument());
    expect(screen.getByTestId('glyph-input')).toBeInTheDocument();
  });

  it("도구 메뉴 '약물 입력'(tools.symbolInput)이 활성이고 클릭 시 다이얼로그가 열린다", async () => {
    await openWith([textBlock('헤드')]);
    expect(glyphDialog()).toBeNull();

    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    const item = within(menu).getByText('약물 입력').closest('button');
    expect(item).toBeEnabled();
    await userEvent.click(item);

    await waitFor(() => expect(glyphDialog()).toBeInTheDocument());
  });

  it("우클릭 '약물입력'(ctx.symbolInput)이 비매핑에서 활성이고 클릭 시 다이얼로그가 열린다", async () => {
    const { container } = await openWith([textBlock('헤드')]);
    rightClickCanvas(container);
    const ctx = await screen.findByTestId('editor-context-menu');
    const item = within(ctx).getByText('약물입력').closest('button');
    expect(item).toBeEnabled();

    await userEvent.click(item);
    await waitFor(() => expect(glyphDialog()).toBeInTheDocument());
    expect(screen.queryByTestId('editor-context-menu')).toBeNull(); // 선택 후 닫힘
  });

  it("자주쓰는 약물('※') 클릭 시 캐럿 줄에 '※'가 삽입된다(updateField body 안전 경로, 임베드 불변)", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedPrefs({ favorites: ['※'] });
    const { container, model } = await openWith([
      textBlock('헤드'), embedBlock({ type: 'image', src: 'https://img/x.png' }), textBlock('본문'),
    ]);
    const save = vi.spyOn(model, 'saveArticle');

    focusCaretAtLine(container, 1); // 텍스트-줄 1 = "본문" 시작
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'o', altKey: true }));
    await waitFor(() => expect(glyphDialog()).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('glyph-input-fav-0'));

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text']); // 순서·개수 불변
    expect(blocksToText(blocks)).toBe('헤드\n※본문'); // 캐럿 줄 시작에 삽입
  });

  it("사용자 키보드 약물(glyphKeymap)이 다이얼로그에 'Ctrl+1 → ★'로 참조 표시된다", async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }] });
    const { container } = await openWith([textBlock('헤드')]);

    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'o', altKey: true }));
    await waitFor(() => expect(glyphDialog()).toBeInTheDocument());

    expect(screen.getByTestId('glyph-input-key-0')).toHaveTextContent('Ctrl+1 → ★');
  });

  it('약물 선택 후에도 다이얼로그가 열려 있다(연속 삽입 — Step 3 닫기 정책)', async () => {
    seedPrefs({ favorites: ['※'] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'o', altKey: true }));
    await waitFor(() => expect(glyphDialog()).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('glyph-input-fav-0'));
    expect(glyphDialog()).toBeInTheDocument(); // 닫기 버튼/Esc 전까지 열린 채

    await userEvent.click(screen.getByTestId('glyph-input-close'));
    await waitFor(() => expect(glyphDialog()).toBeNull());
  });

  it('매핑 모드: Alt+O가 다이얼로그를 열지 않고 updateField(body)가 호출되지 않는다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedPrefs({ favorites: ['※'] });
    const original = serialize([textBlock('foo bar')]);
    const { container, model } = await openWith(
      [textBlock('foo bar')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    const save = vi.spyOn(model, 'saveArticle');

    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'o', altKey: true }));
    expect(glyphDialog()).toBeNull(); // 매핑은 다이얼로그 안 열림

    // 저장 시 원본 body가 그대로 PUT된다(updateField('body',…) 미호출 → 본문 무변경).
    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original);
  });

  it("매핑 모드: 우클릭 '약물입력'이 비활성이다", async () => {
    seedPrefs({ favorites: ['※'] });
    const { container } = await openWith(
      [textBlock('foo bar')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    rightClickCanvas(container);
    const ctx = await screen.findByTestId('editor-context-menu');
    expect(within(ctx).getByText('약물입력').closest('button')).toBeDisabled();
  });

  it("환경설정 약물 미등록(빈 배열)이어도 다이얼로그가 graceful 안내로 열린다", async () => {
    seedPrefs({ favorites: [], keymap: [] });
    const { container } = await openWith([textBlock('헤드')]);

    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'o', altKey: true }));
    await waitFor(() => expect(glyphDialog()).toBeInTheDocument());
    expect(screen.getByTestId('glyph-input-fav-empty')).toBeInTheDocument();
    expect(screen.getByTestId('glyph-input-key-empty')).toBeInTheDocument();
  });

  // 보강(harness-tester): 매핑 모드 도구 메뉴 '약물 입력'은 (찾기/바꾸기 메뉴와 동일하게) 클릭 가능하나
  // onMenuSelect의 매핑 가드(early return)에 막혀 다이얼로그를 열지 않는다(본문-only 불변식). 메뉴 경로 공백 보강.
  it("매핑 모드: 도구 메뉴 '약물 입력' 클릭도 다이얼로그를 열지 않는다(매핑 가드)", async () => {
    seedPrefs({ favorites: ['※'] });
    await openWith(
      [textBlock('foo bar')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText('약물 입력').closest('button'));
    expect(glyphDialog()).toBeNull(); // 매핑 가드로 미개봉(찾기/바꾸기 메뉴와 동일 정책)
  });

  // 보강(harness-tester): glyphFavorites와 동일한 onPrefsClose(applied) 게이트로 keymap(참조 표시)도 즉시 갱신돼야 한다.
  // 환경설정에서 키보드 약물을 등록·'적용'한 뒤 다이얼로그를 열면 새 keymap이 'keys → glyph'로 참조 표시된다(마운트 후 동적 등록 반영 회귀 방어).
  it("환경설정에서 키보드 약물 등록 후 '적용'하면 다이얼로그 참조 표시가 즉시 갱신된다", async () => {
    seedPrefs({ favorites: [], keymap: [] }); // 초기 keymap 없음
    const { container } = await openWith([textBlock('헤드')]);

    // 먼저 다이얼로그를 열어 '등록된 약물 없음'(key-empty)을 확인한다.
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'o', altKey: true }));
    await waitFor(() => expect(glyphDialog()).toBeInTheDocument());
    expect(screen.getByTestId('glyph-input-key-empty')).toBeInTheDocument();
    // 다이얼로그를 닫고 환경설정으로 등록한다(닫지 않으면 prefs 모달과 겹쳐도 무방하나, 게이트 갱신만 검증).
    await userEvent.click(screen.getByTestId('glyph-input-close'));

    // 도움말>환경설정 → 사용자 키보드 약물 탭에서 'Ctrl+2 → ◎' 추가 → 적용.
    await userEvent.click(screen.getByRole('menuitem', { name: '도움말' }));
    await userEvent.click(screen.getByText('환경설정'));
    await userEvent.click(screen.getByTestId('prefs-tab-glyphKeymap'));
    fireEvent.change(screen.getByTestId('pref-glyphKey-keys'), { target: { value: 'Ctrl+2' } });
    fireEvent.change(screen.getByTestId('pref-glyphKey-glyph'), { target: { value: '◎' } });
    fireEvent.click(screen.getByTestId('pref-glyphKey-add'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    // 다시 다이얼로그를 열면 새 keymap이 참조 표시된다(별도 재마운트 없이 onPrefsClose 게이트로 즉시 반영).
    fireEvent(box, createEvent.keyDown(box, { key: 'o', altKey: true }));
    await waitFor(() => expect(glyphDialog()).toBeInTheDocument());
    expect(screen.getByTestId('glyph-input-key-0')).toHaveTextContent('Ctrl+2 → ◎');
    expect(screen.queryByTestId('glyph-input-key-empty')).toBeNull();
  });

  // 보강(harness-tester): 회귀 — Ctrl+F(찾기)와 Alt+O(약물입력)는 서로 간섭하지 않는다.
  // 두 분기 모두 라인삭제 조기 return 위에 있고 key가 달라(f vs o) 서로의 다이얼로그를 열지 않아야 한다.
  it('회귀: Ctrl+F는 찾기만, Alt+O는 약물입력만 열고 서로 간섭하지 않는다', async () => {
    seedPrefs({ favorites: ['※'] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const box = container.querySelector('.yh-editor');

    // Ctrl+F → 찾기/바꾸기만 열고 약물입력은 열지 않는다.
    fireEvent(box, createEvent.keyDown(box, { key: 'f', ctrlKey: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '찾기/바꾸기' })).toBeInTheDocument());
    expect(glyphDialog()).toBeNull(); // Alt+O 다이얼로그는 안 열림

    // Alt+O → 약물입력만 열고(찾기는 그대로) 두 다이얼로그가 공존해도 충돌하지 않는다.
    fireEvent(box, createEvent.keyDown(box, { key: 'o', altKey: true }));
    await waitFor(() => expect(glyphDialog()).toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: '찾기/바꾸기' })).toBeInTheDocument(); // 찾기 불변
  });
});

// Step 1(18-editor-tools-menu): 날짜 삽입(tools.insertDate) 결선 —
// 도구 메뉴 '날짜 삽입' 클릭 시 현재 시각(비결정)을 날짜형식 prefs(dateFormat)대로 포맷해 캐럿 위치 본문에 텍스트로 삽입한다.
// 약물입력과 동일 안전 경로(updateField('body', serialize(...)) + setPendingCaretLine). new Date는 WriterPage에만.
// 시각은 vi.useFakeTimers + setSystemTime으로 고정하고, dateFormat은 saveEditorPrefs로 주입한다(localStorage.clear 격리).
describe('WriterPage — 날짜 삽입(tools.insertDate) 결선', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true }); // userEvent의 타이머 의존을 위해 실시간 진행 허용.
    vi.setSystemTime(new Date('2026-06-24T01:23:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  // 날짜형식 prefs를 시드한다(마운트 lazy 초기화/loadEditorPrefs가 읽는다).
  const seedDateFormat = (dateFormat) => saveEditorPrefs({ ...loadEditorPrefs(), dateFormat });

  // 에디터 캐럿을 줄 시작에 두고 keyUp으로 onCaretChange를 발생시켜 lastCaretRef를 갱신한다(약물바 결선과 동일 경로).
  function focusCaretAtLine(container, lineIndex) {
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(lineEls[lineIndex]);
    range.collapse(true);
    sel.addRange(range);
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

  // 도구 메뉴를 열고 '날짜 삽입' 항목을 클릭한다.
  async function clickInsertDate() {
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText('날짜 삽입').closest('button'));
  }

  it("도구 메뉴 '날짜 삽입'(tools.insertDate)이 활성이다(MENU_ENABLED)", async () => {
    await openWith([textBlock('헤드')]);
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('날짜 삽입').closest('button')).toBeEnabled();
  });

  it("'날짜 삽입' 클릭 시 캐럿 줄에 날짜형식 prefs대로 포맷된 날짜가 삽입된다(안전 경로, 임베드 불변)", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedDateFormat('YYYY.MM.DD');
    const { container, model } = await openWith([
      textBlock('헤드'), embedBlock({ type: 'image', src: 'https://img/x.png' }), textBlock('본문'),
    ]);
    const save = vi.spyOn(model, 'saveArticle');

    focusCaretAtLine(container, 1); // 텍스트-줄 1 = "본문" 시작
    await clickInsertDate();

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text']); // 순서·개수 불변
    expect(blocksToText(blocks)).toBe('헤드\n2026.06.24본문'); // 고정 시각 포맷, 캐럿 줄 시작에 삽입
  });

  it('날짜형식 prefs를 바꾸면 삽입 문자열도 그 형식을 따른다(YYYY-MM-DD)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedDateFormat('YYYY-MM-DD');
    const { container, model } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');

    focusCaretAtLine(container, 1);
    await clickInsertDate();

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드\n2026-06-24본문');
  });

  it('시각 포맷(HH:mm 포함)도 prefs 형식대로 삽입된다(applyDateFormat 정합)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedDateFormat('YYYY-MM-DD HH:mm');
    const { container, model } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');

    focusCaretAtLine(container, 1);
    await clickInsertDate();

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    // 고정 시각 2026-06-24T01:23:00Z → 'YYYY-MM-DD HH:mm' = '2026-06-24 01:23'(UTC, applyDateFormat).
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드\n2026-06-24 01:23본문');
  });

  it('dateFormat prefs가 없으면 기본 형식(YYYY-MM-DD HH:mm)으로 삽입된다(loadEditorPrefs 기본값 폴백)', async () => {
    // seedDateFormat을 부르지 않음 — localStorage가 비어 loadEditorPrefs().dateFormat이 기본값으로 폴백한다.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container, model } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');

    focusCaretAtLine(container, 1);
    await clickInsertDate();

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    // 기본 dateFormat = 'YYYY-MM-DD HH:mm' → 고정 시각이 그 형식으로 삽입.
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드\n2026-06-24 01:23본문');
  });

  it('캐럿이 없을 때 클릭하면 "(끝)"이 아닌 마지막 텍스트 줄 끝에 삽입되고 크래시하지 않는다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedDateFormat('YYYY.MM.DD');
    const embed = embedBlock({ type: 'image', src: 'https://img/y.png' });
    const { model } = await openWith([
      textBlock('첫줄'), embed, textBlock('마지막'), textBlock('(끝)'),
    ]);
    const save = vi.spyOn(model, 'saveArticle');

    await clickInsertDate(); // 캐럿 세팅 없음(lastCaretRef.current === null)

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    expect(blocks[1]).toEqual(embed); // 임베드 위치·내용 불변
    // 폴백 = "(끝)"이 아닌 마지막 텍스트 줄('마지막') 끝, "(끝)"은 불변.
    expect(blocksToText(blocks)).toBe('첫줄\n마지막2026.06.24\n(끝)');
  });

  it('매핑 모드: 도구 메뉴 \'날짜 삽입\' 클릭도 본문을 바꾸지 않는다(매핑 가드)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedDateFormat('YYYY.MM.DD');
    const original = serialize([textBlock('foo bar')]);
    const { container, model } = await openWith(
      [textBlock('foo bar')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    const save = vi.spyOn(model, 'saveArticle');

    focusCaretAtLine(container, 0);
    await clickInsertDate();

    // 저장 시 원본 body가 그대로 PUT된다(updateField('body',…) 미호출 → 본문 무변경).
    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original);
  });

  it('다른 비결선 도구 항목(tools.publishPhoto)은 여전히 비활성이다(회귀 없음)', async () => {
    // 회귀 가드 — 날짜 삽입 결선이 무관한 도구 항목을 켜지 않았는지 확인한다.
    // (약어변환/약어관리는 23-editor-abbrev step1에서 의도적으로 결선되어 이제 활성이므로, 아직 미결선인 사진발행/DB등록으로 가드한다.)
    await openWith([textBlock('헤드')]);
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('사진발행/DB등록').closest('button')).toBeDisabled();
  });
});

// Step 3(18-editor-tools-menu): URL 직접 임베드(tools.insertImage·tools.insertYoutube) 결선 —
// 도구 메뉴 '그림 삽입'/'유튜브 영상 삽입' 클릭 → UrlEmbedDialog 오픈 → URL 입력 후 '삽입' → 기존 make*Embed + insertEmbed
// 경로로 캐럿 줄 뒤에 임베드 삽입(검색패널과 동일). 유튜브 아닌 URL은 makeVideoEmbed null → no-op. 매핑 모드에서도 허용.
describe('WriterPage — URL 직접 임베드(tools.insertImage·tools.insertYoutube) 결선', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });

  // 에디터 캐럿을 줄 시작에 두고 keyUp으로 onCaretChange를 발생시켜 lastCaretRef를 갱신한다(날짜/약물바 결선과 동일 경로).
  function focusCaretAtLine(container, lineIndex) {
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(lineEls[lineIndex]);
    range.collapse(true);
    sel.addRange(range);
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

  // 도구 메뉴를 열고 해당 라벨 항목을 클릭한다.
  async function clickTool(label) {
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText(label).closest('button'));
  }

  // URL 다이얼로그에 url을 입력하고 '삽입'을 누른다.
  async function submitUrl(url) {
    fireEvent.change(screen.getByTestId('url-embed-input'), { target: { value: url } });
    await userEvent.click(screen.getByTestId('url-embed-submit'));
  }

  it("도구 '그림 삽입'/'유튜브 영상 삽입'/'오디오 삽입'/'링크 삽입'/'로컬영상 삽입'은 활성, 비결선은 비활성이다(MENU_ENABLED)", async () => {
    await openWith([textBlock('헤드')]);
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('그림 삽입').closest('button')).toBeEnabled();
    expect(within(menu).getByText('유튜브 영상 삽입').closest('button')).toBeEnabled();
    // 19-step2: 세 임베드 항목이 활성으로 결선됨(이전 step에서 '오디오 삽입' 비활성 단언을 활성으로 갱신).
    expect(within(menu).getByText('오디오 삽입').closest('button')).toBeEnabled();
    expect(within(menu).getByText('링크 삽입').closest('button')).toBeEnabled();
    expect(within(menu).getByText('로컬영상 삽입').closest('button')).toBeEnabled();
    // 비결선 도구 항목은 여전히 비활성(회귀 가드).
    expect(within(menu).getByText('사진발행/DB등록').closest('button')).toBeDisabled();
  });

  it("'그림 삽입' 클릭 시 URL 다이얼로그가 열리고, URL 제출 시 캐럿 줄 뒤에 image 임베드가 생긴다", async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    await clickTool('그림 삽입');
    expect(screen.getByRole('dialog', { name: '그림 삽입' })).toBeInTheDocument();

    await submitUrl('https://img.example.com/a.png');
    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());
    // 다이얼로그는 1회성 삽입 후 닫힌다.
    expect(screen.queryByRole('dialog', { name: '그림 삽입' })).not.toBeInTheDocument();
  });

  it("'유튜브 영상 삽입' 클릭 → 유튜브 URL 제출 시 video 임베드가 생긴다", async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    await clickTool('유튜브 영상 삽입');
    expect(screen.getByRole('dialog', { name: '유튜브 영상 삽입' })).toBeInTheDocument();

    await submitUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await waitFor(() => expect(container.querySelector('[data-embed-type="video"]')).toBeTruthy());
  });

  it("'유튜브 영상 삽입' 클릭 → youtu.be 단축 URL 제출 시에도 video 임베드가 생긴다(parseYouTubeId 정합)", async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    await clickTool('유튜브 영상 삽입');

    await submitUrl('https://youtu.be/dQw4w9WgXcQ');
    await waitFor(() => expect(container.querySelector('[data-embed-type="video"]')).toBeTruthy());
  });

  it("'유튜브 영상 삽입' 클릭 → embed/ 형태 URL 제출 시에도 video 임베드가 생긴다(parseYouTubeId 정합)", async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    await clickTool('유튜브 영상 삽입');

    await submitUrl('https://www.youtube.com/embed/dQw4w9WgXcQ');
    await waitFor(() => expect(container.querySelector('[data-embed-type="video"]')).toBeTruthy());
  });

  it('유튜브가 아닌 URL을 영상 삽입에 넣으면 임베드가 생기지 않고 크래시하지 않는다(makeVideoEmbed null → no-op)', async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    await clickTool('유튜브 영상 삽입');

    await submitUrl('https://example.com/not-a-youtube');
    // 임베드가 추가되지 않는다(텍스트 줄만 유지).
    expect(container.querySelector('[data-embed-type="video"]')).toBeNull();
    expect(container.querySelector('.yh-embed')).toBeNull();
  });

  it('image 임베드 삽입 시 본문 텍스트는 변하지 않는다(임베드만 추가)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container, model } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');

    focusCaretAtLine(container, 1);
    await clickTool('그림 삽입');
    await submitUrl('https://img.example.com/b.png');
    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    // 텍스트 줄은 그대로, 임베드 1개만 추가됨.
    const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text);
    expect(texts).toEqual(['헤드', '본문', '']); // 임베드 뒤 빈 줄(커서 이동용)
    expect(blocks.filter((b) => b.type === 'embed').length).toBe(1);
  });

  it("매핑 모드에서도 '그림 삽입'은 활성이고, URL 제출 시 임베드가 본문에 추가된다(검색패널과 동일)", async () => {
    const { container } = await openWith(
      [textBlock('제목'), textBlock('본문'), textBlock('(끝)')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('그림 삽입').closest('button')).toBeEnabled();
    await userEvent.click(within(menu).getByText('그림 삽입').closest('button'));

    await submitUrl('https://img.example.com/c.png');
    // 매핑은 "(끝)" 앞 append 폴백으로 임베드가 실제 삽입된다(WriterPage.test.jsx:710-723 패턴).
    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());
  });

  it("'닫기'/Esc로 다이얼로그를 닫으면 임베드가 삽입되지 않는다", async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    await clickTool('그림 삽입');
    await userEvent.click(screen.getByTestId('url-embed-close'));

    expect(screen.queryByRole('dialog', { name: '그림 삽입' })).not.toBeInTheDocument();
    expect(container.querySelector('.yh-embed')).toBeNull();
  });

  // 19-step2: 오디오/링크/로컬영상 결선 — 그림/유튜브와 동일 패턴(메뉴 클릭→다이얼로그→URL 제출→insertEmbed).
  it("'오디오 삽입' 클릭 → 다이얼로그(kind=audio) 오픈, 허용 URL 제출 시 audio 임베드가 생긴다", async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    await clickTool('오디오 삽입');
    expect(screen.getByRole('dialog', { name: '오디오 삽입' })).toBeInTheDocument();

    await submitUrl('https://cdn.example.com/a.mp3');
    await waitFor(() => expect(container.querySelector('[data-embed-type="audio"]')).toBeTruthy());
    // <audio>가 실제 렌더된다(검증 통과).
    expect(container.querySelector('audio')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '오디오 삽입' })).not.toBeInTheDocument();
  });

  it("'링크 삽입' 클릭 → 다이얼로그(kind=link) 오픈, 허용 URL 제출 시 link 임베드가 생긴다", async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    await clickTool('링크 삽입');
    expect(screen.getByRole('dialog', { name: '링크 삽입' })).toBeInTheDocument();

    await submitUrl('https://example.com/article');
    await waitFor(() => expect(container.querySelector('[data-embed-type="link"]')).toBeTruthy());
    // <a href>가 실제 렌더되고 rel 하드닝이 박힌다.
    const a = container.querySelector('[data-embed-type="link"] a');
    expect(a.getAttribute('href')).toBe('https://example.com/article');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it("'로컬영상 삽입' 클릭 → 다이얼로그(kind=localVideo) 오픈, 허용 URL 제출 시 localVideo 임베드(<video>, iframe 아님)가 생긴다", async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    await clickTool('로컬영상 삽입');
    expect(screen.getByRole('dialog', { name: '로컬영상 삽입' })).toBeInTheDocument();

    await submitUrl('https://cdn.example.com/a.webm');
    await waitFor(() => expect(container.querySelector('[data-embed-type="localVideo"]')).toBeTruthy());
    expect(container.querySelector('[data-embed-type="localVideo"] video')).toBeTruthy();
    expect(container.querySelector('[data-embed-type="localVideo"] iframe')).toBeNull();
  });

  // 보안 회귀(필수): 악성 URL은 onUrlEmbedSubmit이 예외 없이 임베드를 만들어도 렌더 경로(InlineEmbed)에서 거부된다.
  // WriterPage는 검증하지 않는다(검증 단일 출처=렌더). 결선 후에도 step0 보안 단언이 유효함을 end-to-end로 확인.
  it('악성 오디오 URL(javascript:)을 제출해도 <audio>가 렌더되지 않는다(검증은 렌더 단일 출처)', async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    await clickTool('오디오 삽입');
    await submitUrl('javascript:alert(1)');
    // 임베드 블록은 추가될 수 있으나(WriterPage는 검증 안 함) <audio>는 렌더되지 않는다.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '오디오 삽입' })).not.toBeInTheDocument());
    expect(container.querySelector('audio')).toBeNull();
  });

  it('악성 링크 URL(javascript:)을 제출해도 <a href>가 렌더되지 않는다(검증은 렌더 단일 출처)', async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    await clickTool('링크 삽입');
    await submitUrl('javascript:alert(1)');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '링크 삽입' })).not.toBeInTheDocument());
    expect(container.querySelector('[data-embed-type="link"] a')).toBeNull();
  });

  it('오디오 임베드 삽입 시 본문 텍스트(blocksToText)는 변하지 않는다(임베드만 추가)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container, model } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');

    focusCaretAtLine(container, 1);
    await clickTool('오디오 삽입');
    await submitUrl('https://cdn.example.com/a.mp3');
    await waitFor(() => expect(container.querySelector('[data-embed-type="audio"]')).toBeTruthy());

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text);
    expect(texts).toEqual(['헤드', '본문', '']); // 임베드 뒤 빈 줄(커서 이동용)
    expect(blocks.filter((b) => b.type === 'embed' && b.embedType === 'audio').length).toBe(1);
  });

  it("매핑 모드에서도 '링크 삽입'으로 임베드를 추가할 수 있다(\"(끝)\" 앞 append — 그림/유튜브와 동일)", async () => {
    const { container } = await openWith(
      [textBlock('제목'), textBlock('본문'), textBlock('(끝)')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('링크 삽입').closest('button')).toBeEnabled();
    await userEvent.click(within(menu).getByText('링크 삽입').closest('button'));

    await submitUrl('https://example.com/m');
    await waitFor(() => expect(container.querySelector('[data-embed-type="link"]')).toBeTruthy());
  });
});

// Step 1(20-editor-file-info): 도구>파일 정보(tools.fileInfo) 결선 —
// 메뉴 클릭 시 열린 시점 본문 통계를 계산해 읽기전용 FileInfoDialog에 주입한다.
// 읽기전용이라 본문/캐럿/임베드를 바꾸지 않는다(매핑에서도 안전).
describe('WriterPage — 파일 정보(tools.fileInfo) 결선', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  function focusCaretAtLine(container, lineIndex) {
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(lineEls[lineIndex]);
    range.collapse(true);
    sel.addRange(range);
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

  async function clickFileInfo() {
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText('파일 정보').closest('button'));
  }

  it("도구 메뉴 '파일 정보'(tools.fileInfo)가 활성이다(MENU_ENABLED — 비활성→활성)", async () => {
    await openWith([textBlock('헤드')]);
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('파일 정보').closest('button')).toBeEnabled();
  });

  it("'파일 정보' 클릭 시 FileInfoDialog(file-info, role=dialog '파일 정보')가 열린다", async () => {
    await openWith([textBlock('헤드라인'), textBlock('본문')]);
    await clickFileInfo();
    expect(screen.getByRole('dialog', { name: '파일 정보' })).toBeInTheDocument();
    expect(screen.getByTestId('file-info')).toBeInTheDocument();
  });

  it('본문 통계가 다이얼로그에 표시된다(글자수/줄수/단어수/UTF-8바이트 — 본문 계산값과 일치)', async () => {
    // blocksToText = "헤드라인\n본문" → 글자수 6(개행 제외), 줄수 2, 단어수 2,
    // UTF-8 바이트 19(한글 6자×3B + 개행 1B) — byteLength(bodyText) 결선을 검증한다(charCount 등 오배선 방지).
    await openWith([textBlock('헤드라인'), textBlock('본문')]);
    await clickFileInfo();
    expect(screen.getByTestId('file-info-chars')).toHaveTextContent('6');
    expect(screen.getByTestId('file-info-lines')).toHaveTextContent('2');
    expect(screen.getByTestId('file-info-words')).toHaveTextContent('2');
    expect(screen.getByTestId('file-info-bytes')).toHaveTextContent('19');
  });

  it('임베드가 있으면 file-info-embeds가 임베드 개수(blocks 기준)를 표시한다', async () => {
    // 텍스트 2줄 + 임베드 1개 → embeds=1. bodyText에는 임베드가 빠지므로 blocks.filter로 세야 1.
    await openWith([
      textBlock('헤드'), embedBlock({ type: 'image', src: 'https://img/x.png' }), textBlock('본문'),
    ]);
    await clickFileInfo();
    expect(screen.getByTestId('file-info-embeds')).toHaveTextContent('1');
  });

  it('포커스 전(캐럿 없음)에도 캐럿 위치가 기본값 1단락 1행 1열로 표시된다(statusCaret null 폴백)', async () => {
    await openWith([textBlock('헤드라인'), textBlock('본문')]);
    await clickFileInfo();
    expect(screen.getByTestId('file-info-caret')).toHaveTextContent('1단락 1행 1열');
  });

  it('캐럿을 둘째 줄에 두면 file-info-caret이 그 위치를 표시한다(statusCaret 소스)', async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    focusCaretAtLine(container, 1); // 텍스트-줄 1 시작 = 2행 1열
    await clickFileInfo();
    expect(screen.getByTestId('file-info-caret')).toHaveTextContent('2행');
  });

  it("'닫기' 클릭/Esc로 다이얼로그가 닫힌다", async () => {
    await openWith([textBlock('헤드라인'), textBlock('본문')]);
    await clickFileInfo();
    await userEvent.click(screen.getByTestId('file-info-close'));
    expect(screen.queryByRole('dialog', { name: '파일 정보' })).not.toBeInTheDocument();

    await clickFileInfo();
    fireEvent.keyDown(screen.getByRole('dialog', { name: '파일 정보' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '파일 정보' })).not.toBeInTheDocument();
  });

  it('읽기전용 — 파일 정보를 열고 닫아도 본문(saveArticle markupVersion)이 변하지 않는다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container, model } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');

    focusCaretAtLine(container, 1);
    await clickFileInfo();
    await userEvent.click(screen.getByTestId('file-info-close'));

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    // 텍스트/임베드 무변경 — 본문이 그대로다(읽기전용).
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(blocksToText(blocks)).toBe('헤드\n본문');
  });

  it('읽기전용 — 다이얼로그에 입력 필드(input/textarea)가 없다', async () => {
    await openWith([textBlock('헤드라인'), textBlock('본문')]);
    await clickFileInfo();
    const dialog = screen.getByTestId('file-info');
    expect(dialog.querySelector('input')).toBeNull();
    expect(dialog.querySelector('textarea')).toBeNull();
  });

  it("매핑 모드에서도 '파일 정보'가 활성이고 다이얼로그가 열린다(읽기전용 — 임베드 삽입 항목과 동일)", async () => {
    await openWith(
      [textBlock('제목'), textBlock('본문'), textBlock('(끝)')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('파일 정보').closest('button')).toBeEnabled();
    await userEvent.click(within(menu).getByText('파일 정보').closest('button'));
    expect(screen.getByRole('dialog', { name: '파일 정보' })).toBeInTheDocument();
  });
});

// Step 1(22-editor-memo): 도구>메모장(tools.memo) 결선 —
// 메뉴 클릭 시 controlled MemoDialog를 연다. 값은 부모 memoText(마운트 lazy-init), '저장'만 localStorage(yh.editorMemo) 영속.
// 메모는 기사와 무관한 전역 스크래치패드 — 본문/캐럿/임베드 무변경(매핑에서도 안전). localStorage는 케이스별로 격리.
describe('WriterPage — 메모장(tools.memo) 결선', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
  });

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

  async function clickMemo() {
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText('메모장').closest('button'));
  }

  it("도구 메뉴 '메모장'(tools.memo)이 활성이다(MENU_ENABLED — 비활성→활성)", async () => {
    await openWith([textBlock('헤드')]);
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('메모장').closest('button')).toBeEnabled();
  });

  it("'메모장' 클릭 시 MemoDialog(editor-memo, role=dialog '메모장')가 열리고 textarea가 보인다", async () => {
    await openWith([textBlock('헤드라인'), textBlock('본문')]);
    await clickMemo();
    expect(screen.getByRole('dialog', { name: '메모장' })).toBeInTheDocument();
    expect(screen.getByTestId('editor-memo-text')).toBeInTheDocument();
  });

  it('textarea에 입력하면 값이 반영된다(controlled)', async () => {
    await openWith([textBlock('헤드')]);
    await clickMemo();
    const ta = screen.getByTestId('editor-memo-text');
    await userEvent.type(ta, '취재 메모');
    expect(ta).toHaveValue('취재 메모');
  });

  it("입력 후 '저장' 클릭 시 localStorage(yh.editorMemo)에 영속된다", async () => {
    await openWith([textBlock('헤드')]);
    await clickMemo();
    await userEvent.type(screen.getByTestId('editor-memo-text'), '저장할 메모');
    await userEvent.click(screen.getByTestId('editor-memo-save'));
    expect(loadMemo()).toBe('저장할 메모');
    expect(JSON.parse(localStorage.getItem('yh.editorMemo'))).toBe('저장할 메모');
  });

  it("'저장' 후에도 다이얼로그는 열린 채 유지된다(저장/닫기 별개 동작)", async () => {
    await openWith([textBlock('헤드')]);
    await clickMemo();
    await userEvent.type(screen.getByTestId('editor-memo-text'), '메모');
    await userEvent.click(screen.getByTestId('editor-memo-save'));
    expect(screen.getByRole('dialog', { name: '메모장' })).toBeInTheDocument();
  });

  it("'닫기'로 다이얼로그가 닫힌다", async () => {
    await openWith([textBlock('헤드')]);
    await clickMemo();
    await userEvent.click(screen.getByTestId('editor-memo-close'));
    expect(screen.queryByRole('dialog', { name: '메모장' })).not.toBeInTheDocument();
  });

  it('Esc로 다이얼로그가 닫힌다', async () => {
    await openWith([textBlock('헤드')]);
    await clickMemo();
    fireEvent.keyDown(screen.getByRole('dialog', { name: '메모장' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '메모장' })).not.toBeInTheDocument();
  });

  it('재오픈 시 세션 내 편집 유지(저장 안 해도 부모 state 보존)', async () => {
    await openWith([textBlock('헤드')]);
    await clickMemo();
    await userEvent.type(screen.getByTestId('editor-memo-text'), '미저장 편집');
    await userEvent.click(screen.getByTestId('editor-memo-close'));
    await clickMemo();
    expect(screen.getByTestId('editor-memo-text')).toHaveValue('미저장 편집');
  });

  it('저장 없이 닫으면 localStorage가 갱신되지 않는다(명시 저장 모델)', async () => {
    await openWith([textBlock('헤드')]);
    await clickMemo();
    await userEvent.type(screen.getByTestId('editor-memo-text'), '닫기만');
    await userEvent.click(screen.getByTestId('editor-memo-close'));
    expect(localStorage.getItem('yh.editorMemo')).toBeNull();
    expect(loadMemo()).toBe('');
  });

  it('새 마운트 시 이전에 저장된 메모가 복원돼 다이얼로그에 표시된다(lazy-init loadMemo)', async () => {
    // 마운트 전에 저장본을 심어두면 memoText 초기화(useState(() => loadMemo()))가 이를 복원해야 한다(새로고침 후 지속).
    localStorage.setItem('yh.editorMemo', JSON.stringify('이전 세션 저장 메모'));
    await openWith([textBlock('헤드')]);
    await clickMemo();
    expect(screen.getByTestId('editor-memo-text')).toHaveValue('이전 세션 저장 메모');
  });

  it("매핑 모드에서도 '메모장'이 활성이고 다이얼로그가 열린다(본문 무관 — 매핑 안전)", async () => {
    await openWith(
      [textBlock('제목'), textBlock('본문'), textBlock('(끝)')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('메모장').closest('button')).toBeEnabled();
    await userEvent.click(within(menu).getByText('메모장').closest('button'));
    expect(screen.getByRole('dialog', { name: '메모장' })).toBeInTheDocument();
  });

  it('본문 무변경 — 메모를 열고 입력/저장/닫기 해도 본문(saveArticle markupVersion)이 변하지 않는다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');

    await clickMemo();
    await userEvent.type(screen.getByTestId('editor-memo-text'), '메모 내용');
    await userEvent.click(screen.getByTestId('editor-memo-save'));
    await userEvent.click(screen.getByTestId('editor-memo-close'));

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    // 텍스트/임베드 무변경 — 본문이 그대로다(메모는 기사와 독립).
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(blocksToText(blocks)).toBe('헤드\n본문');
  });
});

// Step 1(23-editor-abbrev): 도구>약어관리(tools.abbrManage)·약어변환(tools.abbrConvert) 결선 —
//  - 약어관리: controlled AbbrevManageDialog를 연다(매핑 가드 앞). 커밋 목록은 부모 abbrevs(마운트 lazy-init),
//    onAdd/onRemove가 즉시 saveAbbrevs로 localStorage(yh.editorAbbrevs) 영속. 본문/캐럿/임베드 무변경.
//  - 약어변환: expandAbbrevInBlocks로 본문 텍스트 블록을 확장(임베드·"(끝)" 불변) → updateField('body', serialize) 안전 경로.
//    본문 변경이라 매핑 가드 뒤(매핑 no-op). localStorage는 케이스별로 격리.
describe('WriterPage — 약어관리/약어변환(tools.abbrManage·tools.abbrConvert) 결선', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
  });

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

  // 도구 메뉴를 열고 해당 라벨 항목을 클릭한다(날짜/메모 결선과 동일 패턴).
  async function clickTool(label) {
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText(label).closest('button'));
  }

  it("도구 메뉴 '약어관리'·'약어변환'이 활성이다(MENU_ENABLED — 비활성→활성)", async () => {
    await openWith([textBlock('헤드')]);
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('약어관리').closest('button')).toBeEnabled();
    expect(within(menu).getByText('약어변환').closest('button')).toBeEnabled();
  });

  it("'약어관리' 클릭 시 AbbrevManageDialog(abbrev-manage, role=dialog '약어 관리')가 열린다", async () => {
    await openWith([textBlock('헤드라인'), textBlock('본문')]);
    await clickTool('약어관리');
    expect(screen.getByRole('dialog', { name: '약어 관리' })).toBeInTheDocument();
    expect(screen.getByTestId('abbrev-manage')).toBeInTheDocument();
  });

  it("짧은형/확장형 추가 시 localStorage(yh.editorAbbrevs)에 영속되고 목록에 'short → long'이 표시된다", async () => {
    await openWith([textBlock('헤드')]);
    await clickTool('약어관리');
    await userEvent.type(screen.getByTestId('abbrev-manage-short'), '정부');
    await userEvent.type(screen.getByTestId('abbrev-manage-long'), '대한민국 정부');
    await userEvent.click(screen.getByTestId('abbrev-manage-add'));

    expect(within(screen.getByTestId('abbrev-manage-list')).getByText('정부 → 대한민국 정부')).toBeInTheDocument();
    expect(loadAbbrevs()).toEqual([{ short: '정부', long: '대한민국 정부' }]); // localStorage 영속(즉시 확정).
  });

  it("행 '삭제' 시 목록과 localStorage에서 제거된다", async () => {
    saveAbbrevs([{ short: '정부', long: '대한민국 정부' }]); // 마운트 전 시드(lazy-init 복원).
    await openWith([textBlock('헤드')]);
    await clickTool('약어관리');
    expect(screen.getByTestId('abbrev-manage-item-0')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('abbrev-manage-remove-0'));
    expect(screen.queryByTestId('abbrev-manage-item-0')).not.toBeInTheDocument();
    expect(loadAbbrevs()).toEqual([]); // 저장소에도 반영(즉시 영속).
  });

  it("'닫기'/Esc로 약어관리 다이얼로그가 닫힌다", async () => {
    await openWith([textBlock('헤드')]);
    await clickTool('약어관리');
    await userEvent.click(screen.getByTestId('abbrev-manage-close'));
    expect(screen.queryByRole('dialog', { name: '약어 관리' })).not.toBeInTheDocument();

    await clickTool('약어관리');
    fireEvent.keyDown(screen.getByRole('dialog', { name: '약어 관리' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '약어 관리' })).not.toBeInTheDocument();
  });

  it("'약어변환' 클릭 시 등록 약어가 본문에서 확장되고 저장 markupVersion에 반영된다(안전 경로)", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    saveAbbrevs([{ short: '정부', long: '대한민국 정부' }]); // 마운트 전 시드(lazy-init 복원).
    const { model } = await openWith([textBlock('헤드'), textBlock('정부'), textBlock('(끝)')]);
    const save = vi.spyOn(model, 'saveArticle');

    await clickTool('약어변환');

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    // '정부'(단독)만 확장, 임베드/"(끝)" 불변.
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드\n대한민국 정부\n(끝)');
  });

  it('오확장 안 함 — 부분문자열(행정부)은 치환되지 않는다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    saveAbbrevs([{ short: '정부', long: '대한민국 정부' }]);
    const { model } = await openWith([textBlock('헤드'), textBlock('행정부'), textBlock('(끝)')]);
    const save = vi.spyOn(model, 'saveArticle');

    await clickTool('약어변환');

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드\n행정부\n(끝)');
  });

  it('미등록 no-op — 등록 약어가 없으면 약어변환이 본문을 바꾸지 않는다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model } = await openWith([textBlock('헤드'), textBlock('정부'), textBlock('(끝)')]);
    const save = vi.spyOn(model, 'saveArticle');

    await clickTool('약어변환');

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드\n정부\n(끝)');
  });

  it("매핑 모드 — '약어관리'는 활성·열림(가드 앞), '약어변환'은 본문을 바꾸지 않는다(가드 뒤 no-op)", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    saveAbbrevs([{ short: '정부', long: '대한민국 정부' }]);
    const { model } = await openWith(
      [textBlock('제목'), textBlock('정부'), textBlock('(끝)')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    const save = vi.spyOn(model, 'saveArticle');

    // 약어관리 — 매핑에서도 활성·다이얼로그 열림(본문 무관).
    await clickTool('약어관리');
    expect(screen.getByRole('dialog', { name: '약어 관리' })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('abbrev-manage-close'));

    // 약어변환 — 매핑 no-op(본문 변경 차단).
    await clickTool('약어변환');
    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('제목\n정부\n(끝)');
  });

  it('약어관리는 본문 무변경 — 열고 추가/삭제/닫기 해도 본문(saveArticle markupVersion)이 변하지 않는다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model } = await openWith([textBlock('헤드'), textBlock('본문'), textBlock('(끝)')]);
    const save = vi.spyOn(model, 'saveArticle');

    await clickTool('약어관리');
    await userEvent.type(screen.getByTestId('abbrev-manage-short'), '정부');
    await userEvent.type(screen.getByTestId('abbrev-manage-long'), '대한민국 정부');
    await userEvent.click(screen.getByTestId('abbrev-manage-add'));
    await userEvent.click(screen.getByTestId('abbrev-manage-remove-0'));
    await userEvent.click(screen.getByTestId('abbrev-manage-close'));

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text', 'text']);
    expect(blocksToText(blocks)).toBe('헤드\n본문\n(끝)');
  });
});

// Step 1(24-editor-simptrad): 도구>간체↔번체 변환(tools.simpTradConvert) 결선 —
//  - 도구 메뉴 '간체↔번체 변환' 클릭 → 방향 선택 다이얼로그(SimpTradConvertDialog) 오픈(매핑 가드 뒤).
//  - 방향 버튼(간체→번체/번체→간체) 클릭 → convertSimpTradInBlocks + updateField('body', serialize) 안전 경로로
//    본문 텍스트 블록만 변환(임베드·"(끝)" 불변) 후 1회성 닫기. 미매핑/오방향은 changed=false → no-op.
//  - 본문 변경이라 매핑 가드 뒤(매핑에선 메뉴가 다이얼로그를 열지 않음 — 약어변환과 동일 정책). 표는 번들 상수(state 없음).
describe('WriterPage — 간체↔번체 변환(tools.simpTradConvert) 결선', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
  });

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

  // 도구 메뉴를 열고 해당 라벨 항목을 클릭한다(약어변환/날짜 결선과 동일 패턴).
  async function clickTool(label) {
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText(label).closest('button'));
  }

  it("도구 메뉴 '간체↔번체 변환'이 활성이다(MENU_ENABLED — 비활성→활성)", async () => {
    await openWith([textBlock('헤드')]);
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('간체↔번체 변환').closest('button')).toBeEnabled();
  });

  it('다른 비결선 도구 항목(사진발행/이력비교/UI언어)은 여전히 비활성이다(회귀 없음)', async () => {
    await openWith([textBlock('헤드')]);
    await userEvent.click(screen.getByRole('menuitem', { name: '도구' }));
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('사진발행/DB등록').closest('button')).toBeDisabled();
    expect(within(menu).getByText('기사이력비교').closest('button')).toBeDisabled();
    expect(within(menu).getByText('UI 언어 설정').closest('button')).toBeDisabled();
  });

  it("'간체↔번체 변환' 클릭 시 SimpTradConvertDialog(simptrad-convert, role=dialog '간체/번체 변환')가 열린다", async () => {
    await openWith([textBlock('헤드'), textBlock('본문')]);
    await clickTool('간체↔번체 변환');
    expect(screen.getByRole('dialog', { name: '간체/번체 변환' })).toBeInTheDocument();
    expect(screen.getByTestId('simptrad-convert')).toBeInTheDocument();
  });

  it("'간체→번체' 클릭 시 본문 간체가 번체로 변환되고 저장 markupVersion에 반영된다(안전 경로), 다이얼로그 닫힘", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model } = await openWith([textBlock('헤드'), textBlock('国'), textBlock('(끝)')]);
    const save = vi.spyOn(model, 'saveArticle');

    await clickTool('간체↔번체 변환');
    await userEvent.click(screen.getByTestId('simptrad-to-trad'));
    // 1회성 — 변환 후 다이얼로그가 닫힌다.
    expect(screen.queryByTestId('simptrad-convert')).not.toBeInTheDocument();

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드\n國\n(끝)');
  });

  it("'번체→간체' 클릭 시 본문 번체가 간체로 변환된다", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model } = await openWith([textBlock('헤드'), textBlock('國'), textBlock('(끝)')]);
    const save = vi.spyOn(model, 'saveArticle');

    await clickTool('간체↔번체 변환');
    await userEvent.click(screen.getByTestId('simptrad-to-simp'));
    expect(screen.queryByTestId('simptrad-convert')).not.toBeInTheDocument();

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드\n国\n(끝)');
  });

  it('미매핑 no-op — 한글/라틴 본문은 어느 방향이든 변하지 않고 다이얼로그가 닫힌다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model } = await openWith([textBlock('헤드라인'), textBlock('abc 본문'), textBlock('(끝)')]);
    const save = vi.spyOn(model, 'saveArticle');

    await clickTool('간체↔번체 변환');
    await userEvent.click(screen.getByTestId('simptrad-to-trad'));
    expect(screen.queryByTestId('simptrad-convert')).not.toBeInTheDocument();

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드라인\nabc 본문\n(끝)');
  });

  it('임베드/"(끝)" 불변 — 텍스트 중국어만 변환되고 임베드·"(끝)"는 그대로다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model } = await openWith([
      textBlock('国'),
      embedBlock({ embedType: 'image', src: 'x.png' }),
      textBlock('(끝)'),
    ]);
    const save = vi.spyOn(model, 'saveArticle');

    await clickTool('간체↔번체 변환');
    await userEvent.click(screen.getByTestId('simptrad-to-trad'));

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text']);
    expect(blocks[0].text).toBe('國');                                // 텍스트 중국어만 변환
    expect(blocks[1]).toMatchObject({ type: 'embed', src: 'x.png' }); // 임베드 불변
    expect(blocks[2].text).toBe('(끝)');                              // "(끝)" 불변
  });

  it("'닫기'/Esc로 다이얼로그가 닫히고 본문은 변하지 않는다", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model } = await openWith([textBlock('헤드'), textBlock('国'), textBlock('(끝)')]);
    const save = vi.spyOn(model, 'saveArticle');

    await clickTool('간체↔번체 변환');
    await userEvent.click(screen.getByTestId('simptrad-close'));
    expect(screen.queryByTestId('simptrad-convert')).not.toBeInTheDocument();

    await clickTool('간체↔번체 변환');
    fireEvent.keyDown(screen.getByRole('dialog', { name: '간체/번체 변환' }), { key: 'Escape' });
    expect(screen.queryByTestId('simptrad-convert')).not.toBeInTheDocument();

    // 변환 없이 닫기만 — 본문 무변경.
    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드\n国\n(끝)');
  });

  it("매핑 모드 — '간체↔번체 변환' 클릭도 다이얼로그를 열지 않고 본문을 바꾸지 않는다(매핑 가드 뒤)", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model } = await openWith(
      [textBlock('제목'), textBlock('国'), textBlock('(끝)')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    const save = vi.spyOn(model, 'saveArticle');

    await clickTool('간체↔번체 변환');
    expect(screen.queryByTestId('simptrad-convert')).not.toBeInTheDocument();

    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('제목\n国\n(끝)');
  });
});
