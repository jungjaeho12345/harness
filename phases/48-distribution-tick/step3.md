# Step 3: tick-service

엠바고 시점 배부 엔진 `src/services/distributionTickService.js`를 신설한다.
"시각이 도래했고 아직 배부되지 않은 엠바고 배부"를 스캔해서 실행하고, 배부 결과에 따른 상태 승격을 위임한다.
**HTTP·타이머·파일시스템은 이 step에 없다** — 라우트/결선은 step4다.

## 배경

- ADR-008 (3): 시점 배부는 앱 내 타이머가 아니라 **`POST /api/distribution/tick`(Z/시스템 전용) pull 엔드포인트**로 실행한다. 외부 운영 cron이 주기 호출한다(로그 다이제스트 pull과 동형 — ADR-007).
- 사용자 확정 스펙 B.7-B.8:
  - `embargoAt <= now`이고 press 미배부 → `press` 배부, 상태가 DES면 EPS 전이
  - `secondEmbargoAt <= now`이고 nonpress 미배부 → `nonpress` 배부, 완결 시 DPS 전이
  - **대상 선정은 "엠바고 시각 + 미배부 여부" 기준**이며, 미배부 판정 근거는 `ArticleHistory`의 `eventType='distribute'` 행의 `action`(kind)이다.
  - 엠바고가 설정됐지만 상태가 **DPS인 레거시 기사**(phase 47 이전에 DDH 경로로 송고돼 EPS/DES를 못 거친 기사)도 tick이 잡아야 한다.
  - **EEK(엠바고 킬)·EEH(엠바고 보류)·DPD(삭제 승인) 기사는 제외**한다.
  - 여기에 더해 **미송고 상태(RDS·RRH·RRK·DDH·DDK)도 제외**한다 — 데스크가 송고하지 않은 기사를 외부 수신처로 내보내면 회수 수단이 없다.
    → 결과적으로 배부 후보 상태는 `['DES','EPS','DPS']`이며, 이 목록은 step0의 `EMBARGO_DISTRIBUTABLE_STATUSES`가 단일 출처다.
- `now`는 **주입**한다(가짜 시계 테스트). 실서버 주입은 step4.

## 읽어야 할 파일

- `docs/ADR.md` — ADR-008 전문(특히 (3)(5)), ADR-006(계층 분리·의존성 주입), ADR-007(pull 엔드포인트 관례).
- `docs/news.md` — "엠바고 규칙" 절.
- `src/services/embargoPolicy.js` — **step0에서 생성**. `EMBARGO_DISTRIBUTABLE_STATUSES`·`requiredKinds`·`distributedKinds`·`dueKinds`·`unparsableEmbargoFields`.
- `src/services/articleService.js` — **step2에서 수정**. `syncEmbargoStatus(articleId, { extraKinds, actorUserId })` 시그니처와 승격 규칙.
- `src/services/distributionService.js` — `distribute(articleId, { kinds, actorUserId })` 계약. **`KINDS`(15행)와 교집합 필터(45행) 덕분에 `kinds:['nonpress']` 단독 호출이 이미 지원된다 — distributionService를 수정할 필요가 없다.** 반환 shape은 `{ ok, distributed:[{targetId,kind,spoolDir,file}], failed:[{targetId,kind,spoolDir,reason}] }`, 미가용 시 `{ ok:false, reason:'spool-disabled'|'not-found' }`.
- `src/models/articleModel.js` — `query(filters)`가 지원하는 필터(특히 `status` 배열 IN, 73-140행)와 `Contents` 행 shape.
- `src/models/articleHistoryModel.js` — `queryByArticle(articleId)`.
- `src/services/collectionService.js` — 같은 "외부 트리거로 도는 도메인 서비스"의 반환/에러 처리 관례(참고).
- `test/distributionService.test.js` — in-memory DB + 실제 모델 + 가짜 writer 테스트 관례(이 step의 테스트도 같은 골격).

## 작업

**TDD: `test/distributionTickService.test.js`를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) 시그니처 (구현 재량, 계약 고정)

```js
export function createDistributionTickService({
  articleModel,
  historyModel,
  distributionService,      // 미주입/undefined면 tick은 no-op 실패를 반환한다
  articleService,           // syncEmbargoStatus 제공자 — 상태 전이의 단일 출처
  now = () => new Date().toISOString(),
});
// → { run }

async function run({ actorUserId = null } = {});
// → { ok:true, at, scanned, distributed:[{ articleId, kinds:[...], status }],
//     failed:[{ articleId, targetId, kind, reason }],   // ← spoolDir 등 경로 정보 제외(투영 필수)
//     invalid:[{ articleId, field }] }
// distributionService 미주입 → { ok:false, reason:'spool-disabled' }
```

