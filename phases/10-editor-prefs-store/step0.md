# Step 0: editor-prefs-store — 에디터 환경설정 영속 모듈 (localStorage)

## 배경 / 요구사항

`docs/news.md` "# 에디터 환경설정"이 편집/자동저장/색상/바이라인/날짜형식/약물/맞춤법 설정을 정의한다. 이 설정들을 세션을 넘어 유지하기 위한 **영속 모듈**(localStorage)을 만든다 — 이것이 후속 환경설정 phase(색상/자동저장/바이라인/날짜형식/다이얼로그)의 공통 기반이다.

이 phase는 **영속 모듈(순수)만** 만든다. 각 설정의 UI/실제 적용(에디터 색상 반영 등)은 후속 phase다. 서버 DB 변경 없음(클라이언트 UI 환경설정 — `columnConfig.js`와 동일 철학).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 레이어, 단순화, DB 비파괴(이 phase는 서버 무관)
- `/docs/news.md` — "# 에디터 환경설정" 절(색상/자동저장/바이라인/날짜형식 등 카테고리)
- `web/src/view/columnConfig.js` — **이 모듈의 본보기**. `STORAGE_KEY`, `defaultColumnConfig`, `readAll`(try/catch JSON), `loadColumnConfig`(기본값 위 병합), `saveColumnConfig`, 순수 업데이트 헬퍼(`toggleColumn`/`setGap`), `Object.freeze` 기본값 — 같은 패턴·같은 견고성(localStorage 불가 시 graceful)으로 만든다.
- `web/src/view/columnConfig.test.js` — vitest 단위 테스트 패턴(load 기본값/병합/save round-trip).
- `web/src/view/editorColoring.js` — `COLORS`(title `#0a4da6`, subtitle `#c8102e`, body `#1a1a1a`, end `#d4af37`). **색상 기본값을 이 값과 일치**시킨다(후속 color-prefs가 editorColoring을 사용자 색으로 인자화할 때 기준).

## 작업

TDD로 진행한다(vitest). **web 테스트는 vitest** — node:test 아님.

### 1. `web/src/view/editorPrefs.js`

`columnConfig.js`와 동일한 패턴으로 만든다:

```js
const STORAGE_KEY = 'yh.editorPrefs';

export const DEFAULT_EDITOR_PREFS = Object.freeze({
  colors: { title: '#0a4da6', subtitle: '#c8102e', body: '#1a1a1a', end: '#d4af37', background: '#ffffff' },
  autosave: { enabled: false, intervalSec: 60, retentionDays: 1 },
  byline: { email: false, blog: false },
  dateFormat: 'YYYY-MM-DD HH:mm',
});

export function loadEditorPrefs()            // 저장값을 기본값 위에 "한 단계 깊이" 병합해 반환(새 키도 기본값 노출).
export function saveEditorPrefs(prefs)        // localStorage 저장(불가 시 graceful no-op), prefs 반환.
export function setEditorPref(prefs, category, patch) // 순수: 해당 category 객체를 patch로 얕은 병합한 새 prefs 반환.
```

규칙:
- `loadEditorPrefs`: `readAll`(try/catch)로 저장 객체를 읽고, **카테고리별로 기본값 위에 병합**한다. 즉 `colors`/`autosave`/`byline`은 `{ ...DEFAULT.colors, ...(saved.colors||{}) }` 식으로 병합(부분 저장도 안전, 새로 추가된 키는 기본값 노출). `dateFormat` 같은 원시값은 저장값 있으면 그대로, 없으면 기본값.
- `saveEditorPrefs`: `globalThis.localStorage?.setItem(...)`를 try/catch로 감싼다(localStorage 불가 환경에서 throw 금지 — `columnConfig`와 동일).
- `setEditorPref(prefs, 'colors', { subtitle:'#000000' })` → `colors`만 얕은 병합된 **새 객체**(입력 mutate 금지). 알 수 없는 category면 변경 없이 그대로 반환.
- 모든 함수 순수/graceful — DOM/네트워크 비의존, localStorage 접근은 try/catch.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **graceful 영속**: localStorage 접근(read/write)은 반드시 try/catch — 없거나 throw해도 기본값/no-op로 진행한다(`columnConfig` 동일). 이유: SSR/프라이버시 모드/jsdom에서 깨지면 안 됨.
2. **순수 업데이트**: `setEditorPref`는 입력 prefs를 mutate하지 말고 새 객체를 반환한다.
3. **색상 기본값 일치**: `colors`는 `editorColoring.COLORS`와 동일 값으로 시드한다(+background 신규). 이유: 후속 color-prefs가 이 기본값으로 폴백한다.
4. **서버 무관**: 이 모듈은 클라이언트 localStorage만 쓴다 — `model`/fetch/서버를 부르지 마라.
5. **범위**: 이 phase는 store만. 각 설정의 UI/적용(색상 반영·자동저장 타이머 등)을 구현하지 마라(후속 phase).

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (editorPrefs 단위 테스트 포함)
npm run build
npm run lint
```

추가 단언(vitest):
- `loadEditorPrefs()`가 저장값 없을 때 `DEFAULT_EDITOR_PREFS`와 동등(colors/autosave/byline/dateFormat).
- 부분 저장(`{ colors: { subtitle: '#000000' } }`) 후 `loadEditorPrefs()`는 `colors.subtitle==='#000000'`이고 `colors.title`은 기본값 유지(병합).
- `saveEditorPrefs` → `loadEditorPrefs` round-trip이 값을 보존.
- `setEditorPref(prefs, 'colors', { body:'#222' })`는 `colors.body` 변경된 새 객체를 반환하고 원본 prefs는 불변(mutate 없음).
- localStorage가 없거나 throw해도(`loadEditorPrefs`/`saveEditorPrefs`) 예외 없이 동작(기본값/no-op).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: view 순수 모듈, ADR 위반 없음, 서버 무관, 범위 준수.
3. 결과에 따라 `phases/10-editor-prefs-store/index.json`의 step 0을 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "editorPrefs.js(STORAGE_KEY·DEFAULT_EDITOR_PREFS·loadEditorPrefs 병합·saveEditorPrefs·setEditorPref) 요약"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- 각 설정의 UI/적용(색상 에디터 반영, 자동저장 타이머, 다이얼로그)을 구현하지 마라(후속 phase). 이유: 이 phase는 store 기반만.
- `editorColoring.js`/`Editor.jsx`/`WriterPage.jsx`를 수정하지 마라(색상 인자화는 후속 color-prefs phase).
- 서버/`model`/fetch를 부르지 마라(클라 localStorage만).
- localStorage 접근을 try/catch 없이 하지 마라(환경에 따라 throw).
- 기존 테스트를 깨뜨리지 마라.
