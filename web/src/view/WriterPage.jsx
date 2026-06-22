// 기사 작성페이지(writer.do) — 좌 에디터 : 우 메타데이터 = 60:40.
// 메타 4탭(공통정보/이미지/영상/글기사), 탭 위 송고/보류/KILL 버튼(권한·상태·진입별 표시 규칙).
// 가드: 송고는 "(끝)" 필요, 송고/보류는 제목(첫 줄) 필요. 각 액션은 확인창 후에만 진행.
// 데이터는 useWriteController/useSearchController 경유(transport 직접 호출 금지, ADR-003).

import { useState, useRef, useEffect, useMemo } from 'react';
import { useAppContext } from '../app/context.js';
import { useWriteController } from '../controller/useWriteController.js';
import { useSearchController } from '../controller/useSearchController.js';
import { Editor, readCaret } from './Editor.jsx';
import { StatusBar } from './StatusBar.jsx';
import { EditorMenuBar } from './EditorMenuBar.jsx';
import { EditorToolBar } from './EditorToolBar.jsx';
import { EditorPrefsDialog } from './EditorPrefsDialog.jsx';
import { FindReplaceDialog } from './FindReplaceDialog.jsx';
import { EditorContextMenu } from './EditorContextMenu.jsx';
import {
  isFindReplace, findMatches, nextMatchIndex, replaceOne, replaceAll,
} from './editorFind.js';
import { selectAllInEditor } from './editorSelect.js';
import { loadEditorPrefs } from './editorPrefs.js';
import { saveDraft, loadDraft, clearDraft, expireDrafts } from './editorDraft.js';
import { setEditorColors } from './editorColoring.js';
import { submitButtons, SUBMIT_LABELS } from './writerButtons.js';
import { deserialize, serialize, hasEndMarker, blocksToText } from './editorContent.js';
import {
  insertEndMarker, isInsertEndMarker, isDeleteLine, deleteLineAt,
  isInsertContinueMarker, insertContinueMarker, transformTextLine,
  toUpper, toLower, capitalizeFirst, toggleCase,
} from './editorShortcuts.js';
import { lineAtOffset } from './editorCaret.js';
import { makeImageEmbed, makeVideoEmbed, makeArticleEmbed } from './clipboardEmbed.js';
import {
  bodyTitle, appendEmbedToBody, insertEmbedAfterLine, serializeBodyFromBlocks, textLineToBlockIndex,
} from './writerBody.js';

const META_TABS = [
  { key: 'common', label: '공통정보' },
  { key: 'image', label: '이미지' },
  { key: 'video', label: '영상' },
  { key: 'article', label: '글기사' },
];

// 매핑 — 편집 진입 시 읽기전용으로 보여주는 메타 필드(news.md 기사 편집 기능).
const READONLY_LABELS = [
  ['articleId', '기사아이디'],
  ['modifier', '수정자'],
  ['sender', '송고자'],
  ['department', '부서'],
  ['departmentCode', '부서코드'],
  ['createdAt', '작성시간'],
  ['editedAt', '편집시간'],
  ['sentAt', '송고시간'],
];

const ACTION_VERB = { send: '송고', hold: '보류', kill: 'KILL' };

// 결선된 에디터 메뉴 항목(EditorMenuBar enabledIds) — 나머지는 비활성(미구현 액션).
const MENU_ENABLED = ['file.recover', 'edit.findReplace', 'edit.selectAll', 'edit.insertEnd', 'edit.insertContinue', 'view.toUpper', 'view.toLower', 'view.capitalize', 'view.toggleCase', 'help.preferences'];
// 보기 메뉴 대소문자 변환 id → 문자열 변환 함수(transformTextLine에 적용).
const VIEW_TRANSFORMS = {
  'view.toUpper': toUpper,
  'view.toLower': toLower,
  'view.capitalize': capitalizeFirst,
  'view.toggleCase': toggleCase,
};

