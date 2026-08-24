# Step 0: dist-reason-token

## 목표

배부 중단 사유 토큰 `'status-changed'`가 **두 서비스에 리터럴로 복제**돼 있는 것을 공용 상수로 승격하고 양쪽이 import하게 한다.

- `src/services/distributionService.js` L20~23: `const STATUS_CHANGED = 'status-changed';` (쓰기 직전 TOCTOU 가드가 남기는 사유)
- `src/services/distributionTickService.js` L26~28: 동일 리터럴 (배부 직전 재검증 스킵 사유)

두 값은 **반드시 같아야 한다** — tick이 `distributionService`의 `failed` 항목을 HTTP 응답으로 투영(`projectFailure`)하므로, 한쪽만 바뀌면 운영 cron이 보는 요약 어휘가 조용히 갈라진다. phase 49 step2가 `EMBARGO_DISTRIBUTABLE_STATUSES`를 `embargoPolicy.js` 단일 출처로 잡은 것과 **대칭**으로, "그 allowlist를 벗어났다"는 사유 토큰도 같은 모듈에 둔다.

동작 변경은 **0건**이다(값·shape·분기 전부 불변). 순수 중복 제거 + 계약 잠금이다.

> **실행 패스**: 여기서 **backend 패스(step0~1)** 가 시작된다. 시작 기준선은 `npm test` **636/636 green**, `npm run lint` clean이다. web 패스(step2~4)와 파일 중복은 없다.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-008**(배부는 파일 스풀 outbound + tick pull, 앱 내 타이머/egress 금지), ADR-006(controllers → services → models 계층).
- `docs/ARCHITECTURE.md` — `[배부]`/`[tick]` 데이터 흐름(L47~58).
- `src/services/embargoPolicy.js` — 순수 판정 모듈. **L13~18**의 `EMBARGO_DISTRIBUTABLE_STATUSES`(`Object.freeze(['DES','EPS','DPS'])`)와 그 위 주석("송고 훅·tick·배부 실행이 공유하는 단일 출처")이 이 step이 따를 선례다. 이 모듈은 DB·HTTP·타이머 비의존이며 그 성질을 깨면 안 된다.
- `src/services/distributionService.js` — **L20~23** 로컬 상수 정의, 사용처 **L84 / L102 / L106**(`abortEntry({ ..., reason: STATUS_CHANGED })`). L55~56의 비용 인식 주석은 step1이 손대므로 여기서는 건드리지 않는다.
- `src/services/distributionTickService.js` — **L21~31**의 사유 토큰 4개(`TICK_FAILED` / `UNKNOWN_FAILURE` / `STATUS_CHANGED` / `NO_ACTIVE_TARGET`), 사용처 **L154**. **L33~44** `projectFailure`가 실패 항목을 화이트리스트 투영해 HTTP로 내보낸다는 사실을 확인하라(토큰 값이 곧 외부 계약이다).
- `test/embargoPolicy.test.js` — 순수 모듈 계약 테스트 스타일(node:test + assert).
- `test/distributionService.test.js` — L358~470 부근에 phase 49 step2가 넣은 상태 가드 테스트 4케이스가 `'status-changed'` 문자열을 단언한다(**이 단언들은 그대로 green이어야 한다**).
- `test/distributionTickService.test.js` — tick 요약의 `reason` 단언들.

## 배경 (자기완결)

`distributionService.distribute()`는 수신처마다 쓰기 직전 최신 status를 재확인하고, allowlist 밖으로 전이됐으면 남은 수신처·남은 kind를 전부 중단하면서 `failed`에 `{ articleId, targetId, kind, spoolDir?, reason: 'status-changed' }`를 남긴다. `distributionTickService`는 배부 직전 재검증에서 같은 상황을 만나면 `{ articleId, targetId: null, kind: null, reason: 'status-changed' }`를 남긴다. 두 값이 같아야 운영자가 tick 응답 하나로 "상태 전이 때문에 안 나갔다"를 단일 어휘로 읽는다.

`'status-changed'`라는 **문자열 값 자체는 외부 계약**이다(`POST /api/distribution/tick` 응답에 그대로 실린다). 이 step은 값을 바꾸지 않는다 — 정의 위치만 옮긴다.

## TDD — 테스트 먼저

`test/embargoPolicy.test.js`에 계약 잠금 테스트를 **먼저** 추가한다(구현 전에는 import가 `undefined`라 red).

- `STATUS_CHANGED_REASON`이 정확히 `'status-changed'`다 — HTTP 응답 토큰이므로 값 변경 금지임을 주석으로 명시.
- (선택) `EMBARGO_DISTRIBUTABLE_STATUSES`와 같은 모듈에서 export된다는 사실을 함께 단언할 필요는 없다 — 값 잠금 1건이면 충분하다.

기존 배부/tick 테스트는 **수정하지 않는다**. 그 테스트들이 여전히 `'status-changed'`를 단언한 채 green이면 리팩터가 안전했다는 증거다.

## 작업

