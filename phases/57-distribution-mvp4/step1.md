# Step 1: failure-log-core

## 목표

배부 실패 원장(ArticleHistory의 `distribute-failed` / `distribute-retry` 행)에서 **"아직 해소되지 않은 수신처 단위 실패"**를 파생하는 **순수 모듈**을 신설한다.

`src/services/distributionFailureLog.js` — DB·HTTP·파일시스템·시계 비의존. `embargoPolicy.js`·`historyMeta.js`와 동형 관례다(조회·쓰기는 전부 호출자 책임).

이 step은 파일 1개(+테스트 1개)만 만든다. 어디서 부르는지는 step2~4 소관이다.

## 읽어야 할 파일

- `docs/ARCHITECTURE.md`(백엔드 계층·DB 비파괴), `docs/ADR.md` **ADR-008**(파일 스풀 outbound — 앱 내 타이머·egress 없음). **읽기 전용(무접촉)**.
- `src/services/embargoPolicy.js` 전체 — 순수 판정 모듈의 관례(`Object.freeze` 상수 export, 방어적 입력 처리, "모르면 안전한 쪽" 규율, JSDoc). 특히 L74~83 `distributedKinds`(eventType strict equality)와 L96~105 `latestSendId`(정수 id만 신뢰).
- `src/services/historyMeta.js` 전체 — 이력 행 배열을 받아 파생만 하는 순수 모듈의 또 다른 선례(입력 불변·재정렬 금지 규율).
- `src/services/distributionService.js` L20~34, L142~150 — 실패 항목 shape `{ articleId, targetId, kind, spoolDir, reason }`과 현재의 무영속 상태(`// 미발송은 운영자가 알아야 한다 — 무음 삼킴 금지(재전송은 후속 MVP-4)`).
- `src/services/spoolWriter.js` L48~84 — 실패 reason 토큰의 실제 출처(`spool-disabled`·`invalid-spool-dir`·`invalid-article-id`·`spool-write-failed`).
- `src/models/articleHistoryModel.js` — step0이 추가한 `queryDistributionEvents`의 반환 shape(이 모듈 입력의 실물).
- `test/embargoPolicy.test.js` — 순수 모듈 테스트 스타일 참고.

## 배경 (자기완결)

원장은 **append-only**다. 행을 지우거나 갱신하지 않으므로 "해소됨"도 새 행으로만 표현한다.

- 수신처 단위 실패: `eventType='distribute-failed'`, `action=<kind>`(`press`|`nonpress`), `targetId=<수신처 id 숫자>`, `reason=<고정 토큰>`
- 수신처 단위 재전송 성공: `eventType='distribute-retry'`, `action=<kind>`, `targetId`

**미해소 판정 규칙(확정)**: `(articleId, targetId, action)` 그룹에서 **id가 가장 큰 행**이 `distribute-failed`면 미해소, `distribute-retry`면 해소.

- 같은 쌍에 실패가 여러 번 쌓여도 미해소 항목은 1건으로 접힌다(최신 실패의 사유·시각을 쓴다).
- 재전송이 또 실패하면 새 `distribute-failed` 행이 append되어 다시 미해소가 된다.
- **기각한 대안**: "실패 행 이후에 같은 kind의 `distribute` 행이 있으면 해소"라는 휴리스틱. 한 번의 `distribute()` 호출 안에서 kind 단위 `distribute` 행이 수신처 실패 행보다 **뒤에** 기록되는 id 순서 불변식에 판정을 의존시키게 되고, 그 순서가 바뀌면 방금 생긴 부분 실패가 조용히 목록에서 사라진다(무음 미발송). 과다 보고(안전 방향)를 택한다.

**재전송 가능 사유 allowlist**: 스풀 쓰기 계열 실패만 재전송 대상이다. `status-changed`(KILL·보류 전이로 인한 안전 중단)는 기사 자체가 배부 불가로 바뀐 것이므로 재전송 대상이 아니며, 영속하면 영원히 해소되지 않는 항목이 된다.

## TDD — 테스트 먼저

`test/distributionFailureLog.test.js`를 새로 만든다(`node --test`, `node:assert/strict`).

