# Step 3: save-override-atomic

## 목표

저장/송고 오버라이드의 **반쪽 적용 비대칭**을 없앤다.

`web/src/controller/useWriteController.js`의 `toSaveDto(tab, override)`는 phase 49 step6에서 `{ body, title }` 객체 계약이 됐는데, 지금은 두 위반이 다르게 처리된다.

| 오버라이드 | 현재 결과 | 문제 |
|---|---|---|
| `'문자열'`(옛 계약) | 전량 무시 | 의도대로 |
| `{ title }`(body 없음) | 전량 무시 | 의도대로 |
| `{ body }`(title 없음) | **body만 적용**, `dto.title`은 `tab.fields.title`(변환 전 값) | **반쪽 적용** — 본문은 변환됐는데 제목은 옛 값인 자기모순 기사가 저장된다 |

수정: **"전부 아니면 전무"** 로 통일한다 — `ov.body`와 `ov.title`이 **둘 다 있을 때만** 오버라이드를 적용한다.

프로덕션 동작 변화는 **0건**이다. 유일한 생산자인 `WriterPage.autoCompanyCodeOverride()`가 항상 `{ body, title }` 쌍을 반환하기 때문이다(아래 배경 참조). 이 step은 **계약을 코드가 실제로 강제**하게 만들고, 기존 계약 테스트 1건을 새 규칙으로 갱신한다.

> **선행**: web 패스의 두 번째 step이다. 시작 기준선은 `npm run test:web` 실패 0(2006 + step2 신규), `npm test` 실패 0. step2와 파일 중복 없음.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-003**(주입형 Model 계약, 프론트 MVC), **ADR-004**(role은 서버 세션에서만 도출 — dto에 role을 싣지 않는다).
- `docs/ARCHITECTURE.md` — L34 `View ← Controller ← Model` 의존 방향. **컨트롤러는 뷰를 import하지 않는다**(phase 49 step6이 제거한 역행).
- `web/src/controller/useWriteController.js`
  - **L57~67**: `toSaveDto` 위 주석 블록. 특히 L62의 "*title — 미전달이면 `tab.fields.title` 유지(문서화된 폴백)*" 문장이 이번에 폐기되는 규칙이다.
  - **L68~75**: `toSaveDto(tab, override)` 본문. L70 `const ov = override && typeof override === 'object' ? override : null;`, L71 `markupVersion: ov?.body ?? body`, L72 `if (ov && ov.body != null && ov.title != null) dto.title = ov.title;`.
  - 호출부 4곳: **L288~291** `save(override)`, **L305** `saveAsNew`(override 없음 — 불변), **L315** `saveMapping`(override 없음 — 불변), **L326~338** `submit(action, override)`.
- `web/src/controller/useWriteController.test.jsx`
  - **L757~845** `describe('useWriteController — 오버라이드 { body, title } 계약 위반 판정 (phase49 step6)')` 전체.
  - **L764~775**: `save({ body })`가 body만 적용하고 title은 폴백한다고 단언하는 테스트 — **이 step에서 갱신할 유일한 기존 테스트**다.
  - L777~803(문자열 무시 save/submit), L805~817(title-only 미적용), L819~831(`title: ''` 통과), L833~844(role 미포함·articleId·body 키 없음) — **전부 그대로 green이어야 한다**.
- `web/src/view/WriterPage.jsx` — **L587~602 `autoCompanyCodeOverride()`**(읽기만, 수정 금지): 변환이 없으면 `null`, 있으면 `commitBody(nextBody)` 후 `{ body: nextBody, title: bodyTitle(nextBody) }`를 **항상 쌍으로** 반환한다. 소비처는 **L796~803**(파일>저장: 기존 기사 `save(auto)` / 신규 초안 `draftFields`)와 **L1455~1456**(송고·보류 `submit(action, auto)`).

## 배경 (자기완결)

오버라이드는 "뷰가 저장 직전에 만든 본문(+그 본문에서 파생한 제목)"을 컨트롤러에 직접 실어 보내는 장치다. `commitBody`의 `setState`가 같은 tick에 `tabsRef`로 반영되지 않아 `save`/`submit`이 stale 본문을 읽는 문제(phase 20·36) 때문에 도입됐다.

제목 파생 규칙(`bodyTitle` = 본문 첫 줄)은 **뷰의 단일 출처**다. 컨트롤러가 그 규칙을 알면 `Controller → View` import 역행이 생기므로(phase 49 step6이 제거), 컨트롤러는 "받은 쌍을 그대로 싣거나, 아예 안 싣거나" 두 가지만 할 수 있다. `{ body }`만 받아 body를 싣는 현재 동작은 그 원칙에서 벗어난 잔재다.

`title === ''`는 **유효한 제목**이다(본문 첫 줄이 빈 줄). 따라서 판정은 반드시 `!= null`이며 truthy 체크를 쓰면 빈 제목이 조용히 stale 값으로 남는다.

## TDD — 테스트 먼저

1. **기존 테스트 갱신**(L764~775): 제목과 기대값을 새 규칙으로 바꾼다.
   - 제목 예: `save({ body }) — title 미전달이면 오버라이드 전량 무시(전부 아니면 전무)`
   - 단언: `dto.markupVersion === '원본 본문'`(오버라이드 body **미적용**), `dto.title === '내가 쓴 제목'`(tab 값 유지).
   - 주석으로 이유를 남겨라: 본문만 바뀌고 제목이 옛 값이면 저장 기사가 자기모순이 된다.
