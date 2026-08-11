# Step 1: boot-wiring

## 목표

step0이 만든 백필 코어를 **부트 시점에 결선**하고, 채운 행 수를 로그로 남긴다. 그리고 이 phase의 목적(레거시 기사도 이력보기가 본문을 읽지 않는다)이 실제로 달성됐음을 **실측 단언**으로 잠근다.

`server/index.js` 하나만 수정한다(부트스트랩 합성 루트). `src/**`는 무수정이다.

## 읽어야 할 파일

- `server/index.js` — 상단 import 블록(1~24행: `createLogService`는 15행, 부트 전용 import는 17~23행), **전례 `logOriginDiagnostics`(91~110행 부근: 주입 가능한 인자 + 값 반환 + 부팅을 막지 않는 진단 로그)**, 그리고 `bootstrap()`(1057~1111행 — 1055~1056행은 그 위의 설명 주석이다). 특히 다음 순서가 현재 코드다:
  ```js
  const db = new DatabaseSync('news.db');
  createSchema(db);                 // 비파괴 멱등 마이그레이션만
  backfillEmptyDepartments(db);     // 예전 DB의 빈 부서 자동 보정(비파괴, 멱등)

  const sessionService = createSessionService();
  const logService = createLogService();   // ← 현재는 백필보다 뒤에 생성된다
  const controllers = createControllers(db, { sessionService, logService });
  ```
  **이 파일은 이 step이 단독 소유한다.**
- `src/db/schema.js`(step0 완료본) — `backfillHistoryTitles(db, { deriveTitle })`의 시그니처·반환값(채운 행 수)·`HISTORY_TITLE_BACKFILL_BATCH`.
- `src/services/historyMeta.js` 18~36행 — 주입할 파생 함수 `snapshotTitle(markupVersion)`. 순수 함수이고 `null`/깨진 JSON에도 throw하지 않으며 항상 문자열을 반환한다(`test/historyMeta.test.js` 58~64행이 잠그고 있다).
- `src/services/logService.js` 27~55행 — `createLogService()`가 돌려주는 `{ debug, info, warn, error, snapshot, ... }`. 링 버퍼 cap은 10000줄이고 Z 전용 SSE/다이제스트로 노출된다.
- `src/models/articleHistoryModel.js` 64~79행(`querySnapshotTitlesByArticle`) + `src/services/articleService.js` 341~372행(`queryHistory`) — E2E 단언의 대상 계약. 조회 결과에서 **레거시 행만** `markupVersion`을 싣는다는 사실을 확인하라.
- `test/csrf-origin.test.js` 175행 부근 — `logOriginDiagnostics` 테스트가 가짜 `logService`를 어떻게 만들어 로그 줄을 검사하는지(신규 테스트의 스타일 기준).
- `docs/ADR.md` ADR-006(35~38행: 계층 방향과 의존성 주입) · ADR-008(45~48행: 앱 내 타이머·egress 금지) — **읽기 전용·무접촉**.
- `phases/59-history-title-backfill/index.json`의 `decisions` (2)·(8)·(9)·(10)·(11).

## 배경 (자기완결)

step0의 `backfillHistoryTitles(db, { deriveTitle })`는 파생 규칙을 **주입받는다** — `src/db`가 `src/services`를 import하면 ADR-006의 계층 방향(controllers → services → models → db)이 역전되기 때문이다. 그 결선(주입)을 하는 자리는 이미 두 계층을 모두 아는 합성 루트, 즉 `server/index.js`의 `bootstrap()`이다.

관측 요구는 두 가지다.

1. 운영자가 "옛 기사 이력이 언제 보정됐는지"를 알 수 있어야 한다 → 채운 행 수를 INFO 1줄로 남긴다.
2. **0건이면 로그를 남기지 않는다.** 근거는 "1회성이라서"가 **아니다** — 레거시 행이 소진된 뒤에도 백필 대상은 드물게 새로 생길 수 있다(phase 58의 기록 게이트가 비문자열 본문 행의 제목 컬럼을 비워 두기 때문이다. step0 "핵심 제약 2" 참조). 근거는 **0은 신호가 아니라는 것**이다: 대부분의 부트에서 0건인데 매번 한 줄씩 남기면 10000줄 링 버퍼(Z 전용 로그 뷰)에 영구 소음이 쌓여 진짜 신호(뒤늦게 채워진 행)가 묻힌다.