- `scanned`는 **후보 기사 수**(상태 allowlist + 엠바고 설정 필터를 통과한 기사 수)다. 운영자가 tick 비용 증가를 관측하는 유일한 신호이므로 반드시 담는다.
- `failed` 항목은 **식별자와 사유만** 담는다. 아래 §2-4의 투영 규칙을 반드시 따르라 — 이 값은 그대로 HTTP 응답으로 나간다(step4).

### 2) run()의 동작 (순서 고정)

1. `const at = now()` — 한 번만 읽는다(같은 실행 안에서 시계가 흔들리면 판정이 갈린다).
2. 후보 조회: `articleModel.query({ status: [...EMBARGO_DISTRIBUTABLE_STATUSES] })` 후
   `requiredKinds(contents).length > 0`인 행만 남긴다(엠바고 미설정 기사는 tick의 관심사가 아니다). 남은 개수를 `scanned`에 담는다.
   - **비용 인식(의도적 수용)**: 이 조회는 `SELECT * FROM Contents WHERE status IN (...)`(`src/models/articleModel.js:92-99,139`)이라
     매 tick마다 **송고된 전 기사(DPS 전량)** 를 로드한 뒤 JS에서 거른다. DPS 포함은 사용자 확정 스펙 B.8(레거시 DPS 엠바고 기사 픽업)의 필수 대가이므로 **그대로 수용**한다.
     대신 `scanned`로 규모를 노출해 운영자가 증가를 관측할 수 있게 한다. 모델에 엠바고 전용 SQL 필터/인덱스를 추가하는 최적화는 **이 phase 범위 밖**이다(모델 계층 변경 금지).
3. 후보를 **순차(sequential await)** 로 처리한다. 병렬 실행 금지 — SQLite 단일 파일 쓰기와 상태 승격 순서를 예측 가능하게 유지한다.
4. 각 후보에 대해:
   - `distributed = distributedKinds(historyModel.queryByArticle(articleId))`
   - `due = dueKinds({ status, contents, distributed, now: at })`
   - `unparsableEmbargoFields(contents)`가 비어있지 않으면 `invalid`에 담는다(무음 삼킴 금지 — 운영자가 오타를 알아야 한다).
   - `due.length > 0`이면 `await distributionService.distribute(articleId, { kinds: due, actorUserId })`
     - 성공한 kind(= `res.distributed`의 kind 집합)가 1개 이상이면
       `articleService.syncEmbargoStatus(articleId, { extraKinds: 성공kinds, actorUserId })`를 호출하고 결과 status를 요약에 담는다.
     - `res.failed`는 **그대로 넣지 말고 투영해서** 합친다: `({ articleId, targetId, kind, reason })`.
       이유: 실물 실패 항목은 `{ articleId, targetId, kind, spoolDir, reason }`(`src/services/distributionService.js:77`)라
       **서버 파일시스템 경로(`spoolDir`)가 tick HTTP 응답으로 그대로 유출**된다(step4의 "식별자와 사유만" 규율 위반).
       화이트리스트 투영으로 만들어라 — 향후 실패 항목에 필드가 추가돼도 자동으로 비노출이다(안전 기본값).
   - `due.length === 0`이고 현재 status가 `'DES'`/`'EPS'`이면 **재정합(self-heal)** 으로 `syncEmbargoStatus(articleId)`를 호출한다.
     이유: 이력은 있는데 승격이 누락된 기사(이력 insert 실패·과거 데이터 등)가 영원히 대기 상태로 남지 않게 한다. `embargoStatusFor`가 `null`이면 아무 쓰기도 일어나지 않는다.
   - 한 기사의 예외가 스캔 전체를 중단시키면 안 된다 — 기사 단위 try/catch로 격리하고 `failed`에 `reason`을 남긴다.
5. `run`은 **throw하지 않는다**(라우트가 500으로 새지 않도록).

### 3) 불변 규칙 (반드시 코드 주석으로 근거를 남길 것)

