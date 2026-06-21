# Step 0: editorcoloring-configurable — 에디터 색상 사용자 설정화 (editorColoring 인자화)

## 배경 / 요구사항

`docs/news.md` "# 에디터 환경설정 > 색상": 제목색/부제목색/본문색/바탕색을 사용자 RGB로 설정. 현재 `editorColoring.js`의 `COLORS`는 하드코딩(frozen)이고 `Editor.jsx`가 `colorForRole(role)`로 직접 색을 칠한다(L471).

이 step은 **`colorForRole`가 사용자 색을 읽도록 인자화**하되 **`Editor.jsx`는 건드리지 않는다**. 방법: editorColoring에 module-level `activeColors`(기본=`COLORS`)와 setter를 두고, `colorForRole`가 `activeColors`를 읽게 한다. 기본값이 `COLORS`와 동일하므로 **기존 색상 동작·테스트는 불변**이다. 색을 적용하는 UI는 Step 1.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md`
- `/docs/news.md` — "# 에디터 환경설정 > 색상"(제목/부제목/본문/바탕)
- `web/src/view/editorColoring.js` — `COLORS`(title `#0a4da6`/subtitle `#c8102e`/body `#1a1a1a`/end `#d4af37`), `colorForRole(role)`(L32, `COLORS[role] ?? COLORS.body`), `classifyLines`, `colorLines`. **여기를 인자화**한다.
- `web/src/view/Editor.jsx` — `colorForRole`를 import해 L471 `style={{ color: colorForRole(role) }}`로 칠한다. **이 파일은 수정하지 마라** — colorForRole 시그니처를 `colorForRole(role)` 그대로 유지하고 내부에서 activeColors를 읽게 한다.
- `web/src/view/editorColoring.test.js` — 기존 색상 단언(기본 COLORS 기준). 기본값 불변이라 통과해야 하며, 신규 setter 테스트를 추가한다.
- `web/src/view/editorPrefs.js` — `DEFAULT_EDITOR_PREFS.colors`(phase 10). 색 키(title/subtitle/body/end/background)와 정합.

## 작업

TDD로 진행한다(vitest).

### 1. `editorColoring.js` 인자화

```js
// 기본 색(불변 — 리셋/폴백 기준).
export const COLORS = Object.freeze({ title:'#0a4da6', subtitle:'#c8102e', body:'#1a1a1a', end:'#d4af37' });

// 현재 적용 색(module-level 가변 사본, 기본 {...COLORS}). setEditorColors로만 바뀐다.
// CRITICAL: activeColors는 COLORS 자체가 아니라 {...COLORS} 가변 사본이어야 한다 — COLORS는 Object.freeze라 직접 mutate하면 throw.
export function setEditorColors(colors)   // colors의 텍스트 색 키(title/subtitle/body)만 현재값 위에 병합. 그 외(background/end/unknown) 무시.
export function resetEditorColors()        // 현재 적용 색을 {...COLORS}로 되돌린다.
export function colorForRole(role)         // 현재 적용 색에서 role 색을 반환(없으면 body). 시그니처·동작은 기존과 동일(인자 1개).
```

규칙:
- `colorForRole(role)`은 **시그니처를 바꾸지 마라**(`Editor.jsx`가 `colorForRole(role)`로 호출). 내부에서 module-level 현재 색을 읽는다. `colorForRole('end')`는 여전히 `COLORS.end`(골드)를 반환한다(activeColors가 end도 포함하므로).
- `setEditorColors(partial)`: **화이트리스트는 `title`/`subtitle`/`body` 3키만**(news.md 색상 = 제목/부제목/본문/바탕 중 텍스트 색 3개). `background`는 텍스트 색이 아니므로 무시(바탕색 적용은 Step 1에서 WriterPage가 처리). `end`("(끝)" 골드)는 사용자 설정 대상이 아니므로 setEditorColors로 바꾸지 않는다(폴백/기본 유지).
- 기본 상태(setEditorColors 미호출)에서 `colorForRole`은 기존과 100% 동일한 값을 반환해야 한다(`COLORS`).
- **module 상태 누수 방지**: 테스트는 `afterEach(resetEditorColors)`로 매 케이스 후 activeColors를 되돌려야 한다(아래 AC·검증절차 — '권장' 아니라 '필수').
- `classifyLines`/`colorLines`/`shouldRecolor` 등 나머지는 변경 없음.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **Editor.jsx 무변경**: `colorForRole(role)` 시그니처·호출부를 바꾸지 마라. 색은 module-level 현재 상태로만 갈아끼운다.
2. **기본값 불변**: setEditorColors 미호출 시 `colorForRole`은 `COLORS` 그대로(부제목 빨강 `#c8102e`). 기존 editorColoring/Editor 색 테스트가 깨지면 안 된다.
3. **순수 외 최소 상태**: module-level 현재 색 1개만 두고, setter/reset/colorForRole 외에는 부수효과를 만들지 마라. localStorage/DOM 접근 금지(영속은 editorPrefs, 적용은 Step 1).
4. **알려진 키만**: setEditorColors는 화이트리스트(title/subtitle/body/end) 키만 병합한다.

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (기본값 불변 + setEditorColors/reset 단언)
npm run build
npm run lint
```

추가 단언(vitest):
- 기본: `colorForRole('subtitle')==='#c8102e'`, `colorForRole('title')==='#0a4da6'`, `colorForRole('body')==='#1a1a1a'`(기존 불변).
- `setEditorColors({ subtitle:'#000000' })` 후 `colorForRole('subtitle')==='#000000'`이고 `colorForRole('title')`은 불변. `resetEditorColors()` 후 다시 `#c8102e`.
- `setEditorColors({ unknown:'#fff' })`·`setEditorColors({ background:'#000000' })`·`setEditorColors({ end:'#000000' })`는 colorForRole 결과에 영향 없음(화이트리스트 title/subtitle/body만).
- **`afterEach(() => resetEditorColors())` 필수** — module-level activeColors가 케이스 간 누수되지 않게(이게 없으면 기본값 불변 단언이 앞선 setEditorColors에 오염됨).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: editorColoring view 모듈, Editor.jsx 무변경, 기본값 불변, 범위 준수.
3. 결과에 따라 `phases/11-editor-color-prefs/index.json`의 step 0을 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "editorColoring 인자화(activeColors·setEditorColors·resetEditorColors·colorForRole 현재색 읽기, 기본 COLORS 불변) 요약"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- `Editor.jsx`를 수정하지 마라(색은 module 상태로 갈아끼운다 — colorForRole 시그니처 불변).
- `colorForRole`의 인자/반환 형태를 바꾸지 마라(Editor 호출부 회귀).
- 색 적용 UI/모달/WriterPage 결선/localStorage 접근을 이 step에서 하지 마라(Step 1).
- 기본 색을 바꾸지 마라(부제목 빨강 유지 — 결정사항).
- 기존 테스트를 깨뜨리지 마라.