로그 본문에는 **건수만** 담는다 — 제목·본문 문자열 금지(LOGS.md 마스킹 규율. `articleService.record`의 콜백이 "식별자·사유만, 본문 스냅샷 금지"인 것과 같은 규율이다).

실패 정책은 전례(`createSchema`·`backfillEmptyDepartments`)와 동일하게 **전파(부팅 중단)** 다. `try/catch`로 감싸 삼키지 마라 — 근거는 step0 주석과 index.json `decisions` (8)에 있다.

## TDD — 테스트 먼저

신규 파일 `test/boot-history-backfill.test.js`를 만든다(기존 테스트 파일 무수정).

가짜 `logService`는 `{ info: (m) => lines.push(['INFO', m]), warn: ..., debug: ..., error: ... }` 정도의 최소 스텁이면 된다(실제 `createLogService()`를 써서 `snapshot()`으로 확인해도 좋다 — 어느 쪽이든 **줄 수와 내용**을 단언할 수 있어야 한다).

1. **기본 결선(파생 기본값)** — `createSchema` + 레거시 스냅샷 행 2건을 심은 in-memory DB에 `runHistoryTitleBackfill({ db, logService })`를 `deriveTitle` **없이** 호출 → 두 행이 채워지고 저장값이 `historyMeta.snapshotTitle(그 본문)`을 직접 호출한 값과 같으며 반환값이 `2`다(기본 결선이 실제로 services의 단일 출처를 쓴다는 증거).
2. **0건이면 로그 0줄** — 대상 행이 없는 DB에서 호출 → 반환 `0`, 기록된 로그 줄이 **정확히 0**이다(부트 소음 금지).
3. **1건 이상이면 INFO 1줄** — 케이스 1의 상황에서 로그가 **정확히 1줄**, 레벨이 INFO이고 메시지에 채운 건수(`2`)가 들어 있다. 그리고 **본문에 심은 표식 문자열(예: `'MARK-BODY-SECRET'`)이 어떤 로그 줄에도 등장하지 않는다**(마스킹).
4. **`logService` 미주입에도 동작** — `runHistoryTitleBackfill({ db })`가 throw하지 않고 백필을 수행하며 반환값이 정확하다.
5. **멱등 결선** — 같은 DB에 helper를 2회 호출 → 2회차 **채운 행 수 `0`**, 2회차에 추가된 로그 줄 0, 저장값 불변("대상 0건"이 아니라 "채운 행 수 0"이 계약이다 — step0 케이스 12 참조).
6. **E2E 실측(이 step의 핵심)** — 한 기사에 레거시 스냅샷 행 3건(`snapshotTitle` `NULL` + 본문) + phase 58 경로로 저장된 신규 행 1건(`snapshotTitle` 문자열 + 본문) + 상태 전이 행 1건을 심고, 실제 `createArticleHistoryModel` + `createArticleService`로 다음을 확인한다.
   레거시 3건의 본문에는 **임베드 블록이 첫 원소인 블록 문서 1건**과 **첫 줄이 200자를 넘는 문서 1건**을 반드시 포함하라 — 파생 규칙(텍스트 블록만 센다·200자 절단)이 백필 경로에서 복제·단순화되면 이 두 건에서 제목이 달라져 deep equal이 red가 된다(서비스 레벨의 규칙 단일 출처 잠금).
   - 백필 **전**: `querySnapshotTitlesByArticle(articleId)` 결과 중 `markupVersion !== null`인 항목이 **3건**이다(레거시 행 blob이 실려 온다).
   - `const before = queryHistory(articleId)`를 저장한다.
   - `runHistoryTitleBackfill({ db })` 실행.
   - 백필 **후**: `querySnapshotTitlesByArticle(articleId)` 결과 중 `markupVersion !== null`인 항목이 **0건**이다(blob 0건 — 이 phase의 목적).
   - `queryHistory(articleId)`가 `before`와 **deep equal**이다(제목·버전·상태·키 집합 전부 동일 — 표시가 바뀌면 개선이 아니라 회귀다).
