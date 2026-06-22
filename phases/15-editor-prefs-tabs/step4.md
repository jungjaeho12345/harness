# Step 4: column-limit-apply — 편집>컬럼제한 effect를 WriterPage 래퍼 레벨에서 적용

## 배경 / 요구사항

step1에서 편집(edit) 탭에 **컬럼제한**(`edit.columnLimit`, bool) 설정이 추가되어 localStorage에 저장된다. news.md L185: "컬럼제한 : 에디터의 좌우 여백이 10%씩 줄어든다." 이 step은 그 설정을 **실제로 적용**한다 — 단, **Editor.jsx 내부는 절대 건드리지 않고**, `WriterPage.jsx`의 에디터 캔버스 래퍼(`yh-writer__canvas`, 이미 `editorBg`를 입히는 그 컨테이너) 레벨에서 **좌우 여백(padding)만** 입힌다.

이것이 이 phase에서 결선하는 **유일한 effect**다(다른 편집/맞춤법/약물 설정 effect는 후속 phase로 defer — 각 step의 DEFERRED EFFECTS 참조). 컬럼제한은 래퍼 레벨 inline style로 안전하게 적용 가능하고, 기존 `editorBg` 적용이 동일한 패턴(래퍼 style + `loadEditorPrefs()` 주입 + `onPrefsClose(true)` 게이트)을 이미 확립했기에 위험이 낮다.

해석(이 파일이 단일 출처): `columnLimit === true`이면 에디터 캔버스 좌우 여백을 각 **10%** 준다(좌우 padding 10%씩). `false`이면 여백 0(또는 기존 기본). 위/아래 여백은 건드리지 않는다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 컴포넌트, ADR-003.
- `/docs/news.md` L185(컬럼제한 정의).
- `phases/15-editor-prefs-tabs/step1.md` — `edit.columnLimit` 설정·저장 형태(bool).
- `web/src/view/editorPrefs.js` — **step0 결과**. `loadEditorPrefs().edit.columnLimit`.
- `web/src/view/WriterPage.jsx` — **변경 대상**. **반드시 정독하라.** 특히:
  - `const [editorBg, setEditorBg] = useState(() => loadEditorPrefs().colors.background);` — 동일 패턴으로 `columnLimit` 상태를 둔다.
  - 마운트 `useEffect([])` — 저장값을 마운트 시 적용하는 곳(색 + editorBg). **여기서 columnLimit도 초기 적용.**
  - `onPrefsClose(applied)` — `applied===true`일 때만 저장값으로 갱신하는 게이트(editorBg·autosaveCfg와 동일). **여기에 columnLimit 갱신을 추가.**
  - `<div className="yh-writer__canvas" ... style={{ backgroundColor: editorBg }} ...>` — Editor를 감싸는 래퍼. **이 style에 좌우 padding을 추가**(별도 래퍼 신설 불필요 — 기존 캔버스 래퍼 재사용).
- `web/src/view/WriterPage.test.jsx` — **변경 대상**(신규 단언 추가). WriterPage 렌더/상호작용 테스트 패턴. 기존 editorBg/자동저장 테스트가 어떻게 모달 적용을 시뮬레이트하는지 참고.

## 작업

TDD로 진행한다(vitest + @testing-library/react). **테스트를 먼저 쓰고 통과시킨다.**

### 1. columnLimit 상태 + 마운트 적용 + 모달 게이트 (editorBg 패턴 미러)

- `const [columnLimit, setColumnLimit] = useState(() => loadEditorPrefs().edit.columnLimit);` (editorBg 옆).
- 마운트 `useEffect([])`(이미 색·editorBg를 적용하는 곳)에 `setColumnLimit(loadEditorPrefs().edit.columnLimit);` 추가(새로고침 후에도 반영).
- `onPrefsClose(applied)`의 `if (applied)` 블록에 `setColumnLimit(loadEditorPrefs().edit.columnLimit);` 추가(적용 시에만 갱신 — 취소 시 불변, editorBg와 동일 게이트).

### 2. 캔버스 래퍼 style에 좌우 여백 결선

`yh-writer__canvas` div의 `style`에 좌우 padding을 합친다. 예:

```jsx
style={{
  backgroundColor: editorBg,
  ...(columnLimit ? { paddingLeft: '10%', paddingRight: '10%' } : null),
}}
```

- `columnLimit` false면 좌우 padding을 주지 않는다(기존 레이아웃 유지).
- 위/아래(top/bottom) 여백은 손대지 않는다.
- inline style 대신 className 토글(`yh-writer__canvas--column-limit`)을 쓰고 CSS에서 padding을 주는 방식도 허용한다. 그 경우 테스트는 className 존재로 단언한다. **둘 중 하나만 일관되게 택한다.**

### 3. (스타일 CSS 보강 — 선택)

