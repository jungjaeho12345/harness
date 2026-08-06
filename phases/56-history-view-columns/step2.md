# Step 2: history-service

## 목표

`src/services/articleService.js`의 `queryHistory(articleId, { sendOnly })`가 이력 행에 **`title`·`version`·`status` 파생 필드를 실어** 반환하게 결선한다. 파생 계산은 step0의 순수 모듈이, 스냅샷 조회는 step1의 모델 메서드가 이미 제공한다 — 이 step은 **조립과 순서 규칙**만 담당한다.

**핵심 순서 규칙**: 파생은 반드시 `sendOnly` 필터 **이전**에, 전체 이력 위에서 계산한다.

## 읽어야 할 파일

- `docs/news.md` 114~115행(이력보기 스펙). **읽기 전용(수정 금지)**.
- `docs/ARCHITECTURE.md` — `controllers → services → models → db`, 의존성 주입, DB 비파괴.
- `docs/ADR.md` ADR-006. **읽기 전용(무접촉)**.
- `src/services/historyMeta.js`(step0 산출물) — `snapshotTitle(markupVersion)`, `decorateHistoryRows(rows, snapshots, { v1Body } = {})`. `snapshots`는 **`[{ id, markupVersion }]` 배열 하나로 고정**(undefined/빈 배열 허용). `v1Body`는 **스냅샷이 한 건도 없을 때만** v1 구간 제목 파생에 쓰이고, 스냅샷이 1건이라도 있으면 무시된다. 반환은 입력과 같은 순서(id DESC)의 새 배열이고 각 행에 `{ title, version, status }`가 붙는다. **`markupVersion`은 반환 행에 없다.**
- `src/models/articleHistoryModel.js`(step1 산출물) — `queryByArticle(articleId)`(경량, id DESC) + `querySnapshotsByArticle(articleId)`(`[{ id, markupVersion }]`).
- `src/services/articleService.js`
  - L105 `export function createArticleService({ articleModel, db, historyModel, distributionService, onHistoryError })` — **`historyModel`은 선택 주입**이다.
  - L326~332 `queryHistory(articleId, { sendOnly = false } = {})` — 현재 구현: `historyModel` 없으면 `[]`, 있으면 `queryByArticle` 결과를 그대로 반환하고 `sendOnly`면 `eventType === 'status' && action === 'send'`만 필터.
  - L334~341 `getHistorySnapshot` — **이 함수는 건드리지 않는다**(단건 본문 조회 계약 유지).
  - L235·L267 — `queryByArticle`을 쓰는 배부/엠바고 판정 경로. **이 호출부들은 그대로 둔다**(파생 필드가 필요 없다).
  - `getById(articleId)`/`articleModel.getById(articleId)` — 반환 shape은 `{ article, contents }`이고 본문은 `article.markupVersion`이다(없는 기사면 falsy). 아래 "v1 본문 예외"에서만 쓴다.
- `test/articleHistoryService.test.js` — 기존 계약 전량. 특히
  - L91~105 `sendOnly` 필터 케이스,
  - L107~121 "목록은 blob 없이 `hasSnapshot`만",
  - L168~186·L207~214 **주입 스텁**: `throwingHistoryModel`은 `{ insert, queryByArticle, querySnapshotById }`만 갖는다 — **`querySnapshotsByArticle`가 없다**. 이 스텁들이 무수정 green이어야 한다.
  - L188~201 `historyModel` 미주입 시 `queryHistory`가 `[]`.
- `src/controllers/index.js` L157 `queryHistory: (articleId, opts) => articleService.queryHistory(articleId, opts)` — 위임만. **수정 불필요**(위임 shape이 그대로 통과한다).

## 배경 (자기완결) — 왜 서비스인가, 왜 필터 전인가

`sendOnly`(송고이력보기)는 **서버 도메인 필터**라 클라이언트에는 status/send 행만 도착한다. 버전·제목·상태는 "그 시점까지 쌓인 이력"에서 승계로 계산되므로, 필터 후에 계산하면 송고 행의 버전이 전부 1, 제목이 전부 빈 값이 된다. 그래서 파생은 서버에서, 필터 이전에 해야 한다(이것이 이 phase에서 프론트 파생을 택하지 않은 결정적 이유다).

