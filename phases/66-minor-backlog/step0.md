# Step 0: sort-paragraph-guard

편집 메뉴 "문단 정렬"이 **범위 밖 캐럿 줄**을 받았을 때 사용자가 가리킨 적 없는 문단을 재배열하는 하자(감사 항목 A, low)를 순수 계산 모듈 한 곳에서 막는다.

## 읽어야 할 파일

- `CLAUDE.md` — 개발 프로세스(TDD 필수)·커밋 규칙
- `phases/66-minor-backlog/index.json` — scope (A), decisions **(1)(2)(20)(22)**, excluded (d)
- `docs/ARCHITECTURE.md` "패턴 > 프론트엔드 MVC" 절 — View 순수 함수 계층 규칙
- `web/src/view/editorEditOps.js` 전체(107줄) — 특히 파일 상단 정책 주석, `sortParagraph`(60~91행), `deleteWordAt`(93~107행)의 **no-op 판정 형태**
- `web/src/view/editorRange.js` 39~52행 — 문단 경계 계산 함수와 그 clamp 주석(이 step은 **이 파일을 수정하지 않는다**)
- `web/src/view/writerBody.js` 31~40행 — 텍스트-줄 인덱스 → 블록 인덱스 매핑 헬퍼(범위 밖·음수·NaN을 전부 -1로 돌려준다는 사실을 직접 확인하라)
- `web/src/view/editorShortcuts.js` 70~80행 — 한줄 삭제의 같은 계열 no-op 판정(형제 전례)
- `web/src/view/editorEditOps.test.js` 208~269행 — 특히 249~253행의 "범위 밖 텍스트 줄 인덱스는 no-op" 케이스(이 step이 동형으로 잠글 본보기)
- `web/src/view/WriterPage.jsx` 1054~1080행 — 호출부 3종(문서 정렬·문단 정렬·한줄 지우기)의 가드 비대칭. **이 step은 이 파일을 수정하지 않는다**(읽기만 — 왜 순수 모듈에서 막아야 하는지의 근거)

## 배경 (실코드 확인 결과)

- `sortParagraph(blocks, caretLineIndex)`는 캐럿 줄 인덱스를 **검증 없이** 문단 경계 계산에 넘긴다. 그 계산은 인덱스를 `[0, 줄수-1]`로 clamp하므로, 문서보다 큰 인덱스는 **마지막 줄**로 접히고 그 문단이 정렬 대상이 된다.
- 형제 연산은 같은 상황에서 조용히 아무것도 하지 않는다: 단어 삭제는 매핑 실패(-1)면 no-op, 한줄 삭제도 no-op. **정렬만 비대칭**이다.
- 실패 시나리오: 10줄 문서에서 캐럿이 9번 줄에 기록됨 → 되돌리기 등으로 본문이 3줄로 줄어드는데 마지막 캐럿 기록은 갱신되지 않음 → 편집>문단 정렬 → 9가 2로 접혀 **마지막 문단이 재배열**되고 그대로 저장된다(되돌리기로 복구 가능하나 사용자는 원인을 알 수 없다).
- 호출부 가드도 비대칭이지만(문단 정렬은 캐럿 유무만, 한줄 지우기는 블록 매핑까지 확인) **이 step은 호출부를 건드리지 않는다** — 순수 모듈이 스스로 안전해지면 충분하고, 한 step은 한 레이어만 만진다.

## 작업

TDD 순서를 지킨다: **먼저 red 테스트 → 그다음 구현**.

### A. red 테스트 추가 (`web/src/view/editorEditOps.test.js`)

`sortParagraph` describe 블록 안에 아래를 추가한다(기존 케이스는 한 줄도 고치지 마라).

1. **범위 밖 캐럿 줄 인덱스는 no-op** — 여러 줄로 된 정렬 대상 문단이 있는 블록 배열에, 텍스트 줄 수보다 큰 인덱스를 넘긴다. 기대: `changed === false`이고 반환 블록이 입력과 같은 내용이다(마지막 문단이 재배열되지 않았음을 값으로 단언하라 — `changed`만 보면 부족하다). 이 케이스는 수정 전에 **반드시 실패**해야 한다. 실패하는 것을 눈으로 확인하고 요약에 기록하라.
2. **음수·비정수 캐럿 줄 인덱스도 no-op** — 음수와 `NaN`(또는 `undefined`) 두 입력에 대해 같은 단언.
3. **정상 인덱스 회귀 잠금** — 유효한 인덱스에서는 오늘의 정렬 결과가 그대로 나온다(경계값: 첫 줄 `0`과 마지막 텍스트 줄). 이 케이스는 수정 전에도 green이어야 하며, 가드가 과잉으로 정상 경로를 막지 않는다는 증거다.
4. **텍스트 블록이 하나도 없는 입력**(임베드만 있는 블록 배열)에서 인덱스 0을 넘겨도 예외 없이 no-op이다.

