# Step 2: article-repository

`Article`·`Contents` 두 테이블의 **데이터 접근 계층**을 만든다(직접 SQL, ORM 없음 — ADR-002·ADR-013). 비즈니스 규칙은 넣지 않는다.

이 step이 소유하는 것: 스키마 요구 목록 확장 · 테스트용 DDL 픽스처 · 조회/삽입/갱신/검색/잠금 컬럼 갱신 SQL · `articleId` 유일성 발급 · **필터 13키 매핑과 결함 후보 #4 재현**.

## 읽어야 할 파일

- `phases/69-spring-articles/index.json` — decisions **(5)(7)(8)(9)(10)(18)(21)**
- `src/models/articleModel.js` (171행 전부) — **이식 원본**: 컬럼 화이트리스트 2종 · present-only 삽입/갱신 · 트랜잭션 `tx` · `query(filters)`의 조건 조립 순서 · `searchByText`(3컬럼 LIKE) · `setLock`/`clearLock`
- `src/db/schema.js` 20~57행 — `Article` 5컬럼 · `Contents` **29컬럼(순서 포함)**
- `src/db/articleId.js` — 유일성 확인 SQL(두 테이블 UNION)
- `server/index.js` 378~390행 — `FILTER_KEYS` **13키**와 `pickFilters`(존재하는 키만 전달)
- `contract/cases/default/articles-read.contract.js` 30~36행·140~260행 — 27키·5키 shape 상수, 필터 케이스 전수(반복 키 IN/NOT IN · 콤마 미분해 · `departments` 우선 · 날짜 범위에서 NULL 행 탈락 · 화이트리스트 밖 키 무시 · **스칼라 키 반복 500**)
- `server-spring/src/main/java/harness/news/db/RequiredSchema.java` · `db/SchemaGuard.java` — 확장 지점(요구 목록의 단일 출처)
- `server-spring/src/main/java/harness/news/model/UserRepository.java` — 화이트리스트 SQL·바인딩·"화이트리스트 밖 키는 조용히 무시" 규율의 기존 사례
- `server-spring/src/test/resources/db/user-schema.sql` · `server-spring/src/test/java/harness/news/testsupport/TempNewsDb.java` — **정본 픽스처**(`CANONICAL_FIXTURE`)와 임시 DB가 사는 곳. 이 step이 확장하는 대상이다
- `server-spring/src/test/java/harness/news/db/SchemaGuardTest.java` · `server-spring/src/test/java/harness/news/db/DbBootGuardTest.java` · `server-spring/src/test/resources/db/user-schema-drift.sql` — 드리프트 거부 단언(요구 목록이 넓어져도 유효해야 한다)
- step1 산출물(시각 포매터 · articleId 형식 생성기 · 파일 참조 정화는 서비스가 쓴다)

## 배경 (동결된 계약 사실)

