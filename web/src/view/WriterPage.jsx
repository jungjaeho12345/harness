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
import { EditorGlyphBar } from './EditorGlyphBar.jsx';
import { EditorPrefsDialog } from './EditorPrefsDialog.jsx';
import { FindReplaceDialog } from './FindReplaceDialog.jsx';
import { GlyphInputDialog } from './GlyphInputDialog.jsx';
import { UrlEmbedDialog } from './UrlEmbedDialog.jsx';
import { FileInfoDialog } from './FileInfoDialog.jsx';
import { MemoDialog } from './MemoDialog.jsx';
import { loadMemo, saveMemo } from './memoStore.js';
import { AbbrevManageDialog } from './AbbrevManageDialog.jsx';
import { loadAbbrevs, saveAbbrevs } from './abbrevStore.js';
import { expandAbbrevInBlocks } from './abbrevConvert.js';
import { SimpTradConvertDialog } from './SimpTradConvertDialog.jsx';
import { convertSimpTradInBlocks } from './simpTradConvert.js';
import { HistoryCompareDialog } from './HistoryCompareDialog.jsx';
import { EditorContextMenu } from './EditorContextMenu.jsx';
import {
  isFindReplace, findMatches, nextMatchIndex, replaceOne, replaceAll,
} from './editorFind.js';
import {
  selectAllInEditor, selectLineInEditor, selectWordInEditor, selectParagraphInEditor,
} from './editorSelect.js';
import { wordBoundsAt, paragraphBoundsAt } from './editorRange.js';
import { sortDocument, sortParagraph, deleteWordAt } from './editorEditOps.js';
import { loadEditorPrefs } from './editorPrefs.js';
import { saveDraft, loadDraft, clearDraft, expireDrafts } from './editorDraft.js';
import { setEditorColors } from './editorColoring.js';
import { submitButtons, SUBMIT_LABELS } from './writerButtons.js';
import { deserialize, serialize, hasEndMarker, blocksToText, isEmbedBlock } from './editorContent.js';
import {
  charCount, lineCount, wordCount, byteLength, caretPosition,
} from './editorStats.js';
import {
  insertEndMarker, isInsertEndMarker, isDeleteLine, deleteLineAt,
  isInsertContinueMarker, insertContinueMarker, transformTextLine,
  toUpper, toLower, capitalizeFirst, toggleCase, isGlyphInput, isPasteOriginal,
} from './editorShortcuts.js';
import { lineAtOffset } from './editorCaret.js';
import { insertGlyphAtCaret } from './editorGlyph.js';
import { insertDateAtCaret } from './editorDate.js';
import { applyDateFormat, kstIsoString } from './listFormat.js';
import {
  makeImageEmbed, makeVideoEmbed, makeArticleEmbed,
  makeAudioEmbed, makeLinkEmbed, makeLocalVideoEmbed, isAllowedHref,
} from './clipboardEmbed.js';
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
const MENU_ENABLED = ['file.recover', 'edit.findReplace', 'edit.selectAll', 'edit.insertEnd', 'edit.insertContinue', 'view.toUpper', 'view.toLower', 'view.capitalize', 'view.toggleCase', 'tools.abbrManage', 'tools.abbrConvert', 'tools.symbolInput', 'tools.insertDate', 'tools.insertImage', 'tools.insertYoutube', 'tools.insertAudio', 'tools.insertLink', 'tools.insertLocalVideo', 'tools.fileInfo', 'tools.memo', 'tools.simpTradConvert', 'tools.historyCompare', 'help.preferences', 'edit.selectParagraph', 'edit.selectLine', 'edit.selectWord', 'edit.sortDocument', 'edit.sortParagraph', 'edit.deleteLine', 'edit.deleteWord'];
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
  // 기본 숨김 — 상단을 비워두고 우클릭 컨텍스트 메뉴 '메뉴바/툴바 보이기'(ctx.showMenuBar/ctx.showToolBar)로만 켠다(news.md L173).
  const [statusCaret, setStatusCaret] = useState(null);
  const [showMenuBar, setShowMenuBar] = useState(false);
  const [showToolBar, setShowToolBar] = useState(false);
  // 약물바 보이기(우클릭 컨텍스트 메뉴) — showMenuBar/showToolBar와 동일한 레이아웃 토글.
  // 우클릭 '약물바 보이기'가 이 값을 켜고 끄면 EditorGlyphBar(자주쓰는 약물)를 렌더/숨긴다(매핑 모드 제외).
  const [showGlyphBar, setShowGlyphBar] = useState(false);
  // 자주쓰는 약물(editorPrefs.glyphFavorites.items) — 약물바 버튼 + 약물입력 다이얼로그 favorites 소스. editorBg/autosaveCfg와 동일 게이트:
  // 마운트 lazy 초기화 + onPrefsClose(applied) 갱신만(별도 effect/구독 없음 — 환경설정 등록 후 즉시 반영용).
  const [glyphFavorites, setGlyphFavorites] = useState(() => loadEditorPrefs().glyphFavorites.items);
  // 사용자 키보드 약물(editorPrefs.glyphKeymap.items: {keys,glyph}[]) — 약물입력 다이얼로그 참조 표시용. glyphFavorites와 동일 게이트.
  const [glyphKeymap, setGlyphKeymap] = useState(() => loadEditorPrefs().glyphKeymap.items);
  // 약물입력 다이얼로그 보이기(Alt+O·도구 메뉴·우클릭) — FindReplaceDialog의 showFind와 동일한 표시 토글.
  const [showGlyphInput, setShowGlyphInput] = useState(false);
  // URL 직접 임베드 다이얼로그 — null(닫힘) | 'image' | 'video'. 도구>그림/유튜브 삽입으로 열린다(showGlyphInput 패턴 확장).
  const [urlEmbedKind, setUrlEmbedKind] = useState(null);
  // 파일 정보 다이얼로그(도구>파일 정보) 보이기 — showGlyphInput과 동일한 표시 토글. 읽기전용이라 본문 무변경.
  const [showFileInfo, setShowFileInfo] = useState(false);
  // 메모장 다이얼로그(도구>메모장) 보이기 — showFileInfo와 동일한 표시 토글. 기사와 무관한 전역 스크래치패드.
  const [showMemo, setShowMemo] = useState(false);
  // 전역 메모 텍스트(부모 소유·controlled) — glyphFavorites처럼 마운트 lazy-init(새로고침 후 저장본 복원).
  // 세션 내 진실 소스: 입력은 setMemoText만(in-memory), 영속은 '저장'에서 saveMemo만. 탭/articleId 비종속(전역 1개).
  const [memoText, setMemoText] = useState(() => loadMemo());
  // 약어 관리 다이얼로그(도구>약어관리) 보이기 — showFileInfo/showMemo와 동일한 표시 토글. 본문 무관(매핑에서도 안전).
  const [showAbbrevManage, setShowAbbrevManage] = useState(false);
  // 사용자 등록 약어 목록(짧은형→확장형, 전역 1개·세션 진실 소스) — glyphFavorites처럼 마운트 lazy-init.
  // 이후 CRUD(setAbbrevs(saveAbbrevs(...)))로만 갱신한다(렌더/오픈마다 재-load 금지, articleId/탭 비종속).
  const [abbrevs, setAbbrevs] = useState(() => loadAbbrevs());
  // 간체↔번체 변환 방향 선택 다이얼로그(도구>간체↔번체 변환) 보이기 — showAbbrevManage/showMemo 패턴.
  // 변환표(SIMP_TRAD_PAIRS)는 번들 정적 상수라 별도 state가 없다(약어의 abbrevs 같은 lazy-init 없음).
  const [showSimpTrad, setShowSimpTrad] = useState(false);
  // 기사 이력 비교(도구>기사이력비교) — 읽기전용 표시 state만 둔다(step2, 25-article-history-compare).
  // historyEntries: 열 때 queryHistory 결과 중 스냅샷 보유(hasSnapshot) 항목. 좌/우 key는 'current' 또는 이력 id,
  // 좌/우 text는 지연 조회(getHistorySnapshot) 결과를 deserialize+blocksToText로 변환한 비교용 텍스트(미준비면 null).
  // 이 경로의 조회 결과는 여기에만 흐른다 — updateField/serialize/insertEmbed 미호출(본문/캐럿/임베드 불변).
  const [showHistoryCompare, setShowHistoryCompare] = useState(false);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [histLeftKey, setHistLeftKey] = useState(null);
  const [histRightKey, setHistRightKey] = useState(null);
  const [histLeftText, setHistLeftText] = useState(null);
  const [histRightText, setHistRightText] = useState(null);
  // 에디터 본문 우클릭 컨텍스트 메뉴 위치({x,y}) 또는 null(닫힘). ListPage 우클릭 패턴(좌표 상태 + 바깥/Esc 닫기).
  const [ctxMenu, setCtxMenu] = useState(null);

  // 색상 환경설정(도움말>환경설정) — 모달 표시 + 에디터 바탕색(editorBg). 저장값은 localStorage(editorPrefs)에 영속.
  const [showPrefs, setShowPrefs] = useState(false);
  const [editorBg, setEditorBg] = useState(() => loadEditorPrefs().colors.background);

  // 편집>컬럼제한(edit.columnLimit) — 캔버스 래퍼(editor-canvas) 좌우 여백 10%로 적용(news.md L185).
  // editorBg와 동일 게이트: 마운트 적용 + onPrefsClose(applied) 갱신. Editor.jsx 내부는 미접촉(여백은 바깥 래퍼에서만).
  const [columnLimit, setColumnLimit] = useState(() => loadEditorPrefs().edit.columnLimit);

  // 자동저장 설정(환경설정>자동저장: enabled/intervalSec/retentionDays) — 타이머 effect의 단일 의존성.
  // 모달 적용(onPrefsClose(true)) 시 저장값으로 갱신한다(취소 시 불필요 — editorBg와 동일 게이트).
  const [autosaveCfg, setAutosaveCfg] = useState(() => loadEditorPrefs().autosave);

  // 마운트 시 저장된 색을 적용한다(새로고침 후에도 반영). 텍스트색은 setEditorColors, 바탕색은 editorBg로.
  useEffect(() => {
    const c = loadEditorPrefs().colors;
    setEditorColors({ title: c.title, subtitle: c.subtitle, body: c.body });
    setEditorBg(c.background);
    setColumnLimit(loadEditorPrefs().edit.columnLimit); // 새로고침 후에도 컬럼제한 반영.
  }, []);

  // 모달 닫힘 — applied=true(적용)면 바탕색을 저장값으로 갱신(모달이 이미 setEditorColors 호출 → 자연 재렌더로 텍스트색 반영).
  // applied가 아니면(취소) 색/배경 갱신 없이 닫기만 한다.
  const onPrefsClose = (applied) => {
    if (applied) {
      setEditorBg(loadEditorPrefs().colors.background);
      setAutosaveCfg(loadEditorPrefs().autosave); // 자동저장 간격/사용여부 변경을 타이머에 반영(재설정).
      setColumnLimit(loadEditorPrefs().edit.columnLimit); // 컬럼제한(좌우 여백) 변경 반영 — 취소 시 불변(editorBg와 동일 게이트).
      setGlyphFavorites(loadEditorPrefs().glyphFavorites.items); // 환경설정에서 등록한 자주쓰는 약물을 약물바/약물입력 다이얼로그에 즉시 반영.
      setGlyphKeymap(loadEditorPrefs().glyphKeymap.items); // 사용자 키보드 약물(참조 표시)도 동일 게이트로 즉시 반영.
    }
    setShowPrefs(false);
  };

  // 매핑(mapping) — 임베드 전용 제한 편집. 본문 텍스트 비편집·공통정보 readOnly이되 임베드 추가/삭제는 허용(step11).
  const isMapping = activeTab.mode === 'mapping';

  const body = activeTab.fields.body;
  const blocks = deserialize(body);

  // 마지막 에디터 캐럿(텍스트-줄) — 검색패널 클릭 시 에디터 포커스가 빠져 라이브 readCaret이 null이므로 여기 보관(Editor onCaretChange).
  const lastCaretRef = useRef(null);
  // 탭 전환 시 캐럿 소스 초기화 — lastCaretRef는 문서(탭)-로컬 좌표라 다른 탭으로 이월되면 편집 메뉴
  // (한줄/단어 지우기·문단 정렬 등)가 사용자가 가리킨 적 없는 줄을 변경·삭제한다(되돌리기 미구현 — 복구 불가).
  // 상태표시줄(statusCaret)도 같은 좌표라 함께 비운다. effect가 아니라 렌더 중 조정 패턴인 이유:
  // effect는 마운트에서도 돌고 flush가 늦으면 전환/마운트 후 새로 기록된 캐럿을 지운다(레이스).
  const [caretTabId, setCaretTabId] = useState(activeTabId);
  if (caretTabId !== activeTabId) {
    setCaretTabId(activeTabId);
    lastCaretRef.current = null;
    setStatusCaret(null);
  }
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

  // 찾기/바꾸기 다이얼로그 열기 — 부모 findQuery/activeIndex를 함께 초기화한다.
  // (재개방 직후 다이얼로그 입력은 비어 있는데 부모에 이전 query/activeIndex가 남아 find-status가 잠깐 'N/M'을 보이는 불일치 방지.)
  const openFind = () => {
    setFindQuery('');
    setActiveIndex(-1);
    setShowFind(true);
  };

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

  // 본문 변경 단일 경로(choke point) — body를 갱신하고 제목(본문 첫 줄)을 항상 재동기화한다.
  // 타이핑 외 경로(약어변환/간체번체/바꾸기/대소문자/줄삭제/마커·약물·날짜 삽입/임베드)가 body만 갱신해
  // 저장 시 옛 제목이 DB에 남던(제목 stale) 결함 방지 — 모든 본문변경 핸들러가 updateField('body', ...)
  // 대신 이 함수를 지난다(phase 29 편집 메뉴도 재사용). 제목 파생은 writerBody.bodyTitle 단일 출처만 쓴다.
  // 매핑 모드에서는 컨트롤러 updateField가 title을 거부(no-op)하므로 본문-only 불변식을 깨지 않는다.
  const commitBody = (nextBody) => {
    updateField('body', nextBody);
    updateField('title', bodyTitle(nextBody));
  };

  // 본문 타이핑 → 에디터가 읽은 블록(텍스트 + 임베드, 커서 위치 보존)을 직렬화해 커밋(제목 동기화는 commitBody).
  // 임베드는 "(끝)"만 최종 블록으로 보낼 뿐 위치를 옮기지 않는다(news.md 156·167행 — 커서 위치/블록 순서 보존).
  const onTextChange = (text, editedBlocks) => {
    commitBody(serializeBodyFromBlocks(editedBlocks));
  };

  // (끝)삽입 — 키보드 Alt+Y와 메뉴 'edit.insertEnd'의 공용 핸들러(단일 소스). "(끝)" 최종 블록 삽입 + 맞춤법 on(중복이면 무삽입).
  const insertEnd = () => {
    const r = insertEndMarker(blocks);
    commitBody(serialize(r.blocks));
    setSpell(true); // Editor가 spellcheck 상태 변화로 재렌더되어 색칠(메뉴 경로에서도 동일 부수효과).
  };

  // (계속)삽입 — 키보드 Ctrl+Y와 메뉴 'edit.insertContinue'의 공용 핸들러. 마지막 캐럿 텍스트-줄 다음에 "(계속)" 삽입.
  const insertContinue = () => {
    const caretLine = lastCaretRef.current ? lastCaretRef.current.lineIndex : null;
    const r = insertContinueMarker(blocks, caretLine);
    commitBody(serialize(r.blocks));
    if (typeof r.caretTextLine === 'number') setPendingCaretLine(r.caretTextLine);
  };

  // 약물바 약물 클릭 → 마지막 캐럿 위치에 약물 삽입(검색 임베드 insertEmbed와 동일 캐럿 소스·안전 경로).
  const onGlyphPick = (glyph) => {
    if (isMapping) return;                       // 매핑 모드(텍스트 잠금)에서는 본문 변경 금지 — no-op(약물바 숨김과 이중 방어).
    const caret = lastCaretRef.current;          // {lineIndex, offset} 또는 null(캐럿 없으면 헬퍼가 줄 끝 폴백).
    const r = insertGlyphAtCaret(blocks, caret, glyph);
    commitBody(serialize(r.blocks));             // contentEditable 직접 조작 금지 — 직렬화 안전 경로만.
    if (typeof r.caretTextLine === 'number') setPendingCaretLine(r.caretTextLine);
  };

  // 도구>날짜 삽입 — 현재 시각(비결정)을 KST 벽시계로 바꿔 날짜형식 prefs(dateFormat)대로 포맷해 캐럿 위치에 텍스트로 삽입.
  // 비결정성(Date.now)·포맷팅(applyDateFormat)은 여기서만 — 순수 헬퍼(insertDateAtCaret)는 완성된 문자열만 받는다.
  // 약물입력(onGlyphPick)과 동일 안전 경로(commitBody(serialize(...)) + setPendingCaretLine). DOM 직접 조작 금지.
  const insertDate = () => {
    if (isMapping) return;                                   // 매핑(텍스트 잠금) no-op — 본문-only 불변식.
    const fmt = loadEditorPrefs().dateFormat;                // 읽기 전용(저장/변경 안 함).
    const dateString = applyDateFormat(kstIsoString(Date.now()), fmt);
    const caret = lastCaretRef.current;                      // {lineIndex, offset} 또는 null(캐럿 없으면 헬퍼가 줄 끝 폴백).
    const r = insertDateAtCaret(blocks, caret, dateString);
    commitBody(serialize(r.blocks));
    if (typeof r.caretTextLine === 'number') setPendingCaretLine(r.caretTextLine);
  };

  // 도구>약어관리 CRUD — 약어사전은 각 추가/삭제가 확정 동작이라 즉시 saveAbbrevs로 localStorage 영속한다(별도 '저장' 버튼 없음).
  // saveAbbrevs가 정규화 목록을 돌려주므로 그 반환값으로 state를 세팅해 화면·저장소를 일치시킨다. 본문/캐럿/임베드 무변경.
  const addAbbrev = (short, long) => {
    const s = String(short ?? '').trim();
    const l = String(long ?? '').trim();
    if (!s || !l) return;                                     // 빈 입력 no-op(다이얼로그도 가드하지만 이중 방어).
    setAbbrevs((list) => saveAbbrevs([...list, { short: s, long: l }]));
  };
  const removeAbbrev = (index) => {
    setAbbrevs((list) => saveAbbrevs(list.filter((_, i) => i !== index)));
  };

  // 도구>약어변환 — 등록 약어(abbrevs 세션 state)를 본문 텍스트 블록에서 확장(임베드·"(끝)" 불변). 매핑 가드 뒤에서만 호출.
  // 안전 경로(commitBody(serialize(...)))만 쓴다 — DOM/Editor 직접 조작 금지(날짜삽입/대소문자변환과 동일).
  // 전체 본문 transform이라 setPendingCaretLine은 호출하지 않는다(오프셋 대량 변동 — 부정확 캐럿 이동보다 포커스 유지가 안전).
  const convertAbbrev = () => {
    const r = expandAbbrevInBlocks(blocks, abbrevs);
    if (!r.changed) return;                                   // 등록 약어 없음/매치 없음 → no-op(불필요한 dirty 방지).
    commitBody(serialize(r.blocks));
  };

  // 도구>간체↔번체 변환 — 방향 다이얼로그 버튼(간체→번체/번체→간체)이 호출. 등록 표(SIMP_TRAD_PAIRS)로 본문
  // 텍스트 블록을 방향대로 변환(임베드·"(끝)" 불변) → commitBody(serialize(...)) 안전 경로만(약어변환과 동일).
  // 매핑 가드 뒤에서만 도달하지만 다이얼로그가 열린 채 탭 전환에 대비해 isMapping 이중 방어. changed일 때만 반영(no-op 시
  // dirty 방지) 후 1회성으로 닫는다. 전체 본문 transform이라 setPendingCaretLine은 호출하지 않는다(약어변환과 동일 정책).
  const applySimpTrad = (direction) => {
    if (isMapping) return;
    const r = convertSimpTradInBlocks(blocks, direction);
    if (r.changed) commitBody(serialize(r.blocks));
    setShowSimpTrad(false);
  };

  // 도구>기사이력비교 — 열 때 현재 편집 기사의 이력을 조회해 스냅샷 보유 항목만 담고 다이얼로그를 연다(선택은 초기화).
  // 저장 안 된 새 기사(articleId 없음)는 조회 없이 빈 이력으로 열고, 조회 실패/빈 배열도 죽지 않고 빈 상태로 연다.
  const openHistoryCompare = async () => {
    histReqRef.current = { left: null, right: null }; // 선택 초기화와 함께 — 재열기 전 지연 조회의 늦은 응답도 폐기(레이스 가드).
    setHistLeftKey(null);
    setHistRightKey(null);
    setHistLeftText(null);
    setHistRightText(null);
    let entries = [];
    if (activeTab.articleId) {
      try {
        const r = await model.queryHistory(activeTab.articleId);
        if (r && r.ok && Array.isArray(r.items)) entries = r.items.filter((h) => h.hasSnapshot);
      } catch { /* 조회 실패 — 빈 이력으로 연다(읽기전용 경로, 본문 불변) */ }
    }
    setHistoryEntries(entries);
    setShowHistoryCompare(true);
  };

  // 좌/우 비교 대상 선택 — 'current'는 조회 없이 in-memory 본문 텍스트(bodyText)를 즉시 세팅하고,
  // 스냅샷 id면 model.getHistorySnapshot으로 그 항목만 지연 조회해 텍스트로 변환(deserialize+blocksToText)한다.
  // 조회 결과는 표시 state에만 넣는다 — updateField/serialize 미호출(읽기전용 불변식).
  // 쪽(side)별 최신 요청 key 미러 ref — 지연 조회 대기 중 같은 쪽에서 재선택하면(스냅샷→다른 스냅샷/'current')
  // 늦게 도착한 이전 응답이 최신 선택의 텍스트를 덮어써 key와 표시 본문이 어긋난 diff가 보인다. 그래서 진입 시
  // ref에 key를 기록하고('current' 즉시경로 포함), await 뒤 ref가 여전히 이 호출의 key일 때만 setText를 적용한다
  // (pasteImageAtCaret의 시작 시점 tabId 캡처→쓰기 전 재확인과 동일 패턴).
  const histReqRef = useRef({ left: null, right: null });
  const selectCompareTarget = async (side, key) => {
    const setKey = side === 'left' ? setHistLeftKey : setHistRightKey;
    const setText = side === 'left' ? setHistLeftText : setHistRightText;
    histReqRef.current[side] = key;
    setKey(key);
    if (key === 'current') {
      setText(bodyText);
      return;
    }
    setText(null); // 조회 중 — 다이얼로그가 대기 안내를 보여준다.
    try {
      const s = await model.getHistorySnapshot(activeTab.articleId, key);
      if (histReqRef.current[side] !== key) return; // stale — 대기 중 같은 쪽이 재선택됨(응답 폐기).
      if (s && s.ok && s.item) setText(blocksToText(deserialize(s.item.markupVersion)));
    } catch { /* 조회 실패 — 대기 안내 유지(죽지 않음) */ }
  };

  // 다이얼로그 비교 대상 목록 — '현재 본문' + 스냅샷 이력(시각/작성자 라벨, key=이력 id).
  const historyCompareEntries = [
    { key: 'current', label: '현재 본문' },
    ...historyEntries.map((h) => ({
      key: h.id,
      label: [h.createdAt, h.actorUserId].filter(Boolean).join(' / ') || String(h.id),
    })),
  ];

  // 매치 start 오프셋이 속한 텍스트-줄로 캐럿을 옮긴다(임베드/마커 삽입과 동일한 pendingCaretLine 포커스 경로).
  // 줄 안 정확 컬럼 선택은 이번 범위 밖(focusLineStart — 줄 시작 캐럿).
  const focusMatchLine = (offset) => {
    const { lineIndex } = lineAtOffset(bodyText, offset);
    setPendingCaretLine(lineIndex);
  };

  // 다음/이전 찾기 — 현재 활성 매치 기준으로 순환 인덱스를 구해 그 줄로 이동.
  // forward는 현재 매치 끝(cur.end)부터 다음 매치를, backward는 현재 매치 시작(cur.start)부터 이전 매치를 찾는다.
  // (backward에 cur.end를 쓰면 현재 매치 자신이 start<cur.end를 항상 만족해 제자리에 정체된다 — onReplaceOne과 동일하게 cur.start 사용.)
  // 활성 매치가 없으면(activeIndex<0) 마지막 캐럿 offset(없으면 0)부터 탐색한다.
  const findStep = (forward) => {
    if (!findQuery || matches.length === 0) return; // 빈 query/매치 없음 no-op
    const cur = activeIndex >= 0 && activeIndex < matches.length ? matches[activeIndex] : null;
    const fromOffset = cur
      ? (forward ? cur.end : cur.start)
      : (lastCaretRef.current ? lastCaretRef.current.offset : 0);
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
    commitBody(serialize(r.blocks));
    if (typeof r.caretOffset === 'number') focusMatchLine(r.caretOffset);
    setActiveIndex(-1); // 텍스트가 바뀌어 기존 매치 인덱스 무효 → 리셋(다음 찾기는 캐럿/0부터).
  };

  // 모두 바꾸기(replaceAll) — 모든 매치 치환. 다이얼로그는 열린 채 유지(현황 갱신). 매핑/빈 query no-op.
  const onReplaceAll = (replacement) => {
    if (isMapping || !findQuery) return;
    const r = replaceAll(blocks, findQuery, replacement, { caseSensitive: findCase });
    if (r.count <= 0) return; // 매치 없음 no-op
    commitBody(serialize(r.blocks));
    setActiveIndex(-1); // 텍스트가 바뀌어 기존 매치 무효.
  };

  // 라인 삭제 코어 — onKeyDown Ctrl+D(빈 줄 Backspace/Delete 포함)와 메뉴 'edit.deleteLine'의 단일 소스.
  // deleteLineAt(동반 임베드 1개 삭제 승계) → commitBody(제목 재동기화 자동 — phase 28)만 담는다.
  // setPendingCaretLine은 넣지 않는다 — Ctrl+D는 캐럿 복원을 Editor refocus에 맡기므로(기존 동작 불변),
  // 메뉴 경로만 호출부에서 따로 부른다.
  const deleteLineByBlockIndex = (blockIndex) => {
    commitBody(serialize(deleteLineAt(blocks, blockIndex).blocks));
  };

  // 에디터 메뉴(EditorMenuBar) 선택 — 결선된 항목만 동작한다.
  // 매핑 모드(텍스트 잠금)에서는 본문을 바꾸지 않는다(본문-only 불변식).
  const onMenuSelect = (id) => {
    // 색 설정은 본문 잠금과 무관 — 매핑 가드 이전에 처리(매핑 모드에서도 열려야 함, 죽은 버튼 방지).
    if (id === 'help.preferences') { setShowPrefs(true); return; }
    // 그림/유튜브 URL 직접 삽입 — 매핑 가드 앞(임베드 변경은 매핑에서도 허용, 검색패널 onPick과 동일 정책).
    // 본문 텍스트가 아닌 임베드 변경이라 본문-only 불변식과 무관 — 다이얼로그를 열어 URL을 받는다(삽입은 onUrlEmbedSubmit).
    if (id === 'tools.insertImage') { setUrlEmbedKind('image'); return; }
    if (id === 'tools.insertYoutube') { setUrlEmbedKind('video'); return; }
    // 오디오/링크/로컬영상 — 그림/유튜브와 동일 정책(임베드는 매핑에서도 허용 → 매핑 가드 앞).
    if (id === 'tools.insertAudio') { setUrlEmbedKind('audio'); return; }
    if (id === 'tools.insertLink') { setUrlEmbedKind('link'); return; }
    if (id === 'tools.insertLocalVideo') { setUrlEmbedKind('localVideo'); return; }
    // 파일 정보 — 읽기전용(본문 통계 표시만). 매핑 가드 앞(매핑에서도 열림, 죽은 버튼 방지 — 임베드 삽입 항목과 동일 정책).
    if (id === 'tools.fileInfo') { setShowFileInfo(true); return; }
    // 메모장 — 기사와 무관한 전역 스크래치패드(본문/캐럿/임베드 무변경). 매핑 가드 앞(본문 무관 → 매핑에서도 열림, 파일 정보와 동일 정책).
    if (id === 'tools.memo') { setShowMemo(true); return; }
    // 약어관리 — 약어사전 CRUD 다이얼로그(본문/캐럿/임베드 무변경). 매핑 가드 앞(본문 무관 → 매핑에서도 열림, 파일 정보/메모와 동일 정책).
    if (id === 'tools.abbrManage') { setShowAbbrevManage(true); return; }
    // 기사이력비교 — 읽기전용(이력/스냅샷 조회 결과는 표시 state로만). 매핑 가드 앞(매핑에서도 열림, 파일 정보와 동일 정책).
    if (id === 'tools.historyCompare') { openHistoryCompare(); return; }
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
    if (id === 'edit.findReplace') { openFind(); return; }
    // 약물 입력 — 매핑 가드 뒤(약물 삽입은 본문 변경 → 매핑에서는 열지 않는다, 찾기와 동일 정책).
    if (id === 'tools.symbolInput') { setShowGlyphInput(true); return; }
    // 날짜 삽입 — 매핑 가드 뒤(본문 텍스트 변경 → 매핑 비활성, 약물입력과 동일 정책).
    if (id === 'tools.insertDate') { insertDate(); return; }
    // 약어변환 — 등록 약어를 본문에서 확장(본문 변경). 매핑 가드 뒤(매핑=텍스트 잠금이라 no-op, 날짜삽입과 동일 정책).
    if (id === 'tools.abbrConvert') { convertAbbrev(); return; }
    // 간체↔번체 변환 — 방향 선택 다이얼로그를 연다(버튼이 applySimpTrad로 본문 변환). 결과적으로 본문 변경이라
    // 매핑 가드 뒤(매핑에선 아예 열지 않음 — 죽은 다이얼로그 방지, 약어변환과 동일 정책).
    if (id === 'tools.simpTradConvert') { setShowSimpTrad(true); return; }
    // 전체 선택 — 선택 연산(본문 무변경). 메뉴 클릭은 에디터 포커스가 빠져 있어 명시 selectAll 한다.
    // (Ctrl+A 키는 contentEditable 위에서 브라우저 기본이 전체를 선택하므로 onKeyDown에서 가로채지 않는다.)
    if (id === 'edit.selectAll') { selectAllInEditor(document.querySelector('.yh-editor')); return; }
    // 문단/한줄/단어 선택 — 선택 연산(본문 무변경, updateField/serialize/setPendingCaretLine 미호출).
    // 형제 edit.selectAll과 동일하게 매핑 가드 뒤(매핑에서 no-op — 메뉴 내 일관성). 캐럿은 lastCaretRef
    // (메뉴 클릭으로 포커스가 빠짐 — 기존 결선 규약), 경계 계산은 editorRange만(단일 출처), 적용은 editorSelect.
    if (id === 'edit.selectLine' || id === 'edit.selectWord' || id === 'edit.selectParagraph') {
      const caret = lastCaretRef.current;
      if (!caret) return; // 캐럿 없음 no-op
      const root = document.querySelector('.yh-editor');
      if (id === 'edit.selectLine') { selectLineInEditor(root, caret.lineIndex); return; }
      if (id === 'edit.selectWord') {
        const { start } = lineAtOffset(bodyText, caret.offset);
        const column = caret.offset - start;
        const lineText = bodyText.split('\n')[caret.lineIndex] ?? '';
        const { start: colStart, end: colEnd } = wordBoundsAt(lineText, column);
        selectWordInEditor(root, caret.lineIndex, colStart, colEnd); // 빈 범위면 헬퍼가 no-op
        return;
      }
      const { startLine, endLine } = paragraphBoundsAt(bodyText.split('\n'), caret.lineIndex);
      selectParagraphInEditor(root, startLine, endLine);
      return;
    }
    // 문서/문단 정렬·한줄/단어 지우기 — 본문 변경 op(매핑 가드 뒤). 계산은 editorEditOps(step 3)·
    // deleteLineAt(Ctrl+D 단일 출처)만 재사용하고, 반영은 commitBody(serialize(...)) 단일 choke point만
    // (제목 재동기화는 commitBody 자동 — phase 28 불변식, 결선부 별도 title 단계 없음).
    // changed:false/캐럿 없음/blockIndex<0은 no-op(불필요한 dirty/remount 회피).
    if (id === 'edit.sortDocument') {
      const r = sortDocument(blocks);
      // 전체 본문 transform — setPendingCaretLine 미호출(오프셋 대량 변동, convertAbbrev와 동일 정책).
      if (r.changed) commitBody(serialize(r.blocks));
      return;
    }
    if (id === 'edit.sortParagraph') {
      const caretLine = lastCaretRef.current ? lastCaretRef.current.lineIndex : null;
      if (caretLine == null) return;
      const r = sortParagraph(blocks, caretLine);
      // 줄 순서가 바뀌는 transform — sortDocument와 동일하게 setPendingCaretLine 미호출.
      if (r.changed) commitBody(serialize(r.blocks));
      return;
    }
    if (id === 'edit.deleteLine') {
      const caretLine = lastCaretRef.current ? lastCaretRef.current.lineIndex : null;
      if (caretLine == null) return;
      const blockIndex = textLineToBlockIndex(blocks, caretLine);
      if (blockIndex < 0) return;
      deleteLineByBlockIndex(blockIndex); // Ctrl+D와 공용 코어(단일 소스)
      setPendingCaretLine(caretLine); // 메뉴 클릭으로 빠진 포커스를 삭제 자리 줄로(메뉴 경로 한정).
      return;
    }
    if (id === 'edit.deleteWord') {
      const caret = lastCaretRef.current;
      if (!caret) return;
      const { start } = lineAtOffset(bodyText, caret.offset);
      const r = deleteWordAt(blocks, caret.lineIndex, caret.offset - start);
      if (!r.changed) return; // 마커 줄/단어 없음/매핑 실패 — no-op
      commitBody(serialize(r.blocks));
      setPendingCaretLine(caret.lineIndex);
      return;
    }
    if (id === 'edit.insertEnd') { insertEnd(); return; }
    if (id === 'edit.insertContinue') { insertContinue(); return; }
    const fn = VIEW_TRANSFORMS[id];
    if (!fn) return;
    // 대소문자 변환은 마지막 캐럿 텍스트-줄에만 적용한다. 캐럿이 없으면 no-op.
    const caretLine = lastCaretRef.current ? lastCaretRef.current.lineIndex : null;
    if (caretLine == null) return;
    const r = transformTextLine(blocks, caretLine, fn);
    commitBody(serialize(r.blocks));
    setPendingCaretLine(caretLine); // 같은 줄 유지(메뉴 클릭으로 빠진 포커스를 그 줄로 되돌림).
  };

  // 우클릭 컨텍스트 메뉴(EditorContextMenu) 활성 항목(ctx.*) — EditorMenuBar enabledIds 패턴.
  //  - 항상 활성: 찾기/바꾸기·전체 선택·보이기 토글(메뉴바/툴바/약물바). 선택 연산·레이아웃 토글이라 본문-only 불변식과 무관.
  //  - 표준 편집(잘라내기/복사/붙여넣기): 비매핑(텍스트 편집 가능)일 때만 활성. 매핑(텍스트 잠금)에서는 복사도 일관되게 비활성으로
  //    단순화한다(본문 변경 항목과 같은 가드 — 잘라내기/붙여넣기는 텍스트를 바꾸므로 반드시 비활성).
  //  - 약물입력(ctx.symbolInput): 비매핑(본문 편집 가능)일 때만 활성(약물 삽입=본문 변경 → 매핑 비활성, 찾기와 동일 가드).
  //  - 원본 붙여넣기(ctx.pasteOriginal): 클립보드 이미지 붙여넣기(Alt+V와 동일 경로) — 본문 변경이라 비매핑에서만 활성.
  //  - aux-tools 의존(기업코드변환/텍스트 붙여넣기): 항상 비활성 placeholder(미구현).
  const ctxEnabledIds = [
    'ctx.findReplace', 'ctx.selectAll', 'ctx.showMenuBar', 'ctx.showToolBar', 'ctx.showGlyphBar',
    ...(isMapping ? [] : ['ctx.cut', 'ctx.copy', 'ctx.paste', 'ctx.pasteOriginal', 'ctx.symbolInput']),
  ];
  // 보이기 토글의 현재 on 상태(체크 표식용).
  const ctxCheckedIds = [
    ...(showMenuBar ? ['ctx.showMenuBar'] : []),
    ...(showToolBar ? ['ctx.showToolBar'] : []),
    ...(showGlyphBar ? ['ctx.showGlyphBar'] : []),
  ];

  // 파일 정보 통계(읽기전용 스냅샷) — showFileInfo가 true일 때만 파생 계산한다(effect/타이머 없이, 찾기 매치 파생계산과 동일).
  // 캐럿은 statusCaret(StatusBar와 동일 소스 — 메뉴 클릭으로 포커스가 빠져 라이브 readCaret은 null)을 쓴다.
  // 임베드 개수는 blocks(텍스트+임베드 전체)에서 센다(bodyText는 텍스트만이라 임베드가 빠짐).
  let fileInfoStats = null;
  if (showFileInfo) {
    const cp = caretPosition(bodyText, statusCaret);
    fileInfoStats = {
      chars: charCount(bodyText),
      words: wordCount(bodyText),
      bytes: byteLength(bodyText),
      lines: lineCount(bodyText),
      embeds: blocks.filter(isEmbedBlock).length,
      paragraph: cp.paragraph,
      row: cp.row,
      column: cp.column,
    };
  }

  // 우클릭 컨텍스트 메뉴 선택(ctx.*) 라우팅. 찾기/전체선택은 메뉴바와 동일 동작을 공유한다(중복 금지).
  const onCtxSelect = (id) => {
    switch (id) {
      // 찾기/바꾸기 — 매핑에선 본문 변경 가능이라 다이얼로그를 열지 않는다(Ctrl+F·편집 메뉴와 동일 가드).
      case 'ctx.findReplace': if (!isMapping) openFind(); break;
      // 전체 선택 — Step 2 selectAllInEditor 재사용(선택 연산만, 본문/DOM 무변경).
      case 'ctx.selectAll': selectAllInEditor(document.querySelector('.yh-editor')); break;
      case 'ctx.showMenuBar': setShowMenuBar((v) => !v); break;
      case 'ctx.showToolBar': setShowToolBar((v) => !v); break;
      // 약물바 — showMenuBar/showToolBar와 동일한 레이아웃 토글(EditorGlyphBar 렌더/숨김).
      case 'ctx.showGlyphBar': setShowGlyphBar((v) => !v); break;
      // 약물입력 — 비매핑에서만 다이얼로그를 연다(매핑은 enabledIds에서 비활성이라 호출되지 않지만 이중 방어).
      case 'ctx.symbolInput': if (!isMapping) setShowGlyphInput(true); break;
      // 원본 붙여넣기 — Alt+V와 동일 경로(클립보드 이미지 → 업로드 → 경로 임베드). 비매핑에서만(이중 방어).
      case 'ctx.pasteOriginal': if (!isMapping) pasteOriginalAtCaret(); break;
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
      // aux 항목(ctx.companyCode/pasteText)은 비활성이라 호출되지 않는다.
      default: break;
    }
  };

  // Alt+Y → "(끝)" 삽입(insertEnd). Ctrl+Y → "(계속)" 삽입(insertContinue, 브라우저 redo 가로채기).
  // Ctrl+D / 빈 줄 Backspace·Delete → 활성 라인(+동반 임베드 1개) 삭제. 문자 삭제(비어 있지 않은 줄)는 기본 동작 유지.
  const onKeyDown = (e) => {
    // IME 조합 중에는 어떤 에디터 단축키도 가로채지 않는다(줄삭제/preventDefault 없이 브라우저·IME에 위임 —
    // news.md 173행 조합 중 무개입 원칙. 조합 상태는 nativeEvent.isComposing(레거시 keyCode 229)로 판정).
    if ((e.nativeEvent && e.nativeEvent.isComposing) || e.keyCode === 229) return;
    // Ctrl+F → 찾기/바꾸기 다이얼로그(브라우저 기본 찾기 가로채기). 매핑이어도 preventDefault는 하되 다이얼로그는 안 연다.
    // isFindReplace는 !altKey라 Alt+Y와 충돌하지 않는다(라인삭제 조기 return보다 위에 둔다).
    if (isFindReplace(e)) {
      e.preventDefault();
      if (!isMapping) openFind();
      return;
    }
    // Alt+O → 약물입력 다이얼로그(찾기와 동일 위치·가드). 매핑이어도 preventDefault는 하되 다이얼로그는 안 연다.
    // isGlyphInput은 !ctrlKey라 다른 조합을 오인하지 않고, key가 'o'라 Alt+Y/Ctrl+D 등과 충돌하지 않는다(라인삭제 조기 return보다 위).
    if (isGlyphInput(e)) {
      e.preventDefault();
      if (!isMapping) setShowGlyphInput(true);
      return;
    }
    // Alt+V → 원본 붙여넣기(클립보드 이미지). 매핑이어도 preventDefault는 하되 실행은 안 한다(Alt+O와 동일 가드 —
    // 매핑에선 onKeyDown 자체가 Editor에 전달되지 않지만 이중 방어). isPasteOriginal은 !ctrlKey라 Ctrl+V(기본 붙여넣기)와 충돌하지 않는다.
    if (isPasteOriginal(e)) {
      e.preventDefault();
      if (!isMapping) pasteOriginalAtCaret();
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
    deleteLineByBlockIndex(blockIndex); // 메뉴 'edit.deleteLine'과 공용 코어(단일 소스).
  };

  const onRemoveEmbed = (blockIndex) => {
    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const next = blocks.slice();
    next.splice(blockIndex, 1);
    commitBody(serialize(next));
  };

  // 임베드를 커서 텍스트 줄 "다음"에 삽입하고, 그 뒤 빈 줄을 만들어 커서를 그 줄로 옮긴다(news.md 156행 — 커서 위치 임베딩).
  // 캐럿이 없거나(한 번도 포커스 안 함) 매핑 모드(텍스트 잠금)면 끝("(끝)" 앞)에만 추가한다(빈 줄/커서 이동 없음 — 매핑 본문 불변식).
  // srcBody/mapping은 기본값이 렌더 클로저(body/isMapping)라 동기 호출부(검색패널 insertEmbed·URL 삽입)는
  // 동작이 그대로다. 비동기(업로드) 삽입 경로는 대기 후 stale 클로저 대신 '최신 body/탭'을 명시 전달한다.
  const insertEmbedAtLine = (embed, caretLine, srcBody = body, mapping = isMapping) => {
    if (!embed) return;
    if (mapping || caretLine == null) {
      commitBody(appendEmbedToBody(srcBody, embed));
      return;
    }
    const r = insertEmbedAfterLine(srcBody, embed, caretLine);
    commitBody(r.body);
    if (typeof r.caretTextLine === 'number') setPendingCaretLine(r.caretTextLine);
  };

  // 검색패널(이미지/영상/글기사) 픽 — 마지막 에디터 캐럿 줄에 삽입(클릭으로 포커스가 빠지므로 lastCaretRef 사용, 라이브 readCaret 금지).
  const insertEmbed = (embed) => insertEmbedAtLine(embed, lastCaretRef.current ? lastCaretRef.current.lineIndex : null);

  // Ctrl+V 이미지 붙여넣기 — Editor가 동기로 확보한 raw File을 model.uploadFile로 서버 업로드하고(ADR-003 —
  //   업로드 오케스트레이션은 view가 아니라 model 경유), 성공 시 반환 path를 image 임베드 src로 만들어 동기 캐럿
  //   줄에 삽입한다(텍스트 직렬화 없이 — news.md 156행). base64 폴백은 만들지 않는다(신규 base64 벡터 제거가 목적).
  //   성공 판정은 r && r.ok && r.path만 본다(request는 HTTP status를 안 보고 res.json()만 반환 — onFileChange와 동일 계약).
  //   실패/too-large면 삽입하지 않고 window.alert로만 안내한다(확정 정책 — 서버가 5MB를 판정, 클라 사전 검사 없음).
  const pasteImageAtCaret = async (file, caret) => {
    const tabId = activeTab.id; // 붙여넣기 시점 편집 탭 고정(업로드 대기 중 탭 전환 대비).
    let r;
    try {
      r = await model.uploadFile(file);
    } catch {
      r = null; // 전송 자체가 실패(서버 다운/네트워크/파일 읽기) — 아래 공통 실패 알림으로 합류(무피드백 방지).
    }
    if (!(r && r.ok && r.path)) {
      const msg = r && r.reason === 'too-large'
        ? '이미지가 너무 커 첨부할 수 없습니다(5MB 초과).'
        : '이미지 업로드에 실패했습니다.';
      window.alert(msg);
      return;
    }
    // 업로드(네트워크 왕복) 대기 동안 사용자가 본문을 편집했거나 다른 탭으로 이동했을 수 있다. 붙여넣기 시점
    // 렌더의 stale body/탭 클로저로 덮어쓰면 같은 탭에서는 사용자 입력이 유실되고, 탭을 옮겼으면 다른 기사의
    // 미저장 본문이 파손된다. 그래서 최신 활성 탭(activeTabRef)을 읽어 (1) 붙여넣은 탭과 동일할 때만
    // (2) 그 탭의 최신 body 위에 임베드를 얹는다(insertEmbedAtLine에 최신 body/mapping을 명시 전달).
    const current = activeTabRef.current;
    if (!current || current.id !== tabId) {
      window.alert('편집 탭이 바뀌어 이미지 삽입이 취소되었습니다.');
      return;
    }
    insertEmbedAtLine(
      makeImageEmbed(r.path, { alt: '' }),
      caret ? caret.lineIndex : null,
      current.fields.body,
      current.mode === 'mapping',
    );
  };

  // Alt+V/우클릭 '원본 붙여넣기' — keydown에서는 클립보드를 동기로 읽을 수 없어(브라우저 보안) 비동기 클립보드
  // API(navigator.clipboard.read)로 이미지를 찾아 Ctrl+V와 동일한 안전 경로(pasteImageAtCaret: 업로드→경로 임베드)로
  // 삽입한다. 캐럿은 호출 시점 lastCaretRef 스냅샷(검색패널 insertEmbed와 동일 소스 — 우클릭으로 포커스가 빠져도 유지).
  // 미지원/권한 거부/이미지 없음은 window.alert로만 안내한다(pasteImageAtCaret 실패 정책과 동일). 텍스트 붙여넣기는
  // 브라우저 기본 Ctrl+V가 담당하므로 여기서 다루지 않는다(ctx.pasteText는 여전히 placeholder).
  const pasteOriginalAtCaret = async () => {
    const caret = lastCaretRef.current;
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (!clip || typeof clip.read !== 'function') {
      window.alert('이 브라우저에서는 원본 붙여넣기를 지원하지 않습니다. Ctrl+V를 사용하세요.');
      return;
    }
    let file = null;
    try {
      const items = await clip.read();
      for (const item of items || []) {
        const type = (item.types || []).find((t) => typeof t === 'string' && t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          // 클립보드 blob은 이름이 없다 — 빈 이름 File로 감싸면 httpModel.resolveUploadFilename이 MIME으로 파일명을 합성한다.
          file = new File([blob], '', { type });
          break;
        }
      }
    } catch {
      window.alert('클립보드 읽기 권한이 거부되어 원본 붙여넣기를 할 수 없습니다.');
      return;
    }
    if (!file) {
      window.alert('클립보드에 이미지가 없습니다. 텍스트는 Ctrl+V로 붙여넣으세요.');
      return;
    }
    await pasteImageAtCaret(file, caret);
  };

  // URL 직접 입력(도구>그림/유튜브/오디오/링크/로컬영상 삽입) → 종류별 팩토리로 임베드 생성 → insertEmbed
  //   (검색패널 onPick과 동일 경로·팩토리). 매핑 가드를 두지 않는다 — insertEmbed→insertEmbedAtLine이 매핑 시
  //   "(끝)" 앞 append 폴백으로 삽입한다(검색패널과 동일). 빈/비유튜브 등 부적격 URL은 팩토리가 null →
  //   insertEmbed가 no-op(insertEmbedAtLine의 !embed 가드). URL 검증(악성 scheme)은 렌더(InlineEmbed/articleDetail) 단일 출처에 위임.
  const onUrlEmbedSubmit = (url) => {
    let embed = null;
    if (urlEmbedKind === 'image') embed = makeImageEmbed(url, { alt: '' });
    else if (urlEmbedKind === 'video') embed = makeVideoEmbed(url, { title: '' });
    else if (urlEmbedKind === 'audio') embed = makeAudioEmbed(url, { title: '' });
    else if (urlEmbedKind === 'link') embed = makeLinkEmbed(url, { title: '' });
    else if (urlEmbedKind === 'localVideo') embed = makeLocalVideoEmbed(url, { title: '' });
    insertEmbed(embed); // embed falsy면 no-op. 매핑 시엔 "(끝)" 앞 append 폴백.
    setUrlEmbedKind(null); // 1회성 삽입 후 닫는다(URL 1개).
  };

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
          {/* 메뉴바/툴바는 기본 숨김 — 우클릭 컨텍스트 메뉴 '메뉴바/툴바 보이기'(ctx.showMenuBar/ctx.showToolBar)로만 토글한다(news.md L173).
              구 전용 토글 버튼(yh-editor-chrome-bar)은 제거됨. */}
          {showMenuBar && <EditorMenuBar onSelect={onMenuSelect} enabledIds={MENU_ENABLED} />}
          {showToolBar && <EditorToolBar />}
          {/* 약물바 — 우클릭 '약물바 보이기' 토글로 켜짐(showMenuBar/showToolBar와 동일 배치). 매핑 모드(텍스트 잠금)에서는
              본문-only 불변식을 위해 바 자체를 미렌더한다(onGlyphPick의 isMapping no-op과 이중 방어). */}
          {showGlyphBar && !isMapping && <EditorGlyphBar items={glyphFavorites} onPick={onGlyphPick} />}
          {/* 바탕색 전용 캔버스 래퍼 — Editor만 감싸 배경을 입힌다(메뉴바/툴바/상태바는 칠하지 않음).
              에디터 본문 우클릭 → 브라우저 기본 메뉴 대신 커스텀 컨텍스트 메뉴(EditorContextMenu)를 좌표에 띄운다(ListPage 패턴). */}
          <div
            className="yh-writer__canvas"
            data-testid="editor-canvas"
            style={{
              backgroundColor: editorBg,
              // 컬럼제한 on → 에디터 캔버스 좌우 여백 10%씩(위/아래는 불변). 래퍼 레벨이라 Editor 내부 미접촉.
              ...(columnLimit ? { paddingLeft: '10%', paddingRight: '10%' } : null),
            }}
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
              onPasteImageFile={pasteImageAtCaret}
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
              <CommonInfo tab={activeTab} updateField={updateField} model={model} readOnly={isMapping} activeTabRef={activeTabRef} />
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

      {/* 약물입력 다이얼로그 — Alt+O·도구 메뉴·우클릭으로 열림(매핑에서는 안 열림). 약물 선택은 약물바와 동일한
          onGlyphPick 안전 경로(updateField+serialize)로 캐럿 위치에 삽입한다. keymap은 참조 표시만(키조합 인터셉트 없음).
          약물 선택 후 닫지 않는다(연속 삽입 — Step 3 컴포넌트 닫기 정책과 일치, 닫기는 닫기 버튼/Esc). */}
      <GlyphInputDialog
        open={showGlyphInput}
        favorites={glyphFavorites}
        keymap={glyphKeymap}
        onPick={onGlyphPick}
        onClose={() => setShowGlyphInput(false)}
      />

      {/* URL 직접 임베드 다이얼로그 — 도구>그림/유튜브 삽입으로 열림(매핑에서도 허용). URL 제출 시 make*Embed+insertEmbed
          (검색패널과 동일 경로)로 캐럿 줄 뒤에 임베드를 삽입한다. 유튜브 아닌 URL은 makeVideoEmbed가 null → no-op. */}
      <UrlEmbedDialog
        open={urlEmbedKind !== null}
        kind={urlEmbedKind || 'image'}
        onSubmit={onUrlEmbedSubmit}
        onClose={() => setUrlEmbedKind(null)}
      />

      {/* 파일 정보 다이얼로그(도구>파일 정보) — 읽기전용. 열린 시점 본문 통계(fileInfoStats)를 props로만 주입해 표시한다.
          본문/캐럿/임베드를 바꾸지 않으므로 매핑 모드에서도 안전하다(매핑 가드 앞 결선). 닫기/Esc는 컴포넌트 onClose. */}
      <FileInfoDialog
        open={showFileInfo}
        stats={fileInfoStats}
        onClose={() => setShowFileInfo(false)}
      />

      {/* 메모장(도구>메모장) — 기사와 무관한 전역 스크래치패드. controlled: 값은 memoText(부모 소유·마운트 lazy-init),
          '저장'만 localStorage 영속(saveMemo), 닫기/Esc는 닫기만(자동 저장 없음). 본문/캐럿/임베드 무변경 → 매핑에서도 안전. */}
      <MemoDialog
        open={showMemo}
        value={memoText}
        onChange={setMemoText}
        onSave={() => saveMemo(memoText)}
        onClose={() => setShowMemo(false)}
      />

      {/* 약어 관리(도구>약어관리) — controlled: 커밋 목록은 abbrevs(부모 소유·마운트 lazy-init), onAdd/onRemove가 즉시
          saveAbbrevs로 localStorage 영속. 본문/캐럿/임베드 무변경 → 매핑에서도 안전(매핑 가드 앞 결선). */}
      <AbbrevManageDialog
        open={showAbbrevManage}
        items={abbrevs}
        onAdd={addAbbrev}
        onRemove={removeAbbrev}
        onClose={() => setShowAbbrevManage(false)}
      />

      {/* 간체↔번체 변환(도구>간체↔번체 변환) — 방향 선택 다이얼로그. 버튼 클릭 시 applySimpTrad(direction)이
          convertSimpTradInBlocks + commitBody(serialize(...)) 안전 경로로 본문을 변환하고 닫는다.
          본문 변경이므로 매핑 가드 뒤 결선(매핑에선 메뉴가 다이얼로그를 열지 않음 — 약어변환과 동일 정책). */}
      <SimpTradConvertDialog
        open={showSimpTrad}
        onConvert={applySimpTrad}
        onClose={() => setShowSimpTrad(false)}
      />

      {/* 기사 이력 비교(도구>기사이력비교) — 읽기전용. 열 때 스냅샷 이력 목록을 entries로 주입하고, 좌/우 선택 시
          getHistorySnapshot 지연 조회 결과를 텍스트로만 주입한다(View는 transport 미호출 — ADR-003).
          본문/캐럿/임베드 무변경 → 매핑에서도 안전(매핑 가드 앞 결선 — 파일 정보와 동일 정책). */}
      <HistoryCompareDialog
        open={showHistoryCompare}
        entries={historyCompareEntries}
        leftKey={histLeftKey}
        rightKey={histRightKey}
        leftText={histLeftText}
        rightText={histRightText}
        onSelectLeft={(key) => selectCompareTarget('left', key)}
        onSelectRight={(key) => selectCompareTarget('right', key)}
        onClose={() => setShowHistoryCompare(false)}
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
function CommonInfo({ tab, updateField, model, readOnly = false, activeTabRef }) {
  const f = tab.fields;
  const ro = tab.readOnly || {};

  // 첨부/자료파일 — 선택 즉시 업로드(model.uploadFile) → 성공 시 반환 path를 해당 필드에 보관.
  // updateField는 항상 '현재 활성 탭'에 쓰므로, 업로드(네트워크 왕복) 대기 중 탭을 바꾸면 응답이 다른 기사에
  // 오기록되고 원래 기사는 첨부를 잃는다. 그래서 선택 시점 탭 id를 고정하고(렌더 스냅샷 tab.id), 응답 도착 시
  // 최신 활성 탭(activeTabRef)과 동일할 때만 반영한다(pasteImageAtCaret의 탭 고정 가드와 동형).
  const onFileChange = async (field, e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const tabId = tab.id; // 선택 시점 편집 탭 고정(업로드 대기 중 탭 전환 대비).
    const r = await model.uploadFile(file);
    if (!(r && r.ok && r.path)) return;
    const current = activeTabRef.current;
    if (!current || current.id !== tabId) {
      window.alert('편집 탭이 바뀌어 파일 첨부가 취소되었습니다.');
      return;
    }
    updateField(field, r.path);
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

        {/* 첨부파일/자료파일 — 실제 업로드. 저장된 path는 링크로 보여주고 지우기 버튼을 제공한다.
            href는 DB 원본값이라 isAllowedHref(phase 19 단일 출처)로 검증 — 비허용 값(javascript: 등)은
            클릭 가능한 링크 대신 텍스트로만 표시한다(저장형 XSS 클릭 유발 차단). */}
        <div className="yh-field yh-field--wide">
          <label htmlFor="meta-attachment">첨부파일</label>
          <input id="meta-attachment" type="file" disabled={readOnly} onChange={(e) => onFileChange('attachmentFile', e)} />
          {f.attachmentFile && (
            <span className="yh-file-saved">
              {isAllowedHref(f.attachmentFile)
                ? <a href={f.attachmentFile}>{f.attachmentFile}</a>
                : <span>{f.attachmentFile}</span>}
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
              {isAllowedHref(f.referenceFile)
                ? <a href={f.referenceFile}>{f.referenceFile}</a>
                : <span>{f.referenceFile}</span>}
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
