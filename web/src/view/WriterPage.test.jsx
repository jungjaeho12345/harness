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
import { loadEditorPrefs, saveEditorPrefs, setEditorPref, DEFAULT_EDITOR_PREFS } from './editorPrefs.js';
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

// 메뉴바는 기본 숨김 — 상단 메뉴(파일/편집/보기/도구 등)를 클릭하기 전에 우클릭 컨텍스트 메뉴의
// '메뉴바 보이기'로 메뉴바를 켜는 공용 헬퍼. 이미 켜져 있으면(같은 테스트 내 재호출) 바로 클릭한다.
async function openTopMenu(name) {
  if (!screen.queryByTestId('menubar')) {
    fireEvent.contextMenu(screen.getByTestId('editor-canvas'));
    const ctx = await screen.findByTestId('editor-context-menu');
    await userEvent.click(within(ctx).getByText('메뉴바 보이기').closest('button'));
    await waitFor(() => expect(screen.getByTestId('menubar')).toBeInTheDocument());
  }
  await userEvent.click(screen.getByRole('menuitem', { name }));
}

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

  it('메뉴바·툴바·전용 토글 버튼은 기본 미노출이고 상태표시줄만 보인다', () => {
    const { container, queryByTestId } = setup({ identity: { role: 'R' } });
    const editorCol = container.querySelector('.yh-writer__editor');
    expect(within(editorCol).queryByTestId('menubar')).toBeNull();
    expect(within(editorCol).queryByTestId('toolbar')).toBeNull();
    // 구 메뉴바/툴바 전용 토글 버튼(yh-editor-chrome-bar)은 제거됨 — 우클릭 컨텍스트 메뉴로만 토글한다.
    expect(queryByTestId('toggle-menubar')).toBeNull();
    expect(queryByTestId('toggle-toolbar')).toBeNull();
    expect(within(editorCol).getByRole('status', { name: '에디터 상태' })).toBeInTheDocument();
  });

  it('본문 텍스트가 상태표시줄 단어수/Byte에 반영된다', async () => {
    const { getByTestId } = await openWith([textBlock('헤드라인'), textBlock('본문')]);
    // blocksToText = "헤드라인\n본문" → 단어 2개, UTF-8 19바이트(한글 3B×6 + 개행 1B).
    expect(getByTestId('stat-words')).toHaveTextContent('2단어');
    expect(getByTestId('stat-bytes')).toHaveTextContent('19B');
  });

  it("우클릭 '메뉴바 보이기'/'툴바 보이기'로 메뉴바·툴바를 켜고 다시 끌 수 있다", async () => {
    const { queryByTestId } = await openWith([textBlock('헤드')]);
    expect(queryByTestId('menubar')).toBeNull();
    expect(queryByTestId('toolbar')).toBeNull();

    // 컨텍스트 메뉴는 항목 선택 시 닫히므로(onSelect 후 onClose) 토글마다 다시 연다.
    async function toggleCtx(label) {
      fireEvent.contextMenu(screen.getByTestId('editor-canvas'));
      const ctx = await screen.findByTestId('editor-context-menu');
      await userEvent.click(within(ctx).getByText(label).closest('button'));
    }

    await toggleCtx('메뉴바 보이기');
    expect(queryByTestId('menubar')).toBeInTheDocument();
    await toggleCtx('툴바 보이기');
    expect(queryByTestId('toolbar')).toBeInTheDocument();

    await toggleCtx('메뉴바 보이기');
    expect(queryByTestId('menubar')).toBeNull();
    await toggleCtx('툴바 보이기');
    expect(queryByTestId('toolbar')).toBeNull();
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

  // IME 조합 가드 — 조합 중(isComposing)에는 커스텀 줄삭제를 실행하지 않는다(조합 파괴 방지 — news.md 173행 무개입 원칙).
  it('IME 조합 중 Ctrl+D는 개입하지 않는다(줄 삭제·preventDefault 없음)', async () => {
    const { container } = await openWith([
      textBlock('헤드'), textBlock('둘째'), textBlock('다음'),
    ]);
    caretAtLine(container, 1); // "둘째" 라인

    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: 'd', ctrlKey: true, isComposing: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(spy).not.toHaveBeenCalled(); // IME/브라우저 기본 동작 보존
    expect(editorLines(container)).toEqual(['헤드', '둘째', '다음']); // 줄이 삭제되지 않음
  });

  it('IME 조합 중 빈 줄 Backspace는 개입하지 않는다(줄·임베드 보존)', async () => {
    const { container } = await openWith([
      textBlock('제목'), textBlock(''), embedBlock({ embedType: 'image', src: 'x.png' }), textBlock('다음'),
    ]);
    caretAtLine(container, 1); // 빈 줄

    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: 'Backspace', isComposing: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(spy).not.toHaveBeenCalled();
    expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy(); // 임베드 보존
    expect(editorLines(container)).toEqual(['제목', '', '다음']); // 빈 줄 그대로
  });

  // 회귀 가드 — 조합이 아닐 때(isComposing:false)의 줄 삭제는 기존과 동일하게 동작한다.
  it('조합이 아닐 때(isComposing:false) Ctrl+D 줄 삭제는 기존대로 동작한다', async () => {
    const { container } = await openWith([
      textBlock('헤드'), textBlock('둘째'), textBlock('다음'),
    ]);
    caretAtLine(container, 1);
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'd', ctrlKey: true, isComposing: false });
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '다음']));
  });

  it('조합이 아닐 때(isComposing:false) 빈 줄 Backspace 줄 삭제는 기존대로 동작한다', async () => {
    const { container } = await openWith([
      textBlock('제목'), textBlock(''), embedBlock({ embedType: 'image', src: 'x.png' }), textBlock('다음'),
    ]);
    caretAtLine(container, 1); // 빈 줄
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'Backspace', isComposing: false });
    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeNull());
    expect(editorLines(container)).toEqual(['제목', '다음']);
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

  it('캐럿이 "(끝)" 줄이어도 이미지가 삽입되고 "(끝)"은 마지막 줄로 유지된다(마커 차단은 텍스트만)', async () => {
    const { container, model } = await openWith([textBlock('제목'), textBlock('본문'), textBlock('(끝)')]);
    vi.spyOn(model, 'uploadFile').mockResolvedValue({ ok: true, path: '/uploads/end.png' });
    caretAtLine(container, 2); // "(끝)" 줄 — 문서 끝 클릭 후 붙여넣기(가장 흔한 시나리오)
    const box = container.querySelector('.yh-editor');
    fireEvent(box, pasteImageEvent(box));

    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());
    // 임베드+빈 줄은 "(끝)" 앞으로 정규화된다: 제목 → 본문 → [이미지] → 빈 줄 → (끝)
    expect(blockTypes(container)).toEqual(['text', 'text', 'embed', 'text', 'text']);
    const texts = Array.from(container.querySelectorAll('.yh-editor__line')).map((el) => el.textContent);
    expect(texts[texts.length - 1]).toBe('(끝)'); // 마커 최종 유지(송고 자격 보존)
  });

  it('업로드 요청 자체가 실패(reject — 서버 다운/네트워크)해도 조용히 넘어가지 않고 alert로 안내한다', async () => {
    const { container, model } = await openWith([textBlock('제목'), textBlock('본문')]);
    vi.spyOn(model, 'uploadFile').mockRejectedValue(new Error('network'));
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    caretAtLine(container, 0);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, pasteImageEvent(box));

    await waitFor(() => expect(alert).toHaveBeenCalledWith('이미지 업로드에 실패했습니다.'));
    expect(container.querySelector('[data-embed-type="image"]')).toBeFalsy(); // 미삽입
    expect(blockTypes(container)).toEqual(['text', 'text']); // 본문 불변
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

// 공통정보 확장 — 공동작성/키워드(text)·내부/외부코멘트(textarea)는 직접 입력, 지역/내용/속성은
// MetaSelectDialog 팝업 선택 전용 트리거(readOnly input — 32-meta-popups step 3) + 첨부/자료파일(file upload).
describe('WriterPage — 공통정보 확장 입력(공동작성/지역/내용/속성/키워드/코멘트)', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  const LABELS = ['공동작성', '내용', '지역', '속성', '키워드', '내부코멘트', '외부코멘트'];

  // 지역/내용/속성 팝업 플로우 — 트리거 클릭 → 팝업에서 항목 체크 → 적용 → 닫힘(값은 이 경로로만 바뀐다).
  async function pickMeta(triggerLabel, items) {
    await userEvent.click(screen.getByLabelText(triggerLabel));
    const dialog = await screen.findByTestId('meta-dialog');
    for (const item of items) {
      await userEvent.click(within(dialog).getByLabelText(item));
    }
    await userEvent.click(within(dialog).getByTestId('meta-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('meta-dialog')).toBeNull());
  }

  it('새 공통정보 입력란이 모두 라벨로 노출된다', () => {
    setup({ identity: { role: 'R' } });
    for (const label of LABELS) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it("내용(분류) 입력란이 라벨 '내용'으로 존재하고, 지역/내용/속성은 팝업 트리거(readOnly)다", () => {
    setup({ identity: { role: 'R' } });
    expect(screen.getByLabelText('내용')).toBeInTheDocument();
    // 직접 타이핑 경로 제거 — 값은 팝업 제출(updateField)로만 바뀐다(news.md "누르면 팝업창이 열리고").
    for (const label of ['지역', '내용', '속성']) {
      expect(screen.getByLabelText(label)).toHaveAttribute('readonly');
    }
  });

  it('입력 변경이 dto(저장)에 반영된다 — 직접 입력(coAuthor/keyword/comments) + 팝업(region/category/attribute)', async () => {
    const { model } = setup({ identity: { role: 'R' } });
    const save = vi.spyOn(model, 'saveArticle');

    await userEvent.type(screen.getByLabelText('공동작성'), '박기자');
    await userEvent.type(screen.getByLabelText('키워드'), 'kw');
    await userEvent.type(screen.getByLabelText('내부코멘트'), '내부');
    await userEvent.type(screen.getByLabelText('외부코멘트'), '외부');
    // 지역/내용/속성은 직접 타이핑 불가(readOnly) — 팝업 선택으로만 값이 들어간다.
    await pickMeta('지역', ['서울']);
    await pickMeta('내용', ['정치일반']);
    await pickMeta('속성', ['단신']);

    // 송고가 아닌 저장 경로를 직접 타기 위해 보류(신규는 전이 없이 RDS 저장)로 dto를 만든다.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // 신규 보류는 제목(첫 줄) 필요 — title 필드는 별도 입력란이 없으므로 본문 에디터 첫 줄로 제목을 만든다.
    const editor = screen.getByRole('textbox', { name: '본문' });
    editor.focus();
    await userEvent.type(editor, '제목줄');
    await userEvent.click(actionBtn('보류'));

    await waitFor(() => expect(save).toHaveBeenCalled());
    const dto = save.mock.calls[save.mock.calls.length - 1][0];
    expect(dto).toMatchObject({
      coAuthor: '박기자', keyword: 'kw', internalComment: '내부', externalComment: '외부',
      region: '서울', category: '정치일반', attribute: '단신',
    });
  });

  it('팝업에서 복수 선택·적용하면 트리거 입력란에 콤마 조인 값이 표시된다', async () => {
    setup({ identity: { role: 'R' } });
    await pickMeta('지역', ['서울', '부산']);
    expect(screen.getByLabelText('지역')).toHaveValue('서울, 부산');
  });

  it('팝업을 다시 열면 현재 필드 값이 체크된 상태로 초기화되고, 추가 선택·적용해도 기존 선택이 보존된다', async () => {
    setup({ identity: { role: 'R' } });
    await pickMeta('지역', ['서울']);

    // 재오픈 — WriterPage가 활성 탭의 현재 값(value)을 팝업에 넘겨야 기존 선택이 체크로 복원된다.
    // 이 결선이 빠지면 재오픈 팝업이 빈 선택으로 시작해 '적용'이 기존 값을 조용히 지운다(비파괴 회귀 잠금).
    await userEvent.click(screen.getByLabelText('지역'));
    const dialog = await screen.findByTestId('meta-dialog');
    expect(within(dialog).getByLabelText('서울')).toBeChecked();

    await userEvent.click(within(dialog).getByLabelText('부산'));
    await userEvent.click(within(dialog).getByTestId('meta-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('meta-dialog')).toBeNull());
    expect(screen.getByLabelText('지역')).toHaveValue('서울, 부산');
  });

  it('팝업이 열린 채 다른 메타 트리거를 클릭하면 새 필드 구성으로 재초기화되고, 이전 필드 선택이 새 필드에 기록되지 않는다', async () => {
    setup({ identity: { role: 'R' } });

    // 지역 팝업을 열고 '서울'을 체크만 한다(적용 없이 필드 전환).
    await userEvent.click(screen.getByLabelText('지역'));
    const regionDialog = await screen.findByTestId('meta-dialog');
    await userEvent.click(within(regionDialog).getByLabelText('서울'));

    // 닫지 않고 속성 트리거 클릭 — open true→true라 같은 인스턴스가 재사용되면 wasOpen 가드가 재초기화를
    // 건너뛰어 지역 selected(['서울'])가 살아남고('기존 값' 섹션 노출), '적용'이 지역 값을 속성 필드에
    // 기록한다(조용한 필드 오염). key={metaDialog} remount로 속성 value 기준 재초기화를 잠근다.
    await userEvent.click(screen.getByLabelText('속성'));
    const attrDialog = await screen.findByRole('dialog', { name: '속성' });
    expect(within(attrDialog).queryByTestId('meta-dialog-legacy')).toBeNull();
    expect(within(attrDialog).queryByLabelText('서울')).toBeNull();

    // 그대로 적용해도 속성 필드에 지역 값이 기록되지 않는다(지역도 적용된 적 없으니 빈 값 유지).
    await userEvent.click(within(attrDialog).getByTestId('meta-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('meta-dialog')).toBeNull());
    expect(screen.getByLabelText('속성')).toHaveValue('');
    expect(screen.getByLabelText('지역')).toHaveValue('');
  });

  it('편집 진입 시 저장된 공통정보 확장 필드가 입력란에 로드된다', async () => {
    setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'RDS' }, mode: 'edit' },
      seed: {
        articles: [{
          articleId: 'AKR1', title: '제목', status: 'RDS', lockYN: 'Y', markupVersion: '제목\n본문',
          coAuthor: '공동기자', region: '대전', category: '정치일반', attribute: '기획', keyword: '키워드값',
          internalComment: '내부메모', externalComment: '외부메모',
        }],
      },
    });
    await waitFor(() => expect(screen.getByLabelText('공동작성')).toHaveValue('공동기자'));
    expect(screen.getByLabelText('지역')).toHaveValue('대전');
    expect(screen.getByLabelText('내용')).toHaveValue('정치일반');
    expect(screen.getByLabelText('속성')).toHaveValue('기획');
    expect(screen.getByLabelText('키워드')).toHaveValue('키워드값');
    expect(screen.getByLabelText('내부코멘트')).toHaveValue('내부메모');
    expect(screen.getByLabelText('외부코멘트')).toHaveValue('외부메모');
  });

  it('매핑 모드에서는 새 공통정보 입력란이 readOnly로 잠기고, 지역/내용/속성 트리거도 팝업을 열지 않는다', async () => {
    setup({
      identity: { role: 'D' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'DPS' }, mode: 'mapping' },
      seed: { articles: [{ articleId: 'AKR1', title: '제목', status: 'DPS', lockYN: 'Y', markupVersion: '제목\n본문', coAuthor: '공동기자' }] },
    });
    await waitFor(() => expect(screen.getByLabelText('공동작성')).toBeInTheDocument());
    for (const label of LABELS) {
      expect(screen.getByLabelText(label)).toHaveAttribute('readonly');
    }
    // 매핑은 공통정보 잠금 — 트리거 클릭이 no-op(팝업 미오픈).
    for (const label of ['지역', '내용', '속성']) {
      await userEvent.click(screen.getByLabelText(label));
      expect(screen.queryByTestId('meta-dialog')).toBeNull();
    }
  });

  it('열린 메타 팝업은 탭 전환 시 닫힌다(팝업 적용이 다른 탭 필드를 덮지 않도록)', async () => {
    setup({ identity: { role: 'R' } });
    await userEvent.click(screen.getByLabelText('속성'));
    await screen.findByTestId('meta-dialog');
    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' }));
    await waitFor(() => expect(screen.queryByTestId('meta-dialog')).toBeNull());
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

  // 업로드는 네트워크 왕복(비동기)이라 대기 창이 넓다. 응답 도착 시점의 활성 탭에 기록하면 대기 중 탭을
  // 바꿨을 때 다른 기사에 첨부가 오기록되고 원래 기사는 첨부를 잃는다 — 시작 시점 탭과 동일할 때만 반영한다
  // (pasteImageAtCaret의 탭 고정 가드와 동형 — 위 'Ctrl+V 이미지 붙여넣기' 탭 전환 테스트 참조).
  it('업로드 대기 중 다른 탭으로 이동하면 첨부파일이 새 탭에 오기록되지 않는다(반영 취소 + 안내)', async () => {
    const { model, container } = setup({ identity: { role: 'R' } });
    let resolveUpload;
    vi.spyOn(model, 'uploadFile').mockImplementation(() => new Promise((res) => { resolveUpload = res; }));
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    // 탭 A를 제목으로 식별 가능하게 만든다(탭 라벨 = 제목 필드 = 본문 첫 줄).
    const editor = screen.getByRole('textbox', { name: '본문' });
    editor.focus();
    await userEvent.type(editor, '탭A제목');

    await userEvent.upload(screen.getByLabelText('첨부파일'), file('a.pdf')); // T0에서 업로드 in-flight
    await waitFor(() => expect(typeof resolveUpload).toBe('function'));

    // 업로드 대기 중 새 작성 탭으로 전환(addTab → 새 탭 활성). 에디터에서 탭 A 본문이 사라지면 전환 완료.
    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' }));
    await waitFor(() => {
      const lines = Array.from(container.querySelectorAll('.yh-editor__line')).map((el) => el.textContent);
      expect(lines).not.toContain('탭A제목');
    });

    await act(async () => { resolveUpload({ ok: true, path: '/uploads/x.pdf' }); });

    // 탭이 바뀌었으므로 반영은 취소되고 안내만 뜬다 — 활성 탭(B)에 path가 오기록되지 않는다.
    await waitFor(() => expect(alert).toHaveBeenCalledWith('편집 탭이 바뀌어 파일 첨부가 취소되었습니다.'));
    expect(screen.queryByText('/uploads/x.pdf')).toBeNull();

    // 원래 탭(A)로 돌아와도 취소라 미반영(늦은 응답이 어느 탭에도 새지 않음).
    await userEvent.click(screen.getByRole('button', { name: '탭A제목' }));
    await waitFor(() => expect(screen.getByLabelText('첨부파일')).toBeInTheDocument());
    expect(screen.queryByText('/uploads/x.pdf')).toBeNull();
  });

  it('업로드 대기 중 다른 탭으로 이동하면 자료파일이 새 탭에 오기록되지 않는다(반영 취소 + 안내)', async () => {
    const { model, container } = setup({ identity: { role: 'R' } });
    let resolveUpload;
    vi.spyOn(model, 'uploadFile').mockImplementation(() => new Promise((res) => { resolveUpload = res; }));
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    const editor = screen.getByRole('textbox', { name: '본문' });
    editor.focus();
    await userEvent.type(editor, '탭A제목');

    await userEvent.upload(screen.getByLabelText('자료파일'), file('r.docx')); // T0에서 업로드 in-flight
    await waitFor(() => expect(typeof resolveUpload).toBe('function'));

    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' }));
    await waitFor(() => {
      const lines = Array.from(container.querySelectorAll('.yh-editor__line')).map((el) => el.textContent);
      expect(lines).not.toContain('탭A제목');
    });

    await act(async () => { resolveUpload({ ok: true, path: '/uploads/r.docx' }); });

    await waitFor(() => expect(alert).toHaveBeenCalledWith('편집 탭이 바뀌어 파일 첨부가 취소되었습니다.'));
    expect(screen.queryByText('/uploads/r.docx')).toBeNull();
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

// 첨부/자료파일 링크 href 가드 — DB 원본값을 스킴 검증 없이 <a href>로 렌더하면 조작된 값
// (javascript: 등)이 편집 화면에서 클릭 시 실행된다(저장형 XSS). isAllowedHref(clipboardEmbed.js,
// phase 19 URL 검증 단일 출처)로 걸러 비허용 값은 링크 없이 텍스트(textNode)로만 표시한다.
describe('WriterPage — 첨부/자료파일 링크 href 가드', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  // 저장된 첨부/자료값을 가진 기사로 편집 진입한 WriterPage를 띄우고 두 값이 표시될 때까지 기다린다.
  async function openWithFiles({ attachmentFile, referenceFile }) {
    const utils = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'RDS' }, mode: 'edit' },
      seed: {
        articles: [{
          articleId: 'AKR1', title: '제목', status: 'RDS', lockYN: 'Y', markupVersion: '제목\n본문',
          attachmentFile, referenceFile,
        }],
      },
    });
    await waitFor(() => expect(screen.getByText(attachmentFile)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(referenceFile)).toBeInTheDocument());
    return utils;
  }

  it('javascript: 스킴 첨부/자료값은 클릭 가능한 링크로 렌더되지 않는다(텍스트로만 표시)', async () => {
    const { container } = await openWithFiles({
      attachmentFile: 'javascript:alert(1)', referenceFile: 'javascript:alert(2)',
    });
    // 파일명 텍스트는 보이되(이스케이프된 textNode) <a>가 아니어야 한다.
    expect(screen.getByText('javascript:alert(1)').closest('a')).toBeNull();
    expect(screen.getByText('javascript:alert(2)').closest('a')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    // 나머지 UI(지우기 버튼)는 유지된다.
    expect(screen.getByRole('button', { name: '첨부파일 지우기' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '자료파일 지우기' })).toBeInTheDocument();
  });

  it('상대경로(/uploads/...) 첨부/자료값은 기존대로 링크로 렌더된다', async () => {
    await openWithFiles({
      attachmentFile: '/uploads/stored-a.pdf', referenceFile: '/uploads/stored-r.docx',
    });
    const attach = screen.getByText('/uploads/stored-a.pdf').closest('a');
    expect(attach).not.toBeNull();
    expect(attach).toHaveAttribute('href', '/uploads/stored-a.pdf');
    const ref = screen.getByText('/uploads/stored-r.docx').closest('a');
    expect(ref).not.toBeNull();
    expect(ref).toHaveAttribute('href', '/uploads/stored-r.docx');
  });

  it('https://는 링크로 렌더되고 http://는 링크로 렌더되지 않는다(isAllowedHref 규칙 일치)', async () => {
    await openWithFiles({
      attachmentFile: 'https://example.com/x.pdf', referenceFile: 'http://evil.example/x.pdf',
    });
    const attach = screen.getByText('https://example.com/x.pdf').closest('a');
    expect(attach).not.toBeNull();
    expect(attach).toHaveAttribute('href', 'https://example.com/x.pdf');
    expect(screen.getByText('http://evil.example/x.pdf').closest('a')).toBeNull();
  });

  it('프로토콜상대(//host) 값은 링크로 렌더되지 않는다', async () => {
    const { container } = await openWithFiles({
      attachmentFile: '//evil.example/x.pdf', referenceFile: '/uploads/ok.pdf',
    });
    expect(screen.getByText('//evil.example/x.pdf').closest('a')).toBeNull();
    expect(container.querySelector('a[href="//evil.example/x.pdf"]')).toBeNull();
    // 같은 화면의 정상 상대경로 링크는 영향 없다.
    expect(screen.getByText('/uploads/ok.pdf').closest('a')).toHaveAttribute('href', '/uploads/ok.pdf');
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

    await openTopMenu('보기');
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
    await openTopMenu('편집');
    await userEvent.click(screen.getByText('(끝)삽입'));
    await waitFor(() => expect(editorLines(container)).toContain('(끝)'));
  });

  it("편집>'(계속)삽입'(edit.insertContinue) 메뉴 클릭 시 캐럿 줄 다음에 (계속)이 삽입된다", async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 0); // 헤드 줄

    await openTopMenu('편집');
    await userEvent.click(screen.getByText('(계속)삽입'));

    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '(계속)', '본문']));
  });

  it('되돌리기·다시실행이 활성이고, 도구 UI 언어 설정(tools.uiLanguage)도 결선돼 활성이다', async () => {
    // 되돌리기/다시실행(edit.undo/redo)은 37-editor-undo-redo에서 결선돼 활성이고(찾기/바꾸기=14,
    // 파일 메뉴=34, 클립보드 5종=36과 동일 계보), 도구 'UI 언어 설정'(tools.uiLanguage)도
    // 42-editor-ui-language step3에서 결선돼 활성이다(도구 15항목 전부 결선 — 미결선 항목 없음).
    await openWith([textBlock('헤드'), textBlock('본문')]);
    // 드롭다운으로 스코프(툴바에도 같은 라벨 버튼이 있어 메뉴 항목만 본다).
    await openTopMenu('편집');
    const menu = screen.getByTestId('menu-편집');
    expect(within(menu).getByText('되돌리기').closest('button')).toBeEnabled();
    expect(within(menu).getByText('다시실행').closest('button')).toBeEnabled();
    await openTopMenu('도구');
    expect(within(screen.getByTestId('menu-도구')).getByText('UI 언어 설정').closest('button')).toBeEnabled();
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

    await openTopMenu('보기');
    await userEvent.click(screen.getByText('대문자로 바꾸기'));

    // 매핑은 본문-only 불변식 — 대문자 변환이 적용되지 않는다.
    expect(editorLines(container)[0]).toBe('title abc');
  });
});