- **멱등**: 같은 시각으로 여러 번 호출해도 이미 배부된 kind는 다시 배부되지 않는다(판정 근거가 append-only 이력이므로 자연 성립).
- **상태 전이는 여기서 구현하지 않는다** — `articleService.syncEmbargoStatus`에 위임한다(생애주기 단일 출처). tick에서 `articleModel.update(..., { contents: { status } })`를 직접 호출하는 코드는 금지다.
- **실패한 kind는 승격 근거가 아니다**(거짓 완결 금지).
- **앱 타이머 없음**: `setInterval`/`setTimeout`/`setImmediate` 기반 주기 실행을 만들지 않는다. `run`은 외부 호출자만 트리거한다.
- **egress 없음**: `fetch`/소켓/HTTP 클라이언트를 쓰지 않는다. 외부로 나가는 유일한 경로는 `distributionService`→`spoolWriter`의 파일 쓰기다.
- **응답에 경로·본문 금지**: `spoolDir`·파일 경로·기사 본문은 요약에 담지 않는다(식별자와 사유만 — step4 라우트가 이 값을 그대로 반환한다).
- **`distributedAt`은 배부가 실행될 때마다 갱신된다** — tick이 별도로 쓰지 않고 `distributionService`(`src/services/distributionService.js:94-96`)가 present-only로 갱신한다.
  사용자 확정 스펙 9번의 "최초 1회 유지" 문언은 `distributionService`를 **다시 만들지 말라(재사용하라)**는 뜻으로 읽고,
  값 정책은 `docs/SCHEMA.md:49`("배부가 실행될 때마다 가장 최근 시각으로 갱신하고, 개별 배부 이벤트는 ArticleHistory에 append-only")를 따른다.
  → 1차 배부 후 `T1`, 2차 배부 후 `T2`(`T2 > T1`). 과거 배부 사실은 이력에 남으므로 정보 손실이 없다. **tick에서 `distributedAt`을 직접 쓰지 마라.**
- **엠바고가 모두 해제된 DES/EPS 기사**(`embargoAt`·`secondEmbargoAt`를 둘 다 지운 기사)는 후보에서 빠져 대기 상태로 남는다 — **phase 48 범위 밖**이며 운영 액션(KILL/보류)으로 처리한다. 이를 자동 승격시키는 규칙을 발명하지 마라(배부되지 않은 기사의 완결 처리가 된다).

### 4) 테스트 (`test/distributionTickService.test.js`, node:test)

in-memory DB + 실제 `articleModel`/`articleHistoryModel`/`articleService`(step2) + **가짜 distributionService**로 구성한다.
가짜는 호출 인자를 기록하고, 성공 시 **실물과 동일하게** `historyModel.insert({ articleId, eventType:'distribute', action: kind, createdAt })`를 남겨야 한다.
(이걸 빼면 멱등성·승격 검증이 가짜가 된다.)

최소한 다음을 잠근다:
- **1차만**: `now < embargoAt` → 배부 0, status `DES` 유지. `now >= embargoAt` → `kinds:['press']` 1회, status `DES` → `DPS`(1차만은 1차 배부가 곧 완결).
- **2차만**: 송고 즉시 press가 이미 배부된 `EPS` 기사에 대해 `now >= secondEmbargoAt` → `kinds:['nonpress']` 1회, status `EPS` → `DPS`.
- **1+2차**: 1차 도래 → `['press']`, `DES` → `EPS`. 이어서 2차 도래 시각으로 재실행 → `['nonpress']`, `EPS` → `DPS`.
- **경계**: `embargoAt === now`(정확히 같은 시각)는 **도래**로 취급한다.
- **멱등**: 같은 시각으로 연속 2회 실행 → 2회차의 `distribute` 호출 0건, status 불변, `Contents`/`Article`/`ArticleHistory` 행 수 검증.
- **제외 상태**: `EEK`·`EEH`·`DPD`·`RDS`·`DDH` 각각에 엠바고 시각이 도래해 있어도 배부 0건(5케이스).
- **레거시 DPS**: `status='DPS'` + 엠바고 설정 + `distribute` 이력 없음 → 도래한 kind가 배부되고, **status는 DPS 그대로**(역행 없음).
- **부분 실패**: 가짜가 `{ ok:true, distributed:[], failed:[{targetId,kind,reason}] }`를 돌려주면 status 승격 없음 + `failed` 요약에 반영.
- **경로 비노출**: 가짜가 실물처럼 `failed:[{ articleId, targetId, kind, spoolDir:'out/kbs', reason }]`를 돌려줘도
  `run()`의 `failed` 항목에 **`spoolDir` 키가 없다**(`Object.keys` 단언 또는 `JSON.stringify(result)`에 `'out/kbs'` 미포함).
- **`distributedAt` 갱신**: 실제 `distributionService`(가짜 spoolWriter 주입)로 1+2차 기사를 두 시각에 tick하면
  1차 후 `distributedAt = T1`, 2차 후 `T2`이고 `T2 > T1`이다(SCHEMA.md:49 계약). 이력에는 `distribute` 행이 2건 남는다.
- **`scanned`**: 엠바고 기사 2건 + 엠바고 없는 DPS 기사 3건이 있을 때 `scanned === 2`(후보만 센다).
- **미가용**: `distributionService` 미주입 → `{ ok:false, reason:'spool-disabled' }`이고 DB 쓰기 0건.
- **파싱 불가 엠바고 값**(`embargoAt: '내일 오전'`) → 배부 0 + `invalid`에 `{ articleId, field:'embargoAt' }`.
- **예외 격리**: 한 기사에서 `distribute`가 reject해도 다른 기사의 배부는 계속되고 `run`은 정상 반환한다.
- **DB 비파괴**: 실행 전후 `Contents`/`Article` 행 수 동일, 기존 송고 이력(`eventType='status' && action='send'`) 보존, `sentAt`·`sender`·본문 불변.

