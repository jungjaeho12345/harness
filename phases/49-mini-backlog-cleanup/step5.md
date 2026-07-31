# Step 5: overwrite-surrogate-guard

## 목표

**수정(overwrite) 모드에서 캐럿이 서로게이트 페어 "중간"에 있을 때 반쪽만 대체돼 본문이 손상되는 경로를 막는다.**

phase 45 step2가 "캐럿이 이모지 **앞**에 있을 때 2 코드유닛을 온전히 대체"하는 경우를 해결했다(`overwriteExtendLength`). 남은 엣지는 반대다 — 캐럿 offset이 **low 서로게이트 위치**(= high 서로게이트 바로 뒤, 이모지 내부)일 때다. 이때 `shouldOverwriteNextChar`가 `true`를 주고 `overwriteExtendLength`가 1을 돌려주어 **low 반쪽만 새 글자로 대체**된다. 결과 문자열에는 짝 없는(lone) high 서로게이트가 남아 본문이 깨진 코드유닛을 품은 채 저장된다(JSON 직렬화·DB 저장·외부 배부 파일까지 전파된다).

수정: **캐럿이 페어 내부면 덮어쓰기를 하지 않는다**(= 기존의 다른 차단 조건들과 동일한 "삽입 폴백"). 이 함수는 이미 줄 끝·"(끝)" 마커·무효 offset에서 같은 방식으로 안전 저하한다.

이 step은 **`web/src/view/editorNewline.js`의 순수 판정 함수 1개만** 수정한다(+ 그 테스트). DOM/WriterPage/컨트롤러/서버 무접촉.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md`(프론트 MVC), `docs/ADR.md`(ADR-003), `docs/news.md`의 에디터 "수정(overwrite)" 규칙.
- `web/src/view/editorNewline.js` — **전체**. 이 파일의 계약:
  - `isInputBlocked(text, caretOffset)`(L24~29) — "(끝)" 마커 시작 이상이면 입력 차단.
  - **`shouldOverwriteNextChar(text, offset)`(L37~43)** ← **수정 대상**. 현재 false 조건: 정수 아님/음수/`offset >= length`, `text[offset] === '\n'`, `isInputBlocked(...)`.
  - `overwriteExtendLength(text, offset)`(L48~58) — high(0xD800~0xDBFF) + low(0xDC00~0xDFFF) 페어면 2, 아니면 1. **시그니처·반환 계약은 그대로 둔다.**
- `web/src/view/WriterPage.jsx` — **읽기만(수정 금지)**:
  - `extendSelectionForOverwrite(root)`(L132~142) — 노드-로컬 좌표(`sel.anchorOffset`)로 `overwriteExtendLength`를 부르고 `sel.extend`로 확장한다. 노드 경계를 넘으면 확장하지 않는다(삽입 폴백).
  - onKeyDown의 덮어쓰기 분기(L1205~1211) — **`shouldOverwriteNextChar(blocksToText(blocks), caret.offset)`가 true일 때만** `extendSelectionForOverwrite`를 부른다. **즉 이 게이트에서 false를 주면 확장 자체가 일어나지 않고 네이티브 삽입으로 자연 폴백된다** — WriterPage를 고칠 필요가 없는 이유다.
- `web/src/view/editorNewline.test.js` — 이 step의 테스트가 들어갈 파일(기존 `overwriteExtendLength` 경계 전수 describe 스타일을 따른다).

## 배경 (자기완결)

UTF-16에서 이모지 같은 astral 문자는 high(0xD800~0xDBFF) + low(0xDC00~0xDFFF) **2 코드유닛**으로 표현된다. `'a😀b'`의 인덱스는 `0:'a', 1:high, 2:low, 3:'b'`다.

- offset=1(이모지 앞): 이미 해결됨 — `overwriteExtendLength`가 2를 줘 이모지 전체가 대체된다.
- **offset=2(이모지 내부)**: `text[2]`는 low 서로게이트. `'\n'`도 아니고 마커도 아니므로 현재 게이트를 통과하고, 확장 길이는 1 → low 한 짝만 대체 → `high + 새글자 + 'b'` = 깨진 문자열.

브라우저 Selection은 보통 캐럿을 코드포인트 경계로 정렬하므로 도달성은 낮다. 그러나 (a) 도달 시 결과가 **되돌리기 어려운 데이터 손상**이고, (b) 수정이 순수 함수 조건 한 줄이며, (c) 이미 같은 파일에 서로게이트 인지 로직이 있어 일관성이 좋다 — 그래서 채택한다.

**채택하지 않은 대안**: 캐럿을 페어 시작으로 뒤로 당겨 2유닛을 대체하는 방식. selection anchor를 옮겨야 해서 `extendSelectionForOverwrite`(DOM 코드)를 고쳐야 하고, 하이라이트로 줄이 여러 span으로 쪼개진 경우 anchor 이동이 노드 경계를 넘는 새 엣지를 만든다. 이득 대비 위험이 크다.

## TDD — 테스트 먼저

`web/src/view/editorNewline.test.js`에 red→green으로 추가한다(전부 순수 함수 단언 — DOM 불필요).

1. **페어 내부 차단(핵심)**: `shouldOverwriteNextChar('a😀b', 2) === false`(offset 2 = low 서로게이트, 앞은 high).
2. **페어 앞은 허용(회귀 가드)**: `shouldOverwriteNextChar('a😀b', 1) === true`이고 `overwriteExtendLength('a😀b', 1) === 2`.
3. **페어 뒤는 허용**: `shouldOverwriteNextChar('a😀b', 3) === true`(일반 글자 'b').
4. **lone low 서로게이트는 기존대로 허용**: 앞 글자가 high가 아닌 위치의 단독 low(`'a\uDC00b'`, offset 1)는 `true`(페어가 아니므로 반쪽 대체 문제가 없다 — 오히려 깨진 유닛을 정리한다).
5. **BMP 회귀**: 한글·영문·기호에서 기존 true/false 판정이 전부 그대로(줄바꿈 false, `offset >= length` false, "(끝)" 마커 이후 false, 음수/비정수 false).

## 작업

`shouldOverwriteNextChar(text, offset)`에 **"offset이 페어 내부(low 서로게이트이고 직전이 high 서로게이트)면 false"** 조건을 추가한다. 배치는 기존 false 조건들 뒤, `return true` 앞이 자연스럽다.

- 판정은 `charCodeAt`으로 한다(정규식·`Array.from` 금지 — 기존 `overwriteExtendLength`와 동형 스타일 유지).
- 범위 상수(0xD800/0xDBFF/0xDC00/0xDFFF)는 이미 `overwriteExtendLength`에 있다. **작은 순수 헬퍼(예: `isHighSurrogate`/`isLowSurrogate`)를 모듈 안에 만들어 두 함수가 공유**하거나, 최소한 값의 의미를 주석으로 명확히 하라(마법 숫자 중복 최소화).
- **공개 시그니처와 반환 타입은 불변**이다: `shouldOverwriteNextChar(text, offset) -> boolean`, `overwriteExtendLength(text, offset) -> 1|2`.
- `overwriteExtendLength`에는 "페어 내부 offset은 게이트(`shouldOverwriteNextChar`)에서 이미 걸러져 여기 도달하지 않는다"는 한 줄 주석만 남겨라(로직 변경 금지 — 0을 반환하도록 바꾸면 WriterPage의 `anchorOffset + len` 계산 계약이 깨진다).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web        # 87 files, 실패 0 (기준선 1944 pass + 신규 케이스)
npm test                # 620/620 green — 백엔드 무접촉 증명(step0 이후 기준선)
```

