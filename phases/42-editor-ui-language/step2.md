# Step 2: menubar-i18n

## 목표
에디터 크롬의 대표 표면인 **상단 메뉴바**(`web/src/view/EditorMenuBar.jsx`)가 라벨을 Step 0의 번역 헬퍼로 렌더하도록 만든다(+테스트). 이 step은 View 컴포넌트 하나(`EditorMenuBar.jsx`)만 수정한다.

## 배경 / 설계 의도
- 스코프: 이 phase의 "크롬 결선"은 **상단 메뉴바 라벨**로 한정한다. 메뉴바는 news.md L180-187이 정확히 규정하는 에디터의 정본 크롬이라 i18n의 대표 대상이다. 툴바/상태표시줄/각 다이얼로그 본문 문자열의 번역은 **이 phase 범위 밖**이다(인프라는 재사용 가능하게 두어 후속 phase가 점진 확장) — Scope 최소화·ko 회귀 위험 최소화.
- **ko 불변식**: `EditorMenuBar`는 지금 `EDITOR_MENUS`의 하드코딩 라벨을 그대로 렌더한다. 이를 `t(id, label)` 조회로 바꾸되, `t` prop이 없거나 ko일 때는 **원문 라벨을 그대로 반환**해야 한다 → 기존 메뉴바 테스트가 한 글자도 안 바뀌고 통과한다. Step 0에서 카탈로그 키를 `EDITOR_MENUS`의 id와 동일하게, ko 값을 라벨과 바이트 동일로 맞춰 두었으므로 결선은 한 줄 조회로 끝난다.
- `t` prop은 **선택적**이다. `EditorMenuBar`는 여러 곳/테스트에서 `t` 없이 렌더된다(phase 8 하위호환). `t`가 `undefined`면 기존과 동일하게 `item.label`/`menu.label`을 쓴다.

## 읽어야 할 파일
- `docs/news.md` L180-187(메뉴바 라벨 정본), `docs/ARCHITECTURE.md`(프론트 MVC), `docs/ADR.md`(ADR-003)
- `web/src/view/EditorMenuBar.jsx`(전체 — `EDITOR_MENUS` L9-112, `EditorMenuBar({ onSelect, enabledIds })` L114-189). 각 메뉴는 `id`/`label`, 각 항목은 `id`/`label`/`shortcut?`를 가진다. 라벨 렌더 지점: 상단 버튼 L152 `{menu.label}`, 항목 L175 `<span ...>{item.label}</span>`, 드롭다운 testid L155 `menu-${menu.label}`.
- `web/src/view/EditorMenuBar.test.jsx`(있으면 — 기존 단언 스타일. `menu-도구` 등 label 기반 testid에 의존하는지 확인)
- **이전 step 산출물**: `web/src/view/i18n.js` — `createTranslator(lang)` → `t(key, fallback?)`. 키는 메뉴/항목 id, ko 값은 라벨과 바이트 동일.

## 작업 (테스트 먼저 — TDD)
`EditorMenuBar.test.jsx`에 케이스를 먼저 추가하고 구현한다.

1. **prop 추가**: `EditorMenuBar({ onSelect, enabledIds, t })` — `t`는 선택적 `(key, fallback?) => string`. 미전달 시 `const tr = t || ((k, f) => f);` 형태의 항등 폴백을 두어 원문을 그대로 쓴다(폴백은 `fallback` 인자=원문 라벨을 반환).
2. **라벨 조회로 치환**:
   - 상단 메뉴 버튼 라벨 `{menu.label}` → `{tr(menu.id, menu.label)}`.
   - 항목 라벨 `{item.label}` → `{tr(item.id, item.label)}`.
   - `shortcut`은 언어 무관(키 표기) — **번역하지 마라**, 그대로 둔다.
3. **testid 안정성 결정(중요)**: 드롭다운 testid는 현재 `menu-${menu.label}`(예: `menu-도구`)로, 다수 기존 테스트가 이 값에 의존한다(`screen.getByTestId('menu-도구')`). 언어가 바뀌어도 이 testid가 흔들리면 안 된다. **testid는 안정 키(원문 label 또는 menu.id) 기준으로 고정**하라 — 표시 텍스트만 `tr(...)`로 바꾸고, `data-testid`는 기존 `menu-${menu.label}`(원문) 그대로 유지한다(en에서도 `menu-도구`로 조회 가능). 즉 **표시 텍스트만 번역, testid/aria 구조 키는 불변**.
4. `EDITOR_MENUS` 데이터(id/label/shortcut) 자체는 바꾸지 마라 — ko 라벨은 폴백/원문 출처로 남는다.

## Acceptance Criteria
```
cd D:/agents/harness && npm run test -- web/src/view/EditorMenuBar.test.jsx
cd D:/agents/harness && npm run test
cd D:/agents/harness && npm run lint
cd D:/agents/harness && npm run build
```
테스트가 반드시 커버할 것:
- **ko 바이트 동일 회귀**: `t` 미전달로 렌더 시 모든 메뉴/항목 라벨이 기존과 동일(예: '도구', 'UI 언어 설정', 'file.new'='새문서'). 기존 `EditorMenuBar`/`WriterPage` 메뉴 테스트가 수정 없이 통과.
- `createTranslator('ko')` 전달 시에도 원문과 동일.
- `createTranslator('en')` 전달 시 상단 메뉴·항목 라벨이 영문으로 렌더된다(예: 도구 메뉴가 영문 라벨). 단 `data-testid="menu-도구"`(원문 키)로 여전히 드롭다운을 조회할 수 있다.
- `shortcut`(Alt+Y 등)은 언어와 무관하게 동일하게 표시.
- 전체 스위트 회귀 없음(`npm run test`).

## 검증 절차
1. `t` 미전달 렌더 DOM이 변경 전과 바이트 동일인가(기존 메뉴바 테스트가 강제)?
2. `data-testid`/`role`/`aria-*` 등 구조 셀렉터가 언어에 따라 흔들리지 않는가(표시 텍스트만 번역)?
3. en 전달 시 상단 7개 메뉴와 도구 15개 항목 라벨이 영문으로 나오는가?
4. `EDITOR_MENUS` 상수(id/label)가 그대로인가? `WriterPage.jsx`는 이 step에서 미수정인가(결선은 Step 3)?

## 금지사항
- `data-testid`(`menu-${menu.label}`)나 `aria-label` 등 구조 셀렉터를 번역값 기준으로 바꾸지 마라. 이유: 언어 전환 시 다수 기존 테스트·접근성 훅이 요소를 못 찾는다.
- `shortcut` 표기를 번역하지 마라. 이유: 키보드 키 표기는 언어 무관.
- `EDITOR_MENUS`의 id/label을 변경·삭제하지 마라. 이유: id는 i18n 키·`MENU_ENABLED`·`onMenuSelect` 라우팅의 안정 키이고 label은 ko 폴백 원문이다.
- 툴바·상태표시줄·다이얼로그 본문 문자열을 이 step에서 번역하지 마라. 이유: 범위 밖 — Scope 최소화, ko 회귀 표면 확대 방지.
- `t` prop을 필수로 만들지 마라(기본값/폴백 유지). 이유: `t` 없이 렌더하는 기존 호출부·테스트가 깨진다(phase 8 하위호환).
