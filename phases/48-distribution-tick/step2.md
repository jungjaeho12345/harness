# Step 2: send-des

`src/services/articleService.js` 한 모듈만 고친다. 세 가지를 한다.
1. 송고 후처리의 **EPS 치환을 DES 치환으로 교체**하고, RDS 경로뿐 아니라 **DDH 경로까지** 적용한다(phase 47 리뷰가 지적한 "DDH 송고 엠바고 기사가 DPS로 새는 구멍" 해소).
2. 송고 즉시 배부 판정(`distributionKindsForSend`)의 기준 상태를 EPS → DES로 옮긴다.
3. 배부 성공 후 상태를 재계산해 승격하는 **`syncEmbargoStatus`** 를 신설하고, 송고 훅에 결선한다(2차만 설정 기사: 송고 즉시 press 배부 → DES→EPS).

이 step은 **기존 EPS 단언을 광범위하게 갱신**한다. 아래 "영향 라인 전수 목록"을 그대로 따르라.

## 배경 (사용자 확정 스펙 2026-07-28 A항)

- **DES 진입**: 엠바고 시각(`embargoAt` 또는 `secondEmbargoAt`)이 설정된 기사를 데스크(D/Z)가 송고하는 순간. **RDS 경로든 DDH 경로든 동일**.
- **DES→EPS**: 첫 배부가 실제 실행되는 시점. 2차만 설정 기사는 송고 즉시 press 배부(phase 47 훅)가 첫 배부이므로 **송고 직후 EPS**가 된다.
- **EPS→DPS**: 그 기사의 모든 엠바고 배부가 완결된 시점(1차만=1차 배부 후, 2차만=2차 배부 후, 1+2차=2차 배부 후).
- 기존 EPS 행은 마이그레이션하지 않는다(A.5) — 레거시 EPS 행의 KILL/보류/재송고 거부 계약은 그대로여야 한다.

## 읽어야 할 파일

- `docs/news.md` — "엠바고 규칙" 절 전문 + "기사 생애주기" 절(`엠바고 기사는 RDS->DES->EPS 가 기본 생애주기가 된다`).
- `docs/ADR.md` — ADR-008 (4)(5), ADR-004(role은 세션에서만 도출), ADR-006(계층 분리).
- `src/services/embargoPolicy.js` — **step0에서 생성**. `requiredKinds`·`distributedKinds`·`embargoStatusFor` 시그니처와 규칙.
- `src/services/lifecycle.js` — **step1에서 수정**. `DESK_TABLE.DES = { kill:'EEK', hold:'EEH' }`가 이미 있어야 한다.
- `src/services/articleService.js` — 전체. 특히 `distributionKindsForSend`(69-79행), `applyAction`(137-188행: transition → `(끝)` 마커 → EPS 치환(148-156행) → `articleModel.update` → `record()` → 배부 훅(174-186행)), `record()` 헬퍼(85-89행).
- `src/services/distributionService.js` — `distribute(articleId,{kinds,actorUserId})`의 반환 shape `{ ok, distributed:[{targetId,kind,spoolDir,file}], failed:[...] }`(40-99행)와 `eventType='distribute'` 이력 기록 조건(84-88행).
- `src/models/articleHistoryModel.js` — `queryByArticle` 반환 shape.
- `phases/48-distribution-tick/step0.md`, `step1.md` — 이 phase의 앞선 두 step 계약.

## 작업

**TDD: 아래 "영향 라인 전수 목록"의 테스트를 먼저 고쳐 red를 만든 뒤 구현한다.**

### 1) `src/services/articleService.js` — DES 치환 (현재 148-156행 교체)

```
조건: action === 'send'
   && (role === 'D' || role === 'Z')
   && transition 결과 status === 'DPS'
   && (embargoAt || secondEmbargoAt)          // truthy 판정 유지(빈 문자열은 미설정)
   && 이전 status(row.contents.status) ∈ { 'RDS', 'DDH' }
→ finalStatus = 'DES'
```
- **`'EPS'` 문자열은 이 파일에서 사라진다**(치환 결과·판정 기준 모두 DES).
- **이전 status를 RDS·DDH로 한정하는 이유**(반드시 주석으로 남길 것): `DPS` 재송고(고침/포털고침 후 재송)까지 DES로 되돌리면,
  이미 배부 이력이 있는 기사는 tick의 "미배부" 판정(step3)에 걸리지 않아 **영구 DES 고착** 상태가 된다(복구 수단 없음).
  news.md·사용자 확정 스펙이 열거하는 진입 경로도 "데스크 미송고(RDS)"와 "DDH"뿐이다. DPS 재송고는 phase 47 계약(DPS 유지 + 즉시 전체 배부)을 그대로 유지한다.