- **응답 행의 키 집합은 스키마 컬럼 집합이다.** `Contents` 29컬럼(투영 후 27키) · `Article` 5컬럼. 값이 NULL이어도 **키가 남는다**(decisions (5)).
- 삽입·갱신은 **present-only**다: 주어지지 않은 컬럼은 문장에 넣지 않는다(그래서 미전달 필드가 기존 값을 덮지 않고, 신규 행에서는 NULL로 남는다).
- `query`의 조건 조립: 동등 3키(`articleId`·`author`·`sender`) → `status` IN → `excludeStatus` NOT IN → 부서(`departments` 우선, 없으면 `department`) IN → 시각 3쌍 범위(`>=`/`<=`) → `ORDER BY createdAt DESC`.
- **배열이 허용되는 키는 `status`·`excludeStatus`·`departments` 3개뿐**이다. 나머지 키에 값이 2개 이상 오면 **500 `internal-error`**가 되어야 한다(decisions (9) — 결함 후보 #4의 재현).
- 검색은 `Article` 테이블의 `title`·`content`·`markupVersion` **3컬럼 LIKE**이며 빈 질의는 전 행 매칭이다(거부가 아니다).
- 잠금 획득은 5컬럼을 한 문장으로 세팅하고, 해제는 같은 5컬럼을 `'N'`/NULL로 되돌린다 — **행을 지우지 않는다**.
- `changes`는 두 갱신문의 영향 행 수 **합**이며 계약 리포트가 그 정수를 비교한다(decisions (18)).

## 작업

### A. 스키마 요구 목록 확장 (읽기 검증만)

- `RequiredSchema`에 `Article`(5) · `Contents`(**29, 스키마 순서 그대로**) 컬럼 목록을 추가하고 부팅 검증 대상 테이블에 넣는다. **이 목록이 SELECT 컬럼 나열의 단일 출처**다(`SELECT *` 금지 — decisions (5)).
- 부팅 시 없으면 **무엇이 없는지 지목하고 기동 거부**(기존 `SchemaGuard` 동작 그대로 — 새 DDL을 실행하지 않는다).
- **전역 파급을 먼저 알고 시작하라**: `SchemaGuard`는 `RequiredSchema.TABLES`의 **전 테이블**을 부팅에서 검증한다. 즉 목록을 넓히는 순간 그 요구는 이 step의 새 테스트뿐 아니라 **정본 픽스처로 시드된 기존 전 테스트**에 적용된다 — 그래서 B는 선택이 아니라 필수다.

### B. 테스트 DDL 픽스처 — **정본 픽스처를 확장한다**

- 확장 대상은 **정본 픽스처 자체**다: `TempNewsDb.CANONICAL_FIXTURE`(= `server-spring/src/test/resources/db/user-schema.sql`)에 기사 3테이블(`Article`·`Contents`·`ArticleHistory`) DDL을 **추가**한다.
- **별도 픽스처를 만들어 리포지토리 테스트에만 적용하지 마라.** 이유: A가 요구 목록을 넓히는 순간 정본 픽스처로 시드된 **모든 `@SpringBootTest`가 컨텍스트 로딩에서 기동 거부로 죽는다**. 계획 시점에 확인된 정본 픽스처 사용처: `HandlerInventoryTest:73` · `FilterWiringTest:35` · `HealthWireTest:34` · `SessionWiringTest:40` · `ClockBeanTest:30`(`TempNewsDb.sharedDataDir()` 경유) · `UserRepositoryTest:43` · `AuthorizationTest:48` · `SessionGuardTest:60` · `UserServiceLoginTest:79`. 실제 사용처는 `TempNewsDb`·`CANONICAL_FIXTURE` 참조를 검색해 **다시 확인**하고 요약에 개수를 적는다.
- **드리프트 픽스처는 유지한다**: `db/user-schema-drift.sql` 기반의 거부 단언(`SchemaGuardTest:49` · `DbBootGuardTest:38`)이 **넓어진 요구 목록에서도 유효한지** 확인한다. 단언이 특정 실패 메시지 문자열에 묶여 있다면 그 메시지가 여전히 참인지 실측으로 확인하라 — 단언을 **약화하지 마라**(느슨한 부분 문자열 매칭으로 바꾸는 것도 약화다).
- `ArticleHistory`까지 한 번에 넣어 step3이 픽스처를 다시 건드리지 않게 한다.
- **main 소스에는 DDL이 없다**(정적 스캔 테스트가 잠근다) — 픽스처는 테스트 리소스에만 존재한다.
- 컬럼 정의는 `src/db/schema.js`와 **같은 타입 표기·같은 순서**로 옮긴다(정렬·affinity가 계약에 영향을 준다).

### C. 리포지토리

메서드는 정본과 1:1로 둔다(이름은 Java 관례로): 단건 조회(`Article`·`Contents` 둘 다 조회해 둘 다 없으면 없음) · 상태만 읽는 경량 조회 · 삽입 · 갱신 · 목록 조회(필터) · 텍스트 검색 · 잠금 설정 · 잠금 해제.

- **컬럼 화이트리스트 밖 키는 조용히 무시한다**(거부가 아니다 — 68 `UserRepository`와 같은 규율). 갱신 대상 컬럼이 하나도 없으면 SQL을 실행하지 않고 0을 돌려준다.
- **바인딩 정책(decisions (8))**: 문자열·숫자는 텍스트로, `null`은 SQL NULL로 바인딩하고 **불리언·객체·배열은 예외를 던진다**(전역 핸들러가 500으로 만든다 — Node 동형).
- **트랜잭션**: 두 테이블을 함께 바꾸는 삽입·갱신은 하나의 트랜잭션이며 실패 시 원인 예외를 보존한다(롤백 실패가 원인을 덮지 않게).
- **필터 매핑**: 입력은 `키 → 값 배열`(원문) 형태로 받는다. 배열 허용 3키만 다중 값을 IN/NOT IN으로 펴고, **나머지 키에 값이 2개 이상이면 예외**를 던진다(decisions (9)). 값이 1개면 그대로 동등/범위 조건.
- **articleId 발급**: step1의 형식 생성기로 후보를 만들고 두 테이블 어느 쪽에도 없을 때까지 다시 뽑는다. 무한 루프 방지 상한을 두되, 상한에 걸리면 **조용히 진행하지 말고 예외**로 알린다.
- 반환 행은 컬럼 목록 순서의 맵이며 **투영은 하지 않는다**(투영은 서비스 책임 — 내부 판정 경로가 원본을 필요로 한다, decisions (4)). 단, `Contents` 원본 행은 step1이 정의한 **명목 타입으로 감싸 돌려준다**(decisions (4)① 타입 경계 — 투영 우회를 타입으로 막는다). `Article` 행은 투영 대상이 아니므로 평범한 맵이다.

### D. 테스트 (먼저 쓴다 — `@TempDir` 임시 파일 DB + DDL 픽스처)

1. 삽입 후 조회: `Contents` **29키**·`Article` **5키**가 전부 있고 미전달 컬럼은 `null`이다.
2. present-only 갱신: 준 컬럼만 바뀌고 나머지는 **그대로**(특히 본문·상태·잠금 컬럼이 우연히 지워지지 않는다). 반환 `changes`가 두 문장의 합이다.
3. 필터 전수: 동등 3키 · `status` 단일/다중 · `excludeStatus` 단일/다중 · `departments`가 `department`를 **덮어쓴다** · 날짜 범위에서 **NULL 값 행이 탈락** · 정렬이 `createdAt` 내림차순 · 화이트리스트 밖 키 무시.
4. **콤마 미분해**: 값이 `RDS,DDH` 하나면 매칭 0건이다.
5. **스칼라 키 반복 → 예외**(결함 후보 #4 재현). 배열 허용 3키는 예외가 아니다.
6. 검색: 제목·본문·마크업 각각에서 매칭 · 빈 질의는 전 행 · 무매칭은 빈 목록.
7. 잠금: 설정 후 5컬럼 값 · 해제 후 `'N'`과 NULL 4개. **행 수는 변하지 않는다**(해제가 삭제가 아님을 행 수로 단언).
8. 바인딩 정책: 숫자 값이 텍스트로 저장되고 다시 읽힌다 · 불리언 값은 예외 · `null`은 SQL NULL.
9. articleId: 형식 · 이미 존재하는 id를 만나면 다시 뽑는다(고정 난수원 주입 또는 선삽입으로 실증).
10. 스키마 가드: 요구 컬럼이 빠진 DB로 부팅 검증하면 **무엇이 없는지 메시지에 담아** 실패한다(기존 드리프트 픽스처 방식 재사용).

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 3번은 무회귀 확인(관측 수 step0과 동일 · `diffs=0`). 이 step은 라우트를 늘리지 않는다.
- **부팅 검증이 확장됐으므로** 하네스가 띄우는 Spring이 기동에 성공하는지가 이 step의 실질 게이트다(하네스는 Node 스키마로 시드한 임시 DB를 쓴다 — 요구 목록이 실제 스키마와 어긋나면 기동 실패로 즉시 드러난다).

## 검증 절차

1. red 먼저(D의 10군).
2. AC 실행. `--parity`가 exit 0인지 확인 — 만약 **기동 실패**가 나면 요구 컬럼 목록이 실제 `src/db/schema.js`와 어긋난 것이다(하네스 진단에 java stdout/stderr가 붙는다). 그 경우 **스키마를 만들지 말고 목록을 고쳐라**.
3. **정본 픽스처 파급 확인(이 step의 필수 관측)**: `mvnw -B verify`에서 **컨텍스트 로딩 실패 0**임을 확인한다 — 정본 픽스처를 쓰는 기존 `@SpringBootTest`(B의 목록)가 전부 green이어야 한다. 하나라도 `ApplicationContext` 로딩 실패로 죽으면 정본 픽스처 확장이 누락된 것이다(개별 테스트에 픽스처를 덧대 우회하지 마라). 그리고 드리프트 거부 단언(`SchemaGuardTest`·`DbBootGuardTest`)이 **넓어진 목록으로도** 통과하는지 확인해 실패 메시지 실측을 요약에 적는다.
4. **변이 실증 3종**(확인 후 원복): (a) `SELECT *`로 바꾸면 1번이 red인가(키 집합이 스키마 변화에 끌려간다) (b) 스칼라 반복 키를 첫 값만 쓰도록 바꾸면 5번이 red인가 (c) 잠금 해제를 행 삭제로 바꾸면 7번이 red인가 — **(c)는 반드시 원복하고, 실험 자체를 임시 DB에서만 하라**.
5. **DB 비파괴 확인**: Java 테스트가 리포 `news.db`를 열지 않는지(임시 디렉토리 경로만 사용) · main 소스 정적 스캔 테스트가 green인지.
6. `git status --porcelain` 증분 = `server-spring/src/main/java/harness/news/{db,model}/**` · `server-spring/src/test/resources/db/user-schema.sql`(정본 픽스처 확장) · `server-spring/src/test/**` · `phases/69-spring-articles/index.json`.
7. index.json step2 status·summary 갱신(어떤 컬럼 목록을 요구 대상에 넣었는지 · 정본 픽스처를 확장했다는 사실과 그 파급 범위를 명시).

## 금지사항

- main 소스에 스키마를 만들거나 바꾸거나 행을 지우는 SQL을 **주석에도** 쓰지 마라. 이유: 정적 스캔 테스트가 문자열 등장만으로 red다. 그리고 스키마 소유자는 Node(`src/db/schema.js`)다.
- `SELECT *`를 쓰지 마라. 이유: 응답 키 집합이 스키마 변경에 따라 조용히 넓어지고, 투영이 모르는 새 컬럼(다음 비밀)이 그대로 나간다.
- 스칼라 전용 필터 키의 반복을 400으로 바꾸지 마라. 이유: 계약이 500을 동결했다(결함 후보 #4). 지금 고치면 `articles-read.contract.js`가 red가 되고 '이식 결함'과 '의도된 계약 변경'이 섞인다.
- 쿼리 값에 콤마 분해를 넣지 마라. 이유: `?status=RDS,DDH`가 매칭 0건인 것이 계약이다.
- 화이트리스트 밖 키에 예외를 던지지 마라. 이유: Node는 조용히 무시하고 그 결과(200·`changes:0`)가 계약으로 동결돼 있다(68 forward_notes (19)(d)가 흡수 검토에서 되돌린 결함이다).
- 갱신에서 present-only를 깨고 전 컬럼을 쓰지 마라. 이유: 부분 수정이 본문·상태·잠금을 조용히 지운다(DB 비파괴 위반).
- 응답 투영을 리포지토리에 넣지 마라. 이유: 잠금 판정(재로그인 takeover)이 `lockerSessionId` 원본을 필요로 한다 — 투영은 서비스의 단일 지점이다.