// Step 2(35-editor-view-align): 보기 정렬(양쪽/왼쪽/가운데/오른쪽) 결선 — 대소문자 변환과 동형 dispatch.
// 마지막 캐럿 텍스트-줄에 setLineAlign을 적용하고 commitBody(serialize) 단일 경로로 반영한다(임베드·다른 줄·"(끝)" 불변).
// 정렬은 DOM `.yh-editor__line[data-align]`(step1 렌더)로 검증한다.
describe('WriterPage — 보기 정렬 결선(EditorMenuBar view.align*)', () => {
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

  // 마지막 캐럿(lastCaretRef)을 lineIndex 줄로 갱신(keyUp→onCaretChange — 대소문자/약물 결선과 동일 경로).
  function focusCaretAtLine(container, lineIndex) {
    caretAtLine(container, lineIndex);
    fireEvent.keyUp(container.querySelector('.yh-editor'));
  }

  const editorLines = (container) => Array.from(
    container.querySelectorAll('.yh-editor .yh-editor__line'),
  ).map((el) => el.textContent);
  // 텍스트 줄별 data-align 속성(미정렬은 null).
  const alignAttrs = (container) => Array.from(
    container.querySelectorAll('.yh-editor .yh-editor__line'),
  ).map((el) => el.getAttribute('data-align'));

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

  it("보기>'가운데로 정렬' 클릭 시 캐럿 줄만 data-align='center'가 되고 다른 줄·임베드는 불변이다", async () => {
    const { container } = await openWith([
      textBlock('제목'), embedBlock({ embedType: 'image', src: 'x.png' }), textBlock('본문'),
    ]);
    focusCaretAtLine(container, 1); // 텍스트-줄 1 = '본문'(임베드 제외 좌표)

    await openTopMenu('보기');
    await userEvent.click(screen.getByText('가운데로 정렬'));

    await waitFor(() => expect(alignAttrs(container)).toEqual([null, 'center'])); // 캐럿 줄만 center
    expect(editorLines(container)).toEqual(['제목', '본문']); // 텍스트 불변(임베드가 텍스트 줄로 변질 안 됨)
    expect(container.querySelector('.yh-embed')).toBeTruthy(); // 임베드 생존
  });

  it('4종 정렬 각각 해당 값으로 캐럿 줄에 반영된다(양쪽→justify/왼쪽→left/가운데→center/오른쪽→right)', async () => {
    for (const [label, value] of [
      ['양쪽으로 정렬', 'justify'], ['왼쪽으로 정렬', 'left'],
      ['가운데로 정렬', 'center'], ['오른쪽으로 정렬', 'right'],
    ]) {
      sessionStorage.clear();
      const { container, unmount } = await openWith([textBlock('제목'), textBlock('본문')]);
      focusCaretAtLine(container, 1);

      await openTopMenu('보기');
      await userEvent.click(screen.getByText(label));

      await waitFor(() => expect(
        container.querySelectorAll('.yh-editor__line')[1].getAttribute('data-align'),
      ).toBe(value));
      expect(container.querySelectorAll('.yh-editor__line')[0].getAttribute('data-align')).toBeNull();
      unmount(); // 다음 라벨 렌더 전 정리(단일 트리 유지 — screen 조회 모호성 방지).
    }
  });

  it('매핑 모드에서는 정렬 클릭이 본문(정렬)을 바꾸지 않는다(본문-only 불변식)', async () => {
    const { container } = await openWith(
      [textBlock('제목'), textBlock('본문')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    focusCaretAtLine(container, 1);

    await openTopMenu('보기');
    await userEvent.click(screen.getByText('가운데로 정렬'));

    expect(alignAttrs(container)).toEqual([null, null]); // 정렬 미적용(no-op)
  });

  it('캐럿이 없으면(에디터 미포커스) 정렬 클릭은 no-op이다', async () => {
    const { container } = await openWith([textBlock('제목'), textBlock('본문')]);
    // 캐럿 세팅 없음 → lastCaretRef.current === null(대소문자 변환과 동일 no-op 조건).

    await openTopMenu('보기');
    await userEvent.click(screen.getByText('가운데로 정렬'));

    expect(alignAttrs(container)).toEqual([null, null]); // 정렬 미적용(no-op)
  });

  it('이미 그 정렬인 줄에 같은 정렬 재클릭은 no-op이다(changed:false → 미커밋)', async () => {
    const { container } = await openWith([textBlock('제목'), textBlock('본문', 'center')]);
    focusCaretAtLine(container, 1);

    await openTopMenu('보기');
    await userEvent.click(screen.getByText('가운데로 정렬'));

    // 이미 center — 변화 없이 그대로 유지(setLineAlign changed:false는 step0 단위테스트가 보증).
    expect(alignAttrs(container)).toEqual([null, 'center']);
    expect(editorLines(container)).toEqual(['제목', '본문']);
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
    await openTopMenu('도움말');
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
    await openTopMenu('도움말');
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

// Step 1(33-editor-linespacing-effect): 편집>줄간격(edit.lineSpacing)을 WriterPage 캔버스 래퍼(editor-canvas)
// 레벨에서 CSS 변수(--yh-editor-line-height) 주입으로 적용(columnLimit 동형 게이트 — 마운트 적용 + onPrefsClose(applied)).
// 자식 .yh-editor/.yh-editor__line의 line-height/min-height가 var()로 이 변수를 상속한다(주입 없으면 fallback 1.8). Editor.jsx 무변경.
describe('WriterPage — 편집>줄간격(editor-canvas line-height 변수) 적용', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { resetEditorColors(); });

  // 편집 탭의 lineSpacing만 저장(다른 카테고리는 기본값 유지).
  const saveLineSpacing = (v) => saveEditorPrefs({
    ...loadEditorPrefs(),
    edit: { ...loadEditorPrefs().edit, lineSpacing: v },
  });

  async function openPrefsViaMenu() {
    await openTopMenu('도움말');
    await userEvent.click(screen.getByText('환경설정'));
  }

  const lineHeightVar = (el) => el.style.getPropertyValue('--yh-editor-line-height');

  it('lineSpacing=1.5로 저장된 상태로 렌더하면 editor-canvas가 변수를 1.5로 반영한다', () => {
    saveLineSpacing(1.5);
    const { getByTestId } = setup({ identity: { role: 'R' } });
    expect(lineHeightVar(getByTestId('editor-canvas'))).toBe('1.5');
  });

  it('미저장(기본)이면 변수가 step0 기본 1.8로 주입된다', () => {
    const { getByTestId } = setup({ identity: { role: 'R' } });
    expect(lineHeightVar(getByTestId('editor-canvas'))).toBe('1.8');
  });

  it('레거시 lineSpacing=1.0으로 저장돼 있어도 변수는 1.8로 정규화된다(정규화 회귀 가드)', () => {
    saveLineSpacing(1.0);
    const { getByTestId } = setup({ identity: { role: 'R' } });
    expect(lineHeightVar(getByTestId('editor-canvas'))).toBe('1.8');
  });

  it('배경색·컬럼제한·줄간격을 함께 저장하면 셋 다 캔버스에 공존한다(회귀 없음)', () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      colors: { ...loadEditorPrefs().colors, background: '#123456' },
      edit: { ...loadEditorPrefs().edit, columnLimit: true, lineSpacing: 1.5 },
    });
    const { getByTestId } = setup({ identity: { role: 'R' } });
    const canvas = getByTestId('editor-canvas');
    expect(canvas).toHaveStyle({ backgroundColor: '#123456' });
    expect(canvas).toHaveStyle({ paddingLeft: '10%', paddingRight: '10%' });
    expect(lineHeightVar(canvas)).toBe('1.5');
  });

  it("편집 탭에서 줄간격 2.0을 골라 '적용'하면 변수가 '2'로 반영된다(2.0 직렬화 = '2')", async () => {
    setup({ identity: { role: 'R' } });
    expect(lineHeightVar(screen.getByTestId('editor-canvas'))).toBe('1.8'); // 적용 전 기본

    await openPrefsViaMenu();
    await userEvent.click(screen.getByTestId('prefs-tab-edit'));
    // React가 value={2.0}을 "2"로 직렬화하므로 selectOptions에도 '2'를 넘긴다('2.0'은 무매칭).
    await userEvent.selectOptions(screen.getByTestId('pref-edit-lineSpacing'), '2');
    fireEvent.click(screen.getByTestId('prefs-apply'));

    await waitFor(() => expect(loadEditorPrefs().edit.lineSpacing).toBe(2));
    await waitFor(() => expect(lineHeightVar(screen.getByTestId('editor-canvas'))).toBe('2'));
  });

  it("'취소' 시 줄간격 변수가 바뀌지 않는다(columnLimit 게이트와 동일 — 적용 시에만 갱신)", async () => {
    setup({ identity: { role: 'R' } });
    await openPrefsViaMenu();
    await userEvent.click(screen.getByTestId('prefs-tab-edit'));
    await userEvent.selectOptions(screen.getByTestId('pref-edit-lineSpacing'), '2');
    fireEvent.click(screen.getByTestId('prefs-cancel'));

    expect(loadEditorPrefs().edit.lineSpacing).toBe(DEFAULT_EDITOR_PREFS.edit.lineSpacing); // 저장 불변(1.8)
    expect(lineHeightVar(screen.getByTestId('editor-canvas'))).toBe('1.8'); // 변수 불변
  });
});

// Step 3(40-editor-lang-inputmode): 편집>언어(edit.language)·입력모드(edit.inputMode)를 상태표시줄(step2)과
// Editor 편집 div lang 속성에 결선(columnLimit/lineSpacing 동형 게이트 — 마운트 + onPrefsClose(applied), 취소 불변).
// StatusBar엔 raw(폴백·정규화는 StatusBar 내부), Editor lang엔 normalizeLanguage 결과(HTML엔 유효 코드만).
describe('WriterPage — 편집>언어·입력모드(상태표시줄·Editor lang) 결선', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { resetEditorColors(); });

  // 편집 탭의 language/inputMode만 부분 저장(다른 카테고리는 기본값 유지) — columnLimit 저장 헬퍼와 동형.
  const saveEdit = (patch) => saveEditorPrefs({
    ...loadEditorPrefs(),
    edit: { ...loadEditorPrefs().edit, ...patch },
  });

  async function openPrefsViaMenu() {
    await openTopMenu('도움말');
    await userEvent.click(screen.getByText('환경설정'));
  }

  // 본문(markupVersion)을 가진 기사로 편집 진입 — 상태표시줄 바이트 검증용 한글 본문.
  async function openWith(blocks) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '한글', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  const editorLang = () => screen.getByRole('textbox', { name: '본문' }).getAttribute('lang');

  it("미저장(기본)이면 상태표시줄 언어 '한글'(ko), 편집 div lang='ko'다", () => {
    setup({ identity: { role: 'R' } });
    expect(screen.getByTestId('stat-language')).toHaveTextContent('한글');
    expect(editorLang()).toBe('ko');
  });

  it("language='en' 저장 상태로 렌더하면 언어 '영어', 편집 div lang='en'이다", () => {
    saveEdit({ language: 'en' });
    setup({ identity: { role: 'R' } });
    expect(screen.getByTestId('stat-language')).toHaveTextContent('영어');
    expect(editorLang()).toBe('en');
  });

  it("미지원 language='xx' 저장이면 언어 '한글' 폴백, 편집 div lang='ko'(normalizeLanguage)다", () => {
    saveEdit({ language: 'xx' });
    setup({ identity: { role: 'R' } });
    expect(screen.getByTestId('stat-language')).toHaveTextContent('한글');
    expect(editorLang()).toBe('ko');
  });

  it("inputMode='ksc5601' 저장이면 stat-bytes가 EUC-KR 근사값('한글'=4B), 기본(unicode)은 UTF-8(6B)이다", async () => {
    saveEdit({ inputMode: 'ksc5601' });
    await openWith([textBlock('한글')]);
    expect(screen.getByTestId('stat-bytes')).toHaveTextContent('4B');
  });

  it('기본(unicode) 렌더는 UTF-8 바이트를 표시한다(현행 불변)', async () => {
    await openWith([textBlock('한글')]);
    expect(screen.getByTestId('stat-bytes')).toHaveTextContent('6B');
  });

  it("편집 탭에서 언어 'en'·입력모드 'ksc5601'을 골라 '적용'하면 라벨·lang·바이트가 라이브 반영된다", async () => {
    await openWith([textBlock('한글')]);
    expect(screen.getByTestId('stat-language')).toHaveTextContent('한글');
    expect(screen.getByTestId('stat-bytes')).toHaveTextContent('6B'); // 적용 전 UTF-8

    await openPrefsViaMenu();
    await userEvent.click(screen.getByTestId('prefs-tab-edit'));
    await userEvent.selectOptions(screen.getByTestId('pref-edit-language'), 'en');
    await userEvent.selectOptions(screen.getByTestId('pref-edit-inputMode'), 'ksc5601');
    fireEvent.click(screen.getByTestId('prefs-apply'));

    await waitFor(() => expect(loadEditorPrefs().edit.language).toBe('en'));
    await waitFor(() => expect(screen.getByTestId('stat-language')).toHaveTextContent('영어'));
    expect(editorLang()).toBe('en');
    expect(screen.getByTestId('stat-bytes')).toHaveTextContent('4B'); // EUC-KR 근사
  });

  it("'취소' 시 언어·입력모드가 바뀌지 않는다(columnLimit 게이트와 동일 — 적용 시에만 갱신)", async () => {
    await openWith([textBlock('한글')]);
    await openPrefsViaMenu();
    await userEvent.click(screen.getByTestId('prefs-tab-edit'));
    await userEvent.selectOptions(screen.getByTestId('pref-edit-language'), 'en');
    await userEvent.selectOptions(screen.getByTestId('pref-edit-inputMode'), 'ksc5601');
    fireEvent.click(screen.getByTestId('prefs-cancel'));

    expect(loadEditorPrefs().edit.language).toBe('ko'); // 저장 불변
    expect(loadEditorPrefs().edit.inputMode).toBe('unicode'); // 저장 불변
    expect(screen.getByTestId('stat-language')).toHaveTextContent('한글'); // 라벨 불변
    expect(editorLang()).toBe('ko'); // lang 불변
    expect(screen.getByTestId('stat-bytes')).toHaveTextContent('6B'); // UTF-8 불변
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

  // 파일>복구 클릭. 메뉴는 항목 선택 시 닫히므로(EditorMenuBar 규약 — 선택 즉시 닫힘) 호출마다
  // 드롭다운이 닫혀 있으면 다시 연다. 재복구(연속 호출)에서도 안전하게 동작한다.
  async function clickRecover() {
    if (!screen.queryByTestId('menu-파일')) {
      await openTopMenu('파일');
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

// Step 0(34-editor-file-menu): 파일 메뉴 '새문서'(file.new)·'닫기'(file.close) 결선 —
// 컨트롤러 addTab/closeTab에 위임(새 빈 탭 열기 / 활성 탭 닫기 — × 버튼과 동일 경로, 편집 탭이면 잠금 해제).
describe('WriterPage — 파일 메뉴(새문서/닫기)', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  // writer-tabs 스트립의 문서 탭(span.yh-tab)만 센다 — ＋ 버튼(.yh-tab__add)·메타 탭(별 컨테이너)은 제외.
  const docTabs = (container) => container.querySelectorAll('[data-testid="writer-tabs"] > .yh-tab');
  const activeDocTab = (container) => container.querySelector('[data-testid="writer-tabs"] .yh-tab--active');

  // 파일 메뉴를 열고 항목을 클릭한다(복구 결선과 동일 패턴 — 메뉴는 선택 즉시 닫히므로 매번 다시 연다).
  async function clickFileItem(label) {
    if (!screen.queryByTestId('menu-파일')) await openTopMenu('파일');
    await userEvent.click(within(screen.getByTestId('menu-파일')).getByText(label).closest('button'));
  }

  it("'새문서'·'닫기'가 활성(enabled)이다(placeholder→결선)", async () => {
    setup({ identity: { role: 'R' } });
    await openTopMenu('파일');
    const menu = screen.getByTestId('menu-파일');
    expect(within(menu).getByText('새문서').closest('button')).toBeEnabled();
    expect(within(menu).getByText('닫기').closest('button')).toBeEnabled();
  });

  it("'새문서' 클릭 시 빈 새 탭이 1개 추가되고 활성화된다", async () => {
    const { container } = setup({ identity: { role: 'R' } });
    expect(docTabs(container)).toHaveLength(1);

    await clickFileItem('새문서');

    await waitFor(() => expect(docTabs(container)).toHaveLength(2));
    // 새로 추가된(마지막) 탭이 활성 + 빈 본문(신규 → 라벨 '새 기사').
    expect(activeDocTab(container)).toBe(docTabs(container)[1]);
    expect(within(activeDocTab(container)).getByText('새 기사')).toBeInTheDocument();
  });

  it("'닫기'(다중 탭) 클릭 시 활성 탭이 제거되고 개수가 1 감소한다", async () => {
    const { container } = setup({ identity: { role: 'R' } });
    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' })); // ＋ → 2탭(새 탭 활성)
    await waitFor(() => expect(docTabs(container)).toHaveLength(2));

    await clickFileItem('닫기');

    await waitFor(() => expect(docTabs(container)).toHaveLength(1));
  });

  it("'닫기'(마지막 탭) 클릭 시 빈 새 기사 탭 1개가 유지된다(0으로 떨어지지 않음)", async () => {
    const { container } = setup({ identity: { role: 'R' } });
    expect(docTabs(container)).toHaveLength(1);

    await clickFileItem('닫기');

    // 마지막 탭 닫기 → 빈 새 기사 탭 1개 유지(개수 불변).
    await waitFor(() => expect(docTabs(container)).toHaveLength(1));
    expect(within(activeDocTab(container)).getByText('새 기사')).toBeInTheDocument();
  });

  it("'닫기'(편집 탭) 클릭 시 그 기사의 잠금을 해제한다(unlockArticle 호출)", async () => {
    const { model, container } = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y', markupVersion: serialize([textBlock('제목')]) }] },
    });
    // 편집 탭이 로드(에디터 본문 렌더)될 때까지 대기 — openArticle가 이 탭을 활성으로 둔다.
    await waitFor(() => expect(container.querySelector('.yh-editor__line')).toBeTruthy());
    const unlock = vi.spyOn(model, 'unlockArticle');

    await clickFileItem('닫기');

    await waitFor(() => expect(unlock).toHaveBeenCalledWith('AKR1', expect.anything()));
  });
});

// Step 1(34-editor-file-menu): 파일 메뉴 '인쇄'(file.print)·'인쇄미리보기'(file.printPreview) 결선 —
// 현재 편집 탭 본문·공통정보를 상세보기(renderPrintHtml→renderDetailHtml) 형태로 새 창에 동기 렌더.
// 인쇄만 렌더 후 w.print()까지, 인쇄미리보기는 창만 연다. (ListPage.openDetail의 async 재조회 없는 동기 버전)
describe('WriterPage — 파일 메뉴(인쇄/인쇄미리보기)', () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  // 새 창 fake — document.open/write/close + print를 스파이로 잡는다(원복은 beforeEach의 restoreAllMocks).
  const fakeWindow = () => ({
    document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
    print: vi.fn(),
  });

  // 파일 메뉴를 열고 항목을 클릭한다(step0 결선과 동일 패턴 — 메뉴는 선택 즉시 닫히므로 매번 다시 연다).
  async function clickFileItem(label) {
    if (!screen.queryByTestId('menu-파일')) await openTopMenu('파일');
    await userEvent.click(within(screen.getByTestId('menu-파일')).getByText(label).closest('button'));
  }

  // 제목(첫 줄)이 든 본문으로 편집 탭을 연다 — 인쇄 HTML에 그 제목이 나타나는지 검증용.
  async function openEditTab(title) {
    const body = serialize([textBlock(title)]);
    const utils = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title, status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', status: 'RDS', lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  it("'인쇄'·'인쇄미리보기'가 활성(enabled)이다(placeholder→결선)", async () => {
    setup({ identity: { role: 'R' } });
    await openTopMenu('파일');
    const menu = screen.getByTestId('menu-파일');
    expect(within(menu).getByText('인쇄').closest('button')).toBeEnabled();
    expect(within(menu).getByText('인쇄미리보기').closest('button')).toBeEnabled();
  });

  it("'인쇄' 클릭 시 새 창을 열어 인쇄 HTML을 write하고 w.print()를 호출한다", async () => {
    const w = fakeWindow();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(w);
    await openEditTab('인쇄될 제목');

    await clickFileItem('인쇄');

    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    expect(w.document.write).toHaveBeenCalledTimes(1);
    const html = w.document.write.mock.calls[0][0];
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('인쇄될 제목');
    expect(w.print).toHaveBeenCalledTimes(1);
  });

  it("'인쇄미리보기' 클릭 시 새 창을 열어 write하나 w.print()는 호출하지 않는다(인쇄와의 유일한 차이)", async () => {
    const w = fakeWindow();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(w);
    await openEditTab('미리보기 제목');

    await clickFileItem('인쇄미리보기');

    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    expect(w.document.write).toHaveBeenCalledTimes(1);
    expect(w.print).not.toHaveBeenCalled();
  });

  it('window.open이 null(팝업 차단)이어도 예외 없이 no-op이다', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    await openEditTab('차단 제목');

    // 예외 없이 통과해야 한다(fake window 없음 → w.document 접근 방어).
    await clickFileItem('인쇄');
    expect(openSpy).toHaveBeenCalled();
  });
});

// Step 2(34-editor-file-menu): 파일 메뉴 '저장'(file.save)·'다른이름으로 저장'(file.saveAs) 결선 —
// 저장은 기사 상태로 갈린다(기존=서버 PUT 부분수정, 신규=로컬 초안만·DB 미생성). 다른이름으로 저장은 현재 본문을 새 기사로 POST(복제본).
describe('WriterPage — 파일 메뉴(저장/다른이름으로 저장)', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });

  const docTabs = (container) => container.querySelectorAll('[data-testid="writer-tabs"] > .yh-tab');
  const editorLines = (container) => Array.from(
    container.querySelectorAll('.yh-editor .yh-editor__line'),
  ).map((el) => el.textContent);
  // localStorage 초안 저장소(yh.editorDrafts) 원본을 파싱한다(신규 탭 초안 key 검증용).
  const readDraftsStore = () => {
    try { return JSON.parse(localStorage.getItem('yh.editorDrafts')) || {}; }
    catch { return {}; }
  };

  // 파일 메뉴를 열고 항목을 클릭한다(step0/step1 패턴 — 메뉴는 선택 즉시 닫히므로 매번 다시 연다).
  async function clickFileItem(label) {
    if (!screen.queryByTestId('menu-파일')) await openTopMenu('파일');
    await userEvent.click(within(screen.getByTestId('menu-파일')).getByText(label).closest('button'));
  }

  // 본문(markupVersion)을 가진 기사로 편집 탭을 연다(기존 기사 저장 검증용).
  async function openEditTab({ articleId = 'AKR1', status = 'RDS', role = 'R' } = {}) {
    const body = serialize([textBlock('제목'), textBlock('본문')]);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId, title: '제목', status }, mode: 'edit' },
      seed: { articles: [{ articleId, status, lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  it("'저장'·'다른이름으로 저장'이 활성(enabled)이다(placeholder→결선)", async () => {
    setup({ identity: { role: 'R' } });
    await openTopMenu('파일');
    const menu = screen.getByTestId('menu-파일');
    expect(within(menu).getByText('저장').closest('button')).toBeEnabled();
    expect(within(menu).getByText('다른이름으로 저장').closest('button')).toBeEnabled();
  });

  it("'저장'(기존 편집 탭): PUT(dto.articleId 포함)로 저장하고 전이/unlock/탭 리셋이 없다", async () => {
    const { model, container } = await openEditTab();
    const save = vi.spyOn(model, 'saveArticle');
    const apply = vi.spyOn(model, 'applyAction');
    const unlock = vi.spyOn(model, 'unlockArticle');
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    const tabCountBefore = docTabs(container).length; // 빈 새 기사 탭 + 편집 탭

    await clickFileItem('저장');

    await waitFor(() => expect(save).toHaveBeenCalled());
    const dto = save.mock.calls[save.mock.calls.length - 1][0];
    expect(dto.articleId).toBe('AKR1'); // PUT(부분 수정) — 기존 기사
    expect(apply).not.toHaveBeenCalled(); // 상태 전이 없음(편집 유지)
    expect(unlock).not.toHaveBeenCalled(); // 잠금 해제 없음(편집 유지)
    // 탭 리셋/추가 없음 — 개수 불변, 편집 본문도 그대로 유지된다.
    expect(docTabs(container).length).toBe(tabCountBefore);
    expect(editorLines(container)).toEqual(['제목', '본문']);
  });

  it("'저장'(신규 탭): POST를 내지 않고 tab.id 키로 로컬 초안만 저장한다(DB 미오염)", async () => {
    const { model, container } = setup({ identity: { role: 'R' } }); // 신규 빈 탭(articleId 없음)
    const save = vi.spyOn(model, 'saveArticle');
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    // 본문 입력 → onTextChange가 tab.fields.body를 채운다(autosave 테스트와 동일 경로).
    const editor = container.querySelector('.yh-editor');
    editor.textContent = '신규본문';
    fireEvent.input(editor);

    await clickFileItem('저장');

    expect(save).not.toHaveBeenCalled(); // 신규 POST 금지 — 송고 전 DB에 draft 행을 만들지 않는다(이 phase 핵심)
    const store = readDraftsStore();
    const keys = Object.keys(store);
    expect(keys).toHaveLength(1); // 활성(신규) 탭 1개의 초안만
    expect(keys[0]).toMatch(/^tab-/); // 신규 탭 key=tab.id(자동저장/파일>복구와 동일 규약)
    expect(blocksToText(deserialize(store[keys[0]].data.body))).toContain('신규본문');
  });

  it("'저장'(신규 탭) 초안은 파일>복구가 같은 tab.id 키로 되살릴 수 있다(key 규약 일치)", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { container } = setup({ identity: { role: 'R' } });
    const editor = container.querySelector('.yh-editor');
    editor.textContent = '복구대상본문';
    fireEvent.input(editor);

    await clickFileItem('저장'); // tab.id 키로 초안 저장

    // 본문을 다른 내용으로 바꾼 뒤 복구 → 초안 본문이 되살아난다(같은 tab.id 키로 조회).
    editor.textContent = '지워짐';
    fireEvent.input(editor);
    await clickFileItem('복구');

    await waitFor(() => expect(editorLines(container).join('\n')).toContain('복구대상본문'));
  });

  it("'다른이름으로 저장': articleId 없는 dto(POST)로 저장하고 현재 탭 정체성은 불변이다", async () => {
    const { model, container } = await openEditTab();
    await waitFor(() => expect(document.title).toBe('AKR1')); // 현재 탭=원본 AKR1 편집 중
    const save = vi.spyOn(model, 'saveArticle');
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    const tabCountBefore = docTabs(container).length;

    await clickFileItem('다른이름으로 저장');

    await waitFor(() => expect(save).toHaveBeenCalled());
    const last = save.mock.calls[save.mock.calls.length - 1];
    expect(last[0].articleId).toBeUndefined(); // POST(복제본) — 원본 articleId 미포함
    expect(last[1]).toBeUndefined(); // clientId 미전달(새 기사는 잠금 대상 아님)
    // 현재 탭은 여전히 원본(AKR1)을 편집 중 — 복제본이 현재 문서를 하이재킹하지 않는다(articleId 재바인딩 없음).
    expect(document.title).toBe('AKR1');
    expect(docTabs(container).length).toBe(tabCountBefore); // 탭 추가/리셋 없음
  });

  it("'다른이름으로 저장' 실패({ ok:false }) 시 실패 alert를 띄운다", async () => {
    const { model } = await openEditTab();
    vi.spyOn(model, 'saveArticle').mockResolvedValue({ ok: false });
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await clickFileItem('다른이름으로 저장');

    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining('실패')));
  });
});

