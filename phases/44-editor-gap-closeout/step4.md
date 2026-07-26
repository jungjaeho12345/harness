# Step 4: help-dialogs

## 목표

도움말 메뉴의 **'도움말 열기'(help.open)·'에디터 정보'(help.about)**를 결선한다 — 각각 읽기전용 다이얼로그를 연다. '도움말 열기'=단축키/기능 안내, '에디터 정보'=이름·버전 등 정적 정보. 현재 두 항목은 `MENU_ENABLED`에 없어 비활성 placeholder다. 신규 컴포넌트 2종 + `WriterPage` 결선 + `MENU_ENABLED` 추가 + i18n 카탈로그 additive.

## 읽어야 할 파일

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — 순수 컴포넌트, transport 무관).
- `web/src/view/FileInfoDialog.jsx` — **동형 패턴의 권위 출처(전체 94줄)**. 읽기전용 순수 컴포넌트: `useFocusOnOpen(closeRef, open)`, `if (!open) return null;`, 루트 `className="yh-editor-dialog yh-file-info"` + `role="dialog"` + `aria-label` + `data-testid` + `onKeyDown`(Esc→onClose), `<h2>` 제목, 닫기 버튼(`yh-btn yh-btn--primary`, closeRef). **onSubmit/입력 폼 없음**(읽기전용). model/localStorage/Date import 없음.
- `web/src/view/FileInfoDialog.test.jsx` — 읽기전용 다이얼로그 테스트 스타일(신규 2종을 동형으로).
- `web/src/view/useFocusOnOpen.js` — 열림 시 focusable 요소(닫기 버튼)로 포커스 이전(전체 15줄).
- `web/src/view/EditorMenuBar.jsx` — **L104~111 help 메뉴**(`help.open`='도움말 열기', `help.about`='에디터 정보', `help.preferences`='환경설정'). L116~121 `t` 폴백(`tr = t || ((k,f)=>f)`), L172 `disabled={!enabledSet.has(item.id)}`.
- `web/src/view/i18n.js` — **L88~92 도움말 ko**(`help.open`:'도움말 열기', `help.about`:'에디터 정보'), L180~184 도움말 en(`'Open Help'`/`'About Editor'`), L93~99 `ui.dialog.*`/`common.*` 전용 키(신규 다이얼로그 키를 이 스타일로 추가). L200~209 `createTranslator`(폴백 사슬).
- `web/src/view/i18n.test.js` — **L32~39(en 키집합 === ko 키집합, 누락/잉여 없음)** — 신규 키는 반드시 ko/en 양쪽 추가. L25~29(ko 메뉴 라벨 === EDITOR_MENUS 라벨 — help.open/help.about 라벨은 불변이라 통과 유지). L48~57(전용 키 존재 단언 — 신규 키에 동형 단언 추가).
- `web/src/view/WriterPage.jsx` — 특히:
  - **L112 `MENU_ENABLED`**(현재 `'help.preferences'`만 포함 — 여기에 `'help.open'`, `'help.about'` 추가).
  - L167~168(`showFileInfo` boolean 토글 state 선례 — 신규 boolean state 2개 동형), L235~238(`t = useMemo(() => createTranslator(uiLanguage), [uiLanguage])` — 다이얼로그에 `t` 주입 소스).
  - **L788~812 `onMenuSelect`**(매핑 가드 앞 결선 — `help.preferences`(L790)·`tools.fileInfo`(L800)·`tools.memo`(L802) 패턴). help.open/help.about도 본문 무관 읽기 액션이라 매핑 가드 앞에 결선.
  - L1570~1634 다이얼로그 렌더 구역(`EditorPrefsDialog`·`FileInfoDialog` 등 controlled 렌더 — 신규 2종을 동형으로 추가).
- `web/src/view/WriterPage.test.jsx` — L4271 근처("도구 '파일 정보'가 활성이다(MENU_ENABLED)") 및 파일 정보 다이얼로그 열림/닫힘 테스트 스타일(신규 2종을 동형으로).
- `web/src/styles/yonhap.css` — L872~914(`yh-editor-dialog` — 중앙 모달 + `<h2>` 브랜드 룰. 신규 다이얼로그가 재사용). 필요 시 최소 content 클래스만 추가.

## 배경 (자기완결)

### §회귀 가드 grep 결과 (전수 확인 — 완료)

`help.open`/`help.about`/'도움말 열기'/'에디터 정보'를 **비활성으로 단언하는 기존 테스트는 없다**(전수 grep 완료):
- `EditorMenuBar.test.jsx`의 `toBeDisabled` 단언 대상은 '새문서'(L59)·'인쇄'(L60)·'(끝)삽입'(L125)·'(계속)삽입'(L126)뿐 — help 항목 없음.
- `WriterPage.test.jsx`에 help.open/help.about disabled 단언 없음(help 관련은 '도움말>환경설정'=help.preferences뿐).
- `i18n.js`에 help.open/help.about 라벨이 이미 ko/en 존재(L90~91, L182~183).