1. `src/services/embargoPolicy.js` — `EMBARGO_DISTRIBUTABLE_STATUSES` 바로 아래에 export를 추가한다.

   ```js
   export const STATUS_CHANGED_REASON = 'status-changed';
   ```

   주석은 2줄 이내로: (a) 배부 중 status가 위 allowlist 밖으로 전이돼 중단된 항목의 사유 토큰이며 배부 실행(`distributionService` 가드)과 tick 재검증이 **공유**한다, (b) 값은 tick 응답으로 나가는 외부 계약이라 변경 금지. 새 import·new Date·조회를 이 모듈에 들이지 마라(순수 판정 모듈 성질 유지).

2. `src/services/distributionService.js` — 로컬 `const STATUS_CHANGED = 'status-changed';`(L23)를 **삭제**하고, 기존 import 문에 `STATUS_CHANGED_REASON`을 더한다. 사용처 3곳(L84 / L102 / L106)은 import한 이름을 그대로 쓴다. 로컬 별칭(`const STATUS_CHANGED = STATUS_CHANGED_REASON`)을 만들지 마라 — 복제를 지우려는 step에서 이름만 남기면 의미가 없다.

3. `src/services/distributionTickService.js` — L28의 로컬 상수를 **삭제**하고 기존 `embargoPolicy.js` import 목록에 `STATUS_CHANGED_REASON`을 더한다. 사용처(L154) 교체. **나머지 토큰 3개**(`TICK_FAILED` / `UNKNOWN_FAILURE` / `NO_ACTIVE_TARGET`)는 **그대로 모듈 로컬로 둔다** — 생산자가 이 모듈 하나뿐이라 공유 대상이 아니다.

4. 두 서비스의 상수 주석은 "복제 어휘"를 설명하던 문장이므로, 승격에 맞춰 한 줄로 줄이거나 import 지점으로 옮긴다(주석 전면 재작성 금지).

시그니처·반환 shape·분기·failed 항목의 키 구성은 **전부 불변**이다.

## Acceptance Criteria

```bash
npm test        # 636 + 신규 케이스(최소 1), 실패 0
npm run lint
```

`git diff --name-only`는 `src/services/embargoPolicy.js`, `src/services/distributionService.js`, `src/services/distributionTickService.js`, `test/embargoPolicy.test.js` **4개뿐**이어야 한다(web/·docs/·server/·db 변경 0).

## 검증 절차

1. 위 AC 커맨드를 실행한다. `npm test`는 실패 0이어야 하고, 특히 `distributionService.test.js`의 상태 가드 4케이스와 `distributionTickService.test.js`의 `status-changed` 단언이 **수정 없이** green이어야 한다.
2. 단일 출처 확인: `git grep -n "'status-changed'" -- src/` 결과가 **`src/services/embargoPolicy.js` 1줄뿐**이어야 한다(test/는 외부 계약을 단언하므로 리터럴이 남아 있는 게 정상).
3. 변이 검증: `embargoPolicy.js`의 상수 값을 임시로 `'status-changed-x'`로 바꾸면 (a) 새 잠금 테스트와 (b) 두 서비스의 기존 사유 단언이 함께 red가 되는지 확인한 뒤 되돌린다 — 두 소비자가 실제로 같은 출처를 보고 있다는 증거다.
4. 아키텍처 체크리스트:
   - `embargoPolicy.js`가 여전히 DB/HTTP/파일시스템/타이머 비의존인가?
   - 서비스 → 순수 모듈 방향 의존만 늘었는가(역방향 import 0)?
   - DB 스키마·행 변경 0인가(이 step은 SQL을 건드리지 않는다)?
5. `phases/50-hygiene-cleanup/index.json`의 step0을 `completed` + `summary`로 갱신한다.

## 금지사항

- `'status-changed'` **값을 바꾸지 마라**. 이유: `POST /api/distribution/tick` 응답에 그대로 실리는 외부 계약이며, 운영 cron/로그 파서가 이 토큰으로 원인을 분류한다.
- `TICK_FAILED`/`UNKNOWN_FAILURE`/`NO_ACTIVE_TARGET`까지 `embargoPolicy.js`로 올리지 마라. 이유: 생산자가 tick 하나뿐인 토큰까지 옮기면 순수 판정 모듈이 tick 전용 어휘의 창고가 되어 응집도가 무너진다(이번 승격의 근거는 "둘이 공유한다"뿐이다).
- 새 파일(`distributionReasons.js` 등)을 만들지 마라. 이유: allowlist와 그 위반 사유는 같은 판정 규칙의 앞뒷면이라 한 모듈에 있어야 하고, 파일이 늘면 import 그래프만 복잡해진다.
- `projectFailure`의 화이트리스트 투영(tick L33~44)을 손대지 마라. 이유: 스풀 경로 유출을 막는 안전 기본값이며 이 step의 범위가 아니다.
- 상태 가드 로직(`aborted` 처리·`abortEntry` 호출 위치·failed 항목 shape)을 바꾸지 마라. 이유: phase 49 step2가 TOCTOU 방어로 확정한 동작이며, 여기서 함께 바꾸면 실패 원인 격리가 불가능해진다.
- `.claude/skills/claude-code-review-harness/SKILL.md`를 읽거나 수정하거나 커밋에 포함하지 마라. 이유: 사용자가 편집 중인 파일이다 — 스테이징 전에 `git status`로 확인하고 제외하라.
