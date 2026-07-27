# Step 1: distribution-service

## 목표

배부 실행 도메인 서비스 `src/services/distributionService.js`를 만든다. 책임은 정확히 셋이다:
(1) **대상 선택**(active='Y' 중 audience에 해당하는 kind), (2) **스풀 기록**(step0 writer 호출),
(3) **DB 기록**(`Contents.distributedAt` 최초 1회 stamp + `ArticleHistory` append 1행).

이 서비스는 **누가 언제 배부를 트리거하는지 모른다**. 송고 후처리 결선은 step2, 시각 도래 배부(tick)는 phase 48이다.

배경(자기완결 — 이전 대화를 참조하지 마라):

- **ADR-008**이 배부 아키텍처의 단일 출처다: 앱은 스풀 디렉토리에 기사 JSON을 쓰기만 하고 발송은 외부 전송기가 한다.
  **앱 내 타이머·네트워크 egress 금지.** 트레이드오프 문단이 못박은 대로 **스풀 기록 시각 = `distributedAt` = 배부 지시 완료**(발송 완료가 아니다).
- **news.md 엠바고 규칙**(L256~263): 1차 엠바고 시각 → 언론사, 2차 엠바고 시각 → 비언론사(단 **송고 시 바로 언론사**),
  1+2차는 각각. 엠바고 없는 일반 기사는 송고 즉시 전체 배부(ADR-008 (4)).
  → 그래서 audience는 이번 phase에서 **`'press'`(언론사만)** 과 **`'all'`(언론사+비언론사)** 두 가지다.
- **news.md L12**: "기사를 조회하는 함수에서는 **배부시간**을 조건으로 기사를 조회할 수 있다" — `Contents.distributedAt`이 그 값이고,
  조회 필터(`distributedAtFrom`/`distributedAtTo`)는 `src/models/articleModel.js` L79·L126에 **이미 구현돼 있다**(클라 변경 불요).
- **phase 46 완료분**: `DistributionTarget` 테이블·모델·서비스·관리 UI(`distMgmt.do`)·`sanitizeSpoolDir`.
- **step0 완료분(이번 step의 입력)**: `src/services/spoolWriter.js` — `buildDistributionPayload(...)`(순수) +
  `createSpoolWriter({ rootDir, fs })` → `{ enabled, write({ target, payload }) }`
  (파일명 재료 `articleId`·`distributedAt`은 **writer가 payload에서 파생**한다 — 별도 인자로 넘기지 않는다).
  `write`는 **절대 throw하지 않고** `{ ok:true, path }` 또는 `{ ok:false, reason, message? }`를 반환한다(동기).

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 반드시 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-008 전문(L45~48)**, ADR-006(계층·주입, L35~38), ADR-004(신뢰 경계=서버 세션, L25 부근), ADR-007(타이머/egress 금지, L40~43).
- `docs/news.md` — **엠바고 규칙(L256~263)**, 기사 함수의 **배부시간 조회(L12)**, 기사 생애주기(L265~).
- `docs/SCHEMA.md` — `## Contents Table`(L42~51), `## DistributionTarget Table`(L76~87). **이 step에서 수정한다**(§5).
- `docs/ARCHITECTURE.md` — 계층 분리(L33), 보안 경계(L54~57).
- **step0 산출물**: `src/services/spoolWriter.js` **전체** — 특히 `buildDistributionPayload` 인자 shape과
  `write`의 reason 집합(`disabled`/`invalid-spool-dir`/`invalid-article-id`/`invalid-timestamp`/`write-failed`).
- `test/spoolWriter.test.js` — 가짜 fs 하네스(이 step의 통합 테스트에서 재사용).
- **phase 46 산출물**:
  - `src/models/distributionTargetModel.js` **전체(50줄)** — `query(filters)`는 화이트리스트 AND 동등 필터 + `ORDER BY id`.
  - `src/services/distributionTargetService.js` L10~20(`SAFE_FIELDS`/`FILTER_KEYS`/`KINDS`=`press|nonpress`/`ACTIVE`), L38~42(주입 시그니처·`now` 기본값).
  - `phases/46-distribution-targets/index.json` step0·step1 summary.
