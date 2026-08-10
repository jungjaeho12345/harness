# Step 4: retry-list-cost

## 목표

`src/services/distributionRetryService.js`의 `list()`에서 N+1 조회를 없앤다.

1. 수신처 조회(`distributionTargetModel.findById`)에 **호출당 캐시**를 둔다(지금은 항목마다 무조건 조회).
2. 기사 status 조회를 `articleModel.getById`(blob 포함 전체 로드) 대신 step3의 **`getStatusById`(경량)** 로 바꾼다.

응답 항목 shape(10키)·판정 규칙·`retry()`는 **전부 불변**이다. 이 파일 1개(+테스트)만 다룬다.

## 읽어야 할 파일

- `src/services/distributionRetryService.js` 전체(241줄) — 특히 `list({ limit })`(81~123행): `queryDistributionEvents` → `unresolvedFailures` → 항목마다 `distributionTargetModel.findById(it.targetId)` + `tickView(articleId)`(기사 단위 Map 캐시: `articleModel.getById` + `articleHistoryModel.queryByArticle`) → 화이트리스트 투영. 그리고 파일 상단의 책임 경계 주석(인가·HTTP·시점 판정은 이 서비스 책임이 아니다).
- `src/models/articleModel.js`(step3 완료본) — `getStatusById(articleId)`의 반환 3분기(문자열 / `null` / `undefined`).
- `src/services/embargoPolicy.js`의 `cycleDistributedKinds({ status, historyRows })` — `kindDistributed` 파생의 단일 출처(변경 금지).
- `test/distributionRetryService.test.js` — 특히 케이스 2(항목 shape 10키 정확 + `spoolDir`/경로 미노출, 117~135행), 케이스 3(대상 행 부재 폴백 `null`/`null`/`'N'`, 138~155행), 케이스 5(다른 기사·수신처·kind 분리), 케이스 6(limit 정규화), 그리고 `setup()` 헬퍼(실제 db + 실제 모델 조립)와 `retry` 케이스들이 쓰는 **부분 스텁**(`articleModel: { getById: () => null }`, 696~697행).
- `src/controllers/index.js`에서 `createDistributionRetryService(...)`를 결선하는 지점 — 실제 모델이 주입되는 합성 루트(수정하지 마라, 확인만).

## 배경 (자기완결)

`list()`는 Z 전용 미해소 실패 목록을 만든다. 현재 비용:

- 항목마다 `distributionTargetModel.findById(targetId)` — 같은 수신처가 여러 항목에 걸쳐도 매번 조회한다(실패는 특정 수신처에 몰리는 것이 정상이므로 중복률이 높다).
- distinct 기사마다 `articleModel.getById(articleId)` — `status` **한 필드**를 쓰려고 `Article.*`(본문 blob 포함) + `Contents.*`를 읽는다.

수정 방향(확정):

- `targetOf(targetId)`: `list()` 호출마다 새로 만드는 `Map` 캐시. **호출 사이 캐시 금지** — 수신처의 `active`/`kind` 변경이 다음 조회에 즉시 보여야 한다(재전송 게이트가 그 값을 근거로 안내한다).
- `tickView(articleId)`의 `status`를 `articleModel.getStatusById(articleId)`로 얻는다. 주입 모델이 그 메서드를 갖지 않은 부분 스텁이면 `getById` 폴백(`row && row.contents ? row.contents.status : undefined`)을 유지한다 — `typeof articleModel.getStatusById === 'function'` 가드(house style: `articleService.queryHistory`의 스냅샷 조회 가드와 동형).
- `queryByArticle`(사이클 판정 입력)은 그대로 distinct 기사당 1회다. **없앨 수 없다** — `cycleDistributedKinds`가 이력 행을 요구한다.
- `undefined` status(기사 부재)일 때의 기존 동작(그 항목의 `kindDistributed` 파생 결과)이 바뀌면 안 된다.

## TDD — 테스트 먼저

`test/distributionRetryService.test.js`에 케이스를 **추가**한다(기존 케이스 수정 금지).

1. **target 캐시**: 같은 `targetId`로 실패 항목 3건(서로 다른 기사 또는 kind)을 시드하고 `distributionTargetModel.findById`를 래핑해 호출 수를 세면, `list()` 1회에서 호출이 **distinct targetId 수**와 같다(3이 아니라 1).
2. **경량 status**: 한 기사에 실패 항목 3건을 시드하고 `articleModel`을 래핑하면, `list()` 1회에서 `getById` **0회** · `getStatusById` **1회**(distinct 기사 수)다.
3. **부분 스텁 폴백**: `getStatusById`가 없는 스텁 모델(`{ getById }`만)로 조립해도 `list()`가 정상 동작하고 항목 shape·`kindDistributed`가 동일하다.
4. **호출당 캐시**: `list()`를 2회 부르면 `findById`가 각 호출마다 다시 조회된다(호출 사이 캐시 금지). 두 호출 사이에 수신처를 `active:'N'`으로 바꾸면 두 번째 결과의 `targetActive`가 `'N'`이다.
5. **shape 불변**: 케이스 2(10키 정확)·케이스 3(대상 부재 폴백)이 **무수정 green**이고, 신규로도 `spoolDir` 슬러그·파일 경로가 어떤 필드에도 없음을 확인한다.
6. **판정 불변**: `kindDistributed`의 사이클 경계 케이스(재송고 후 이전 사이클 배부 행이 true를 만들지 않는다)가 무수정 green이다. 기사 행이 없는 실패 항목(status `undefined`)에서도 기존과 같은 결과다.
7. 회귀: `retry()` 스위트 전체가 무수정 green(이 step은 `retry`를 건드리지 않는다).