7. **`sendOnly` 경로 회귀** — 케이스 6의 기사에서 `queryHistory(articleId, { sendOnly: true })`도 백필 전후 deep equal이다(필터 경로가 파생 승계에 의존하므로 함께 잠근다).
8. **빈 제목 레거시 행의 E2E** — 첫 줄이 공백뿐인 레거시 본문 행이 섞여 있어도 백필 후 그 행의 표시 제목이 백필 전과 같고(`''`), 그 행의 blob이 더 이상 실리지 않는다(`''` 저장이 폴백을 되살리지 않는다는 증거 — step0 케이스 3·4의 서비스 레벨 확인).

## 작업

### `server/index.js`

1. import 추가 — 부트 전용 import 블록(17~23행)에 step0의 백필 함수를, 그리고 파생 규칙(`snapshotTitle`)을 `src/services/historyMeta.js`에서 가져온다. 기존 import 순서·주석은 유지한다.

2. 전례(`logOriginDiagnostics`)와 동형의 **export된 부트 헬퍼**를 추가한다(테스트가 부트 없이 검증할 수 있게 — 이 파일의 house style이다):

```js
// 부트 시 멱등 백필 — 표시제목(snapshotTitle)이 비어 있는 스냅샷 행을 그 행 본문에서 파생해 채운다.
// 파생 규칙은 services의 단일 출처를 주입한다(src/db는 services를 import하지 않는다 — ADR-006).
// 로그는 실제로 채운 게 있을 때만 남긴다 — 0건 로그를 매 부트 남기면 Z 전용 링 버퍼에 영구 소음이 된다.
// 메시지에는 건수만 담는다(제목·본문 문자열 금지 — LOGS.md 마스킹).
// 실패는 전파한다(부팅 중단) — createSchema·backfillEmptyDepartments와 같은 정책. 배치당 커밋이라
// 중간 실패에도 진행분은 보존되고, 멱등이라 재기동이 이어서 완결한다.
// 반환값은 채운 행 수 — 테스트가 결선을 직접 확인하기 위한 것이다(호출부는 로그로만 쓴다).
export function runHistoryTitleBackfill({ db, deriveTitle = snapshotTitle, logService }) { /* ... */ }
```

3. `bootstrap()` 결선 — `createSchema`/`backfillEmptyDepartments` 다음, **`app.listen`보다 먼저** 실행한다. 로그를 남기려면 `logService`가 필요하므로 `const logService = createLogService();` 선언(주석 포함)을 그 지점 위로 **이동**한다. 이동 외에 부트 순서·다른 줄은 바꾸지 않는다.

```js
const db = new DatabaseSync('news.db');
createSchema(db);
backfillEmptyDepartments(db);
const logService = createLogService();   // (이동) 백필 결과를 남기기 위해 먼저 만든다
runHistoryTitleBackfill({ db, logService });

const sessionService = createSessionService();
const controllers = createControllers(db, { sessionService, logService });
// ...이하 무수정
```

### 로그 문구

영문 소문자 한 줄로, 기존 부트 로그(`API server on ...`, `distribution spool root ...`)의 수위에 맞춘다. 예: `history title backfill filled 128 rows`. 건수 외의 데이터(기사아이디·제목·본문)는 절대 넣지 마라.

## Acceptance Criteria

```bash
npm test          # 실패 0 — step0 종료 시점 개수 + 신규 케이스(8건 이상)
npm run lint      # 통과
```

**diff scope**: 시작 시점 `git status --porcelain` 스냅샷 대비 증분이 `server/index.js`, `test/boot-history-backfill.test.js` **2개**(+ 진행 기록 `phases/59-history-title-backfill/index.json`)뿐. `src/**`·`web/**`·`docs/**` 증분 0.

**추가 확인(porcelain 증분이 못 잡는 구멍)**: `phases/index.json`은 계획 단계에서 이미 `M` 상태라 증분 판정에 걸리지 않는다. 이 step은 그 파일을 건드리지 않는다 — `git diff phases/index.json`으로 59 항목이 여전히 `pending`이고 그 외 변경이 없는지 직접 확인하라(갱신은 step2 소관).

## 검증 절차

