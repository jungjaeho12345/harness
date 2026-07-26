# Step 4: comment-deadkey-hygiene

## 목표

누적된 **위생 nit을 일괄 정리한다 — 동작 변경 0**. 네 가지: (1) i18n.js/EditorMenuBar.jsx의 "ko 바이트 동일" 주석 부정확 교정, (2) 미사용 카탈로그 키 `ui.dialog.langLabel`·`common.save` 제거, (3) WriterPage `fontFamilyCss`/`fontSizeCss` 중복 호출 1회화, (4) Insert 토글의 stale "step3" 주석 교정. **모두 주석/죽은 키/무해 리팩터** — 런타임 동작은 바이트 불변이어야 하며, 전체 테스트 그린이 무회귀 게이트다.

이 step은 candidate 6("위생 nit 일괄")의 명시적 배치다. 전부 뷰 계층·behavior-preserving이라 한 관심사(위생)로 묶되, 각 변경을 아래에 정확히 열거한다.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `web/src/view/i18n.js`:
  - **파일 상단 주석 L1~5**: L3~4 "fallback(item.label=ko 원문)이 ko 불변식을 이중 보장한다. ko 값은 EDITOR_MENUS의 라벨과 바이트 동일해야 한다" — **부정확**(아래 배경 참조).
  - ko `MESSAGES.ko`: **L102 `'ui.dialog.langLabel': '언어',`**, **L105 `'common.save': '저장',`** ← 제거 대상.
  - en `MESSAGES.en`: **L201 `'ui.dialog.langLabel': 'Language',`**, **L204 `'common.save': 'Save',`** ← 제거 대상(대칭).
  - `t(key, fallback)` 헬퍼(파일 하단) — lang이 ko고 t가 주입되면 `MESSAGES.ko[key]`(카탈로그 값)를 반환, 미주입이면 fallback. **이 동작이 주석 교정의 근거.**
- `web/src/view/i18n.test.js`:
  - **L48~57** `'UI 언어 다이얼로그 전용 키가 ko/en 양쪽에 존재한다'` — **L49 배열에 `'ui.dialog.langLabel'`·`'common.save'` 포함**, **L55 `expect(MESSAGES.ko['common.save']).toBe('저장');`** ← 제거 대상(자기참조 가드 갱신).
  - L48 이후 MESSAGES.ko[id]===label 불변식 테스트(메뉴 키 대상 — 제거하는 두 키는 **메뉴 키가 아님**이라 불변식 무관) 확인.
- `web/src/view/EditorMenuBar.jsx`:
  - **L114~115 주석**: "미전달/ko일 때는 fallback(=원문 label)을 그대로 반환 → 기존 호출부·테스트가 바이트 동일로 통과" — **부정확**(t 주입 + ko면 fallback이 아니라 카탈로그 값 반환). L120~121 `tr = t || ((k,f)=>f)` 실동작 확인.
  - `help.about`/`help.preferences` 등 항목 정의(L108~112) — 라벨 불변.
- `web/src/view/WriterPage.jsx`:
  - **캔버스 래퍼 style L1512~1515**: L1514 `...(fontFamilyCss(editorFont) ? { '--yh-editor-font-family': fontFamilyCss(editorFont) } : null),` — **`fontFamilyCss(editorFont)` 2회 호출**. L1515 `fontSizeCss(editorFontSize)` 동일. import L46. 조건부 스프레드 계약(‘기본’→null→미주입)은 **불변**.
  - **Insert 토글 stale 주석**: L163~166(`이 step은 토글+상태표시줄 표시까지 — 실제 캐럿 뒤 덮어쓰기 입력은 step3(이 state를 소비).`)·L1122~1124(`실제 덮어쓰기 입력은 step3(overwrite state 소비) — 여기서는 모드 토글+표시만.`) — phase 44에서 이미 구현 완료된 "step3"를 미래 작업처럼 지칭.
- `web/src/view/UiLanguageDialog.jsx`·`AboutDialog.jsx`·`HelpDialog.jsx` — **죽은 키 제거 전 재확인용**: 이들이 `ui.dialog.langLabel`·`common.save`를 쓰지 않는지 직접 grep으로 확인(UiLanguageDialog는 `ui.dialog.ko`/`ui.dialog.en`/`ui.dialog.title`/`common.close`만, About/Help는 `common.close`만 사용).

## 배경 (자기완결) — 주석이 왜 부정확한가 / 죽은 키가 왜 안전한가

