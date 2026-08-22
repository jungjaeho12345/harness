# Step 1: receiver-config-repository

`ReceiverConfig` 데이터 접근층(직접 SQL) + **요구 스키마 확장 + 정본 픽스처 확장**을 한 step에서 한다. 라우트를 늘리지 않으므로 계약 scope는 그대로 — 판정은 Java 테스트 + 무회귀 + 지정 진단 서명이다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — 전체(특히 decisions **(1)(5)(9)(12)** · order (e))
- `phases/69-spring-articles/index.json` forward_notes **(9)** — 요구 스키마 확장의 전역 파급과 정본 픽스처 동시 확장 규율(같은 함정 반복 금지)
- `src/models/receiverConfigModel.js` — 이식 정본(query·insert·remove). `COLUMNS` 11개 · `FILTERABLE = ['id', ...COLUMNS]`
- `docs/SCHEMA.md` `## ReceiverConfig Table` (68~77행) — 12컬럼 · 삭제는 설정 행만
- `src/db/schema.js` `SCHEMA.ReceiverConfig`(79~92행) — 컬럼 순서 정본
- `server-spring/src/main/java/harness/news/db/RequiredSchema.java` — 확장 대상(TABLES·컬럼 상수 추가)
- `server-spring/src/main/java/harness/news/model/ArticleRepository.java` — 직접 SQL·화이트리스트·숫자 `Types.DOUBLE` 바인딩 이식 선례
- `server-spring/src/test/java/harness/news/db/SchemaGuardTest.java` · `src/test/resources/db/user-schema.sql`(정본 픽스처) · `db/article-schema-drift.sql`(드리프트 픽스처 선례) · `src/test/java/harness/news/testsupport/TempNewsDb.java`
- **step0에서 만든 파일**: `server-spring/src/main/java/harness/news/service/SpoolDir.java`(이 step에서 쓰지 않지만 존재 확인)

## 작업 (테스트 먼저)

