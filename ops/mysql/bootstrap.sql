-- =====================================================================
-- 기사 작성기 — MySQL 부트스트랩 (phase 75 / P2 DB 이관 · step0)
--
-- 무엇인가:  root 권한이 필요한 작업을 **사용자가 직접 1회 실행**하는 템플릿이다.
--            자동화(에이전트)는 root로 접속하지 않는다 — root 비밀번호를 알지 못하고,
--            추측 시도는 max_connect_errors 에 걸려 호스트가 차단된다.
--
-- 어떻게 쓰는가:  이 파일을 **직접 실행하지 마라.** 사본을 만들어 값을 채운 뒤 실행한다.
--            자세한 절차는 `docs/ops-mysql.md` 를 보라.
--
--              copy ops\mysql\bootstrap.sql ops\mysql\bootstrap.local.sql
--              (사본에서 __CHANGE_ME_* 3곳을 실제 비밀번호로 바꾼다)
--              mysql -u root -p < ops\mysql\bootstrap.local.sql
--
--            `ops/mysql/*.local.sql` 은 .gitignore 가 막는다 — 이 정본에는
--            **실제 비밀번호가 한 글자도 들어가지 않는다**(SecretHygieneTest 가 단언한다).
--
-- 멱등:      전 문장이 재실행 안전하다. `CREATE ... IF NOT EXISTS` 만 쓰고
--            `ALTER USER ... IDENTIFIED BY` 는 **일부러 넣지 않았다**(재실행이 비밀번호를
--            덮어써 이미 배포된 설정을 깨기 때문이다). 두 번 실행해도 안전하다 —
--            §6 이 그것을 실제로 요구한다.
--
-- 비파괴:    이 파일에는 DROP·TRUNCATE·REVOKE 가 없다. 뉴스 데이터가 있는 테이블을
--            만들지도 지우지도 않는다(스키마 정본은 마이그레이터의 Flyway 다).
-- =====================================================================


-- ---------------------------------------------------------------------
-- §1. 데이터베이스
--
-- collation:  `utf8mb4_0900_bin` 은 **step1 이 실측으로 확정할 때까지의 유력 후보**다.
--             후보 3종은 `utf8mb4_0900_bin`(NO PAD · BINARY 계열) ·
--             `utf8mb4_bin`(PAD SPACE — 후행 공백을 무시할 위험) ·
--             `utf8mb4_0900_ai_ci`(8.0 기본 · 대소문자/악센트 무시)이고,
--             `WHERE userId = ?` 가 대소문자·후행 공백을 무시하면 **다른 계정으로 로그인**할 수
--             있으므로 이 축은 보안 축이다.
--             ⚠ 확정값이 다르면 **root 재실행이 필요 없다** — `news_migrator` 가 `news`.* 와
--             `news_stage`.* 에 ALTER 를 가지므로 아래 한 줄로 바꿀 수 있다:
--                 ALTER DATABASE news CHARACTER SET utf8mb4 COLLATE <확정값>;
--             (DB 기본 collation 은 이후 CREATE TABLE 의 기본값일 뿐이고, 테이블·컬럼
--              collation 은 Flyway 마이그레이션이 명시적으로 정한다.)
--
-- 이름:      `news` 는 운영 DB(실제 컷오버는 P3 다 — 이 phase 는 만들기만 한다),
--            `news_stage` 는 이관 리허설·왕복 대조 전용 스테이징이다(step3·step4 의 대상).
--            하네스가 쓰고 지우는 `harness_ct_*` 접두사를 **쓰지 않는다** — 그 공간은
--            실행 중에 사라질 수 있어 리허설 산출물을 둘 수 없다.
-- ---------------------------------------------------------------------

CREATE DATABASE IF NOT EXISTS `news`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE DATABASE IF NOT EXISTS `news_stage`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;