- 엠바고 판정은 **DB에 저장된 값**으로만 한다(클라이언트 값 불신 — ADR-004). 현행 코드와 동일.

### 2) `distributionKindsForSend(status, contents)` (현재 75-79행)

```js
if (status === 'DPS') return ['press', 'nonpress'];          // 유지 — ADR-008 (4)
if (status === 'DES' && !contents.embargoAt && contents.secondEmbargoAt) return ['press']; // EPS → DES로 기준 교체
return [];
```
- `'EPS'` 분기는 **삭제**한다. 이유: 이제 송고 성공 후 상태가 EPS가 되는 경로는 없다(lifecycle에 `EPS.send`가 없어 EPS 기사의 재송고는 거부된다). 죽은 분기를 남기면 두 상태가 같은 의미를 갖는 것처럼 오독된다.
- 시각 비교는 **여기서 하지 않는다**(도래 판정은 step3 tick). 현행 주석의 이 원칙을 유지·갱신하라.

### 3) `syncEmbargoStatus(articleId, { extraKinds = [] } = {})` 신설 — 배부 이력 기반 상태 재계산·승격

- 시그니처(구현은 재량):
  ```js
  function syncEmbargoStatus(articleId, { extraKinds = [], actorUserId = null } = {})
  // → { ok:true, status } (변경 없으면 현재 status 그대로) | { ok:false, reason:'not-found' }
  ```
- 동작:
  1. `articleModel.getById(articleId)`로 현재 contents/status를 읽는다.
  2. 배부된 kind 집합 = `embargoPolicy.distributedKinds(historyModel?.queryByArticle(articleId) ?? [])` ∪ `extraKinds`.
     `extraKinds`는 방금 성공한 배부의 kind 힌트다(이력 insert가 실패로 격리됐을 때의 보정 — distributionService의 `record`는 실패를 삼킨다).
  3. `embargoPolicy.embargoStatusFor({ status, contents, distributed })`가 `null`이 아니면 `articleModel.update(articleId, { contents: { status: next } })`.
  4. 상태가 실제로 바뀐 경우에만 `record({ articleId, eventType:'status', action:'embargo', fromStatus, toStatus, actorUserId })`로 이력을 남긴다.
- **present-only 업데이트**: `status` 외 컬럼(`sentAt`·`sender`·본문·잠금)을 절대 함께 쓰지 마라.
- **승격 권한 판정 없음**: 이것은 사람의 액션이 아니라 배부 사실의 반영이다. `transition()`을 거치지 않는 이유를 주석으로 남겨라
  (lifecycle 전이표는 role×action 표이고, 여기엔 role도 action도 없다. 대신 허용 범위는 `embargoPolicy.embargoStatusFor`가 DES/EPS로 좁혀 강제한다).
- `createArticleService`의 반환 객체에 `syncEmbargoStatus`를 추가한다(step3 tick 서비스가 호출한다).

### 4) 송고 훅 결선 (현재 174-186행)

- `distribute(...)`가 **성공적으로 resolve**하고 `result.distributed.length > 0`이면, 성공한 kind만 모아
  `syncEmbargoStatus(articleId, { extraKinds: 성공kinds, actorUserId })`를 호출한다.
- **승격 가드는 `result.distributed`(실제 스풀 기록 성공 목록)로만 판단한다.** `result.ok`만 보고 승격하면
  `{ ok:true, distributed:[], failed:[...] }`(전 수신처 쓰기 실패)에서도 완결 처리가 되어 **배부되지 않은 기사가 DPS**가 된다.
  이 경로는 아래 "가짜 배부 서비스 보강" 2번 케이스가 회귀 가드로 잠근다.
- `applyAction`의 **동기 반환 계약은 그대로 유지**한다(`Promise` 반환 금지). 승격은 fire-and-forget 체인 안에서 일어난다.
- 실패/reject는 기존과 동일하게 삼킨다 — 배부 실패는 송고를 되돌리지 않으며, **실패한 kind는 승격 근거가 될 수 없다**(거짓 완결 금지).

## 영향 라인 전수 목록 (`EPS` grep 결과 — 판단까지 명시. 이 표를 벗어난 파일은 이 step에서 건드리지 마라)

### 수정 대상