**주석 부정확(1·4):** i18n 라벨 국제화(phase 42)에서 `EditorMenuBar`가 `t(item.id, item.label)`로 라벨을 그린다. `t`가 **주입되고 lang='ko'**면 반환값은 **`MESSAGES.ko[id]`(카탈로그 값)**이지 fallback(원문 label)이 아니다. 즉 ko 바이트 동일은 **"카탈로그 값 === 라벨" 불변식(i18n.test.js가 강제)**에 의존하며, fallback은 **t 미주입 시**의 이차 보장일 뿐이다. 현재 주석은 "fallback이 ko 불변식을 보장한다"고 읽혀 소스를 오도한다. → "ko 바이트 동일은 카탈로그 값=라벨 일치(테스트 강제)에 의존, fallback은 t 미주입 시 이중 보장"으로 교정한다.

**죽은 키(2):** `ui.dialog.langLabel`('언어'/'Language')·`common.save`('저장'/'Save')는 **어떤 프로덕션 .jsx 컴포넌트도 참조하지 않는다**(grep 확인: UiLanguageDialog는 즉시-적용이라 '저장' 버튼이 없고 '닫기'(`common.close`)만 있으며, langLabel 라벨도 렌더하지 않는다). 유일한 참조는 `i18n.test.js`의 **자기참조 존재 가드**뿐이다(실소비자 아님). ko/en 양쪽을 **대칭 제거**하고 그 자기참조 가드도 함께 갱신하면 카탈로그가 정직해진다. 제거 두 키는 **메뉴 키가 아니라** `MESSAGES.ko[id]===label` 불변식 대상이 아니고, ko/en 키 집합 대칭은 대칭 제거로 유지된다.

**중복 호출(3):** `fontFamilyCss(editorFont)`가 조건과 값에서 2회 평가된다. 순수 함수라 결과는 같지만 1회 계산해 재사용하는 게 명료하다(동작 동일). **동일 규칙: 조건부 스프레드(‘기본’/null이면 미주입=fallback 렌더)는 절대 바꾸지 마라** — phase 44 step1의 바이트-동일 회귀 가드다.

## TDD — 테스트 먼저 / 무회귀 게이트

동작 변경이 없으므로 **신규 동작 테스트는 없다**. 안전판은 두 가지:
- **죽은 키 제거의 대칭·불변식 유지**: `i18n.test.js` L48~57을 갱신하되(`'ui.dialog.langLabel'`·`'common.save'` 제거, L55 `common.save` 단언 제거), 다음 기존 테스트가 그린이어야 한다: (i) ko/en **키 집합 대칭**(모든 ko 키가 en에 존재, 역도) — 대칭 제거라 통과, (ii) `MESSAGES.ko[id]===label`(메뉴 키) 불변식 — 제거 키는 메뉴 키 아님이라 무영향, (iii) 남은 UI 다이얼로그 키(`ui.dialog.title`/`ko`/`en`/`common.close`) 존재·비어있지 않음.
- **전체 스위트 무회귀**: 주석/리팩터/죽은 키 제거 후 `npm run test:web`(1871 기준) 그린 — 특히 phase 44 툴바 폰트 주입/미주입 회귀 가드(‘기본’ 미주입=fallback)와 phase 42 i18n 라벨 바이트-동일 테스트가 깨지지 않아야 한다.

> 죽은 키를 제거하기 **전에** 반드시 `Grep`으로 `ui.dialog.langLabel`·`common.save`가 `web/src/**/*.{jsx,js}`(테스트 제외 프로덕션)에서 참조되지 않음을 재확인하라. 하나라도 실소비자가 있으면 그 키는 제거 대상에서 제외한다.

## 작업 (구현 상세 — 동작 불변)

