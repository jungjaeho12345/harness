# Step 2: meta-dialog — MetaSelectDialog 순수 선택 팝업 컴포넌트

## 배경 / 요구사항

지역·내용·속성을 **팝업에서 다중 선택**한다(news.md L63~65). 이 step은 **재사용 단일 컴포넌트** `web/src/view/MetaSelectDialog.jsx`를 만든다 — 그룹 헤더 + 체크박스 항목, 한도(n/limit) 카운터, 레거시(기존 자유입력) 값 보존 섹션을 갖춘 **순수 표시/폼 컴포넌트**(ADR-003).

- **순수 컴포넌트**: props로 데이터를 주입받고 콜백으로만 위임한다. `model`/`fetch`/`localStorage`/`window`/`document`/택소노미 직접 import 없음. 부모(step 3 WriterPage)가 `metaTaxonomy.metaFieldConfig`로 groups/limit/title을 뽑아 주입한다.
- 이 step에는 **WriterPage 결선도 CommonInfo 변경도 없다.** 컴포넌트 + 테스트만. 결선은 step 3.
- 지역/내용/속성 3용도를 **한 컴포넌트**가 처리한다 — 차이는 주입되는 `groups`/`limit`/`title`뿐이다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`(프론트 MVC — View 순수), `/docs/ADR.md`(ADR-003 주입형·transport 무관).
- `web/src/view/TableEditDialog.jsx` — **1순위 템플릿**. `open`/`initialRows`/`onSubmit`/`onClose` props, `useFocusOnOpen`, **open false→true 재초기화 `wasOpen` 가드**(L40~46), `onKeyDown` Escape 닫기(L61~68), 루트 `className="yh-editor-dialog yh-table-dialog"`·`role="dialog"`·`data-testid`, `onSubmit(정규화 결과)` 후 닫기는 부모에 위임(L55~59). **이 구조를 그대로 따른다.**
- `web/src/view/GlyphInputDialog.jsx` — 버튼/목록형(텍스트 입력 없는) 다이얼로그의 포커스·섹션·빈 상태(`__empty`) 패턴. 약물 선택 후 닫지 않는 정책 참고(우리는 '적용'에서 부모가 닫음).
- `web/src/view/useFocusOnOpen.js` — 열림 시 포커스 이전 훅. **ref는 실재 focusable(체크박스/버튼)에 달아라. bare div 금지**(phase 27 교훈 — 포커스가 Editor에 남으면 타이핑이 본문 오염 + Esc 미발화).
- `web/src/view/metaTaxonomy.js`(step 0 산출) — `parseTokens`/`joinTokens`(값 문자열 ↔ 토큰 배열). **컴포넌트는 이 두 헬퍼만 import한다**(REGION_GROUPS 등 데이터는 import하지 않는다 — groups는 props로 받는다).
- `web/src/view/TableEditDialog.test.jsx` — **테스트 템플릿**. `render(<Dialog open .../>)` 후 `screen`/`fireEvent`/`userEvent`로 단언, open 토글 재초기화 검증, onSubmit 인자 검증 패턴.
- `web/src/styles/yonhap.css` — `.yh-editor-dialog`(공용 중앙 모달, PR#60) + `.yh-table-dialog`/`.yh-glyph-input` 전용 클래스 스타일 위치. **전용 클래스 `.yh-meta-dialog` 스타일을 인근에 추가**.

## 작업

TDD로 진행한다(vitest). 새 파일 `web/src/view/MetaSelectDialog.jsx` + `web/src/view/MetaSelectDialog.test.jsx`. **선택 토글 → 한도 → 레거시 보존 → 제출** 순으로 테스트를 먼저 쓴다.

### 컴포넌트 시그니처

```jsx
export function MetaSelectDialog({
  open,       // boolean
  title,      // string — 다이얼로그 제목/aria-label ('지역'|'내용'|'속성')
  groups,     // [{ label: string, items: string[] }] — 헤더+항목(속성은 단일 그룹)
  limit,      // number — 최대 선택 수(지역/내용 5, 속성 3)
  value,      // string — 현재 필드값(콤마 조인). 레거시 자유입력 토큰 포함 가능
  onSubmit,   // (joined: string) => void — '적용' 시 조인 문자열 위임
  onClose,    // () => void — 닫기/Esc(제출 없이 폐기)
}) { ... }
```

### (1) 로컬 선택 상태 — 순서 보존 배열

- 로컬 state `selected`(**문자열 배열**, Set 아님 — 순서 보존).
- **open false→true 재초기화**(TableEditDialog `wasOpen` 가드와 동형): 열릴 때 `selected = parseTokens(value)`로 초기화. 열려 있는 동안 `value`가 바뀌어도 편집 중 선택을 리셋하지 않는다.
- 토글: 항목 체크 → 없으면 배열 끝에 push, 있으면 remove. **원래 순서 보존**(제출 시 원래 값의 상대 순서가 유지되고 신규 선택은 뒤에 붙는다).

### (2) 그룹 렌더 (헤더 + 체크박스)

- `groups`를 순회하며 각 그룹: 헤더(`group.label`) + 항목별 체크박스(`checked = selected.includes(item)`). 라벨 텍스트 = 항목 문자열. 접근성: 각 체크박스에 항목명 라벨(`aria-label`/`<label>`), `data-testid`(예: `meta-dialog-item-<index>` 또는 항목 기반) 부여.
- 단일 그룹(속성)이면 헤더는 렌더해도(=`속성`) 무해하다 — 별도 분기 불필요.

### (3) 한도 카운터 + 초과 차단

- 카운터 표시: `${selected.length}/${limit}`(예: `2/5`). `data-testid="meta-dialog-counter"`.
- **한도 도달 차단**: `selected.length >= limit`이면 **미체크** 항목의 체크박스를 `disabled`로(추가 불가). **이미 체크된 항목은 항상 해제 가능**(disabled 아님). 이유: 한도는 '추가'만 막고 '제거'는 늘 허용.

### (4) 레거시(기존 값) 보존 섹션 — 조용한 소실 금지

- `value`에는 팝업 도입 전 **자유입력 토큰**(어느 그룹 items에도 없는 값)이 있을 수 있다. 이를 버리면 편집-저장 시 사용자가 모르게 데이터가 사라진다.
- 선택된 토큰 중 **어느 그룹 items에도 없는 것**을 모아 별도 섹션 '기존 값'(`data-testid="meta-dialog-legacy"`)에 **체크된 상태**로 렌더한다. 사용자가 해제할 때만 제거된다.
- 레거시 토큰도 **한도 카운트에 포함**된다(selected 배열에 이미 있으므로 자동). 한도 초과 상태에서 레거시는 해제만 가능(추가 개념 없음).
- 레거시 섹션은 해당 토큰이 있을 때만 렌더(없으면 미표시).

### (5) 제출 / 닫기

- `if (!open) return null;`(TableEditDialog와 동형).
- '적용' 버튼: `onSubmit(joinTokens(selected))`. 닫기는 부모가 `open`을 내려 처리(여기서 onClose 호출하지 않음 — TableEditDialog submit 정책과 동형). `data-testid="meta-dialog-submit"`.
- '닫기' 버튼 + `onKeyDown` Escape → `onClose()`(제출 없이 폐기 — 로컬 selected 변경분 버림). `data-testid="meta-dialog-close"`.
- `useFocusOnOpen`: 첫 focusable(첫 체크박스, 항목이 없으면 '닫기' 버튼)로 포커스 이전. **bare div에 달지 마라.**

### (6) 스타일 (yonhap.css)

- 루트 `className="yh-editor-dialog yh-meta-dialog"`(공용 + 전용). `role="dialog"`, `aria-label={title}`, `data-testid="meta-dialog"`.
- `.yh-meta-dialog`(그룹 목록 스크롤 영역·헤더·체크박스 행·카운터·액션) 스타일을 `.yh-table-dialog` 인근에 추가. 정적 CSS만(사용자 값 미삽입). 다른 다이얼로그(`yh-table-dialog`/`yh-glyph-input`/`yh-url-embed`/`yh-find-replace`)와 클래스 충돌 없게 전용 클래스만.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수 컴포넌트**: props in / 콜백 out. `model`/`fetch`/`localStorage`/`window`/`document` 접근 금지, 택소노미 데이터(REGION_GROUPS 등) 직접 import 금지(groups는 props). `parseTokens`/`joinTokens`만 import. 이유: ADR-003 View 순수 — 결선/데이터 주입은 부모(step 3).
2. **레거시 값 보존**: value의 미등재 토큰을 '기존 값' 섹션에 체크 상태로 노출하고, 사용자가 해제할 때만 제거한다. 조용한 소실 금지. 이유: 팝업 도입 전 자유입력 데이터를 편집 시 무단 삭제하면 안 된다(DB 비파괴 정신의 UI판).
3. **한도는 추가만 차단**: `selected.length >= limit`이면 미체크 항목만 disabled. 체크된 항목·레거시는 항상 해제 가능. 이유: 사용자가 한도 도달 후에도 교체(해제→추가)할 수 있어야 한다.
4. **순서 보존 제출**: selected는 배열(순서 보존). 제출 문자열은 기존 토큰의 상대 순서를 유지한다. 이유: 편집-저장 왕복에서 값 순서가 임의로 뒤섞이면 안 된다(무의미한 diff 방지).
5. **재초기화 가드**: open false→true에서만 `parseTokens(value)`로 재초기화(`wasOpen`). 열려 있는 동안 value 변화로 리셋 금지. 이유: 재오픈 시 이전 편집 잔존 방지 + 열린 중 부모 리렌더가 편집을 날리지 않게(TableEditDialog 계약).
6. **포커스 이전**: `useFocusOnOpen`을 실재 focusable(체크박스/버튼)에 단다. 이유: 포커스가 Editor(contentEditable)에 남으면 타이핑이 본문 오염 + Esc 미발화(phase 27).

## Acceptance Criteria

```bash
npm run test:web -- MetaSelectDialog   # 신규 컴포넌트 테스트 통과(vitest 파일 필터)
npm run test:web                       # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `MetaSelectDialog.test.jsx`) — groups는 테스트용 소형 fixture 주입(예: `[{label:'g1',items:['a','b','c']}]`):
- `open=false` → 아무것도 렌더 안 함(`queryByTestId('meta-dialog')` null).
- 그룹 헤더·항목 체크박스가 렌더되고, `value='a'`면 `a` 체크·`b` 미체크로 초기화.
- 항목 클릭 토글 → 체크/해제. `onSubmit`이 조인 문자열(`'a, b'` 등)로 호출된다(순서 보존: `value='b'`에서 `a` 추가 → `'b, a'`).
- 한도: `limit=1`, `value='a'` → 미체크 항목 `b`가 `disabled`; `a` 해제는 가능(disabled 아님). 카운터 `1/1` 표시.
- 레거시: groups에 없는 `value='zzz'` → '기존 값' 섹션에 `zzz` 체크 상태 노출; 해제하면 제출 문자열에서 빠진다. 레거시가 한도 카운트에 포함된다(`limit=1`, `value='zzz'` → 그룹 항목 전부 disabled).
- **시작부터 한도 초과(② 검토 minor 보강)**: `limit=1`, `value='a, b'`(2토큰) → 카운터 `2/1` 표시, 미체크 항목 `c` disabled, 체크된 `a`/`b`는 해제 가능, 그대로 '확인' 시 `onSubmit('a, b')` 허용(초과 상태도 비파괴 제출 — 팝업이 기존 데이터를 강제 삭감하지 않는다).
- Escape/닫기 → `onClose` 호출, `onSubmit` 미호출(폐기).
- 재초기화: open을 false→true로 토글하며 `value`를 바꾸면 새 value로 재초기화(`wasOpen` 가드).

