# Step 1: language-dialog

## 목표
UI 언어를 고르는 **진입 다이얼로그** 순수 컴포넌트 `web/src/view/UiLanguageDialog.jsx`를 만든다(+테스트). 이 step은 View 컴포넌트 하나만 만든다 — `WriterPage` 결선은 Step 3에서 한다.

## 배경 / 설계 의도
- 진입 경로(최종): 도구 메뉴 > "UI 언어 설정" 클릭 → 이 다이얼로그가 열려 ko/en 중 하나를 고른다.
- ADR-003(프론트 MVC): 이 컴포넌트는 **순수 controlled 컴포넌트**다 — 내부 state·localStorage·model·fetch 없음. 현재 언어(value)·표시여부(open)·선택 처리(onSelect)·닫기(onClose)는 전부 부모(Step 3 `WriterPage`)가 소유한다. `MemoDialog.jsx`가 정확한 참고 형이다(controlled·Esc 닫기·`useFocusOnOpen`).
- **자기 자신도 번역 대상이다.** 다이얼로그의 제목/라벨/버튼 텍스트는 Step 0의 `createTranslator`로 만든 `t` prop을 통해 렌더한다 — 사용자가 en으로 바꾸면 이 다이얼로그도 영문으로 보여야 언어 전환이 일관된다. `t` prop이 없으면(테스트 편의) ko 원문으로 저하되게 폴백을 준다.
- 이 다이얼로그는 **탭-로컬 좌표/선택 상태가 없다**(UI 언어는 전역). 따라서 phase 29~32 계열 stale 회귀 대상이 아니다. 다만 비모달이라 열린 채 탭 전환이 가능하므로, 탭 전환 시 닫는 것은 Step 3(부모)가 조정 블록에서 처리한다 — 이 컴포넌트는 open prop만 따른다.

## 읽어야 할 파일
- `docs/ARCHITECTURE.md`(프론트 MVC), `docs/ADR.md`(ADR-003), `docs/UI_GUIDE.md`(`.yh-editor-dialog`·버튼 `.yh-btn`/`.yh-btn--primary`·색상 토큰)
- `web/src/view/MemoDialog.jsx`(정확한 참고 형 — controlled·`useFocusOnOpen`·Esc·testid·yh-editor-dialog className) 및 `web/src/view/MemoDialog.test.jsx`(테스트 스타일)
- `web/src/view/useFocusOnOpen.js`(열림 시 포커스 이전 훅 — focusable 요소에만 ref)
- **이전 step 산출물**: `web/src/view/i18n.js` — `createTranslator(lang)`가 반환하는 `t(key, fallback?)` 헬퍼와 `ui.dialog.*`/`common.*` 키. 이 다이얼로그는 그 키로 자기 텍스트를 렌더한다.

## 작업 (테스트 먼저 — TDD)
`web/src/view/UiLanguageDialog.test.jsx`를 먼저 작성하고(아래 AC), 통과하는 최소 구현을 만든다.