- `src/models/articleModel.js` — `CONTENTS_COLS`(L7~14, `distributedAt` L10), `updateSet` present-only(L24~30),
  `tx`(L33~43), `update(articleId, { article, contents })`(L62~69), 시간 범위 필터(L79·L126).
- `src/models/articleHistoryModel.js` **전체(46줄)** — `HISTORY_COLS`(L6~9), present-only `insert`(L21~23),
  `queryByArticle`(L28~34 — **id DESC 정렬** + `hasSnapshot` 파생), `querySnapshotById`(L38~43).
- `src/services/articleService.js` — `record` 헬퍼(L72~76 — 이력 실패가 본 기능을 막지 않는 선례),
  `applyAction`(L124~161), **`queryHistory`의 sendOnly 필터(L203~208)**.
- `src/services/logService.js` — `createLogService`(L27), 레벨(L7), 주입 시계 주석(L4). **주입 시계 선례**.
- `src/services/collectionService.js` L25~43 — 주입형 서비스 선례. 특히 L32의 관대한 활성 판정
  `(c.active ?? 'Y') !== 'N'` — **이 step은 의도적으로 다르게 간다**(§2 참조).
- `src/controllers/index.js` **전체(124줄)** — 결선 형태 파악용. **이 step에서는 수정하지 않는다**(결선은 step2).
- 소비처 확인용(수정 금지, 읽기만): `server/index.js` L473~483(`GET /api/articles/:id/history`),
  `web/src/view/ListPage.jsx` L258~289(이력 모달, L278이 `종류` 열),
  `web/src/view/WriterPage.jsx` L624~625(`hasSnapshot` 필터), `web/src/test/fakeModel.js` L156~160,
  `test/controllers.test.js` L145~166(이력 **1건** 단언 — 회귀 주의).

## 변경할 파일

**신규**
- `src/services/distributionService.js`
- `test/distributionService.test.js`

**수정**
- `docs/SCHEMA.md` — additive 문서화만(§5).

**수정 금지**: `src/controllers/index.js`, `server/index.js`, `src/services/articleService.js`, `web/**`
(결선·송고 훅은 step2다).

## 상세 설계

### 1) 시그니처

```js
// src/services/distributionService.js
import { buildDistributionPayload } from './spoolWriter.js';

export function createDistributionService({
  articleModel,             // getById / update (Contents present-only)
  distributionTargetModel,  // query
  historyModel = null,      // ArticleHistory insert (미주입이면 이력 생략 — articleService.record 선례)
  spoolWriter = null,       // step0 { enabled, write } (미주입/비활성이면 배부 비활성)
  now = () => new Date().toISOString(),  // 주입 시계(테스트 결정성)
  logger = null,            // { debug, info, warn, error } — logService 호환. 미주입이면 무로그
}) {
  // distribute(articleId, audience, { actorUserId = null } = {}) ->
  //   { ok: true, attempted, written, failures: [{ targetId, spoolDir, reason }], distributedAt }
  //   | { ok: false, reason: 'not-found' | 'invalid-audience' }
  return { distribute };
}
```

- **모델을 직접 주입받는다**(articleService를 주입받지 마라). 이유: step2에서 `articleService`가
  `distributionService`를 주입받으므로, 반대 방향 의존을 만들면 순환이 된다.
- `distribute`는 **동기**다(step0 writer가 동기, DB가 `DatabaseSync`). `async`로 만들지 마라 — step2에서
  `applyAction`이 Promise를 반환하게 되어 기존 테스트가 깨진다.
- `distribute`는 **어떤 경우에도 throw하지 않는다**(내부 예외는 전부 잡아 결과 객체로 변환).

### 2) 대상 선택 규칙

```js
const AUDIENCE_KINDS = {
  press: ['press'],              // 언론사만 (2차 엠바고 기사 송고 시 즉시 배부)
  all:   ['press', 'nonpress'],  // 전체 (엠바고 없는 일반 기사 송고 시)
};
```

- 알 수 없는 audience(`'nonpress'` 포함, 오타, undefined) → `{ ok:false, reason:'invalid-audience' }`.
  **`'nonpress'`를 지금 추가하지 마라** — 비언론사 시각 배부는 phase 48 소관이며, 그때 이 맵에 additive로 추가한다.
  느슨하게 받아들이면 잘못된 수신처군으로 오발송된다.
