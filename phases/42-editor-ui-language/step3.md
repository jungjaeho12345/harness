# Step 3: writer-wiring

## 목표
`web/src/view/WriterPage.jsx`(Controller)에서 UI 언어 기능을 **결선·영속·재접속 유지**한다. 도구 메뉴 "UI 언어 설정"을 활성화하고, 클릭 시 Step 1 다이얼로그를 열고, 선택을 localStorage(editorPrefs)에 저장하며, 선택 언어를 메뉴바(Step 2)와 다이얼로그(Step 1)에 실시간 반영한다. 이 step으로 **도구 메뉴 전 항목 결선이 완결**된다. 이 step은 `WriterPage.jsx`(+테스트) 하나만 수정한다.

## 배경 / 설계 의도
- 결선 패턴은 기존 도구 메뉴 결선과 **동일**하다: `MENU_ENABLED`에 id 추가 → `onMenuSelect(id)` 분기 → 표시 state → 기존 다이얼로그들 옆에 컴포넌트 배치. `tools.memo`/`tools.publishPhoto` 선례를 그대로 따른다.
- **영속·재접속 유지**는 신규 인프라가 아니라 기존 prefs 패턴 재사용이다. `columnLimit`/`language`(문서언어)/`autosaveCfg`가 하는 것과 **완전히 동형**으로: 마운트 lazy-init(`loadEditorPrefs().ui.language`) + 마운트 useEffect에서 재적용(새로고침/재접속 반영) + `onPrefsClose(applied)` 패리티. 저장은 `saveEditorPrefs(setEditorPref(loadEditorPrefs(), 'ui', { language }))`. **localStorage는 새로고침·재로그인(같은 브라우저)에도 유지되므로 "재접속 시 유지" 요구가 자동 충족**된다 — 서버/DB 불필요.
- **실시간 반영(리렌더 경로)**: 선택 언어를 `uiLanguage` state로 들고, `const t = createTranslator(uiLanguage)`(useMemo)로 번역기를 만들어 `<EditorMenuBar t={t}>`와 `<UiLanguageDialog t={t}>` **양쪽에 같은 번역기를 주입**한다. `uiLanguage`가 바뀌면 `WriterPage`가 리렌더 → 열려 있는 메뉴바·다이얼로그가 **함께** 새 언어로 갱신된다(일관성 — 함정 노트: 열린 다이얼로그/메뉴/툴바에 일관 반영).
- **함정 반영 — 비모달 탭 전환**: UI 언어 다이얼로그는 비모달이고, `uiLanguage`는 전역(탭-로컬 좌표 아님)이라 phase 29~32식 좌표 stale은 없다. 그러나 지침대로 **탭 전환 시 닫는다** — 기존 탭 전환 조정 블록(caretTabId 리셋, `setShowPhotoPublish(false)`가 있는 곳)에 `setShowUiLanguage(false)` 한 줄을 추가한다(열린 채 이월되는 혼란 방지).
- **함정 반영 — async 후 activeTabRef**: UI 언어 저장은 **동기 localStorage**(`saveEditorPrefs`)라 async가 아니다. 따라서 저장 후 `activeTabRef` 재파생은 불필요하다. (주의: 향후 서버 저장으로 바꾸면 `await` 뒤 `activeTabRef.current`를 재파생해 쓸 것 — phase 20·36 교훈. 지금은 sync라 해당 없음.)
- **본문 무관**: UI 언어는 크롬 설정이라 본문/캐럿/임베드/제목을 건드리지 않는다. `commitBody`/`serialize`/`updateField`/`insertEmbed`를 호출하지 마라. 따라서 매핑 모드에서도 열려야 한다 → `onMenuSelect` 분기를 **매핑 가드(`if (isMapping) return;`)보다 앞**에 둔다(`help.preferences`·`tools.fileInfo`·`tools.memo`와 동일 정책, 죽은 버튼 방지).