또한 `historyModel`은 선택 주입이고 테스트 스텁이 부분 구현이다 — **`querySnapshotsByArticle`가 없는 스텁이 이미 존재**하므로, 없으면 빈 스냅샷으로 진행해야 한다(있으면 제목이 채워지고, 없으면 제목만 빈다 — 버전·상태는 `hasSnapshot`/전이 정보만으로 정확하다).

**v1 본문 예외**: `create` → `send`만 있는 기사(편집 스냅샷 0건)는 실제 운영에서 가장 흔한 경로인데, 이대로면 송고이력의 제목이 항상 빈다. 그런데 스냅샷이 **0건**이라는 것은 "최초 저장 이후 본문이 한 번도 바뀌지 않았다"는 뜻이므로 **현재 `Article.markupVersion` = v1 본문**이다(추측이 아니라 동치). 그래서 스냅샷이 빈 배열일 때에 **한해** 현재 본문을 `v1Body`로 넘긴다. 스냅샷이 1건 이상이면 현재 본문은 최신 버전이지 v1이 아니므로 넘기지 않는다.

## TDD — 테스트 먼저

`test/articleHistoryService.test.js`에 케이스를 **추가**한다(기존 케이스는 수정 금지 — 아래 "회귀" 항목은 기존 케이스가 무수정 green임을 확인하는 것이다). 기존 `setup()`·`markup()` 헬퍼를 그대로 쓴다.

1. **제목 파생**: `create`(본문 '초판') → `update({ markupVersion: markup('새 제목\n본문'), modifier:'kim' })` 후 `queryHistory(articleId)[0].title === '새 제목'`.
2. **버전 파생**: 편집 2회(둘 다 본문 포함)면 최신순 배열의 버전이 `[3, 2]`이고, 편집 0회 + 송고 1회면 그 status 행의 `version === 1`(최초 저장 본문 = v1).
3. **메타 전용 편집**(본문 미포함 update)은 버전을 올리지 않는다(`hasSnapshot` falsy 행 — 직전 값 유지).
4. **상태 파생**: `update`(edit) → `applyAction('send')` 순서로 쌓으면 status 행의 `status === 'DPS'`, 그보다 오래된 edit 행의 `status === 'RDS'`(역승계).
5. **sendOnly는 파생 이후 필터다(핵심)**: 편집(본문 포함) 2회 후 송고하면, `queryHistory(id, { sendOnly: true })`의 유일한 행이 `version === 3`이고 `title`이 마지막 편집 제목이다. `sendOnly` 없이 조회했을 때의 같은 행 값과 **정확히 일치**한다.
6. **blob 미노출**: `sendOnly` 여부와 무관하게 모든 반환 행에 `markupVersion` 키가 없다(기존 계약 유지) — 단, `hasSnapshot`은 그대로 있다.
7. **스텁 호환(회귀)**: `historyModel`이 `querySnapshotsByArticle`를 갖지 않는 객체(기존 `throwingHistoryModel` 형태)여도 `queryHistory`가 throw하지 않고 배열을 반환한다(`title`은 `''`).
7-1. **v1 본문 예외(스냅샷 0건)**: `create({ markupVersion: markup('첫 제목\n본문', true) })` → `applyAction('send')`만 한 기사(편집 0회)에서 `queryHistory(id)`의 송고 행이 `title === '첫 제목'`, `version === 1`이다. `sendOnly: true`로 조회해도 같다.
7-2. **스냅샷이 생기면 v1 구간은 다시 빈다**: 위 기사에 본문 편집(`update({ markupVersion: markup('새 제목\n본문') })`)을 한 번 추가하면, **송고 행(더 오래됨)의 `title`은 `''`** 이고 편집 행의 `title === '새 제목'`이다(현재 본문이 v1 구간에 새지 않는다).
7-3. **추가 조회는 필요할 때만**: 스냅샷이 1건 이상인 기사에서는 기사 본문 조회가 일어나지 않는다(주입한 `articleModel`의 `getById` 호출 횟수를 스파이/카운터로 확인하라 — 이력 0건인 기사에서도 0회).
8. **미주입 회귀**: `historyModel` 미주입이면 여전히 `[]`.
9. **필드 보존 회귀**: 기존 필드(`id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt, hasSnapshot`)가 모두 그대로 남아 있다(파생 필드는 **추가**일 뿐 대체가 아니다).
10. **배부 이력 회귀**: 배부 판정 경로(`applyAction('send')` + 엠바고)가 이번 변경으로 달라지지 않는다 — 기존 `test/articleSendDistribution.test.js`·`test/distributionTickService.test.js`가 무수정 green이어야 한다(새 단언 추가 불필요, 실행으로 확인).