- 조회: `distributionTargetModel.query({ active: 'Y' })` 후 `AUDIENCE_KINDS[audience].includes(row.kind)`로 필터.
  - **`active: 'Y'` 엄격 판정**(수집의 `(active ?? 'Y') !== 'N'` 관대 판정과 **의도적으로 다르다**).
    근거: `DistributionTarget.active`는 `VARCHAR DEFAULT 'Y'`(`src/db/schema.js` L90)이고 phase 46 서비스가
    항상 `'Y'`/`'N'`을 stamp하므로 **엄격 판정이 정상 행을 누락시키지 않는다**(직접 SQL로 NULL을 넣은 행만 제외되며,
    outbound에서 "알 수 없는 활성 상태"를 배부하지 않는 쪽이 fail-safe다 — 오발송 피해가 비대칭적으로 크다).
    이 근거를 파일 주석에 남겨라(다음 사람이 관대 판정으로 "통일"하지 않게).
  - kind도 **화이트리스트 매칭**이다 — 알 수 없는 kind 값(레거시/직접 SQL)은 어떤 audience에도 포함되지 않는다.
  - 정렬은 모델의 `ORDER BY id`를 그대로 쓴다(결정적 순회).
  - **중복 `spoolDir` 대상은 앞선 것만 배부한다**: 순회 중 이미 이번 호출에서 쓴 `spoolDir`을 다시 만나면
    그 대상은 **skip**하고 `failures`에 `{ targetId, spoolDir, reason: 'duplicate-spool-dir' }`로 남긴다(id 오름차순이라 결정적).
    이유: phase 46의 유일성 검증은 **앱 계층에서만** 강제되므로 직접 SQL로 같은 `spoolDir`을 가진 활성 대상 2건이 존재할 수 있고,
    그대로 두면 뒤 대상이 앞 대상의 파일을 **덮어쓰면서** `written`은 2로 과대 보고된다(배부되지 않은 수신처가 배부된 것으로 기록된다).

### 3) 실행 절차 (순서가 곧 계약)

1. `audience` 검증 → 실패 시 즉시 반환(DB·fs 접촉 없음).
2. `const row = articleModel.getById(articleId)` → **`!row || !row.contents || !row.article`이면
   `{ ok:false, reason:'not-found' }`**(+ `row`는 있는데 한쪽 테이블만 없는 손상 케이스는 `logger?.warn`으로 구분해 남긴다).
   근거: `getById`는 Article·Contents 중 **하나만 있어도 행을 반환한다**(`src/models/articleModel.js` L47~52).
   Article 행이 없으면 본문이 없다는 뜻인데, **본문 없는 기사를 외부 수신처로 내보내는 것은 되돌릴 수 없다** —
   outbound는 fail-safe로 간다(정상 생성 경로는 두 행을 한 트랜잭션에 넣으므로 이 분기는 손상 데이터에서만 발생한다).
3. **배부 비활성 판정**: `!spoolWriter || !spoolWriter.enabled` →
   `logger?.debug('distribution disabled ...')` 후 `{ ok:true, attempted:0, written:0, failures:[], distributedAt:null }`.
   **DB를 건드리지 않는다**(파일이 하나도 안 나갔는데 배부시간이 찍히면 조회 결과가 거짓이 된다).
4. 대상 목록 산출(§2). 0건이면 3과 동일한 "아무것도 안 함" 결과 + `logger?.debug`.
5. `const distributedAt = now()` — **한 번만 호출**해 모든 대상 파일이 **같은 타임스탬프**를 쓰게 한다(파일명·payload 일관).
6. 대상마다 순서대로(중복 `spoolDir`은 §2대로 skip):
   - `payload = buildDistributionPayload({ article: row.article, contents: row.contents, target, audience, distributedAt })`
   - `const r = spoolWriter.write({ target, payload })`
     — **인자는 2개뿐이다**(step0 §1: 파일명 재료는 writer가 payload에서 파생한다. `articleId`/`distributedAt`을
     따로 넘기려 하지 마라 — writer 시그니처에 없다).
   - 성공: `written += 1`, `logger?.info('distribution spool write articleId=… targetId=… spoolDir=… audience=…')`
   - 실패: `failures.push({ targetId: target.id, spoolDir: target.spoolDir, reason: r.reason })`,
     `logger?.warn('distribution spool failed articleId=… targetId=… spoolDir=… reason=…')` 후 **다음 대상으로 계속**(중단 금지).
   - **로그에 기사 제목·본문·payload를 담지 마라**(수집 로깅 관례 — `server/index.js` L856 "payload는 담지 않는다").