### B. 구현 (`web/src/view/editorEditOps.js`)

- `sortParagraph` 진입부(입력 정규화 직후, 줄 배열/문단 경계 계산 **전**)에서 캐럿 줄 인덱스를 텍스트-줄 → 블록 인덱스 매핑 헬퍼로 확인하고, 매핑에 실패하면 **단어 삭제와 같은 모양의 no-op**으로 즉시 반환한다(정규화된 입력 + 변경 없음).
- 판정 규칙을 새로 만들지 마라 — 이미 있는 매핑 헬퍼의 -1 계약을 그대로 쓴다(음수·NaN·범위 초과가 전부 여기서 걸린다).
- 함수 상단 주석에 이 no-op 계약을 한 문장으로 명시한다(형제 연산과 동형이라는 사실 포함). 시그니처·반환 shape·정상 경로 로직은 그대로다.

## Acceptance Criteria

```bash
npx vitest run --root web src/view/editorEditOps.test.js
npx vitest run --root web src/view/editorRange.test.js src/view/editorShortcuts.test.js src/view/WriterPage.test.jsx
npm run test:web
npm run lint
git status --porcelain
```

## 검증 절차

1. **red 먼저**: A의 1·2번 케이스를 추가하고 구현 전에 `npx vitest run --root web src/view/editorEditOps.test.js`를 돌려 실패를 확인한다(실패 개수와 메시지 요지를 요약에 남긴다). 그 뒤 B를 구현하고 green을 확인한다.
2. AC를 전부 실행한다. `npm run test:web` 기준선은 2368 pass이며, 이 step 뒤에는 추가한 케이스 수만큼만 늘어야 한다(줄어들면 회귀다). 전체 스위트가 1건 실패하면 **재실행 2회**로 판정하라(알려진 비고정 flake).
3. **변이 검증 2종**(각각 red 확인 후 원복, 결과를 요약에 기록):
   - (a) 새 가드를 제거 → A-1·A-2가 red.
   - (b) 가드를 '항상 no-op'으로 뒤집기 → A-3(정상 경로 회귀 잠금)이 red. 이 증거가 없으면 가드가 정상 정렬까지 죽였는지 알 수 없다.
4. `git status --porcelain` 증분이 소유 파일(`web/src/view/editorEditOps.js` · `web/src/view/editorEditOps.test.js` · `phases/66-minor-backlog/index.json`)뿐인지 **시작 시점 스냅샷 대비**로 확인한다.
5. 아키텍처 체크: `web/src/view/editorRange.js`·`WriterPage.jsx`·`Editor.jsx` 무수정 · `server/**`·`src/**`·`client/**` 무수정 · 새 파일 0 · DB 접속 0 · 의존성 불변.
6. `phases/66-minor-backlog/index.json`의 step0 status를 갱신하고 summary에 실측(변이 결과·테스트 증감)을 남긴다.

## 금지사항

- `web/src/view/editorRange.js`의 clamp를 없애거나 예외를 던지게 바꾸지 마라. 이유: 그 clamp는 문단 **선택**(무해한 읽기 연산)이 함께 쓰는 계약이고, "문단 꼬리가 마지막 줄을 넘어도 동작한다"가 기존 테스트로 잠겨 있다 — 고칠 지점은 파괴적 연산의 입구 한 곳이다.
- `WriterPage.jsx`에 호출부 가드를 추가하지 마라. 이유: 한 step은 한 레이어만 만진다(순수 모듈이 안전해지면 중복 방어일 뿐이고, 컨테이너 뷰 수정은 이 phase에서 step3 소유다).
- 문서 정렬(`sortDocument`)의 동작을 바꾸지 마라. 이유: 캐럿 인덱스를 받지 않는 전체 문서 연산이라 이 결함과 무관하고, 정렬 규칙 변경은 기존 계약 테스트를 깬다.
- 자체 숫자 검사(정수 여부·상한 비교)를 새로 만들지 마라. 이유: 판정 출처가 둘로 갈라지면 나중에 한쪽만 바뀌어 형제 연산과 다시 비대칭이 된다 — 이미 있는 매핑 헬퍼의 -1 계약을 쓴다.
- 기존 테스트 케이스를 고쳐서 green을 만들지 마라. 이유: 그 케이스들은 정렬·정렬(align) 승계 계약을 잠근 것이고, 새 가드가 그것을 깨뜨렸다면 가드가 틀린 것이다.
