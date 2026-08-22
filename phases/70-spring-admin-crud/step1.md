# Step 1: receiver-config-repository

수집 수신 설정 데이터 접근층을 만든다 — `ReceiverConfigRepository`(화이트리스트 SQL: query 조회 · insert 생성 · **remove 삭제**). 이 리포지토리가 도입하는 `DELETE FROM ReceiverConfig`는 **이 시스템의 유일한 행 삭제**이므로, 같은 step에서 정적 삭제 금지 스캔을 그 하나만 허용하도록 좁힌다.

이 step은 **model 계층만** 건드린다. 컨트롤러·서비스가 없어 `receiver-config.contract.js`는 아직 green이 될 수 없다 — 판정은 Java 리포지토리 단위 테스트 + 이미 green인 scope 무회귀다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — decisions **(2)(10)(11)(13)(16)** · forward_notes (3)①
- `src/models/receiverConfigModel.js` — **이식 원본**(query: 화이트리스트 AND 동등 필터 + ORDER BY id · insert: present-only(정의 컬럼만) · remove: `DELETE FROM ReceiverConfig WHERE id = ?` → changes 반환). 읽기 전용 참조
- `server-spring/src/main/java/harness/news/db/RequiredSchema.java` — step0이 추가한 `RECEIVER_CONFIG_COLUMNS`(화이트리스트 단일 출처)
- `server-spring/src/main/java/harness/news/model/UserRepository.java` — 이미 있는 화이트리스트 직접 SQL 리포지토리의 본보기(JdbcClient/DataSource 사용 패턴·바인딩 정책)
- `server-spring/src/main/java/harness/news/model/ArticleRepository.java` — 값 바인딩 정책(숫자·null·불리언/객체/배열 예외)의 실제 구현
- `server-spring/src/test/java/harness/news/model/UserRepositoryTest.java` — 리포지토리 단위 테스트(@TempDir 임시 DB) 형식
- `server-spring/src/test/java/harness/news/db/NoSchemaSqlInMainSourcesTest.java` — **이 step에서 좁히는 정적 스캔**(현재 모든 `DELETE FROM`을 red로 만든다)
- `server-spring/src/test/java/harness/news/testsupport/TempNewsDb.java` — 임시 DB 시드 헬퍼

## 배경 (동결된 계약 사실)

- `ReceiverConfig`의 `id`는 INTEGER PK(ROWID alias)라 **insert 대상이 아니고** 자동 증가한다. insert는 정의된 컬럼(undefined 제외)만 넣고 새 행 id를 반환한다.
- query는 화이트리스트 컬럼(`id` + COLUMNS)만 **AND 동등** 필터로 쓴다 — 밖의 키는 무시한다(400이 아니다). `ORDER BY id`.
- **remove는 설정 행만 지운다** — 이미 수집된 `Article`/`Contents`는 절대 건드리지 않는다(DB 비파괴 원칙의 명시적 예외 경계). `DELETE FROM ReceiverConfig WHERE id = ?`의 영향 행 수(changes)를 반환한다. 존재 판정을 하지 않으므로 없는 id·NaN id는 changes 0이다(decisions (11)).
- 값 바인딩은 Node 동형(decisions (13)): 문자열·숫자는 텍스트, `null`은 SQL NULL, 불리언·객체·배열은 예외(→ 전역 500). 계약 케이스는 문자열만 보내므로 이 축은 관측되지 않는다.

## 작업

### A. Node 대조 리포트 실측 (구현 전, decisions (17)) — 특히 NaN id

리포 **밖** 임시 경로에 Node 리포트를 뽑아 receiver-config-delete의 `nan-id`·`repeat-idempotent` 관측(둘 다 200 changes:0)을 눈으로 확인한다. `DELETE /api/receiver-config/abc`가 Node에서 500이 아니라 200 changes:0임을 실측해, Java의 NaN 바인딩이 같은 결과를 내도록 맞춘다.

```bash
cd /home/user/harness && OUT="$(mktemp -d)" && node scripts/contract-run.mjs --profile default --files contract/cases/default/receiver-config.contract.js --out "$OUT/node-rc.json" && ls -l "$OUT"
```

실제로 쓴 절대 경로와 확인한 사실(특히 `nan-id`의 status·changes)을 요약에 1~2줄로 남긴다.

### B. `model` 계층 — `ReceiverConfigRepository`

- 생성자 주입(DataSource/JdbcClient). 시그니처(구현은 재량):
  - `int insert(Map<String,Object> entry)` — 정의된 화이트리스트 컬럼만 INSERT, 새 행 id(int) 반환.
  - `List<Map<String,Object>> query(Map<String,Object> filters)` — 화이트리스트 AND 동등 필터, `ORDER BY id`, **전체 행(시크릿 포함)**을 돌려준다(투영은 서비스 책임 — 계층 분리).
  - `int remove(long id)` — `DELETE FROM ReceiverConfig WHERE id = ?`, changes 반환.
