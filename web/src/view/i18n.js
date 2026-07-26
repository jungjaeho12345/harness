// 에디터 UI 언어(ko/en) 문자열 카탈로그 + 번역 헬퍼 — 순수 모듈(React/DOM/localStorage 무관).
// 키 = EditorMenuBar.jsx의 EDITOR_MENUS가 이미 가진 안정 id(예: 'file', 'file.new', 'tools.uiLanguage')를 재사용한다.
//   → Step 2에서 t(item.id, item.label) 한 줄로 결선된다. t 주입 + lang='ko'면 반환값은 MESSAGES.ko[id](카탈로그 값)이지
//     fallback(원문 label)이 아니다 → ko 바이트 동일은 "카탈로그 값 === 라벨" 일치에 의존하며 i18n.test.js가 이를 강제한다.
//     fallback(item.label=ko 원문)은 t 미주입 시의 이차 보장일 뿐이다.
// ko 값은 EDITOR_MENUS의 라벨과 바이트 동일해야 한다(이 phase 최상위 불변식). i18n.test.js가 강제한다.
// 지원 UI 언어는 ko/en 2종뿐. news.md L196의 문서 언어 9종(editorPrefs.edit.language)과는 별개 개념이다.

// 지원 UI 언어 목록.
export const UI_LANGUAGES = Object.freeze(['ko', 'en']);

// 한국어(ko) — 메뉴/항목 값은 EDITOR_MENUS 라벨과 바이트 동일(정답지: EditorMenuBar.jsx L9-112).
const KO = {
  // 파일
  file: '파일',
  'file.new': '새문서',
  'file.open': '문서열기',
  'file.save': '저장',
  'file.saveAs': '다른이름으로 저장',
  'file.recover': '복구',
  'file.print': '인쇄',
  'file.printPreview': '인쇄미리보기',
  'file.close': '닫기',
  // 편집
  edit: '편집',
  'edit.undo': '되돌리기',
  'edit.redo': '다시실행',
  'edit.cut': '잘라내기',
  'edit.copy': '복사',
  'edit.paste': '붙여넣기',
  'edit.pasteOriginal': '원본 붙여넣기',
  'edit.pasteText': '텍스트 붙여넣기',
  'edit.findReplace': '찾기/바꾸기',
  'edit.selectAll': '전체 선택',
  'edit.selectParagraph': '문단 선택',
  'edit.selectLine': '한줄 선택',
  'edit.selectWord': '단어 선택',
  'edit.sortDocument': '문서 정렬',
  'edit.sortParagraph': '문단 정렬',
  'edit.deleteLine': '한줄 지우기',
  'edit.deleteWord': '단어 지우기',
  'edit.insertEnd': '(끝)삽입',
  'edit.insertContinue': '(계속)삽입',
  // 보기
  view: '보기',
  'view.toUpper': '대문자로 바꾸기',
  'view.toLower': '소문자로 바꾸기',
  'view.capitalize': '첫글자 대문자로',
  'view.toggleCase': '대/소문자 전환',
  'view.justify': '양쪽으로 정렬',
  'view.alignLeft': '왼쪽으로 정렬',
  'view.alignCenter': '가운데로 정렬',
  'view.alignRight': '오른쪽으로 정렬',
  // 맞춤법
  spell: '맞춤법',
  'spell.checkAll': '통합 맞춤법 검사',
  'spell.checkParagraph': '문단식 검사',
  'spell.checkToCaret': '현재위치까지 검사',
  'spell.checkFromCaret': '현재위치부터 검사',
  'spell.checkOff': '통합 맞춤법 검사 안함',
  // 표
  table: '표',
  'table.insert': '표 삽입',
  'table.delete': '표 삭제',
  'table.copy': '표 복사',
  'table.cut': '표 잘라내기',
  'table.deleteRow': '행 삭제',
  'table.deleteCol': '열 삭제',
  'table.addRowAbove': '위에 행 추가',
  'table.addRowBelow': '아래에 행 추가',
  'table.addColLeft': '왼쪽에 열 추가',
  'table.addColRight': '오른쪽에 열 추가',
  // 도구
  tools: '도구',
  'tools.abbrConvert': '약어변환',
  'tools.abbrManage': '약어관리',
  'tools.symbolInput': '약물 입력',
  'tools.insertDate': '날짜 삽입',
  'tools.fileInfo': '파일 정보',
  'tools.insertImage': '그림 삽입',
  'tools.insertLink': '링크 삽입',
  'tools.insertYoutube': '유튜브 영상 삽입',
  'tools.insertLocalVideo': '로컬영상 삽입',
  'tools.insertAudio': '오디오 삽입',
  'tools.publishPhoto': '사진발행/DB등록',
  'tools.historyCompare': '기사이력비교',
  'tools.simpTradConvert': '간체↔번체 변환',
  'tools.memo': '메모장',
  'tools.uiLanguage': 'UI 언어 설정',
  // 도움말
  help: '도움말',
  'help.open': '도움말 열기',
  'help.about': '에디터 정보',
  'help.preferences': '환경설정',
  // 도움말 열기/에디터 정보 다이얼로그 본문 전용(메뉴 라벨 아님 — ko/en 대칭 + 비어있지 않음만 강제)
  'help.dialog.shortcutsTitle': '단축키',
  'help.dialog.overwrite': '삽입/수정 모드 전환',
  'help.dialog.companyCode': '기업코드 변환',
  'help.dialog.nameLabel': '이름',
  'help.dialog.appName': '기사 작성기',
  'help.dialog.versionLabel': '버전',
  // UI 언어 다이얼로그 전용 + 공용
  'ui.dialog.title': 'UI 언어 설정',
  'ui.dialog.ko': '한국어',
  'ui.dialog.en': '영어',
  'common.close': '닫기',
};

