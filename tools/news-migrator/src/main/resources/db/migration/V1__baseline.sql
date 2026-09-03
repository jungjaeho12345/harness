-- MySQL 8.0 기반선 — SQLite 정본(src/db/schema.js)의 번역이다. 새 결정이 아니다.
--
-- 이 파일이 MySQL 측 스키마의 정본이고(ADR-016 ③), SQLite 측 정본은 여전히 src/db/schema.js 다.
-- 두 정본의 동형성은 사람 눈이 아니라 기계가 대조한다(BaselineMatchesCanonicalSchemaTest —
-- 컬럼 이름·선언 순서·타입·기본값을 규칙으로 계산해 비교하므로, 정본에 컬럼이 늘면 여기가 red 다).
--
-- 타입 매핑 규칙은 넷뿐이다(근거는 docs/db-mysql-mapping.md 축 7·8 의 실측 오류코드다):
--   1. 텍스트 PK          → VARCHAR(768) NOT NULL PRIMARY KEY
--        LONGTEXT 는 PK 가 될 수 없고(1170), VARCHAR(769) 는 키 상한 3072바이트를 넘어 거부된다(1071).
--        즉 768 은 계산이 아니라 실측된 상한이다.
--   2. INTEGER PRIMARY KEY → BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY
--   3. targetId INTEGER    → BIGINT
--   4. 그 밖의 모든 텍스트 → LONGTEXT
--        Article.markupVersion 이 165,802바이트라 VARCHAR 는 원천 불가하고(1406),
--        Contents 29컬럼을 VARCHAR(768) 로 두면 행 크기 상한을 넘어 테이블이 만들어지지 않는다(1118).
--
-- 문자셋·collation: utf8mb4 / utf8mb4_0900_bin.
--   step1 이 세 후보를 나란히 재서 고른 값이다. utf8mb4_bin 은 PAD SPACE 라 'x' 와 'x ' 를 같다고 보아
--   인증 축이 무너지고, utf8mb4_0900_ai_ci 는 대소문자·전각·자모 조합을 같다고 본다. utf8mb4_0900_bin
--   만이 = 6쌍과 40표본 정렬에서 SQLite BINARY 와 완전히 일치했다. 대신 LIKE 대소문자를 포기했고
--   그 사실은 divergence 로 기록돼 있다(같은 문서 §7 · 방어선은 Java 차등 테스트다).
--
-- 기본값은 식 형태로 옮긴다: LONGTEXT 는 리터럴 기본값을 가질 수 없고(1101) 8.0.13+ 의 식 형태는 된다.
--   버리지 않은 이유는 실측이다 — 이 리포의 삽입문은 전부 동적 컬럼 목록이라 값이 없는 컬럼은 문장에서
--   빠지고, 정본에서는 그 자리가 채워진다. 버리면 MySQL 에서만 NULL 이 되어 이관이 동작을 바꾼다.
--
-- 이름 표기: 정본 표기(User · ArticleHistory)를 그대로 쓴다. 서버 설정이 lower_case_table_names=1 이라
--   카탈로그에는 소문자로 남지만(step1 축 10 실측) 컬럼 이름의 표기는 보존되므로 응답 키 집합(=계약)은
--   이관으로 바뀌지 않는다. SchemaGuard 의 대소문자 무시 비교도 그대로 성립한다.
--
-- 보조 인덱스와 외래 관계는 만들지 않는다 — 정본이 PK 자동 인덱스만 쓴다(src/db/schema.js 3행).
--   성능 축은 이 phase 의 범위가 아니다(P3).

CREATE TABLE IF NOT EXISTS User (
  userId VARCHAR(768) NOT NULL PRIMARY KEY,
  name LONGTEXT,
  password LONGTEXT,
  role LONGTEXT,
  department LONGTEXT,
  departmentCode LONGTEXT,
  active LONGTEXT DEFAULT ('Y'),
  failedLoginCount LONGTEXT DEFAULT ('0'),
  lockedUntil LONGTEXT,
  lastFailedLoginAt LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS Article (
  articleId VARCHAR(768) NOT NULL PRIMARY KEY,
  title LONGTEXT,
  content LONGTEXT,
  markupVersion LONGTEXT,
  modifier LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS Contents (
  articleId VARCHAR(768) NOT NULL PRIMARY KEY,
  title LONGTEXT,
  content LONGTEXT,
  author LONGTEXT,
  modifier LONGTEXT,
  sender LONGTEXT,
  department LONGTEXT,
  departmentCode LONGTEXT,
  createdAt LONGTEXT,
  editedAt LONGTEXT,
  sentAt LONGTEXT,
  distributedAt LONGTEXT,
  embargoAt LONGTEXT,
  secondEmbargoAt LONGTEXT,
  status LONGTEXT,
  lockYN LONGTEXT DEFAULT ('N'),
  lockerUserId LONGTEXT,
  lockerSessionId LONGTEXT,
  lockerClientId LONGTEXT,
  lockedAt LONGTEXT,
  coAuthor LONGTEXT,
  category LONGTEXT,
  region LONGTEXT,
  attribute LONGTEXT,
  keyword LONGTEXT,
  internalComment LONGTEXT,
  externalComment LONGTEXT,
  attachmentFile LONGTEXT,
  referenceFile LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS ArticleHistory (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  articleId LONGTEXT,
  eventType LONGTEXT,
  action LONGTEXT,
  fromStatus LONGTEXT,
  toStatus LONGTEXT,
  actorUserId LONGTEXT,
  createdAt LONGTEXT,
  markupVersion LONGTEXT,
  snapshotTitle LONGTEXT,
  targetId BIGINT,
  reason LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS ReceiverConfig (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sourceId LONGTEXT,
  type LONGTEXT,
  name LONGTEXT,
  host LONGTEXT,
  port LONGTEXT,
  username LONGTEXT,
  password LONGTEXT,
  apiEndpoint LONGTEXT,
  apiKey LONGTEXT,
  active LONGTEXT DEFAULT ('Y'),
  createdAt LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS DistributionTarget (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name LONGTEXT,
  kind LONGTEXT,
  spoolDir LONGTEXT,
  active LONGTEXT DEFAULT ('Y'),
  createdAt LONGTEXT,
  updatedAt LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS Photo (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  src LONGTEXT,
  caption LONGTEXT,
  sourceArticleId LONGTEXT,
  registeredBy LONGTEXT,
  createdAt LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