1. **정본 픽스처 확장 먼저** — `src/test/resources/db/user-schema.sql`에 `ReceiverConfig`(12컬럼)와 `DistributionTarget`(7컬럼) **두 테이블 DDL을 한 번에** 추가한다(`src/db/schema.js` 컬럼 순서·타입 그대로 · `id INTEGER PRIMARY KEY`, 나머지 VARCHAR · `active VARCHAR DEFAULT 'Y'`). step2가 이 픽스처를 다시 건드리지 않게 하기 위해서다.
2. **드리프트 픽스처 신설** — `receiver-config-schema-drift.sql`(ReceiverConfig만 컬럼 결손, 예: `password`·`apiKey` 빠짐)과 `TempNewsDb`의 참조 상수. `distribution-target-schema-drift.sql`은 step2 몫이지만, DDL을 이 step에서 정본 픽스처에 다 넣었으므로 step2는 드리프트 픽스처·TABLES 항목만 추가한다.
3. **테스트 먼저** — `SchemaGuardTest`에 ReceiverConfig 검증 단언(12컬럼·TABLES에 `ReceiverConfig` 존재·컬럼 드리프트 거부 메시지가 결손 컬럼을 지목)을 추가하고, `ReceiverConfigRepositoryTest`를 신설한다. 덮을 계약(Node 대조 — **작업 A로 실측 확정**):
   - `query(filters)`: 화이트리스트 컬럼(`FILTERABLE = id + 11컬럼`) AND 동등 필터 · `ORDER BY id` · 필터 값이 `undefined`/`null`이면 조건 제외 · 화이트리스트 밖 키 무시 · 빈 필터 → 전건.
   - `insert(entry)`: present-only(`entry`에 있는 컬럼만) · `id`는 삽입 대상 아님(자동 증가) · `lastInsertRowid` 반환 · 미지정 컬럼은 NULL(되읽으면 `createdAt` 등 null).
   - `remove(id)`: `DELETE FROM ReceiverConfig WHERE id = ?` · 영향 행 수(`changes`) 반환 · 없는 id → `0` · 재삭제 → `0`.
   - **숫자 바인딩 동형**(gap #4): 숫자 값은 `Types.DOUBLE`로 바인딩해 `42 → "42.0"`(자체 포매터 금지). 리포지토리 단위 테스트가 유일 방어선.
   - **비-ASCII 왕복**(gap #5): 한글 name/sourceId 저장 후 그 값으로 필터 조회 시 매치(계약 픽스처는 ASCII만 — 이 테스트가 유일 방어선).
4. 구현 전 red 서명을 관측·기록한다(스키마 확장 전엔 정본 픽스처가 새 테이블을 이미 갖게 되므로 SchemaGuardTest는 TABLES 확장 후 통과; 리포지토리 테스트는 클래스 부재로 red).
5. `RequiredSchema`에 `RECEIVER_CONFIG_TABLE`·`RECEIVER_CONFIG_COLUMNS`(12) 추가 + `TABLES`에 `ReceiverConfig` 행 추가. `model/ReceiverConfigRepository.java` 구현(생성자 주입·`@Autowired` · `SELECT` 나열은 요구 스키마 컬럼 순회 = 응답 키 집합 단일 출처, `SELECT *` 금지). green 확인.

## Acceptance Criteria

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B verify
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B -q package -DskipTests
cd /home/user/harness && node scripts/spring-contract.mjs --parity
cd /home/user/harness && npm test
cd /home/user/harness && git diff --stat
```

- 1번: failures/errors 0. 테스트 수는 step0 기준선보다 커야 한다(SchemaGuardTest·ReceiverConfigRepositoryTest 신규분).
- 3번: exit 0 · 전 프로파일 `diffs=0`(라우트 미변 · **넓어진 부팅 검증이 하네스의 Node 시드 DB에서도 통과**한다는 실질 게이트가 여기서 닫힌다 — 정본 픽스처를 안 넓히면 전 기동 테스트가 컨텍스트 로딩에서 죽는다).
- 4번: **1328/1328**.
- 5번: 변경이 `server-spring/**`에만 있음(무접촉 목록 0줄 — 특히 `src/**`·`contract/**` 무변).

## 검증 절차

1. **작업 A(Node 대조)**: 리포 밖 임시 DB에 `createSchema`로 시드하고 `src/models/receiverConfigModel.js`를 직접 관측해 query 필터·insert present-only·remove changes·NaN id 동작을 실측한다(계획서 추정 금지). Java 테스트가 그 관측과 1:1인지 확인한다.
2. **정본 픽스처 파급 실측**: `TempNewsDb`를 참조하는 `@SpringBootTest` 개수와 확장 후 컨텍스트 로딩 실패 **0**을 기록한다(69 forward_notes (9) 형식).
3. **드리프트 거부 단언이 약화되지 않았는지**: `receiver-config-schema-drift.sql`의 실제 거부 메시지가 결손 컬럼을 지목하는지 확인하고, 기존 user/article/history drift 단언이 넓어진 목록에서도 참인지 확인한다.
4. **변이 실증**(원복): `SELECT` 나열을 `SELECT *` + 메타데이터 매핑으로 바꾸고 임시 DB에 컬럼을 하나 추가하면 그 컬럼이 응답 키에 새는지 확인(응답 키 집합의 진짜 출처가 요구 스키마 순회임을 증명 — 69 step2 선례).
5. main 소스 DDL 0 · **`ReceiverConfigRepository.remove`의 `DELETE`는 `ReceiverConfig` 테이블 하나에만** 있고 다른 테이블 DELETE 0임을 확인한다(decisions (1)).

## 금지사항

- 요구 목록(`TABLES`)만 넓히고 정본 픽스처를 그대로 두지 마라. 이유: 정본 픽스처로 시드된 전 `@SpringBootTest`가 `SchemaGuard`의 부팅 검증에서 컨텍스트 로딩 실패로 죽는다(69 forward_notes (9)).
- `SELECT *`로 읽지 마라. 이유: 응답 키 집합이 스키마 변경에 따라 조용히 넓어지고 투영이 모르는 새 컬럼이 그대로 나간다 — 읽기 나열의 단일 출처는 `RequiredSchema` 순회다.
- `DistributionTarget`에 삭제 함수를 만들지 마라(step2). `ReceiverConfig` 외 어떤 테이블에도 `DELETE`를 추가하지 마라. 이유: 시스템 유일의 행 삭제 라우트는 receiver-config-delete뿐이다(decisions (1)).
- main 소스에 CREATE/ALTER/DROP TABLE을 쓰지 마라(주석에도). 이유: 이 서버는 스키마를 소유하지 않는다 — 없으면 만드는 것이 아니라 뜨지 않는다(정적 스캔이 잠근다).
- 숫자를 `String.valueOf`로 바인딩하지 마라. 이유: node:sqlite는 REAL→TEXT로 `42`를 `"42.0"`으로 저장한다 — `Types.DOUBLE` 바인딩으로 같은 변환을 얻어야 저장값이 갈리지 않는다(gap #4).
