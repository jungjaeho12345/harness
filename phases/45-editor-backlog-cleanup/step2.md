# Step 2: overwrite-surrogate

## 목표

**수정(overwrite) 모드**에서 캐럿 뒤 문자를 덮어쓸 때, astral 문자(이모지 등 서로게이트 페어)를 **반쪽만 덮어쓰는** 결함을 수정한다. 원인은 `extendSelectionForOverwrite`(WriterPage.jsx)가 `sel.extend(node, anchorOffset + 1)` — **UTF-16 코드유닛 1개**만 확장하기 때문이다. 이모지는 2 코드유닛(high+low 서로게이트)이라 +1은 high 서로게이트만 선택 → 네이티브 입력이 반쪽만 대체 → 깨진 문자.

수정 = 순수 헬퍼 `overwriteExtendLength(text, offset)`(1 또는 2 반환)를 만들어 서로게이트 페어면 2 코드유닛을 확장한다. `convertSimpTrad`가 코드포인트 단위(`Array.from`/`for...of`)로 순회해 서로게이트를 온전히 다룬 선례와 동형(서로게이트 인지).

변경 대상: `web/src/view/editorNewline.js`(순수 헬퍼 추가) + `web/src/view/WriterPage.jsx`(`extendSelectionForOverwrite`에서 헬퍼 사용). DOM selection 조작은 얇게, 판정은 순수 함수로.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003). `docs/news.md`(수정 모드 = 캐럿 뒤 글자 대체).
- `phases/44-editor-gap-closeout/step3.md` — overwrite 타이핑의 권위 출처(에코 경로·순수 판정+얇은 DOM·jsdom 한계). 이 step은 그 `extendSelectionForOverwrite`의 확장 **길이만** 서로게이트-safe로 보강한다.
- `web/src/view/WriterPage.jsx`:
  - **`extendSelectionForOverwrite(root)`(L126~138, 모듈 스코프)**. L135 `if (sel.anchorOffset >= (node.textContent ?? '').length) return;`, **L137 `sel.extend(node, sel.anchorOffset + 1);` ← 수정 대상**(항상 +1 코드유닛). L126~129 주석(같은 텍스트 노드 안에서만 확장·노드 끝이면 삽입 폴백).
  - import 블록 L57 `import { shouldOverwriteNextChar } from './editorNewline.js';` — 여기에 `overwriteExtendLength`를 병합한다.
  - L1197~1201 onKeyDown 덮어쓰기 분기(`shouldOverwriteNextChar(blocksToText(blocks), caret.offset)` true면 `extendSelectionForOverwrite(root)`) — **이 결선은 수정 불필요**(확장 길이는 헬퍼 내부에서 결정).
- `web/src/view/editorNewline.js` — `shouldOverwriteNextChar(text, offset)`(L37 근처, 순수). 여기에 `overwriteExtendLength`를 **동일 파일·동형 스타일**로 추가. `text[i]==='\n'` 등 오프셋 판정 관례를 참고.
- `web/src/view/editorNewline.test.js` — `shouldOverwriteNextChar` 경계 테스트 스타일(L46~95). `overwriteExtendLength` 테스트를 동형으로 추가.
- `web/src/view/WriterPage.test.jsx` — **`describe('WriterPage — 수정(overwrite) 모드 덮어쓰기 타이핑')`(L7529~)**. 헬퍼 `openBody(blocks)`·`toModifyMode(c)`·`caretAt(container, lineIndex, offset)` + `sel.getRangeAt(0).toString()` 단언 관례(L7569~7589). 이모지 케이스를 이 describe에 동형 추가.
- `web/src/view/simpTradConvert.js` `convertSimpTrad`(L24~) — 코드포인트 단위 순회 선례(서로게이트-safe 처리의 권위 참고. import는 하지 마라 — 별개 관심사).

## 배경 (자기완결)

수정 모드 문자 입력 시 흐름: onKeyDown → `shouldOverwriteNextChar(blocksToText, caret.offset)`가 true면 `extendSelectionForOverwrite(root)`가 **collapsed 캐럿을 앞으로 확장** → preventDefault 없이 통과 → 네이티브 입력이 그 선택을 대체(에코 경로로 반영).