→ `MENU_ENABLED`에 두 id를 추가해도 기존 disabled 테스트를 깨지 않는다. **구현자는 이 grep을 재확인**(phase 42 검토 게이트가 과소집계를 반려한 전례 — `toBeDisabled`를 label/id로 재-grep)한 뒤, `EditorMenuBar.test.jsx`에 두 항목이 이제 **활성**임을 단언하는 테스트를 추가하라.

### §i18n 정책 (못박음)

- 다이얼로그 **제목**은 기존 키 재사용: `t('help.open', '도움말 열기')`·`t('help.about', '에디터 정보')`(ko 바이트 동일은 `i18n.test.js` L25~29가 이미 강제).
- 다이얼로그 **본문 정적 텍스트**는 신규 i18n 키(ko/en 양쪽)로 추가한다. `i18n.test.js` L32~39가 ko/en 키집합 동일을 강제하므로 **양쪽에 반드시 추가**(누락 시 실패). 키 예: `help.dialog.aboutBody`(에디터 정보 본문), `help.dialog.shortcutsTitle`(단축키 섹션 제목) 등 — **키 이름·개수는 재량**이되 최소·ko/en 대칭. ko 값은 자연스러운 한국어, en은 대응 영문(비어있지 않은 문자열 — L41~46 강제).
- 신규 키는 **메뉴 라벨이 아니므로** `MESSAGES.ko[id]===label` 불변식(메뉴 전용, L25~29) 대상이 아니다 — ko/en 대칭 + 비어있지 않음만 만족하면 된다.

## TDD — 테스트 먼저

`web/src/view/HelpDialog.test.jsx`(신규) + `web/src/view/AboutDialog.test.jsx`(신규) — FileInfoDialog.test.jsx 동형:
- `open=false` → 렌더 없음(`queryByTestId` null).
- `open=true` → `role="dialog"` + 지정 `data-testid` 렌더, 제목·본문 텍스트 표시.
- 닫기 버튼 클릭 → `onClose` 호출. Esc keydown → `onClose` 호출.
- `t` 미전달 시에도 ko 폴백으로 렌더(FileInfoDialog는 `t` 미사용 하드코딩이나, 이 phase는 `t` 주입 — `t` 없으면 fallback 인자로 ko 표시).

`web/src/view/i18n.test.js`:
- 신규 다이얼로그 키가 ko/en 양쪽에 존재(L48~57 동형 단언). (L32~39 키집합 동일 테스트는 자동 커버 — 확인.)

`web/src/view/EditorMenuBar.test.jsx`:
- `enabledIds=['help.open','help.about']`면 도움말 드롭다운에서 '도움말 열기'·'에디터 정보'가 **활성**·클릭 시 `onSelect(id)` 호출(L129~134 동형).

`web/src/view/WriterPage.test.jsx`(신규 describe):
- 도움말 메뉴에서 '도움말 열기' 클릭 → HelpDialog 열림(`data-testid` 존재); 닫기/Esc로 닫힘.
- 도움말 메뉴에서 '에디터 정보' 클릭 → AboutDialog 열림; 닫힘.
- (선택) 매핑 모드에서도 열린다(읽기전용·매핑 가드 앞 — 죽은 버튼 방지, 파일 정보와 동일 정책).

## 작업 (구현 상세)

### 1. 신규 `web/src/view/HelpDialog.jsx` (도움말 열기 — 읽기전용)
- FileInfoDialog 동형: `HelpDialog({ open, t, onClose })`. `useFocusOnOpen(closeRef, open)`, `if (!open) return null;`.
- 루트 `className="yh-editor-dialog yh-editor-help"`, `role="dialog"`, `aria-label`(제목), `data-testid="help-dialog"`, `onKeyDown`(Esc→onClose).
- `<h2>{tr('help.open', '도움말 열기')}</h2>` + 본문: 단축키/기능 안내(정적). 단축키 목록은 news.md·기존 predicate에 있는 조합(Alt+Y "(끝)"·Ctrl+Y "(계속)"·Ctrl+D 한줄삭제·Ctrl+F 찾기·Alt+O 약물입력·Ctrl+Z/Ctrl+Shift+Z undo/redo·Insert 삽입/수정 등)을 정적 리스트로. 텍스트는 i18n 키 경유(또는 fallback 인자로 ko). **입력 폼/onSubmit 없음.**
- 닫기 버튼(`yh-btn yh-btn--primary`, `data-testid="help-dialog-close"`, closeRef, `tr('common.close','닫기')`).
- `tr = t || ((k, f) => f)`(EditorMenuBar L121 폴백 관례). model/localStorage/Date/window import 금지.