## 작업

`src/services/articleService.js`의 `queryHistory`만 수정한다.

```js
// 이력 조회 — 모델에 얇게 위임 + 표시용 파생(title/version/status) 부여.
// 파생은 sendOnly 필터 '전에' 전체 이력 기준으로 계산한다(승계 규칙이 필터로 잘린 행에 의존하므로).
function queryHistory(articleId, { sendOnly = false } = {}) {}
```

규칙:
1. `historyMeta.js`에서 `decorateHistoryRows`를 import한다(파일 상단 import 그룹에 추가 — 기존 import 순서 관례 유지).
2. 스냅샷 조회는 **가드 호출**: `typeof historyModel.querySnapshotsByArticle === 'function'`일 때만 부르고, 아니면 빈 배열을 넘긴다. 조회가 throw해도 이력보기가 죽지 않게 `try/catch`로 감싸고 빈 스냅샷으로 진행하라(제목만 비고 나머지는 정상 — `record()`가 이력 insert 실패를 격리하는 것과 같은 정신).
2-1. **v1 본문은 조건부로만 조회**한다: `rows.length > 0`이고 스냅샷 배열이 **비어 있을 때만** `articleModel.getById(articleId)`로 현재 본문(`article.markupVersion`)을 읽어 `{ v1Body }`로 넘긴다. 그 외(이력 0건 / 스냅샷 1건 이상)에는 **조회하지 않는다**(불필요한 읽기 금지). 이 조회도 `try/catch`로 감싸 실패 시 `v1Body` 없이 진행하라.
3. 필터는 파생 **후**에 적용하고, 필터 조건(`eventType === 'status' && action === 'send'`)은 그대로 둔다.
4. `getHistorySnapshot`·`record`·`applyAction`·`syncEmbargoStatus`·L235/L267의 `queryByArticle` 호출부는 **건드리지 마라**.
5. 반환 행에 `markupVersion`을 넣지 마라(step0 모듈이 이미 빼지만, 이 함수에서 다시 합치는 코드를 쓰지 마라 — `v1Body`도 반환에 실리면 안 된다).
6. 왜 필터 전에 파생하는지, 왜 `v1Body`가 스냅샷 0건에서만 유효한지 각각 한 줄 주석으로 남겨라(다음 사람이 순서를 뒤집거나 조건을 넓히는 리팩터를 막는다).

## Acceptance Criteria

```bash
npm test          # 실패 0 — step1 종료 시점 개수 + 이번 신규 케이스
npm run lint      # 통과
```

**diff scope**: step을 시작하기 전에 `git status --porcelain`을 찍어 스냅샷으로 남겨라. 종료 시점의 `git status --porcelain`이 그 스냅샷과 **다른 부분**은 `src/services/articleService.js`, `test/articleHistoryService.test.js` **2개뿐**이어야 한다(절대 목록 비교 금지 — 트리에 사용자 소유 미커밋 파일이 이미 있다).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 5종(확인 후 원복):
   - 필터를 파생보다 앞으로 옮기면 케이스 5만 red(순서 규칙이 테스트로 잠겼는지 확인).
   - `querySnapshotsByArticle` 가드(`typeof … === 'function'`)를 지우면 케이스 7이 red(TypeError).
   - `decorateHistoryRows` 호출을 지우면 케이스 1~4가 red, 기존 케이스는 green(파생이 순수 additive임을 확인).
   - `v1Body` 전달의 "스냅샷 0건" 조건을 없애고 항상 넘기면 케이스 7-2가 red.
   - `v1Body` 전달을 통째로 지우면 케이스 7-1만 red(나머지 파생은 green 유지).
