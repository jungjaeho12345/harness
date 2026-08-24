# Step 8: failure-ledger

배부 실패 원장 파생을 **순수 모듈**로 이식한다 — `DistributionFailureLog`(= `src/services/distributionFailureLog.js` 106행 1:1). 답하는 질문은 둘뿐이다: (1) 이 이벤트 행들에서 **아직 해소되지 않은 수신처 단위 실패**는 무엇인가 (2) 이 `(articleId, targetId)` 쌍에 미해소 실패가 있는가.

이 step은 **순수 모듈만** 만든다: DB·HTTP·시계 의존 0.

## 읽어야 할 파일

- `phases/71-spring-distribution/index.json` — decisions **(17)(19)**
- `src/services/distributionFailureLog.js` — **이식 원본 전문**. 특히 서문의 *기각한 대안*("실패 행 이후 같은 kind의 distribute 행이 있으면 해소" 휴리스틱을 **왜 버렸는지**) — 과다 보고(안전 방향)를 택했다는 사실이 계약이다
- `docs/ADR.md` ADR-008 (6) — 실패는 append-only로 영속하고 **해소 여부는 실패 행을 갱신하지 않고 이후 재전송 이력으로 파생**한다
- `docs/SCHEMA.md`의 `ArticleHistory` 절 — `targetId`가 정수 컬럼인 이유
- `server-spring/src/main/java/harness/news/web/NodeNumber.java` — `toNumber`(= JS `Number()`)의 **단일 출처**
- 이 phase의 step6 산출물: `ArticleHistoryRepository.queryDistributionEvents`가 돌려주는 8키 행의 타입

## 배경 (동결된 사실 — 이 목록이 곧 테스트다)

- **상수 3개**:
  - `DISTRIBUTE_FAILED_EVENT = "distribute-failed"` · `DISTRIBUTE_RETRY_EVENT = "distribute-retry"`.
  - `RETRYABLE_FAILURE_REASONS`(불변, **정확히 3개**): `spool-write-failed` · `invalid-spool-dir` · `invalid-article-id`. **`status-changed`를 넣지 마라**(기사가 배부 불가로 전이된 **안전 중단**이라 재전송 대상이 아니고, 영속하면 영원히 해소되지 않는 항목이 된다). **`spool-disabled`도 넣지 마라**(특정 수신처의 실패가 아니라 기능 자체가 꺼진 상태다).
- **판정 규칙**: 그룹 키는 **(articleId, targetId, action) 3원소**. 그룹에서 **id가 가장 큰 행**이 `distribute-failed`면 미해소, `distribute-retry`면 해소.
- **행 정규화(참여 자격)** — 아래 중 하나라도 아니면 **조용히 무시**(throw 금지):
  - `eventType`이 두 배부 이벤트 중 하나
  - `id`가 **정수**
  - `action`이 **문자열**
  - `targetId` 정규화 결과가 non-null: `null`·`undefined`·`''` → null · 그 외는 **`NodeNumber.toNumber`** 후 유한수면 그 값(= JS `Number(value)` + `Number.isFinite`). **`Integer.parseInt`·`Double.parseDouble`로 재구현하지 마라**(phase 70 review_gate high-1).
- **반환 항목 6키**: `historyId`(=행 id) · `articleId` · `targetId`(정규화된 수) · `kind`(=행 `action`) · `reason`(없으면 null) · `failedAt`(=행 `createdAt`, 없으면 null). **경로성 필드(`spoolDir`·`file`)를 절대 담지 마라** — 이 값은 HTTP 응답으로 나간다.
- **정렬**: `historyId` **DESC**.
- `findUnresolvedFailure(rows, articleId, targetId)` — `targetId` 정규화 실패면 null. **판정을 복제하지 않고** `unresolvedFailures`를 부른 뒤 첫 매치를 돌려준다(정렬이 DESC이므로 첫 매치가 가장 최근). **`kind`를 인자로 받지 않는다**(클라이언트가 kind를 고르면 안 된다 — 배부 kind는 실패 이력에서만 도출한다, ADR-004).

## 작업

### A. Node 실측 대조

`node -e`로 원본을 불러 경계 입력의 반환을 표로 만든다(최소): 같은 그룹에 failed→retry→failed 3행 · retry가 최신 · `targetId`가 문자열 `"3"`/숫자 `3`/`3.0`/`''`/null · `id`가 문자열 · `action`이 null · 다른 `action`(kind)으로 같은 (articleId,targetId) 2그룹 · `eventType`이 `distribute`인 행(무시) · `rows`가 null/비배열.

### B. `DistributionFailureLog` (순수, `harness.news.service`)

- 전부 `public static`. 시그니처(구현 재량):
  - `List<Failure> unresolvedFailures(List<Map<String,Object>> rows)`
  - `Failure findUnresolvedFailure(List<Map<String,Object>> rows, String articleId, Object targetId)` — 없으면 null
  - `boolean isRetryableFailureReason(Object reason)`
  - `record Failure(long historyId, String articleId, double targetId, String kind, String reason, String failedAt)` — `targetId`의 표현은 구현 재량이되 **`DistributionTarget.id`와 직접 비교 가능**해야 한다(step6 실측을 근거로 정한다).
