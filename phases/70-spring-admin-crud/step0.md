# Step 0: schema-required

`RequiredSchema.TABLES`를 4테이블(User·Article·Contents·ArticleHistory)에서 **6테이블**로 넓힌다 — `ReceiverConfig`·`DistributionTarget`를 additive로 추가한다. 이 두 테이블은 이 phase의 7 라우트가 읽고 쓰는 대상이다. **동시에** 정본 테스트 픽스처(`user-schema.sql`)에 두 테이블 DDL을 넣어 전 `@SpringBootTest` 기동 경로가 컨텍스트 로딩에서 죽지 않게 한다.

이 step은 **DB 계층만** 건드린다. 라우트를 하나도 구현하지 않으므로 계약 파일이 green이 되지 않는다 — 판정은 Java 부팅/스키마 테스트 + 이미 green인 scope의 무회귀다.

## 왜 이걸 맨 앞 단일 step으로 뽑는가

`RequiredSchema.TABLES`에 테이블을 넣는 것은 **전역 파급**이다: 부팅 시 `SchemaGuard`가 그 목록 전체를 검증하므로, 정본 픽스처(`TempNewsDb.CANONICAL_FIXTURE` = `db/user-schema.sql`)로 시드된 **모든** 기동 테스트가 두 테이블 DDL이 없으면 컨텍스트 로딩에서 함께 죽는다(phase 69 forward_notes (9) 실측). 그래서 요구 목록 확장과 픽스처 확장을 **같은 step에서** 하고, 두 테이블을 한 번에 넣어 뒤의 리포지토리 step들이 스키마를 건드리지 않게 한다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — scope · baseline · order (c) · decisions **(16)** · forward_notes (5)
- `docs/SCHEMA.md` 68~102행 — **ReceiverConfig 테이블**(id INTEGER PK ROWID alias, 나머지 VARCHAR: sourceId·type·name·host·port·username·password·apiEndpoint·apiKey·active(기본 'Y')·createdAt)과 **DistributionTarget 테이블**(id INTEGER PK, 나머지 VARCHAR: name·kind·spoolDir·active(기본 'Y')·createdAt·updatedAt)의 컬럼·타입·기본값
- `src/models/receiverConfigModel.js` 4~7행 — ReceiverConfig COLUMNS 순서(정본)
- `src/models/distributionTargetModel.js` 7행 — DistributionTarget COLUMNS 순서(정본)
- `server-spring/src/main/java/harness/news/db/RequiredSchema.java` — 이 step에서 TABLES를 6테이블로 넓힌다(현재 4)
- `server-spring/src/main/java/harness/news/db/SchemaGuard.java` — 부팅 검증(읽기 검증만, DDL 0)
- `server-spring/src/test/java/harness/news/testsupport/TempNewsDb.java` — CANONICAL_FIXTURE·드리프트 픽스처 상수
- `server-spring/src/test/resources/db/user-schema.sql` — **이 step에서 두 테이블 DDL을 추가한다**
- `server-spring/src/test/resources/db/user-schema-drift.sql`·`article-schema-drift.sql`·`history-schema-drift.sql` — 드리프트 거부 픽스처의 형식(신설 픽스처의 본보기)
- `server-spring/src/test/java/harness/news/db/SchemaGuardTest.java` — 드리프트 거부 단언의 형식

## 배경 (동결된 스키마 사실)

- `ReceiverConfig` 컬럼(순서): `id`(INTEGER PK ROWID alias, insert 제외) · `sourceId` · `type` · `name` · `host` · `port` · `username` · `password` · `apiEndpoint` · `apiKey` · `active`(기본 'Y') · `createdAt`. 전부 VARCHAR(id 제외).
- `DistributionTarget` 컬럼(순서): `id`(INTEGER PK ROWID alias, insert 제외) · `name` · `kind` · `spoolDir` · `active`(기본 'Y') · `createdAt` · `updatedAt`. 전부 VARCHAR(id 제외).
- **이 서버는 스키마를 소유하지 않는다** — 정본은 Node `src/db/schema.js`다. `RequiredSchema`는 '요구 사항'일 뿐이고, 없으면 만드는 것이 아니라 뜨지 않는다(main 소스 DDL 0).
- 계약 하네스가 시드하는 DATA_DIR은 Node의 `createSchema`가 만들므로 이미 7테이블 전부를 갖는다 — 이 step은 그 테이블들의 **존재를 요구 목록에 등재**하는 것이지 만드는 것이 아니다.

## 작업

### A. `RequiredSchema` 확장 (main)

- `RECEIVER_CONFIG_TABLE = "ReceiverConfig"`와 `RECEIVER_CONFIG_COLUMNS`(위 순서, id 포함 여부는 리포지토리가 화이트리스트로 결정하므로 SCHEMA 순서 그대로 등재)·`DISTRIBUTION_TARGET_TABLE = "DistributionTarget"`와 `DISTRIBUTION_TARGET_COLUMNS`를 추가한다.
- `TABLES` 맵을 4 → **6 엔트리**로 넓힌다(`Map.of`는 최대 10 엔트리까지 되므로 그대로 가능).
- 컬럼 목록은 Node 모델의 COLUMNS와 **순서까지** 같아야 한다(SELECT 나열의 단일 출처 규율 — phase 69 decisions (5)).