3. 아키텍처 체크리스트:
   - 서비스가 SQL을 직접 쓰지 않고 모델 메서드만 부르는가(ADR-006)?
   - 라우트(`server/index.js`)·컨트롤러를 건드리지 않았는가(위임만으로 통과해야 한다)?
   - DB 쓰기(INSERT/UPDATE/DELETE)가 이 경로에 없는가(이력보기는 읽기 전용)?
   - 새 타이머·외부 네트워크 호출이 없는가(ADR-008)?
4. `phases/56-history-view-columns/index.json`의 step2를 `completed` + `summary`로 갱신한다. summary에 (a) `queryHistory` 반환 행의 최종 shape, (b) 파생→필터 순서 규칙, (c) 스냅샷 조회 가드/실패 격리 정책, (d) `v1Body` 조건부 조회 규칙(스냅샷 0건 + 이력 1건 이상일 때만)을 명시하라.

## 금지사항

- 파생을 `sendOnly` 필터 이후에 계산하지 마라. 이유: 승계 규칙이 필터로 잘린 edit 스냅샷 행에 의존한다 — 송고이력보기의 버전이 전부 1, 제목이 전부 빈 값이 된다(이 phase가 백엔드 파생을 택한 이유 자체가 무효화된다).
- `historyModel.querySnapshotsByArticle`를 무조건 호출하지 마라. 이유: 기존 테스트의 부분 구현 스텁(`{ insert, queryByArticle, querySnapshotById }`)에서 `TypeError`가 나 무관한 테스트가 무더기로 깨진다.
- `queryByArticle`을 쓰는 다른 호출부(L235·L267)나 `distributionTickService`를 이번 변경에 끌어들이지 마라. 이유: 그 경로는 판정 입력이지 표시 데이터가 아니다 — 파생 필드는 판정에 무의미하고 blob 로딩만 늘린다.
- 응답에 `markupVersion`을 싣지 마라. 이유: `/history`는 blob 없는 경량 목록 계약이고(모델·서비스 테스트가 강제), 편집이 많은 기사에서 응답이 수 MB로 커진다.
- 기존 반환 필드를 제거·개명하지 마라(`eventType`·`action`·`fromStatus`·`toStatus`·`hasSnapshot` 포함). 이유: 기사이력비교(WriterPage)가 `hasSnapshot`으로 필터하고, 기존 이력 모달·서버 테스트가 나머지 필드에 묶여 있다.
- `v1Body`를 스냅샷 유무와 무관하게(또는 이력 0건에도) 조회해 넘기지 마라. 이유: 스냅샷이 있으면 현재 본문은 v1이 아니라 최신 버전이라 과거 행에 현재 제목이 붙고, 이력 0건 기사에서는 결과에 쓰이지도 않는 DB 읽기만 늘어난다.
- `docs/news.md`·`docs/ADR.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라. 이유: 이번 phase 무접촉 대상이며, `docs/news.md`는 사용자 소유의 미커밋 편집분(이 phase의 입력 스펙)이다.
- `git add -A`/`git add .`로 스테이징하지 마라 — 반드시 이번 step이 만진 파일만 명시 경로로 `git add` 하라. 이유: 작업 트리에 사용자 소유 미커밋 파일(`docs/news.md` 등)이 이미 있어, 통짜 add는 그것들을 커밋에 끌어들인다.
- 미커밋 사용자 파일(`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`)을 `git restore`/`git checkout --`/`git stash`/`git clean`으로 되돌리거나 치우지 마라. 이유: 이 phase의 유일한 스펙 원문이 소실된다.