-- ---------------------------------------------------------------------
-- §2. 계정 3종
--
-- 셋으로 나눈 이유는 **최소 권한이 DB 비파괴의 1차 방어선**이기 때문이다.
-- 정적 스캔·코드 리뷰는 뚫린 전례가 있고(phase 71a~74: 스캔이 전부 green 인 채로 우회됐다),
-- 그때 마지막으로 남는 방어선이 "DB 서버 자신이 거부한다" 이다.
--
--   news_app       — Spring 런타임.   읽기·삽입·갱신만. DELETE 는 ReceiverConfig 1개 테이블 예외.
--   news_migrator  — 마이그레이터.    스키마 생성·행 적재. DELETE·DROP 없음.
--   news_ct        — 계약 하네스.     `harness_ct_%` 임시 DB 밖에는 권한이 0.
--
-- 접속은 전부 localhost 한정이다(개발 머신 단일 인스턴스 — 원격 접속 계정을 만들지 않는다).
-- 인증 플러그인은 8.0 기본(`caching_sha2_password`)을 그대로 쓴다. JDBC 로 붙을 때
-- TLS 를 쓰지 않으면 `allowPublicKeyRetrieval=true` 가 필요하다 — docs/ops-mysql.md 참조.
-- ---------------------------------------------------------------------

CREATE USER IF NOT EXISTS 'news_app'@'localhost'      IDENTIFIED BY '__CHANGE_ME_APP__';
CREATE USER IF NOT EXISTS 'news_migrator'@'localhost' IDENTIFIED BY '__CHANGE_ME_MIGRATOR__';
CREATE USER IF NOT EXISTS 'news_ct'@'localhost'       IDENTIFIED BY '__CHANGE_ME_CT__';


-- ---------------------------------------------------------------------
-- §3. news_app — 서버 런타임 계정
--
-- SELECT/INSERT/UPDATE 만 준다. DROP·ALTER·CREATE·(테이블 전반의)DELETE 는 **주지 않는다**.
-- 비활성화는 언제나 soft delete(`active='N'` UPDATE)이고, 그 규율을 코드가 아니라
-- DB 서버가 강제하게 만드는 것이 이 설계의 핵심이다.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON `news`.*       TO 'news_app'@'localhost';
GRANT SELECT, INSERT, UPDATE ON `news_stage`.* TO 'news_app'@'localhost';


-- ---------------------------------------------------------------------
-- §4. news_migrator — 마이그레이터·스키마 계정
--
-- CREATE 가 필요한 이유: MySQL 스키마의 정본이 이 모듈의 Flyway 마이그레이션이고
-- (`server-spring` 은 DDL 0 을 유지한다 — NoSchemaSqlInMainSourcesTest 가 main 소스·리소스에서
--  `flyway` 철자 자체를 금지한다), Flyway 는 이력 테이블 `flyway_schema_history` 를 만든다.
-- UPDATE 가 필요한 이유: Flyway 가 이력 행의 성공 플래그를 갱신한다.
--
-- **DELETE·DROP·TRUNCATE 는 주지 않는다.** 이것이 `Flyway.clean()`(스키마 전 객체 DROP)에 대한
-- 두 번째 방어선이다 — 코드의 `cleanDisabled(true)` 와 정적 스캔이 뚫려도 서버가 거부한다.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES ON `news`.*       TO 'news_migrator'@'localhost';
GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES ON `news_stage`.* TO 'news_migrator'@'localhost';


-- ---------------------------------------------------------------------
-- §5. news_ct — 계약 하네스 전용 계정
--
-- 하네스는 패스마다 `harness_ct_<16진수 16자리>` 임시 DB 를 만들고 쓰고 지운다.
-- 백틱 안의 `\_` 는 **와일드카드가 아닌 literal underscore** 로 고정한다(이스케이프하지 않으면
-- `_` 가 "임의의 1문자"라 `newsXct...` 같은 이름까지 매칭된다).
-- 이 계정은 `news`·`news_stage` 에 **어떤 권한도 없다** — 폭발 반경이 임시 DB 로 닫힌다.
-- ---------------------------------------------------------------------