`git diff --name-only`가 `web/src/view/editorNewline.js`와 `web/src/view/editorNewline.test.js` **2개 파일**이어야 한다(WriterPage 포함 금지).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증: 새 조건을 제거하면 케이스 1이 red가 되는지 확인한다.
3. 아키텍처 체크리스트:
   - 순수 함수만 수정했는가(DOM/Selection/React 미도입)?
   - WriterPage·Editor·컨트롤러·서버 무접촉인가?
4. `phases/49-mini-backlog-cleanup/index.json`의 step5를 갱신한다(`completed` + `summary` 등).

## 금지사항

- `WriterPage.jsx`의 `extendSelectionForOverwrite`나 onKeyDown 분기를 수정하지 마라. 이유: 게이트가 false를 주면 확장 호출 자체가 일어나지 않는다 — DOM 코드를 건드리면 IME·하이라이트 span 분할과 얽힌 회귀 표면이 열린다.
- `overwriteExtendLength`가 0을 반환하도록 바꾸지 마라. 이유: 호출부가 `sel.extend(node, anchorOffset + len)`를 계산한다 — 0이면 확장이 아니라 "빈 확장"이 되어 의미가 모호해지고, `len >= 1` 전제로 짜인 노드 경계 가드가 무력해진다.
- 캐럿을 페어 시작으로 되돌리는 보정을 넣지 마라. 이유: anchor 이동은 DOM 계층의 변경이며 span 분할·IME 조합 중 상태와 얽힌다(이 step 범위 밖, 위 "채택하지 않은 대안" 참조).
- 서로게이트 처리를 `Intl.Segmenter`/정규식 `\p{...}`로 확장하지 마라(결합 문자·ZWJ 시퀀스까지 다루려 하지 마라). 이유: 범위는 "반쪽 대체 방지"뿐이다 — 자소 클러스터 단위 편집은 별도 설계 사안이다.
- 기존 테스트를 깨뜨리지 마라(기준: web 87 files / 1944 pass 이상, lint·build clean, 백엔드 620/620 green 유지).
