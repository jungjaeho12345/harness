import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  render, screen, waitFor, fireEvent, createEvent,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../app/context.js';
import { WriterPage } from './WriterPage.jsx';
import { PENDING_EDIT_KEY } from '../controller/useViewController.js';
import { createFakeModel } from '../test/fakeModel.js';
import { serialize, textBlock, embedBlock } from './editorContent.js';

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
