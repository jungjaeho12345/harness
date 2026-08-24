-- 테스트 전용 드리프트 픽스처(배부 대상 축). 정본은 리포 루트의 `src/db/schema.js`이며 main 소스에는
-- 스키마 정의 SQL이 없다.
--
-- User·Article·Contents·ArticleHistory·ReceiverConfig는 정본과 같고 **DistributionTarget에서 2컬럼만
-- 빠져 있다**(spoolDir · updatedAt). 결함이 정확히 그 둘뿐이라, 부팅 검증이 "무엇이 없는지"를 다른
-- 결함에 가려지지 않은 채 지목하는지 실증할 수 있다.
--
-- 왜 이 축을 따로 두는가: spoolDir 컬럼이 없는 DB로 뜨면 배부 대상 저장이 런타임에 조용히 깨진다 —
-- 부팅에서 잡혀야 한다.
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
  snapshotTitle VARCHAR,
  targetId INTEGER,
  reason VARCHAR
);

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

-- spoolDir·updatedAt 2컬럼이 빠진 DistributionTarget(부팅 검증이 지목해야 하는 컬럼 단위 결함).
CREATE TABLE IF NOT EXISTS DistributionTarget (
  id INTEGER PRIMARY KEY,
  name VARCHAR,
  kind VARCHAR,
  active VARCHAR DEFAULT 'Y',
  createdAt VARCHAR
);
