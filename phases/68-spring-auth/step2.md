# Step 2: db-access

## 목표
Spring이 `APS_DB_FILE`(하네스가 시드한 임시 SQLite `news.db`)에 접근하는 **영속 계층(repository)**만 만든다. 컨트롤러/HTTP는 이 step에 없다(step3~5 소유). 제공 메서드: 사용자 조회/쓰기, 기사 목록 읽기. **DDL 0 · DELETE/DROP 0 · 리포 news.db 무접촉.**

## 배경 (자기완결)
- 스키마는 **하네스가** `createSchema`(`src/db/schema.js`)로 미리 만든다 — Spring은 스키마를 만들지 않는다(DDL 0). Spring은 이미 존재하는 테이블을 읽고, 계약이 요구하는 최소 쓰기(사용자 생성/수정, 로그인 실패 카운트)만 한다.
- `User` 테이블 실측 컬럼(정본 `src/db/schema.js`): `userId`(TEXT PK), `name`, `password`(bcrypt 해시), `role`, `department`, `departmentCode`, `active`(기본 'Y'), 그리고 **계정잠금 상태 컬럼** `failedLoginCount`(문자열 정수, 기본 '0'), `lockedUntil`(ISO-8601 UTC, 비면 미잠금), `lastFailedLoginAt`(ISO-8601 UTC). 이 컬럼들은 로그인 핸들러 내부 전용이며 응답에 싣지 않는다.
- `Contents`(기사) 테이블: 목록은 전 컬럼에서 **`lockerSessionId`·`lockerClientId` 2개만 제거**해 돌려준다(응답 투영 단일 지점 — ADR-005/porting §4-5).

## 읽어야 할 파일
- `src/db/schema.js` — `User`·`Contents` 컬럼 정본(위 요약의 근거). 특히 계정잠금 3컬럼.
- `src/db/seed.js` — `SAMPLE_USERS`(reporter/desk/admin), bcrypt cost 10 해시 저장. 로그인이 이 해시를 검증한다.
- `spikes/p0-spring/src/main/java/harness/p0_spring/NewsDb.java` — 참고용 read-only 접근 패턴. **고칠 결함**: (a) `D:/`·사본 경로 하드코딩 → `APS_DB_FILE`만 사용, (b) 목록/조회의 IN절 파라미터 상한 없음 → 파라미터 개수 가드. **단 이 step은 auth 슬라이스라 13키 필터 빌더(ArticleQuery)는 이식하지 않는다**(후속 phase). 기사 목록은 최소 SELECT로 충분하다.
- `spikes/p0-spring/pom.xml` — sqlite-jdbc·security-crypto 의존성 좌표.
- `phases/68-spring-auth/step0.md` — 환경변수 계약(`APS_DB_FILE`).
- 이전 step 산출물: `server-spring/`(step0 골격), `scripts/contract-run.mjs --target spring`(step1 — Spring을 `APS_DB_FILE`로 띄운다).

## 작업 (TDD — 테스트 먼저)
1. `pom.xml`에 `org.xerial:sqlite-jdbc`, `org.springframework.security:spring-security-crypto`(bcrypt 검증용) 추가.
2. **테스트 먼저**: `src/test/java/.../NewsDbTest.java` — 테스트가 임시 파일 DB를 만들고 `User`/`Contents` 스키마를 생성·시드한 뒤(테스트 픽스처 SQL은 `src/db/schema.js` 컬럼과 동일하게), repository 메서드를 검증:
   - `findUser("reporter")` → role 'R', active 'Y', password 해시(널 아님) 반환. 없는 userId → null.
   - `insertUser(...)` 후 `findUser` 재조회로 존재 확인.
   - `updateUser(userId, {role:'R'})` → 변경행수 1, 재조회 시 role 'R'. `updateUser`가 미존재 userId → 변경행수 0.
   - `listArticles()`(또는 세션 게이트 통과 후 쓸 최소 목록) 결과 map에 `lockerSessionId`·`lockerClientId` 키가 **없어야** 한다.
3. `NewsDb`(또는 `UserRepository`+`ArticleRepository`) 구현:
   - 데이터소스 URL은 `jdbc:sqlite:<APS_DB_FILE>`. **환경변수 미설정이면 부팅/최초 접근에서 명확히 실패**(하드코딩 폴백 금지).
   - `setReadOnly(true)`로 강제하지 마라 — 이 슬라이스는 사용자 생성/수정·로그인 실패 카운트 **쓰기가 필요**하다. 대신 코드에 DDL/DELETE/DROP 문자열이 **존재하지 않도록** 한다(정적으로 grep 가능).
   - `updateUser(userId, Map<String,String> fields)`: 화이트리스트 컬럼(`role`·`active`·`failedLoginCount`·`lockedUntil`·`lastFailedLoginAt`·`name`·`department`·`departmentCode`)만 `SET`. 컬럼명은 케이스가 아니라 코드 상수에서만 온다(SQL 인젝션 표면 차단). 변경행수 반환.
   - IN절/반복 파라미터를 쓰는 곳이 있으면 파라미터 개수 상한을 둔다(스파이크 결함 교정).
4. 컴포넌트를 스프링 빈으로 등록(생성자 주입 — ADR-006 합성 루트 단일 주입).

## Acceptance Criteria (실행 커맨드)
```bash
# 1) repository 유닛 테스트 green(임시 시드 DB 대상)
mvn -f server-spring/pom.xml -q test
# 2) DDL/파괴 쿼리 부재 정적 잠금 — main 소스에 DDL/DELETE/DROP이 없어야 한다
! grep -rniE "CREATE TABLE|ALTER TABLE|DROP |DELETE FROM|TRUNCATE" server-spring/src/main/java
# 3) 하네스로 Spring을 띄워도(step1) 리포 news.db 무변 + health 유지
node scripts/contract-run.mjs --target spring --profile prod-cookie --boot-check --timeout 60000
# 4) 정적 안전망
npm run lint
```
- 2)의 `!`(부정) grep은 매칭이 없어야 exit 0. `IF NOT EXISTS`가 붙은 additive 문도 이 step에는 두지 마라(스키마는 하네스 소유).

## 검증 절차
- `NewsDbTest`가 시드 계정 3종 조회 + 사용자 insert/update + 기사 목록 투영(locker* 제거)까지 덮는지 확인.
- 데이터소스 URL 문자열에 `APS_DB_FILE` 외 하드코딩 경로가 없는지 확인.
- 3)에서 러너의 데이터 안전 단언이 통과(리포 news.db mtime/size 무변)하는지 stdout으로 확인.

## 금지사항
- `CREATE TABLE`/`ALTER`/`DROP`/`DELETE`/`TRUNCATE`를 Spring 코드에 넣지 마라. 이유: 스키마는 하네스가 소유하고(DDL 0), DB 비파괴는 최상위 규칙이다.
- `APS_DB_FILE` 없이 리포 `news.db`나 스파이크 사본으로 폴백하지 마라. 이유: 프로파일 격리·데이터 안전이 깨진다.
- 13키 기사 필터 빌더(ArticleQuery)를 이식하지 마라. 이유: articles-read 계약은 이 phase 밖(후속). 여기선 최소 목록 SELECT만.
- 사용자 비밀번호/계정잠금 컬럼(`failedLoginCount`·`lockedUntil`·`lastFailedLoginAt`)을 어떤 응답 DTO에도 노출하지 마라. 이유: SAFE_FIELDS 밖 값이다.