- 컬럼 화이트리스트의 단일 출처는 `RequiredSchema.RECEIVER_CONFIG_COLUMNS`다(`SELECT *`를 쓰더라도 결과는 서비스가 SAFE_FIELDS로 투영하므로 무방하나, 필터·insert 컬럼은 반드시 화이트리스트).
- NaN/비수치 id는 매칭 0 → changes 0로 수렴하게 한다(작업 A 실측에 맞춰 바인딩).

### C. 정적 삭제 금지 스캔 좁히기 (test — 같은 step에서)

- `NoSchemaSqlInMainSourcesTest.mainSourcesContainNoSchemaMutatingSql`의 `\bdelete\s+from\b` 패턴을 **`DELETE FROM ReceiverConfig`만 허용**하도록 좁힌다.
- 동시에 **다른 어떤 테이블도 `DELETE FROM` 대상이 아님**을 적극 단언한다(예: main 소스 전수에서 `delete\s+from\s+(?!receiverconfig\b)...` 잔여 매치 0). 게이트를 통째로 삭제·약화하지 마라 — User·Article·Contents·ArticleHistory·DistributionTarget·Photo의 행 삭제는 여전히 red여야 한다.
- 완화의 근거(SCHEMA.md 76행·계약 파일 7~9행: 설정 행만 삭제, 수집 기사 불변 = DB 비파괴 예외 경계)를 테스트 주석에 명시한다.

### D. 테스트 (먼저 쓴다 — @TempDir 임시 DB · 리포지토리 단위)

1. insert 후 query로 되읽어 새 행 id가 양의 정수이고 전 컬럼(시크릿 포함)이 그대로임을 확인.
2. query 화이트리스트: `sourceId`로 좁히면 그 행만, 밖의 키(`notAColumn`)는 무시(전체 반환), AND 조합 불일치는 빈 목록.
3. remove(자기 id) → changes 1, 되읽으면 사라짐. 같은 id 재remove → changes 0(멱등, 예외 아님).
4. remove(없는 id)·remove(NaN 등가) → changes 0.
5. 바인딩: 불리언/객체 값은 예외를 던진다(decisions (13)).

## Acceptance Criteria

프레시 체크아웃이면 먼저: `cd /home/user/harness && npm ci`

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./mvnw -B verify
cd /home/user/harness && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 node scripts/spring-contract.mjs --parity
cd /home/user/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가(리포지토리 단위 테스트분). 실측치를 요약에 적는다.
- 2번: exit 0 · 4 프로파일 diffs 0 · 관측 수 170 그대로(이 step은 라우트를 늘리지 않는다 — 계약 파일은 아직 red가 될 수도 없다, scope 밖).
- 3번 증분 = `server-spring/src/main/java/harness/news/model/ReceiverConfigRepository.java` · `server-spring/src/test/java/harness/news/model/*` · `server-spring/src/test/java/harness/news/db/NoSchemaSqlInMainSourcesTest.java` · `phases/70-spring-admin-crud/index.json`.

## 검증 절차

1. **red 먼저**: 리포지토리 단위 테스트를 구현 전에 돌려 실패를 실측한다(요약에 개수).
2. **정적 스캔 변이 실증(원복)**: (a) `DELETE FROM Contents` 문자열을 main 소스 아무 곳(예: 임시 주석)에 넣으면 `NoSchemaSqlInMainSourcesTest`가 여전히 red인가 — 좁힌 예외가 ReceiverConfig에만 한정됐음을 실증. (b) `DELETE FROM ReceiverConfig`(리포지토리의 실제 문장)는 green인가. 확인 후 (a)를 반드시 원복한다.
3. AC 실행. `--parity` 관측 수 170 불변 확인.
4. **DB 비파괴**: 하네스가 리포 `news.db`·`uploads/` 무변 단언. 리포지토리 테스트는 @TempDir만 연다.
5. index.json step1 갱신(NaN id 실측·정적 스캔 완화 근거 포함).

## 금지사항

- `DELETE FROM` 정적 스캔을 통째로 삭제하거나 모든 테이블에 대해 약화하지 마라. 이유: 그 게이트가 DB 비파괴 최상위 규칙의 기계 방어선이다 — ReceiverConfig 하나만 예외로 뚫는다.
- distribution-target·다른 테이블의 삭제 함수를 만들지 마라. 이유: distribution-target 제거는 soft delete(active='N')뿐이고(step5), 그 외 테이블은 삭제 경로가 없다.
- 리포지토리에서 시크릿을 걸러내지 마라(전체 행 반환). 이유: 노출 정책은 서비스 계층 단일 지점이다(계층 분리 — 리포지토리가 거르면 다른 호출자가 원본을 못 본다).
- 컨트롤러·서비스·게이트를 만들지 마라. 이유: 이 step은 model 계층 전용(실패 원인 격리).
- 계약 스위트 scope 표를 늘리지 마라. 이유: HTTP가 없어 계약 파일이 green이 될 수 없다.
