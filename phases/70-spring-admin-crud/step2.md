# Step 2: distribution-target-repository

`DistributionTarget` 데이터 접근층(직접 SQL)을 이식한다. 정본 픽스처는 step1이 이미 확장했으므로 이 step은 `TABLES` 항목·드리프트 픽스처·리포지토리만 추가한다. 라우트를 늘리지 않으므로 계약 scope는 그대로.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — 전체(특히 decisions **(1)(5)(9)(12)** · order (e))
- `src/models/distributionTargetModel.js` — 이식 정본(query·findById·insert·update — **삭제 함수 없음**). `COLUMNS` 6개 · `FILTERABLE = ['id', ...COLUMNS]`
- `docs/SCHEMA.md` `## DistributionTarget Table` (91~102행) — 7컬럼 · **행 삭제 없음**(soft delete만) · ReceiverConfig와 별도 테이블(ADR-008 (2))
- `src/db/schema.js` `SCHEMA.DistributionTarget`(93~102행) — 컬럼 순서 정본
- `server-spring/src/main/java/harness/news/db/RequiredSchema.java` — **step1에서 확장됨**(ReceiverConfig 추가 상태). 이 step은 DistributionTarget 행 추가
- **step1에서 만든/수정한 파일**: `src/test/resources/db/user-schema.sql`(DistributionTarget DDL 이미 포함) · `model/ReceiverConfigRepository.java` · `SchemaGuardTest`
- `server-spring/src/main/java/harness/news/model/ArticleRepository.java` — present-only update·숫자 바인딩 선례

## 작업 (테스트 먼저)

1. **드리프트 픽스처 신설** — `distribution-target-schema-drift.sql`(DistributionTarget만 컬럼 결손, 예: `spoolDir`·`updatedAt` 빠짐)과 `TempNewsDb` 참조 상수. (정본 픽스처엔 DDL이 이미 있다 — 새로 넣지 마라.)
2. **테스트 먼저** — `SchemaGuardTest`에 DistributionTarget 단언(7컬럼·TABLES 존재·드리프트 거부가 결손 컬럼 지목) 추가 + `DistributionTargetRepositoryTest` 신설. 덮을 계약(Node 대조 — **작업 A로 실측**):
   - `query(filters)`: 화이트리스트 `FILTERABLE = id + 6컬럼` AND 동등 필터 · `ORDER BY id`.
   - `findById(id)`: 한 행 또는 없음(present 판정).
   - `insert(entry)`: present-only · `id` 자동 증가 · `lastInsertRowid` 반환(`Number(...)` 동형 — 정수).
   - `update(id, fields)`: **present-only SET**(전달 컬럼만) · `id`는 SET 대상 아님 · 컬럼 0개면 `0` 반환(no-op) · 영향 행 수 반환.
   - **삭제 함수 없음** — 리포지토리에 `delete`/`remove` 메서드를 두지 않는다(soft delete는 서비스가 `update(id, {active:'N'})`로 한다).
   - 숫자 바인딩 `Types.DOUBLE` 동형(gap #4) · 비-ASCII name/spoolDir 왕복(gap #5).
3. 구현 전 red 서명 관측·기록.
4. `RequiredSchema`에 `DISTRIBUTION_TARGET_TABLE`·`DISTRIBUTION_TARGET_COLUMNS`(7) 추가 + `TABLES`에 행 추가. `model/DistributionTargetRepository.java` 구현(생성자 주입·`@Autowired` · `SELECT` 나열 = 요구 스키마 순회 · `SELECT *` 금지). green 확인.

## Acceptance Criteria

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B verify
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B -q package -DskipTests
cd /home/user/harness && node scripts/spring-contract.mjs --parity
cd /home/user/harness && npm test
cd /home/user/harness && git diff --stat
```

- 1번: failures/errors 0. 테스트 수는 step1 기준선보다 커야 한다.
- 3번: exit 0 · 전 프로파일 `diffs=0`.
- 4번: **1328/1328**.
- 5번: 변경이 `server-spring/**`에만.

## 검증 절차

1. **작업 A(Node 대조)**: 임시 DB에 `src/models/distributionTargetModel.js`를 직접 관측 — query·findById·insert·update present-only·no-op(컬럼 0개) 실측. Java 1:1 확인.
2. **드리프트 거부 단언**: `distribution-target-schema-drift.sql`이 결손 컬럼(`spoolDir`·`updatedAt`)을 지목하는지, 기존 drift 단언이 넓어진 목록에서도 참인지 확인.
3. **정본 픽스처 무변경 확인**: 이 step은 `user-schema.sql`을 건드리지 않는다(`git diff`로 확인 — step1이 이미 DDL을 넣었다).
4. **삭제 함수 부재 확인**: `DistributionTargetRepository`에 `delete`/`remove` 메서드가 **없음**을 확인(soft delete만 — decisions (1)).
5. main 소스 DDL 0 · DistributionTarget에 대한 행 `DELETE` SQL 0.

## 금지사항

- `DistributionTargetRepository`에 삭제 메서드를 만들지 마라. 이유: 대상 제거는 `active='N'` soft delete가 유일 경로다(SCHEMA.md·ADR-008 · decisions (1)).
- `user-schema.sql`(정본 픽스처)에 DistributionTarget DDL을 다시 넣지 마라. 이유: step1이 이미 넣었다 — 중복 DDL은 픽스처 로딩을 깬다.
- `SELECT *`로 읽지 마라(step1과 동일 이유).
- `update`의 SET에 `id`를 넣지 마라. 이유: `id`는 INTEGER PK(ROWID alias)라 SET 대상이 아니다.