- 그룹 키 조립: Node는 `` `${articleId}\u0000${targetId}\u0000${action}` ``로 NUL 구분자를 쓴다. Java에서도 **구분자가 값에 나타날 수 없는 키**를 쓴다(문자열 연결로 `a|b` 충돌을 만들지 마라 — `List.of(...)`를 키로 쓰는 편이 안전하다).
- **`articleId`가 null인 행**도 그룹 키에 들어간다(Node는 `undefined`를 문자열로 붙인다) — 실측을 따르되, `findUnresolvedFailure`의 매칭은 `Objects.equals`로 한다.

### C. 테스트 (먼저 쓴다 — `DistributionFailureLogTest`)

1. 같은 그룹 failed 2건 → **1건으로 접힘**(최신 사유·시각·historyId).
2. 최신이 retry → **해소**(목록에서 사라진다).
3. retry 뒤 다시 failed → **재등장**.
4. 같은 (articleId,targetId)에 **kind 2종**이 동시 미해소 → **2건**(그룹 키가 3원소라는 실증).
5. `targetId` 표현 4종(`3` · `"3"` · `3.0` · `" 3 "`)이 **같은 그룹**으로 접히는지(JS `Number` 의미론 — `NodeNumber.toNumber` 사용 실증).
6. `targetId`가 `null`·`''`·`"abc"`·`Infinity` → 그 행 **제외**.
7. `id`가 비정수(문자열·실수·null) → 제외 · `action`이 비문자열 → 제외 · `eventType`이 `distribute`/`status` → 제외.
8. 정렬 `historyId` DESC.
9. 반환 항목이 **정확히 6키**이고 `spoolDir`·`file`이 없다.
10. `rows`가 null·비배열·빈 목록 → 빈 결과(throw 없음).
11. `isRetryableFailureReason`: 3토큰 true · `status-changed`·`spool-disabled`·null·비문자열 false. **목록 크기가 정확히 3**임을 단언(늘어나면 red — 재전송 대상이 조용히 넓어지는 것을 막는다).
12. `findUnresolvedFailure`: 같은 쌍에 kind 2종이면 **historyId가 큰 쪽** 1건 · 없으면 null · targetId 정규화 실패면 null.

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가.
- 2번: exit 0 · 5 프로파일 diffs 0 · 관측 수 불변.
- 3번 증분 = `.../service/DistributionFailureLog.java` · 대응 테스트 · `phases/71-spring-distribution/index.json`.

## 검증 절차

1. **red 먼저**: 단위 테스트를 구현 전에 돌려 실패 실측.
2. **변이 (a) 원복**: 그룹 키에서 `action`을 빼(2원소) 4번 red 확인 → 원복. (이 변이는 **kind 하나를 영구 복구 불가**로 만든다.)
3. **변이 (b) 원복**: `NodeNumber.toNumber` → `Integer.parseInt`로 바꿔 5번(`3.0`·`" 3 "`) red 확인 → 원복.
4. **변이 (c) 원복**: `RETRYABLE_FAILURE_REASONS`에 `status-changed`를 추가해 11번 red 확인 → 원복.
5. **변이 (d) 원복**: 해소 판정을 서문이 기각한 휴리스틱("실패 뒤 같은 kind의 distribute 행이 있으면 해소")으로 바꿔 3번 red 확인 → 원복.
6. **변이 (e) 원복**: 반환에 `spoolDir`을 추가해 9번 red 확인 → 원복.
7. AC 실행. index.json step8 상태 갱신.

## 금지사항

- 판정 규칙을 다른 파일에 복제하지 마라. 이유: 목록과 재전송 게이트가 이 파생 하나만 써야 한다 — 두 곳이 갈라지면 **인가 우회**가 된다(목록에 없는 실패로 재전송이 통과한다).
- 경로성 필드를 반환에 담지 마라. 이유: 이 값은 `GET /api/distribution/failures` 응답으로 그대로 나간다.
- `RETRYABLE_FAILURE_REASONS`를 넓히지 마라. 이유: `status-changed`·`spool-disabled`를 담으면 영원히 해소되지 않는 항목이 원장에 쌓인다.
- 잘못된 행에 예외를 던지지 마라. 이유: 판정 모듈이 호출자를 깨뜨리면 실패 목록 조회 하나가 500이 된다(원장에는 레거시·수기 행이 있을 수 있다).
- `Integer.parseInt`·`Double.parseDouble`·`String.trim()`을 쓰지 마라. 이유: Node 의미론 파생은 `NodeNumber`·`NodeString` 단일 출처다.
- 시계·DB·HTTP를 건드리지 마라. 이유: 순수 모듈 전용이다.