| 파일:라인 | 현재 | 조치 |
|---|---|---|
| `src/services/articleService.js:69-79` | 판정표 주석 + `status==='EPS'` 분기 | **변경** — 주석 갱신 + `'DES'` 기준으로 교체 |
| `src/services/articleService.js:148-156` | RDS 한정 EPS 치환 | **변경** — RDS·DDH 경로 DES 치환 |
| `test/articleService.test.js:154-166` | `엠바고 설정된 RDS 기사를 D가 송고하면 EPS로 진입` | **변경** — 기대 `'DES'`(제목도 DES로). `sender`/`sentAt` 단언은 유지 |
| `test/articleService.test.js:168-176` | `2차 엠바고만 설정돼도 RDS→EPS, Z 송고도 동일` | **변경** — 기대 `'DES'`. 이 setup은 `distributionService` 미주입이라 승격이 일어나지 않는다(훅 비활성) |
| `test/articleService.test.js:185-193` | `R 송고는 RDS 유지` | **유지**(문구의 "EPS 진입"만 "DES 진입"으로) — R 송고는 여전히 치환 대상 아님 |
| `test/articleService.test.js:195-205` | `엠바고 설정된 DDH 기사를 D가 송고해도 DPS 유지 (EPS는 RDS 송고 한정)` | **변경(계약 반전)** — 이제 `'DES'`. 이것이 phase 47 리뷰가 지적한 구멍의 수정 증거다. 제목도 `DDH 송고도 DES로 진입한다`로 교체 |
| `test/articleService.test.js:207-225` | `EPS 기사를 D가 KILL하면 EEK, 보류하면 EEH` | **변경 + 추가** — 송고 결과가 DES이므로 DES 기사 KILL/보류로 바꾸고, **레거시 EPS 행**(모델로 직접 `status:'EPS'` 주입)의 KILL→EEK·보류→EEH를 잠그는 케이스를 **추가**한다 |
| `test/articleService.test.js:227-237` | `EPS 기사 재송고(send)는 거부` | **변경 + 추가** — DES 재송고 거부로 바꾸고, 레거시 EPS 재송고 거부 케이스도 **추가** |
| `test/articleService.test.js:178-183` | 엠바고 미설정 RDS 송고 → DPS | **유지**(회귀 가드) |
| `test/articleSendDistribution.test.js:1-7` | 판정표 주석 | **변경** — DES 기준으로 갱신 |
| `test/articleSendDistribution.test.js:19-31` (`fakeDistribution`) | 성공 모드가 `{ ok:true, distributed:[], failed:[] }`(28행)만 반환하고 이력도 남기지 않음 | **변경(필수 — 아래 "가짜 배부 서비스 보강" 절 참조)** — 이 가짜를 그대로 두면 승격 단언이 **구조적으로 통과 불가**다 |
| `test/articleSendDistribution.test.js:62-74` | `2차 엠바고만 → EPS + press 즉시 배부` | **변경** — `applyAction` 반환은 `'DES'`, flush 후 `kinds:['press']` 1회 호출은 유지, **flush 후 DB status가 `'EPS'`로 승격**됨을 추가 단언. **이 단언은 아래 "가짜 배부 서비스 보강" 1번을 먼저 적용해야 통과한다** |
| `test/articleSendDistribution.test.js:76-90` | `1차만/1+2차 → EPS + 즉시 배부 없음` | **변경** — 기대 `'DES'`, 배부 0건 유지, flush 후에도 DB status `'DES'` 유지 단언 추가 |
| `test/articleSendDistribution.test.js:118-132` | 거부 경로(127행 `status:'EPS'` 픽스처) | **유지 + 추가** — 레거시 EPS send 거부는 그대로 두고, `status:'DES'` send 거부 케이스를 추가 |
| `test/articleSendDistribution.test.js:134-145` | DPS 재송고·DDH→DPS(엠바고 없음) | **유지** — 엠바고 미설정이므로 결과 불변(회귀 가드) |
| `test/articleSendDistribution.test.js:147-178` | 배부 실패 격리·미주입 하위호환·동기 반환 계약 | **유지 + 추가** — 세 가지 실패 상황 모두에서 status가 `DES`에 머물고 승격되지 않음을 잠근다: ① `{ok:false}`(mode `'fail'`), ② reject(mode `'reject'`), ③ **호출은 성공했으나 전 수신처 쓰기 실패**(`{ok:true, distributed:[], failed:[...]}`, 신규 모드). 147-161행의 `hist.length === 1` 단언은 그대로 유지 |
| `test/articleHistoryService.test.js:53-67` | `엠바고 RDS 송고(EPS 진입) 이력 toStatus는 EPS다` | **변경** — `toStatus`가 `'DES'` |
| `test/server.test.js:159-187` | `엠바고 설정된 RDS를 D가 송고하면 EPS, EPS 기사 KILL→EEK·보류→EEH` | **변경** — 응답 `status`가 `'DES'`, DES 기사 KILL→EEK·보류→EEH. 182-185행 회귀 가드(엠바고 미설정→DPS)는 유지. (이 테스트 환경은 `DIST_SPOOL_DIR` 미설정이라 배부 훅 비활성 → DES에 머문다) |

