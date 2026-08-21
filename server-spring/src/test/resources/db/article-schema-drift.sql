-- 테스트 전용 드리프트 픽스처(기사 축). 정본은 리포 루트의 `src/db/schema.js`이며 main 소스에는
-- 스키마 정의 SQL이 없다.
--
-- User·Article·ArticleHistory는 정본과 같고 **Contents에서 2컬럼만 빠져 있다**
-- (secondEmbargoAt · lockerSessionId). 즉 이 DB의 결함은 정확히 그 둘뿐이라, 부팅 스키마 검증이
-- "무엇이 없는지" 지목하는지를 다른 결함에 가려지지 않은 채 실증할 수 있다.
--
-- 왜 이 축을 따로 두는가: db/user-schema-drift.sql은 요구 목록이 넓어진 뒤로 기사 3테이블이 통째로
-- 없는 DB가 되어(테이블 없음) **컬럼 단위** 검증을 실증하지 못한다. lockerSessionId가 없는 DB로 뜨면
-- 재로그인 takeover 판정이 런타임에 조용히 깨진다 — 부팅에서 잡혀야 한다.
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
  status VARCHAR,
  lockYN VARCHAR DEFAULT 'N',
  lockerUserId VARCHAR,
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