// 영어(en) — ko와 동일한 키 집합의 대응 영문.
const EN = {
  // File
  file: 'File',
  'file.new': 'New',
  'file.open': 'Open',
  'file.save': 'Save',
  'file.saveAs': 'Save As',
  'file.recover': 'Recover',
  'file.print': 'Print',
  'file.printPreview': 'Print Preview',
  'file.close': 'Close',
  // Edit
  edit: 'Edit',
  'edit.undo': 'Undo',
  'edit.redo': 'Redo',
  'edit.cut': 'Cut',
  'edit.copy': 'Copy',
  'edit.paste': 'Paste',
  'edit.pasteOriginal': 'Paste Original',
  'edit.pasteText': 'Paste as Text',
  'edit.findReplace': 'Find/Replace',
  'edit.selectAll': 'Select All',
  'edit.selectParagraph': 'Select Paragraph',
  'edit.selectLine': 'Select Line',
  'edit.selectWord': 'Select Word',
  'edit.sortDocument': 'Sort Document',
  'edit.sortParagraph': 'Sort Paragraph',
  'edit.deleteLine': 'Delete Line',
  'edit.deleteWord': 'Delete Word',
  'edit.insertEnd': 'Insert (End)',
  'edit.insertContinue': 'Insert (Continue)',
  // View
  view: 'View',
  'view.toUpper': 'To Uppercase',
  'view.toLower': 'To Lowercase',
  'view.capitalize': 'Capitalize First Letter',
  'view.toggleCase': 'Toggle Case',
  'view.justify': 'Justify',
  'view.alignLeft': 'Align Left',
  'view.alignCenter': 'Align Center',
  'view.alignRight': 'Align Right',
  // Spelling
  spell: 'Spelling',
  'spell.checkAll': 'Full Spell Check',
  'spell.checkParagraph': 'Paragraph Check',
  'spell.checkToCaret': 'Check Up to Cursor',
  'spell.checkFromCaret': 'Check From Cursor',
  'spell.checkOff': 'Turn Off Spell Check',
  // Table
  table: 'Table',
  'table.insert': 'Insert Table',
  'table.delete': 'Delete Table',
  'table.copy': 'Copy Table',
  'table.cut': 'Cut Table',
  'table.deleteRow': 'Delete Row',
  'table.deleteCol': 'Delete Column',
  'table.addRowAbove': 'Add Row Above',
  'table.addRowBelow': 'Add Row Below',
  'table.addColLeft': 'Add Column Left',
  'table.addColRight': 'Add Column Right',
  // Tools
  tools: 'Tools',
  'tools.abbrConvert': 'Convert Abbreviation',
  'tools.abbrManage': 'Manage Abbreviations',
  'tools.symbolInput': 'Insert Symbol',
  'tools.insertDate': 'Insert Date',
  'tools.fileInfo': 'File Info',
  'tools.insertImage': 'Insert Image',
  'tools.insertLink': 'Insert Link',
  'tools.insertYoutube': 'Insert YouTube Video',
  'tools.insertLocalVideo': 'Insert Local Video',
  'tools.insertAudio': 'Insert Audio',
  'tools.publishPhoto': 'Publish Photo / Register DB',
  'tools.historyCompare': 'Compare Article History',
  'tools.simpTradConvert': 'Simplified↔Traditional Conversion',
  'tools.memo': 'Memo',
  'tools.uiLanguage': 'UI Language',
  // Help
  help: 'Help',
  'help.open': 'Open Help',
  'help.about': 'About Editor',
  'help.preferences': 'Preferences',
  // Open Help / About Editor dialog body (not menu labels — only ko/en symmetry + non-empty enforced)
  'help.dialog.shortcutsTitle': 'Keyboard Shortcuts',
  'help.dialog.overwrite': 'Toggle Insert/Overwrite Mode',
  'help.dialog.companyCode': 'Convert Company Code',
  'help.dialog.nameLabel': 'Name',
  'help.dialog.appName': 'Article Writer',
  'help.dialog.versionLabel': 'Version',
  // UI language dialog + common
  'ui.dialog.title': 'UI Language',
  'ui.dialog.ko': 'Korean',
  'ui.dialog.en': 'English',
  'common.close': 'Close',
};

// 문자열 카탈로그 — { ko, en } 각 테이블 frozen.
export const MESSAGES = Object.freeze({ ko: Object.freeze(KO), en: Object.freeze(EN) });

// createTranslator(lang) → (key, fallback?) => string
// 폴백 사슬: 현재 테이블 → fallback → MESSAGES.ko[key] → key.
// lang이 MESSAGES에 없으면(미지원) ko 테이블을 사용한다. → lang='ko'/미지원/미등록 키는 항상 원문·폴백으로 안전 저하.
export function createTranslator(lang) {
  const table = MESSAGES[lang] || MESSAGES.ko;
  const has = (t, key) => Object.prototype.hasOwnProperty.call(t, key);
  return (key, fallback) => {
    if (has(table, key)) return table[key];
    if (fallback !== undefined) return fallback;
    if (has(MESSAGES.ko, key)) return MESSAGES.ko[key];
    return key;
  };
}
