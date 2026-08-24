# Step 4: distribution-target-repository

배부 대상(수신처) 데이터 접근층을 만든다 — `DistributionTargetRepository`(화이트리스트 SQL: query 조회 · findById 단건 · insert 생성 · update 부분 갱신). **삭제 함수를 두지 않는다** — 대상 제거는 `active='N'` update(soft delete)가 유일한 경로다.

이 step은 **model 계층만** 건드린다. `distribution-targets.contract.js`는 아직 green이 될 수 없다 — 판정은 Java 리포지토리 단위 테스트 + 이미 green인 scope 무회귀다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — decisions **(5)(10)(13)(16)**
- `src/models/distributionTargetModel.js` — **이식 원본**(query: 화이트리스트 AND 동등 필터 + ORDER BY id · findById · insert: present-only(정의 컬럼만) → id 반환 · update: present-only SET, id는 SET 대상 아님 → changes 반환). **remove/delete 함수 없음**. 읽기 전용 참조
- `server-spring/src/main/java/harness/news/db/RequiredSchema.java` — step0이 추가한 `DISTRIBUTION_TARGET_COLUMNS`
- `server-spring/src/main/java/harness/news/model/ReceiverConfigRepository.java` — step1이 만든 같은 도메인 형태의 리포지토리(바인딩 정책·화이트리스트 패턴 재사용)
- `server-spring/src/main/java/harness/news/model/ArticleRepository.java` — 값 바인딩 정책의 실제 구현
- `server-spring/src/test/java/harness/news/model/*` — 리포지토리 단위 테스트 형식

## 배경 (동결된 계약 사실)

- `id`는 INTEGER PK(ROWID alias)라 insert/update 대상이 아니고 자동 증가한다.
- query는 화이트리스트 컬럼(`id` + `name,kind,spoolDir,active,createdAt,updatedAt`)만 AND 동등 필터, `ORDER BY id`. 밖의 키는 무시. **active로 자동 필터링하지 않는다**(비활성 행도 목록에 남는다 — decisions (5)).
- findById(id) → 단건 또는 없음(존재 판정용 — 서비스가 not-found 판정에 쓴다).
- insert(present-only) → 새 행 id(정수) 반환. update(present-only SET, id는 SET 제외) → changes 반환. **삭제 함수 없음.**
- 값 바인딩은 Node 동형(decisions (13)).

## 작업

### A. `model` 계층 — `DistributionTargetRepository`

- 생성자 주입. 시그니처(구현 재량):
  - `int insert(Map<String,Object> entry)` — 정의된 화이트리스트 컬럼만 INSERT, 새 행 id 반환.
  - `Optional<Map<String,Object>> findById(long id)` — 단건 조회(전체 행).
  - `List<Map<String,Object>> query(Map<String,Object> filters)` — 화이트리스트 AND 동등 필터, `ORDER BY id`, 전체 행 반환.
  - `int update(long id, Map<String,Object> fields)` — present-only SET(전달 컬럼만), 아무 컬럼도 없으면 0, changes 반환.
- **remove/delete 메서드를 만들지 마라**(SCHEMA.md 99행·decisions (5) — soft delete만).
- 컬럼 화이트리스트 단일 출처는 `RequiredSchema.DISTRIBUTION_TARGET_COLUMNS`.

### B. 테스트 (먼저 쓴다 — @TempDir 임시 DB · 리포지토리 단위)

1. insert 후 findById/query로 되읽어 전 컬럼 확인.
2. query 화이트리스트: spoolDir로 좁힘, 밖의 키 무시, AND 불일치 빈 목록, **active='N' 행도 필터 없이는 목록에 남음**.
3. update(present-only): 전달 컬럼만 바뀌고 나머지 불변, id는 SET 대상 아님.
4. update(빈 fields) → changes 0.
5. update(active='N') → changes 1, 되읽으면 active='N'이고 행 존재(삭제 아님).
6. 바인딩: 불리언/객체 값 예외(decisions (13)).

## Acceptance Criteria

프레시 체크아웃이면 먼저: `cd /home/user/harness && npm ci`

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./mvnw -B verify
cd /home/user/harness && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 node scripts/spring-contract.mjs --parity
cd /home/user/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가. 실측치를 요약에 적는다.
- 2번: exit 0 · 4 프로파일 diffs 0 · 관측 수 불변(HTTP 없음).
- 3번 증분 = `server-spring/src/main/java/harness/news/model/DistributionTargetRepository.java` · `server-spring/src/test/java/harness/news/model/*` · `phases/70-spring-admin-crud/index.json`.

## 검증 절차

1. **red 먼저**: 리포지토리 단위 테스트를 구현 전에 돌려 실패 실측.
2. AC 실행. `--parity` 관측 수 불변 확인.
3. **DB 비파괴**: findById/query가 SELECT만, update가 유일한 변경이고 삭제 문장 0임을 확인(`NoSchemaSqlInMainSourcesTest`가 여전히 green — DistributionTarget에 대한 DELETE FROM은 여전히 red 대상).
4. index.json step4 갱신.

## 금지사항

- `DELETE FROM DistributionTarget`·remove/delete 메서드를 만들지 마라. 이유: 대상 제거는 soft delete(active='N')뿐이다(DB 비파괴 — step1이 좁힌 예외는 ReceiverConfig 하나뿐).
- query가 active로 자동 필터링하게 만들지 마라. 이유: 비활성 행도 목록에 남는 것이 계약이다.
- 검증(kind enum·spoolDir 슬러그·name 필수)을 리포지토리에 넣지 마라. 이유: 검증은 서비스 계층 책임이다(step5).
- 컨트롤러·서비스를 만들거나 scope 표를 늘리지 마라. 이유: 이 step은 model 계층 전용.
