-- 테스트 전용 드리프트 픽스처(이력 축). 정본은 리포 루트의 `src/db/schema.js`이며 main 소스에는
-- 스키마 정의 SQL이 없다.
--
-- User·Article·Contents는 정본과 같고 **ArticleHistory에서 2컬럼만 빠져 있다**
-- (snapshotTitle · targetId). 결함이 정확히 그 둘뿐이라, 넓어진 부팅 검증이 "무엇이 없는지"를
-- 다른 결함에 가려지지 않은 채 지목하는지 실증할 수 있다.
--
-- 왜 이 축을 따로 두는가: snapshotTitle이 없는 DB로 뜨면 이력 표시 제목이 런타임에 조용히 깨지고,
-- targetId가 없으면 배부 이벤트 기록이 통째로 실패한다 — 부팅에서 잡혀야 한다.
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

CREATE TABLE IF NOT EXISTS Article (
  articleId VARCHAR PRIMARY KEY,
  title VARCHAR,
  content VARCHAR,
  markupVersion VARCHAR,
  modifier VARCHAR
);

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
  reason VARCHAR
);

-- ReceiverConfig·DistributionTarget는 정본과 같다(이 픽스처의 결함은 ArticleHistory 2컬럼뿐이라
-- 컬럼 단위 지목이 '테이블 없음'에 가려지지 않는다).
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