### 2. 신규 `web/src/view/AboutDialog.jsx` (에디터 정보 — 읽기전용)
- HelpDialog 동형. `AboutDialog({ open, t, onClose })`, 루트 `className="yh-editor-dialog yh-editor-about"`, `data-testid="about-dialog"`.
- `<h2>{tr('help.about','에디터 정보')}</h2>` + 본문: 에디터 이름(예: '기사 작성기')·버전 등 **정적** 정보. 버전 등 값은 컴포넌트 내 상수/props로(Date/외부 조회 금지). i18n 경유.

### 3. `web/src/view/i18n.js`
- ko/en 도움말 섹션(L88~92, L180~184)에 다이얼로그 본문 키 additive 추가(§i18n 정책). **양쪽 대칭.**

### 4. `web/src/view/WriterPage.jsx`
- L112 `MENU_ENABLED`에 `'help.open'`, `'help.about'` 추가(기존 배열에 문자열 2개 — 다른 항목 불변).
- boolean state 2개(`showFileInfo` L167 선례): `const [showHelp, setShowHelp] = useState(false);` + `showAbout`.
- `onMenuSelect`(L788~812)에 **매핑 가드 앞** 결선(help.preferences 형제):
  ```js
  if (id === 'help.open') { setShowHelp(true); return; }
  if (id === 'help.about') { setShowAbout(true); return; }
  ```
- 다이얼로그 렌더 구역(L1570~)에 controlled 추가:
  ```jsx
  <HelpDialog open={showHelp} t={t} onClose={() => setShowHelp(false)} />
  <AboutDialog open={showAbout} t={t} onClose={() => setShowAbout(false)} />
  ```
- import 2개 추가.

### 5. `web/src/styles/yonhap.css`(필요 시만)
- 두 다이얼로그는 `yh-editor-dialog`(중앙 모달 + h2 브랜드 룰)를 재사용하므로 **신규 CSS는 최소**. 본문 리스트 여백 등 꼭 필요한 content 스타일만 `yh-editor-help`/`yh-editor-about`로 추가(diff 최소). 불필요하면 CSS 미변경.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(client 전용 — 백엔드/DB 무관. `npm test` 불필요.)

## 회귀 가드 / 불변식

- **grep 전수**: 구현 전 `toBeDisabled` × help.open/help.about/'도움말 열기'/'에디터 정보'를 재-grep해 비활성 단언이 없음을 재확인(phase 42 과소집계 반려 전례). 결과를 summary에 기록.
- **ko 바이트 동일**: help.open/help.about 라벨·i18n ko 값 불변(`i18n.test.js` L25~29 통과). 신규 키는 ko/en 대칭 + 비어있지 않음(L32~46).
- **읽기전용**: 두 다이얼로그는 본문/캐럿/임베드/model을 건드리지 않는다(순수 표시, onSubmit 없음). 매핑 가드 앞 결선(죽은 버튼 방지 — 파일 정보/메모/환경설정 정책).
- **다이얼로그 규약**: `yh-editor-dialog` 공용 클래스 + 전용 클래스, controlled(props open/onClose), `useFocusOnOpen`(닫기 버튼), Esc 닫기 — 기존 다이얼로그와 동형(PR#60).
- 기존 EditorMenuBar/WriterPage 테스트 그린 유지.

## 커밋 계획

- **feat**: `feat(44-editor-gap-closeout): step4 — 도움말 열기·에디터 정보 결선(HelpDialog·AboutDialog 읽기전용 다이얼로그 + MENU_ENABLED + i18n additive)` — `HelpDialog.jsx`·`AboutDialog.jsx`·`i18n.js`·`WriterPage.jsx`(+필요 시 `yonhap.css`) + 신규/갱신 테스트.
- **chore**: `chore(44-editor-gap-closeout): step4 status — completed` — index.json step4.

## 금지사항

- 다이얼로그에 입력 폼/onSubmit/model 호출을 넣지 마라. 이유: 읽기전용 안내/정보 표시다 — 본문/서버를 건드리면 규약 위반이고 회귀 표면이 커진다.
- 신규 i18n 키를 ko 또는 en 한쪽에만 추가하지 마라. 이유: `i18n.test.js` L32~39가 ko/en 키집합 동일을 강제해 실패한다.
- help.open/help.about 라벨(EditorMenuBar/i18n ko)을 바꾸지 마라. 이유: `MESSAGES.ko[id]===label` 불변식(L25~29)이 깨진다.
- AboutDialog에서 `Date`/버전 동적 조회/외부 fetch를 하지 마라. 이유: 순수 컴포넌트(ADR-003) — 정보는 정적 상수/props로.
- help.open/help.about 결선을 매핑 가드 뒤에 두지 마라. 이유: 읽기전용이라 매핑에서도 열려야 죽은 버튼이 안 된다(help.preferences/tools.fileInfo/tools.memo 정책).
- `useFocusOnOpen` ref를 액션 버튼이 아닌 bare div에 달지 마라(닫기 버튼에). 이유: focus()가 activeElement를 못 바꾸면 Esc 닫기가 발화 안 하고 타이핑이 본문에 샌다(useFocusOnOpen 주석).
- 기존 테스트를 깨뜨리지 마라.