GRANT ALL PRIVILEGES ON `harness\_ct\_%`.* TO 'news_ct'@'localhost';


-- ---------------------------------------------------------------------
-- §6. ReceiverConfig 삭제 예외 — 검증용 프로브 DB
--
-- 배경: `ReceiverConfigRepository.remove()` 는 `DELETE FROM ReceiverConfig WHERE id = ?` 를
-- **실제로 실행**하고 계약이 그 응답을 `200 {ok:true,changes:1}` 로 동결한다(phase 70 이
-- "행 삭제가 허용된 유일 테이블"로 확정). 그래서 news_app 에는 그 테이블 하나에만 DELETE 를 준다.
--
-- ⚠ 왜 프로브 DB 가 따로 필요한가:
--    MySQL 의 **테이블 단위 GRANT 는 대상 테이블이 존재해야 한다**(없으면 ERROR 1146).
--    그런데 이 부트스트랩이 도는 시점에는 `news`·`news_stage` 가 **빈 스키마**다(테이블은
--    step3 에서 마이그레이터의 Flyway 가 만든다). 그렇다고 여기서 진짜 테이블을 미리 만들면
--    Flyway 가 소유해야 할 스키마를 침범하고, 나중에 지우려면 DROP 이 필요해진다(비파괴 위반).
--    ⇒ 뉴스 데이터와 무관한 **전용 프로브 DB** 를 하나 두고 거기서 "예외 1건 허용 · 나머지 거부"를
--      **같은 DB·같은 자격**으로 실증한다(다른 DB 에서 거부를 보면 권한이 0 이라 공허한 green 이다).
--      이 DB 에는 뉴스 데이터가 절대 들어가지 않고 마이그레이터도 서버도 여기에 붙지 않는다.
-- ---------------------------------------------------------------------

CREATE DATABASE IF NOT EXISTS `news_grant_probe`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- 권한 판정에만 쓰는 껍데기 2개(뉴스 스키마가 아니다 — 컬럼 이름이 그 사실을 말한다).
CREATE TABLE IF NOT EXISTS `news_grant_probe`.`ReceiverConfig` (
  `probe_only` INT NOT NULL AUTO_INCREMENT PRIMARY KEY
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `news_grant_probe`.`Contents` (
  `probe_only` INT NOT NULL AUTO_INCREMENT PRIMARY KEY
) ENGINE=InnoDB;

GRANT SELECT, INSERT, UPDATE ON `news_grant_probe`.*                 TO 'news_app'@'localhost';
GRANT DELETE                  ON `news_grant_probe`.`ReceiverConfig` TO 'news_app'@'localhost';


-- ---------------------------------------------------------------------
-- §7. ReceiverConfig 삭제 예외 — 실제 대상(news · news_stage)
--
-- ⚠ **이 §7 은 스키마가 만들어진 뒤에만 성공한다.** 빈 DB 에서 처음 실행하면 아래 첫 문장이
--    `ERROR 1146 (42S02): Table 'news.receiverconfig' doesn't exist` 로 멈춘다 —
--    그것은 **정상이고 예상된 결과**다. §1~§6 은 이미 전부 적용된 상태다.
--
--    할 일: step3 이 스키마를 만든 뒤 **이 파일을 그대로 한 번 더 실행**하면 된다(전 문장이
--    멱등이므로 §1~§6 은 조용히 통과하고 §7 만 새로 붙는다). 절차는 docs/ops-mysql.md §7.
--
--    (`lower_case_table_names=1` 이라 테이블 이름은 소문자로 저장·비교된다. 아래 표기는
--     Spring/Node 의 SQL 표기를 따라 원래 대소문자로 적는다 — 서버가 알아서 접는다.)
-- ---------------------------------------------------------------------

GRANT DELETE ON `news`.`ReceiverConfig`       TO 'news_app'@'localhost';
GRANT DELETE ON `news_stage`.`ReceiverConfig` TO 'news_app'@'localhost';