7. `written === 0`이면 **DB를 건드리지 않고** 결과 반환(이력도 남기지 않는다 — §4).
8. `written >= 1`이면:
   - a. **distributedAt stamp(최초 1회)**: `row.contents.distributedAt`이 **falsy일 때만**
     `articleModel.update(articleId, { contents: { distributedAt } })`. 값이 이미 있으면 **갱신하지 않는다**.
   - b. **이력 append 1행**: `historyModel?.insert({ articleId, eventType: 'distribute', action: audience, actorUserId: actorUserId ?? null, createdAt: distributedAt })`
     — `try/catch`로 격리한다(이력 실패가 배부를 실패시키지 않는다 — `articleService.record` L72~76 선례).
   - c. a도 `try/catch`로 격리하고 실패 시 `logger?.warn`. 이유: 파일은 이미 나갔으므로 결과는 `ok:true`여야 한다.
9. 반환: `{ ok:true, attempted, written, failures, distributedAt: written ? distributedAt : null }`.

**멱등성/재배부**:
- 같은 기사를 다시 배부하면(예: DPS 재송고 = 정정본) 스풀 파일이 **새 타임스탬프로 다시 생성**되고 이력이 1행 더 쌓인다.
  중복 방지 가드를 넣지 마라 — 정정본이 배부되지 않는 것이 더 큰 결함이다.
- `Contents.distributedAt`은 그 경우에도 **최초 값 그대로**다. 근거: news.md L12 배부시간 조회와 ADR-008 (4)에서
  이 값은 "배부 개시(지시) 시각"이며, 2차 엠바고 기사는 언론사 즉시배부(지금) → 비언론사 시각배부(phase 48)로
  **두 번 배부되는 것이 정상**인데 매번 갱신하면 "언제 배부가 시작됐는가"를 영영 알 수 없게 된다.

### 4) ArticleHistory 확장 — additive 계약 (전수 확인 결과)

기록 단위: **배부 1회 = 1행**(대상별 1행이 아니다). 근거: 대상 수만큼 행이 늘면 이력 모달이 수신처 목록으로 도배되고,
기사 생애주기 이력이라는 화면 의미가 무너진다. 대상별 상세는 **스풀 파일 자체와 로그**가 증거다.

기록 필드:

| 컬럼 | 값 | 비고 |
|------|-----|------|
| `eventType` | `'distribute'` | **신규 값**(기존 `'status'`\|`'edit'`에 additive). 스키마 변경 없음 — 자유 VARCHAR. |
| `action` | `audience` (`'press'`\|`'all'`) | phase 48이 "언론사 배부가 끝났는가"를 이력으로 판정할 수 있게 하는 값이다. |
| `actorUserId` | 트리거한 사용자 id 또는 `null` | step2의 송고 후처리는 송고자 userId, phase 48 tick은 `null`(시스템). |
| `createdAt` | `distributedAt` | 파일의 배부 지시 시각과 동일 값. |
| `fromStatus`/`toStatus`/`markupVersion` | **전달하지 않는다**(undefined) | present-only insert라 컬럼에서 제외 → NULL. |

**소비처 전수 확인 — 각 소비처가 `'distribute'` 행을 만났을 때의 거동**(구현 전에 직접 재확인하라):