### 가짜 배부 서비스 보강 (`test/articleSendDistribution.test.js:19-31`) — 이 절을 건너뛰면 step2는 실패한다

현재 `fakeDistribution`의 성공 모드는 28행에서 `return { ok: true, distributed: [], failed: [] };`를 돌려주고 `ArticleHistory`에 `distribute` 행도 남기지 않는다.
그 상태로는 §4의 승격 조건(`result.distributed.length > 0` → `extraKinds`)도, `embargoStatusFor`(distributed=`[]` → 계산값 `'DES'` = 현재값 → `null`)도 **승격을 만들 수 없다**.
즉 62-74행의 "flush 후 DB status가 `'EPS'`" 단언은 가짜를 고치지 않는 한 절대 green이 되지 않는다.

**CRITICAL — 여기서 절대 하면 안 되는 "쉬운 green"**: 승격 가드를 `res.ok`만 보도록 완화하는 것.
그러면 전 수신처 스풀 쓰기 실패(`{ ok:true, distributed:[], failed:[...] }`)에도 DES→EPS/DPS 승격이 일어나 **배부되지 않은 기사가 완결 처리**된다.
테스트는 전부 green이라 후속 게이트로도 잡히지 않는다. 반드시 **가짜 쪽을 실물 계약에 맞추는 방향으로** 해결하라.

1. **성공 모드는 요청 kind별 non-empty `distributed`를 반환한다** — 예: `distributed: kinds.map((kind) => ({ targetId: 1, kind, spoolDir: 'out/x', file: 'f.json' }))`.
   실물 `distributionService.distribute`의 반환 shape(`src/services/distributionService.js:73-76`)과 동형이어야 `extraKinds`가 채워진다.
2. **전량 실패 모드를 별도 케이스로 추가한다** — `{ ok:true, distributed:[], failed:[{ targetId:1, kind, reason:'spool-write-failed' }] }`를 돌려주는 모드로
   "**승격 없음 + status `DES` 유지 + `eventType='status'` 이력이 송고 1건 그대로**"를 잠근다(거짓 완결 금지의 회귀 가드).
   기존 `mode:'fail'`(`{ok:false}`)·`mode:'reject'`와는 **다른 상황**이다(호출은 성공했으나 모든 수신처 쓰기가 실패) — 셋 다 남겨라.
3. **가짜가 non-empty를 돌려주면 엠바고 미설정 DPS 케이스(48-60행, 147-161행)에서도 훅이 `syncEmbargoStatus`를 호출하게 된다.**
   그래도 `requiredKinds({})`가 `[]` → `embargoStatusFor`가 `null` → **DB 쓰기 0건**이므로 147-161행의 `hist.length === 1` 단언은 그대로 유지된다.
   구현자는 이 단언을 완화·삭제하지 마라 — 이 단언이 "엠바고 없는 기사에는 승격 이력이 붙지 않는다"의 증거다.
   (선택적으로 `syncEmbargoStatus`가 엠바고 미설정 기사에서 조기 반환하도록 구현해도 되지만, 계약은 "쓰기 0건"이지 "호출 0건"이 아니다.)

### 변경하지 않는 것 (판단 근거 포함)

| 파일:라인 | 판단 |
|---|---|
| `src/services/lifecycle.js:16` (`EPS: { kill:'EEK', hold:'EEH' }`) | **유지** — 레거시 EPS 행 보존(step1에서 DES 행이 추가돼 있다) |
| `test/lifecycle.test.js:29-33, 63-69` | **유지** — step1에서 DES 행이 이미 추가됨. EPS 행은 레거시 계약 |
| `test/spoolWriter.test.js:55,115` (픽스처 `status:'EPS'`) | **유지** — 스풀 페이로드는 status를 그대로 반출할 뿐이며 값의 의미에 의존하지 않는다 |
| `test/distributionService.test.js:4` (주석) | **유지**(선택적으로 주석만 현행화 가능) |
| `src/services/distributionService.js:12`, `src/services/distributionTargetService.js:5` (주석의 "EPS→DPS") | **유지** — 이 step의 범위 밖(주석 현행화는 step4에서 함께) |
| `web/**`의 EPS 참조 | **유지** — step5 |
| `docs/news.md`의 EPS 행 | **유지** — 사용자 스펙, 수정 금지 |

## Acceptance Criteria