// Step 3(34-editor-file-menu): 파일 메뉴 '문서열기'(file.open) 결선 — DB 기사 피커 다이얼로그(DocumentOpenDialog)를
// 열어 목록/검색으로 기사를 고르면 편집 진입 단일 경로(openArticle → getArticle + lockArticle, 잠금/dedup/locked)로 편집 탭을 연다.
describe('WriterPage — 파일 메뉴(문서열기)', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });

  const docTabs = (container) => container.querySelectorAll('[data-testid="writer-tabs"] > .yh-tab');

  // 파일 메뉴를 열고 항목을 클릭한다(step0~2 패턴 — 메뉴는 선택 즉시 닫히므로 매번 다시 연다).
  async function clickFileItem(label) {
    if (!screen.queryByTestId('menu-파일')) await openTopMenu('파일');
    await userEvent.click(within(screen.getByTestId('menu-파일')).getByText(label).closest('button'));
  }

  // 매 호출마다 새 기사 객체를 만든다 — fakeModel.lockArticle이 잠금 시 객체를 mutate(lockYN/lockerClientId)하므로,
  // 공유 리터럴을 쓰면 이전 테스트의 잠금이 다음 테스트로 새어 dedup 등이 깨진다(테스트 격리).
  const pickerSeed = () => ({
    articles: [
      { articleId: 'AKR1', title: '첫 기사', status: 'RDS', lockYN: 'N', markupVersion: serialize([textBlock('첫 기사')]) },
      { articleId: 'AKR2', title: '둘째 기사', status: 'DPS', lockYN: 'N', markupVersion: serialize([textBlock('둘째 기사')]) },
    ],
  });

  it("'문서열기'가 활성(enabled)이다(placeholder→결선)", async () => {
    setup({ identity: { role: 'R' } });
    await openTopMenu('파일');
    expect(within(screen.getByTestId('menu-파일')).getByText('문서열기').closest('button')).toBeEnabled();
  });

  it("'문서열기' 클릭 시 다이얼로그가 열리고 queryArticles로 받은 목록이 보인다", async () => {
    const { model } = setup({ identity: { role: 'R' }, seed: pickerSeed() });
    const query = vi.spyOn(model, 'queryArticles');

    await clickFileItem('문서열기');

    await waitFor(() => expect(screen.getByTestId('doc-open-dialog')).toBeInTheDocument());
    expect(query).toHaveBeenCalled(); // 초기 목록은 controller passthrough queryArticles로 채운다(ADR-003)
    await waitFor(() => expect(screen.getByText('첫 기사')).toBeInTheDocument());
    expect(screen.getByText('둘째 기사')).toBeInTheDocument();
  });

  it('목록에서 기사를 고르면 openArticle 경로(getArticle+lockArticle)가 타고 편집 탭이 생긴다', async () => {
    const { model, container } = setup({ identity: { role: 'R' }, seed: pickerSeed() });
    const getArticle = vi.spyOn(model, 'getArticle');
    const lock = vi.spyOn(model, 'lockArticle');
    expect(docTabs(container)).toHaveLength(1); // 시작: 빈 새 기사 탭 1개

    await clickFileItem('문서열기');
    await waitFor(() => expect(screen.getByTestId('doc-open-row-0')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('doc-open-row-0')); // 첫 기사 선택

    await waitFor(() => expect(getArticle).toHaveBeenCalledWith('AKR1'));
    expect(lock).toHaveBeenCalled(); // 편집 진입 = 잠금 획득(openArticle 단일 경로 재사용)
    await waitFor(() => expect(docTabs(container)).toHaveLength(2)); // 편집 탭이 새로 열림
    // 성공 시 다이얼로그는 닫힌다.
    await waitFor(() => expect(screen.queryByTestId('doc-open-dialog')).toBeNull());
  });

  it("다른 세션이 편집 중(locked)이면 '편집중입니다.' alert가 뜨고 편집 탭이 열리지 않는다", async () => {
    const seed = {
      articles: [
        // 다른 clientId가 이미 잠근 기사 — fakeModel.lockArticle이 { ok:false, reason:'locked' }를 돌려준다.
        { articleId: 'AKR1', title: '잠긴 기사', status: 'RDS', lockYN: 'Y', lockerClientId: 'other-client', markupVersion: serialize([textBlock('잠긴 기사')]) },
      ],
    };
    const { container } = setup({ identity: { role: 'R' }, seed });
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await clickFileItem('문서열기');
    await waitFor(() => expect(screen.getByTestId('doc-open-row-0')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('doc-open-row-0'));

    await waitFor(() => expect(alert).toHaveBeenCalledWith('편집중입니다.'));
    expect(docTabs(container)).toHaveLength(1); // 편집 탭 안 열림(빈 새 기사 탭만)
    expect(screen.getByTestId('doc-open-dialog')).toBeInTheDocument(); // 다이얼로그는 열린 채 유지
  });

  it('이미 열린 기사를 다시 고르면 새 탭을 만들지 않고 dedup한다(기존 탭 활성)', async () => {
    const { container } = setup({ identity: { role: 'R' }, seed: pickerSeed() });

    await clickFileItem('문서열기');
    await waitFor(() => expect(screen.getByTestId('doc-open-row-0')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('doc-open-row-0')); // 첫 기사 편집 탭 생성
    await waitFor(() => expect(docTabs(container)).toHaveLength(2));

    // 같은 기사를 다시 연다 → dedup(새 탭 없음).
    await clickFileItem('문서열기');
    await waitFor(() => expect(screen.getByTestId('doc-open-row-0')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('doc-open-row-0'));

    await waitFor(() => expect(screen.queryByTestId('doc-open-dialog')).toBeNull());
    expect(docTabs(container)).toHaveLength(2); // 탭 개수 불변(dedup)
  });

  it("검색 제출 시 searchArticles로 목록을 좁힌다(빈 검색어는 전체 목록으로 복귀)", async () => {
    const { model } = setup({ identity: { role: 'R' }, seed: pickerSeed() });
    const searchSpy = vi.spyOn(model, 'searchArticles');

    await clickFileItem('문서열기');
    await waitFor(() => expect(screen.getByText('첫 기사')).toBeInTheDocument());

    // '둘째'로 검색 → searchArticles 위임 + 목록이 좁혀진다(fakeModel은 제목 substring 매치).
    fireEvent.change(screen.getByTestId('doc-open-search'), { target: { value: '둘째' } });
    fireEvent.click(screen.getByTestId('doc-open-search-btn'));

    await waitFor(() => expect(searchSpy).toHaveBeenCalledWith('둘째'));
    await waitFor(() => expect(screen.queryByText('첫 기사')).toBeNull());
    expect(screen.getByText('둘째 기사')).toBeInTheDocument();
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

  // Step 0(27-editor-critical-fixes): 본문 오염 방지 — 에디터(contentEditable)에 캐럿을 둔 채 Ctrl+F로 열면
  // 포커스가 본문에 남아 이어지는 검색어 타이핑이 기사 본문에 삽입(→자동저장으로 영속)되던 결함의 회귀 테스트.
  it('에디터에 포커스가 있는 상태에서 Ctrl+F로 열면 포커스가 본문이 아니라 find-query로 이동한다', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const box = container.querySelector('.yh-editor');
    box.focus(); // jsdom best-effort — contentEditable 루트에 포커스를 둔 채 진입
    fireEvent.keyDown(box, { key: 'f', ctrlKey: true });

    await waitFor(() => expect(findDialog()).toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByTestId('find-query')); // 다이얼로그 내부(양성 단언)
    expect(box.contains(document.activeElement)).toBe(false); // 에디터 본문이 아님
  });

  it("편집 메뉴 '찾기/바꾸기'(edit.findReplace) 클릭 시 다이얼로그가 열린다", async () => {
    await openWith([textBlock('헤드'), textBlock('본문')]);
    expect(findDialog()).toBeNull();

    await openTopMenu('편집');
    // 편집 드롭다운 안의 항목만 본다(다이얼로그 라벨과 분리).
    await userEvent.click(within(screen.getByTestId('menu-편집')).getByText('찾기/바꾸기'));

    await waitFor(() => expect(findDialog()).toBeInTheDocument());
  });

  it("편집 메뉴 '찾기/바꾸기'·'전체 선택'이 활성(enabled)이다", async () => {
    await openWith([textBlock('헤드'), textBlock('본문')]);
    await openTopMenu('편집');
    const menu = screen.getByTestId('menu-편집');
    expect(within(menu).getByText('찾기/바꾸기').closest('button')).toBeEnabled();
    expect(within(menu).getByText('전체 선택').closest('button')).toBeEnabled();
  });

  it("다시실행·되돌리기가 활성이고, 도구 UI 언어 설정(tools.uiLanguage)도 결선돼 활성이다(회귀)", async () => {
    // 다시실행/되돌리기(edit.redo/undo)는 37-editor-undo-redo에서 결선돼 활성이고, 도구
    // 'UI 언어 설정'(tools.uiLanguage)도 42-editor-ui-language step3에서 결선돼 활성이다(도구 전 항목 활성).
    await openWith([textBlock('헤드'), textBlock('본문')]);
    await openTopMenu('편집');
    const menu = screen.getByTestId('menu-편집');
    expect(within(menu).getByText('다시실행').closest('button')).toBeEnabled();
    expect(within(menu).getByText('되돌리기').closest('button')).toBeEnabled();
    await openTopMenu('도구');
    expect(within(screen.getByTestId('menu-도구')).getByText('UI 언어 설정').closest('button')).toBeEnabled();
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

    await openTopMenu('편집');
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
// aux-tools 의존(기업코드변환)은 여전히 비활성 placeholder. 텍스트 붙여넣기는 36-editor-edit-clipboard에서 결선. 약물바 토글은 실제 바(glyph-bar)를 켜고 끈다(phase17 step2 결선).
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

  it("컨텍스트 메뉴 '메뉴바 보이기' 클릭 시 메뉴바가 토글된다(기본 숨김 → 표시)", async () => {
    const { container, queryByTestId } = await openWith([textBlock('헤드')]);
    expect(queryByTestId('menubar')).toBeNull();

    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());
    await userEvent.click(ctxItem('메뉴바 보이기'));

    await waitFor(() => expect(queryByTestId('menubar')).toBeInTheDocument());
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

  it('aux 항목(기업코드변환)만 비활성으로 보인다(약물입력=phase17·원본 붙여넣기=Alt+V·텍스트 붙여넣기=phase36 결선됨)', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());

    for (const label of ['기업코드변환']) {
      expect(ctxItem(label)).toBeDisabled();
    }
  });

  it('편집(비매핑) 모드: 잘라내기/복사/붙여넣기·원본·텍스트 붙여넣기·찾기/바꾸기·전체 선택·약물입력·보이기 토글이 활성이다', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());

    for (const label of ['잘라내기', '복사', '붙여넣기', '원본 붙여넣기', '텍스트 붙여넣기', '찾기/바꾸기', '전체 선택', '약물입력', '메뉴바 보이기', '툴바 보이기', '약물바 보이기']) {
      expect(ctxItem(label)).toBeEnabled();
    }
  });

  it('매핑 모드: 컨텍스트 찾기/바꾸기 클릭이 다이얼로그를 열지 않고 updateField(body)가 호출되지 않는다 + 잘라내기/붙여넣기/텍스트 붙여넣기 비활성', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const original = serialize([textBlock('foo bar')]);
    const { container, model } = await openWith(
      [textBlock('foo bar')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    const save = vi.spyOn(model, 'saveArticle');

    rightClickCanvas(container);
    await waitFor(() => expect(ctxMenu()).toBeInTheDocument());

    // 매핑: 잘라내기/붙여넣기/텍스트 붙여넣기 비활성(본문 텍스트 잠금).
    expect(ctxItem('잘라내기')).toBeDisabled();
    expect(ctxItem('붙여넣기')).toBeDisabled();
    expect(ctxItem('텍스트 붙여넣기')).toBeDisabled();

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
    await openTopMenu('도움말');
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

    await openTopMenu('도구');
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
    await openTopMenu('도구');
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
    await openTopMenu('도움말');
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

// Step 1(38-editor-glyph-keymap): 사용자 키보드약물(glyphKeymap) 인터셉트 —
// step0 editorGlyphKeymap(compileGlyphKeymap/matchGlyphKeymap)을 onKeyDown에 결선: 등록 키조합(예: Ctrl+1) keydown 시
// 매칭 약물을 onGlyphPick 안전 경로(insertGlyphAtCaret → commitBody)로 캐럿에 삽입하고 preventDefault한다.
// 예약 단축키(Ctrl+F/Ctrl+D 등)는 항상 keymap보다 우선(섀도잉 금지 — 조기 return 1차 + RESERVED_COMBOS 컴파일 제외 2차).
// 매핑(onKeyDown 미부착 + onGlyphPick 가드)·IME 조합 중(최상단 조기 return)·수식어 없는 일반 타이핑(빠른 탈출)은 무개입.
describe('WriterPage — 사용자 키보드약물 인터셉트(glyphKeymap 결선)', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });

  // 사용자 키보드 약물을 시드한다(마운트 lazy 초기화가 읽는다 — 약물입력 다이얼로그 스위트와 동형).
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

  const editorLines = (container) => Array.from(container.querySelectorAll('.yh-editor .yh-editor__line')).map((el) => el.textContent);

  // 에디터 캐럿을 줄 시작에 두고 keyUp으로 onCaretChange를 발생시킨다(lastCaretRef 갱신 — 약물바 결선과 동일 경로).
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

  it('등록 조합(Ctrl+1) keydown 시 약물(★)이 캐럿 줄에 삽입되고 preventDefault된다(임베드·순서 불변)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedPrefs({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }] });
    const { container, model } = await openWith([
      textBlock('헤드'), embedBlock({ type: 'image', src: 'https://img/x.png' }), textBlock('본문'),
    ]);
    const save = vi.spyOn(model, 'saveArticle');

    focusCaretAtLine(container, 1); // 텍스트-줄 1 = "본문" 시작(임베드 제외 좌표)
    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: '1', ctrlKey: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);
    expect(spy).toHaveBeenCalled(); // 브라우저 기본(Ctrl+숫자) 억제 + Editor 후속 처리 건너뛰기

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text']); // 순서·개수 불변
    expect(blocksToText(blocks)).toBe('헤드\n★본문'); // 캐럿 줄 시작에 삽입
  });

  it("한글 입력 상태에서도 e.code로 매칭된다 — Ctrl+K(key:'ㅏ', code:'KeyK') → '§' 삽입", async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+K', glyph: '§' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'ㅏ', code: 'KeyK', ctrlKey: true }));

    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '§본문']));
  });

  it('예약 섀도잉 금지: keymap에 Ctrl+F를 등록해도 찾기/바꾸기가 열리고 약물은 삽입되지 않는다', async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+F', glyph: '✕' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'f', ctrlKey: true }));

    await waitFor(() => expect(screen.getByRole('dialog', { name: '찾기/바꾸기' })).toBeInTheDocument());
    expect(editorLines(container)).toEqual(['헤드', '본문']); // '✕' 미삽입 — 기존 동작 보존
  });

  it('예약 섀도잉 금지: keymap에 Ctrl+D를 등록해도 라인 삭제가 일어나고 약물은 삽입되지 않는다', async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+D', glyph: '✕' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('둘째'), textBlock('다음')]);
    focusCaretAtLine(container, 1); // "둘째" 라인
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'd', ctrlKey: true });

    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '다음'])); // 라인 삭제(기존 동작 보존)
    expect(editorLines(container).join('')).not.toContain('✕'); // 약물 미삽입
  });

  // ⑤ 리뷰 Minor fix 회귀 잠금: 예약키의 shift 변형(Ctrl+Shift+Y)은 상위 isInsertContinueMarker가 shift를
  // 무시하고 삼키므로 keymap에 등록해도 발화 불가 — 컴파일 제외(죽은 항목 방지)로 기존 (계속)삽입이 그대로 이긴다.
  it('예약 느슨 변형: keymap에 Ctrl+Shift+Y를 등록해도 (계속) 삽입이 일어나고 약물은 삽입되지 않는다', async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+Shift+Y', glyph: '✕' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'y', ctrlKey: true, shiftKey: true }));

    await waitFor(() => expect(editorLines(container).join('\n')).toContain('(계속)')); // 기존 동작 보존
    expect(editorLines(container).join('')).not.toContain('✕'); // 약물 미삽입(죽은 항목 — 컴파일 제외)
  });

  it('매핑 모드: 등록 조합 keydown이 본문을 바꾸지 않는다(저장 시 원본 PUT)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedPrefs({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }] });
    const original = serialize([textBlock('foo bar')]);
    const { container, model } = await openWith(
      [textBlock('foo bar')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    const save = vi.spyOn(model, 'saveArticle');

    // 매핑은 onKeyDown 자체가 Editor에 부착되지 않아(1차 방어) keymap 분기·onGlyphPick 가드(2차)에 도달하지 않는다.
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: '1', ctrlKey: true }));

    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original); // 본문 불변
  });

  it('IME 조합 중에는 등록 조합도 개입하지 않는다(삽입·preventDefault 없음)', async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);

    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: '1', ctrlKey: true, isComposing: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(spy).not.toHaveBeenCalled(); // IME 가드가 keymap 분기보다 먼저 return — 무개입(news.md 173행)
    expect(editorLines(container)).toEqual(['헤드', '본문']);
  });

  it('keymap이 비어 있으면 임의 조합(Ctrl+1)은 무개입이다', async () => {
    seedPrefs({ keymap: [] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: '1', ctrlKey: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(spy).not.toHaveBeenCalled();
    expect(editorLines(container)).toEqual(['헤드', '본문']);
  });

  it('등록돼 있어도 수식어 없는 일반 타이핑(1)은 삽입을 트리거하지 않는다(빠른 탈출)', async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: '1' }); // ctrl 없음 — 일반 타이핑
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(spy).not.toHaveBeenCalled();
    expect(editorLines(container)).toEqual(['헤드', '본문']); // '★' 미삽입
  });

  it('키보드약물 삽입은 독립 undo 한 단계다 — Ctrl+Z 한 번으로 그 삽입만 되돌려진다(phase 37 회귀)', async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: '1', ctrlKey: true }));
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '★본문']));

    // 삽입은 coalesce 없는 commitBody 기본 경로 — undo 한 번에 삽입 전으로 복귀한다.
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'z', ctrlKey: true });
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '본문']));
  });

  // 보강(harness-tester): 예약 섀도잉 금지 확장 — undo 계열(Ctrl+Z). isUndo 조기 return(1차 방어)이 keymap 분기보다
  // 위에 있고 RESERVED_COMBOS 컴파일 제외(2차 방어)도 겹쳐, 사용자가 Ctrl+Z를 등록해도 되돌리기가 그대로 동작해야 한다.
  it('예약 섀도잉 금지: keymap에 Ctrl+Z를 등록해도 되돌리기가 동작하고 약물은 삽입되지 않는다', async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }, { keys: 'Ctrl+Z', glyph: '✕' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: '1', ctrlKey: true })); // 히스토리 한 단계(★ 삽입)
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '★본문']));

    // 커밋 후 Editor remount — keydown 대상은 재조회한다(기존 '독립 undo' 테스트 관례).
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'z', ctrlKey: true }); // 등록돼 있어도 undo가 우선
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '본문'])); // 삽입이 되돌려졌다
    expect(editorLines(container).join('')).not.toContain('✕'); // keymap 약물 미삽입
  });

  // 보강(harness-tester): 예약 섀도잉 금지 확장 — Alt 계열(Alt+O 약물입력 다이얼로그).
  it('예약 섀도잉 금지: keymap에 Alt+O를 등록해도 약물입력 다이얼로그가 열리고 약물은 삽입되지 않는다', async () => {
    seedPrefs({ keymap: [{ keys: 'Alt+O', glyph: '✕' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'o', altKey: true }));

    await waitFor(() => expect(screen.getByRole('dialog', { name: '약물 입력' })).toBeInTheDocument());
    expect(editorLines(container)).toEqual(['헤드', '본문']); // '✕' 미삽입 — 기존 동작 보존
  });

  // 보강(harness-tester): 수식어 정확 일치 결선 — 모델(matchGlyphKeymap)의 수식어 불일치 거부가
  // onKeyDown에서 무개입(preventDefault 없음)으로 이어지는지 못박는다.
  it('수식어 정확 일치: Ctrl+1 등록 후 Ctrl+Shift+1은 무개입이다(삽입·preventDefault 없음)', async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    const ev = createEvent.keyDown(box, { key: '1', ctrlKey: true, shiftKey: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(spy).not.toHaveBeenCalled();
    expect(editorLines(container)).toEqual(['헤드', '본문']); // '★' 미삽입
  });

  // 보강(harness-tester): 쓰레기 항목 혼합 안전성 — EditorPrefsDialog가 keys를 trim만 하고 그대로 저장하므로
  // 어떤 자유입력이 섞여 있어도 마운트 컴파일이 크래시 없이 쓰레기만 버리고 정상 항목은 동작해야 한다.
  it('쓰레기 항목(ㅋㅋ/Shift+1/빈/1/Ctrl+)이 섞여 있어도 크래시 없이 정상 항목만 동작한다', async () => {
    seedPrefs({
      keymap: [
        { keys: 'ㅋㅋ', glyph: '✕' }, { keys: 'Shift+1', glyph: '✕' }, { keys: '', glyph: '✕' },
        { keys: '1', glyph: '✕' }, { keys: 'Ctrl+', glyph: '✕' }, { keys: 'Ctrl+2', glyph: '♠' },
      ],
    });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]); // 마운트(컴파일) 크래시 없음
    focusCaretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    // 쓰레기 항목이 가리키는 키들은 무개입(컴파일에서 이미 제외).
    fireEvent(box, createEvent.keyDown(box, { key: '!', shiftKey: true, code: 'Digit1' }));
    fireEvent(box, createEvent.keyDown(box, { key: '1' }));
    expect(editorLines(container)).toEqual(['헤드', '본문']);
    // 정상 항목(Ctrl+2)은 동작한다.
    fireEvent(box, createEvent.keyDown(box, { key: '2', ctrlKey: true }));
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '♠본문']));
  });

  // 보강(harness-tester): 중복 keys 결정성 — 같은 combo 2항목이면 먼저 등록된 glyph 하나만 정확히 1회 삽입된다
  // (matchGlyphKeymap 첫 매칭 반환 + onGlyphPick 1회 호출 — 이중 발화 없음).
  it('같은 keys 2항목 등록 시 먼저 등록된 glyph 하나만 1회 삽입된다', async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+1', glyph: '첫' }, { keys: 'ctrl+1', glyph: '둘' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: '1', ctrlKey: true }));

    // '첫' 정확히 1개(이중 발화면 '첫첫'), '둘' 없음(등록 순서 우선).
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '첫본문']));
  });

  // 보강(harness-tester): 환경설정 반영 경로 — 마운트 이후 프리퍼런스 다이얼로그에서 keymap을 추가하고 '적용'하면
  // onPrefsClose(applied) 게이트(setGlyphKeymap → useMemo 재컴파일)로 재마운트 없이 즉시 인터셉트가 동작해야 한다
  // (phase 33 lineSpacing 동형 게이트).
  it("환경설정에서 키보드 약물 등록 후 '적용'하면 즉시 인터셉트가 동작한다", async () => {
    seedPrefs({ keymap: [] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const box = container.querySelector('.yh-editor');
    focusCaretAtLine(container, 1);
    fireEvent(box, createEvent.keyDown(box, { key: '3', ctrlKey: true })); // 등록 전 — 무개입
    expect(editorLines(container)).toEqual(['헤드', '본문']);

    // 도움말>환경설정 → 사용자 키보드 약물 탭에서 'Ctrl+3 → ◎' 추가 → 적용.
    await openTopMenu('도움말');
    await userEvent.click(screen.getByText('환경설정'));
    await userEvent.click(screen.getByTestId('prefs-tab-glyphKeymap'));
    fireEvent.change(screen.getByTestId('pref-glyphKey-keys'), { target: { value: 'Ctrl+3' } });
    fireEvent.change(screen.getByTestId('pref-glyphKey-glyph'), { target: { value: '◎' } });
    fireEvent.click(screen.getByTestId('pref-glyphKey-add'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    focusCaretAtLine(container, 1);
    fireEvent(box, createEvent.keyDown(box, { key: '3', ctrlKey: true }));
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '◎본문'])); // 즉시 반영
  });

  it("환경설정에서 키보드 약물 등록 후 '취소'하면 인터셉트에 반영되지 않는다", async () => {
    seedPrefs({ keymap: [] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const box = container.querySelector('.yh-editor');

    await openTopMenu('도움말');
    await userEvent.click(screen.getByText('환경설정'));
    await userEvent.click(screen.getByTestId('prefs-tab-glyphKeymap'));
    fireEvent.change(screen.getByTestId('pref-glyphKey-keys'), { target: { value: 'Ctrl+3' } });
    fireEvent.change(screen.getByTestId('pref-glyphKey-glyph'), { target: { value: '◎' } });
    fireEvent.click(screen.getByTestId('pref-glyphKey-add')); // 다이얼로그 draft에만 추가
    fireEvent.click(screen.getByTestId('prefs-cancel')); // 취소 — 미영속·게이트 미발동

    focusCaretAtLine(container, 1);
    const ev = createEvent.keyDown(box, { key: '3', ctrlKey: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    fireEvent(box, ev);

    expect(spy).not.toHaveBeenCalled();
    expect(editorLines(container)).toEqual(['헤드', '본문']); // '◎' 미삽입
  });

  // 보강(harness-tester): 코얼레싱 경계 — 타이핑 버스트 직후의 keymap 삽입은 coalesce=false 경로라
  // 타이핑 스냅샷에 병합되지 않고 독립 undo 한 단계여야 한다(시간창 안 고정으로 시간 경과 아님을 못박는다).
  it('타이핑 직후 keymap 삽입은 코얼레싱에 병합되지 않는다 — Ctrl+Z 1회에 약물만 제거되고 타이핑은 보존된다', async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    vi.spyOn(Date, 'now').mockReturnValue(1000); // 코얼레싱 시간창(COALESCE_MS) 안에 고정
    const box = container.querySelector('.yh-editor');
    container.querySelectorAll('.yh-editor__line')[1].textContent = '본문가';
    fireEvent.input(box); // 타이핑 커밋(coalesce=true)
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '본문가']));

    focusCaretAtLine(container, 1);
    fireEvent(box, createEvent.keyDown(box, { key: '1', ctrlKey: true })); // keymap 삽입(coalesce=false)
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '★본문가']));

    // 커밋 후 Editor remount — keydown 대상은 재조회한다(기존 '독립 undo' 테스트 관례).
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'z', ctrlKey: true }); // undo 1회 — 약물만 제거
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '본문가'])); // 타이핑 보존(전부 되돌아가면 병합 회귀)
  });

  // 보강(harness-tester): "(끝)" 마커 캐럿 — 캐럿이 마커 줄을 가리켜도 keymap 발화는 insertGlyphAtCaret 폴백
  // 계약("(끝)" 불변, 마지막 본문 줄 끝 삽입)을 그대로 따른다(마커 뒤/안 텍스트 오염 없음).
  it('캐럿이 "(끝)" 마커 줄일 때 keymap 발화는 마커를 오염시키지 않고 마지막 본문 줄 끝에 삽입한다', async () => {
    seedPrefs({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }] });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문'), textBlock('(끝)')]);
    focusCaretAtLine(container, 2); // "(끝)" 줄
    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: '1', ctrlKey: true }));

    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '본문★', '(끝)'])); // 마커 불변·폴백 삽입
  });
});