1. `DISTRIBUTE_FAILED_EVENT === 'distribute-failed'`, `DISTRIBUTE_RETRY_EVENT === 'distribute-retry'`이고 `RETRYABLE_FAILURE_REASONS`가 frozen 배열이며 `status-changed`를 **포함하지 않는다**.
2. `isRetryableFailureReason`: allowlist 토큰은 true, `'status-changed'`·**`'spool-disabled'`**(`spoolWriter.js` L51의 실제 토큰 — 배부 기능 자체가 꺼진 상태라 수신처 단위 재전송 대상이 아니다)·`undefined`·`null`·빈 문자열·객체는 false.
3. `unresolvedFailures([])` → `[]`. 비배열(`null`/`undefined`/문자열/숫자) 입력도 `[]`(throw 금지).
4. 실패 1건만 있으면 미해소 1건이고, 항목 shape는 `{ historyId, articleId, targetId, kind, reason, failedAt }`이다(그 외 키 없음 — `spoolDir` 같은 경로성 필드 금지).
5. 같은 쌍에 실패 → 재전송 성공이 있으면 미해소 0건이다.
6. 같은 쌍에 실패 → 재전송 성공 → 실패(더 큰 id)면 다시 미해소 1건이고 최신 실패의 `reason`·`failedAt`·`historyId`를 쓴다.
7. 같은 쌍의 실패가 3건 쌓이면 미해소는 1건으로 접히고 최신 실패 값을 쓴다.
8. `targetId`가 다르면 다른 그룹이다(같은 기사·같은 kind라도 수신처별로 독립).
9. `action`(kind)이 다르면 다른 그룹이다(같은 수신처라도 press/nonpress 독립).
10. `articleId`가 다르면 다른 그룹이다.
11. 판정은 **배열 순서가 아니라 id**로 한다: 입력을 id ASC로 줘도 DESC로 줘도 셔플해도 결과가 같다.
12. 방어: `id`가 정수가 아닌 행, `targetId`가 `null`/`undefined`인 행, `action`이 문자열이 아닌 행, 객체가 아닌 원소는 **무시**한다(throw 금지, 결과에 등장하지 않는다).
13. `eventType`이 `'distribute'`·`'status'`·`'edit'`인 행은 판정에 아무 영향을 주지 않는다(같은 쌍의 `distribute` 행이 뒤에 있어도 해소되지 않는다 — 위 '기각한 대안' 잠금).
14. 반환 정렬은 **최신 실패 우선**(historyId DESC)으로 결정적이다.
15. 입력 배열·입력 행 객체를 변형하지 않는다(호출 전후 `deepEqual`).
16. `findUnresolvedFailure(rows, { articleId, targetId })`는 그 쌍의 미해소 항목을 주고, 없으면 `null`이다. `targetId`를 문자열 `'12'`로 줘도 숫자 `12` 행과 매칭된다(HTTP 경계에서 문자열이 올 수 있다 — 숫자 정규화).
17. **복수 매치 계약**: 그룹 키는 `(articleId, targetId, action)` 3원소이므로 같은 `(articleId, targetId)`에 kind가 둘(`press`·`nonpress`) 다 미해소일 수 있다. 이때 `findUnresolvedFailure`는 **`historyId`가 가장 큰(가장 최근) 항목 1건**을 돌려준다(결정적 — 배열 순서를 셔플해도 같은 결과). `kind`를 인자로 받지 않는다.
18. 같은 쌍에 `press`가 해소되고 `nonpress`만 미해소면 `findUnresolvedFailure`는 `nonpress` 항목을 준다(해소된 kind를 고르지 않는다).

## 작업

`src/services/distributionFailureLog.js`를 만든다. 파일 상단에 "무엇을 답하고 무엇을 답하지 않는가"를 명시하는 주석을 둔다(embargoPolicy 스타일).