1. 위 AC 커맨드를 실행한다. HTTP/SSE 계열 스위트(`test/server.test.js`·`test/csrf-origin.test.js`·`test/sse-auth.test.js`·`test/server-logging.test.js`·`test/logs-api.test.js`)가 **무수정 green**인지 확인하라(부트 헬퍼 추가가 `createApp` 계약을 건드리지 않았다는 증거).
2. 변이 검증 4종(확인 후 반드시 원복):
   - 채운 행 수가 0일 때도 로그를 남기게 하면 → 케이스 2가 red.
   - `deriveTitle` 기본값(`= snapshotTitle`)을 제거하면 → 케이스 1·4가 red(주입 없이는 `TypeError`).
   - 로그 메시지에 채워진 제목 문자열을 덧붙이면 → 케이스 3이 red(마스킹).
   - `runHistoryTitleBackfill` 호출을 `bootstrap()`에서 지우면 → (테스트로는 잡히지 않으므로) `git diff`로 호출부가 남아 있는지 **눈으로** 확인하라. `bootstrap()`은 테스트가 실행하지 않는다 — 이 한 줄은 코드 리뷰가 유일한 게이트다.
3. 실측 기록(summary에 남길 것): 케이스 6에서 백필 전 blob 적재 건수 → 백필 후 건수(3 → 0), 그리고 `queryHistory` 결과 deep equal 여부.
4. 아키텍처 체크리스트:
   - `bootstrap()`에 타이머(`setInterval`/`setTimeout`)·워커·네트워크 호출이 추가되지 않았는가(ADR-008)?
   - 백필이 `app.listen`보다 **먼저** 실행되는가(요청 처리 중 스키마 상태가 바뀌지 않게)?
   - `src/**`가 무수정인가(step0 산출물 외 변경 0)?
   - 헬퍼가 `process.env`·전역 상태를 직접 읽지 않고 인자만 쓰는가(`logOriginDiagnostics`의 주입 seam 관례)?
   - 응답 계약(`/api/articles/:id/history` 등)이 한 글자도 바뀌지 않았는가?
5. `phases/59-history-title-backfill/index.json`의 step1을 `completed` + `summary`로 갱신한다(헬퍼 시그니처·기본 주입·로그 정책(0건 무로그)·부트 순서 변경 내용·E2E 실측 수치·테스트 증가분·변이 결과 명시).

## 금지사항

- 백필 호출을 `try/catch`로 감싸 삼키지 마라. 이유: `createSchema`·`backfillEmptyDepartments`와 정책이 달라지고, "개선이 안 됐는데 안 된 줄 모르는" 상태가 된다(멱등·배치 커밋이라 재기동이 안전하게 이어서 완결한다).
- 0건일 때 로그를 남기지 마라. 이유: 대부분의 부트에서 0건인데 매번 남기면 Z 전용 10000줄 링 버퍼에 영구 소음이 되어 진짜 신호가 묻힌다 — 0은 신호가 아니다(비문자열 edge로 대상이 재발할 수 있어 "항상 0건"은 보장이 아니다).
- 로그·에러 메시지에 제목·본문·기사아이디 목록을 담지 마라. 이유: LOGS.md 마스킹 규율이며, 이력 본문은 로그 뷰어로 나가면 안 되는 페이로드다(`record`의 `onHistoryError`가 식별자·사유만 담는 것과 같은 규율).
- 백필을 요청 경로(라우트 핸들러·컨트롤러·미들웨어)나 SSE 훅에서 호출하지 마라. 이유: 1회성 마이그레이션이 요청마다 스캔을 유발하고, 동시 요청에서 중복 실행된다. 부트 동기 실행 1회가 확정 설계다.
- `setInterval`/`setTimeout`/워커/큐로 백필을 비동기·주기 실행하지 마라. 이유: ADR-008이 앱 내 타이머를 금지한다(다중 인스턴스 중복 실행). 부트 동기 실행이면 그 문제가 없다.
- `createApp`의 파라미터·라우트·응답 shape을 바꾸지 마라. 이유: 이 step은 부트 결선만이며, transport 계약 변경은 회귀 표면이 전혀 다른 작업이다.
- `src/db/schema.js`·`src/services/**`·`src/models/**`를 수정하지 마라(step0 산출물 포함). 이유: 파일 소유가 겹치면 실패 원인 격리가 불가능하고, step2의 주석 정정과도 충돌한다.
- 백필을 `scripts/seed*.js`에도 끼워 넣지 마라. 이유: 시드 스크립트는 개발용이고 이 phase의 확정 결선은 부트 1곳이다(호출 지점이 늘면 "언제 무엇이 채워졌는지"가 흐려진다).
- `docs/**`·`web/**`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