이모지 케이스: 본문 `a😀b`에서 캐럿이 이모지 바로 앞(`a|😀b`)일 때 문자 입력. `😀`(U+1F600)는 DOM 텍스트 노드에서 **2 코드유닛**(high `\uD83D` + low `\uDE00`)이다. 현재 `sel.extend(node, anchorOffset + 1)`은 high 서로게이트 1개만 선택 → 네이티브 입력이 그 반쪽만 대체 → 남은 low 서로게이트와 새 글자가 붙어 **깨진 문자**가 된다.

`shouldOverwriteNextChar`는 이미 옳다: `text[offset]`이 high 서로게이트라 `'\n'`이 아니고 마커도 아니어서 true를 반환한다 — **덮어쓰기는 일어나야 한다**. 고칠 것은 오직 **확장 길이**다. `overwriteExtendLength`가 캐럿 뒤가 서로게이트 페어인지 보고 2를, 아니면 1을 반환하면, `extendSelectionForOverwrite`가 그만큼 확장해 온전한 코드포인트를 대체한다. lone(짝 없는) 서로게이트나 문서/노드 끝은 1로 안전 폴백.

## TDD — 테스트 먼저

`web/src/view/editorNewline.test.js`(순수 — 결정적):
- `overwriteExtendLength('a😀b', 1) === 2` — 인덱스 1이 high 서로게이트(😀 시작)라 페어 전체 2 코드유닛.
- `overwriteExtendLength('abc', 1) === 1` — BMP 문자.
- `overwriteExtendLength('가나', 1) === 1` — 한글(BMP) 1 코드유닛.
- `overwriteExtendLength('😀', 0) === 2` — 문자열 시작의 이모지.
- `overwriteExtendLength('a😀', 1) === 2` — 문자열 끝의 이모지(low가 마지막 코드유닛).
- lone high 서로게이트: `overwriteExtendLength('a\uD83Db', 1) === 1`(뒤가 low 서로게이트 아님 → 안전 1).
- lone high가 문자열 끝: `overwriteExtendLength('a\uD83D', 1) === 1`(뒤에 코드유닛 없음).
- 경계/무효: `overwriteExtendLength('abc', 3) === 1`(문서 끝), `('abc', -1) === 1`, `('abc', 1.5) === 1`, `('', 0) === 1`, `(null, 0) === 1`(안전 기본 1 — 확장 자체는 상위 `shouldOverwriteNextChar`/노드 경계 가드가 별도로 막음).

`web/src/view/WriterPage.test.jsx`(overwrite describe에 추가 — 헬퍼 재사용):
- **이모지 온전 확장(핵심 red→green)**: `openBody([textBlock('제목'), textBlock('a😀b')])` → `toModifyMode` → `caretAt(container, 1, 1)`(`a|😀b`, DOM 코드유닛 오프셋 1) → 문자 keydown → `sel.isCollapsed === false`이고 **`sel.getRangeAt(0).toString() === '😀'`**(반쪽 lone 서로게이트 아님). *수정 전에는 high 서로게이트만 선택돼 `'😀'`가 아니라 깨진 1코드유닛이 나와 실패한다.*
- **BMP 회귀 가드**: 기존 L7569(`a|bcd` → 'b' 1글자 확장) 케이스가 그대로 통과(BMP는 여전히 1 코드유닛).

> jsdom은 `window.getSelection().extend`를 지원한다(phase 44 step3에서 확인). 따라서 확장 범위를 `getRangeAt(0).toString()`으로 직접 단언한다. 네이티브 문자 대체(실제 교체)는 jsdom 미실행이라, 경계는 (A) 순수 `overwriteExtendLength` 전수 + (B) selection 확장 범위(코드포인트 온전성)로 커버한다.

## 작업 (구현 상세 — 시그니처 고정)

### 1. `web/src/view/editorNewline.js` — 순수 헬퍼 추가
```js
// 수정(overwrite) 모드에서 캐럿 뒤 "한 문자(코드포인트)"를 덮어쓸 때 확장할 UTF-16 코드유닛 수(1 또는 2).
// text[offset]가 high 서로게이트이고 text[offset+1]가 low 서로게이트면 2(astral 문자=이모지 온전히 대체), 아니면 1.
// convertSimpTrad의 코드포인트 단위 순회와 동형(서로게이트 페어 인지). 무효/범위 밖/lone 서로게이트는 1(안전 기본).
export function overwriteExtendLength(text, offset) {
  const s = String(text ?? '');
  const i = Number(offset);
  if (!Number.isInteger(i) || i < 0 || i >= s.length) return 1;
  const hi = s.charCodeAt(i);
  if (hi >= 0xD800 && hi <= 0xDBFF && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xDC00 && lo <= 0xDFFF) return 2;
  }
  return 1;
}
```
(순수·DOM 비의존. `shouldOverwriteNextChar` 바로 아래에 둔다.)