## 검증 절차

1. 위 AC 커맨드 실행(한글 깨지면 UTF-8 로케일 확인).
2. 아키텍처 체크리스트:
   - `MetaSelectDialog.jsx`에 `model`/`fetch`/`localStorage`/`window`/`document`/`REGION_GROUPS`/`metaFieldConfig` 참조 없음(`grep` 확인) — `parseTokens`/`joinTokens`만 import.
   - 레거시 보존·한도 추가차단·순서보존 단언 green.
   - 전용 클래스 `yh-meta-dialog`·testid `meta-dialog` 사용(기존 다이얼로그 클래스와 무충돌).
3. 결과에 따라 `phases/32-meta-popups/index.json`의 step 2를 갱신.

## 금지사항

- 컴포넌트에서 택소노미 데이터를 직접 import하거나 `model`/`fetch`/`document`를 호출하지 마라. 이유: 순수 컴포넌트(ADR-003) — 주입은 부모.
- value의 미등재(레거시) 토큰을 렌더에서 누락하거나 제출에서 조용히 버리지 마라. 이유: 무단 데이터 소실.
- 한도 도달 시 이미 체크된 항목/레거시까지 disabled로 잠그지 마라. 이유: 교체(해제) 불가로 사용자가 갇힌다.
- selected를 Set으로 관리해 제출 순서를 뒤섞지 마라. 이유: 무의미한 값 diff.
- `useFocusOnOpen`을 bare div/제출 버튼에 달지 마라(첫 체크박스/닫기 버튼에). 이유: 본문 오염·Esc 미발화(phase 27).
- WriterPage/CommonInfo/useWriteController를 이 step에서 결선하지 마라. 이유: Scope 최소화 — 결선은 step 3.