1. **i18n.js 상단 주석(L3~4)**: "fallback이 ko 불변식을 보장" → "ko 바이트 동일은 카탈로그 값(MESSAGES.ko[id])이 라벨과 일치함에 의존(i18n.test.js 강제), fallback은 t 미주입 시 이중 보장"으로 교정.
2. **i18n.js 죽은 키 제거**: ko L102·L105, en L201·L204 4줄 삭제(대칭). `// UI 언어 다이얼로그 전용 + 공용` 섹션 주석은 남은 키(title/ko/en/close)에 맞게 유지.
3. **i18n.test.js 자기참조 가드 갱신(L48~57)**: L49 배열에서 `'ui.dialog.langLabel'`·`'common.save'` 제거, L55 `common.save` 단언 제거. 남은 키 존재 단언·L54(`ui.dialog.title`)·L56(`common.close`)는 보존.
4. **EditorMenuBar.jsx 주석(L114~115)**: "ko일 때 fallback 반환" 부분을 "t 미주입 시 fallback(=원문 label); t 주입 + ko면 카탈로그 값(=라벨과 바이트 동일, 불변식 보장)을 반환"으로 교정. `tr = t || ((k,f)=>f)` 실동작·testid/aria 원문 불변 설명은 보존.
5. **WriterPage.jsx 중복 호출(L1512~1515)**: style 객체 직전에 `const editorFontCss = fontFamilyCss(editorFont);`·`const editorFontSizeCss = fontSizeCss(editorFontSize);`를 계산하고, 조건부 스프레드에서 그 const를 조건·값에 재사용:
   ```js
   ...(editorFontCss ? { '--yh-editor-font-family': editorFontCss } : null),
   ...(editorFontSizeCss ? { '--yh-editor-font-size': editorFontSizeCss } : null),
   ```
   출력(주입/미주입 결정)은 100% 동일해야 한다.
6. **WriterPage.jsx Insert 토글 stale 주석(L163~166·L1122~1124)**: "실제 덮어쓰기 입력은 step3" 미래-작업 표현을 현재 상태(덮어쓰기 입력은 구현됨 — overwrite state를 소비하는 onKeyDown 분기가 존재)로 교정. "전역 단일 모드·탭 미격리·비영속·조정 블록 미대상" 등 유효한 설명은 보존.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(client 전용 — `npm test` 불필요. 서버/DB 무접촉.)

## 회귀 가드 / 불변식

- **동작 바이트 불변**: 렌더 출력·툴바 폰트 주입/미주입·i18n 라벨 표시가 이 step 전후로 동일. 죽은 키는 실소비자가 없어 UI에 아무 영향 없음.
- **`MESSAGES.ko[id]===label`(메뉴 키)**: 제거 키는 메뉴 키가 아니므로 불변식 무영향 — 메뉴 라벨 카탈로그는 손대지 마라.
- **ko/en 키 대칭**: 두 키를 ko·en 양쪽에서 대칭 제거 → 집합 대칭 유지.
- **조건부 스프레드 계약**: fontFamilyCss/fontSizeCss가 null(‘기본’)이면 여전히 미주입(=CSS fallback 렌더). 중복 제거가 이 결정을 바꾸면 안 됨.
- 기준 무회귀: web 1871·backend 427·lint/build clean(i18n.test.js L48~57은 죽은 키 제거에 따라 의도적 갱신, 그 외 전부 보존).

## 커밋 계획

- **refactor**: `refactor(45-editor-backlog-cleanup): step4 — 위생 nit 일괄(i18n/메뉴바 주석 정확화·미사용 카탈로그 키 제거·fontCss 중복호출 정리·Insert 토글 stale 주석)` — `i18n.js`·`EditorMenuBar.jsx`·`WriterPage.jsx` + `i18n.test.js`. (동작 변경 없음을 메시지에 명시.)
- **chore**: `chore(45-editor-backlog-cleanup): step4 status — completed` — index.json step4(phase 45 전체 완결).

## 금지사항

- 실소비자가 있는 카탈로그 키를 제거하지 마라. 이유: grep으로 프로덕션 .jsx 무참조를 재확인한 `ui.dialog.langLabel`·`common.save`만 제거 대상 — 하나라도 참조되면 제외한다.
- 죽은 키를 ko만/en만 한쪽에서 제거하지 마라. 이유: ko/en 키 대칭 불변식이 깨진다 — 반드시 대칭 제거하고 자기참조 테스트도 함께 갱신한다.
- 메뉴 라벨 카탈로그 값이나 `MESSAGES.ko[id]===label` 불변식 대상 키를 건드리지 마라. 이유: phase 42 라벨 바이트-동일 계약이 깨진다.
- `fontFamilyCss`/`fontSizeCss` 중복 제거로 조건부 스프레드의 주입/미주입 결정을 바꾸지 마라. 이유: ‘기본’ 미주입=fallback 렌더는 phase 44 바이트-동일 회귀 가드다.
- 주석 교정 김에 인접 로직/동작을 바꾸지 마라(주석/죽은 키/무해 리팩터만). 이유: 이 step은 behavior-preserving — 동작 변경은 별도 step 소관이다.
- 기존 테스트를 깨뜨리지 마라(i18n.test.js L48~57 자기참조 가드만 의도적 갱신).