### B. 정본 픽스처 확장 (test resources — 같은 step에서)

- `server-spring/src/test/resources/db/user-schema.sql`에 `CREATE TABLE IF NOT EXISTS ReceiverConfig (...)`와 `CREATE TABLE IF NOT EXISTS DistributionTarget (...)`를 추가한다(컬럼·타입·DEFAULT·순서를 SCHEMA.md·Node schema.js와 1:1로). `id`는 `INTEGER PRIMARY KEY`(ROWID alias — AUTOINCREMENT 키워드는 Node schema.js 실측을 따라라), 나머지는 VARCHAR, active는 `DEFAULT 'Y'`.
- 이 파일은 **테스트 리소스**다 — main 소스가 아니므로 DDL 금지 정적 스캔의 대상이 아니다(그 스캔은 `src/main/java`·`src/main/resources`만 본다).

### C. 드리프트 거부 픽스처·단언 (test — 컬럼 단위 게이트)

- 기존 드리프트 거부 단언(`user-schema-drift.sql` 등)이 **넓어진 6테이블 목록에서도 유효**한지 확인한다(phase 69 실측: '테이블 없음' 메시지가 길어질 뿐 참을 유지했다).
- 두 새 테이블의 **컬럼 단위 드리프트**를 덮는 픽스처를 신설한다(`receiver-config-schema-drift.sql`·`distribution-target-schema-drift.sql` 등가 — 한 컬럼을 뺀 스키마로 시드해 `SchemaGuard`가 그 컬럼을 지목해 기동 거부하는지 단언). `article-schema-drift.sql`의 형식을 본보기로 삼는다.

## Acceptance Criteria

프레시 체크아웃이면 먼저: `cd /home/user/harness && npm ci`

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./mvnw -B verify
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./mvnw -B -q package -DskipTests
cd /home/user/harness && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 node scripts/spring-contract.mjs --parity
cd /home/user/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수는 기준선 **584 이상**(드리프트 단언 신설분만큼 증가). 실측치를 요약에 적는다. **컨텍스트 로딩 실패 0**(6테이블 요구 + 픽스처 6테이블이 맞아떨어졌다는 증거).
- 3번: exit 0이고 4 프로파일 전부 `diffs=0`(관측 수는 기준선 170 그대로 — 이 step은 라우트를 늘리지 않는다). scope 표는 아직 안 바뀐다.
- 4번 증분 = `server-spring/src/main/java/harness/news/db/RequiredSchema.java` · `server-spring/src/test/resources/db/*.sql` · `server-spring/src/test/java/harness/news/db/SchemaGuardTest.java`(드리프트 단언 신설) · `phases/70-spring-admin-crud/index.json`.

## 검증 절차

1. **red 먼저(픽스처 드리프트 실증)**: `RequiredSchema.TABLES`에 두 테이블을 넣되 **픽스처(user-schema.sql)는 아직 확장하지 않은** 상태로 `mvnw verify`를 돌려, 전 `@SpringBootTest`가 컨텍스트 로딩에서 죽는 것을 실측한다(요약에 실패 개수·메시지 1줄). 그 다음 픽스처를 확장해 green으로 만든다 — 이 순서가 '요구 목록과 픽스처는 같은 step'의 실증이다.
2. **컬럼 드리프트 변이**: 신설 드리프트 픽스처에서 한 컬럼을 되살려(즉 스키마가 온전해지면) 그 드리프트 테스트가 green이 되고, 컬럼을 다시 빼면 red가 되는지 확인한다(단언이 진짜 그 컬럼을 지목하는지).
3. AC 실행. `--parity` 관측 수가 **170 그대로**임을 확인한다(늘어나면 scope 표를 잘못 건드린 것이다).
4. **DB 비파괴**: 하네스가 리포 `news.db`·`uploads/` 무변을 단언한다. 요약에 적는다.
5. index.json의 step0 status·summary 갱신(실측 수치 포함).

## 금지사항

- main 소스(`src/main/java`·`src/main/resources`)에 `CREATE TABLE`·`ALTER`·DDL을 쓰지 마라(주석에도). 이유: 스키마 소유자는 Node이고 `NoSchemaSqlInMainSourcesTest`가 기계로 잠근다.
- `RequiredSchema`만 넓히고 `user-schema.sql`을 안 넓히지 마라. 이유: 전 `@SpringBootTest`가 컨텍스트 로딩에서 죽는다(요구 목록과 픽스처는 반드시 같은 step).
- scope 표(`scripts/spring-contract.mjs`)를 이 step에서 늘리지 마라. 이유: 라우트를 구현하지 않았으므로 계약 파일이 green이 될 수 없다 — 늘리면 `--parity`가 red가 된다(order (f)).
- 라우트·컨트롤러·서비스·리포지토리를 만들지 마라. 이유: 이 step은 DB 계층 전용이다(실패 원인 격리).
- 컬럼을 추가·삭제하지 마라(요구 목록에 없는 컬럼 생성 금지). 이유: additive 원칙 — 요구 목록은 Node 스키마의 부분집합이면 충분하다.