## 읽어야 할 파일
- `docs/news.md` L186(도구 메뉴), `docs/ARCHITECTURE.md`(프론트 MVC·상태 관리), `docs/ADR.md`(ADR-003·ADR-004)
- `web/src/view/WriterPage.jsx` — 다음 지점을 확인:
  - L43 `import { loadEditorPrefs, normalizeLineSpacing } from './editorPrefs.js';`(여기에 `saveEditorPrefs`, `setEditorPref` import 추가 필요)
  - L108 `MENU_ENABLED` 배열(여기에 `'tools.uiLanguage'` 추가)
  - L167 `const [showPhotoPublish, setShowPhotoPublish]`, L169 `const [showMemo, setShowMemo]`(표시 state 선언 패턴)
  - L205-251 prefs state 블록(`columnLimit`/`language`/`autosaveCfg` lazy-init·마운트 useEffect L227-235·`onPrefsClose` L239-251) — `uiLanguage`를 **동형으로** 추가할 자리
  - L254 `const isMapping = ...`, L728-756 `onMenuSelect`(매핑 가드 앞 분기 지점 — `tools.memo` L742·`tools.publishPhoto` L749 근처)
  - L261-285 탭 전환 조정 블록(`if (caretTabId !== activeTabId) { ... setShowPhotoPublish(false); }`) — 여기에 `setShowUiLanguage(false)` 추가
  - L1345 `<EditorMenuBar onSelect={onMenuSelect} enabledIds={MENU_ENABLED} />`(여기에 `t={t}` 추가)
  - L1586-1610 다이얼로그 배치 영역(`<PhotoPublishDialog>`/`<MemoDialog>` 옆에 `<UiLanguageDialog>` 배치)
- **이전 step 산출물**:
  - `web/src/view/i18n.js` — `createTranslator(lang)`, `UI_LANGUAGES`
  - `web/src/view/UiLanguageDialog.jsx` — `{ open, value, t, onSelect, onClose }`
  - `web/src/view/EditorMenuBar.jsx` — 선택적 `t` prop(라벨 번역)
  - `web/src/view/editorPrefs.js` — `ui: { language:'ko' }` 기본값, `loadEditorPrefs().ui.language`, `saveEditorPrefs`, `setEditorPref`
- `web/src/view/WriterPage.test.jsx` — 현재 `'UI 언어 설정'` 버튼을 `toBeDisabled()`로 단언하는 회귀 가드가 **6곳**이다(결선 후 전부 실패하므로 반드시 갱신): **L1431, L2589, L3933, L3990, L4655, L4815**. 이 중 셋은 다른 항목(되돌리기/다시실행·임베드 5종)의 활성 단언에 붙은 **미결선 foil**이고(테스트 제목/주석에 'UI 언어 설정은 여전히 비활성'이 박혀 있다 — L1420·L1422, L2580·L2582, L3979·L3989), 나머지 셋은 UI 언어 전용 회귀 가드다(제목/주석도 미결선 명시 — L3927·L3929, L4650·L4651, L4810·L4811). 6곳 전부 assertion + 제목/주석을 갱신해야 한다(아래 작업 11 참조). 기존 도구 결선 테스트(`tools.memo`/`tools.publishPhoto` 활성·오픈) 스타일 참고. (phase 41 step2 summary가 "회귀 가드 6곳을 tools.uiLanguage로 교체"라 기록 — 6곳임을 확증.)

## 작업 (테스트 먼저 — TDD)
`WriterPage.test.jsx`에 신규/갱신 케이스를 먼저 작성하고 구현한다.