```bash
node --test test/articleService.test.js test/articleSendDistribution.test.js test/articleHistoryService.test.js
npm test
npm run lint
```

- 위 3개 파일 green.
- `npm test` 기준선: **총 527 / pass 523 / fail 4**(phase 47 머지본의 기존 실패 — Windows 경로 구분자 `\` vs `/` 단언, phase 48 범위 밖):
  1. `createControllers: DIST_SPOOL_DIR 설정 시 송고가 활성 수신처 스풀에 배부된다` (`test/controllers.test.js`)
  2. `레거시 행의 잘못된 spoolDir는 실제 writer가 거부해 failed로 격리된다(경로 조작 방어)` (`test/distributionService.test.js:265`)
  3. `spoolWriter: 수신처 폴더를 recursive mkdir 후 임시 파일에 쓰고 rename으로 게시한다` (`test/spoolWriter.test.js`)
  4. `spoolWriter: 파일명은 <articleId>_<timestamp>.json 이며 재배부해도 덮어쓰지 않는다` (`test/spoolWriter.test.js`)
  → 합격 조건은 **"fail이 위 4건 그대로, 신규 실패 0"**. 위 4건 중 1번은 `articleService`를 거치는 end-to-end 테스트지만 실패 사유는 경로 구분자 단언이다 —
  **이 step에서 그 테스트의 단언을 고치지 마라**(범위 밖). 단, 실패 메시지가 경로 단언(`/spool/out/kbs` vs `\spool\out\kbs`)인지 확인해 사유가 바뀌지 않았음을 증명하라.
- `npm run lint` clean.
- web 무접촉이므로 `npm run test:web`/`npm run build`는 이 step의 AC가 아니다.

## 검증 절차

1. 테스트 먼저 수정 → red 확인(EPS 기대와 DES 실제의 불일치).
2. 구현 → 위 3개 파일 green.
3. `npm test` 후 fail 목록을 4건과 이름으로 대조하고, 각 실패 메시지가 경로 구분자 사유인지 확인.
4. `grep -rn "EPS" src/services/articleService.js` → **0건**(치환·판정 모두 DES로 이동했다는 증거).
5. `git diff --stat`이 `src/services/articleService.js` + 위 4개 테스트 파일뿐인지 확인(소스는 1개 모듈만).
6. DB 비파괴 확인: 새 테스트에서 승격 전후 `SELECT COUNT(*) FROM Contents`/`Article`이 동일하고, `sentAt`·`sender`가 승격으로 변하지 않음을 단언한다.

## 금지사항

- `applyAction`을 `async`로 바꾸지 마라. 이유: 라우트(`server/index.js:530`)와 다수 기존 테스트가 동기 반환을 전제한다 — 조용한 광범위 회귀가 생긴다.
- 배부 실패를 송고 실패로 전환하거나, 실패한 kind로 상태를 승격하지 마라. 이유: 스풀 쓰기 실패로 기사가 잠기면 복구 수단이 없고(ADR-008: 앱은 발송 결과를 모른다), 거짓 완결은 배부되지 않은 기사를 DPS로 만든다.
- 승격 단언을 green으로 만들려고 `res.ok`만 보는 가드로 완화하지 마라. 고쳐야 할 것은 **가짜 배부 서비스**다(`test/articleSendDistribution.test.js:19-31`). 이유: 그 완화는 전 수신처 실패 시에도 완결 처리를 만들고, 테스트가 전부 green이라 어떤 후속 게이트로도 잡히지 않는다.
- `syncEmbargoStatus`에서 `status` 외의 컬럼을 쓰지 마라. 이유: present-only 업데이트가 DB 비파괴의 실현 수단이다.
- DES 치환을 DPS 재송고 경로까지 확대하지 마라. 이유: 이미 배부 이력이 있는 기사가 DES로 돌아가면 tick의 미배부 판정에 걸리지 않아 영구 고착된다.
- 엠바고 시각과 현재 시각을 `articleService`에서 비교하지 마라. 이유: 시점 판정은 tick(step3)의 단일 책임이다.
- `lifecycle.js`를 수정하지 마라(step1에서 완료). 이유: 한 step은 한 모듈 — 전이표와 후처리를 동시에 흔들면 실패 원인 격리가 불가능하다.
- 기존 EPS 행을 DES로 바꾸는 UPDATE/백필을 넣지 마라. 이유: 사용자 확정 스펙 A.5(마이그레이션 없음) + DB 비파괴.
- `web/**`, `server/index.js`, `src/controllers/index.js`를 건드리지 마라. 이유: 라우트/결선은 step4, 프론트 노출은 step5다.