// Step 1(18-editor-tools-menu): 날짜 삽입(tools.insertDate) 결선 —
// 도구 메뉴 '날짜 삽입' 클릭 시 현재 시각(비결정)을 KST 벽시계(kstIsoString)로 바꿔 날짜형식 prefs(dateFormat)대로 포맷해 캐럿 위치 본문에 텍스트로 삽입한다.
// 약물입력과 동일 안전 경로(updateField('body', serialize(...)) + setPendingCaretLine). Date.now는 WriterPage에만.
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
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText('날짜 삽입').closest('button'));
  }

  it("도구 메뉴 '날짜 삽입'(tools.insertDate)이 활성이다(MENU_ENABLED)", async () => {
    await openWith([textBlock('헤드')]);
    await openTopMenu('도구');
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
    // 고정 시각 2026-06-24T01:23:00Z → KST 벽시계(+9h) 'YYYY-MM-DD HH:mm' = '2026-06-24 10:23'(kstIsoString).
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드\n2026-06-24 10:23본문');
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
    // 기본 dateFormat = 'YYYY-MM-DD HH:mm' → 고정 시각의 KST 벽시계(01:23Z → 10:23 KST)가 그 형식으로 삽입.
    expect(blocksToText(deserialize(save.mock.calls[0][0].markupVersion))).toBe('헤드\n2026-06-24 10:23본문');
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

  it('도구 UI 언어 설정(tools.uiLanguage)이 결선돼 활성이다(회귀 없음)', async () => {
    // 회귀 가드 — 도구 'UI 언어 설정'은 42-editor-ui-language step3에서 결선돼 활성이다
    // (도구 15항목 전부 결선 — 미결선 항목 없음). 날짜 삽입 결선이 이를 훼손하지 않았는지 확인한다.
    await openWith([textBlock('헤드')]);
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('UI 언어 설정').closest('button')).toBeEnabled();
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
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText(label).closest('button'));
  }

  // URL 다이얼로그에 url을 입력하고 '삽입'을 누른다.
  async function submitUrl(url) {
    fireEvent.change(screen.getByTestId('url-embed-input'), { target: { value: url } });
    await userEvent.click(screen.getByTestId('url-embed-submit'));
  }

  it("도구 '그림 삽입'/'유튜브 영상 삽입'/'오디오 삽입'/'링크 삽입'/'로컬영상 삽입'이 활성이고 UI 언어 설정도 활성이다(MENU_ENABLED)", async () => {
    await openWith([textBlock('헤드')]);
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('그림 삽입').closest('button')).toBeEnabled();
    expect(within(menu).getByText('유튜브 영상 삽입').closest('button')).toBeEnabled();
    // 19-step2: 세 임베드 항목이 활성으로 결선됨(이전 step에서 '오디오 삽입' 비활성 단언을 활성으로 갱신).
    expect(within(menu).getByText('오디오 삽입').closest('button')).toBeEnabled();
    expect(within(menu).getByText('링크 삽입').closest('button')).toBeEnabled();
    expect(within(menu).getByText('로컬영상 삽입').closest('button')).toBeEnabled();
    // 도구 'UI 언어 설정'도 42-editor-ui-language step3에서 결선돼 활성(도구 15항목 전부 결선 — 미결선 항목 없음).
    expect(within(menu).getByText('UI 언어 설정').closest('button')).toBeEnabled();
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
    await openTopMenu('도구');
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
    await openTopMenu('도구');
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
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText('파일 정보').closest('button'));
  }

  it("도구 메뉴 '파일 정보'(tools.fileInfo)가 활성이다(MENU_ENABLED — 비활성→활성)", async () => {
    await openWith([textBlock('헤드')]);
    await openTopMenu('도구');
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
    await openTopMenu('도구');
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
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText('메모장').closest('button'));
  }

  it("도구 메뉴 '메모장'(tools.memo)이 활성이다(MENU_ENABLED — 비활성→활성)", async () => {
    await openWith([textBlock('헤드')]);
    await openTopMenu('도구');
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
    await openTopMenu('도구');
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
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText(label).closest('button'));
  }

  it("도구 메뉴 '약어관리'·'약어변환'이 활성이다(MENU_ENABLED — 비활성→활성)", async () => {
    await openWith([textBlock('헤드')]);
    await openTopMenu('도구');
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
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText(label).closest('button'));
  }

  it("도구 메뉴 '간체↔번체 변환'이 활성이다(MENU_ENABLED — 비활성→활성)", async () => {
    await openWith([textBlock('헤드')]);
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('간체↔번체 변환').closest('button')).toBeEnabled();
  });

  it('도구 UI 언어 설정(tools.uiLanguage)이 결선돼 활성이다(회귀 없음)', async () => {
    // UI 언어 설정은 42-editor-ui-language step3에서 결선돼 활성 — 도구 15항목이 전부 결선되어 미결선 항목이 없다.
    await openWith([textBlock('헤드')]);
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('UI 언어 설정').closest('button')).toBeEnabled();
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

// Step 2(25-article-history-compare): 도구>기사이력비교(tools.historyCompare) 결선 —
// 메뉴 클릭 시 model.queryHistory로 스냅샷 이력 목록을 조회해 HistoryCompareDialog(step1)에 주입하고,
// 좌/우 선택 시 model.getHistorySnapshot으로 선택 스냅샷만 지연 조회해 텍스트(deserialize+blocksToText)로 표시한다.
// 읽기전용 — 본문/캐럿/임베드 무변경(매핑에서도 열림, 파일 정보와 동일 정책 — 매핑 가드 앞).
describe('WriterPage — 기사이력비교(tools.historyCompare) 결선', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  // 스냅샷 이력 seed — id 11(edit, 스냅샷 보유)만 비교 목록 대상, id 10(status, 스냅샷 없음)은 제외돼야 한다.
  const OLD_BODY = serialize([textBlock('헤드'), textBlock('옛본문')]);
  const HISTORIES = {
    AKR1: [
      { id: 11, articleId: 'AKR1', eventType: 'edit', action: 'edit', actorUserId: 'lee', createdAt: '2026-06-14T02:00:00Z', hasSnapshot: 1, markupVersion: OLD_BODY },
      { id: 10, articleId: 'AKR1', eventType: 'status', action: 'send', actorUserId: 'kim', createdAt: '2026-06-14T01:00:00Z', hasSnapshot: 0 },
    ],
  };

  async function openWith(blocks, { mode = 'edit', status = 'RDS', role = 'R', histories } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status }, mode },
      seed: { articles: [{ articleId: 'AKR1', status, lockYN: 'Y', markupVersion: body }], histories },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  // 도구 메뉴를 열고 '기사이력비교'를 클릭한다(파일 정보 결선과 동일 패턴).
  async function clickHistoryCompare() {
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText('기사이력비교').closest('button'));
  }

  it("도구 메뉴 '기사이력비교'(tools.historyCompare)가 활성이다(MENU_ENABLED — 비활성→활성)", async () => {
    await openWith([textBlock('헤드')], { histories: HISTORIES });
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('기사이력비교').closest('button')).toBeEnabled();
  });

  it('도구 UI 언어 설정(tools.uiLanguage)이 결선돼 활성이다(회귀 가드)', async () => {
    // UI 언어 설정(tools.uiLanguage)은 42-editor-ui-language step3에서 결선돼 활성 — 도구 전 항목 결선 완결.
    await openWith([textBlock('헤드')], { histories: HISTORIES });
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('UI 언어 설정').closest('button')).toBeEnabled();
  });

  it("클릭 시 HistoryCompareDialog(history-compare, role=dialog '기사 이력 비교')가 열린다", async () => {
    await openWith([textBlock('헤드'), textBlock('본문')], { histories: HISTORIES });
    await clickHistoryCompare();
    expect(screen.getByRole('dialog', { name: '기사 이력 비교' })).toBeInTheDocument();
    expect(screen.getByTestId('history-compare')).toBeInTheDocument();
  });

  it('스냅샷 시드가 있는 기사에서 열면 현재 본문 + 스냅샷 이력 항목이 선택 목록에 표시된다(hasSnapshot만)', async () => {
    await openWith([textBlock('헤드'), textBlock('본문')], { histories: HISTORIES });
    await clickHistoryCompare();
    const left = screen.getByTestId('history-compare-left');
    expect(within(left).getByRole('option', { name: '현재 본문' })).toBeInTheDocument();
    // 스냅샷 보유 항목(id 11 — lee)은 표시, 스냅샷 없는 항목(id 10 — kim)은 제외.
    expect(within(left).getByRole('option', { name: /lee/ })).toBeInTheDocument();
    expect(within(left).queryByRole('option', { name: /kim/ })).toBeNull();
  });

  it('좌=스냅샷/우=현재 본문 선택 시 getHistorySnapshot 지연 조회 후 add/del 세그먼트 diff가 렌더된다', async () => {
    const { model } = await openWith([textBlock('헤드'), textBlock('본문')], { histories: HISTORIES });
    const snap = vi.spyOn(model, 'getHistorySnapshot');

    await clickHistoryCompare();
    await userEvent.selectOptions(screen.getByTestId('history-compare-left'), '11');
    await userEvent.selectOptions(screen.getByTestId('history-compare-right'), 'current');

    // 선택된 스냅샷(id 11)만 지연 조회한다(목록 조회로 본문을 미리 받지 않음).
    expect(snap).toHaveBeenCalledWith('AKR1', 11);

    // '헤드\n옛본문' vs '헤드\n본문' → equal '헤드' + del '옛본문' + add '본문'.
    await waitFor(() => expect(screen.getByTestId('history-compare-diff')).toBeInTheDocument());
    const segs = screen.getAllByTestId('history-compare-segment');
    expect(segs.some((s) => s.dataset.type === 'del' && s.textContent === '옛본문')).toBe(true);
    expect(segs.some((s) => s.dataset.type === 'add' && s.textContent === '본문')).toBe(true);
    expect(segs.some((s) => s.dataset.type === 'equal' && s.textContent === '헤드')).toBe(true);
  });

  it('같은 쪽 빠른 재선택 — 늦게 도착한 스냅샷 응답이 최신 선택(현재 본문)을 덮어쓰지 않는다(stale 폐기)', async () => {
    const { model } = await openWith([textBlock('헤드'), textBlock('본문')], { histories: HISTORIES });
    // getHistorySnapshot을 수동 resolve 가능한 지연 Promise로 스텁 — resolver를 테스트가 쥔다(deferred).
    const real = model.getHistorySnapshot.bind(model);
    let resolveSnap;
    vi.spyOn(model, 'getHistorySnapshot').mockImplementation((articleId, id) => {
      const result = real(articleId, id);
      return new Promise((resolve) => { resolveSnap = () => resolve(result); });
    });

    await clickHistoryCompare();
    await userEvent.selectOptions(screen.getByTestId('history-compare-right'), 'current');
    // ① 왼쪽 스냅샷(id 11 — '헤드\n옛본문') 선택: fetch 시작, 응답은 아직 보류.
    await userEvent.selectOptions(screen.getByTestId('history-compare-left'), '11');
    // ② 응답 전에 같은 쪽을 '현재 본문'으로 재선택 → 좌=우=현재 본문이라 diff는 전부 equal.
    await userEvent.selectOptions(screen.getByTestId('history-compare-left'), 'current');
    await waitFor(() => expect(screen.getByTestId('history-compare-diff')).toBeInTheDocument());
    // ③ ①의 지연 응답이 이제 도착 — stale이므로 폐기돼야 한다.
    await act(async () => { resolveSnap(); });
    // ④ 표시 텍스트는 여전히 현재 본문 — 스냅샷('옛본문')으로 덮어쓰이면 del/add 세그먼트가 생겨 실패한다.
    const segs = screen.getAllByTestId('history-compare-segment');
    expect(segs.some((s) => s.textContent === '옛본문')).toBe(false);
    expect(segs.every((s) => s.dataset.type === 'equal')).toBe(true);
  });

  it('저장 안 된 새 기사(articleId 없음)에서 열면 "이력 없음" 빈 상태로 열린다(조회 없음·죽지 않음)', async () => {
    const { model } = setup({ identity: { role: 'R' } }); // pendingEdit 없음 — 신규 빈 탭(articleId 없음)
    const query = vi.spyOn(model, 'queryHistory');

    await clickHistoryCompare();
    expect(screen.getByTestId('history-compare')).toBeInTheDocument();
    expect(screen.getByTestId('history-compare-empty')).toBeInTheDocument();
    expect(query).not.toHaveBeenCalled();
  });

  it('스냅샷 이력이 없는 기사에서 열면 빈 상태로 열린다(현재 본문 1개뿐 — 비교 불가)', async () => {
    // 이력은 있으나 전부 스냅샷 없음(hasSnapshot falsy) → 비교 대상은 현재 본문뿐이라 빈 상태.
    await openWith([textBlock('헤드')], {
      histories: { AKR1: [{ id: 10, articleId: 'AKR1', eventType: 'status', action: 'send', actorUserId: 'kim', createdAt: '2026-06-14T01:00:00Z', hasSnapshot: 0 }] },
    });
    await clickHistoryCompare();
    expect(screen.getByTestId('history-compare-empty')).toBeInTheDocument();
  });

  it('읽기전용 — 열고 좌/우 선택·닫기 후에도 본문(saveArticle markupVersion)이 변하지 않는다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model } = await openWith([textBlock('헤드'), textBlock('본문')], { histories: HISTORIES });
    const save = vi.spyOn(model, 'saveArticle');

    await clickHistoryCompare();
    await userEvent.selectOptions(screen.getByTestId('history-compare-left'), '11');
    await userEvent.selectOptions(screen.getByTestId('history-compare-right'), 'current');
    await waitFor(() => expect(screen.getByTestId('history-compare-diff')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('history-compare-close'));

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    // 텍스트/임베드 무변경 — 본문이 그대로다(읽기전용, 파일 정보 결선과 동일 단언).
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(blocksToText(blocks)).toBe('헤드\n본문');
  });

  it("매핑 모드에서도 '기사이력비교'가 활성이고 다이얼로그가 열린다(읽기전용 — 파일 정보와 동일 정책)", async () => {
    await openWith(
      [textBlock('제목'), textBlock('본문'), textBlock('(끝)')],
      { mode: 'mapping', status: 'DPS', role: 'D', histories: HISTORIES },
    );
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('기사이력비교').closest('button')).toBeEnabled();
    await userEvent.click(within(menu).getByText('기사이력비교').closest('button'));
    expect(screen.getByRole('dialog', { name: '기사 이력 비교' })).toBeInTheDocument();
  });

  it("'닫기'/Esc로 다이얼로그가 닫힌다", async () => {
    await openWith([textBlock('헤드'), textBlock('본문')], { histories: HISTORIES });
    await clickHistoryCompare();
    await userEvent.click(screen.getByTestId('history-compare-close'));
    expect(screen.queryByRole('dialog', { name: '기사 이력 비교' })).not.toBeInTheDocument();

    await clickHistoryCompare();
    fireEvent.keyDown(screen.getByRole('dialog', { name: '기사 이력 비교' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '기사 이력 비교' })).not.toBeInTheDocument();
  });
});

// Alt+V/우클릭 '원본 붙여넣기' — keydown에서는 클립보드를 동기로 읽을 수 없어(브라우저 보안) 비동기 클립보드
// API(navigator.clipboard.read)로 이미지를 찾아 Ctrl+V와 동일한 안전 경로(pasteImageAtCaret: 업로드→경로 임베드)로
// 삽입한다. 미지원/권한 거부/이미지 없음은 alert로만 안내한다.
describe("WriterPage — Alt+V/우클릭 '원본 붙여넣기'(클립보드 이미지)", () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { delete navigator.clipboard; });

  const stubClipboard = (readImpl) => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { read: readImpl }, configurable: true, writable: true,
    });
  };
  const imageClipItem = (type = 'image/png') => ({
    types: [type],
    getType: async () => new Blob(['x'], { type }),
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

  const embeds = (container) => container.querySelectorAll('.yh-editor .yh-embed');

  it('Alt+V: 클립보드에 이미지가 있으면 업로드 후 경로(/uploads/) 임베드로 삽입된다', async () => {
    stubClipboard(async () => [imageClipItem()]);
    const { container, model } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const upload = vi.spyOn(model, 'uploadFile');

    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'v', altKey: true });

    await waitFor(() => expect(embeds(container).length).toBe(1));
    expect(upload).toHaveBeenCalledTimes(1);
    // 업로드 File은 MIME image/png — base64가 아니라 서버 경로 임베드로 삽입된다.
    expect(upload.mock.calls[0][0].type).toBe('image/png');
    const img = container.querySelector('.yh-embed img');
    expect(img.getAttribute('src')).toMatch(/^\/uploads\//);
  });

  it('Alt+V: 클립보드에 이미지가 없으면(텍스트뿐) 안내만 하고 업로드/본문 변경이 없다', async () => {
    stubClipboard(async () => [
      { types: ['text/plain'], getType: async () => new Blob(['t'], { type: 'text/plain' }) },
    ]);
    const { container, model } = await openWith([textBlock('본문')]);
    const upload = vi.spyOn(model, 'uploadFile');
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'v', altKey: true });

    await waitFor(() => expect(alert).toHaveBeenCalledWith('클립보드에 이미지가 없습니다. 텍스트는 Ctrl+V로 붙여넣으세요.'));
    expect(upload).not.toHaveBeenCalled();
    expect(embeds(container).length).toBe(0);
  });

  it('Alt+V: 클립보드 API 미지원 브라우저면 안내만 한다', async () => {
    // navigator.clipboard 미정의(jsdom 기본) — stub하지 않는다.
    const { container, model } = await openWith([textBlock('본문')]);
    const upload = vi.spyOn(model, 'uploadFile');
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'v', altKey: true });

    await waitFor(() => expect(alert).toHaveBeenCalledWith('이 브라우저에서는 원본 붙여넣기를 지원하지 않습니다. Ctrl+V를 사용하세요.'));
    expect(upload).not.toHaveBeenCalled();
  });

  it('Alt+V: 클립보드 읽기 권한 거부(reject)면 안내만 한다', async () => {
    stubClipboard(async () => { throw new Error('denied'); });
    const { container, model } = await openWith([textBlock('본문')]);
    const upload = vi.spyOn(model, 'uploadFile');
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'v', altKey: true });

    await waitFor(() => expect(alert).toHaveBeenCalledWith('클립보드 읽기 권한이 거부되어 원본 붙여넣기를 할 수 없습니다.'));
    expect(upload).not.toHaveBeenCalled();
  });

  it('매핑 모드: Alt+V가 동작하지 않는다(본문 텍스트 잠금)', async () => {
    stubClipboard(async () => [imageClipItem()]);
    const { container, model } = await openWith([textBlock('본문')], { mode: 'mapping', status: 'DPS', role: 'D' });
    const upload = vi.spyOn(model, 'uploadFile');
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'v', altKey: true });
    await act(async () => {}); // 마이크로태스크 플러시 — 비동기 경로가 있었다면 업로드가 잡힌다.

    expect(upload).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("우클릭 '원본 붙여넣기'가 비매핑에서 활성이고 클릭 시 이미지가 삽입된다", async () => {
    stubClipboard(async () => [imageClipItem()]);
    const { container } = await openWith([textBlock('본문')]);

    fireEvent.contextMenu(screen.getByTestId('editor-canvas'));
    const ctx = await screen.findByTestId('editor-context-menu');
    const item = within(ctx).getByText('원본 붙여넣기').closest('button');
    expect(item).toBeEnabled();
    await userEvent.click(item);

    await waitFor(() => expect(embeds(container).length).toBe(1));
  });

  it("매핑 모드: 우클릭 '원본 붙여넣기'는 비활성이다", async () => {
    await openWith([textBlock('본문')], { mode: 'mapping', status: 'DPS', role: 'D' });
    fireEvent.contextMenu(screen.getByTestId('editor-canvas'));
    const ctx = await screen.findByTestId('editor-context-menu');
    expect(within(ctx).getByText('원본 붙여넣기').closest('button')).toBeDisabled();
  });
});