export function WriterPage() {
  const { identity, model } = useAppContext();
  const {
    tabs, activeTabId, activeTab,
    addTab, closeTab, selectTab,
    updateField, submit, saveMapping,
  } = useWriteController();
  const search = useSearchController();

  const [metaTab, setMetaTab] = useState('common');
  const [spell, setSpell] = useState(false);

  // 에디터 크롬(메뉴바·툴바·상태표시줄) — Step 3 배치.
  // statusCaret: 상태표시줄 '행/열' 표시용 마지막 캐럿({lineIndex, offset}). 캐럿 이동마다 갱신(가산적 결선).
  // showMenuBar/showToolBar: 메뉴바/툴바 보이기 토글(레이아웃 토글 — placeholder 아님).
  const [statusCaret, setStatusCaret] = useState(null);
  const [showMenuBar, setShowMenuBar] = useState(true);
  const [showToolBar, setShowToolBar] = useState(true);
  // 약물바 보이기(우클릭 컨텍스트 메뉴) — placeholder 토글 상태만 보존한다.
  // 약물바(glyph bar) 컴포넌트는 이번 범위 밖(news.md 경계)이라 실제 바는 렌더하지 않는다(토글만 동작).
  const [showGlyphBar, setShowGlyphBar] = useState(false);
  // 에디터 본문 우클릭 컨텍스트 메뉴 위치({x,y}) 또는 null(닫힘). ListPage 우클릭 패턴(좌표 상태 + 바깥/Esc 닫기).
  const [ctxMenu, setCtxMenu] = useState(null);

  // 색상 환경설정(도움말>환경설정) — 모달 표시 + 에디터 바탕색(editorBg). 저장값은 localStorage(editorPrefs)에 영속.
  const [showPrefs, setShowPrefs] = useState(false);
  const [editorBg, setEditorBg] = useState(() => loadEditorPrefs().colors.background);

  // 자동저장 설정(환경설정>자동저장: enabled/intervalSec/retentionDays) — 타이머 effect의 단일 의존성.
  // 모달 적용(onPrefsClose(true)) 시 저장값으로 갱신한다(취소 시 불필요 — editorBg와 동일 게이트).
  const [autosaveCfg, setAutosaveCfg] = useState(() => loadEditorPrefs().autosave);

  // 마운트 시 저장된 색을 적용한다(새로고침 후에도 반영). 텍스트색은 setEditorColors, 바탕색은 editorBg로.
  useEffect(() => {
    const c = loadEditorPrefs().colors;
    setEditorColors({ title: c.title, subtitle: c.subtitle, body: c.body });
    setEditorBg(c.background);
  }, []);

  // 모달 닫힘 — applied=true(적용)면 바탕색을 저장값으로 갱신(모달이 이미 setEditorColors 호출 → 자연 재렌더로 텍스트색 반영).
  // applied가 아니면(취소) 색/배경 갱신 없이 닫기만 한다.
  const onPrefsClose = (applied) => {
    if (applied) {
      setEditorBg(loadEditorPrefs().colors.background);
      setAutosaveCfg(loadEditorPrefs().autosave); // 자동저장 간격/사용여부 변경을 타이머에 반영(재설정).
    }
    setShowPrefs(false);
  };

  // 매핑(mapping) — 임베드 전용 제한 편집. 본문 텍스트 비편집·공통정보 readOnly이되 임베드 추가/삭제는 허용(step11).
  const isMapping = activeTab.mode === 'mapping';

  const body = activeTab.fields.body;
  const blocks = deserialize(body);

  // 마지막 에디터 캐럿(텍스트-줄) — 검색패널 클릭 시 에디터 포커스가 빠져 라이브 readCaret이 null이므로 여기 보관(Editor onCaretChange).
  const lastCaretRef = useRef(null);
  // 임베드 삽입 후 커서를 옮길 빈 줄(텍스트-줄 인덱스). Editor가 소비(focus)하면 비워, 같은 줄 연속 삽입도 매번 커서를 옮긴다.
  const [pendingCaretLine, setPendingCaretLine] = useState(null);
  useEffect(() => {
    if (pendingCaretLine !== null) setPendingCaretLine(null);
  }, [pendingCaretLine]);

  // 찾기/바꾸기(Ctrl+F·편집 메뉴) — 다이얼로그 표시 + 찾기 컨트롤 상태(Step 2 결선).
  // 매치는 effect/타이머 없이 렌더 중 파생 계산한다(본문 텍스트 기준 — blocksToText). 본문 변경은 안전 경로(updateField+serialize)로만.
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findCase, setFindCase] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const bodyText = blocksToText(blocks);
  // 현재 query의 매치(파생) — body/query/대소문자 변경 시에만 재계산.
  const matches = useMemo(
    () => findMatches(bodyText, findQuery, { caseSensitive: findCase }),
    [bodyText, findQuery, findCase],
  );
  // query/대소문자 즉시 매치 수를 구하는 헬퍼(onQueryChange에서 activeIndex 초기화 판단용 — state 반영 전 동기 계산).
  const matchesFor = (q, caseSensitive) => findMatches(bodyText, q, { caseSensitive });

  // 활성 탭 미러 ref — 자동저장 타이머가 매 타이핑마다 재설정되지 않도록 활성 탭을 ref로 읽되, 항상 최신값을
  // 보게 동기화한다(lastCaretRef와 동일 미러링 패턴). 이게 없으면 타이머 클로저가 초기 activeTab에 stale된다.
  const activeTabRef = useRef(activeTab);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // 자동저장 타이머 — 설정이 켜져 있으면 간격마다 활성 탭 내용을 초안(localStorage)으로 스냅샷하고 만료분을 정리한다.
  // 서버 저장이 아니다(localStorage 초안만). 의존성은 [autosaveCfg]만 — 활성 탭은 ref로 읽어 타이핑마다 재설정하지 않는다.
  useEffect(() => {
    if (!autosaveCfg.enabled) return undefined; // 꺼져 있으면 타이머 없음
    const ms = autosaveCfg.intervalSec * 1000;
    const id = setInterval(() => {
      const tab = activeTabRef.current; // 최신 활성 탭(미러 ref)
      const key = tab.articleId || tab.id; // 기존=articleId(안정), 신규=tab.id(best-effort)
      const hasContent = !!(tab.fields.body || tab.fields.title);
      if (!hasContent) return; // 빈 탭은 스냅샷 안 함
      saveDraft(key, { ...tab.fields }, Date.now()); // 시각은 런타임에서 주입(저장소는 시계를 모름).
      expireDrafts(autosaveCfg.retentionDays, Date.now());
    }, ms);
    return () => clearInterval(id); // 설정 변경/unmount 시 타이머 정리(누수 없음).
  }, [autosaveCfg]);

  // 본문 타이핑 → 에디터가 읽은 블록(텍스트 + 임베드, 커서 위치 보존)을 직렬화 + 제목(첫 줄) 동기화.
  // 임베드는 "(끝)"만 최종 블록으로 보낼 뿐 위치를 옮기지 않는다(news.md 156·167행 — 커서 위치/블록 순서 보존).
  const onTextChange = (text, editedBlocks) => {
    const next = serializeBodyFromBlocks(editedBlocks);
    updateField('body', next);
    updateField('title', (String(text ?? '').split('\n')[0] ?? '').trim());
  };

  // (끝)삽입 — 키보드 Alt+Y와 메뉴 'edit.insertEnd'의 공용 핸들러(단일 소스). "(끝)" 최종 블록 삽입 + 맞춤법 on(중복이면 무삽입).
  const insertEnd = () => {
    const r = insertEndMarker(blocks);
    updateField('body', serialize(r.blocks));
    setSpell(true); // Editor가 spellcheck 상태 변화로 재렌더되어 색칠(메뉴 경로에서도 동일 부수효과).
  };

  // (계속)삽입 — 키보드 Ctrl+Y와 메뉴 'edit.insertContinue'의 공용 핸들러. 마지막 캐럿 텍스트-줄 다음에 "(계속)" 삽입.
  const insertContinue = () => {
    const caretLine = lastCaretRef.current ? lastCaretRef.current.lineIndex : null;
    const r = insertContinueMarker(blocks, caretLine);
    updateField('body', serialize(r.blocks));
    if (typeof r.caretTextLine === 'number') setPendingCaretLine(r.caretTextLine);
  };

  // 매치 start 오프셋이 속한 텍스트-줄로 캐럿을 옮긴다(임베드/마커 삽입과 동일한 pendingCaretLine 포커스 경로).
  // 줄 안 정확 컬럼 선택은 이번 범위 밖(focusLineStart — 줄 시작 캐럿).
  const focusMatchLine = (offset) => {
    const { lineIndex } = lineAtOffset(bodyText, offset);
    setPendingCaretLine(lineIndex);
  };

  // 다음/이전 찾기 — 현재 활성 매치 끝(없으면 마지막 캐럿 offset, 없으면 0) 기준으로 순환 인덱스를 구해 그 줄로 이동.
  const findStep = (forward) => {
    if (!findQuery || matches.length === 0) return; // 빈 query/매치 없음 no-op
    const cur = activeIndex >= 0 && activeIndex < matches.length ? matches[activeIndex] : null;
    const fromOffset = cur ? cur.end : (lastCaretRef.current ? lastCaretRef.current.offset : 0);
    const idx = nextMatchIndex(matches, fromOffset, { forward });
    if (idx < 0) return;
    setActiveIndex(idx);
    focusMatchLine(matches[idx].start);
  };

  // 바꾸기(replaceOne) — 첫(또는 활성 이후) 매치 하나만 치환. 매핑/빈 query는 no-op(본문-only 불변식).
  const onReplaceOne = (replacement) => {
    if (isMapping || !findQuery) return;
    const cur = activeIndex >= 0 && activeIndex < matches.length ? matches[activeIndex] : null;
    const fromOffset = cur ? cur.start : (lastCaretRef.current ? lastCaretRef.current.offset : 0);
    const r = replaceOne(blocks, findQuery, replacement, { caseSensitive: findCase, fromOffset });
    if (!r.replaced) return; // 매치 없음 no-op
    updateField('body', serialize(r.blocks));
    if (typeof r.caretOffset === 'number') focusMatchLine(r.caretOffset);
    setActiveIndex(-1); // 텍스트가 바뀌어 기존 매치 인덱스 무효 → 리셋(다음 찾기는 캐럿/0부터).
  };

  // 모두 바꾸기(replaceAll) — 모든 매치 치환. 다이얼로그는 열린 채 유지(현황 갱신). 매핑/빈 query no-op.
  const onReplaceAll = (replacement) => {
    if (isMapping || !findQuery) return;
    const r = replaceAll(blocks, findQuery, replacement, { caseSensitive: findCase });
    if (r.count <= 0) return; // 매치 없음 no-op
    updateField('body', serialize(r.blocks));
    setActiveIndex(-1); // 텍스트가 바뀌어 기존 매치 무효.
  };

  // 에디터 메뉴(EditorMenuBar) 선택 — 결선된 항목만 동작한다.
  // 매핑 모드(텍스트 잠금)에서는 본문을 바꾸지 않는다(본문-only 불변식).
  const onMenuSelect = (id) => {
    // 색 설정은 본문 잠금과 무관 — 매핑 가드 이전에 처리(매핑 모드에서도 열려야 함, 죽은 버튼 방지).
    if (id === 'help.preferences') { setShowPrefs(true); return; }
    if (isMapping) return;
    // 파일>복구 — 활성 탭의 최신 초안(localStorage)을 되살린다(loadDraft → updateField). 본문을 바꾸므로 매핑 가드 뒤.
    if (id === 'file.recover') {
      const tab = activeTab;
      const key = tab.articleId || tab.id;
      const draft = loadDraft(key);
      if (!draft) { window.alert('복구할 자동저장 내용이 없습니다.'); return; }
      if (!window.confirm('자동저장된 내용으로 복구하시겠습니까?')) return;
      Object.entries(draft).forEach(([k, v]) => updateField(k, v)); // updateField가 EDITABLE_FIELDS만 통과(메타 무시)
      clearDraft(key); // 복구 후 초안 제거 — 재복구로 부활 방지.
      return;
    }
    // 찾기/바꾸기 — 매핑 가드 뒤(매핑에서는 본문 변경 가능 → 다이얼로그를 열지 않는다, step2.md 22행).
    if (id === 'edit.findReplace') { setShowFind(true); return; }
    // 전체 선택 — 선택 연산(본문 무변경). 메뉴 클릭은 에디터 포커스가 빠져 있어 명시 selectAll 한다.
    // (Ctrl+A 키는 contentEditable 위에서 브라우저 기본이 전체를 선택하므로 onKeyDown에서 가로채지 않는다.)
    if (id === 'edit.selectAll') { selectAllInEditor(document.querySelector('.yh-editor')); return; }
    if (id === 'edit.insertEnd') { insertEnd(); return; }
    if (id === 'edit.insertContinue') { insertContinue(); return; }
    const fn = VIEW_TRANSFORMS[id];
    if (!fn) return;
    // 대소문자 변환은 마지막 캐럿 텍스트-줄에만 적용한다. 캐럿이 없으면 no-op.
    const caretLine = lastCaretRef.current ? lastCaretRef.current.lineIndex : null;
    if (caretLine == null) return;
    const r = transformTextLine(blocks, caretLine, fn);
    updateField('body', serialize(r.blocks));
    setPendingCaretLine(caretLine); // 같은 줄 유지(메뉴 클릭으로 빠진 포커스를 그 줄로 되돌림).
  };

  // 우클릭 컨텍스트 메뉴(EditorContextMenu) 활성 항목(ctx.*) — EditorMenuBar enabledIds 패턴.
  //  - 항상 활성: 찾기/바꾸기·전체 선택·보이기 토글(메뉴바/툴바/약물바). 선택 연산·레이아웃 토글이라 본문-only 불변식과 무관.
  //  - 표준 편집(잘라내기/복사/붙여넣기): 비매핑(텍스트 편집 가능)일 때만 활성. 매핑(텍스트 잠금)에서는 복사도 일관되게 비활성으로
  //    단순화한다(본문 변경 항목과 같은 가드 — 잘라내기/붙여넣기는 텍스트를 바꾸므로 반드시 비활성).
  //  - aux-tools 의존(기업코드변환/원본·텍스트 붙여넣기/약물입력): 항상 비활성 placeholder(미구현).
  const ctxEnabledIds = [
    'ctx.findReplace', 'ctx.selectAll', 'ctx.showMenuBar', 'ctx.showToolBar', 'ctx.showGlyphBar',
    ...(isMapping ? [] : ['ctx.cut', 'ctx.copy', 'ctx.paste']),
  ];
  // 보이기 토글의 현재 on 상태(체크 표식용).
  const ctxCheckedIds = [
    ...(showMenuBar ? ['ctx.showMenuBar'] : []),
    ...(showToolBar ? ['ctx.showToolBar'] : []),
    ...(showGlyphBar ? ['ctx.showGlyphBar'] : []),
  ];

  // 우클릭 컨텍스트 메뉴 선택(ctx.*) 라우팅. 찾기/전체선택은 메뉴바와 동일 동작을 공유한다(중복 금지).
  const onCtxSelect = (id) => {
    switch (id) {
      // 찾기/바꾸기 — 매핑에선 본문 변경 가능이라 다이얼로그를 열지 않는다(Ctrl+F·편집 메뉴와 동일 가드).
      case 'ctx.findReplace': if (!isMapping) setShowFind(true); break;
      // 전체 선택 — Step 2 selectAllInEditor 재사용(선택 연산만, 본문/DOM 무변경).
      case 'ctx.selectAll': selectAllInEditor(document.querySelector('.yh-editor')); break;
      case 'ctx.showMenuBar': setShowMenuBar((v) => !v); break;
      case 'ctx.showToolBar': setShowToolBar((v) => !v); break;
      // 약물바 — placeholder 토글 상태만 바꾼다(실제 바 미렌더 — 범위 밖).
      case 'ctx.showGlyphBar': setShowGlyphBar((v) => !v); break;
      // 잘라내기/복사/붙여넣기 — 브라우저 기본 클립보드 동작에 위임(contentEditable 텍스트/블록을 코드로 직접 조작하지 않는다 —
      // (끝) 차단·이미지 임베드는 Editor.handlePaste가 이미 처리하므로 그 경로를 깨지 않기 위함). 메뉴 클릭으로 빠진 포커스를
      // 에디터로 되돌린 뒤 document.execCommand를 시도하되, 미지원 환경(jsdom)에서는 no-op으로 두고 메뉴만 닫는다(브라우저 단축키 정상).
      case 'ctx.cut':
      case 'ctx.copy':
      case 'ctx.paste': {
        const cmd = id === 'ctx.cut' ? 'cut' : id === 'ctx.copy' ? 'copy' : 'paste';
        const root = document.querySelector('.yh-editor');
        if (root && typeof root.focus === 'function') root.focus();
        try { if (typeof document.execCommand === 'function') document.execCommand(cmd); } catch { /* jsdom 미지원 — no-op */ }
        break;
      }
      // aux 항목(ctx.companyCode/pasteOriginal/pasteText/symbolInput)은 비활성이라 호출되지 않는다.
      default: break;
    }
  };

  // Alt+Y → "(끝)" 삽입(insertEnd). Ctrl+Y → "(계속)" 삽입(insertContinue, 브라우저 redo 가로채기).
  // Ctrl+D / 빈 줄 Backspace·Delete → 활성 라인(+동반 임베드 1개) 삭제. 문자 삭제(비어 있지 않은 줄)는 기본 동작 유지.
  const onKeyDown = (e) => {
    // Ctrl+F → 찾기/바꾸기 다이얼로그(브라우저 기본 찾기 가로채기). 매핑이어도 preventDefault는 하되 다이얼로그는 안 연다.
    // isFindReplace는 !altKey라 Alt+Y와 충돌하지 않는다(라인삭제 조기 return보다 위에 둔다).
    if (isFindReplace(e)) {
      e.preventDefault();
      if (!isMapping) setShowFind(true);
      return;
    }
    if (isInsertEndMarker(e)) {
      e.preventDefault();
      insertEnd();
      return;
    }
    if (isInsertContinueMarker(e)) {
      e.preventDefault(); // 브라우저 redo(Ctrl+Y) 가로채기.
      insertContinue();
      return;
    }
    const ctrlD = isDeleteLine(e);
    if (!ctrlD && e.key !== 'Backspace' && e.key !== 'Delete') return;
    // Ctrl+D는 삭제 가능 여부와 무관하게 브라우저 기본동작(북마크 추가)을 막는다.
    // (삭제할 라인이 없을 때 preventDefault를 빼먹으면 두 번째 Ctrl+D에서 북마크 창이 뜬다.)
    if (ctrlD) e.preventDefault();

    const text = blocksToText(blocks);
    const caret = readCaret(e.currentTarget);
    const textLineIndex = lineAtOffset(text, caret ? caret.offset : text.length).lineIndex;
    // Backspace/Delete는 빈 줄(라인 삭제)에만 개입한다 — 비어 있지 않은 줄의 문자 삭제는 막지 않는다.
    if (!ctrlD && (text.split('\n')[textLineIndex] ?? '') !== '') return;

    const blockIndex = textLineToBlockIndex(blocks, textLineIndex);
    if (blockIndex < 0) return;
    if (!ctrlD) e.preventDefault(); // Backspace/Delete는 실제 라인 삭제가 확정될 때만 기본동작을 막는다.
    updateField('body', serialize(deleteLineAt(blocks, blockIndex).blocks));
  };

  const onRemoveEmbed = (blockIndex) => {
    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const next = blocks.slice();
    next.splice(blockIndex, 1);
    updateField('body', serialize(next));
  };

  // 임베드를 커서 텍스트 줄 "다음"에 삽입하고, 그 뒤 빈 줄을 만들어 커서를 그 줄로 옮긴다(news.md 156행 — 커서 위치 임베딩).
  // 캐럿이 없거나(한 번도 포커스 안 함) 매핑 모드(텍스트 잠금)면 끝("(끝)" 앞)에만 추가한다(빈 줄/커서 이동 없음 — 매핑 본문 불변식).
  const insertEmbedAtLine = (embed, caretLine) => {
    if (!embed) return;
    if (isMapping || caretLine == null) {
      updateField('body', appendEmbedToBody(body, embed));
      return;
    }
    const r = insertEmbedAfterLine(body, embed, caretLine);
    updateField('body', r.body);
    if (typeof r.caretTextLine === 'number') setPendingCaretLine(r.caretTextLine);
  };

  // 검색패널(이미지/영상/글기사) 픽 — 마지막 에디터 캐럿 줄에 삽입(클릭으로 포커스가 빠지므로 lastCaretRef 사용, 라이브 readCaret 금지).
  const insertEmbed = (embed) => insertEmbedAtLine(embed, lastCaretRef.current ? lastCaretRef.current.lineIndex : null);

  // Ctrl+V 이미지 붙여넣기 — 동기로 확보한 캐럿 줄에 삽입(텍스트 직렬화 없이 — news.md 156행).
  const pasteEmbedAtCaret = (embed, caret) => insertEmbedAtLine(embed, caret ? caret.lineIndex : null);

  // 송고/보류/KILL — 가드 후 확인창, 확인 시에만 진행.
  const onAction = async (action) => {
    // 제목은 본문 첫 줄(bodyTitle) 또는 제목 FIELD 둘 중 하나라도 있으면 인정한다.
    // (둘 다 본문 첫 줄만 보던 버그로 제목 필드만 있을 때 송고/보류가 모두 잘못 차단됐다.)
    const title = bodyTitle(body) || (activeTab.fields.title || '').trim();
    if ((action === 'send' || action === 'hold') && !title) {
      window.alert(`제목이 없어 ${ACTION_VERB[action]}할 수 없습니다`);
      return;
    }
    if (action === 'send' && !hasEndMarker(blocks)) {
      window.alert('본문에 "(끝)" 표시가 없어 송고할 수 없습니다');
      return;
    }
    if (!window.confirm(`${ACTION_VERB[action]}하시겠습니까?`)) return;
    // 전이 직전 탭 키를 잡아둔다 — 성공 후 초안을 무효화(빈 새 기사 탭에서 복구 시 송고/제출 내용 부활 방지).
    const key = activeTab.articleId || activeTab.id;
    const r = await submit(action);
    if (r && r.ok) clearDraft(key);
  };

  // 매핑 '저장' — 송고 가드(제목/"(끝)")·전이(applyAction) 없이 추가된 임베드만 PUT 저장한다.
  const onSaveMapping = async () => {
    if (!window.confirm('저장하시겠습니까?')) return;
    const key = activeTab.articleId || activeTab.id; // 저장 직전 키 — 성공 후 초안 무효화.
    const r = await saveMapping();
    if (r && r.ok) clearDraft(key);
  };

  const buttons = submitButtons({
    mode: activeTab.mode,
    status: activeTab.status,
    role: identity && identity.role,
    articleId: activeTab.articleId,
  });

  return (
    <main className="yh-page">
      {/* 작성 탭 스트립 — ＋로 새 탭, ×로 닫기, 클릭으로 전환 */}
      <div className="yh-tabs yh-tabs--docs" data-testid="writer-tabs">
        {tabs.map((t) => (
          <span key={t.id} className={`yh-tab ${t.id === activeTabId ? 'yh-tab--active' : ''}`}>
            <button type="button" className="yh-tab__label" onClick={() => selectTab(t.id)}>
              {t.fields.title || t.articleId || '새 기사'}
            </button>
            <button type="button" className="yh-tab__close" aria-label="탭 닫기" onClick={() => closeTab(t.id)}>×</button>
          </span>
        ))}
        <button type="button" aria-label="새 작성 탭" className="yh-tab__add" onClick={() => addTab()}>＋</button>
      </div>

      <div className="yh-writer">
        {/* 좌측 60% — 에디터 크롬(메뉴바·툴바) → 에디터 → 상태표시줄 순으로 쌓는다. */}
        <section className="yh-writer__editor">
          {/* 메뉴바/툴바 보이기 토글 — 전용 버튼(항상 보임). 보이기 항목은 EditorMenuBar에 없어(우클릭 컨텍스트 메뉴 규정) 결선 대상이 아니다.
              (news.md L173은 우클릭 컨텍스트 메뉴 항목으로도 규정하나 ContextMenu 이동은 후속 phase로 연기 — 이번엔 전용 버튼만.) */}
          <div className="yh-editor-chrome-bar">
            <button
              type="button"
              className="yh-editor-chrome-bar__toggle"
              data-testid="toggle-menubar"
              aria-pressed={showMenuBar}
              onClick={() => setShowMenuBar((v) => !v)}
            >
              메뉴바
            </button>
            <button
              type="button"
              className="yh-editor-chrome-bar__toggle"
              data-testid="toggle-toolbar"
              aria-pressed={showToolBar}
              onClick={() => setShowToolBar((v) => !v)}
            >
              툴바
            </button>
          </div>
          {showMenuBar && <EditorMenuBar onSelect={onMenuSelect} enabledIds={MENU_ENABLED} />}
          {showToolBar && <EditorToolBar />}
          {/* 바탕색 전용 캔버스 래퍼 — Editor만 감싸 배경을 입힌다(메뉴바/툴바/상태바는 칠하지 않음).
              에디터 본문 우클릭 → 브라우저 기본 메뉴 대신 커스텀 컨텍스트 메뉴(EditorContextMenu)를 좌표에 띄운다(ListPage 패턴). */}
          <div
            className="yh-writer__canvas"
            data-testid="editor-canvas"
            style={{ backgroundColor: editorBg }}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
          >
            <Editor
              key={activeTabId}
              blocks={blocks}
              spellcheck={spell}
              textEditable={!isMapping}
              onKeyDown={isMapping ? undefined : onKeyDown}
              onTextChange={isMapping ? undefined : onTextChange}
              onRemoveEmbed={onRemoveEmbed}
              onPasteEmbed={pasteEmbedAtCaret}
              // 가산적 결선 — lastCaretRef(검색패널 임베드 삽입 위치)는 유지하고 상태표시줄용 statusCaret만 추가한다.
              onCaretChange={(c) => { lastCaretRef.current = c; setStatusCaret(c); }}
              pendingCaretLine={pendingCaretLine}
            />
          </div>
          {/* 상태표시줄 — 본문 텍스트(임베드 제외)·캐럿만 결선. overwrite/language는 기본값(placeholder) 유지. */}
          <StatusBar text={blocksToText(blocks)} caret={statusCaret} />
        </section>

        {/* 우측 40% — 메타데이터 */}
        <aside className="yh-writer__meta">
          {/* 4개 탭 위 송고/보류/KILL 버튼. 매핑은 전이 없음 → 저장 버튼만(임베드 변경을 PUT 저장). */}
          <div className="yh-actionbar" data-testid="action-bar">
            {isMapping ? (
              <button type="button" className="yh-btn yh-btn--primary" onClick={onSaveMapping}>
                저장
              </button>
            ) : (
              buttons.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`yh-btn ${key === 'send' ? 'yh-btn--primary' : key === 'kill' ? 'yh-btn--danger' : ''}`}
                  onClick={() => onAction(key)}
                >
                  {SUBMIT_LABELS[key]}
                </button>
              ))
            )}
          </div>

          <div className="yh-tabs">
            {META_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`yh-tab ${metaTab === t.key ? 'yh-tab--active' : ''}`}
                onClick={() => setMetaTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="yh-meta-panel">
            {metaTab === 'common' && (
              <CommonInfo tab={activeTab} updateField={updateField} model={model} readOnly={isMapping} />
            )}
            {metaTab === 'image' && (
              <SearchPanel
                kind="image"
                results={search.imageResults}
                onSearch={search.searchImages}
                onPick={(item) => insertEmbed(makeImageEmbed(item.src ?? item.link ?? item.url ?? '', { alt: item.title ?? '' }))}
              />
            )}
            {metaTab === 'video' && (
              <SearchPanel
                kind="video"
                results={search.videoResults}
                onSearch={search.searchVideos}
                onPick={(item) => insertEmbed(makeVideoEmbed(item.url ?? item.src ?? `https://www.youtube.com/watch?v=${item.videoId ?? (item.id && item.id.videoId) ?? ''}`, { title: item.title ?? '' }))}
              />
            )}
            {metaTab === 'article' && (
              <SearchPanel
                kind="article"
                results={search.articleResults}
                onSearch={search.searchArticles}
                onPick={(item) => insertEmbed(makeArticleEmbed(item))}
              />
            )}
          </div>
        </aside>
      </div>

      {/* 색상 환경설정 모달 — 도움말>환경설정으로 열림. 적용 시 onPrefsClose(true)로 배경 적용. */}
      <EditorPrefsDialog open={showPrefs} onClose={onPrefsClose} />

      {/* 찾기/바꾸기 다이얼로그 — Ctrl+F·편집 메뉴로 열림(매핑에서는 안 열림). 본문 변경은 안전 경로(updateField+serialize)로만. */}
      <FindReplaceDialog
        open={showFind}
        matchCount={matches.length}
        activeIndex={activeIndex}
        onQueryChange={(q, { caseSensitive }) => {
          setFindQuery(q);
          setFindCase(caseSensitive);
          setActiveIndex(matchesFor(q, caseSensitive).length ? 0 : -1);
        }}
        onFindNext={() => findStep(true)}
        onFindPrev={() => findStep(false)}
        onReplaceOne={onReplaceOne}
        onReplaceAll={onReplaceAll}
        onClose={() => setShowFind(false)}
      />

      {/* 에디터 본문 우클릭 컨텍스트 메뉴(news.md L173) — ctxMenu 있을 때만 렌더. 항목선택/Esc/마우스 이탈 시 닫힌다.
          잘라내기/복사/붙여넣기는 브라우저 기본 동작에 위임하고(onCtxSelect), aux 항목은 비활성 placeholder다. */}
      {ctxMenu && (
        <EditorContextMenu
          position={ctxMenu}
          enabledIds={ctxEnabledIds}
          checkedIds={ctxCheckedIds}
          onSelect={onCtxSelect}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </main>
  );
}

// 공통정보 — 편집 가능(작성자/엠바고/2차엠바고/공동작성/지역/속성/키워드/내부·외부코멘트 + 첨부/자료파일)
//   + 읽기전용 매핑 필드. 본문(내용)은 좌측 에디터가 담당하므로 별도 내용 입력란은 두지 않는다.
// 매핑 모드(readOnly)에서는 모든 공통정보 입력란을 readOnly/disabled로 잠근다(임베드만 변경 — step11, 본문-only 불변식).
// 파일 업로드는 ADR-003에 따라 view에서 직접 fetch하지 않고 model.uploadFile(file)로만 처리한다.
function CommonInfo({ tab, updateField, model, readOnly = false }) {
  const f = tab.fields;
  const ro = tab.readOnly || {};

  // 첨부/자료파일 — 선택 즉시 업로드(model.uploadFile) → 성공 시 반환 path를 해당 필드에 보관.
  const onFileChange = async (field, e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const r = await model.uploadFile(file);
    if (r && r.ok && r.path) updateField(field, r.path);
  };

  return (
    <div data-testid="meta-common">
      <div className="yh-meta-grid">
        <div className="yh-field">
          <label htmlFor="meta-author">작성자</label>
          <input id="meta-author" value={f.author} readOnly={readOnly} onChange={(e) => updateField('author', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="meta-coauthor">공동작성</label>
          <input id="meta-coauthor" value={f.coAuthor} readOnly={readOnly} onChange={(e) => updateField('coAuthor', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="meta-region">지역</label>
          <input id="meta-region" value={f.region} readOnly={readOnly} onChange={(e) => updateField('region', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="meta-attribute">속성</label>
          <input id="meta-attribute" value={f.attribute} readOnly={readOnly} onChange={(e) => updateField('attribute', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="meta-embargo">엠바고 시간</label>
          <input id="meta-embargo" value={f.embargoAt} readOnly={readOnly} onChange={(e) => updateField('embargoAt', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="meta-embargo2">2차 엠바고 시간</label>
          <input id="meta-embargo2" value={f.secondEmbargoAt} readOnly={readOnly} onChange={(e) => updateField('secondEmbargoAt', e.target.value)} />
        </div>
        <div className="yh-field yh-field--wide">
          <label htmlFor="meta-keyword">키워드</label>
          <input id="meta-keyword" value={f.keyword} readOnly={readOnly} onChange={(e) => updateField('keyword', e.target.value)} />
        </div>
        <div className="yh-field yh-field--wide">
          <label htmlFor="meta-internal-comment">내부코멘트</label>
          <textarea id="meta-internal-comment" value={f.internalComment} readOnly={readOnly} onChange={(e) => updateField('internalComment', e.target.value)} />
        </div>
        <div className="yh-field yh-field--wide">
          <label htmlFor="meta-external-comment">외부코멘트</label>
          <textarea id="meta-external-comment" value={f.externalComment} readOnly={readOnly} onChange={(e) => updateField('externalComment', e.target.value)} />
        </div>

        {/* 첨부파일/자료파일 — 실제 업로드. 저장된 path는 링크로 보여주고 지우기 버튼을 제공한다. */}
        <div className="yh-field yh-field--wide">
          <label htmlFor="meta-attachment">첨부파일</label>
          <input id="meta-attachment" type="file" disabled={readOnly} onChange={(e) => onFileChange('attachmentFile', e)} />
          {f.attachmentFile && (
            <span className="yh-file-saved">
              <a href={f.attachmentFile}>{f.attachmentFile}</a>
              {!readOnly && (
                <button type="button" aria-label="첨부파일 지우기" onClick={() => updateField('attachmentFile', '')}>×</button>
              )}
            </span>
          )}
        </div>
        <div className="yh-field yh-field--wide">
          <label htmlFor="meta-reference">자료파일</label>
          <input id="meta-reference" type="file" disabled={readOnly} onChange={(e) => onFileChange('referenceFile', e)} />
          {f.referenceFile && (
            <span className="yh-file-saved">
              <a href={f.referenceFile}>{f.referenceFile}</a>
              {!readOnly && (
                <button type="button" aria-label="자료파일 지우기" onClick={() => updateField('referenceFile', '')}>×</button>
              )}
            </span>
          )}
        </div>
      </div>

      {READONLY_LABELS.some(([k]) => ro[k] != null) && (
        <div className="yh-readonly-meta" data-testid="readonly-meta">
          {READONLY_LABELS.filter(([k]) => ro[k] != null).map(([k, label]) => (
            <div className="yh-field" key={k}>
              <label>{label}</label>
              <input value={String(ro[k])} readOnly />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 유튜브 video id로 썸네일 URL을 만든다(없으면 null).
function youtubeThumb(item) {
  const id = item.videoId ?? (item.id && item.id.videoId);
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
}

// 이미지(Google)/영상(YouTube)/글기사(내부 DB) 검색 패널 — 결과 선택 시 본문에 임베드.
// 이미지·영상은 썸네일 카드(클릭 시 삽입), 글기사는 제목 + '삽입' 버튼 행으로 깔끔하게 표시한다.
function SearchPanel({ kind, results, onSearch, onPick }) {
  const [q, setQ] = useState('');
  const submit = () => onSearch(q);
  return (
    <div data-testid={`meta-${kind}`}>
      <div className="yh-search-bar">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="검색어를 입력하세요"
          aria-label={`${kind} 검색어`}
        />
        <button type="button" className="yh-btn" onClick={submit}>검색</button>
      </div>

      {kind === 'article' ? (
        <ul className="yh-article-results">
          {results.map((item, i) => (
            <li className="yh-article-result" key={item.articleId ?? i}>
              <span className="yh-article-result__title" title={item.title}>
                {item.title || item.articleId || '(제목 없음)'}
              </span>
              <button
                type="button"
                className="yh-btn yh-btn--sm"
                onClick={() => onPick(item)}
              >
                삽입
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="yh-search-results">
          {results.map((item, i) => {
            const thumb = kind === 'image' ? (item.src ?? item.link) : youtubeThumb(item);
            return (
              <button
                type="button"
                className="yh-media-result"
                key={item.videoId ?? item.src ?? item.link ?? i}
                onClick={() => onPick(item)}
              >
                {thumb
                  ? <img src={thumb} alt={item.title ?? ''} />
                  : (item.title || item.url || '결과')}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default WriterPage;
