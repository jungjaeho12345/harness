# Step 6: history-distribution-queries

배부 이벤트 원장을 읽는 **조회 2개**를 `ArticleHistoryRepository`에 더한다 — `queryDistributionEvents({articleId?, limit})`와 `getDistributionEventById(id)`. 배부 실패 목록(Z 전용)과 재전송 대상 확인의 **유일한 조회 경로**다.

이 step은 **model 계층만** 건드린다. 계약은 아직 green이 될 수 없다 — 판정은 리포지토리 단위 테스트 + scope 무회귀다.

## 읽어야 할 파일

- `phases/71-spring-distribution/index.json` — decisions **(17)(19)(20)(26)**
- `src/models/articleHistoryModel.js` 81~106행 — **이식 원본**: `queryDistributionEvents`(8컬럼 · `eventType IN ('distribute-failed','distribute-retry')` · `articleId` 선택 조건 · `ORDER BY id DESC LIMIT ?`) · `getDistributionEventById`(같은 8컬럼 · `id = ? AND eventType IN (?,?)`)
- `src/models/articleHistoryModel.js` 상단의 `DISTRIBUTION_EVENTS_DEFAULT_LIMIT` 값을 **실측으로 확인**한다(계획서 수치를 믿지 마라)
- `server-spring/src/main/java/harness/news/model/ArticleHistoryRepository.java` — `LIST_COLUMNS`(8) · `SNAPSHOT_COLUMNS`(7) · `insert` · `mapListRow` 관례. **`targetId`가 어떤 기존 조회에도 실리지 않는다**는 주석(75행)을 확인하고, 이 step이 그 사실을 바꾼다는 것을 주석으로 갱신한다
- `server-spring/src/main/java/harness/news/db/RequiredSchema.java` `HISTORY_COLUMNS` 12개 — `targetId`가 **정수 컬럼**이라는 예외 기록
- `server-spring/src/main/java/harness/news/model/ColumnValues.java` — 값 바인딩 정책(문자열/숫자/NULL/예외)
- `server-spring/src/test/java/harness/news/model/ArticleHistoryRepositoryTest.java` — 기존 테스트 관례(임시 DB · 컬럼 단언)

## 배경 (동결된 사실)

- **결과 컬럼 8개**: `id, articleId, eventType, action, targetId, reason, actorUserId, createdAt`. 기존 `queryByArticle`의 9키(8컬럼 + `hasSnapshot`)와 **다르다** — 그 조회에 `targetId`/`reason`을 싣지 않는 이유는 그 응답이 **전 사용자에게 열린 이력보기 계약**이기 때문이다(모델 주석). **두 조회를 합치지 마라.**
- `eventType` 필터는 **두 조회 모두에** 있다. `getDistributionEventById`에서 필터를 빼면 임의 id로 본문 스냅샷 행이 그 경로로 새어 나온다(재전송 게이트의 1차 방어).
- `id`는 정수, `targetId`도 **정수 컬럼**이다. `id`는 정수로 읽고(`rs.getInt`/`getLong`), `targetId`는 **NULL일 수 있다**(kind 단위 실패 항목은 저장되지 않지만 레거시·수기 데이터 방어) — NULL이면 키를 남기되 값은 null이다.
- **`limit` 정규화는 모델 책임이 아니다**: Node 모델은 `Number.isInteger(limit) && limit >= 1`이면 그 값, 아니면 기본값을 쓴다. 서비스가 클램프(최대 1000)를 한다 — **두 곳의 역할을 섞지 마라**(step14가 클램프를 갖는다).
- **`LIMIT`은 반드시 파라미터 바인딩**으로 넣는다(문자열 연결 금지 — SQL 조립 규율).
- 이 조회는 **읽기 전용**이다. `UPDATE`·`DELETE`를 추가하면 `NoSchemaSqlInMainSourcesTest`의 `LEDGER_MUTATIONS` 스캔이 red다(그것이 정상이다 — 원장은 append-only).

## 작업

### A. Node 실측 대조

`DISTRIBUTION_EVENTS_DEFAULT_LIMIT`의 실제 값과, 같은 스키마의 임시 DB에 행을 넣고 두 조회를 부른 결과(키 집합·정렬·타입)를 `node -e`로 확인해 요약에 적는다. 특히 **`targetId`가 정수로 돌아오는지 문자열로 돌아오는지**를 실측한다.

### B. `ArticleHistoryRepository`에 조회 2개 추가