// Step 1(36-editor-edit-clipboard): 편집 메뉴/우클릭 클립보드 5종 결선(clipboard-dispatch).
// 잘라내기·복사=execCommand 위임(runEditorClipboardCommand, ctx와 공유), 붙여넣기·텍스트 붙여넣기=비동기 navigator.clipboard
// 핸들러(pasteAtCaret/pasteTextAtCaret), 원본 붙여넣기=기존 pasteOriginalAtCaret 재사용. 본문 반영은 전부
// commitBody(serialize(...))(텍스트) / pasteImageAtCaret(이미지) 안전 경로만 — DOM/contentEditable 직접 조작 없음.
describe('WriterPage — 편집/우클릭 클립보드 5종 결선(clipboard-dispatch)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    window.getSelection().removeAllRanges();
  });
  afterEach(() => { delete navigator.clipboard; });

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

  // 클립보드 stub — { read?, readText? } 조합을 주입한다(원본 붙여넣기 테스트와 동일 패턴).
  const stubClipboard = (impl) => {
    Object.defineProperty(navigator, 'clipboard', { value: impl, configurable: true, writable: true });
  };
  const imageClipItem = (type = 'image/png') => ({ types: [type], getType: async () => new Blob(['x'], { type }) });
  const textClipItem = () => ({ types: ['text/plain'], getType: async () => new Blob(['t'], { type: 'text/plain' }) });

  // 캐럿을 텍스트-줄 lineIndex 시작에 두고 keyUp으로 onCaretChange를 발생시켜 lastCaretRef를 갱신한다(약물/날짜 삽입과 동일 경로).
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

  const editMenuItem = (label) => within(screen.getByTestId('menu-편집')).getByText(label).closest('button');
  const editorLines = (container) => Array.from(container.querySelectorAll('.yh-editor .yh-editor__line')).map((el) => el.textContent);
  const embeds = (container) => container.querySelectorAll('.yh-editor .yh-embed');

  // ---- 잘라내기/복사: execCommand 위임(runEditorClipboardCommand) ----
  it("편집 메뉴 '잘라내기'/'복사' 클릭은 execCommand(cut/copy)로 위임하고 에디터 root에 focus한다", async () => {
    const { container } = await openWith([textBlock('foo bar')]);
    const exec = vi.fn(() => true);
    document.execCommand = exec; // jsdom 미정의 → 위임 경로 검증용 주입.
    const root = container.querySelector('.yh-editor');
    const focus = vi.spyOn(root, 'focus');
    try {
      await openTopMenu('편집');
      await userEvent.click(editMenuItem('복사'));
      expect(exec).toHaveBeenCalledWith('copy');

      await openTopMenu('편집');
      await userEvent.click(editMenuItem('잘라내기'));
      expect(exec).toHaveBeenCalledWith('cut');
      expect(focus).toHaveBeenCalled(); // 코드 직접 조작이 아니라 에디터 focus 후 브라우저 위임.
    } finally {
      delete document.execCommand;
    }
  });

  it("매핑 모드: 편집 메뉴 '잘라내기'는 execCommand를 호출하지 않는다(본문 잠금)", async () => {
    await openWith([textBlock('foo')], { mode: 'mapping', status: 'DPS', role: 'D' });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    try {
      await openTopMenu('편집');
      await userEvent.click(editMenuItem('잘라내기'));
      expect(exec).not.toHaveBeenCalled(); // isMapping 가드로 조기 return.
    } finally {
      delete document.execCommand;
    }
  });

  // ---- 텍스트 붙여넣기: 클립보드 평문 삽입(pasteTextAtCaret) ----
  it("편집 메뉴 '텍스트 붙여넣기': 클립보드 평문을 캐럿 줄에 삽입하고 다중 줄로 분할한다(임베드 보존)", async () => {
    stubClipboard({ readText: async () => 'X\nY' });
    const { container } = await openWith([
      textBlock('헤드'), embedBlock({ type: 'image', src: 'https://img/x.png' }), textBlock('본문'),
    ]);
    focusCaretAtLine(container, 1); // 텍스트-줄 1 = '본문' 시작

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('텍스트 붙여넣기'));

    // '본문' 시작에 'X\nY' 삽입 → ['헤드','X','Y본문'] (임베드는 위치 보존).
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', 'X', 'Y본문']));
    expect(embeds(container).length).toBe(1);
  });

  it("편집 메뉴 '텍스트 붙여넣기': 캐럿이 \"(끝)\" 뒤면 삽입되지 않는다(마커 무결성)", async () => {
    stubClipboard({ readText: async () => 'X' });
    const { container } = await openWith([textBlock('본문'), textBlock('(끝)')]);
    focusCaretAtLine(container, 1); // '(끝)' 줄 시작 = 마커 시작 → isInputBlocked

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('텍스트 붙여넣기'));
    await act(async () => {}); // readText 마이크로태스크 플러시.

    expect(editorLines(container)).toEqual(['본문', '(끝)']); // 불변(no-op)
  });

  it("매핑 모드: 편집 메뉴 '텍스트 붙여넣기'는 readText를 호출하지 않는다(본문-only 불변식)", async () => {
    const readText = vi.fn(async () => 'X');
    stubClipboard({ readText });
    await openWith([textBlock('foo')], { mode: 'mapping', status: 'DPS', role: 'D' });

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('텍스트 붙여넣기'));
    await act(async () => {});

    expect(readText).not.toHaveBeenCalled(); // isMapping 가드로 조기 return.
  });

  it("편집 메뉴 '텍스트 붙여넣기': 클립보드 API 미지원이면 안내만 한다", async () => {
    // navigator.clipboard 미정의(stub 안 함).
    await openWith([textBlock('본문')]);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('텍스트 붙여넣기'));

    await waitFor(() => expect(alert).toHaveBeenCalledWith('이 브라우저에서는 텍스트 붙여넣기를 지원하지 않습니다. Ctrl+V를 사용하세요.'));
  });

  it("편집 메뉴 '텍스트 붙여넣기': 클립보드 읽기 권한 거부면 안내만 한다", async () => {
    stubClipboard({ readText: async () => { throw new Error('denied'); } });
    const { container } = await openWith([textBlock('본문')]);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    focusCaretAtLine(container, 0);

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('텍스트 붙여넣기'));

    await waitFor(() => expect(alert).toHaveBeenCalledWith('클립보드 읽기 권한이 거부되어 붙여넣기를 할 수 없습니다.'));
    expect(editorLines(container)).toEqual(['본문']); // 본문 불변.
  });

  // ---- 붙여넣기: 이미지 우선 → 없으면 평문(pasteAtCaret) ----
  it("편집 메뉴 '붙여넣기': 클립보드에 이미지가 있으면 업로드 후 경로(/uploads/) 임베드로 삽입된다", async () => {
    stubClipboard({ read: async () => [imageClipItem()] });
    const { container, model } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const upload = vi.spyOn(model, 'uploadFile');
    focusCaretAtLine(container, 1);

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('붙여넣기'));

    await waitFor(() => expect(embeds(container).length).toBe(1));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.yh-embed img').getAttribute('src')).toMatch(/^\/uploads\//);
  });

  it("편집 메뉴 '붙여넣기': 클립보드에 이미지가 없으면 평문을 캐럿 줄에 삽입한다", async () => {
    stubClipboard({ read: async () => [textClipItem()], readText: async () => 'Z' });
    const { container, model } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const upload = vi.spyOn(model, 'uploadFile');
    focusCaretAtLine(container, 1);

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('붙여넣기'));

    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', 'Z본문']));
    expect(upload).not.toHaveBeenCalled(); // 이미지 없음 → 업로드 경로 미진입.
  });

  // ---- 원본 붙여넣기: 편집 메뉴에서도 기존 핸들러 재사용 ----
  it("편집 메뉴 '원본 붙여넣기': 클립보드 이미지를 업로드 경로 임베드로 삽입한다", async () => {
    stubClipboard({ read: async () => [imageClipItem()] });
    const { container, model } = await openWith([textBlock('본문')]);
    const upload = vi.spyOn(model, 'uploadFile');

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('원본 붙여넣기'));

    await waitFor(() => expect(embeds(container).length).toBe(1));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  // ---- 탭-stale 가드: await 사이 탭 전환 시 어느 탭 본문도 오염되지 않는다(pasteImageAtCaret 탭 고정 가드와 동형) ----
  it("텍스트 붙여넣기: readText 대기 중 다른 탭으로 이동하면 어느 탭 본문도 바뀌지 않는다(탭 고정 가드)", async () => {
    let resolveText;
    stubClipboard({ readText: () => new Promise((res) => { resolveText = res; }) });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('텍스트 붙여넣기'));
    await waitFor(() => expect(typeof resolveText).toBe('function')); // readText in-flight

    // 대기 중 새 작성 탭으로 전환(addTab → 새 탭 활성). 에디터에서 이전 탭 본문('본문')이 사라지면 전환 완료.
    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' }));
    await waitFor(() => expect(editorLines(container)).not.toContain('본문'));

    await act(async () => { resolveText('PASTED'); });

    // 탭이 바뀌었으므로 커밋은 폐기(activeTabRef.current.id !== tabId) — 새(활성) 탭에 붙여넣기가 새지 않고
    // 이전 탭(A) 본문도 새 탭으로 새지 않는다(image 탭 고정 가드 테스트와 동일 관찰 — 커밋 자체가 일어나지 않음).
    const lines = editorLines(container);
    expect(lines.join('\n')).not.toContain('PASTED');
    expect(lines).not.toContain('본문');

    // 전환 후 원 탭 A로 되돌아가 본문이 원본 그대로 보존됐는지 직접 재검증(커밋 폐기 → 붙여넣기 텍스트 부재).
    // 탭 순서: [시드 빈 탭(0), A=AKR1(1), 새 작성 탭 B(2)] — openArticle/addTab이 모두 append(useWriteController).
    await userEvent.click(container.querySelectorAll('.yh-tab__label')[1]);
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', '본문']));
    expect(editorLines(container).join('\n')).not.toContain('PASTED');
  });

  // ---- 같은-탭 stale 가드(리뷰 게이트 Major): readText 대기 중 같은 탭 본문이 바뀌면 최신 본문 위에 삽입 ----
  it('텍스트 붙여넣기: readText 대기 중 같은 탭 본문이 바뀌면 최신 본문 위에 삽입한다(변경 보존)', async () => {
    let resolveText;
    stubClipboard({ readText: () => new Promise((res) => { resolveText = res; }) });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1); // 캐럿 = 텍스트-줄 1('본문') 시작

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('텍스트 붙여넣기'));
    await waitFor(() => expect(typeof resolveText).toBe('function')); // readText in-flight

    // 대기 중(권한 버블 등) 같은 탭에서 본문을 편집한다: 줄 0 '헤드' → '헤드EDIT'.
    // onInput→onTextChange→commitBody로 활성 탭 fields.body가 '헤드EDIT\n본문'으로 갱신된다(에디터는 echo라 remount 없음).
    const editorEl = container.querySelector('.yh-editor');
    container.querySelectorAll('.yh-editor__line')[0].textContent = '헤드EDIT';
    fireEvent.input(editorEl);
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드EDIT', '본문']));

    await act(async () => { resolveText('PASTED'); });

    // 커밋은 렌더 클로저의 stale blocks(['헤드','본문'])가 아니라 최신 본문(['헤드EDIT','본문']) 위에 얹혀야 한다.
    // 붙여넣기 텍스트가 삽입되면서도 대기 중 편집('헤드EDIT')이 유실되지 않는다(같은-탭 stale 유실 회귀 방지).
    await waitFor(() => expect(editorLines(container)).toEqual(['헤드EDIT', 'PASTED본문']));
  });

  // ---- 우클릭 ctx.pasteText도 동일 핸들러(pasteTextAtCaret)로 결선 ----
  it("우클릭 '텍스트 붙여넣기': 클립보드 평문을 캐럿 줄에 삽입한다", async () => {
    stubClipboard({ readText: async () => 'Q' });
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    focusCaretAtLine(container, 1);

    fireEvent.contextMenu(screen.getByTestId('editor-canvas'));
    const ctx = await screen.findByTestId('editor-context-menu');
    await userEvent.click(within(ctx).getByText('텍스트 붙여넣기').closest('button'));

    await waitFor(() => expect(editorLines(container)).toEqual(['헤드', 'Q본문']));
  });
});

// Step 1(28-audit-stabilization): 제목 파생 중앙화(commitBody) — 본문을 바꾸는 모든 경로가 제목(본문 첫 줄)을
// 재동기화한다. 타이핑(onTextChange) 외 경로(모두 바꾸기/대소문자 변환/줄삭제 등)가 body만 갱신해 저장 시
// DB로 나가는 dto.title이 옛 값(stale)으로 남던 결함의 회귀 테스트 — 저장(PUT) dto의 title로 직접 관찰한다.
describe('WriterPage — 제목 파생 중앙화(모든 본문변경 경로의 title 재동기화)', () => {
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

  // 마지막 캐럿(lastCaretRef)을 lineIndex 줄로 갱신(keyUp→onCaretChange — 대소문자 변환 메뉴 클릭 전 상태 모사).
  function focusCaretAtLine(container, lineIndex) {
    caretAtLine(container, lineIndex);
    fireEvent.keyUp(container.querySelector('.yh-editor'));
  }

  const editorLines = (container) => Array.from(
    container.querySelectorAll('.yh-editor .yh-editor__line'),
  ).map((el) => el.textContent);

  // fields.title(=옛 제목)과 본문 첫 줄이 일치한 상태로 편집 진입한다 — 경로 실행 후 저장 dto.title이
  // "바뀐 첫 줄"인지 단언한다(제목 재동기화가 누락되면 옛 제목이 그대로 서버로 나간다).
  async function openWith(blocks, title) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role: 'R' },
      pendingEdit: { article: { articleId: 'AKR1', title, status: 'RDS' }, mode: 'edit' },
      seed: { articles: [{ articleId: 'AKR1', title, status: 'RDS', lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  // 보류(hold)로 서버에 실리는 dto를 관찰한다 — 보류는 "(끝)" 불필요·제목 가드만 지나고,
  // submit이 저장(PUT saveArticle)에 탭 필드(title 포함)를 싣는다(toSaveDto).
  async function holdAndGetDto(model) {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const save = vi.spyOn(model, 'saveArticle');
    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    return save.mock.calls[save.mock.calls.length - 1][0];
  }

  it('모두 바꾸기로 첫 줄이 바뀌면 저장 dto의 title이 새 첫 줄로 나간다(제목 stale 방지)', async () => {
    const { container, model } = await openWith(
      [textBlock('한국 소식'), textBlock('본문 한국')], '한국 소식',
    );

    const box = container.querySelector('.yh-editor');
    fireEvent(box, createEvent.keyDown(box, { key: 'f', ctrlKey: true }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '찾기/바꾸기' })).toBeInTheDocument());
    await userEvent.type(screen.getByTestId('find-query'), '한국');
    await userEvent.type(screen.getByTestId('find-replacement'), '대한민국');
    await userEvent.click(screen.getByTestId('find-replace-all'));
    await waitFor(() => expect(editorLines(container)[0]).toBe('대한민국 소식'));

    const dto = await holdAndGetDto(model);
    expect(dto.title).toBe('대한민국 소식');
  });

  it('보기>대문자로 바꾸기로 첫 줄이 바뀌면 저장 dto의 title이 변환된 첫 줄로 나간다', async () => {
    const { container, model } = await openWith(
      [textBlock('title abc'), textBlock('본문')], 'title abc',
    );
    focusCaretAtLine(container, 0);

    await openTopMenu('보기');
    await userEvent.click(screen.getByText('대문자로 바꾸기'));
    await waitFor(() => expect(editorLines(container)[0]).toBe('TITLE ABC'));

    const dto = await holdAndGetDto(model);
    expect(dto.title).toBe('TITLE ABC');
  });

  it('Ctrl+D로 첫 줄을 지우면 저장 dto의 title이 새 첫 줄로 동기화된다', async () => {
    const { container, model } = await openWith(
      [textBlock('옛첫줄'), textBlock('새첫줄'), textBlock('본문')], '옛첫줄',
    );
    caretAtLine(container, 0);
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'd', ctrlKey: true });
    await waitFor(() => expect(editorLines(container)[0]).toBe('새첫줄'));

    const dto = await holdAndGetDto(model);
    expect(dto.title).toBe('새첫줄');
  });

  it('타이핑(onTextChange) 경로의 title 동기화는 회귀 없이 유지된다', async () => {
    const { container, model } = await openWith(
      [textBlock('옛첫줄'), textBlock('본문')], '옛첫줄',
    );
    const box = container.querySelector('.yh-editor');
    box.querySelector('.yh-editor__line').textContent = '새제목줄';
    fireEvent.input(box);
    await waitFor(() => expect(editorLines(container)[0]).toBe('새제목줄'));

    const dto = await holdAndGetDto(model);
    expect(dto.title).toBe('새제목줄');
  });

  // 매핑 무해성 — 임베드 삽입도 같은 choke point(commitBody)를 지나지만, 매핑에서는 컨트롤러 updateField가
  // title을 거부(no-op)하므로 오류 없이 동작하고 원제목이 유지된다(본문-only 불변식).
  it('매핑 모드: 임베드 삽입이 오류 없이 동작하고 title은 갱신되지 않는다(원제목 유지)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const body = serialize([textBlock('본문첫줄'), textBlock('본문')]);
    const utils = setup({
      identity: { role: 'D' },
      pendingEdit: { article: { articleId: 'AKR9', title: '원제목', status: 'DPS' }, mode: 'mapping' },
      seed: {
        articles: [{ articleId: 'AKR9', title: '원제목', status: 'DPS', lockYN: 'Y', markupVersion: body }],
        mediaItems: [{ type: 'image', src: 'pic.png', title: '사진' }],
      },
    });
    await waitFor(() => expect(actionBtn('저장')).toBeInTheDocument());
    const { container, model } = utils;
    const save = vi.spyOn(model, 'saveArticle');

    await userEvent.click(screen.getByRole('button', { name: '이미지' }));
    await userEvent.type(screen.getByLabelText('image 검색어'), '사진');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    await userEvent.click((await screen.findByRole('img', { name: '사진' })).closest('button'));
    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());

    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const dto = save.mock.calls[save.mock.calls.length - 1][0];
    expect(dto.title).toBe('원제목'); // 매핑은 title 갱신이 컨트롤러에서 거부됨 — 원제목 그대로.
  });
});

// Step 2(29-editor-edit-menu): 편집 메뉴 문단/한줄/단어 선택(selection-wire) 결선.
// step0(editorRange 경계 계산) + step1(editorSelect 적용기)을 onMenuSelect 매핑 가드 뒤(edit.selectAll parity)에 연결.
// 선택 연산은 본문을 절대 바꾸지 않는다(선택-only) — 캐럿 소스는 lastCaretRef(메뉴 클릭으로 포커스 이탈).
describe('WriterPage — 편집 메뉴 문단/한줄/단어 선택 결선(editorRange·editorSelect)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    window.getSelection().removeAllRanges(); // 이전 테스트 selection 오염 차단
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

  // 캐럿을 텍스트-줄 lineIndex의 column 위치에 두고 keyUp으로 onCaretChange를 발생시켜 lastCaretRef를 갱신한다
  // (약물바 focusCaretAtLine의 컬럼 확장 — 단어 선택은 줄 안 위치가 필요하다).
  function focusCaretAt(container, lineIndex, column = 0) {
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    const tnode = lineEls[lineIndex].firstChild;
    if (tnode && tnode.nodeType === 3) {
      range.setStart(tnode, column);
      range.collapse(true);
    } else {
      range.selectNodeContents(lineEls[lineIndex]);
      range.collapse(true);
    }
    sel.addRange(range);
    fireEvent.keyUp(container.querySelector('.yh-editor'));
  }

  const editorLines = (container) => Array.from(container.querySelectorAll('.yh-editor .yh-editor__line')).map((el) => el.textContent);
  const editMenuItem = (label) => within(screen.getByTestId('menu-편집')).getByText(label).closest('button');

  it("편집 메뉴 '문단 선택'/'한줄 선택'/'단어 선택'이 활성이고 기존 항목 상태는 불변이다", async () => {
    await openWith([textBlock('헤드'), textBlock('본문')]);
    await openTopMenu('편집');
    expect(editMenuItem('문단 선택')).toBeEnabled();
    expect(editMenuItem('한줄 선택')).toBeEnabled();
    expect(editMenuItem('단어 선택')).toBeEnabled();
    // 기존 활성/비활성 항목 불변(회귀). 문서 정렬/한줄 지우기는 step 4(edit-ops-wire)에서 결선되어 활성.
    expect(editMenuItem('전체 선택')).toBeEnabled();
    expect(editMenuItem('찾기/바꾸기')).toBeEnabled();
    expect(editMenuItem('문서 정렬')).toBeEnabled();
    expect(editMenuItem('한줄 지우기')).toBeEnabled();
  });

  it("'한줄 선택': 캐럿 줄 전체가 선택되고 본문(updateField body)은 바뀌지 않는다(선택-only)", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const original = serialize([textBlock('헤드라인'), textBlock('본문 문장')]);
    const { container, model } = await openWith([textBlock('헤드라인'), textBlock('본문 문장')]);
    const save = vi.spyOn(model, 'saveArticle');
    focusCaretAt(container, 1);

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('한줄 선택'));

    expect(window.getSelection().toString()).toBe('본문 문장');
    expect(editorLines(container)).toEqual(['헤드라인', '본문 문장']); // DOM 본문 불변

    // 보류 저장 시 원본 body가 그대로 PUT된다(본문 무변경 — 선택-only 단언).
    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original);
  });

  it("'단어 선택': 캐럿 컬럼의 단어(editorRange 경계)가 선택된다(한글)", async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('안녕 세상 좋다')]);
    focusCaretAt(container, 1, 4); // '세상' 내부(col 4)

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('단어 선택'));

    expect(window.getSelection().toString()).toBe('세상');
    expect(editorLines(container)).toEqual(['헤드라인', '안녕 세상 좋다']);
  });

  it("'문단 선택': 캐럿 줄이 속한 문단(빈 줄 경계)의 줄들만 선택된다", async () => {
    const { container } = await openWith([
      textBlock('제목줄'), textBlock(''),
      textBlock('둘째 문단 첫줄'), textBlock('둘째 문단 둘째줄'),
      textBlock(''), textBlock('셋째 문단'),
    ]);
    focusCaretAt(container, 3); // '둘째 문단 둘째줄'

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('문단 선택'));

    const text = window.getSelection().toString();
    expect(text).toContain('둘째 문단 첫줄');
    expect(text).toContain('둘째 문단 둘째줄');
    expect(text).not.toContain('제목줄');
    expect(text).not.toContain('셋째 문단');
  });

  it('캐럿이 없으면(lastCaretRef null) 3종 모두 예외 없이 no-op(선택·본문 무변경)', async () => {
    const { container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    // 캐럿 미설정 — 메뉴 열기/클릭은 onCaretChange(keyUp/mouseUp on editor)를 발생시키지 않는다.
    for (const label of ['문단 선택', '한줄 선택', '단어 선택']) {
      await openTopMenu('편집');
      await userEvent.click(editMenuItem(label));
    }
    // userEvent 클릭이 메뉴 버튼 위에 collapsed selection을 남길 수 있어 rangeCount 대신
    // "선택된 텍스트 없음"으로 단언한다(결선 3종이 걸었다면 비-빈 줄 텍스트가 잡혔을 것).
    expect(window.getSelection().toString()).toBe(''); // 선택 무변경
    expect(editorLines(container)).toEqual(['헤드', '본문']); // 본문 무변경
  });

  it('매핑 모드: 3종 클릭이 no-op이고(매핑 가드 뒤 — selectAll parity) 본문도 바뀌지 않는다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const original = serialize([textBlock('헤드라인'), textBlock('본문 문장')]);
    const { container, model } = await openWith(
      [textBlock('헤드라인'), textBlock('본문 문장')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    const save = vi.spyOn(model, 'saveArticle');
    focusCaretAt(container, 1); // 매핑에서도 onCaretChange는 결선 — lastCaretRef가 채워진 상태로 가드를 검증

    for (const label of ['문단 선택', '한줄 선택', '단어 선택']) {
      await openTopMenu('편집');
      await userEvent.click(editMenuItem(label));
      expect(window.getSelection().toString()).toBe(''); // 캐럿(collapsed) 그대로 — 선택 무변경
    }

    // 저장 시 원본 body가 그대로 PUT된다(본문 무변경).
    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original);
  });
});