| # | 소비처 | 거동 | 판정 |
|---|--------|------|------|
| 1 | `src/models/articleHistoryModel.js` `insert`(L21~23) | present-only — 새 컬럼 불필요, 미전달 컬럼은 NULL | 무변경 |
| 2 | 〃 `queryByArticle`(L28~34) | eventType 필터 없음 → distribute 행도 반환. `markupVersion` NULL → **`hasSnapshot=0`** | 무변경 |
| 3 | 〃 `querySnapshotById`(L38~43) | id 지정 시 조회는 되나 `markupVersion`이 NULL(본문 없음). 아래 #6이 접근 자체를 막는다 | 무변경 |
| 4 | `src/services/articleService.js` `queryHistory` sendOnly(L207) | `eventType==='status' && action==='send'` → **distribute 행 제외**(송고이력 화면 불변) | 무변경 |
| 5 | `server/index.js` `GET /api/articles/:id/history`(L473~483) | 위임만 — 그대로 통과 | 무변경 |
| 5b | `web/src/model/httpModel.js` `queryHistory`(L175~178) | 응답 JSON 무가공 반환(도메인 로직 0) — eventType을 해석하지 않는다 | 무변경 |
| 5c | `web/src/controller/useViewController.js` L180~183 | `model.queryHistory` 결과를 모달로 그대로 전달(필터·라벨 매핑 없음) | 무변경 |
| 6 | `web/src/view/WriterPage.jsx` L625 기사이력비교 | `filter((h) => h.hasSnapshot)` → distribute 행 **자동 제외** | 무변경 |
| 7 | `web/src/view/ListPage.jsx` L278 이력보기 모달 `종류` 열 | `h.eventType ?? h.action ?? ''` **원문 표시** — 기존에도 `status`/`edit` 영문 원문을 그대로 보여준다(라벨 맵 없음) → `distribute`도 동형 표시. `전이` 열은 from/to 모두 NULL이라 빈칸, `작성자` 열은 actorUserId | 무변경(오표시 없음) |
| 8 | `web/src/test/fakeModel.js` L156~160 | sendOnly를 `action==='send'`로만 판정(서버와 다름). distribute의 action은 `'press'`\|`'all'`이라 **오검출 없음** | 무변경(이번 phase web 무접촉) |
| 9 | `web/src/view/historyView.js` | 앱에서 쓰이지 않는 레거시 모듈(자기 테스트만). eventType을 escape해 출력 | 무변경 |
| 10 | `test/controllers.test.js` L145~166 / `test/server.test.js` L220~264 | 송고 후 **이력 1건**을 단언한다. 배부는 스풀 루트 미주입 시 **비활성**이라 이 테스트들에서 행이 늘지 않는다 | 무변경(step2에서 재확인) |

**주의**: #4의 필터를 `action`만 보도록 바꾸지 마라. 지금은 무해하지만 "송고이력 = status+send" 계약을 약화시킨다.

### 5) `docs/SCHEMA.md` — additive 문서화 (이 step에서 수행)

1. `## Contents Table`의 property 목록에 **배부시간 시맨틱 한 줄 추가**(기존 줄은 수정하지 마라):
   - `distributedAt`은 **최초 배부 지시 시각**(ISO-8601 UTC)이다. 스풀 파일 기록이 1건 이상 성공했을 때 서버가 stamp하며,
     **이미 값이 있으면 갱신하지 않는다**(재배부·2차 엠바고의 2회 배부에도 최초 값 유지). 발송 완료 시각이 아니다(ADR-008).
     배부가 비활성(스풀 루트 미설정)이거나 대상 0건이면 stamp하지 않는다.
2. `## ArticleHistory Table` 섹션을 **신규 추가**한다(L8 테이블 목록에는 이미 있으나 섹션이 누락돼 있다 — stale 보정, 순수 additive).
   내용은 **현행 구현 그대로만** 적는다(없는 규칙을 창작하지 마라):
   - 컬럼: `id`(INTEGER PK, ROWID alias), `articleId`, `eventType`, `action`, `fromStatus`, `toStatus`, `actorUserId`, `createdAt`, `markupVersion`.
   - append-only — 행 삭제/수정 없음(DB 비파괴). 모델에 삭제 함수 없음.
   - `eventType`: `'edit'`(편집 저장 — `markupVersion` 스냅샷 동반), `'status'`(생애주기 전이 — `action`/`fromStatus`/`toStatus` 동반),
     **`'distribute'`(배부 지시 — `action`에 대상군 `press`\|`all`, from/to·스냅샷 없음, phase 47)**.
     값 집합은 **additive**이며 소비처는 알 수 없는 값을 만나도 원문 표시/필터 제외로 안전하게 동작한다.
   - 보조 인덱스/FK 없음.