- `private static final List<String> DISTRIBUTION_EVENT_COLUMNS = List.of("id","articleId","eventType","action","targetId","reason","actorUserId","createdAt")`.
- `private static final List<String> DISTRIBUTION_EVENT_TYPES = List.of("distribute-failed","distribute-retry")` — **어휘의 출처는 도메인**이지만 모델은 문자열만 둔다(Node 모델과 같은 규율: 모델은 도메인 비의존).
- `public List<Map<String,Object>> queryDistributionEvents(String articleId, Integer limit)` — `articleId`가 null이면 그 조건을 넣지 않는다(전역 스캔). `limit`이 정수 ≥1이 아니면 기본값.
- `public Map<String,Object> getDistributionEventById(long id)` — 없거나 배부 이벤트가 아니면 `null`.
- 행 매핑: `id`는 정수, `targetId`는 정수 또는 null, 나머지는 문자열. **키 순서는 컬럼 목록 순서의 `LinkedHashMap`**이고 값이 SQL NULL이어도 키를 남긴다.

### C. 테스트 (먼저 쓴다 — `ArticleHistoryRepositoryTest` 확장)

1. `distribute-failed`·`distribute-retry` 행만 나오고 `status`·`edit`·`distribute` 행은 **나오지 않는다**.
2. `ORDER BY id DESC` · `LIMIT` 적용 · `limit` 미지정/0/음수/비정수 → 기본값.
3. `articleId` 지정 시 그 기사만 · 미지정 시 전 기사.
4. `getDistributionEventById`: 존재하는 배부 이벤트 → 8키 · **`status` 이벤트 id를 주면 null**(어휘 필터 실증) · 없는 id → null.
5. **`targetId` 왕복**: `insert`로 넣은 숫자 `targetId`가 그대로 정수로 돌아오는지, `DistributionTarget.id`와 **직접 비교 가능한 표현**인지(문자열 `"3"`이나 `3.0`으로 돌아오면 매칭이 조용히 깨진다 — 이 축은 계약이 절대 보지 못한다).
6. `targetId`·`reason`이 NULL인 행 → 키는 남고 값은 null.
7. **`queryByArticle`의 9키가 변하지 않았다**(회귀 잠금 — 배부 컬럼이 이력보기 응답으로 새면 안 된다).
8. 비-ASCII `reason`(방어적 — 실제 토큰은 ASCII지만 인코딩 경로를 덮는다).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가 · `NoSchemaSqlInMainSourcesTest` green(원장 변경 SQL 0).
- 2번: exit 0 · 5 프로파일 diffs 0 · **관측 수 불변**(step5 종료 시점 값 — HTTP 변경 없음).
- 3번 증분 = `.../model/ArticleHistoryRepository.java` · `.../model/ArticleHistoryRepositoryTest.java` · `phases/71-spring-distribution/index.json`.

## 검증 절차

1. **red 먼저**: 리포지토리 테스트를 구현 전에 돌려 실패 실측.
2. **어휘 필터 변이(원복)**: `getDistributionEventById`에서 `eventType IN` 조건을 빼고 4번 테스트가 red인지 확인 → 원복. (이 게이트가 재전송의 1차 방어다.)
3. **컬럼 누출 변이(원복)**: `queryByArticle`에 `targetId`를 추가해 7번 테스트가 red인지 확인 → 원복.
4. **정렬 변이(원복)**: `ORDER BY id ASC`로 바꿔 2번이 red인지 확인 → 원복.
5. AC 실행. index.json step6 상태 갱신.

## 금지사항

- `queryByArticle`에 배부 컬럼을 싣지 마라. 이유: 그 응답은 전 사용자에게 열린 이력보기 계약이다.
- `getDistributionEventById`의 `eventType` 필터를 빼지 마라. 이유: 임의 id로 본문 스냅샷 행이 재전송 경로로 새고, 그것이 곧 인가 우회다.
- `LIMIT` 값을 SQL 문자열에 연결하지 마라. 이유: 바인딩이 이 리포지토리의 규율이다.
- 원장에 `UPDATE`·`DELETE`를 추가하지 마라. 이유: append-only(ADR-008 (6)) — 해소는 새 행으로만 표현한다.
- 서비스 수준 클램프(최대 1000)를 모델에 넣지 마라. 이유: 표시용 창(200/1000)과 게이트용 스캔(사실상 무제한)이 서로 다른 상한을 쓴다 — 모델이 클램프를 갖는 순간 게이트가 조용히 좁아져 오래된 실패가 복구 불가가 된다.
- 서비스·컨트롤러를 만들지 마라. 이유: 이 step은 model 계층 전용이다.