// Step 4(29-editor-edit-menu): 편집 메뉴 문서/문단 정렬·한줄/단어 지우기(edit-ops-wire) 결선.
// step3(editorEditOps 순수 계산)·deleteLineAt(Ctrl+D 단일 출처)을 onMenuSelect 매핑 가드 뒤에 연결.
// 본문 변경은 commitBody(serialize(...)) 단일 choke point만 — 제목(본문 첫 줄)은 commitBody가 자동 재동기화(phase 28).
describe('WriterPage — 편집 메뉴 문서/문단 정렬·한줄/단어 지우기 결선(editorEditOps)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    window.getSelection().removeAllRanges();
  });

  async function openWith(blocks, { mode = 'edit', status = 'RDS', role = 'R', title = '제목' } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId: 'AKR1', title, status }, mode },
      seed: { articles: [{ articleId: 'AKR1', title, status, lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  // 캐럿을 텍스트-줄 lineIndex의 column 위치에 두고 keyUp으로 onCaretChange를 발생시켜 lastCaretRef를 갱신한다(step 2 동형).
  function focusCaretAt(container, lineIndex, column = 0) {
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    const tnode = lineEls[lineIndex].firstChild;
    if (tnode && tnode.nodeType === 3) {
      range.setStart(tnode, column);
      range.collapse(true);
    } else {
      range.selectNodeContents(lineEls[lineIndex]);
      range.collapse(true);
    }
    sel.addRange(range);
    fireEvent.keyUp(container.querySelector('.yh-editor'));
  }

  const editorLines = (container) => Array.from(container.querySelectorAll('.yh-editor .yh-editor__line')).map((el) => el.textContent);
  const editMenuItem = (label) => within(screen.getByTestId('menu-편집')).getByText(label).closest('button');

  // 보류(hold) 저장으로 서버에 실리는 dto를 관찰한다(phase 28 title 재동기화 테스트 동형).
  async function holdAndGetDto(model) {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const save = vi.spyOn(model, 'saveArticle');
    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    return save.mock.calls[save.mock.calls.length - 1][0];
  }

  it("편집 메뉴 '문서 정렬'/'문단 정렬'/'한줄 지우기'/'단어 지우기'가 활성이고 기존 항목 상태는 불변이다", async () => {
    await openWith([textBlock('헤드'), textBlock('본문')]);
    await openTopMenu('편집');
    expect(editMenuItem('문서 정렬')).toBeEnabled();
    expect(editMenuItem('문단 정렬')).toBeEnabled();
    expect(editMenuItem('한줄 지우기')).toBeEnabled();
    expect(editMenuItem('단어 지우기')).toBeEnabled();
    // 기존 활성/비활성 항목 불변(회귀) — step 2 선택 3종 활성·미결선(DEFER) 항목 비활성.
    expect(editMenuItem('문단 선택')).toBeEnabled();
    expect(editMenuItem('전체 선택')).toBeEnabled();
    // 되돌리기/다시실행(undo/redo)은 37-editor-undo-redo에서 결선돼 활성 — 잘라내기는 36-editor-edit-clipboard에서 결선됨.
    expect(editMenuItem('되돌리기')).toBeEnabled();
    expect(editMenuItem('다시실행')).toBeEnabled();
  });

  it("'문서 정렬': 텍스트 줄이 정렬되고 \"(끝)\" 마커는 최종 유지, 제목이 새 첫 줄로 재동기화된다(commitBody)", async () => {
    const { container, model } = await openWith(
      [textBlock('다라 소식'), textBlock('가나 소식'), textBlock('(끝)')],
      { title: '다라 소식' },
    );

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('문서 정렬'));

    await waitFor(() => expect(editorLines(container)).toEqual(['가나 소식', '다라 소식', '(끝)']));
    // 제목 재동기화 — commitBody 단일 경로(저장 dto.title이 새 첫 줄, stale 방지).
    const dto = await holdAndGetDto(model);
    expect(dto.title).toBe('가나 소식');
    expect(deserialize(dto.markupVersion).at(-1).text).toBe('(끝)'); // 마커 최종 블록 유지
  });

  it("'문단 정렬': 캐럿 문단(빈 줄 경계)만 정렬되고 다른 문단은 불변이다", async () => {
    const { container } = await openWith([
      textBlock('제목줄'), textBlock(''),
      textBlock('나 둘째줄'), textBlock('가 첫째줄'),
      textBlock(''), textBlock('하'), textBlock('자'),
    ]);
    focusCaretAt(container, 3); // '가 첫째줄' — 둘째 문단(줄 2~3)

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('문단 정렬'));

    await waitFor(() => expect(editorLines(container)).toEqual([
      '제목줄', '', '가 첫째줄', '나 둘째줄', '', '하', '자', // 셋째 문단('하','자')은 미정렬 그대로
    ]));
  });

  it("'한줄 지우기': 캐럿 줄이 삭제되고(Ctrl+D 단일 소스) 첫 줄 삭제 시 제목이 새 첫 줄로 재동기화된다", async () => {
    const { container, model } = await openWith(
      [textBlock('옛첫줄'), textBlock('새첫줄'), textBlock('본문')],
      { title: '옛첫줄' },
    );
    focusCaretAt(container, 0);

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('한줄 지우기'));

    await waitFor(() => expect(editorLines(container)).toEqual(['새첫줄', '본문']));
    const dto = await holdAndGetDto(model);
    expect(dto.title).toBe('새첫줄'); // Ctrl+D와 공용 코어 — commitBody가 제목 자동 재동기화
  });

  it("'한줄 지우기': \"(끝)\" 마커 줄에서 실행하면 마커 줄이 통째로 삭제된다(news.md L167 — 입력 재개)", async () => {
    const { container } = await openWith([textBlock('제목'), textBlock('본문'), textBlock('(끝)')]);
    focusCaretAt(container, 2); // 마커 줄

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('한줄 지우기'));

    await waitFor(() => expect(editorLines(container)).toEqual(['제목', '본문']));
  });

  it("'단어 지우기': 캐럿 컬럼의 단어만 삭제된다(한글, 주변 공백 유지)", async () => {
    const { container } = await openWith([textBlock('헤드라인'), textBlock('안녕 세상 좋다')]);
    focusCaretAt(container, 1, 4); // '세상' 내부(col 4)

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('단어 지우기'));

    await waitFor(() => expect(editorLines(container)).toEqual(['헤드라인', '안녕  좋다']));
  });

  it("'단어 지우기': \"(끝)\" 마커 줄에서는 no-op(본문 불변 — 저장 시 원본 PUT)", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const blocks = [textBlock('제목'), textBlock('본문'), textBlock('(끝)')];
    const original = serialize(blocks);
    const { container, model } = await openWith(blocks, { title: '제목' });
    focusCaretAt(container, 2, 1); // 마커 줄 내부

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('단어 지우기'));

    expect(editorLines(container)).toEqual(['제목', '본문', '(끝)']);
    // changed:false → commitBody 미호출(no-op 존중) — 저장 dto가 원본 그대로.
    const dto = await holdAndGetDto(model);
    expect(dto.markupVersion).toBe(original);
  });

  it('캐럿이 없으면(lastCaretRef null) 문단 정렬/한줄·단어 지우기는 예외 없이 no-op이다', async () => {
    const { container } = await openWith([textBlock('나'), textBlock('가')]);
    for (const label of ['문단 정렬', '한줄 지우기', '단어 지우기']) {
      await openTopMenu('편집');
      await userEvent.click(editMenuItem(label));
    }
    expect(editorLines(container)).toEqual(['나', '가']); // 본문 무변경
  });

  it('매핑 모드: 정렬/삭제 4종 클릭이 본문(updateField body)을 바꾸지 않는다(텍스트 잠금 가드)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const blocks = [textBlock('나 둘째'), textBlock('가 첫째'), textBlock('본문 문장')];
    const original = serialize(blocks);
    const { container, model } = await openWith(blocks, { mode: 'mapping', status: 'DPS', role: 'D', title: '나 둘째' });
    const save = vi.spyOn(model, 'saveArticle');
    focusCaretAt(container, 1); // lastCaretRef가 채워진 상태로 가드를 검증(step 2 동형)

    for (const label of ['문서 정렬', '문단 정렬', '한줄 지우기', '단어 지우기']) {
      await openTopMenu('편집');
      await userEvent.click(editMenuItem(label));
    }
    expect(editorLines(container)).toEqual(['나 둘째', '가 첫째', '본문 문장']); // 본문 무변경

    // 저장 시 원본 body가 그대로 PUT된다(매핑 가드 — commitBody 미호출).
    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original);
  });

  // 리뷰 게이트(MAJOR): lastCaretRef는 문서(탭)-로컬 좌표인데 탭 전환에서 초기화되지 않으면
  // 이전 탭의 캐럿으로 '한줄/단어 지우기'가 현재 탭의 엉뚱한 줄을 삭제한다(되돌리기 미구현 — 복구 불가).
  it("탭 전환 후 캐럿 소스가 초기화된다 — 이전 탭 캐럿(stale)으로 '한줄 지우기'가 실행되지 않는다", async () => {
    const { container } = await openWith([textBlock('가나'), textBlock('다라'), textBlock('마바')], { title: '가나' });
    focusCaretAt(container, 1); // 탭 A에서 캐럿 기록(lineIndex 1 — '다라')

    // 새 작성 탭으로 전환했다가 원래 탭으로 복귀 — 그동안 본문을 클릭하지 않아 새 캐럿 기록이 없다.
    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' }));
    await waitFor(() => expect(editorLines(container)).not.toContain('다라'));
    await userEvent.click(screen.getByRole('button', { name: '가나' }));
    await waitFor(() => expect(editorLines(container)).toEqual(['가나', '다라', '마바']));

    await openTopMenu('편집');
    await userEvent.click(editMenuItem('한줄 지우기'));

    // 전환 이전 캐럿은 무효 — 삭제가 일어나지 않는다(no-op). 초기화가 없으면 '다라'가 지워진다.
    expect(editorLines(container)).toEqual(['가나', '다라', '마바']);
  });
});

// Step 2(30-editor-spellcheck): 맞춤법 메뉴(spell.*) 5종 결선 — Step 0 엔진(editorSpell) + Step 1 다이얼로그(SpellCheckDialog).
// 검사는 읽기전용(본문/캐럿/임베드 불변 — 항목 클릭은 focusMatchLine 캐럿 이동만). prefs는 실행 시점 로드
// (checkOption+errorTypes → 활성 규칙군, errorStyle → 오류 조각 스타일). 매핑 가드 앞(파일 정보와 동일 정책).
// 기존 spell state(브라우저 네이티브 spellCheck 속성)와 별개 기능이다.
describe('WriterPage — 맞춤법 검사(spell.*) 결선', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });

  async function openWith(blocks, { mode = 'edit', status = 'RDS', role = 'R', title = '제목' } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId: 'AKR1', title, status }, mode },
      seed: { articles: [{ articleId: 'AKR1', status, lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  // 맞춤법 prefs만 부분 저장(다른 카테고리는 기본값 유지) — columnLimit 저장 헬퍼와 동형. errorTypes는 중첩 병합.
  const saveSpellPrefs = (patch) => saveEditorPrefs({
    ...loadEditorPrefs(),
    spellcheck: {
      ...loadEditorPrefs().spellcheck,
      ...patch,
      errorTypes: { ...loadEditorPrefs().spellcheck.errorTypes, ...(patch.errorTypes || {}) },
    },
  });

  // 에디터 캐럿을 lineIndex 줄 시작에 두고 keyUp으로 onCaretChange를 발생시킨다(lastCaretRef 갱신 — 검색패널 결선과 동일 경로).
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

  // 맞춤법 메뉴를 열고 항목을 클릭한다(파일 정보 결선과 동일 패턴). getByText는 exact 매치라
  // '통합 맞춤법 검사'가 '통합 맞춤법 검사 안함'을 오클릭하지 않는다.
  async function clickSpellMenu(label) {
    await openTopMenu('맞춤법');
    const menu = screen.getByTestId('menu-맞춤법');
    await userEvent.click(within(menu).getByText(label).closest('button'));
  }

  it('맞춤법 메뉴 5종이 활성이다(MENU_ENABLED — 비활성→활성)', async () => {
    await openWith([textBlock('제목'), textBlock('본문')]);
    await openTopMenu('맞춤법');
    const menu = screen.getByTestId('menu-맞춤법');
    for (const label of ['통합 맞춤법 검사', '문단식 검사', '현재위치까지 검사', '현재위치부터 검사', '통합 맞춤법 검사 안함']) {
      expect(within(menu).getByText(label).closest('button')).toBeEnabled();
    }
  });

  it("errorTypes.multiWord 저장 후 '통합 맞춤법 검사' → 다이얼로그에 중복 어절 이슈가 보인다", async () => {
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    await openWith([textBlock('제목'), textBlock('먹었다 먹었다')]);
    await clickSpellMenu('통합 맞춤법 검사');
    expect(screen.getByTestId('spellcheck')).toBeInTheDocument();
    const item = screen.getByTestId('spellcheck-item-0');
    expect(item).toHaveTextContent('먹었다');
    expect(item).toHaveTextContent('중복된 어절');
  });

  it("errorStyle:'underline' 저장 후 검사 → 오류 조각이 data-style=\"underline\"로 렌더된다", async () => {
    saveSpellPrefs({ errorStyle: 'underline', errorTypes: { multiWord: true } });
    await openWith([textBlock('제목'), textBlock('먹었다 먹었다')]);
    await clickSpellMenu('통합 맞춤법 검사');
    expect(screen.getAllByTestId('spellcheck-snippet')[0]).toHaveAttribute('data-style', 'underline');
  });

  it('오류가 없는 본문에서 검사 → spellcheck-empty 빈 상태가 보인다', async () => {
    await openWith([textBlock('제목'), textBlock('본문')]);
    await clickSpellMenu('통합 맞춤법 검사');
    expect(screen.getByTestId('spellcheck-empty')).toBeInTheDocument();
  });

  it("'통합 맞춤법 검사 안함' 클릭 → 다이얼로그가 닫힌다(결과 비움)", async () => {
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    await openWith([textBlock('제목'), textBlock('먹었다 먹었다')]);
    await clickSpellMenu('통합 맞춤법 검사');
    expect(screen.getByTestId('spellcheck')).toBeInTheDocument();
    await clickSpellMenu('통합 맞춤법 검사 안함');
    expect(screen.queryByTestId('spellcheck')).toBeNull();
  });

  it('결과 항목 클릭 → 캐럿만 이동하고 본문(markupVersion)은 불변, 다이얼로그는 유지된다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    const blocks = [textBlock('제목'), textBlock('먹었다 먹었다')];
    const original = serialize(blocks);
    const { model } = await openWith(blocks);
    const save = vi.spyOn(model, 'saveArticle');

    await clickSpellMenu('통합 맞춤법 검사');
    // 캐럿 이동은 에디터 focus() 호출로 확인한다 — jsdom은 contentEditable 캐럿을 신뢰성 있게 반영하지
    // 않으므로(검색패널 결선과 동일), 실제 줄 배치는 Editor.test.jsx pendingCaretLine 단위테스트가 보증.
    const realFocus = HTMLElement.prototype.focus;
    const editorFocuses = [];
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function focusImpl(...args) {
      if (this.classList && this.classList.contains('yh-editor')) editorFocuses.push(this);
      return realFocus.apply(this, args);
    });
    await userEvent.click(screen.getByTestId('spellcheck-item-0'));

    expect(screen.getByTestId('spellcheck')).toBeInTheDocument(); // 다이얼로그 유지(찾기 선례)
    await waitFor(() => expect(editorFocuses.length).toBeGreaterThanOrEqual(1)); // 캐럿이 이슈 줄로 이동

    // 본문 불변 — 보류 저장 dto의 markupVersion이 원본 그대로다(updateField('body')/serialize 미호출).
    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original);
  });

  it("매핑 모드에서도 '통합 맞춤법 검사'가 활성이고 다이얼로그가 열린다(읽기전용 — 매핑 가드 앞)", async () => {
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    await openWith(
      [textBlock('제목'), textBlock('먹었다 먹었다'), textBlock('(끝)')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    await openTopMenu('맞춤법');
    const menu = screen.getByTestId('menu-맞춤법');
    expect(within(menu).getByText('통합 맞춤법 검사').closest('button')).toBeEnabled();
    await userEvent.click(within(menu).getByText('통합 맞춤법 검사').closest('button'));
    expect(screen.getByTestId('spellcheck')).toBeInTheDocument();
    expect(screen.getByTestId('spellcheck-item-0')).toHaveTextContent('중복된 어절');
  });

  it("'현재위치까지 검사'는 캐럿 앞 구간만 검사한다(toCaret — 캐럿 뒤 오류 제외)", async () => {
    saveSpellPrefs({ errorTypes: { misuse: true } });
    const { container } = await openWith([textBlock('역활 테스트'), textBlock('왠만하면 좋다')]);
    focusCaretAtLine(container, 1); // 캐럿 = 둘째 줄 시작(offset 7)
    await clickSpellMenu('현재위치까지 검사');
    expect(screen.getByTestId('spellcheck-count')).toHaveTextContent('1건');
    expect(screen.getByTestId('spellcheck-item-0')).toHaveTextContent('역활');
  });

  it("'현재위치부터 검사'는 캐럿 뒤 구간만 검사한다(fromCaret — 캐럿 앞 오류 제외)", async () => {
    saveSpellPrefs({ errorTypes: { misuse: true } });
    const { container } = await openWith([textBlock('역활 테스트'), textBlock('왠만하면 좋다')]);
    focusCaretAtLine(container, 1);
    await clickSpellMenu('현재위치부터 검사');
    expect(screen.getByTestId('spellcheck-count')).toHaveTextContent('1건');
    expect(screen.getByTestId('spellcheck-item-0')).toHaveTextContent('왠만');
  });

  it("'문단식 검사'는 캐럿 문단(빈 줄 구분)만 검사한다", async () => {
    saveSpellPrefs({ errorTypes: { misuse: true } });
    const { container } = await openWith([textBlock('첫문단 역활'), textBlock(''), textBlock('둘째 왠만하면')]);
    focusCaretAtLine(container, 2); // 캐럿 = 셋째 줄(둘째 문단)
    await clickSpellMenu('문단식 검사');
    expect(screen.getByTestId('spellcheck-count')).toHaveTextContent('1건');
    expect(screen.getByTestId('spellcheck-item-0')).toHaveTextContent('왠만');
  });

  // 리뷰 게이트(phase 30 ⑤): 캐럿 폴백 0이 toCaret을 빈 범위 {0,0}으로 만들어 오류가 있어도
  // "맞춤법 오류가 없습니다"로 오보고했다 — scoped 검사는 캐럿 기록이 없으면 no-op(phase 29 편집 메뉴 선례).
  it('캐럿 기록이 없으면 문단식/현재위치까지/현재위치부터 검사는 다이얼로그를 열지 않는다(거짓 "오류 없음" 방지)', async () => {
    saveSpellPrefs({ errorTypes: { misuse: true } });
    await openWith([textBlock('역활 테스트'), textBlock('왠만하면 좋다')]);
    for (const label of ['문단식 검사', '현재위치까지 검사', '현재위치부터 검사']) {
      await clickSpellMenu(label);
      expect(screen.queryByTestId('spellcheck')).toBeNull();
    }
    await clickSpellMenu('통합 맞춤법 검사'); // 전체 검사는 캐럿 무관 — 정상 동작 유지
    expect(screen.getByTestId('spellcheck')).toBeInTheDocument();
    expect(screen.getByTestId('spellcheck-count')).toHaveTextContent('2건');
  });

  // 리뷰 게이트(phase 30 ⑤): spellIssues의 start/snippet은 문서(탭)-로컬 스냅샷 — 탭을 넘어 이월되면
  // 다른 기사의 오류 목록을 표시하고 항목 클릭이 엉뚱한 줄로 캐럿을 옮긴다(phase 29 lastCaretRef 불변식과 동일 계열).
  it('탭을 전환하면 맞춤법 결과 다이얼로그가 닫히고 스냅샷이 초기화된다(문서-로컬 좌표 이월 금지)', async () => {
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    await openWith([textBlock('가나'), textBlock('먹었다 먹었다')], { title: '가나' });
    await clickSpellMenu('통합 맞춤법 검사');
    expect(screen.getByTestId('spellcheck')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' }));
    expect(screen.queryByTestId('spellcheck')).toBeNull();

    // 원래 탭으로 복귀해도 이전 스냅샷은 재표시되지 않는다(재검사 필요).
    await userEvent.click(screen.getByRole('button', { name: '가나' }));
    expect(screen.queryByTestId('spellcheck')).toBeNull();
  });

  // 리뷰 게이트(phase 30 ⑤) 테스트 공백 보강: 임베드가 낀 본문에서 이슈 오프셋/snippet이
  // blocksToText(임베드 제외) 좌표와 정합하는지 잠근다 — 좌표계가 갈라지면 snippet이 밀려 어긋난다.
  it('임베드가 낀 본문에서도 이슈 snippet이 텍스트 좌표와 정합한다(blocksToText 임베드 제외 좌표계)', async () => {
    saveSpellPrefs({ errorTypes: { misuse: true } });
    await openWith([
      textBlock('제목 역활'),
      embedBlock({ embedType: 'image', src: 'https://img/x.png' }),
      textBlock('둘째 왠만하면'),
    ]);
    await clickSpellMenu('통합 맞춤법 검사');
    expect(screen.getByTestId('spellcheck-count')).toHaveTextContent('2건');
    const snippets = screen.getAllByTestId('spellcheck-snippet').map((el) => el.textContent);
    expect(snippets).toEqual(['역활', '왠만']); // 임베드로 오프셋이 밀리면 조각이 어긋난다
  });
});

// Step 2(39-editor-spell-highlight): 규칙엔진 이슈를 본문 하이라이트로 결선 — runSpellCheck가 raw의
// start/end span을 spellHighlights(표시 전용 state)로 세팅해 Editor(step1 렌더)에 prop으로 넘긴다.
// 클리어 3경로: 실편집(commitBody, nextBody!==body — 타이핑/Ctrl+D 등 모든 편집)·탭 전환·checkOff.
// blur 재색칠(무편집, nextBody===body)은 클리어를 통과해 하이라이트가 보존된다([low-1]).
// 다이얼로그(spellIssues/spellStyle — phase 30 완료 계약)와 별개 state — 그쪽 결선은 불변.
describe('WriterPage — 맞춤법 본문 하이라이트(spellHighlights) 결선', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });

  async function openWith(blocks, { mode = 'edit', status = 'RDS', role = 'R', title = '제목' } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId: 'AKR1', title, status }, mode },
      seed: { articles: [{ articleId: 'AKR1', status, lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  // 맞춤법 prefs만 부분 저장 — phase 30 spell describe의 헬퍼와 동형(errorTypes 중첩 병합).
  const saveSpellPrefs = (patch) => saveEditorPrefs({
    ...loadEditorPrefs(),
    spellcheck: {
      ...loadEditorPrefs().spellcheck,
      ...patch,
      errorTypes: { ...loadEditorPrefs().spellcheck.errorTypes, ...(patch.errorTypes || {}) },
    },
  });

  async function clickSpellMenu(label) {
    await openTopMenu('맞춤법');
    const menu = screen.getByTestId('menu-맞춤법');
    await userEvent.click(within(menu).getByText(label).closest('button'));
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

  const hlSpans = (container) => Array.from(container.querySelectorAll('.yh-editor__spell'));
  const editorLines = (container) => Array.from(
    container.querySelectorAll('.yh-editor__line'),
  ).map((el) => el.textContent);

  it("'통합 맞춤법 검사' → 오류 텍스트가 본문에 .yh-editor__spell--bold(기본)로 하이라이트되고 다이얼로그도 뜬다", async () => {
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    const { container } = await openWith([textBlock('제목'), textBlock('먹었다 먹었다')]);
    await clickSpellMenu('통합 맞춤법 검사');
    expect(screen.getByTestId('spellcheck')).toBeInTheDocument(); // 다이얼로그(phase 30) 불변
    await waitFor(() => expect(hlSpans(container).length).toBeGreaterThanOrEqual(1));
    const span = hlSpans(container)[0];
    expect(span.classList.contains('yh-editor__spell--bold')).toBe(true);
    expect(span.textContent).toContain('먹었다');
  });

  it("errorStyle:'underline' prefs → 하이라이트가 underline 클래스로 렌더된다", async () => {
    saveSpellPrefs({ errorStyle: 'underline', errorTypes: { multiWord: true } });
    const { container } = await openWith([textBlock('제목'), textBlock('먹었다 먹었다')]);
    await clickSpellMenu('통합 맞춤법 검사');
    await waitFor(() => expect(hlSpans(container).length).toBeGreaterThanOrEqual(1));
    expect(hlSpans(container)[0].classList.contains('yh-editor__spell--underline')).toBe(true);
  });

  it("'통합 맞춤법 검사 안함' → 본문 하이라이트가 제거된다", async () => {
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    const { container } = await openWith([textBlock('제목'), textBlock('먹었다 먹었다')]);
    await clickSpellMenu('통합 맞춤법 검사');
    await waitFor(() => expect(hlSpans(container).length).toBeGreaterThanOrEqual(1));
    await clickSpellMenu('통합 맞춤법 검사 안함');
    await waitFor(() => expect(hlSpans(container).length).toBe(0));
  });

  it('검사 후 본문 타이핑(onTextChange→commitBody) → 하이라이트가 제거되고 본문이 갱신된다', async () => {
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    const { container } = await openWith([textBlock('제목'), textBlock('먹었다 먹었다')]);
    await clickSpellMenu('통합 맞춤법 검사');
    await waitFor(() => expect(hlSpans(container).length).toBeGreaterThanOrEqual(1));

    // 브라우저 입력 모사 — 오류 줄을 평문으로 교체 후 input(handleInput→onTextChange→commitBody).
    const box = container.querySelector('.yh-editor');
    container.querySelectorAll('.yh-editor__line')[1].textContent = '먹었다 잘';
    fireEvent.input(box);

    await waitFor(() => expect(hlSpans(container).length).toBe(0)); // 검사 스냅샷 무효화
    await waitFor(() => expect(editorLines(container)).toEqual(['제목', '먹었다 잘'])); // 본문 갱신
  });

  // onTextChange만 클리어했다면 남았을 stale 하이라이트를 잠근다 — commitBody가 모든 편집 경로를 덮는다.
  it('검사 후 Ctrl+D 줄 삭제(비-onTextChange 편집 경로) → 하이라이트가 제거된다', async () => {
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    const { container } = await openWith([textBlock('제목'), textBlock('먹었다 먹었다'), textBlock('셋째')]);
    await clickSpellMenu('통합 맞춤법 검사');
    await waitFor(() => expect(hlSpans(container).length).toBeGreaterThanOrEqual(1));

    caretAtLine(container, 2); // 오류 줄이 아닌 '셋째' 줄 삭제도 좌표를 무효화한다
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'd', ctrlKey: true });

    await waitFor(() => expect(editorLines(container)).toEqual(['제목', '먹었다 먹었다']));
    expect(hlSpans(container).length).toBe(0);
  });

  // [low-1] 무편집 blur 재색칠(nextBody===body)은 클리어를 통과 — 포커스만 이탈해도 사라지지 않는다.
  it('검사 후 편집 없이 blur → 하이라이트가 유지된다', async () => {
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    const { container } = await openWith([textBlock('제목'), textBlock('먹었다 먹었다')]);
    await clickSpellMenu('통합 맞춤법 검사');
    await waitFor(() => expect(hlSpans(container).length).toBeGreaterThanOrEqual(1));

    fireEvent.blur(container.querySelector('.yh-editor')); // blur 재색칠 emit — 무편집(nextBody===body)
    await waitFor(() => expect(hlSpans(container).length).toBeGreaterThanOrEqual(1)); // 보존
  });

  it('탭 전환 → 새 탭에 하이라이트가 없고, 원래 탭으로 복귀해도 재표시되지 않는다(문서-로컬 좌표 이월 금지)', async () => {
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    const { container } = await openWith([textBlock('가나'), textBlock('먹었다 먹었다')], { title: '가나' });
    await clickSpellMenu('통합 맞춤법 검사');
    await waitFor(() => expect(hlSpans(container).length).toBeGreaterThanOrEqual(1));

    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' }));
    expect(hlSpans(container).length).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: '가나' }));
    expect(hlSpans(container).length).toBe(0); // 재검사 필요(스냅샷 미보존)
  });

  it("매핑 모드에서 '통합 맞춤법 검사' → 본문 하이라이트가 표시된다(읽기전용 — 크래시 없음)", async () => {
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    const { container } = await openWith(
      [textBlock('제목'), textBlock('먹었다 먹었다'), textBlock('(끝)')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    await openTopMenu('맞춤법');
    const menu = screen.getByTestId('menu-맞춤법');
    await userEvent.click(within(menu).getByText('통합 맞춤법 검사').closest('button'));
    await waitFor(() => expect(hlSpans(container).length).toBeGreaterThanOrEqual(1));
  });

  // 핵심 가드 — 하이라이트는 표시 전용: 검사만으로 본문 직렬화/히스토리 캡처를 유발하지 않는다.
  it('검사만 하면(편집 없음) 저장되는 markupVersion이 원본 그대로다(본문/undo 무접촉)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    saveSpellPrefs({ errorTypes: { multiWord: true } });
    const blocks = [textBlock('제목'), textBlock('먹었다 먹었다')];
    const original = serialize(blocks);
    const { container, model } = await openWith(blocks);
    const save = vi.spyOn(model, 'saveArticle');

    await clickSpellMenu('통합 맞춤법 검사');
    await waitFor(() => expect(hlSpans(container).length).toBeGreaterThanOrEqual(1));

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original);
  });
});