3. **stale 1줄 현행화(이 step의 유일한 기존 문장 수정 허용 예외)**: `## DistributionTarget Table`의 `spoolDir` 설명(L82)이
   "**앱은 이 phase에서 디렉토리를 만들거나 파일을 쓰지 않는다(실제 스풀 쓰기는 phase 47)**"라고 적혀 있는데,
   이 step으로 그 진술이 거짓이 된다. → "배부 스풀 하위 폴더명(슬러그)이다. 배부 실행 시 스풀 루트 아래 이 폴더에
   기사 JSON을 기록한다(phase 47, ADR-008). 대상 관리 API는 문자열 검증·저장만 한다." 취지로 **그 한 줄만** 고친다.

그 외 문서 수정은 **추가만** 한다 — 위 3 이외의 기존 문장 삭제·재작성 금지.

## TDD 테스트 목록 (red → green 순서)

`test/distributionService.test.js` 신규. 하네스: in-memory `DatabaseSync(':memory:')` + `createSchema` +
실제 `articleModel`/`distributionTargetModel`/`articleHistoryModel` + step0 `createSpoolWriter`에 **가짜 fs** 주입
+ 고정 시계(`now = () => '2026-07-27T09:00:00.000Z'`). (`test/articleHistoryService.test.js` L1~24 setup 스타일 차용.)

**A. 대상 선택**

1. `audience='all'` — 활성 press 1 + 활성 nonpress 1 → 파일 2개, 각 대상 폴더에 1개씩.
2. `audience='press'` — 같은 데이터에서 **press 폴더에만** 파일 1개(nonpress 폴더 미생성 — `mkdirSync` 인자 단언).
3. `active='N'` 대상은 제외된다(soft delete된 수신처로 나가지 않는다).
4. 알 수 없는 `kind`(`'other'`, `null`) 행은 어떤 audience에도 포함되지 않는다.
5. `audience`가 `'nonpress'`/`'ALL'`/`undefined`/`null` → `{ ok:false, reason:'invalid-audience' }`이고 **fs·DB 접촉 0**.
6. 없는 articleId → `{ ok:false, reason:'not-found' }`, fs 접촉 0.
6b. **Contents만 있고 Article 행이 없는 손상 기사**(테스트에서 `Contents`에만 직접 INSERT) →
    `{ ok:false, reason:'not-found' }`, **fs 접촉 0**, throw 없음(본문 없는 기사를 내보내지 않는다 — §3.2).
6c. **중복 `spoolDir`**: 같은 `spoolDir`을 가진 활성 대상 2건(직접 INSERT)을 `audience='all'`로 배부하면
    파일은 **1개**, `written===1`, `failures`에 `{ reason:'duplicate-spool-dir' }` 1건이다(뒤 대상이 앞 파일을 덮어쓰지 않는다).

**B. 스풀 payload**

7. 기록된 파일을 `JSON.parse`하면 `schema==='yh-dist-article'`, `audience`, `target.spoolDir`, `article.articleId`,
   `article.markupVersion`(원문)이 일치한다.
8. 두 대상 파일의 `distributedAt`이 **동일**하다(`now()` 1회 호출).
9. `internalComment`가 채워진 기사를 배부해도 파일 내용에 그 값이 없다(step0 계약 재확인 — 회귀 잠금).

**C. distributedAt 정책**

10. 배부 성공 후 `Contents.distributedAt`이 주입 시계 값으로 stamp된다.
11. **이미 값이 있으면 갱신되지 않는다**: `distributedAt='2026-01-01T00:00:00.000Z'`인 기사를 배부하면
    파일은 새로 써지지만 DB 값은 그대로다(반환 `distributedAt`은 이번 지시 시각).
12. `written===0`(대상 0건 / writer 비활성 / 전량 실패)이면 **stamp하지 않는다**(DB 값 여전히 null).
13. stamp가 **다른 Contents 컬럼을 건드리지 않는다**: 배부 전후 행 전체를 비교해 `distributedAt` 외 전 컬럼이 동일하다.

**D. 이력**

14. 배부 1회 = 이력 1행, `eventType==='distribute'`, `action===audience`, `fromStatus/toStatus===null`,
    `actorUserId`가 옵션 값(미전달 시 null), `createdAt===distributedAt`.