> **검토(plan-reviewer) 실행 참고 2건 — 반드시 반영:**
> 1. 이 문서에 인용된 회귀 가드 제목/주석 라인 번호(L1420·L3979 등)는 **근사값**이다. 6곳을 flip하기 전에 `grep -rn "toBeDisabled" web/src/view/WriterPage.test.jsx`로 `'UI 언어 설정'` 조합 지점을 **직접 재확인**하고 전환하라. 검증 절차 6의 grep 0건 게이트가 실제 안전망이다(라인 번호에 의존하지 마라).
> 2. WriterPage에서 **메뉴바는 `showMenuBar`가 true일 때만 렌더**되고, 개별 메뉴 항목은 메뉴를 열어야 나타난다. 신규 테스트는 기존 헬퍼 `openTopMenu(name)`(WriterPage.test.jsx L32, 예: `await openTopMenu('도구')`)로 메뉴를 연 뒤 항목/라벨을 단언하라.

1. **import**: L43 import에 `saveEditorPrefs`, `setEditorPref` 추가. 상단에서 `createTranslator`(i18n.js)와 `UiLanguageDialog` import.
2. **`MENU_ENABLED`(L108)에 `'tools.uiLanguage'` 추가** — 기존 id는 하나도 제거/재배치하지 마라(순수 append).
3. **표시 state**: `const [showUiLanguage, setShowUiLanguage] = useState(false);`(`showMemo` 패턴).
4. **`uiLanguage` state + 영속 게이트(기존 prefs 패턴과 동형)**:
   - `const [uiLanguage, setUiLanguage] = useState(() => loadEditorPrefs().ui.language);`
   - 마운트 useEffect(L227-235 블록)에 `setUiLanguage(loadEditorPrefs().ui.language);` 추가 — 새로고침/재접속 후에도 반영(다른 prefs와 동일 줄 스타일).
   - `onPrefsClose(applied)` 패리티(선택 — 환경설정에서 UI 언어를 바꾸는 UX는 없으나, 다른 prefs와 동형으로 `setUiLanguage(loadEditorPrefs().ui.language)`를 넣어도 무해). 필수는 아님.
5. **번역기(useMemo)**: `const t = useMemo(() => createTranslator(uiLanguage), [uiLanguage]);` — 메뉴바·다이얼로그 공용 주입.
6. **`onMenuSelect` 분기(매핑 가드 앞)**: `tools.memo`/`tools.publishPhoto` 근처에 `if (id === 'tools.uiLanguage') { setShowUiLanguage(true); return; }` 추가. 이유 주석: 크롬 설정(본문 무관) → 매핑에서도 열림.
7. **선택 처리(영속+즉시 적용, 동기)**:
   ```
   const onSelectUiLanguage = (lang) => {
     if (!UI_LANGUAGES.includes(lang)) return;              // 방어(허용값만)
     saveEditorPrefs(setEditorPref(loadEditorPrefs(), 'ui', { language: lang })); // localStorage 영속
     setUiLanguage(lang);                                    // 즉시 리렌더(메뉴바+다이얼로그 반영)
   };
   ```
   동기 저장이라 `await`/`activeTabRef` 재파생 불필요(본문 무변경).
8. **탭 전환 조정 블록(L261-285)**: `setShowPhotoPublish(false);` 뒤에 `setShowUiLanguage(false);` 추가(비모달 열린 채 이월 방지).
9. **메뉴바에 t 주입**(L1345): `<EditorMenuBar onSelect={onMenuSelect} enabledIds={MENU_ENABLED} t={t} />`.
10. **다이얼로그 배치**(다이얼로그 영역, `<MemoDialog>` 옆):
    ```
    <UiLanguageDialog
      open={showUiLanguage}
      value={uiLanguage}
      t={t}
      onSelect={onSelectUiLanguage}
      onClose={() => setShowUiLanguage(false)}
    />
    ```