### 2. `web/src/view/WriterPage.jsx` — `extendSelectionForOverwrite` 서로게이트-safe화
- import(L57)에 `overwriteExtendLength` 병합: `import { shouldOverwriteNextChar, overwriteExtendLength } from './editorNewline.js';`
- L135·L137을 확장 길이 기반으로 교체:
  ```js
  const text = node.textContent ?? '';
  const len = overwriteExtendLength(text, sel.anchorOffset); // 서로게이트 페어면 2, 아니면 1
  if (sel.anchorOffset + len > text.length) return; // 확장이 노드 경계를 넘으면(반쪽만 남음) 생략 = 삽입 폴백
  if (typeof sel.extend !== 'function') return;      // 구형 환경 방어(기존 유지)
  sel.extend(node, sel.anchorOffset + len);
  ```
  - 기존 `anchorOffset >= length` 가드는 `anchorOffset + len > length`가 포섭한다(len>=1). 노드 끝(형제 하이라이트 경계)은 여전히 삽입 폴백.
- L126~129 함수 주석에 "서로게이트 페어는 온전히(2 코드유닛) 확장한다" 한 줄 반영.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(client 전용 — `npm test` 불필요.)

## 회귀 가드 / 불변식

- **BMP 무회귀**: 비-서로게이트 문자는 여전히 1 코드유닛 확장(`overwriteExtendLength` 기본 1). 기존 overwrite 테스트(줄 중간 'b'/'c' 확장 등) 그린 유지.
- **줄/노드 경계 보존**: `extendSelectionForOverwrite`는 여전히 같은 텍스트 노드 안에서만 확장하고, 확장이 노드 길이를 넘으면 생략(삽입 폴백). 다음 줄/임베드/마커 침범 없음(`shouldOverwriteNextChar` 판정은 불변).
- **lone 서로게이트 안전**: 짝 없는 서로게이트는 2로 확장하지 않는다(깨진 데이터를 더 키우지 않음).
- **`Editor.jsx` diff 없음**: 반영은 여전히 에코 경로(onTextChange → commitBody). Editor 미접촉.
- **shouldOverwriteNextChar 불변**: 판정 함수는 건드리지 않는다(이미 옳음 — 이모지에 대해 true 반환).
- 기준 무회귀: web 1871·backend 427·lint/build clean.

## 커밋 계획

- **fix**: `fix(45-editor-backlog-cleanup): step2 — overwrite 모드 이모지 서로게이트 분할 수정(editorNewline overwriteExtendLength + extendSelectionForOverwrite 코드포인트 확장)` — `editorNewline.js`·`WriterPage.jsx` + `editorNewline.test.js`·`WriterPage.test.jsx`.
- **chore**: `chore(45-editor-backlog-cleanup): step2 status — completed` — index.json step2.

## 금지사항

- `sel.extend(node, anchorOffset + 1)`처럼 고정 +1을 남기지 마라. 이유: astral 문자를 반쪽만 선택해 네이티브 대체가 깨진 문자를 만든다.
- lone(짝 없는) 서로게이트를 2로 확장하지 마라. 이유: 뒤 코드유닛이 low 서로게이트가 아니면 무관한 다음 글자까지 삼킨다 — `overwriteExtendLength`가 페어일 때만 2를 반환한다.
- 확장 길이 판정을 `extendSelectionForOverwrite`에 인라인으로 박지 마라 — 순수 `overwriteExtendLength`로 분리하라. 이유: jsdom이 네이티브 대체를 못 하므로 경계는 순수 함수로 결정적으로 테스트해야 한다(phase 44 step3 원칙 계승).
- `shouldOverwriteNextChar`를 바꾸지 마라. 이유: 그 함수는 이미 옳다(이모지 앞에서 true) — 결함은 확장 길이뿐이다.
- IME 가드(WriterPage onKeyDown 상단)·onKeyDown 덮어쓰기 분기 배치를 옮기지 마라. 이유: 조합 중 selection 확장은 한글 입력을 깨뜨린다(news.md 무개입).
- 기존 테스트를 깨뜨리지 마라.
