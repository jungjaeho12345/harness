# Step 0: memo-store — 메모장 내용 영속 모듈 (editorMemo.js)

## 배경 / 요구사항

에디터 도구의 미결선 항목 '메모장'(`tools.memo` / 툴바 `tool.memo`)을 결선하는 phase의 첫 step.
메모장은 **본문을 건드리지 않는 순수 스크래치패드**다 — 기자가 취재 메모를 적어두는 별도 패널이며, 그 내용은 세션을 넘어 유지되어야 한다.

이 step은 그 **영속 계층만** 만든다(UI/결선은 후속 step). 메모 텍스트를 client localStorage에 저장/로드하는 순수 모듈 `editorMemo.js`를 TDD로 추가한다.

### 설계 결정 — 왜 editorPrefs가 아닌 전용 모듈인가 (근거를 반드시 반영)

메모 내용은 editorPrefs(`DEFAULT_EDITOR_PREFS`)의 구조적 설정값이 아니라 **매 타이핑마다 바뀌는 자유 텍스트**다. editorPrefs는 환경설정 다이얼로그가 열릴 때 로드되고 '적용'(`onPrefsClose(true)`) 시 통째로 다시 쓰이는 게이트를 갖는다 — 메모 텍스트를 그 shape에 끼우면 (1) 환경설정 적용/취소 게이트와 결합되어 메모가 취소로 되돌려지거나 (2) 매 키 입력마다 prefs 전체를 재직렬화하게 된다. 따라서 메모는 `editorDraft.js`(localStorage 초안 게이트)와 같은 **독립 localStorage 모듈**로 둔다. editorPrefs 파일은 이 step에서 **수정하지 않는다**.

## 읽어야 할 파일

- `/CLAUDE.md`(DB 비파괴·TDD·UTF-8), `/docs/ARCHITECTURE.md`(프론트 MVC — View는 순수, client 전용), `/docs/ADR.md`(ADR-003).
- `web/src/view/editorPrefs.js` — **패턴 참고(수정 금지)**. `readAll()`/`saveEditorPrefs()`의 `try/catch` + `globalThis.localStorage?.` graceful 처리, `STORAGE_KEY` 상수 방식을 그대로 따른다.
- `web/src/view/editorPrefs.test.js` — 테스트 스타일(localStorage 스텁, graceful 경로 검증) 참고.
- `web/src/view/editorDraft.js` (있으면) — 자유 텍스트/타임스탬프를 localStorage에 저장하는 동류 모듈 패턴 참고.

## 작업

TDD. 먼저 `web/src/view/editorMemo.test.js`를 **실패하는 테스트**로 작성한 뒤, 통과하는 최소 구현 `web/src/view/editorMemo.js`를 만든다.

### `editorMemo.js` 시그니처 (구현은 재량, 계약은 고정)

```js
// localStorage 키(전용 — editorPrefs와 분리)
const STORAGE_KEY = 'yh.editorMemo';

// 저장된 메모 텍스트를 반환. 없거나 파싱 불가면 '' 반환.
export function loadMemo(): string

// 메모 텍스트를 저장. text는 문자열. localStorage 불가 시 graceful no-op. 저장한 text를 반환.
export function saveMemo(text: string): string
```

- 저장 형식은 재량(문자열 그대로 또는 `{ text }` JSON). 단 `loadMemo`/`saveMemo`가 왕복 일관성을 가져야 한다.
- `globalThis.localStorage?.` 옵셔널 체이닝 + `try/catch`로 localStorage 미지원/예외 환경에서 절대 throw하지 않는다(editorPrefs와 동일 견고성).
- 이 모듈은 **순수 client 저장만** 한다 — `fetch`/`model`/`document`/React import 금지.

## 핵심 규칙 (반드시 준수)

1. **client 전용·DB 무관**: `server/`·마이그레이션·스키마를 건드리지 않는다. localStorage만 사용한다. 이유: 메모장은 client 스크래치패드로 확정됐다.
2. **editorPrefs 미수정**: `editorPrefs.js`의 `DEFAULT_EDITOR_PREFS`/`loadEditorPrefs`에 memo 키를 추가하지 마라. 전용 모듈로 분리한다. 이유: 위 설계 결정(적용/취소 게이트 결합·재직렬화 회피).
3. **graceful**: localStorage가 없거나 예외를 던져도 throw하지 않는다(`loadMemo`→`''`, `saveMemo`→no-op 후 text 반환). 이유: SSR/테스트/프라이빗모드 환경 견고성.
4. **UTF-8**: 파일은 UTF-8로 저장한다.

## Acceptance Criteria

```bash
npm run test:web   # editorMemo.test.js 포함 web 전체 통과
npm run build      # vite 빌드 에러 없음
npm run lint       # ESLint 통과(미사용 심볼 없음)
```

추가 단언(`editorMemo.test.js`):
- 초기 상태(저장값 없음)에서 `loadMemo()`가 `''`를 반환한다.
- `saveMemo('취재 메모')` 후 `loadMemo()`가 `'취재 메모'`를 반환한다(왕복 일관성).
- 빈 문자열 저장/로드가 정상 동작한다.
- localStorage가 없는(또는 throw하는) 스텁에서 `loadMemo()`가 `''`를 반환하고 `saveMemo()`가 throw하지 않는다.

## 검증 절차

1. 위 AC 커맨드를 실행한다(테스트가 먼저 red였다가 구현 후 green이 되는 흐름 확인).
2. 아키텍처 체크: `editorMemo.js`에 `fetch`/`model`/`document`/React import가 없음, `editorPrefs.js` diff 없음, `server/`·DB 미변경.
3. 결과에 따라 `phases/21-editor-tools-memo/index.json`의 step 0을 갱신한다(completed+summary / error / blocked).

## 금지사항

- `editorPrefs.js`에 memo 필드를 추가하지 마라. 이유: 적용/취소 게이트 결합·매 키 재직렬화 회피(전용 모듈로 분리).
- `server/`·스키마·마이그레이션을 건드리지 마라. 이유: 메모장은 client 전용이며 DB 비파괴가 불변 규칙이다.
- localStorage 접근을 옵셔널 체이닝/try-catch 없이 직접 하지 마라. 이유: 미지원 환경에서 throw하면 에디터 전체가 깨진다.