className 방식을 택했다면 해당 클래스의 좌우 padding 10% 규칙을 스타일시트에 추가한다(정적 — 사용자 값 무관).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **Editor.jsx 절대 무변경**: 본문/캐럿/IME/remount 불변식을 건드리지 마라. 여백은 **에디터 바깥 캔버스 래퍼** 레벨에서만 준다. `<Editor>`에 새 prop을 추가하지 마라.
2. **기존 적용 패턴 미러**: columnLimit은 `editorBg`와 정확히 같은 결선(마운트 적용 + `onPrefsClose(applied===true)` 게이트). 새로운 effect/타이머/리스너를 만들지 마라. 모달 취소(`applied===false`) 시 적용이 바뀌지 않아야 한다.
3. **좌우 여백만**: 위/아래 여백·에디터 내부 레이아웃·배경색 로직을 바꾸지 마라(editorBg는 그대로 유지).
4. **이 phase 유일 effect**: columnLimit만 결선한다. 같은 phase의 dragDrop/language/lineSpacing/inputMode/맞춤법/약물 effect는 결선하지 마라(후속 phase).
5. **store 시그니처 불변**: `editorPrefs.js`·`EditorPrefsDialog.jsx`를 수정하지 마라(이 step은 WriterPage + 그 테스트만 만진다).

## Acceptance Criteria

```bash
npm run test:web && npm run build && npm run lint
```

추가 단언(`WriterPage.test.jsx`, vitest):
- `localStorage`에 `edit.columnLimit: true`를 저장한 상태로 WriterPage를 렌더하면 에디터 캔버스(`editor-canvas` testid)가 좌우 여백을 반영한다(inline style의 `paddingLeft`/`paddingRight`가 `'10%'`, 또는 className `yh-writer__canvas--column-limit` 존재 — 택한 방식에 맞춰 단언).
- `edit.columnLimit: false`(기본)면 좌우 여백이 적용되지 않는다(padding 없음 / 클래스 없음).
- editorBg 적용이 columnLimit과 무관하게 그대로 동작한다(배경색 회귀 없음).
- **회귀**: 기존 WriterPage 테스트 전부 통과(자동저장 타이머·복구·송고 가드·메뉴·찾기/바꾸기 등 불변).
- **Editor 불변식 회귀**: Editor 관련 기존 테스트(타이핑/캐럿/임베드/remount) 전부 통과.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크: ADR-003(WriterPage의 `loadEditorPrefs`는 view 모듈 호출 — 서버 아님, editorBg 선례와 동일) / Editor.jsx 무변경 / 기존 WriterPage·Editor 테스트 회귀 없음 / DB 비파괴(무관).
3. `phases/15-editor-prefs-tabs/index.json`의 step 4를 갱신한다(성공 → `completed` + `summary` / 3회 실패 → `error` + `error_message` / 개입 필요 → `blocked` + `blocked_reason`).

## DEFERRED EFFECTS

이 step은 컬럼제한 1건만 래퍼 레벨로 적용한다. 같은 phase에서 저장만 된 다음 effect는 **후속 phase**로 명확히 연기한다:
- 편집>드래그앤드롭(이미지 D&D 허용) — Editor 입력/드롭 핸들러 변경 필요.
- 편집>언어·줄간격·입력모드(KSC-5601/Unicode)·공용약어/기업코드 — Editor 본문/IME 로직 변경 필요.
- 맞춤법 검사 실행·오류 하이라이트 — 검사 엔진 + Editor 본문 마크업.
- 약물 입력/약물바/키조합 — aux-tools.

이들은 **Editor.jsx 내부 또는 IME/입력 경로**를 건드려야 하므로 본 phase(환경설정 UI + 안전한 래퍼 effect 1건) 범위 밖이다.

## 금지사항

- **Editor.jsx를 수정하지 마라.** 이유: 타이핑/IME/캐럿/remount 불변식이 깨지면 에디터 전체가 회귀한다. 여백은 바깥 래퍼에서만.
- `<Editor>`에 새 prop을 추가하지 마라(여백은 래퍼 style/className으로만).
- editorBg·배경색 로직·위/아래 여백을 바꾸지 마라(좌우 여백만 추가).
- 모달 취소(`applied===false`) 시 columnLimit 적용을 바꾸지 마라(editorBg 게이트와 동일 — 적용 시에만 갱신).
- columnLimit 외 다른 편집/맞춤법/약물 설정의 effect를 결선하지 마라(후속 phase).
- `editorPrefs.js`·`EditorPrefsDialog.jsx`를 수정하지 마라(이 step은 WriterPage + 테스트만).
- 새 effect/타이머/이벤트 리스너를 만들지 마라(마운트 적용 + 모달 게이트 = editorBg 패턴 그대로).
- 기존 테스트를 깨뜨리지 마라.