## Acceptance Criteria

```bash
node --test test/distributionTickService.test.js
npm test
npm run lint
```

- 신규 테스트 전부 green.
- `npm test` 기준선: **총 527 / pass 523 / fail 4**(phase 47 머지본의 기존 실패 — Windows 경로 구분자 `\` vs `/` 단언, phase 48 범위 밖):
  1. `createControllers: DIST_SPOOL_DIR 설정 시 송고가 활성 수신처 스풀에 배부된다` (`test/controllers.test.js`)
  2. `레거시 행의 잘못된 spoolDir는 실제 writer가 거부해 failed로 격리된다(경로 조작 방어)` (`test/distributionService.test.js:265`)
  3. `spoolWriter: 수신처 폴더를 recursive mkdir 후 임시 파일에 쓰고 rename으로 게시한다` (`test/spoolWriter.test.js`)
  4. `spoolWriter: 파일명은 <articleId>_<timestamp>.json 이며 재배부해도 덮어쓰지 않는다` (`test/spoolWriter.test.js`)
  → 합격 조건은 **"fail이 위 4건 그대로, 신규 실패 0, pass는 신규 테스트 수만큼 증가"**(step0-2에서 추가된 테스트 포함).
- `npm run lint` clean.
- web 무접촉이므로 `npm run test:web`/`npm run build`는 이 step의 AC가 아니다.

## 검증 절차

1. 테스트 작성 → red(모듈 부재) 확인.
2. 구현 → `node --test test/distributionTickService.test.js` green.
3. `npm test` 후 fail 목록을 위 4건과 이름 대조(신규 실패 0).
4. 금지 API grep — `src/services/distributionTickService.js`에서 `setInterval|setTimeout|fetch|node:fs|node:sqlite|prepare\(|DELETE FROM|DROP ` **0건**.
5. 상태 전이 위임 확인 — 같은 파일에서 `articleModel.update` **0건**(승격은 `syncEmbargoStatus`만), `distributedAt` 문자열 **0건**(배부 시각 갱신은 `distributionService` 책임).
6. 응답 위생 확인 — `run()` 결과를 `JSON.stringify`했을 때 `spoolDir`/파일 경로 문자열이 없음을 테스트로 단언(위 "경로 비노출" 케이스).
7. `git diff --stat`이 `src/services/distributionTickService.js` + `test/distributionTickService.test.js` **2개 파일뿐**인지 확인.

## 금지사항

- 앱 안에 타이머/스케줄러(`setInterval` 등)를 만들지 마라. 이유: ADR-008 (3)이 명시적으로 tick pull을 택했고, 앱 타이머는 다중 인스턴스에서 중복 배부를 만든다.
- `fetch`·소켓 등 네트워크 전송을 추가하지 마라. 이유: 앱은 egress가 없다(발송은 외부 전송기 — ADR-008 (1)).
- tick 안에서 status를 직접 UPDATE하지 마라. 이유: 생애주기 단일 출처는 `lifecycle`/`articleService`다. 두 곳에서 상태를 쓰면 규칙이 갈라진다.
- 상태(`status === 'EPS'`)만으로 배부 대상을 고르지 마라. 이유: 레거시 DPS 엠바고 기사가 영영 배부되지 않는다(사용자 확정 스펙 B.8).
- 반대로 상태 필터를 완전히 없애지도 마라. 이유: 미송고(RDS/DDH)·킬(EEK)·보류(EEH)·삭제(DPD) 기사가 외부로 나간다 — 회수 불가능한 사고다.
- `distributionService`/`spoolWriter`/`articleService`의 파일을 수정하지 마라. 이유: 이 step은 신규 모듈 1개만 추가한다. `kinds:['nonpress']` 단독 호출은 이미 지원된다(distributionService.js:15,45).
- 배부 실패를 삼키지 마라(로그/요약 어디에도 남기지 않는 경로 금지). 이유: 앱은 발송 결과를 모르므로 미발송 사실이 유일한 운영 신호다.
- 후보를 `Promise.all`로 병렬 배부하지 마라. 이유: 같은 기사에 대한 이력/상태 쓰기 경합과 비결정적 테스트를 만든다.
- `distributionService`가 돌려준 `failed` 항목을 **그대로** 요약에 넣지 마라. 이유: `spoolDir`(서버 파일시스템 경로)가 tick HTTP 응답으로 유출된다 — 화이트리스트 투영만 허용한다.
- tick에서 `distributedAt`을 직접 쓰지 마라. 이유: 배부 시각 갱신은 `distributionService`의 단일 책임이며(SCHEMA.md:49), 두 곳에서 쓰면 값이 갈라진다.
