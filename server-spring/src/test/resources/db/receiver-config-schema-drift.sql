-- 테스트 전용 드리프트 픽스처(수신 설정 축). 정본은 리포 루트의 `src/db/schema.js`이며 main 소스에는
-- 스키마 정의 SQL이 없다.
--
-- User·Article·Contents·ArticleHistory·DistributionTarget는 정본과 같고 **ReceiverConfig에서 2컬럼만
-- 빠져 있다**(password · apiKey). 결함이 정확히 그 둘뿐이라, 넓어진 부팅 검증이 "무엇이 없는지"를
-- 다른 결함에 가려지지 않은 채(테이블 없음이 아니라 컬럼 단위로) 지목하는지 실증할 수 있다.
--
-- DistributionTarget을 온전히 둔 이유: step2가 요구 목록에 DistributionTarget을 추가한 뒤에도 이 픽스처가
-- "테이블 없음"이 아니라 ReceiverConfig 컬럼 드리프트만 내게 하기 위해서다.
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

-- ReceiverConfig — password·apiKey 두 컬럼이 빠졌다(그 둘이 이 픽스처의 결함이다).
CREATE TABLE IF NOT EXISTS ReceiverConfig (
  id INTEGER PRIMARY KEY,
  sourceId VARCHAR,
  type VARCHAR,
  name VARCHAR,
  host VARCHAR,
  port VARCHAR,
  username VARCHAR,
  apiEndpoint VARCHAR,
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
