-- 테스트 전용 스키마 픽스처. 정본은 리포 루트의 `src/db/schema.js`(Node 서버)이며
-- main 소스(`src/main/java`)에는 스키마 정의 SQL이 한 줄도 없다 — 이 서버는 스키마를 소유하지 않는다.
--
-- 이 파일이 존재하는 이유: Java 단위 테스트는 Node의 createSchema를 호출할 수 없으므로 @TempDir
-- 임시 DB에 같은 모양의 테이블을 세워야 한다. 계약 하네스(scripts/spring-contract.mjs)는 반대로
-- Node의 createSchema로 임시 DATA_DIR을 시드한다. 이 이중 경로가 어긋나면 "Java 테스트는 green인데
-- 계약 실행이 red"가 되므로, 그 조합을 보면 이 픽스처의 드리프트를 가장 먼저 의심하라.
--
-- User 컬럼 10개·DEFAULT 값은 src/db/schema.js 의 SCHEMA.User 와 1:1로 일치해야 한다.
CREATE TABLE IF NOT EXISTS User (
  userId TEXT PRIMARY KEY,
  name TEXT,
  password TEXT,
  role TEXT,
  department TEXT,
  departmentCode TEXT,
  active TEXT DEFAULT 'Y',
  failedLoginCount TEXT DEFAULT '0',
  lockedUntil TEXT,
  lastFailedLoginAt TEXT
);