15. 대상 3건을 배부해도 이력은 **1행**이다(대상별 행이 아니다).
16. **`queryHistory(articleId, { sendOnly: true })`에 distribute 행이 섞이지 않는다**(articleService 경유로 확인 — #4 계약 잠금).
17. `queryByArticle` 결과에서 distribute 행의 `hasSnapshot===0`이다(#6 계약 잠금).
18. `historyModel` 미주입이어도 배부는 정상 동작한다(이력만 생략).
19. `historyModel.insert`가 throw해도 `{ ok:true }`이고 파일·distributedAt은 유지된다.

**E. 실패/비활성**

20. `spoolWriter` 미주입 또는 `enabled===false` → `{ ok:true, attempted:0, written:0 }`, DB 무변경, **fs 호출 0**.
21. 한 대상의 `spoolDir`가 오염(`'../x'`)돼 있으면 그 대상만 skip되고 **나머지 대상은 정상 기록**된다.
    결과 `failures`에 `{ targetId, spoolDir, reason:'invalid-spool-dir' }`가 담기고 `written===1`이다.
22. `writeFileSync`가 특정 폴더에서만 throw해도 나머지는 기록되고, 결과는 `ok:true`(부분 성공) + `failures` 1건이다.
23. **전량 실패**(모든 대상 write 실패) → `ok:true`, `written===0`, `failures.length===attempted`,
    `Contents.distributedAt` 미stamp, **이력 0행**.
24. `distribute`는 어떤 입력에도 throw하지 않는다(모델이 throw하도록 조작해도 결과 객체로 수렴).

**F. 로깅·아키텍처 가드**

25. 주입한 가짜 logger에 실패 시 `warn`, 성공 시 `info`가 남고, **기록된 로그 문자열에 기사 제목/본문이 포함되지 않는다**.
26. 모듈 소스에 `node:fs`·`fetch`·`setTimeout`·`setInterval`·`DELETE FROM`·`DROP`가 **없다**(소스 문자열 단언).

순서: **A → B → C → D → E → F**. A~B(파일이 올바른 곳에 올바른 내용으로) green 이전에 C(DB) 구현을 시작하지 마라.

## Acceptance Criteria

```bash
npm test
npm run lint
```

- `npm test`: **fail 0**, pass = step0 완료 시점 개수 + 신규 테스트 수(감소하면 회귀).
  참고 기준선: 이 계획 작성 시점 `pass 489 / fail 0`(step0에서 신규분만큼 증가한 값이 이 step의 출발점이다).
- `npm run lint`: clean(경고 0).
- `npm run test:web` / `npm run build`는 이 step의 AC가 **아니다**(web 무접촉).

## 검증 절차

1. `test/distributionService.test.js`를 먼저 작성해 **red**(`ERR_MODULE_NOT_FOUND`) 확인 후 구현한다.
2. A~F 순서로 green을 만든다.
3. `grep -n "node:fs\|node:path\|fetch(\|setInterval\|setTimeout" src/services/distributionService.js` → **0건**
   (파일 IO는 전부 주입된 spoolWriter 경유).
4. `grep -rn "DELETE FROM\|DROP \|TRUNCATE" src/services/distributionService.js` → **0건**.
5. `grep -n "articleService\|require\|process.env" src/services/distributionService.js` → **0건**
   (서비스→서비스 역의존 금지, env 판독 금지).
6. `git diff --stat`이 **정확히 3개 파일**(`src/services/distributionService.js`, `test/distributionService.test.js`, `docs/SCHEMA.md`)인지 확인한다.
   `src/controllers/**`·`server/**`·`web/**`·`src/services/articleService.js`가 diff에 있으면 **범위 위반**이다.
7. DB 비파괴 체크:
   - [ ] `Contents`는 `distributedAt` UPDATE만(다른 컬럼 무변경 — 테스트 13이 증명)
   - [ ] `ArticleHistory`는 append만
   - [ ] 어떤 경로에도 행 삭제 없음
8. `docs/SCHEMA.md` diff가 **추가 라인 위주**인지 확인한다(기존 문장 삭제·재작성이 있으면 되돌려라).

## 커밋 계획

- **feat**: `feat(47-distribution-service): step1 — distributionService(대상 선택·스풀 기록·distributedAt 최초 1회·배부 이력)`
  — `src/services/distributionService.js`, `test/distributionService.test.js`, `docs/SCHEMA.md`.
- **chore**: `chore(47-distribution-service): step1 status — completed` — `phases/47-distribution-service/index.json`만.

## 금지사항

- `distributionService`가 `articleService`를 주입받거나 import하지 마라. 이유: step2에서 `articleService`가 `distributionService`를 주입받는다 — 반대 방향을 만들면 순환 의존이 된다.
- `distribute`를 `async`로 만들지 마라. 이유: step2에서 `applyAction`이 Promise를 반환하게 되어 동기 계약에 의존하는 기존 백엔드 테스트가 대량으로 깨진다.
- `distribute`에서 throw하지 마라. 이유: 상위(step2)에서 배부 실패가 송고를 실패시키면 안 된다(ADR-008 — 배부는 후처리다).
- 스풀 파일이 **하나도** 기록되지 않았는데 `distributedAt`을 stamp하지 마라. 이유: news.md L12 배부시간 조회가 배부되지 않은 기사를 배부된 것으로 보여준다(데이터 거짓).
- 이미 값이 있는 `distributedAt`을 덮어쓰지 마라. 이유: 2차 엠바고 기사는 언론사 즉시배부 → 비언론사 시각배부로 두 번 배부되는 것이 정상인데, 덮어쓰면 "배부 개시 시각"이라는 의미가 소실된다(ADR-008 (4)).
- 재배부(정정본 송고) 중복 방지 가드를 넣지 마라. 이유: DPS 재송고는 고침/정정 반영이며, 정정본이 배부되지 않는 것이 훨씬 큰 결함이다.
- `audience`에 `'nonpress'`를 추가하거나 알 수 없는 audience를 관대하게 처리하지 마라. 이유: 비언론사 시각 배부는 phase 48 소관이고, 관대한 처리는 잘못된 수신처군 오발송으로 직결된다.
- 배부 대상을 `ReceiverConfig`(수집 설정)에서 찾지 마라. 이유: ADR-008 (2) — ReceiverConfig는 수집(inbound) 전용이며 재사용하지 않는다.
- `ArticleHistory`에 새 컬럼을 추가하거나 `src/db/schema.js`를 수정하지 마라. 이유: 이 step은 서비스 레이어다. eventType 확장은 **값 추가만으로 충분**하고, 스키마를 건드리면 레이어가 섞여 실패 격리가 불가능해진다.
- 대상별로 이력 행을 남기지 마라. 이유: 이력 모달이 수신처 목록으로 도배되어 기사 생애주기 이력이라는 화면 의미가 무너진다.
- 배부 **실패**를 이력 행으로 남기지 마라. 이유: 현재 `ArticleHistory`에는 성공/실패 구분 컬럼이 없어 사용자가 "배부됨"으로 오독한다(컬럼 추가는 이 step 범위 밖). 실패 가시성은 `logService`(Z 전용 로그 뷰어)가 담당한다.
- 로그에 기사 제목·본문·payload를 담지 마라. 이유: 수집 로깅 관례(`server/index.js` L856)와 동일 — 로그 뷰어는 실데이터를 push하므로 노출 표면을 늘리지 마라.
- `process.env`를 읽거나 스풀 루트 경로를 이 파일에서 결정하지 마라. 이유: env 판독은 부트스트랩(step2) 한 곳에서만 한다.
- `setInterval`/`setTimeout`/`fetch`/네트워크 전송을 넣지 마라. 이유: ADR-008 — 앱 내 타이머·egress 금지. 시각 도래 배부는 phase 48의 tick pull이다.
- 기사 상태 전이(EPS→DPS)·`POST /api/distribution/tick` 라우트·새 공개 라우트를 만들지 마라. 이유: 전자는 phase 48 소관, 후자는 이번 phase에 **새 공개 엔드포인트가 없다**(배부는 서버 내부 후처리로만 트리거된다).
- `src/controllers/index.js`·`server/index.js`·`src/services/articleService.js`·`web/**`를 수정하지 마라. 이유: 결선과 송고 훅은 step2다 — 한 step에 여러 레이어를 욱여넣으면 자가교정 범위가 넓어져 실패 원인 격리가 불가능해진다.
- `queryHistory`의 sendOnly 필터(`articleService.js` L207)를 수정하지 마라. 이유: "송고이력 = status+send" 계약이며, 이번 변경은 그 필터를 통과하지 않도록 설계됐다.
