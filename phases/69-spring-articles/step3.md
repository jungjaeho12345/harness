# Step 3: history-repository

`ArticleHistory` 테이블의 **데이터 접근 계층**을 만든다. 이 원장은 **append-only**다 — 삽입과 조회만 있고 갱신·삭제 코드는 두지 않는다.

## 읽어야 할 파일

- `phases/69-spring-articles/index.json` — decisions **(5)(8)(16)(21)**
- `src/models/articleHistoryModel.js` (전부) — **이식 원본**: 삽입 컬럼 화이트리스트(id 제외 11개) · `queryByArticle`(고정 8컬럼 + `hasSnapshot` 파생, `id DESC`) · `querySnapshotById`(**`articleId`로 스코프**, 7컬럼) · `querySnapshotTitlesByArticle`(저장 제목 우선 + 레거시 행만 본문 동반, `length(markupVersion) > 0` 필터)
- `src/db/schema.js` 58~76행 — `ArticleHistory` 12컬럼(`id`는 자동 증가 정수, `targetId`는 정수)
- `contract/cases/default/articles-read.contract.js` 37~41행·480~560행 — 이력 목록 행 **12키**(`action,actorUserId,articleId,createdAt,eventType,fromStatus,hasSnapshot,id,status,title,toStatus,version`)와 단건 스냅샷 **7키**(`action,actorUserId,articleId,createdAt,eventType,id,markupVersion`), `hasSnapshot`이 **불리언이 아니라 정수 1/0**이라는 단언, 타 기사 스코프·비정수·미존재 id 전부 404
- step1 산출물(`decorateHistoryRows` — 이 리포지토리의 결과를 입력으로 받는다)
- step2 산출물(**정본 픽스처** `server-spring/src/test/resources/db/user-schema.sql`에 이미 `ArticleHistory`가 들어 있어야 한다 · 바인딩 정책 · `server-spring/src/test/java/harness/news/testsupport/TempNewsDb.java`)

## 배경 (동결된 계약 사실)

- 목록 조회는 **본문(blob)을 SELECT하지 않는다** — 존재 여부만 `hasSnapshot` **정수 1/0**으로 파생한다(`markupVersion`이 NULL도 빈 문자열도 아닐 때 1). 이 값은 표시 버전 계산의 입력이기도 하다.
- 정렬은 `id` **내림차순**이다(최신이 위). 같은 시각의 행이 여러 개일 수 있어 순서 판단은 시각이 아니라 id로 한다.
- 단건 스냅샷 조회는 **반드시 `articleId`와 함께** 스코프한다(다른 기사의 본문이 id만으로 새지 않게 — 권한 우회 방지).
- 목록 응답에는 `markupVersion`·`snapshotTitle`·`targetId`·`reason`이 **없다**. 배부 이벤트 전용 컬럼을 이 경로로 흘리지 마라(그 응답은 전 사용자에게 열린 이력보기 계약이다).
- 표시 제목 입력 조회는 **행 단위 폴백을 SQL에서 끝낸다**: 저장된 제목이 있으면 그것만, NULL인 레거시 행에만 본문을 함께 싣는다. 필터는 본문 길이가 0보다 큰 행이며(스냅샷 판정과 동치) **저장 제목 기준으로 거르면 안 된다**(레거시 행이 사라져 폴백 대상을 식별할 수 없다).
- 이 phase는 배부 이벤트 조회 2종(`queryDistributionEvents`·`getDistributionEventById`)을 **이식하지 않는다**(배부 phase 소유 — 지금 만들면 검증 없는 표면이다).

## 작업

### A. 요구 스키마 확장

- `RequiredSchema`에 `ArticleHistory` 컬럼 목록을 추가하고 부팅 검증 대상에 넣는다(step2와 같은 방식 · 읽기 검증만).
- **전역 파급 주의**: `SchemaGuard`는 `RequiredSchema.TABLES` **전 테이블**을 부팅에서 검증한다 — `ArticleHistory`가 목록에 들어가는 순간 **정본 픽스처(`TempNewsDb.CANONICAL_FIXTURE` = `server-spring/src/test/resources/db/user-schema.sql`)로 시드된 모든 `@SpringBootTest`**가 그 테이블을 요구하게 된다. step2가 이미 정본 픽스처에 3테이블을 넣었을 것이므로 새 픽스처 작업은 없어야 하지만, **정본 픽스처에 `ArticleHistory`가 실제로 들어 있는지 먼저 확인하라**. 없으면 step2와 같은 방식으로 **정본 픽스처를 확장**한다 — 별도 픽스처를 이 step의 테스트에만 적용하면 기존 `@SpringBootTest`가 컨텍스트 로딩에서 통째로 죽는다.
- 드리프트 거부 단언(`SchemaGuardTest` · `DbBootGuardTest` · `db/user-schema-drift.sql`)이 **넓어진 요구 목록에서도** 유효한지 확인한다(단언 약화 금지).

### B. 리포지토리

