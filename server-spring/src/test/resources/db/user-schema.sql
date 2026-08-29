-- 테스트 전용 스키마 픽스처. 정본은 리포 루트의 `src/db/schema.js`(Node 서버)이며
-- main 소스(`src/main/java`)에는 스키마 정의 SQL이 한 줄도 없다 — 이 서버는 스키마를 소유하지 않는다.
--
-- 이 파일이 존재하는 이유: Java 단위 테스트는 Node의 createSchema를 호출할 수 없으므로 @TempDir
-- 임시 DB에 같은 모양의 테이블을 세워야 한다. 계약 하네스(scripts/spring-contract.mjs)는 반대로
-- Node의 createSchema로 임시 DATA_DIR을 시드한다. 이 이중 경로가 어긋나면 "Java 테스트는 green인데
-- 계약 실행이 red"가 되므로, 그 조합을 보면 이 픽스처의 드리프트를 가장 먼저 의심하라.
--
-- 이 파일은 **정본 픽스처**다(TempNewsDb.CANONICAL_FIXTURE). 부팅 스키마 검증(SchemaGuard)은
-- RequiredSchema.TABLES의 전 테이블을 보므로, 요구 목록이 넓어지면 이 픽스처로 시드된 전 기동
-- 테스트(@SpringBootTest)가 컨텍스트 로딩에서 함께 죽는다. 그래서 요구 목록 확장과 이 파일의
-- 확장은 항상 같은 step에서 한다(phase 69 forward_notes (9)).
--
-- 컬럼 이름·타입 표기·순서·DEFAULT 값은 src/db/schema.js 의 SCHEMA 와 1:1로 일치해야 한다
-- (정렬·affinity가 계약에 영향을 준다).

-- User 10컬럼.
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

-- Article 5컬럼 — 본문 마크업. Contents와 articleId로 1:1이다.
CREATE TABLE IF NOT EXISTS Article (
  articleId VARCHAR PRIMARY KEY,
  title VARCHAR,
  content VARCHAR,
  markupVersion VARCHAR,
  modifier VARCHAR
);

-- Contents 29컬럼 — 공통정보·생애주기·편집 잠금. 응답 투영은 여기서 2컬럼을 뺀 27키다.
CREATE TABLE IF NOT EXISTS Contents (
  articleId VARCHAR PRIMARY KEY,
  title VARCHAR,
  content VARCHAR,
  author VARCHAR,
  modifier VARCHAR,
  sender VARCHAR,
  department VARCHAR,
  departmentCode VARCHAR,
  createdAt VARCHAR,
  editedAt VARCHAR,
  sentAt VARCHAR,
  distributedAt VARCHAR,
  embargoAt VARCHAR,
  secondEmbargoAt VARCHAR,
  status VARCHAR,
  lockYN VARCHAR DEFAULT 'N',
  lockerUserId VARCHAR,
  lockerSessionId VARCHAR,
  lockerClientId VARCHAR,
  lockedAt VARCHAR,
  coAuthor VARCHAR,
  category VARCHAR,
  region VARCHAR,
  attribute VARCHAR,
  keyword VARCHAR,
  internalComment VARCHAR,
  externalComment VARCHAR,
  attachmentFile VARCHAR,
  referenceFile VARCHAR
);

-- ArticleHistory 12컬럼 — append-only 원장(갱신·삭제 없음). id·targetId만 INTEGER다.
CREATE TABLE IF NOT EXISTS ArticleHistory (
  id INTEGER PRIMARY KEY,
  articleId VARCHAR,
  eventType VARCHAR,
  action VARCHAR,
  fromStatus VARCHAR,
  toStatus VARCHAR,
  actorUserId VARCHAR,
  createdAt VARCHAR,
  markupVersion VARCHAR,
  snapshotTitle VARCHAR,
  targetId INTEGER,
  reason VARCHAR
);

-- ReceiverConfig 12컬럼 — 수집 수신 설정. id만 INTEGER, 나머지는 VARCHAR. active는 DEFAULT 'Y'.
-- password(FTP)·apiKey(API)는 쓰기 전용 시크릿이라 스키마에는 있지만 서비스 투영에는 없다.
CREATE TABLE IF NOT EXISTS ReceiverConfig (
  id INTEGER PRIMARY KEY,
  sourceId VARCHAR,
  type VARCHAR,
  name VARCHAR,
  host VARCHAR,
  port VARCHAR,
  username VARCHAR,
  password VARCHAR,
  apiEndpoint VARCHAR,
  apiKey VARCHAR,
  active VARCHAR DEFAULT 'Y',
  createdAt VARCHAR
);

-- DistributionTarget 7컬럼 — 배부 대상(수신처). id만 INTEGER, 나머지는 VARCHAR. active는 DEFAULT 'Y'.
-- 삭제 없음(active='N' soft delete). kind enum·spoolDir 슬러그 검증은 서비스 계층.
CREATE TABLE IF NOT EXISTS DistributionTarget (
  id INTEGER PRIMARY KEY,
  name VARCHAR,
  kind VARCHAR,
  spoolDir VARCHAR,
  active VARCHAR DEFAULT 'Y',
  createdAt VARCHAR,
  updatedAt VARCHAR
);

-- Photo 6컬럼 — 사진DB. append-only(등록·검색만, 수정·삭제 없음). id만 INTEGER, 나머지는 VARCHAR.
-- `src`는 /uploads 상대경로 또는 https:// URL만(sanitizeFileRef), `registeredBy`는 세션 stamp다.
CREATE TABLE IF NOT EXISTS Photo (
  id INTEGER PRIMARY KEY,
  src VARCHAR,
  caption VARCHAR,
  sourceArticleId VARCHAR,
  registeredBy VARCHAR,
  createdAt VARCHAR
);