// Step 3(31-editor-table): 표 메뉴(table.*) 10종 결선 — step0 모델(tableModel) + step1 렌더(InlineEmbed) +
// step2 다이얼로그(TableEditDialog) 조립. 셀 편집 UX는 다이얼로그(본문 표는 읽기 전용 렌더 — 더블클릭 진입),
// 메뉴 연산의 대상 표는 캐럿 인접(findTargetTableIndex — 캐럿 없으면 마지막 표 폴백), 복사/잘라내기는 시스템
// 클립보드 TSV. 표는 임베드라 매핑 가드 앞 라우팅(phase 18/19 임베드 parity). 본문 반영은 전부
// commitBody(serialize(...)) 단일 경로(텍스트 블록 불변 — 본문-only 불변식).
describe('WriterPage — 표 메뉴(table.*) 결선', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    window.getSelection().removeAllRanges();
  });
  afterEach(() => { delete navigator.clipboard; });

  async function openWith(blocks, { mode = 'edit', status = 'RDS', role = 'R', title = '제목' } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId: 'AKR1', title, status }, mode },
      seed: { articles: [{ articleId: 'AKR1', title, status, lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  // 캐럿을 텍스트-줄 lineIndex 시작에 두고 keyUp으로 onCaretChange를 발생시켜 lastCaretRef를 갱신한다(phase 29 동형).
  function focusCaretAt(container, lineIndex) {
    const lineEls = container.querySelectorAll('.yh-editor__line');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(lineEls[lineIndex]);
    range.collapse(true);
    sel.addRange(range);
    fireEvent.keyUp(container.querySelector('.yh-editor'));
  }

  const tableMenuItem = (label) => within(screen.getByTestId('menu-표')).getByText(label).closest('button');
  const editorLines = (container) => Array.from(container.querySelectorAll('.yh-editor .yh-editor__line')).map((el) => el.textContent);
  const tableFigure = (container) => container.querySelector('figure[data-embed-type="table"]');
  // 본문 표들의 렌더 그리드(셀 텍스트 2차원 배열) — 표별.
  const grids = (container) => Array.from(container.querySelectorAll('figure[data-embed-type="table"]'))
    .map((fig) => Array.from(fig.querySelectorAll('tr'))
      .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent)));
  const grid = (container) => grids(container)[0];
  const tableEmbed = (rows) => embedBlock({ embedType: 'table', rows });

  it("'표' 메뉴 10종이 모두 활성이다(MENU_ENABLED — 비활성→활성)", async () => {
    await openWith([textBlock('제목'), textBlock('본문')]);
    await openTopMenu('표');
    for (const label of [
      '표 삽입', '표 삭제', '표 복사', '표 잘라내기', '행 삭제', '열 삭제',
      '위에 행 추가', '아래에 행 추가', '왼쪽에 열 추가', '오른쪽에 열 추가',
    ]) {
      expect(tableMenuItem(label)).toBeEnabled();
    }
  });

  it("'표 삽입': 다이얼로그 적용 시 캐럿 줄 뒤에 table 임베드가 삽입되고 셀 값이 보존된다", async () => {
    const { container } = await openWith([textBlock('제목'), textBlock('본문')]);
    focusCaretAt(container, 1); // '본문' 줄 — 임베드는 그 줄 뒤에 삽입(기존 insertEmbed 경로)

    await openTopMenu('표');
    await userEvent.click(tableMenuItem('표 삽입'));
    const dialog = await screen.findByTestId('table-dialog');
    await userEvent.type(within(dialog).getByTestId('table-dialog-cell-0-0'), '값A');
    await userEvent.click(within(dialog).getByTestId('table-dialog-submit'));

    await waitFor(() => expect(tableFigure(container)).toBeTruthy());
    expect(screen.queryByTestId('table-dialog')).toBeNull(); // 적용 후 닫힘
    expect(grid(container)).toEqual([['값A', ''], ['', '']]); // 기본 2×2 그리드 + 입력 셀 보존
    expect(editorLines(container)).toEqual(['제목', '본문', '']); // 텍스트 블록 불변 + 임베드 뒤 빈 줄(커서 이동용)
  });

  it('본문 표 더블클릭 → 기존 rows로 다이얼로그가 열리고 적용 시 그 블록만 갱신된다(텍스트 불변)', async () => {
    const { container } = await openWith([
      textBlock('제목'), tableEmbed([['a', 'b'], ['c', 'd']]), textBlock('본문'),
    ]);

    fireEvent.doubleClick(container.querySelector('figure[data-embed-type="table"] td'));
    const dialog = await screen.findByTestId('table-dialog');
    expect(within(dialog).getByTestId('table-dialog-cell-0-0')).toHaveValue('a');
    expect(within(dialog).getByTestId('table-dialog-cell-1-1')).toHaveValue('d');

    await userEvent.type(within(dialog).getByTestId('table-dialog-cell-0-0'), '수정'); // 'a수정'
    await userEvent.click(within(dialog).getByTestId('table-dialog-submit'));

    await waitFor(() => expect(grid(container)).toEqual([['a수정', 'b'], ['c', 'd']]));
    expect(screen.queryByTestId('table-dialog')).toBeNull();
    expect(editorLines(container)).toEqual(['제목', '본문']); // 텍스트 블록 불변
  });

  it('표가 아닌 곳 더블클릭은 다이얼로그를 열지 않는다(no-op)', async () => {
    const { container } = await openWith([textBlock('제목'), tableEmbed([['a']]), textBlock('본문')]);
    fireEvent.doubleClick(container.querySelectorAll('.yh-editor__line')[0]);
    expect(screen.queryByTestId('table-dialog')).toBeNull();
  });

  it('행/열 연산: 아래/오른쪽은 끝에, 위/왼쪽은 index 0에 추가되고 행/열 삭제는 마지막을 지운다', async () => {
    const { container } = await openWith([
      textBlock('제목'), tableEmbed([['a', 'b'], ['c', 'd']]), textBlock('본문'),
    ]);

    await openTopMenu('표');
    await userEvent.click(tableMenuItem('아래에 행 추가'));
    await waitFor(() => expect(grid(container)).toEqual([['a', 'b'], ['c', 'd'], ['', '']]));

    await openTopMenu('표');
    await userEvent.click(tableMenuItem('오른쪽에 열 추가'));
    await waitFor(() => expect(grid(container)).toEqual([['a', 'b', ''], ['c', 'd', ''], ['', '', '']]));

    await openTopMenu('표');
    await userEvent.click(tableMenuItem('위에 행 추가'));
    await waitFor(() => expect(grid(container)).toEqual([['', '', ''], ['a', 'b', ''], ['c', 'd', ''], ['', '', '']]));

    await openTopMenu('표');
    await userEvent.click(tableMenuItem('왼쪽에 열 추가'));
    await waitFor(() => expect(grid(container)).toEqual([
      ['', '', '', ''], ['', 'a', 'b', ''], ['', 'c', 'd', ''], ['', '', '', ''],
    ]));

    await openTopMenu('표');
    await userEvent.click(tableMenuItem('행 삭제')); // 마지막 행 삭제
    await waitFor(() => expect(grid(container)).toEqual([['', '', '', ''], ['', 'a', 'b', ''], ['', 'c', 'd', '']]));

    await openTopMenu('표');
    await userEvent.click(tableMenuItem('열 삭제')); // 마지막 열 삭제
    await waitFor(() => expect(grid(container)).toEqual([['', '', ''], ['', 'a', 'b'], ['', 'c', 'd']]));

    expect(editorLines(container)).toEqual(['제목', '본문']); // 텍스트 블록 불변
  });

  it('행/열 삭제는 최소 1행 1열을 유지한다(1×1 no-op)', async () => {
    const { container } = await openWith([textBlock('제목'), tableEmbed([['홀로']])]);
    await openTopMenu('표');
    await userEvent.click(tableMenuItem('행 삭제'));
    await openTopMenu('표');
    await userEvent.click(tableMenuItem('열 삭제'));
    expect(grid(container)).toEqual([['홀로']]); // tableModel 최소 1행/1열 유지 규칙
  });

  it('대상 표 = 캐럿 인접(캐럿 이후 첫 표), 캐럿 기록이 없으면 마지막 표 폴백', async () => {
    const blocks = [
      textBlock('제목'), tableEmbed([['A']]), textBlock('중간'), tableEmbed([['B']]), textBlock('끝줄'),
    ];
    // 캐럿 없음 — 마지막 표(B)가 대상.
    const first = await openWith(blocks);
    await openTopMenu('표');
    await userEvent.click(tableMenuItem('아래에 행 추가'));
    await waitFor(() => expect(grids(first.container).map((g) => g.length)).toEqual([1, 2]));
    first.unmount();

    // 캐럿을 '제목' 줄에 — 이후 첫 표(A)가 대상.
    sessionStorage.clear();
    const second = await openWith(blocks);
    focusCaretAt(second.container, 0);
    await openTopMenu('표');
    await userEvent.click(tableMenuItem('아래에 행 추가'));
    await waitFor(() => expect(grids(second.container).map((g) => g.length)).toEqual([2, 1]));
  });

  it("'표 삭제': 대상 표 임베드만 제거되고 텍스트 블록은 유지된다", async () => {
    const { container } = await openWith([textBlock('제목'), tableEmbed([['a']]), textBlock('본문')]);
    await openTopMenu('표');
    await userEvent.click(tableMenuItem('표 삭제'));
    await waitFor(() => expect(tableFigure(container)).toBeNull());
    expect(editorLines(container)).toEqual(['제목', '본문']);
  });

  it("'표 복사': TSV로 클립보드에 쓴다(본문 불변) — '표 잘라내기': 쓰기 + 블록 제거", async () => {
    const { container } = await openWith([
      textBlock('제목'), tableEmbed([['a', 'b'], ['c', 'd']]), textBlock('본문'),
    ]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });

    await openTopMenu('표');
    fireEvent.click(tableMenuItem('표 복사'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('a\tb\nc\td'));
    expect(tableFigure(container)).toBeTruthy(); // 복사는 본문 불변
    expect(editorLines(container)).toEqual(['제목', '본문']);

    await openTopMenu('표');
    fireEvent.click(tableMenuItem('표 잘라내기'));
    await waitFor(() => expect(tableFigure(container)).toBeNull()); // 블록 제거
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls[1][0]).toEqual(expect.stringContaining('\t'));
    expect(editorLines(container)).toEqual(['제목', '본문']); // 텍스트 블록 불변
  });

  it('클립보드 미지원이면 표 복사는 alert만 하고 예외 없이 본문 불변이다', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { container } = await openWith([textBlock('제목'), tableEmbed([['a']])]);
    await openTopMenu('표');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
    fireEvent.click(tableMenuItem('표 복사'));
    expect(alert).toHaveBeenCalledWith('이 브라우저에서는 표 복사를 지원하지 않습니다.');
    expect(tableFigure(container)).toBeTruthy(); // 본문 불변
  });

  it('클립보드 거부(reject)여도 표 잘라내기의 제거는 진행된다(복사 실패는 alert만)', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { container } = await openWith([textBlock('제목'), tableEmbed([['a']]), textBlock('본문')]);
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });

    await openTopMenu('표');
    fireEvent.click(tableMenuItem('표 잘라내기'));

    await waitFor(() => expect(tableFigure(container)).toBeNull()); // 사용자 의도는 제거 — 복사 실패와 무관하게 진행
    await waitFor(() => expect(alert).toHaveBeenCalledWith('클립보드 접근이 거부되어 표를 복사할 수 없습니다.'));
    expect(editorLines(container)).toEqual(['제목', '본문']);
  });

  it('대상 표가 없으면 alert 후 본문 불변(no-op)', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { container } = await openWith([textBlock('제목'), textBlock('본문')]);
    for (const label of ['표 삭제', '표 복사', '표 잘라내기', '아래에 행 추가', '열 삭제']) {
      await openTopMenu('표');
      await userEvent.click(tableMenuItem(label));
    }
    expect(alert).toHaveBeenCalledTimes(5);
    expect(alert).toHaveBeenCalledWith('대상 표가 없습니다. 표 근처에 커서를 두세요.');
    expect(editorLines(container)).toEqual(['제목', '본문']); // 본문 불변
    expect(tableFigure(container)).toBeNull();
  });

  it('매핑 모드: 표 삽입/삭제가 동작하고(임베드 parity) 텍스트 블록은 불변이다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container, model } = await openWith(
      [textBlock('제목줄'), textBlock('본문줄')],
      { mode: 'mapping', status: 'DPS', role: 'D', title: '제목줄' },
    );
    const save = vi.spyOn(model, 'saveArticle');

    // 삽입 — 매핑에서는 캐럿/빈 줄 없이 끝에 append(insertEmbedAtLine 매핑 폴백 — 본문 텍스트 불변).
    await openTopMenu('표');
    await userEvent.click(tableMenuItem('표 삽입'));
    const dialog = await screen.findByTestId('table-dialog');
    await userEvent.type(within(dialog).getByTestId('table-dialog-cell-0-0'), '셀');
    await userEvent.click(within(dialog).getByTestId('table-dialog-submit'));
    await waitFor(() => expect(tableFigure(container)).toBeTruthy());
    expect(editorLines(container)).toEqual(['제목줄', '본문줄']); // 텍스트 블록 불변(빈 줄 미추가)

    // 행 추가 — 매핑에서도 임베드 블록 변경 허용.
    await openTopMenu('표');
    await userEvent.click(tableMenuItem('아래에 행 추가'));
    await waitFor(() => expect(grid(container).length).toBe(3));

    // 삭제 — 매핑에서도 동작.
    await openTopMenu('표');
    await userEvent.click(tableMenuItem('표 삭제'));
    await waitFor(() => expect(tableFigure(container)).toBeNull());
    expect(editorLines(container)).toEqual(['제목줄', '본문줄']);

    // 저장 — 텍스트 블록이 원본 그대로 PUT된다(본문-only 불변식).
    await userEvent.click(actionBtn('저장'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const dto = save.mock.calls[0][0];
    expect(deserialize(dto.markupVersion).filter((b) => b.type === 'text').map((b) => b.text))
      .toEqual(['제목줄', '본문줄']);
  });

  it('XSS end-to-end: 셀에 스크립트 태그를 입력해도 문자 그대로 렌더되고 script는 실행되지 않는다', async () => {
    const { container } = await openWith([textBlock('제목'), textBlock('본문')]);
    await openTopMenu('표');
    await userEvent.click(tableMenuItem('표 삽입'));
    const dialog = await screen.findByTestId('table-dialog');
    await userEvent.type(within(dialog).getByTestId('table-dialog-cell-0-0'), '<script>alert(1)</script>');
    await userEvent.click(within(dialog).getByTestId('table-dialog-submit'));

    await waitFor(() => expect(tableFigure(container)).toBeTruthy());
    expect(document.querySelector('script')).toBeNull(); // 스크립트 노드 미주입(step1 JSX 이스케이프)
    expect(container.querySelector('figure[data-embed-type="table"] td').textContent).toBe('<script>alert(1)</script>');
  });

  it('편집 다이얼로그가 열린 사이 대상 표가 삭제되면 적용은 본문을 바꾸지 않는다(stale blockIndex 방어)', async () => {
    const { container } = await openWith([textBlock('제목'), tableEmbed([['a']]), textBlock('본문')]);

    // 본문 표 더블클릭으로 편집 다이얼로그를 연다 — blockIndex=1이 캡처된다.
    fireEvent.doubleClick(container.querySelector('figure[data-embed-type="table"] td'));
    const dialog = await screen.findByTestId('table-dialog');

    // 다이얼로그가 열린 사이 메뉴로 그 표를 삭제한다 — 캡처된 blockIndex=1은 이제 텍스트 블록('본문')을 가리킨다.
    await openTopMenu('표');
    await userEvent.click(tableMenuItem('표 삭제'));
    await waitFor(() => expect(tableFigure(container)).toBeNull());

    // 적용 — onTableSubmit의 isTableEmbed 방어로 교체 없이 닫히기만 해야 한다.
    // 방어가 없으면 next[1] = 표 임베드가 텍스트 블록('본문')을 덮어써 본문이 파괴된다.
    await userEvent.click(within(dialog).getByTestId('table-dialog-submit'));
    expect(screen.queryByTestId('table-dialog')).toBeNull();
    expect(tableFigure(container)).toBeNull(); // 삭제된 표가 되살아나지 않는다
    expect(editorLines(container)).toEqual(['제목', '본문']); // 텍스트 블록 불변
  });

  // 리뷰 게이트(phase 31 ⑤): tableDialog의 blockIndex/rows는 문서(탭)-로컬 좌표 — 다이얼로그는 비모달이라
  // 열린 채 탭 전환이 가능하고, 이월되면 '적용'이 다른 기사의 blocks[N]을 덮어쓴다(phase 29/30 spellIssues와 동일 계열).
  it('탭을 전환하면 표 다이얼로그가 닫힌다(문서-로컬 blockIndex 이월 금지)', async () => {
    const { container } = await openWith(
      [textBlock('제목'), tableEmbed([['a']]), textBlock('본문')], { title: '표기사' },
    );
    fireEvent.doubleClick(container.querySelector('figure[data-embed-type="table"] td'));
    expect(await screen.findByTestId('table-dialog')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' }));
    expect(screen.queryByTestId('table-dialog')).toBeNull();

    // 원래 탭으로 복귀해도 재표시되지 않는다(더블클릭 재진입 필요).
    await userEvent.click(screen.getByRole('button', { name: '표기사' }));
    expect(screen.queryByTestId('table-dialog')).toBeNull();
  });
});

// Step 1(37-editor-undo-redo): 편집 메뉴 되돌리기(edit.undo)/다시실행(edit.redo) + Ctrl+Z/Ctrl+Shift+Z 결선.
// 캡처는 commitBody 단일 지점(타이핑만 코얼레싱), 히스토리는 탭 id 키 Map(세션-로컬·휘발, 탭 전환에 보존),
// 복원은 commitBody→blocks prop→Editor remount 단일 경로(DOM 직접 조작 없음). 매핑 no-op,
// 문서 리셋(submit/매핑저장 성공 → resetTabToBlank) 시 그 탭 히스토리 폐기(송고 본문 부활 금지).
describe('WriterPage — 되돌리기/다시실행(editorHistory 결선)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
    window.getSelection().removeAllRanges();
  });

  async function openWith(blocks, { mode = 'edit', status = 'RDS', role = 'R', title = '제목' } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId: 'AKR1', title, status }, mode },
      seed: { articles: [{ articleId: 'AKR1', title, status, lockYN: 'Y', markupVersion: body }] },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  const editorLines = (container) => Array.from(container.querySelectorAll('.yh-editor .yh-editor__line')).map((el) => el.textContent);
  const editMenuItem = (label) => within(screen.getByTestId('menu-편집')).getByText(label).closest('button');

  // 캐럿을 텍스트-줄 lineIndex 시작에 두고 keyUp으로 onCaretChange를 발생시킨다(lastCaretRef 갱신 — 기존 스위트 동형).
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

  // 결정적 본문 변경 헬퍼 — 보기>'대문자로 바꾸기'(view.toUpper)로 캐럿 줄을 변경한다(DOM 타이핑보다 안정,
  // coalesce=false 경로라 편집 op 하나 = undo 한 단계).
  async function upperLine(container, lineIndex) {
    focusCaretAtLine(container, lineIndex);
    await openTopMenu('보기');
    await userEvent.click(within(screen.getByTestId('menu-보기')).getByText('대문자로 바꾸기'));
  }

  async function clickEdit(label) {
    await openTopMenu('편집');
    await userEvent.click(editMenuItem(label));
  }

  it('본문 되돌리기/다시실행 왕복 — 편집 op 2회는 각자 한 단계씩 되돌려진다', async () => {
    const { container } = await openWith([textBlock('abc'), textBlock('def')], { title: 'abc' });
    await upperLine(container, 0);
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));
    await upperLine(container, 1);
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'DEF']));

    await clickEdit('되돌리기');
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));
    await clickEdit('되돌리기');
    await waitFor(() => expect(editorLines(container)).toEqual(['abc', 'def']));
    // 베이스라인(문서를 연 시점) 도달 — 추가 되돌리기는 no-op.
    await clickEdit('되돌리기');
    expect(editorLines(container)).toEqual(['abc', 'def']);

    await clickEdit('다시실행');
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));
  });

  it('redo 분기 절단 — 되돌리기 후 새 변경이 생기면 다시실행은 no-op이다', async () => {
    const { container } = await openWith([textBlock('abc'), textBlock('def')]);
    await upperLine(container, 0);
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));
    await clickEdit('되돌리기');
    await waitFor(() => expect(editorLines(container)).toEqual(['abc', 'def']));
    await upperLine(container, 1); // 새 변경 — 이전 redo 분기('ABC') 소실
    await waitFor(() => expect(editorLines(container)).toEqual(['abc', 'DEF']));

    await clickEdit('다시실행');
    expect(editorLines(container)).toEqual(['abc', 'DEF']); // 'ABC' 분기는 되살아나지 않는다
  });

  it('Ctrl+Z keydown → 되돌리기 + preventDefault(네이티브 undo 차단), Ctrl+Shift+Z → 다시실행', async () => {
    const { container } = await openWith([textBlock('abc'), textBlock('def')]);
    await upperLine(container, 0);
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));

    const box = container.querySelector('.yh-editor');
    const undoEv = createEvent.keyDown(box, { key: 'z', ctrlKey: true });
    const undoSpy = vi.spyOn(undoEv, 'preventDefault');
    fireEvent(box, undoEv);
    expect(undoSpy).toHaveBeenCalled();
    await waitFor(() => expect(editorLines(container)).toEqual(['abc', 'def']));

    const redoEv = createEvent.keyDown(container.querySelector('.yh-editor'), { key: 'z', ctrlKey: true, shiftKey: true });
    const redoSpy = vi.spyOn(redoEv, 'preventDefault');
    fireEvent(container.querySelector('.yh-editor'), redoEv);
    expect(redoSpy).toHaveBeenCalled();
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));
  });

  it('Ctrl+Y는 여전히 "(계속)삽입"이다 — 되돌리기가 아니다(회귀)', async () => {
    const { container } = await openWith([textBlock('abc'), textBlock('def')]);
    await upperLine(container, 0);
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));
    focusCaretAtLine(container, 1);
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'y', ctrlKey: true });
    await waitFor(() => expect(editorLines(container)).toContain('(계속)'));
    expect(editorLines(container)[0]).toBe('ABC'); // 직전 변경이 되돌려지지 않았다
  });

  it('히스토리는 탭별로 격리·보존된다 — 전환 후에도 각 탭의 되돌리기는 그 탭 본문만 되돌린다', async () => {
    const { container } = await openWith([textBlock('abc'), textBlock('def')], { title: 'abc' });
    await upperLine(container, 0); // 탭 A: ['ABC','def'] (제목도 'ABC'로 재동기화 — 탭 라벨)
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));

    // 새 작성 탭 B에서 타이핑 — B의 히스토리가 따로 쌓인다(blank 베이스라인).
    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' }));
    await waitFor(() => expect(editorLines(container)).toEqual([]));
    const box = () => container.querySelector('.yh-editor');
    box().textContent = '비본문';
    fireEvent.input(box());
    // 빈 에디터의 bare 텍스트 입력은 echo 경로라 라인 div가 없다 — 제목 재동기화(탭 라벨)로 커밋을 관찰한다.
    await waitFor(() => expect(screen.getByRole('button', { name: '비본문' })).toBeInTheDocument());

    // 탭 A로 복귀 — 전환에도 A의 히스토리가 보존되어 A 본문만 되돌려진다(B 불변).
    await userEvent.click(screen.getByRole('button', { name: 'ABC' }));
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));
    await clickEdit('되돌리기');
    await waitFor(() => expect(editorLines(container)).toEqual(['abc', 'def']));

    // 탭 B — B의 되돌리기는 B의 타이핑만 되돌리고 A 내용을 건드리지 않는다(문서-로컬 이월 없음).
    // 전환은 Editor remount(key=tabId)라 B의 본문이 라인 div로 렌더된다.
    await userEvent.click(screen.getByRole('button', { name: '비본문' }));
    await waitFor(() => expect(editorLines(container)).toEqual(['비본문']));
    await clickEdit('되돌리기');
    await waitFor(() => expect(editorLines(container)).toEqual([])); // B의 blank 베이스라인
    await userEvent.click(screen.getByRole('button', { name: 'abc' }));
    await waitFor(() => expect(editorLines(container)).toEqual(['abc', 'def'])); // A 불변
  });

  it('보류 성공으로 탭이 빈 새 기사로 리셋되면 되돌리기가 이전 기사 본문을 되살리지 않는다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = await openWith([textBlock('abc'), textBlock('def')], { title: 'abc' });
    await upperLine(container, 0);
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));

    await userEvent.click(actionBtn('보류')); // R+RDS 보류 → RRH 성공 → resetTabToBlank(같은 탭 id, blank fields)
    await waitFor(() => expect(editorLines(container)).toEqual([]));

    // 히스토리가 폐기되고 다음 렌더의 lazy 시드가 blank 베이스라인 — 되돌리기/다시실행 no-op(송고 본문 부활 없음).
    await clickEdit('되돌리기');
    expect(editorLines(container)).toEqual([]);
    await clickEdit('다시실행');
    expect(editorLines(container)).toEqual([]);
  });

  it('매핑 모드에서는 되돌리기/다시실행이 본문을 바꾸지 않는다(메뉴·키 모두 no-op)', async () => {
    const { container } = await openWith(
      [textBlock('abc'), textBlock('def')],
      { mode: 'mapping', status: 'DPS', role: 'D', title: 'abc' },
    );
    // 매핑에서 허용되는 임베드 변경(표 삽입)으로 히스토리에 스냅샷을 만든다 — 가드가 없으면 undo가 표를 지운다.
    await openTopMenu('표');
    await userEvent.click(within(screen.getByTestId('menu-표')).getByText('표 삽입'));
    const dialog = await screen.findByTestId('table-dialog');
    await userEvent.type(within(dialog).getByTestId('table-dialog-cell-0-0'), '셀');
    await userEvent.click(within(dialog).getByTestId('table-dialog-submit'));
    const tableFigure = () => container.querySelector('figure.yh-embed[data-embed-type="table"]');
    await waitFor(() => expect(tableFigure()).toBeTruthy());

    await clickEdit('되돌리기'); // 매핑 no-op — 표가 사라지지 않는다
    expect(tableFigure()).toBeTruthy();
    expect(editorLines(container)).toEqual(['abc', 'def']);
    // 키보드 — 매핑은 Editor에 onKeyDown 자체가 미결선(이중 방어) → 본문 불변.
    fireEvent.keyDown(container.querySelector('.yh-editor'), { key: 'z', ctrlKey: true });
    expect(tableFigure()).toBeTruthy();
    await clickEdit('다시실행');
    expect(editorLines(container)).toEqual(['abc', 'def']);
  });

  it('타이핑 연타는 코얼레싱되어 되돌리기 1회로 버스트 전체가 되돌려진다', async () => {
    const { container } = await openWith([textBlock('가'), textBlock('나')], { title: '가' });
    vi.spyOn(Date, 'now').mockReturnValue(1000); // 코얼레싱 시간창(COALESCE_MS) 안에 고정
    const box = container.querySelector('.yh-editor');
    container.querySelectorAll('.yh-editor__line')[1].textContent = '나다';
    fireEvent.input(box);
    await waitFor(() => expect(editorLines(container)).toEqual(['가', '나다']));
    container.querySelectorAll('.yh-editor__line')[1].textContent = '나다라';
    fireEvent.input(box);
    await waitFor(() => expect(editorLines(container)).toEqual(['가', '나다라']));

    await clickEdit('되돌리기'); // 버스트가 한 단계 — 글자 단위('나다')로 멈추지 않는다
    await waitFor(() => expect(editorLines(container)).toEqual(['가', '나']));
  });

  it('코얼레싱 경계 — 편집 op 직후 시간창 내 타이핑은 op 스냅샷을 교체하지 않는다(각자 독립 undo 단계)', async () => {
    const { container } = await openWith([textBlock('abc'), textBlock('def')], { title: 'abc' });
    // 모든 커밋을 같은 시각에 고정 — 시간창(COALESCE_MS)이 아니라 '직전 커밋도 타이핑'(wasTyping)이
    // 코얼레싱 지속의 판정자임을 검증한다. 가드가 없으면 아래 타이핑이 op 스냅샷을 top 교체로 덮는다.
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    await upperLine(container, 0); // 편집 op(coalesce=false): ['ABC','def']
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));
    const box = container.querySelector('.yh-editor');
    container.querySelectorAll('.yh-editor__line')[1].textContent = 'def가';
    fireEvent.input(box); // 시간창 안 첫 타이핑 — 직전이 op라 push(교체 아님)여야 한다
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def가']));

    await clickEdit('되돌리기'); // 타이핑만 되돌아간다 — op 스냅샷('ABC')이 보존돼 있다
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));
    await clickEdit('되돌리기'); // op 자체도 별도 한 단계
    await waitFor(() => expect(editorLines(container)).toEqual(['abc', 'def']));
  });

  it('파일>복구는 하나의 undo 단계다 — 되돌리기 한 번으로 복구 전 본문으로 돌아가고 다시실행으로 재적용된다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = await openWith([textBlock('원본제목'), textBlock('원본본문')], { title: '원본제목' });
    saveDraft('AKR1', { title: '초안제목', body: serialize([textBlock('초안제목'), textBlock('초안본문')]) }, 1000);

    await openTopMenu('파일');
    await userEvent.click(within(screen.getByTestId('menu-파일')).getByText('복구'));
    await waitFor(() => expect(editorLines(container)).toEqual(['초안제목', '초안본문']));

    await clickEdit('되돌리기'); // 복구(commitBody 경로)가 한 단계 — 복구 전 본문으로 복귀
    await waitFor(() => expect(editorLines(container)).toEqual(['원본제목', '원본본문']));
    await clickEdit('다시실행'); // 대칭 — 복구 상태 재적용
    await waitFor(() => expect(editorLines(container)).toEqual(['초안제목', '초안본문']));
  });

  it('에디터 밖 입력(키워드 필드)의 Ctrl+Z/Ctrl+Shift+Z는 가로채지 않는다 — preventDefault 없음·본문 불변(네이티브 undo 보존)', async () => {
    const { container } = await openWith([textBlock('abc'), textBlock('def')], { title: 'abc' });
    await upperLine(container, 0); // undo 가능한 스냅샷을 만들어 둔다 — 오간섭 시 본문이 바뀌어 드러난다
    await waitFor(() => expect(editorLines(container)).toEqual(['ABC', 'def']));

    // 키 인터셉트는 에디터 컨테이너(contentEditable) 스코프다 — 다른 입력 필드에서는 버블돼도
    // 가로채지 않아 필드 자체의 네이티브 undo가 살아 있어야 한다(전역 리스너 회귀 가드).
    const keyword = screen.getByLabelText('키워드');
    const undoEv = createEvent.keyDown(keyword, { key: 'z', ctrlKey: true });
    const undoSpy = vi.spyOn(undoEv, 'preventDefault');
    fireEvent(keyword, undoEv);
    expect(undoSpy).not.toHaveBeenCalled();
    expect(editorLines(container)).toEqual(['ABC', 'def']); // 본문 되돌리기도 실행되지 않는다

    const redoEv = createEvent.keyDown(keyword, { key: 'z', ctrlKey: true, shiftKey: true });
    const redoSpy = vi.spyOn(redoEv, 'preventDefault');
    fireEvent(keyword, redoEv);
    expect(redoSpy).not.toHaveBeenCalled();
    expect(editorLines(container)).toEqual(['ABC', 'def']);
  });
});