11. **회귀 가드 테스트 갱신(필수) — 6곳 전부**: `'UI 언어 설정'` 버튼을 `toBeDisabled()`로 단언하는 지점이 **6곳**(L1431·L2589·L3933·L3990·L4655·L4815) 있고, `'tools.uiLanguage'`를 `MENU_ENABLED`에 append하는 순간 6곳 전부 버튼이 enabled가 되어 `toBeDisabled()`가 실패한다 → 6곳 **모두** `toBeEnabled()`로 전환한다(약화·삭제 금지 — 회귀 가드망은 보존, assertion 방향만 반전. p21/p34 선례). 도구 15항목이 이번에 전부 결선되어 도구 메뉴 내 미결선 항목이 **하나도 없다**(정상 상태 = 전부 활성).
    - **제목/주석까지 반드시 재작성**: 6곳 중 다음은 테스트 제목·주석이 "UI 언어 설정은 (여전히) 미결선/비활성"이라 단언하므로 assertion만 뒤집으면 제목·주석이 거짓이 된다 — 함께 '전 항목 활성' 취지로 고친다.
      - L1431(제목 L1420·주석 L1422), L2589(제목 L2580·주석 L2582): 되돌리기/다시실행 활성 단언에 붙은 미결선 foil — foil 절('미결선 항목 …은 여전히 비활성')을 제거하거나 'UI 언어 설정도 활성'으로 수정.
      - L3990(주석 L3989): 임베드 5종 활성 테스트의 꼬리 foil — 주석의 '비결선 도구 항목은 여전히 비활성' 표현을 'UI 언어 설정도 결선돼 활성'으로 수정하고, 제목의 '비결선은 비활성' 취지도 어긋나지 않게 조정.
      - L3933(제목 L3927·주석 L3928-3929), L4655(제목 L4650·주석 L4651), L4815(제목 L4810·주석 L4811): UI 언어 전용 회귀 가드 — 제목·주석을 'UI 언어 설정(tools.uiLanguage)이 결선돼 활성이다' 취지로 재작성.
    - **help.open/help.about에 새 미결선 가드를 만들지 마라**(범위 밖 — 이미 정한 방향과 일관).

## Acceptance Criteria
```
cd D:/agents/harness && npm run test -- web/src/view/WriterPage.test.jsx
cd D:/agents/harness && npm run test
cd D:/agents/harness && npm run lint
cd D:/agents/harness && npm run build
```
테스트가 반드시 커버할 것:
- 도구 메뉴 'UI 언어 설정'(`tools.uiLanguage`)이 **활성**(`toBeEnabled`)이다(MENU_ENABLED — 비활성→활성). **기존 `toBeDisabled()` 회귀 가드 6곳(L1431·L2589·L3933·L3990·L4655·L4815)을 전부 `toBeEnabled()`로 갱신 + 제목/주석 재작성**(작업 11 참조). 갱신 누락 시 이 AC의 "전체 스위트 회귀 없음"을 스스로 위반한다.
- 클릭 시 `UiLanguageDialog`(`data-testid="ui-language-dialog"`, `role=dialog`)가 열린다.
- 기본값 ko: 최초 렌더 시 메뉴바 라벨이 ko 원문 그대로다(기존 메뉴 텍스트 테스트 회귀 없음). `loadEditorPrefs().ui.language==='ko'`.
- **선택 영속+반영**: 다이얼로그에서 en 선택 → `saveEditorPrefs`로 저장(재로드 시 `loadEditorPrefs().ui.language==='en'`) → 메뉴바 상단/도구 항목 라벨이 영문으로 갱신(같은 렌더에서 `t` 재생성 반영).
- **재접속/새로고침 유지**: en 저장 후 컴포넌트 재마운트(재렌더/언마운트→마운트) 시 메뉴바가 en으로 뜬다(마운트 lazy-init + effect가 localStorage에서 복원).
- **탭 전환 시 닫힘**: 다이얼로그를 연 채 다른 탭 선택 시 다이얼로그가 닫힌다.
- **매핑 모드에서도 열림**: 매핑 모드 탭에서 'UI 언어 설정' 클릭 시 다이얼로그가 열린다(본문 무관 — 죽은 버튼 아님).
- **본문 무변경**: 언어 선택이 `saveArticle`/`updateField('body',…)`를 호출하지 않는다(저장 시 원본 body 그대로 — `tools.publishPhoto`/`fileInfo` 무변경 테스트 스타일).
- 전체 스위트 회귀 없음(`npm run test`) — ko 불변식의 최종 증거. **phase 마지막 step이므로 phase 전체 산출물이 함께 통과해야 한다.**