2. **신규 케이스**를 같은 `describe`에 추가한다.
   - `submit('send', { body })` — submit 경로에서도 body-only는 미적용(markupVersion·title 모두 tab 값).
   - `save({ body, title: undefined })` / `save({ body, title: null })` — 명시적 `undefined`/`null`도 미적용(`!= null` 판정 잠금).
   - 정상 경로 회귀: `save({ body, title })`은 둘 다 적용된다(기존 케이스가 있으면 중복 추가 금지).
3. 갱신 전에 먼저 실행해 **red**를 확인하고(현재 구현은 body를 적용하므로 새 단언이 실패한다), 구현 후 green으로 만든다.

## 작업

`toSaveDto`의 정규화를 "쌍이 완전할 때만 오버라이드"로 바꾼다.

```js
function toSaveDto(tab, override) {
  const { body, ...rest } = tab.fields;
  // 전부 아니면 전무 — body·title이 모두 있는 객체만 오버라이드로 인정한다.
  const ov = override && typeof override === 'object'
    && override.body != null && override.title != null ? override : null;
  const dto = { ...rest, markupVersion: ov ? ov.body : body };
  if (ov) dto.title = ov.title;
  if (tab.articleId) dto.articleId = tab.articleId;
  return dto;
}
```

- 판정은 `!= null`만 쓴다(truthy 금지 — `''`는 유효 제목).
- L57~67 주석 블록에서 "미전달이면 `tab.fields.title` 유지(문서화된 폴백)" 문장을 **새 규칙 한 줄로 교체**한다: 쌍이 아니면 오버라이드 자체가 없는 것으로 수렴한다. 주석 전면 재작성 금지.
- `markupVersion` 키 사용(서버 `ARTICLE_FIELDS` 계약), `body` 키 미전송, `role` 미포함(ADR-004), `articleId` 조건부 포함은 **전부 불변**이다.
- 호출부(`save`/`submit`/`saveAsNew`/`saveMapping`)와 뷰는 수정하지 않는다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web    # 실패 0 — 기존 1건 갱신 + 신규 케이스만큼 증가(기준선: 2006 + step2 신규)
npm test            # 백엔드 무접촉 — 실패 0(개수는 step0·1 종료 시점과 동일)
```

`git diff --name-only`는 `web/src/controller/useWriteController.js`와 `web/src/controller/useWriteController.test.jsx` **2개뿐**이어야 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다. `WriterPage.test.jsx`의 자동 기업코드 변환 관련 테스트(신규 초안 title 동기화 포함)가 **무수정 green**인지 확인한다 — 프로덕션 동작 불변의 증거다.
2. 생산자 확인: `git grep -n "autoCompanyCodeOverride" -- web/src`로 생산자가 `WriterPage.jsx` 한 곳뿐이고 항상 `{ body, title }`을 반환하는지 재확인한다. 다른 생산자가 발견되면 **고치지 말고** step 요약에 보고하라(범위 밖).
3. 변이 검증: `override.title != null` 조건을 지우면 갱신한 테스트가 red가 되는지 확인한다.
4. 의존 방향 확인: `git grep -n "from '\.\./view/" -- web/src/controller/*.js` 결과가 **0건**이어야 한다(프로덕션 코드 기준 — 테스트 파일 제외).
5. 아키텍처 체크리스트:
   - 컨트롤러가 제목 파생 규칙(`bodyTitle`)을 알게 되지 않았는가?
   - dto에 `role`이 실리지 않는가(ADR-004)?
   - 자동저장 타이머·`saveAsNew`·`saveMapping`·파일>복구 경로가 불변인가?
6. `phases/50-hygiene-cleanup/index.json`의 step3을 `completed` + `summary`로 갱신한다.

## 금지사항

- `bodyTitle`(또는 `../view/`의 무엇이든)을 컨트롤러에서 import하지 마라. 이유: `Controller → View` 의존 역행을 phase 49 step6이 제거했다 — 되살리면 프론트 MVC 경계가 다시 무너진다.
- truthy 체크(`if (ov && ov.body && ov.title)`)를 쓰지 마라. 이유: `title === ''`는 본문 첫 줄이 빈 줄인 정상 상태이며, truthy 판정은 그 경우 stale 제목을 남긴다(전용 회귀 테스트가 있다).
- `WriterPage.autoCompanyCodeOverride()`나 그 소비처(L796~803·L1455~1456)를 수정하지 마라. 이유: 이미 쌍을 보장하는 유일한 생산자다 — 이 step은 컨트롤러 쪽 강제만 담당하며, 뷰를 함께 바꾸면 실패 원인 격리가 불가능해진다.
- `markupVersion` 대신 `body` 키를 싣거나 두 키를 함께 싣지 마라. 이유: 서버 `ARTICLE_FIELDS`는 `markupVersion`만 저장하며 `body`로 보내면 본문이 통째로 유실된다.
- 오버라이드 문자열(옛 계약)을 다시 지원하지 마라. 이유: 문자열을 body로 받아들이면 제목이 stale인 무음 반쪽 적용이 되살아난다.
- 기존 계약 테스트를 삭제하지 마라(갱신 대상은 L764~775 **1건뿐**). 이유: 나머지 케이스는 이번 변경이 다른 계약을 깨지 않았다는 증거다.
- `.claude/skills/claude-code-review-harness/SKILL.md`를 읽거나 수정하거나 커밋에 포함하지 마라. 이유: 사용자가 편집 중인 파일이다.