// Step 2(41-photo-publish-db): 도구>사진발행/DB등록(tools.publishPhoto) 결선 — PhotoPublishDialog를 열어
// 현재 본문의 이미지 임베드를 골라 캡션과 함께 model.publishPhoto({src,caption,sourceArticleId})로 등록한다.
// 등록은 본문/캐럿/임베드 무변경(읽기 액션 — commitBody/serialize/insertEmbed 미호출) — 매핑 가드 앞 결선
// (매핑에서도 열림, tools.fileInfo와 동일 정책). 탭 전환 시 닫힘(imageEmbeds/sourceArticleId 탭-로컬).
describe('WriterPage — 사진발행/DB등록(tools.publishPhoto) 결선', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });

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

  // 도구 메뉴를 열고 '사진발행/DB등록'을 클릭한다(파일 정보/기사이력비교 결선과 동일 패턴).
  async function clickPublishPhoto() {
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText('사진발행/DB등록').closest('button'));
  }

  it("도구 메뉴 '사진발행/DB등록'(tools.publishPhoto)이 활성이다(MENU_ENABLED — 비활성→활성)", async () => {
    await openWith([textBlock('헤드')]);
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('사진발행/DB등록').closest('button')).toBeEnabled();
  });

  it('클릭 시 PhotoPublishDialog가 열리고, 본문의 이미지 임베드만 목록에 나타난다(영상/표 제외)', async () => {
    await openWith([
      textBlock('헤드'),
      embedBlock({ embedType: 'image', src: '/uploads/a.png', alt: '사진A' }),
      embedBlock({ embedType: 'video', src: 'https://youtube.com/watch?v=x' }),
      textBlock('본문'),
      embedBlock({ embedType: 'image', src: '/uploads/b.png', alt: '사진B' }),
    ]);
    await clickPublishPhoto();

    const dialog = screen.getByTestId('photo-publish');
    expect(screen.getByRole('dialog', { name: '사진발행/DB등록' })).toBeInTheDocument();
    const thumbs = within(dialog).getAllByRole('img');
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]).toHaveAttribute('src', '/uploads/a.png');
    expect(thumbs[1]).toHaveAttribute('src', '/uploads/b.png');
  });

  it('이미지 선택+캡션 입력+등록 → model.publishPhoto가 {src, caption, sourceArticleId=현재 기사아이디}로 호출되고 다이얼로그가 닫힌다', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { model } = await openWith([
      textBlock('헤드'),
      embedBlock({ embedType: 'image', src: '/uploads/a.png', alt: '사진A' }),
      embedBlock({ embedType: 'image', src: '/uploads/b.png', alt: '사진B' }),
      textBlock('본문'),
    ]);
    const publish = vi.spyOn(model, 'publishPhoto');

    await clickPublishPhoto();
    await userEvent.click(screen.getByTestId('photo-publish-choice-1'));
    fireEvent.change(screen.getByTestId('photo-publish-caption'), { target: { value: '현장 사진' } });
    await userEvent.click(screen.getByTestId('photo-publish-submit'));

    await waitFor(() => expect(publish).toHaveBeenCalledWith({
      src: '/uploads/b.png', caption: '현장 사진', sourceArticleId: 'AKR1',
    }));
    await waitFor(() => expect(screen.queryByTestId('photo-publish')).toBeNull());
    expect(alert).toHaveBeenCalledWith('사진을 DB에 등록했습니다.');
    // 등록→검색 루프(fakeModel in-memory 스토어) — 등록된 캡션으로 검색되면 실제로 등록된 것.
    const found = await model.searchPhotos('현장');
    expect(found.items).toHaveLength(1);
    expect(found.items[0].src).toBe('/uploads/b.png');
    expect(found.items[0].sourceArticleId).toBe('AKR1');
  });

  it('등록은 본문을 바꾸지 않는다(읽기 액션) — 등록 후 보류 저장 시 원본 markupVersion이 그대로 PUT된다', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const blocks = [
      textBlock('헤드'),
      embedBlock({ embedType: 'image', src: '/uploads/a.png', alt: '사진A' }),
      textBlock('본문'),
    ];
    const original = serialize(blocks);
    const { model } = await openWith(blocks);
    const save = vi.spyOn(model, 'saveArticle');

    await clickPublishPhoto();
    fireEvent.change(screen.getByTestId('photo-publish-caption'), { target: { value: '캡션' } });
    await userEvent.click(screen.getByTestId('photo-publish-submit'));
    await waitFor(() => expect(screen.queryByTestId('photo-publish')).toBeNull());

    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original);
  });

  it("매핑 탭에서도 '사진발행/DB등록'이 활성이고 다이얼로그가 열린다(매핑 가드 앞 — tools.fileInfo와 동일 정책)", async () => {
    await openWith(
      [textBlock('헤드'), embedBlock({ embedType: 'image', src: '/uploads/a.png', alt: '사진A' })],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('사진발행/DB등록').closest('button')).toBeEnabled();
    await userEvent.click(within(menu).getByText('사진발행/DB등록').closest('button'));
    expect(screen.getByTestId('photo-publish')).toBeInTheDocument();
  });

  it('신규(미저장) 탭에서는 sourceArticleId가 빈 문자열로 등록된다(best-effort 출처 — 등록을 막지 않음)', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    // 신규 작성 탭(pendingEdit 없음 — articleId 미생성) — 도구>그림 삽입(URL 직접 임베드,
    // 검색패널과 동일 insertEmbed 경로)으로 본문에 이미지 임베드를 만든 뒤 등록한다.
    const { model } = setup({ identity: { role: 'R' } });
    const publish = vi.spyOn(model, 'publishPhoto');
    await openTopMenu('도구');
    await userEvent.click(within(screen.getByTestId('menu-도구')).getByText('그림 삽입').closest('button'));
    fireEvent.change(screen.getByTestId('url-embed-input'), { target: { value: 'https://img.example.com/a.png' } });
    await userEvent.click(screen.getByTestId('url-embed-submit'));

    await clickPublishPhoto();
    fireEvent.change(screen.getByTestId('photo-publish-caption'), { target: { value: '신규 캡션' } });
    await userEvent.click(screen.getByTestId('photo-publish-submit'));

    await waitFor(() => expect(publish).toHaveBeenCalledWith({
      src: 'https://img.example.com/a.png', caption: '신규 캡션', sourceArticleId: '',
    }));
  });

  it('본문에 이미지 임베드가 없으면 빈 상태 안내가 뜨고 등록 버튼이 비활성이다(등록 불가 UX)', async () => {
    await openWith([textBlock('헤드'), textBlock('본문')]);
    await clickPublishPhoto();
    expect(screen.getByTestId('photo-publish-empty')).toBeInTheDocument();
    expect(screen.getByTestId('photo-publish-submit')).toBeDisabled();
  });

  it('등록 실패(!ok — 예: invalid-src)면 실패 alert만 안내하고 본문/다이얼로그 상태를 오염시키지 않는다', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { model } = await openWith([
      textBlock('헤드'),
      embedBlock({ embedType: 'image', src: '/uploads/a.png', alt: '사진A' }),
    ]);
    vi.spyOn(model, 'publishPhoto').mockResolvedValue({ ok: false, reason: 'invalid-src' });

    await clickPublishPhoto();
    await userEvent.click(screen.getByTestId('photo-publish-submit'));

    await waitFor(() => expect(alert).toHaveBeenCalledWith('사진 등록에 실패했습니다.'));
    await waitFor(() => expect(screen.queryByTestId('photo-publish')).toBeNull());
  });

  it('열린 채 탭을 전환하면 다이얼로그가 닫힌다(imageEmbeds/sourceArticleId 탭-로컬 — 이전 탭 이미지 이월 방지)', async () => {
    await openWith([
      textBlock('헤드'),
      embedBlock({ embedType: 'image', src: '/uploads/a.png', alt: '사진A' }),
    ]);
    await clickPublishPhoto();
    expect(screen.getByTestId('photo-publish')).toBeInTheDocument();

    // ＋ 버튼으로 새 작성 탭 추가 → 활성 탭 전환 → 조정 블록이 다이얼로그를 닫는다.
    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' }));
    await waitFor(() => expect(screen.queryByTestId('photo-publish')).toBeNull());
  });
});

// Step 3(41-photo-publish-db): 이미지 탭 검색 소스 토글(Google | 사진DB) — 사진DB는 model.searchPhotos로
// 등록된 사진을 캡션 검색하고, 픽은 기존 insertEmbed→makeImageEmbed 경로로 표준 image 임베드를 삽입한다
// (재임베드 루프 — SearchPanel/InlineEmbed 무변경, 소스 토글은 이미지 탭 내부 additive·5번째 탭 아님).
describe('WriterPage — 이미지 검색 소스(Google | 사진DB) 결선', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });

  const PHOTO = {
    id: 1, src: '/uploads/p1.png', caption: '현장 사진',
    sourceArticleId: 'AKR9', registeredBy: 'kim', createdAt: '2026-07-21T00:00:00.000Z',
  };

  async function openWith(blocks, { photos = [PHOTO], mode = 'edit', status = 'RDS', role = 'R' } = {}) {
    const body = serialize(blocks);
    const utils = setup({
      identity: { role },
      pendingEdit: { article: { articleId: 'AKR1', title: '제목', status }, mode },
      seed: { articles: [{ articleId: 'AKR1', status, lockYN: 'Y', markupVersion: body }], photos },
    });
    await waitFor(() => expect(utils.container.querySelector('.yh-editor__line')).toBeTruthy());
    return utils;
  }

  // 이미지 탭 열기 → 사진DB 소스 선택 → 검색까지의 공용 플로우.
  async function searchPhotoDb(q) {
    await userEvent.click(screen.getByRole('button', { name: '이미지' }));
    await userEvent.click(screen.getByRole('button', { name: '사진DB' }));
    await userEvent.type(screen.getByLabelText('image 검색어'), q);
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
  }

  it('이미지 탭에 Google/사진DB 소스 토글이 있고 기본은 Google이다', async () => {
    await openWith([textBlock('헤드'), textBlock('본문')]);
    await userEvent.click(screen.getByRole('button', { name: '이미지' }));
    const group = screen.getByRole('group', { name: '이미지 검색 소스' });
    const google = within(group).getByRole('button', { name: 'Google' });
    const photoDb = within(group).getByRole('button', { name: '사진DB' });
    expect(google.className).toContain('yh-tab--active');
    expect(photoDb.className).not.toContain('yh-tab--active');
  });

  it('기본(Google) 검색은 searchMedia만 부르고 searchPhotos는 부르지 않는다(기존 이미지 검색 회귀 가드)', async () => {
    const { model } = await openWith([textBlock('헤드')]);
    const media = vi.spyOn(model, 'searchMedia');
    const photos = vi.spyOn(model, 'searchPhotos');
    await userEvent.click(screen.getByRole('button', { name: '이미지' }));
    await userEvent.type(screen.getByLabelText('image 검색어'), '고양이');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(media).toHaveBeenCalledWith('고양이', 'image'));
    expect(photos).not.toHaveBeenCalled();
  });

  it("'사진DB' 선택+검색 → model.searchPhotos가 호출되고 결과 썸네일(item.src)이 렌더된다", async () => {
    const { model, container } = await openWith([textBlock('헤드')]);
    const spy = vi.spyOn(model, 'searchPhotos');
    await searchPhotoDb('현장');
    await waitFor(() => expect(spy).toHaveBeenCalledWith('현장'));
    // SearchPanel 이미지 브랜치가 item.src로 썸네일을 렌더한다(공용 컴포넌트 무변경).
    await waitFor(() => {
      const img = container.querySelector('[data-testid="meta-image"] .yh-media-result img');
      expect(img).toBeTruthy();
      expect(img.getAttribute('src')).toBe('/uploads/p1.png');
    });
  });

  it('사진 결과 픽 → 본문에 표준 image 임베드가 삽입된다(src=사진 src·alt=caption — 기존 insertEmbed 경로)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { model, container } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');

    await searchPhotoDb('현장');
    await waitFor(() => expect(container.querySelector('[data-testid="meta-image"] .yh-media-result')).toBeTruthy());
    await userEvent.click(container.querySelector('[data-testid="meta-image"] .yh-media-result'));
    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());

    // 보류 저장 → PUT 본문 blocks에 image 임베드(src=사진 src·alt=caption)가 추가돼 있다.
    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blocks = deserialize(save.mock.calls[0][0].markupVersion);
    const embed = blocks.find((b) => b.type === 'embed' && b.embedType === 'image');
    expect(embed).toBeTruthy();
    expect(embed.src).toBe('/uploads/p1.png');
    expect(embed.alt).toBe('현장 사진');
  });

  it('매핑 탭에서도 사진DB 픽이 임베드를 삽입한다(기존 이미지 픽과 동형 — 임베드 삽입은 매핑 허용)', async () => {
    const { container } = await openWith(
      [textBlock('헤드'), textBlock('본문')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    await searchPhotoDb('현장');
    await waitFor(() => expect(container.querySelector('[data-testid="meta-image"] .yh-media-result')).toBeTruthy());
    await userEvent.click(container.querySelector('[data-testid="meta-image"] .yh-media-result'));
    await waitFor(() => expect(container.querySelector('[data-embed-type="image"]')).toBeTruthy());
  });
});

// Step 3(42-editor-ui-language): 도구>UI 언어 설정(tools.uiLanguage) 결선 — 메뉴 클릭 시 controlled
// UiLanguageDialog를 열고(매핑 가드 앞 — 크롬 설정이라 본문 무관), 선택은 editorPrefs(ui.language)에 동기
// localStorage 영속하며, 선택 언어를 메뉴바(t)와 다이얼로그(t)에 동일 번역기로 실시간 반영한다.
// 기본값 ko는 메뉴바 라벨이 한국어 원문(바이트 동일 불변식). 본문/캐럿/임베드 무변경(saveArticle markupVersion 불변).
describe('WriterPage — UI 언어 설정(tools.uiLanguage) 결선', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { localStorage.clear(); });

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

  // 메뉴바만 켜는 헬퍼(상단 메뉴는 열지 않는다) — 언어 전환 후 상단 버튼 라벨을 검증할 때 쓴다
  // (openTopMenu는 항목명으로 클릭하므로 en 전환 후엔 라벨이 바뀌어 부적합).
  async function showMenuBar() {
    if (!screen.queryByTestId('menubar')) {
      fireEvent.contextMenu(screen.getByTestId('editor-canvas'));
      const ctx = await screen.findByTestId('editor-context-menu');
      await userEvent.click(within(ctx).getByText('메뉴바 보이기').closest('button'));
      await waitFor(() => expect(screen.getByTestId('menubar')).toBeInTheDocument());
    }
  }

  // 도구 메뉴를 열고 'UI 언어 설정'을 클릭한다(메모장/파일 정보 결선과 동일 패턴).
  async function clickUiLanguage() {
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    await userEvent.click(within(menu).getByText('UI 언어 설정').closest('button'));
  }

  it("도구 메뉴 'UI 언어 설정'(tools.uiLanguage)이 활성이다(MENU_ENABLED — 비활성→활성)", async () => {
    await openWith([textBlock('헤드')]);
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('UI 언어 설정').closest('button')).toBeEnabled();
  });

  it("'UI 언어 설정' 클릭 시 UiLanguageDialog(ui-language-dialog, role=dialog)가 열린다", async () => {
    await openWith([textBlock('헤드')]);
    await clickUiLanguage();
    expect(screen.getByTestId('ui-language-dialog')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('기본값 ko — 메뉴바 라벨이 한국어 원문이고 loadEditorPrefs().ui.language가 ko이다(바이트 동일 불변식)', async () => {
    await openWith([textBlock('헤드')]);
    await showMenuBar();
    // 상단 메뉴 버튼이 한국어 원문 그대로다.
    expect(screen.getByRole('menuitem', { name: '도구' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '파일' })).toBeInTheDocument();
    expect(loadEditorPrefs().ui.language).toBe('ko');
  });

  it("en 선택 시 editorPrefs에 영속되고(loadEditorPrefs().ui.language==='en') 메뉴바 라벨이 영문으로 실시간 갱신된다", async () => {
    await openWith([textBlock('헤드')]);
    await clickUiLanguage();
    // 다이얼로그에서 en 선택 → 동기 localStorage 영속 + 즉시 리렌더.
    await userEvent.click(screen.getByTestId('ui-language-option-en'));
    expect(loadEditorPrefs().ui.language).toBe('en');
    // 같은 렌더에서 t 재생성 → 메뉴바 상단 버튼 라벨이 영문으로 갱신(도구→Tools, 파일→File).
    expect(screen.getByRole('menuitem', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'File' })).toBeInTheDocument();
    // 열린 다이얼로그의 닫기 라벨도 같은 번역기로 영문 반영(Close).
    expect(screen.getByTestId('ui-language-close')).toHaveTextContent('Close');
  });

  it('재마운트 시 저장된 en이 복원돼 메뉴바가 영문으로 뜬다(마운트 lazy-init + effect 복원)', async () => {
    // 마운트 전에 en을 심어두면 uiLanguage 초기화(useState + 마운트 effect)가 이를 복원해야 한다(새로고침/재접속 지속).
    saveEditorPrefs(setEditorPref(loadEditorPrefs(), 'ui', { language: 'en' }));
    await openWith([textBlock('헤드')]);
    await showMenuBar();
    expect(screen.getByRole('menuitem', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'File' })).toBeInTheDocument();
  });

  it('열린 채 탭을 전환하면 UI 언어 다이얼로그가 닫힌다(비모달 이월 방지 — 조정 블록 setShowUiLanguage(false))', async () => {
    await openWith([textBlock('헤드')]);
    await clickUiLanguage();
    expect(screen.getByTestId('ui-language-dialog')).toBeInTheDocument();
    // ＋ 버튼으로 새 작성 탭 추가 → 활성 탭 전환 → 조정 블록이 다이얼로그를 닫는다.
    await userEvent.click(screen.getByRole('button', { name: '새 작성 탭' }));
    await waitFor(() => expect(screen.queryByTestId('ui-language-dialog')).toBeNull());
  });

  it("매핑 탭에서도 'UI 언어 설정'이 활성이고 다이얼로그가 열린다(크롬 설정 — 매핑 가드 앞, 죽은 버튼 아님)", async () => {
    await openWith(
      [textBlock('제목'), textBlock('본문'), textBlock('(끝)')],
      { mode: 'mapping', status: 'DPS', role: 'D' },
    );
    await openTopMenu('도구');
    const menu = screen.getByTestId('menu-도구');
    expect(within(menu).getByText('UI 언어 설정').closest('button')).toBeEnabled();
    await userEvent.click(within(menu).getByText('UI 언어 설정').closest('button'));
    expect(screen.getByTestId('ui-language-dialog')).toBeInTheDocument();
  });

  it('본문 무변경 — UI 언어를 열고 en 선택/닫기 해도 본문(saveArticle markupVersion)이 그대로 PUT된다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const original = serialize([textBlock('헤드'), textBlock('본문')]);
    const { model } = await openWith([textBlock('헤드'), textBlock('본문')]);
    const save = vi.spyOn(model, 'saveArticle');

    await clickUiLanguage();
    await userEvent.click(screen.getByTestId('ui-language-option-en'));
    await userEvent.click(screen.getByTestId('ui-language-close'));

    // 저장 시 원본 body가 그대로 PUT된다(commitBody/serialize/updateField('body',…) 미호출 → 본문 무변경).
    await userEvent.click(actionBtn('보류'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].markupVersion).toBe(original);
  });
});