## 검증 절차
1. `MENU_ENABLED`에서 기존 결선 id가 하나도 제거/재배치되지 않고 `tools.uiLanguage`만 append됐는가?
2. `onMenuSelect` 분기가 **매핑 가드 앞**에 있는가(매핑에서도 열림)? 본문/캐럿/임베드/제목을 건드리는 호출이 없는가?
3. `uiLanguage` state가 다른 prefs(`columnLimit`/`language`)와 동형으로 lazy-init + 마운트 effect 복원되는가? 저장이 `saveEditorPrefs(setEditorPref(...,'ui',...))` 단일 경로인가?
4. `t`(번역기)가 `EditorMenuBar`와 `UiLanguageDialog`에 **동일 인스턴스**로 주입되어 언어 전환이 양쪽에 일관 반영되는가?
5. 탭 전환 조정 블록에 `setShowUiLanguage(false)`가 추가됐는가?
6. `toBeDisabled` × `'UI 언어 설정'` 조합을 **grep 전수 확인 → 0건**이어야 한다(6곳 모두 `toBeEnabled()`로 전환됐다는 증거). 제목/주석에 'UI 언어 설정 미결선/비활성' 잔재가 없는가? 6곳 회귀 가드가 삭제·약화 없이 활성 단언으로 보존됐는가? 서버·model 계약·DB 미접촉인가?
7. 아키텍처 체크리스트: View←Controller←Model 준수(다이얼로그·메뉴바는 View, 영속은 Controller가 store 호출), 신규 서버 라우트/DB 없음, `edit.language`(문서언어) 미변경, ko 기본 DOM 불변.

## 금지사항
- `MENU_ENABLED`에서 기존 결선 id를 제거·재배치하지 마라. 이유: 파일/편집/보기/맞춤법/표/도구 전 계열이 즉시 죽은 버튼이 되어 회귀한다.
- `'UI 언어 설정'`을 `toBeDisabled()`로 단언하는 6곳(L1431·L2589·L3933·L3990·L4655·L4815) 중 하나라도 그대로 남겨 두지 마라(결선 후 전부 실패한다). 삭제하거나 다른 미결선 항목으로 도피시키지도 마라 — 6곳 모두 `toBeEnabled()`로 전환하고 제목/주석도 '전 항목 활성' 취지로 재작성하라. 이유: 도구 15항목이 전부 결선돼 미결선 항목이 없다(정상 = 전부 활성). 회귀 가드망은 보존(방향만 반전).
- UI 언어 선택 시 `commitBody`/`serialize`/`updateField('body',…)`/`insertEmbed`/제목 재동기화를 호출하지 마라. 이유: UI 언어는 크롬 설정 — 본문/캐럿/임베드/제목을 바꾸면 미저장 본문·매핑 불변식이 파손된다.
- `onMenuSelect` 분기를 매핑 가드 뒤에 두지 마라. 이유: 매핑 모드에서 활성인데 안 열리는 죽은 버튼이 된다(크롬 설정은 본문 잠금과 무관).
- 서버 저장·신규 DB 테이블·라우트·model 계약(MODEL_KEYS)을 추가하지 마라. 이유: UI 언어는 클라이언트 localStorage 재사용이 정책(DB 비파괴·범위 최소화). `req.body.role` 등 인가와 무관하다.
- `editorPrefs.edit.language`(문서 언어 9종)나 상태표시줄 언어 표시를 건드리지 마라. 이유: 별개 개념 — 회귀 유발.
- 툴바/상태표시줄/다이얼로그 본문 문자열을 이 step에서 추가 번역하지 마라. 이유: 범위 밖(Scope 최소화) — 메뉴바 결선 + 진입/영속만이 이 phase의 완결 조건이다.