```js
export const DISTRIBUTE_FAILED_EVENT = 'distribute-failed';
export const DISTRIBUTE_RETRY_EVENT = 'distribute-retry';

// 재전송으로 복구 가능한 실패 사유(단일 출처). status-changed는 담지 않는다 — 기사가 배부 불가로
// 전이된 안전 중단이라 재전송 대상이 아니고, 영속하면 영원히 해소되지 않는 항목이 된다.
export const RETRYABLE_FAILURE_REASONS = Object.freeze([...]);

export function isRetryableFailureReason(reason) {}          // → boolean
export function unresolvedFailures(rows) {}                  // → [{ historyId, articleId, targetId, kind, reason, failedAt }] (historyId DESC)
// 그룹 키는 (articleId, targetId, action) 3원소다 — 같은 수신처에 kind 2종이 동시에 미해소일 수 있으므로
// 이 함수는 그중 historyId가 가장 큰 항목 1건을 돌려준다(kind는 인자로 받지 않는다 — 클라이언트가 kind를 고르면 안 된다).
export function findUnresolvedFailure(rows, { articleId, targetId }) {} // → 항목 | null
```

규칙:

1. **순수**하게 유지한다 — import 0개(다른 모듈에 의존하지 않는다), `new Date()`·`Math.random()`·전역 상태 금지.
2. 입력을 변형하지 마라(정렬이 필요하면 복사본에서).
3. `targetId`는 숫자로 정규화해 비교한다(`Number(...)` + `Number.isFinite` 가드). 이유: DB는 INTEGER지만 HTTP 경계에서 문자열이 들어올 수 있다.
4. 방어적 입력 처리: 어떤 입력에도 throw하지 않는다(판정 모듈이 호출자를 깨뜨리지 않는다 — embargoPolicy와 같은 규율).
5. 반환 항목에 `spoolDir`·파일 경로·예외 메시지를 넣지 마라. 이 값은 이후 HTTP 응답으로 나간다.
6. `findUnresolvedFailure`는 `unresolvedFailures`를 재사용해 구현한다(판정 규칙 복제 금지 — 두 곳이 갈라지면 인가 우회가 된다).

## Acceptance Criteria

```bash
npm test          # 실패 0 — step0 종료 시점 개수 + 이번 신규 케이스
npm run lint      # 통과
```

**diff scope**: step 시작 전 `git status --porcelain` 스냅샷 대비 증분이 `src/services/distributionFailureLog.js`, `test/distributionFailureLog.test.js` **2개뿐**이어야 한다(절대 목록 비교 금지).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 4종(확인 후 원복):
   - 그룹 키에서 `action`을 빼면 케이스 9가 red.
   - "최신 행(id 최대)" 대신 "배열 첫 행"으로 판정하면 케이스 11이 red.
   - `RETRYABLE_FAILURE_REASONS`에 `'status-changed'`를 넣으면 케이스 1이 red.
   - `eventType` 필터를 느슨하게(`startsWith('distribute')`) 하면 케이스 13이 red.
   - `findUnresolvedFailure`가 첫 매치를 반환하게 바꾸면 케이스 17이 red.
3. 아키텍처 체크리스트:
   - import가 0개인가(순수 모듈)?
   - 시계·랜덤·전역 상태가 없는가?
   - 반환 항목에 경로성 필드가 없는가?
4. `phases/57-distribution-mvp4/index.json`의 step1을 `completed` + `summary`로 갱신한다. summary에 export 목록·시그니처·미해소 판정 규칙·정렬·방어 규칙을 명시하라.

## 금지사항

- 이 모듈에서 DB·모델·HTTP를 참조하지 마라. 이유: 판정 규칙이 조회 경로에 묶이면 테스트가 무거워지고 재사용(재전송 인가 판정)이 막힌다.
- "실패 후 같은 kind의 `distribute` 행이 있으면 해소" 규칙을 넣지 마라. 이유: 한 번의 배부 호출 안에서 kind 행이 실패 행보다 뒤에 기록되는 id 순서에 판정이 의존하게 되고, 그 불변식이 깨지면 신선한 미발송이 조용히 목록에서 사라진다(과소 보고 = 무음 실패).
- 실패 행을 "지우거나 갱신하는" 파생(예: resolved 플래그 계산 후 원본 mutate)을 만들지 마라. 이유: 원장은 append-only이고 입력 불변이 이 모듈의 계약이다.
- `reason` 문자열을 사용자 문구로 번역하지 마라. 이유: 표시 문구는 뷰 책임이고(mgmtMessages 선례), 서버는 고정 토큰만 다룬다.
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라. 이유: 이번 phase 무접촉 대상이다.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지. 이유: 사용자 소유 미커밋 파일이 트리에 있다.
