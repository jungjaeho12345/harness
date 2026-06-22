import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EditorPrefsDialog } from './EditorPrefsDialog.jsx';
import { loadEditorPrefs, saveEditorPrefs, DEFAULT_EDITOR_PREFS } from './editorPrefs.js';
import { colorForRole, resetEditorColors } from './editorColoring.js';
import { setDateFormat, DEFAULT_DATE_FORMAT } from './listFormat.js';

// 색상 환경설정 모달 — 폼/적용/취소/기본값. editorPrefs(localStorage) + editorColoring(module 상태)을 직접 호출하므로
// localStorage.clear()(영속 누수 차단) + resetEditorColors()(module 상태 복원)로 격리한다.
describe('EditorPrefsDialog — 색상 환경설정 모달', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { resetEditorColors(); });

  it('open=false면 렌더하지 않는다', () => {
    const { container } = render(<EditorPrefsDialog open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('열리면 제목/부제목/본문/바탕 색 입력 4개를 보여준다(end는 없음)', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId('pref-color-title')).toBeInTheDocument();
    expect(screen.getByTestId('pref-color-subtitle')).toBeInTheDocument();
    expect(screen.getByTestId('pref-color-body')).toBeInTheDocument();
    expect(screen.getByTestId('pref-color-background')).toBeInTheDocument();
    expect(screen.queryByTestId('pref-color-end')).toBeNull();
  });

  it("부제목 색을 바꾸고 '적용' 시 saveEditorPrefs로 저장되고 colorForRole도 새 값을 반환한다", () => {
    const onClose = vi.fn();
    render(<EditorPrefsDialog open onClose={onClose} />);

    fireEvent.change(screen.getByTestId('pref-color-subtitle'), { target: { value: '#00ff00' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    // 영속(saveEditorPrefs) + 적용(setEditorColors) 둘 다 반영.
    expect(loadEditorPrefs().colors.subtitle).toBe('#00ff00');
    expect(colorForRole('subtitle')).toBe('#00ff00');
    // applied=true로 닫힘.
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("'적용'은 바탕색을 텍스트 색(setEditorColors)으로 적용하지 않는다(저장에만 반영)", () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pref-color-background'), { target: { value: '#222222' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    expect(loadEditorPrefs().colors.background).toBe('#222222'); // 저장됨
    // 바탕색은 텍스트 색 화이트리스트가 아니므로 colorForRole(body)는 기본 본문색 유지.
    expect(colorForRole('body')).toBe(DEFAULT_EDITOR_PREFS.colors.body);
  });

  it("'취소' 시 저장/적용 없이 닫히고 색이 불변이다", () => {
    const onClose = vi.fn();
    render(<EditorPrefsDialog open onClose={onClose} />);

    fireEvent.change(screen.getByTestId('pref-color-subtitle'), { target: { value: '#00ff00' } });
    fireEvent.click(screen.getByTestId('prefs-cancel'));

    // 저장 안 됨(기본값 유지) + module 색 불변.
    expect(loadEditorPrefs().colors.subtitle).toBe(DEFAULT_EDITOR_PREFS.colors.subtitle);
    expect(colorForRole('subtitle')).toBe(DEFAULT_EDITOR_PREFS.colors.subtitle);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it("'기본값'은 폼 색을 DEFAULT_EDITOR_PREFS 색으로 되돌린다", () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    const subtitle = screen.getByTestId('pref-color-subtitle');

    fireEvent.change(subtitle, { target: { value: '#00ff00' } });
    expect(subtitle).toHaveValue('#00ff00');

    fireEvent.click(screen.getByTestId('prefs-reset'));
    expect(subtitle).toHaveValue(DEFAULT_EDITOR_PREFS.colors.subtitle);
  });
});

// 탭 구조(색상/날짜형식) + 날짜형식 탭 — phase 12. 색상 탭은 위 describe가 회귀를 지킨다.
// 다이얼로그는 listFormat.setDateFormat을 직접 부르지 않지만(저장만, 적용은 ListPage), 격리 규칙대로 module 상태도 복원한다.
describe('EditorPrefsDialog — 탭 구조 + 날짜형식', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { resetEditorColors(); setDateFormat(DEFAULT_DATE_FORMAT); });

  it('색상/날짜형식 탭을 보여주고 전환된다(기본은 색상 탭)', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId('prefs-tab-colors')).toBeInTheDocument();
    expect(screen.getByTestId('prefs-tab-dateFormat')).toBeInTheDocument();

    // 기본은 색상 탭 — 색 입력이 보이고 날짜형식 select는 없다.
    expect(screen.getByTestId('pref-color-title')).toBeInTheDocument();
    expect(screen.queryByTestId('pref-dateFormat')).toBeNull();

    // 날짜형식 탭으로 전환 — 날짜형식 select가 보이고 색 입력은 사라진다.
    fireEvent.click(screen.getByTestId('prefs-tab-dateFormat'));
    expect(screen.getByTestId('pref-dateFormat')).toBeInTheDocument();
    expect(screen.queryByTestId('pref-color-title')).toBeNull();
  });

  it('날짜형식 select 초기값은 저장값(loadEditorPrefs().dateFormat)이다', () => {
    saveEditorPrefs({ ...loadEditorPrefs(), dateFormat: 'YYYY.MM.DD' });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-dateFormat'));
    expect(screen.getByTestId('pref-dateFormat')).toHaveValue('YYYY.MM.DD');
  });

  it("날짜형식을 고르고 '적용'하면 editorPrefs.dateFormat에 저장되고 닫힌다", () => {
    const onClose = vi.fn();
    render(<EditorPrefsDialog open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('prefs-tab-dateFormat'));
    fireEvent.change(screen.getByTestId('pref-dateFormat'), { target: { value: 'YYYY.MM.DD' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    expect(loadEditorPrefs().dateFormat).toBe('YYYY.MM.DD');
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("'적용'은 색과 날짜형식을 함께 저장한다(탭 전환해도 미적용 색이 보존된다)", () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    // 색상 탭에서 부제목 변경 → 날짜형식 탭으로 전환 후 날짜형식 변경 → 적용.
    fireEvent.change(screen.getByTestId('pref-color-subtitle'), { target: { value: '#00ff00' } });
    fireEvent.click(screen.getByTestId('prefs-tab-dateFormat'));
    fireEvent.change(screen.getByTestId('pref-dateFormat'), { target: { value: 'YYYY/MM/DD HH:mm' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const prefs = loadEditorPrefs();
    expect(prefs.colors.subtitle).toBe('#00ff00');
    expect(prefs.dateFormat).toBe('YYYY/MM/DD HH:mm');
  });
});

// 자동저장 탭 — phase 13. 색상/날짜형식 탭(위 describe)을 깨지 않고 자동저장 탭만 추가했는지 확인한다.
describe('EditorPrefsDialog — 자동저장 탭', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { resetEditorColors(); setDateFormat(DEFAULT_DATE_FORMAT); });

  it('자동저장 탭으로 전환하면 사용/간격/보존기한 입력을 보여준다', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId('prefs-tab-autosave')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('prefs-tab-autosave'));
    expect(screen.getByTestId('pref-autosave-enabled')).toBeInTheDocument();
    expect(screen.getByTestId('pref-autosave-interval')).toBeInTheDocument();
    expect(screen.getByTestId('pref-autosave-retention')).toBeInTheDocument();
    // 다른 탭의 입력은 보이지 않는다.
    expect(screen.queryByTestId('pref-color-title')).toBeNull();
  });

  it('자동저장 입력 초기값은 저장값(loadEditorPrefs().autosave)이다', () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      autosave: { enabled: true, intervalSec: 120, retentionDays: 3 },
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-autosave'));

    expect(screen.getByTestId('pref-autosave-enabled')).toBeChecked();
    expect(screen.getByTestId('pref-autosave-interval')).toHaveValue('120');
    expect(screen.getByTestId('pref-autosave-retention')).toHaveValue('3');
  });

  it("자동저장을 설정하고 '적용'하면 editorPrefs.autosave에 반영된다(숫자로 저장)", () => {
    const onClose = vi.fn();
    render(<EditorPrefsDialog open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('prefs-tab-autosave'));

    fireEvent.click(screen.getByTestId('pref-autosave-enabled'));
    fireEvent.change(screen.getByTestId('pref-autosave-interval'), { target: { value: '180' } });
    fireEvent.change(screen.getByTestId('pref-autosave-retention'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const { autosave } = loadEditorPrefs();
    expect(autosave.enabled).toBe(true);
    expect(autosave.intervalSec).toBe(180); // 문자열이 아닌 숫자
    expect(autosave.retentionDays).toBe(5);
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('적용은 색·날짜형식·자동저장을 함께 저장한다(상호 보존)', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pref-color-subtitle'), { target: { value: '#00ff00' } });
    fireEvent.click(screen.getByTestId('prefs-tab-dateFormat'));
    fireEvent.change(screen.getByTestId('pref-dateFormat'), { target: { value: 'YYYY.MM.DD' } });
    fireEvent.click(screen.getByTestId('prefs-tab-autosave'));
    fireEvent.click(screen.getByTestId('pref-autosave-enabled'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const prefs = loadEditorPrefs();
    expect(prefs.colors.subtitle).toBe('#00ff00');
    expect(prefs.dateFormat).toBe('YYYY.MM.DD');
    expect(prefs.autosave.enabled).toBe(true);
  });

  it("'기본값'은 자동저장 폼을 DEFAULT_EDITOR_PREFS.autosave로 되돌린다", () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      autosave: { enabled: true, intervalSec: 300, retentionDays: 7 },
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-autosave'));
    expect(screen.getByTestId('pref-autosave-enabled')).toBeChecked();

    fireEvent.click(screen.getByTestId('prefs-reset'));
    expect(screen.getByTestId('pref-autosave-enabled')).not.toBeChecked();
    expect(screen.getByTestId('pref-autosave-interval'))
      .toHaveValue(String(DEFAULT_EDITOR_PREFS.autosave.intervalSec));
    expect(screen.getByTestId('pref-autosave-retention'))
      .toHaveValue(String(DEFAULT_EDITOR_PREFS.autosave.retentionDays));
  });
});

// 바이라인 탭 — phase 15 step 0. 색상/자동저장/날짜형식 탭(위 describe)을 깨지 않고 바이라인 탭만 추가했는지 확인한다.
// 바이라인 = { email(사용여부), emailValue(값), blog(사용여부), blogValue(값) } — localStorage(editorPrefs) 전용.
describe('EditorPrefsDialog — 바이라인 탭', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { resetEditorColors(); setDateFormat(DEFAULT_DATE_FORMAT); });

  it('바이라인 탭으로 전환하면 email/emailValue/blog/blogValue 입력 4개를 보여준다', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId('prefs-tab-byline')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('prefs-tab-byline'));
    expect(screen.getByTestId('pref-byline-email')).toBeInTheDocument();
    expect(screen.getByTestId('pref-byline-emailValue')).toBeInTheDocument();
    expect(screen.getByTestId('pref-byline-blog')).toBeInTheDocument();
    expect(screen.getByTestId('pref-byline-blogValue')).toBeInTheDocument();
    // 다른 탭의 입력은 보이지 않는다.
    expect(screen.queryByTestId('pref-color-title')).toBeNull();
  });

  it('바이라인 입력 초기값은 저장값(loadEditorPrefs().byline)이다', () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      byline: {
        email: true, emailValue: 'a@b.com', blog: false, blogValue: 'blog.example',
      },
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-byline'));

    expect(screen.getByTestId('pref-byline-email')).toBeChecked();
    expect(screen.getByTestId('pref-byline-emailValue')).toHaveValue('a@b.com');
    expect(screen.getByTestId('pref-byline-blog')).not.toBeChecked();
    expect(screen.getByTestId('pref-byline-blogValue')).toHaveValue('blog.example');
  });

  it("email 사용 체크 + 값 입력 후 '적용'하면 editorPrefs.byline에 영속된다", () => {
    const onClose = vi.fn();
    render(<EditorPrefsDialog open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('prefs-tab-byline'));

    fireEvent.click(screen.getByTestId('pref-byline-email'));
    fireEvent.change(screen.getByTestId('pref-byline-emailValue'), { target: { value: 'reporter@yna.co.kr' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const { byline } = loadEditorPrefs();
    expect(byline.email).toBe(true);
    expect(byline.emailValue).toBe('reporter@yna.co.kr');
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('적용은 색·자동저장·날짜형식·바이라인을 함께 저장한다(상호 보존 — 바이라인만 바꿔도 나머지 유지)', () => {
    // 색/자동저장/날짜형식을 먼저 저장해 두고, 바이라인만 바꿔 적용해도 나머지가 보존되는지 확인.
    saveEditorPrefs({
      ...loadEditorPrefs(),
      colors: { ...DEFAULT_EDITOR_PREFS.colors, subtitle: '#00ff00' },
      autosave: { enabled: true, intervalSec: 120, retentionDays: 3 },
      dateFormat: 'YYYY.MM.DD',
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-byline'));
    fireEvent.click(screen.getByTestId('pref-byline-blog'));
    fireEvent.change(screen.getByTestId('pref-byline-blogValue'), { target: { value: 'blog.yna.co.kr' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const prefs = loadEditorPrefs();
    // 바이라인 반영
    expect(prefs.byline.blog).toBe(true);
    expect(prefs.byline.blogValue).toBe('blog.yna.co.kr');
    // 나머지 보존
    expect(prefs.colors.subtitle).toBe('#00ff00');
    expect(prefs.autosave.enabled).toBe(true);
    expect(prefs.autosave.intervalSec).toBe(120);
    expect(prefs.dateFormat).toBe('YYYY.MM.DD');
  });

  it('색상만 바꿔 적용해도 바이라인은 보존된다(반대 방향 상호 보존)', () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      byline: {
        email: true, emailValue: 'keep@me.com', blog: true, blogValue: 'keep.blog',
      },
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pref-color-subtitle'), { target: { value: '#123456' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const prefs = loadEditorPrefs();
    expect(prefs.colors.subtitle).toBe('#123456');
    expect(prefs.byline.email).toBe(true);
    expect(prefs.byline.emailValue).toBe('keep@me.com');
    expect(prefs.byline.blog).toBe(true);
    expect(prefs.byline.blogValue).toBe('keep.blog');
  });

  it("'기본값'은 바이라인 폼을 DEFAULT_EDITOR_PREFS.byline로 되돌린다", () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      byline: {
        email: true, emailValue: 'x@y.com', blog: true, blogValue: 'z.blog',
      },
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-byline'));
    expect(screen.getByTestId('pref-byline-email')).toBeChecked();

    fireEvent.click(screen.getByTestId('prefs-reset'));
    expect(screen.getByTestId('pref-byline-email')).not.toBeChecked();
    expect(screen.getByTestId('pref-byline-emailValue')).toHaveValue('');
    expect(screen.getByTestId('pref-byline-blog')).not.toBeChecked();
    expect(screen.getByTestId('pref-byline-blogValue')).toHaveValue('');
  });
});

// 편집 탭 — phase 16 step 1. 기존 색상/자동저장/바이라인/날짜형식 탭을 깨지 않고 편집 탭만 추가했는지 확인한다.
// 편집 = { columnLimit, dragDrop, noCommonAbbr, companyCode, language, lineSpacing, inputMode } — localStorage(editorPrefs) 전용(저장만, effect 없음).
describe('EditorPrefsDialog — 편집 탭', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { resetEditorColors(); setDateFormat(DEFAULT_DATE_FORMAT); });

  it('편집 탭으로 전환하면 7개 필드를 보여주고 다른 탭 입력은 사라진다', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId('prefs-tab-edit')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('prefs-tab-edit'));
    expect(screen.getByTestId('pref-edit-columnLimit')).toBeInTheDocument();
    expect(screen.getByTestId('pref-edit-dragDrop')).toBeInTheDocument();
    expect(screen.getByTestId('pref-edit-noCommonAbbr')).toBeInTheDocument();
    expect(screen.getByTestId('pref-edit-companyCode')).toBeInTheDocument();
    expect(screen.getByTestId('pref-edit-language')).toBeInTheDocument();
    expect(screen.getByTestId('pref-edit-lineSpacing')).toBeInTheDocument();
    expect(screen.getByTestId('pref-edit-inputMode')).toBeInTheDocument();
    // 다른 탭의 입력은 보이지 않는다.
    expect(screen.queryByTestId('pref-color-title')).toBeNull();
  });

  it('편집 입력 초기값은 저장값(loadEditorPrefs().edit)이다', () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      edit: {
        columnLimit: true,
        dragDrop: true,
        noCommonAbbr: true,
        companyCode: 'auto',
        language: 'ja',
        lineSpacing: 1.5,
        inputMode: 'ksc5601',
      },
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-edit'));

    expect(screen.getByTestId('pref-edit-columnLimit')).toBeChecked();
    expect(screen.getByTestId('pref-edit-dragDrop')).toBeChecked();
    expect(screen.getByTestId('pref-edit-noCommonAbbr')).toBeChecked();
    expect(screen.getByTestId('pref-edit-companyCode')).toHaveValue('auto');
    expect(screen.getByTestId('pref-edit-language')).toHaveValue('ja');
    expect(screen.getByTestId('pref-edit-lineSpacing')).toHaveValue('1.5');
    expect(screen.getByTestId('pref-edit-inputMode')).toHaveValue('ksc5601');
  });

  it("컬럼제한 체크 + 언어 ja + 줄간격 1.5 후 '적용'하면 editorPrefs.edit에 영속된다(줄간격은 숫자)", () => {
    const onClose = vi.fn();
    render(<EditorPrefsDialog open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('prefs-tab-edit'));

    fireEvent.click(screen.getByTestId('pref-edit-columnLimit'));
    fireEvent.change(screen.getByTestId('pref-edit-language'), { target: { value: 'ja' } });
    fireEvent.change(screen.getByTestId('pref-edit-lineSpacing'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const { edit } = loadEditorPrefs();
    expect(edit.columnLimit).toBe(true);
    expect(edit.language).toBe('ja');
    expect(edit.lineSpacing).toBe(1.5); // 문자열이 아닌 숫자
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('적용은 편집만 바꿔도 색·자동저장·바이라인·날짜형식을 보존한다(상호 보존)', () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      colors: { ...DEFAULT_EDITOR_PREFS.colors, subtitle: '#00ff00' },
      autosave: { enabled: true, intervalSec: 120, retentionDays: 3 },
      byline: {
        email: true, emailValue: 'keep@me.com', blog: false, blogValue: '',
      },
      dateFormat: 'YYYY.MM.DD',
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-edit'));
    fireEvent.click(screen.getByTestId('pref-edit-dragDrop'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const prefs = loadEditorPrefs();
    // 편집 반영
    expect(prefs.edit.dragDrop).toBe(true);
    // 나머지 보존
    expect(prefs.colors.subtitle).toBe('#00ff00');
    expect(prefs.autosave.enabled).toBe(true);
    expect(prefs.autosave.intervalSec).toBe(120);
    expect(prefs.byline.email).toBe(true);
    expect(prefs.byline.emailValue).toBe('keep@me.com');
    expect(prefs.dateFormat).toBe('YYYY.MM.DD');
  });

  it('색상만 바꿔 적용해도 편집은 보존된다(반대 방향 상호 보존)', () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      edit: {
        columnLimit: true,
        dragDrop: true,
        noCommonAbbr: true,
        companyCode: 'auto',
        language: 'en',
        lineSpacing: 2.0,
        inputMode: 'ksc5601',
      },
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pref-color-subtitle'), { target: { value: '#123456' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const prefs = loadEditorPrefs();
    expect(prefs.colors.subtitle).toBe('#123456');
    expect(prefs.edit.columnLimit).toBe(true);
    expect(prefs.edit.language).toBe('en');
    expect(prefs.edit.lineSpacing).toBe(2.0);
    expect(prefs.edit.inputMode).toBe('ksc5601');
  });

  it('재오픈하면 편집 폼이 저장값으로 초기화된다', () => {
    const { rerender } = render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-edit'));
    fireEvent.change(screen.getByTestId('pref-edit-language'), { target: { value: 'zh' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    // 닫았다가 다시 연다.
    rerender(<EditorPrefsDialog open={false} onClose={vi.fn()} />);
    rerender(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-edit'));
    expect(screen.getByTestId('pref-edit-language')).toHaveValue('zh');
  });

  it("'기본값'은 편집 폼을 DEFAULT_EDITOR_PREFS.edit로 되돌린다", () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      edit: {
        columnLimit: true,
        dragDrop: true,
        noCommonAbbr: true,
        companyCode: 'auto',
        language: 'ru',
        lineSpacing: 2.0,
        inputMode: 'ksc5601',
      },
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-edit'));
    expect(screen.getByTestId('pref-edit-columnLimit')).toBeChecked();

    fireEvent.click(screen.getByTestId('prefs-reset'));
    const d = DEFAULT_EDITOR_PREFS.edit;
    expect(screen.getByTestId('pref-edit-columnLimit')).not.toBeChecked();
    expect(screen.getByTestId('pref-edit-dragDrop')).not.toBeChecked();
    expect(screen.getByTestId('pref-edit-noCommonAbbr')).not.toBeChecked();
    expect(screen.getByTestId('pref-edit-companyCode')).toHaveValue(d.companyCode);
    expect(screen.getByTestId('pref-edit-language')).toHaveValue(d.language);
    expect(screen.getByTestId('pref-edit-lineSpacing')).toHaveValue(String(d.lineSpacing));
    expect(screen.getByTestId('pref-edit-inputMode')).toHaveValue(d.inputMode);
  });

  // --- 보강(harness-tester): 명세 경계 + apply 경로 락다운 ---

  it('언어 select에 news.md L190 9종이 모두 옵션으로 있다', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-edit'));
    const langOptions = screen.getByTestId('pref-edit-language').querySelectorAll('option');
    expect(langOptions).toHaveLength(9);
    const values = Array.from(langOptions).map((o) => o.value);
    // news.md L190: 한글/영어/일어/중국어/스페인/프랑스/아랍어/베트남/러시아어.
    expect(values).toEqual(['ko', 'en', 'ja', 'zh', 'es', 'fr', 'ar', 'vi', 'ru']);
  });

  it('기업코드는 수동/자동, 입력모드는 KSC-5601/Unicode 두 옵션만 있다(명세 경계)', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-edit'));
    const company = Array.from(
      screen.getByTestId('pref-edit-companyCode').querySelectorAll('option'),
    ).map((o) => o.value);
    expect(company).toEqual(['manual', 'auto']);
    const inputMode = Array.from(
      screen.getByTestId('pref-edit-inputMode').querySelectorAll('option'),
    ).map((o) => o.value);
    expect(inputMode).toEqual(['ksc5601', 'unicode']);
  });

  it('기업코드 자동 + 입력모드 KSC-5601을 적용하면 그대로 영속된다(apply 경로)', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-edit'));
    fireEvent.change(screen.getByTestId('pref-edit-companyCode'), { target: { value: 'auto' } });
    fireEvent.change(screen.getByTestId('pref-edit-inputMode'), { target: { value: 'ksc5601' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const { edit } = loadEditorPrefs();
    expect(edit.companyCode).toBe('auto');
    expect(edit.inputMode).toBe('ksc5601');
  });

  it('줄간격을 안 건드리고 적용해도 기본 1.0이 숫자 1로 영속된다(문자열/누락 방지)', () => {
    // edit 폼을 전혀 손대지 않고 적용 → 기본 lineSpacing(1.0)이 Number()로 저장돼 number 1이어야 한다.
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-edit'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const { edit } = loadEditorPrefs();
    expect(edit.lineSpacing).toBe(1);
    expect(typeof edit.lineSpacing).toBe('number');
  });

  it('편집만 적용해도 미합성 카테고리(spellcheck/glyph)가 보존된다(loadEditorPrefs base spread)', () => {
    // step0이 추가한 신규 카테고리 spellcheck/glyph 저장값이 편집 적용으로 사라지지 않는지(상호 보존 못박음).
    saveEditorPrefs({
      ...loadEditorPrefs(),
      spellcheck: {
        checkOption: 'circular',
        errorTypes: {
          misuse: true, multiWord: false, semantic: false, circular: false, statSpacing: false, others: false,
        },
        errorStyle: 'underline',
      },
      glyphFavorites: { items: ['℃', '㎡'] },
      glyphKeymap: { items: [{ keys: 'ctrl+1', glyph: '①' }] },
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-edit'));
    fireEvent.click(screen.getByTestId('pref-edit-columnLimit'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const prefs = loadEditorPrefs();
    expect(prefs.edit.columnLimit).toBe(true); // 편집 반영
    // 미합성 신규 카테고리 보존
    expect(prefs.spellcheck.checkOption).toBe('circular');
    expect(prefs.spellcheck.errorStyle).toBe('underline');
    expect(prefs.spellcheck.errorTypes.misuse).toBe(true);
    expect(prefs.glyphFavorites.items).toEqual(['℃', '㎡']);
    expect(prefs.glyphKeymap.items).toEqual([{ keys: 'ctrl+1', glyph: '①' }]);
  });
});

// 맞춤법 탭 — phase 16 step 2. 기존 색상/자동저장/바이라인/날짜형식/편집 탭을 깨지 않고 맞춤법 탭만 추가했는지 확인한다.
// 맞춤법 = { checkOption(enum), errorTypes(6키 bool), errorStyle(enum) } — localStorage(editorPrefs) 전용(저장만, 검사 effect 없음).
describe('EditorPrefsDialog — 맞춤법 탭', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { resetEditorColors(); setDateFormat(DEFAULT_DATE_FORMAT); });

  const ERROR_TYPE_KEYS = ['misuse', 'multiWord', 'semantic', 'circular', 'statSpacing', 'others'];

  it('맞춤법 탭으로 전환하면 검사옵션·오류유형 6개·오류표현을 보여주고 다른 탭 입력은 사라진다', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId('prefs-tab-spellcheck')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('prefs-tab-spellcheck'));
    expect(screen.getByTestId('pref-spellcheck-checkOption')).toBeInTheDocument();
    ERROR_TYPE_KEYS.forEach((key) => {
      expect(screen.getByTestId(`pref-spellcheck-errorType-${key}`)).toBeInTheDocument();
    });
    expect(screen.getByTestId('pref-spellcheck-errorStyle')).toBeInTheDocument();
    // 다른 탭의 입력은 보이지 않는다.
    expect(screen.queryByTestId('pref-color-title')).toBeNull();
  });

  it('검사옵션 select에 명세 5종, 오류표현 select에 명세 2종이 옵션으로 있다(명세 경계)', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-spellcheck'));
    const checkOptions = Array.from(
      screen.getByTestId('pref-spellcheck-checkOption').querySelectorAll('option'),
    ).map((o) => o.value);
    // news.md L211: 절차오류/띄어쓰기/붙여쓰기/띄어쓰기+붙여쓰기/순환용어·외래어.
    expect(checkOptions).toEqual(['procedure', 'spacing', 'joining', 'spacingJoining', 'circularLoan']);
    const styleOptions = Array.from(
      screen.getByTestId('pref-spellcheck-errorStyle').querySelectorAll('option'),
    ).map((o) => o.value);
    // news.md L213: 굵게/밑줄.
    expect(styleOptions).toEqual(['bold', 'underline']);
  });

  it('맞춤법 입력 초기값은 저장값(loadEditorPrefs().spellcheck)이다', () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      spellcheck: {
        checkOption: 'joining',
        errorTypes: {
          misuse: true, multiWord: false, semantic: true, circular: false, statSpacing: false, others: true,
        },
        errorStyle: 'underline',
      },
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-spellcheck'));

    expect(screen.getByTestId('pref-spellcheck-checkOption')).toHaveValue('joining');
    expect(screen.getByTestId('pref-spellcheck-errorType-misuse')).toBeChecked();
    expect(screen.getByTestId('pref-spellcheck-errorType-multiWord')).not.toBeChecked();
    expect(screen.getByTestId('pref-spellcheck-errorType-semantic')).toBeChecked();
    expect(screen.getByTestId('pref-spellcheck-errorType-others')).toBeChecked();
    expect(screen.getByTestId('pref-spellcheck-errorStyle')).toHaveValue('underline');
  });

  it("검사옵션 joining + 오류유형 misuse·semantic + 오류표현 underline 후 '적용'하면 영속된다", () => {
    const onClose = vi.fn();
    render(<EditorPrefsDialog open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('prefs-tab-spellcheck'));

    fireEvent.change(screen.getByTestId('pref-spellcheck-checkOption'), { target: { value: 'joining' } });
    fireEvent.click(screen.getByTestId('pref-spellcheck-errorType-misuse'));
    fireEvent.click(screen.getByTestId('pref-spellcheck-errorType-semantic'));
    fireEvent.change(screen.getByTestId('pref-spellcheck-errorStyle'), { target: { value: 'underline' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const { spellcheck } = loadEditorPrefs();
    expect(spellcheck.checkOption).toBe('joining');
    expect(spellcheck.errorTypes.misuse).toBe(true);
    expect(spellcheck.errorTypes.semantic).toBe(true);
    expect(spellcheck.errorStyle).toBe('underline');
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('오류유형 두 개만 체크해도 저장된 errorTypes에 나머지 4키가 false로 남는다(통째 저장)', () => {
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-spellcheck'));
    fireEvent.click(screen.getByTestId('pref-spellcheck-errorType-misuse'));
    fireEvent.click(screen.getByTestId('pref-spellcheck-errorType-semantic'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const { errorTypes } = loadEditorPrefs().spellcheck;
    expect(errorTypes).toEqual({
      misuse: true, multiWord: false, semantic: true, circular: false, statSpacing: false, others: false,
    });
  });

  it('적용은 맞춤법만 바꿔도 색·자동저장·바이라인·편집·날짜형식을 보존한다(상호 보존)', () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      colors: { ...DEFAULT_EDITOR_PREFS.colors, subtitle: '#00ff00' },
      autosave: { enabled: true, intervalSec: 120, retentionDays: 3 },
      byline: {
        email: true, emailValue: 'keep@me.com', blog: false, blogValue: '',
      },
      edit: {
        ...DEFAULT_EDITOR_PREFS.edit, columnLimit: true, language: 'ja', lineSpacing: 1.5,
      },
      dateFormat: 'YYYY.MM.DD',
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-spellcheck'));
    fireEvent.click(screen.getByTestId('pref-spellcheck-errorType-circular'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const prefs = loadEditorPrefs();
    // 맞춤법 반영
    expect(prefs.spellcheck.errorTypes.circular).toBe(true);
    // 나머지 보존
    expect(prefs.colors.subtitle).toBe('#00ff00');
    expect(prefs.autosave.enabled).toBe(true);
    expect(prefs.autosave.intervalSec).toBe(120);
    expect(prefs.byline.email).toBe(true);
    expect(prefs.byline.emailValue).toBe('keep@me.com');
    expect(prefs.edit.columnLimit).toBe(true);
    expect(prefs.edit.language).toBe('ja');
    expect(prefs.edit.lineSpacing).toBe(1.5);
    expect(prefs.dateFormat).toBe('YYYY.MM.DD');
  });

  it('색상만 바꿔 적용해도 맞춤법은 보존된다(반대 방향 상호 보존)', () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      spellcheck: {
        checkOption: 'circularLoan',
        errorTypes: {
          misuse: true, multiWord: true, semantic: false, circular: false, statSpacing: false, others: false,
        },
        errorStyle: 'underline',
      },
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pref-color-subtitle'), { target: { value: '#123456' } });
    fireEvent.click(screen.getByTestId('prefs-apply'));

    const prefs = loadEditorPrefs();
    expect(prefs.colors.subtitle).toBe('#123456');
    expect(prefs.spellcheck.checkOption).toBe('circularLoan');
    expect(prefs.spellcheck.errorTypes.misuse).toBe(true);
    expect(prefs.spellcheck.errorTypes.multiWord).toBe(true);
    expect(prefs.spellcheck.errorStyle).toBe('underline');
  });

  it('재오픈하면 맞춤법 폼이 저장값으로 초기화된다', () => {
    const { rerender } = render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-spellcheck'));
    fireEvent.change(screen.getByTestId('pref-spellcheck-checkOption'), { target: { value: 'procedure' } });
    fireEvent.click(screen.getByTestId('pref-spellcheck-errorType-others'));
    fireEvent.click(screen.getByTestId('prefs-apply'));

    // 닫았다가 다시 연다.
    rerender(<EditorPrefsDialog open={false} onClose={vi.fn()} />);
    rerender(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-spellcheck'));
    expect(screen.getByTestId('pref-spellcheck-checkOption')).toHaveValue('procedure');
    expect(screen.getByTestId('pref-spellcheck-errorType-others')).toBeChecked();
  });

  it("'기본값'은 맞춤법 폼을 DEFAULT_EDITOR_PREFS.spellcheck로 되돌린다", () => {
    saveEditorPrefs({
      ...loadEditorPrefs(),
      spellcheck: {
        checkOption: 'procedure',
        errorTypes: {
          misuse: true, multiWord: true, semantic: true, circular: true, statSpacing: true, others: true,
        },
        errorStyle: 'underline',
      },
    });
    render(<EditorPrefsDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('prefs-tab-spellcheck'));
    expect(screen.getByTestId('pref-spellcheck-errorType-misuse')).toBeChecked();

    fireEvent.click(screen.getByTestId('prefs-reset'));
    const d = DEFAULT_EDITOR_PREFS.spellcheck;
    expect(screen.getByTestId('pref-spellcheck-checkOption')).toHaveValue(d.checkOption);
    ERROR_TYPE_KEYS.forEach((key) => {
      expect(screen.getByTestId(`pref-spellcheck-errorType-${key}`)).not.toBeChecked();
    });
    expect(screen.getByTestId('pref-spellcheck-errorStyle')).toHaveValue(d.errorStyle);
  });
});