## 작업

`src/services/distributionRetryService.js`의 `list()`만 수정한다.

```js
// 호출당 캐시 — 같은 수신처가 여러 실패 항목에 걸쳐도 조회는 1회다.
// 호출 사이에 캐시하지 않는다: 수신처의 active·kind 변경이 다음 조회에 즉시 보여야 한다
// (재전송 가능 여부 안내의 근거값이다 — phase 57 step15의 getFailureContext 규율과 동형).
const targetCache = new Map();
function targetOf(targetId) { /* 미조회면 findById 후 캐시(undefined도 캐시해 재조회를 막는다) */ }
```

- `tickView(articleId)`의 status 획득만 경량 조회로 바꾼다(가드 + `getById` 폴백). 캐시 구조(`articleCache`)와 `historyRows` 조회는 그대로 둔다.
- 투영 블록은 화이트리스트 그대로다 — 모델 행 스프레드 금지(`spoolDir` 유출의 유일한 경로).
- `normalizeListLimit`·`unresolvedFailures`·`cycleDistributedKinds` 사용법·`retry()`·상수는 전부 무수정이다.

## Acceptance Criteria

```bash
npm test          # 실패 0 — step3 종료 시점 개수 + 신규 케이스(7건 이상)
npm run lint      # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `src/services/distributionRetryService.js`, `test/distributionRetryService.test.js` **2개**(+ 진행 기록 `phases/58-backlog-perf/index.json`)뿐.

## 검증 절차

1. 위 AC 커맨드를 실행한다. `test/distribution-failure-api.test.js`·`test/controllers.test.js`·`test/response-secrets.test.js`·`test/distributionService.test.js`가 **무수정 green**인지 확인하라(HTTP 응답·비밀 위생 계약 불변의 증거다).
2. 변이 검증 3종(확인 후 원복):
   - target 캐시를 제거하면 케이스 1이 red.
   - 캐시를 서비스 수명(클로저 최상단)으로 올리면 케이스 4가 red.
   - status 조회를 `getById`로 되돌리면 케이스 2가 red.
3. 아키텍처 체크리스트:
   - 서비스가 여전히 세션·HTTP를 모르는가(인가는 컨트롤러 책임)?
   - 투영이 화이트리스트인가(`spoolDir`·경로·예외 원문 미노출)?
   - 판정 함수(`unresolvedFailures`·`cycleDistributedKinds`)를 복제하지 않고 재사용하는가?
   - `list()`가 DB에 쓰지 않는가(읽기 전용)?
4. `phases/58-backlog-perf/index.json`의 step4를 `completed` + `summary`로 갱신한다(캐시 범위·경량 조회 가드·조회 횟수 실측(before/after)·변이 결과 명시).

## 금지사항

- 캐시를 서비스 인스턴스 수명이나 모듈 전역으로 올리지 마라. 이유: 수신처 비활성화·kind 변경이 목록에 반영되지 않아 Z가 낡은 근거로 재전송을 누른다(엠바고 미도래 유출로 이어질 수 있는 값이다).
- `kindDistributed` 판정을 `distributedKinds`(전체 이력)로 바꾸거나 자체 구현하지 마라. 이유: 재송고로 새 사이클이 열린 기사에서 과거 사이클 배부 행에 가려 경고가 사라진다(phase 57이 명시적으로 금지한 변형이다).
- 항목 투영에 필드를 추가하거나 모델 행을 스프레드하지 마라. 이유: `spoolDir`(서버 파일 경로 구성요소)가 Z 화면 API로 새는 유일한 경로다 — 케이스 2·5가 잠근다.
- `retry()`의 게이트 순서·조회(`RETRY_SCAN_LIMIT`·`latestSendId` 경계·in-flight)를 건드리지 마라. 이유: phase 57에서 두 차례 block을 거쳐 확정된 보안 경로이며 이 phase의 범위 밖이다.
- 조회 결과를 프로세스 메모리에 영속 캐시하거나 타이머로 갱신하지 마라. 이유: ADR-008은 앱 내 타이머를 금지하며, 다중 인스턴스에서 조용한 불일치를 만든다.
- `src/models/**`를 수정하지 마라. 이유: `getStatusById`는 step3이 확정한 계약이다 — 부족하면 계획 이탈이므로 orchestrator에 보고하라.
- `docs/**`·`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