- **삽입**: 화이트리스트 컬럼 중 값이 주어진 것만 넣고 **새 행의 id(정수)를 돌려준다**. `id`는 삽입 대상이 아니다. 값이 하나도 없으면 빈 문장을 만들지 말고 예외.
- **목록 조회**: 고정 8컬럼 + `hasSnapshot` 파생, `articleId` 일치, `id` 내림차순. `hasSnapshot`은 JSON에 **정수**로 실려야 하므로 Java 타입도 정수로 매핑한다(불리언 금지).
- **단건 스냅샷 조회**: 7컬럼, `id`와 `articleId` 둘 다 조건. 없으면 '없음'.
- **표시 제목 입력 조회**: 정본과 같은 조건·같은 별칭 규칙. 별칭 이름을 바꾸지 마라(필터가 실컬럼을 가리키는 전제가 깨진다).
- 배부 이벤트 컬럼(`targetId`·`reason`)은 **삽입 화이트리스트에는 남기되**(다음 phase가 쓴다) 어떤 조회 경로에도 싣지 않는다.
- 바인딩 정책과 컬럼 화이트리스트 규율은 step2와 같다. `id`·`targetId`는 정수 컬럼이므로 정수로 바인딩·매핑한다(문자열로 저장하면 다음 phase의 매칭이 조용히 깨진다 — 스키마 주석의 경고).

### C. 테스트 (먼저 쓴다 — `@TempDir` 임시 DB)

1. 삽입 → 반환 id가 증가하는 정수이고 목록에서 그 행이 보인다.
2. 목록 행이 **정확히 9키**(고정 8 + `hasSnapshot`)이고 본문·저장 제목·배부 컬럼이 **없다**.
3. `hasSnapshot`: 본문 있는 행 **1**, 본문 NULL 행 **0**, 본문 빈 문자열 행 **0** — 값의 타입이 정수다.
4. 정렬이 `id` 내림차순이다(같은 시각 문자열 3행으로 실증).
5. 단건 스냅샷: 본문 포함 7키 · 스냅샷 없는 전이 행도 조회되고 본문이 `null` · **다른 기사 id로는 조회되지 않는다**.
6. 표시 제목 입력 조회: 신규 행만 있으면 본문 0건 · 레거시 행(저장 제목 NULL)만 본문 동반 · 본문 길이 0인 행은 결과에서 빠진다.
7. 요구 스키마 확장이 부팅 검증에 반영된다(컬럼 누락 픽스처로 실패 메시지 확인). 동시에 **정본 픽스처로 시드된 기존 `@SpringBootTest`가 여전히 컨텍스트를 띄운다**(로딩 실패 0)는 것을 `verify` 결과로 확인한다.
8. **삭제·갱신 API가 없다**는 것을 구조로 증명: 리포지토리의 public 메서드 목록을 단언하거나(리플렉션) 이력 행 수가 삽입 횟수와 같다는 시나리오로 확인한다.

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 3번은 무회귀 확인(관측 수 불변 · `diffs=0`) + **확장된 부팅 검증으로도 기동에 성공**한다는 실증이다.

## 검증 절차

1. red 먼저(C의 8군).
2. AC 실행 후 Java 테스트 수 증가분 기록.
3. **변이 실증 2종**(확인 후 원복): (a) `hasSnapshot`을 불리언으로 매핑하면 3번이 red인가 (b) 단건 조회에서 `articleId` 조건을 빼면 5번의 스코프 단언이 red인가(권한 우회 재현 — **반드시 원복**).
4. 정적 스캔 테스트 green 확인(이력 원장에 대한 갱신·삭제 SQL 0).
5. `git status --porcelain` 증분 = `server-spring/src/main/java/harness/news/{db,model}/**` · `server-spring/src/test/**` · `phases/69-spring-articles/index.json`.
6. index.json step3 status·summary 갱신.

## 금지사항

- 이력 행을 갱신·삭제하는 메서드를 만들지 마라. 이유: append-only 원장이고 그 행은 감사 기록일 뿐 아니라 **판정 입력**이다(사이클 경계·배부 멱등). 지우는 순간 복구 수단이 없다.
- 목록 조회에 본문(`markupVersion`)이나 배부 컬럼(`targetId`·`reason`)을 싣지 마라. 이유: 목록은 경량 계약이고 전 사용자에게 열려 있다 — 배부 실패 사유·수신처 id는 Z 전용 표면이다.
- 단건 스냅샷 조회에서 `articleId` 스코프를 빼지 마라. 이유: id만으로 다른 기사의 본문을 읽는 권한 우회가 된다.
- 부트 백필(저장 제목이 빈 행 채우기)을 이식하지 마라. 이유: 이 서버는 기동 시 쓰기를 하지 않는다(decisions (16)) — 표시 값은 조회 폴백이 만든다.
- `id`·`targetId`를 문자열로 저장·매핑하지 마라. 이유: 정수 컬럼과의 매칭이 조용히 깨진다(스키마 주석이 명시한 실측 함정).