공개 인터페이스(props 시그니처 고정, 내부 구현 재량):
```
UiLanguageDialog({
  open,               // boolean — falsy면 null 반환(미렌더)
  value = 'ko',       // 'ko' | 'en' — 현재 UI 언어(부모 소유, controlled)
  t,                  // (key, fallback?) => string — Step 0 createTranslator 결과. 없으면 (k,f)=>f??k 로 저하
  onSelect,           // (lang) => void — ko/en 라디오/버튼 선택 시. 부모가 영속·적용
  onClose,            // () => void — '닫기'/Esc
})
```
구현 지침:
- 루트는 `role="dialog"`, `aria-label`은 `t('ui.dialog.title', 'UI 언어 설정')`, 전용 `data-testid="ui-language-dialog"`, className은 `yh-editor-dialog yh-editor-ui-language`(다른 다이얼로그와 충돌 방지 — MemoDialog 선례).
- 언어 선택 UI: ko/en 두 옵션을 라디오(또는 각 언어 버튼)로. 각 옵션 라벨은 `t('ui.dialog.ko','한국어')`/`t('ui.dialog.en','영어')`. 현재 `value`에 해당하는 옵션이 checked/선택 상태로 표시된다.
- 선택 즉시 `onSelect(lang)` 호출(부모가 영속+적용). 별도 '적용' 버튼 없이 선택=적용으로 둔다(설정이 2종뿐이라 단순 — 재량이나 선택 시 onSelect 발화는 필수).
- '닫기' 버튼(`t('common.close','닫기')`) → `onClose()`. 루트 `onKeyDown`에서 `Escape` → `onClose()`.
- `useFocusOnOpen`으로 열림 시 포커스를 focusable 요소(첫 라디오 input 또는 '닫기' 버튼)로 이전한다 — 포커스가 `<Editor>` 본문에 남으면 타이핑이 기사 본문에 오염되고 Esc가 발화하지 않는다(MemoDialog 주석 참조). **본문/설정을 바꾸는 액션 버튼이나 bare div에 ref를 달지 마라.**
- 필요한 최소 CSS만 `web/src/styles/yonhap.css`에 추가해도 되나(선택), 다른 다이얼로그 규칙을 바꾸지 마라. AI 슬롭 안티패턴(glass/gradient/보라색/글로우) 금지(UI_GUIDE).

## Acceptance Criteria
```
cd D:/agents/harness && npm run test -- web/src/view/UiLanguageDialog.test.jsx
cd D:/agents/harness && npm run test
cd D:/agents/harness && npm run lint
cd D:/agents/harness && npm run build
```
테스트가 반드시 커버할 것:
- `open=false`면 아무것도 렌더 안 됨(null).
- `open=true`면 `role="dialog"`(`data-testid="ui-language-dialog"`) 표시, ko/en 두 옵션 표시.
- `value='en'`이면 en 옵션이 선택(checked) 표시된다.
- ko 옵션 선택 시 `onSelect('ko')`, en 옵션 선택 시 `onSelect('en')` 호출.
- '닫기' 클릭·Escape 키에서 `onClose` 호출.
- **번역 반영**: `t = createTranslator('en')` 주입 시 제목/라벨/버튼이 영문으로 렌더; `t` 미주입 또는 `createTranslator('ko')` 주입 시 ko 원문으로 렌더.
- 전체 스위트 회귀 없음(`npm run test`).

## 검증 절차
1. 컴포넌트가 내부 state/localStorage/model을 갖지 않는가(순수 controlled — MemoDialog와 동형)?
2. 열림 시 포커스가 focusable 요소로 이전되는가(액션 버튼/ bare div 아님)?
3. `t` 폴백이 안전한가 — `t` 미주입 시 ko 원문이 나오는가(기존 스타일 테스트가 t 없이 렌더할 수 있어야 함)?
4. Step 3 결선 전이라 `WriterPage.jsx`는 이 step에서 수정되지 않았는가(git diff 확인)?

## 금지사항
- 이 컴포넌트에 내부 `useState`로 언어 값을 저장하거나 `localStorage`/`saveEditorPrefs`를 직접 호출하지 마라. 이유: ADR-003 — 영속은 부모(Controller) 책임, 순수 컴포넌트는 controlled여야 테스트·재사용 가능.
- `WriterPage.jsx`·`EditorMenuBar.jsx`·`MENU_ENABLED`를 이 step에서 건드리지 마라. 이유: 결선은 Step 3의 Controller 레이어 작업 — Scope 최소화.
- `useFocusOnOpen` ref를 '닫기' 외 액션 버튼이나 bare div에 달지 마라. 이유: 포커스 상태 Space/Enter로 우발 실행되거나 activeElement가 안 바뀌어 본문 오염/ Esc 미발화(useFocusOnOpen 주석).
- 다른 다이얼로그의 className/testid(`editor-memo` 등)를 재사용하지 마라. 이유: 셀렉터 충돌.
