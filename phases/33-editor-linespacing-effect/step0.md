# Step 0: linespacing-store

이 phase는 환경설정 편집 탭의 줄간격(edit.lineSpacing)이 **저장만 되고 에디터에 반영되지 않는** 문제를 해결한다. step0은 그 전제인 **"값의 정의(계약)"**만 바로잡는다. 렌더/CSS 반영(effect)은 step1이다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md` — 특히 ADR-003(view 모듈은 localStorage/모듈 상태를 직접 호출해도 되고, 서버 호출만 controller를 경유한다). `editorPrefs.js`/`EditorPrefsDialog.jsx`는 view 모듈이므로 localStorage 직접 접근이 위반이 아니다.
- `docs/news.md` L189~198 — 에디터 환경설정 > 편집 > 줄간격(L197). **줄간격은 "줄간격"이라는 라벨만 있고 수치 스펙이 없다** — 옵션 집합은 구현 재량임을 확인하라.
- `web/src/view/editorPrefs.js` — 전체. 특히 L8~29 `DEFAULT_EDITOR_PREFS`(L16 `edit.lineSpacing: 1.0`), L55~67 `loadEditorPrefs`(카테고리 한 단계 병합), L69~83 `saveEditorPrefs`/`setEditorPref`.
- `web/src/view/editorPrefs.test.js` — L78~130(edit 기본값·부분병합·라운드트립 테스트).
- `web/src/view/EditorPrefsDialog.jsx` — L49~50(`EDIT_LINE_SPACINGS`), L100~133(폼 상태 seed), L163~224(`apply` — **edit 카테고리 전체를 항상 저장**, L206 `lineSpacing: Number(lineSpacing)`), L329~341(줄간격 select).
- `web/src/view/EditorPrefsDialog.test.jsx` — L324~525(편집 탭 표시·저장), L461~476(기본값 리셋), L650~680·L885~915(lineSpacing 포함 저장) 등 lineSpacing 관련 전부.

## 배경 (자기완결 — 이전 대화 참조 없이 여기서 이해하라)

핵심 문제 두 가지:

1. **기본값 불일치**: store 기본 `lineSpacing = 1.0`인데, 에디터 줄 CSS는 `line-height: 1.8`(하드코딩, `web/src/styles/yonhap.css` L507)이다. 값을 그대로 line-height로 쓰면 손댄 적 없는 기본 상태에서 1.8→1.0으로 줄이 촘촘해진다 = 시각 회귀.
2. **레거시 sentinel 오염**: `EditorPrefsDialog.apply()`는 '적용' 시 edit 카테고리 **전체**(`lineSpacing` 포함, L199~208)를 항상 저장한다. dialog의 edit 상태는 열 때 `loadEditorPrefs().edit`(현재 기본 1.0)로 seed되므로, **색만 바꿔 '적용'한 사용자도 localStorage에 `edit.lineSpacing = 1.0`이 박혀 있다**. 즉 "저장된 1.0"은 흔한 상태이지 예외가 아니다. 따라서 기본값만 1.8로 바꾸는 것으로는 부족하고, 저장된 레거시 1.0을 base로 중화해야 한다.

### 결정 (이 값 해석을 못박는다)

- `edit.lineSpacing`은 **CSS line-height 직접값(unitless number)**으로 해석한다. 옵션 `1.8`이 곧 현재 CSS와 같다는 점이 이 해석의 근거다.
- 옵션 집합을 `[1.2, 1.5, 1.8, 2.0]`으로 하고, **`1.0`을 제거**한다. 이유: (a) line-height 1.0(줄이 붙음)은 신문 본문 편집에 무의미하고, (b) 1.0이 레거시 기본 sentinel과 충돌하기 때문이다. news.md는 수치를 명시하지 않으므로 옵션 조정은 재량 범위다.
- **base(기본이자 정규화 기준값) = 1.8**. 레거시/무효 저장값(1.0 이하·비유한)은 소비 시점에 1.8로 정규화하고, 유효 선택값(1.2/1.5/1.8/2.0)은 그대로 통과시킨다.
- `1.0` 제거와 "1.0→1.8 정규화"는 **한 쌍**이다: 정규화만 하고 옵션에 1.0을 남기면 "1.0을 골라도 1.8이 되는" 거짓 컨트롤이 된다.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### 1. `web/src/view/editorPrefs.js`

- 단일 출처 상수 도입: `const BASE_LINE_HEIGHT = 1.8;`
- `DEFAULT_EDITOR_PREFS.edit.lineSpacing`을 `1.0` → `1.8`(= `BASE_LINE_HEIGHT`)로 변경. 나머지 edit 키(columnLimit/dragDrop/…)는 불변.
- 순수 export 함수를 추가한다(시그니처 고정, 구현은 재량):

  ```js
  // 저장된 줄간격을 실제 CSS line-height(unitless number)로 정규화한다.
  // 레거시 기본 sentinel(1.0)과 무효값(비유한·≤1.0)은 base(1.8)로, 유효 선택값은 Number로 통과.
  export function normalizeLineSpacing(value) // -> number
  ```

  **못박는 규칙**: `const n = Number(value); if (!Number.isFinite(n) || n <= 1.0) return BASE_LINE_HEIGHT; return n;` (과대값 상한 clamp는 재량이나, 네 옵션값 1.2/1.5/1.8/2.0은 반드시 그대로 반환해야 한다). 문자열 입력(`'1.5'`)도 `Number()`로 받아 처리한다 — dialog select의 onChange가 문자열을 저장하기 때문.
- **`loadEditorPrefs`의 병합에는 normalize를 넣지 마라**(store는 raw를 유지). 정규화는 소비 시점(step1의 WriterPage, 그리고 아래 dialog 표시)에서만 한다.

### 2. `web/src/view/EditorPrefsDialog.jsx`

- L50 `EDIT_LINE_SPACINGS`를 `[1.0, 1.2, 1.5, 1.8, 2.0]` → `[1.2, 1.5, 1.8, 2.0]`로(1.0 제거).
- 줄간격 select(L334)의 표시값을 정규화한다: `value={normalizeLineSpacing(edit.lineSpacing)}`. `normalizeLineSpacing`을 `./editorPrefs.js`에서 import하라. 이유: 레거시 저장 1.0이 옵션에 없어 select가 빈 값으로 보이는 것을 막고, 표시값을 실제 적용될 값(1.8)과 일치시킨다.
- onChange(L335)와 `apply`의 `lineSpacing: Number(lineSpacing)`(L206)은 **그대로 둔다**(문자열 저장→Number 변환 유지).

### 3. 테스트

수정(단언 갱신):
- `web/src/view/editorPrefs.test.js` L88 `expect(edit.lineSpacing).toBe(1.0)` → `toBe(1.8)`.
- `web/src/view/EditorPrefsDialog.test.jsx` L518 주석의 `기본 lineSpacing(1.0)` → `(1.8)`, L524 `expect(edit.lineSpacing).toBe(1)` → `toBe(1.8)`(폼 미변경 '적용'이 새 기본 1.8을 저장). **L517 `it(...)` 제목의 `기본 1.0이 숫자 1로 영속된다` 문구도 `기본 1.8이 영속된다`로 정정하라(제목은 통과에 무관하나 갱신 후 거짓이 되면 안 됨 — ② 검토 minor 1).**

추가(신규 단언):
- `editorPrefs.test.js`에 `normalizeLineSpacing` 테스트: `1.0 → 1.8`, `0/-1/NaN/undefined/'x' → 1.8`, `1.2/1.5/1.8/2.0` 그대로, `'1.5'(문자열) → 1.5`.

확인만(자기조정 — 수정 불필요, 통과하는지 검증):
- `editorPrefs.test.js` L82 `expect(edit).toEqual(DEFAULT_EDITOR_PREFS.edit)`(상수 비교라 자동 반영), L84 dragDrop 등 다른 키 단언.
- `EditorPrefsDialog.test.jsx` L461~476 리셋 테스트(`toHaveValue(String(d.lineSpacing))` — d.lineSpacing이 1.8이 되어 `'1.8'` 기대, 1.8은 옵션에 존재).
- `EditorPrefsDialog.test.jsx` L354~366·L423~435·L650~680·L885~915(유효값 1.5/2.0 라운드트립 — 통과 규칙상 불변).
- `EDIT_LINE_SPACINGS`에서 1.0 제거가 옵션 개수/1.0 존재를 단언하는 테스트를 깨지 않는지 grep으로 확인(현재 그런 단언 없음 — 재확인하라).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(이 phase는 백엔드 무관 — `npm test`(node --test)는 실행 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - ADR-003 준수 — editorPrefs/EditorPrefsDialog는 view 모듈이며 서버 호출을 추가하지 않았는가?
   - `web/src/styles/yonhap.css`, `web/src/view/WriterPage.jsx`, `web/src/view/Editor.jsx`를 건드리지 않았는가?(이 step 범위 밖 — step1)
   - CLAUDE.md: DB 무관·client 전용이며 UTF-8로 저장했는가?
3. 결과에 따라 `phases/33-editor-linespacing-effect/index.json`의 step0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (기본 1.8·옵션 [1.2,1.5,1.8,2.0]·`normalizeLineSpacing` 시그니처와 1.0→1.8 규칙·수정한 테스트)를 한 줄로 요약.
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.

## 금지사항

- `web/src/styles/yonhap.css`·`web/src/view/WriterPage.jsx`·`web/src/view/Editor.jsx`를 건드리지 마라. 이유: 이 step은 값 계약만 담당한다. 렌더 반영은 step1이며, 한 step에 여러 레이어를 섞으면 실패 원인 격리가 불가능해진다.
- `loadEditorPrefs`의 병합에 `normalizeLineSpacing`을 주입하지 마라. 이유: store가 raw 저장값을 잃으면 정확값 라운드트립 테스트(1.5 등)와 dialog 상태 seed가 오염된다. 정규화는 소비 시점에서만 한다.
- 옵션에 1.0을 남긴 채 1.0→1.8 정규화만 하지 마라. 이유: 사용자가 '1.0'을 선택해도 1.8이 되는 거짓 컨트롤이 된다(옵션 제거와 정규화는 한 쌍).
- 유효값(1.5/2.0) 라운드트립 테스트의 기대값을 바꾸지 마라. 이유: 유효 선택값은 정규화에서 그대로 통과하므로 회귀가 없어야 한다 — 바꾸면 계약이 훼손된다.
- 기존 테스트를 깨뜨리지 마라.
