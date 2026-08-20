-- 테스트 전용 드리프트 픽스처. 정본은 리포 루트의 `src/db/schema.js`이며 main 소스에는
-- 스키마 정의 SQL이 없다.
--
-- 잠금 컬럼 2개(lockedUntil·lastFailedLoginAt)가 빠진 "옛 스키마" DB를 흉내낸다.
-- 부팅 스키마 검증이 이런 DB를 거부하고 무엇이 없는지 지목하는지를 실증하는 데만 쓴다
-- (거부하지 못하면 계정 잠금이 런타임에 조용히 깨진다).
CREATE TABLE IF NOT EXISTS User (
  userId TEXT PRIMARY KEY,
  name TEXT,
  password TEXT,
  role TEXT,
  department TEXT,
  departmentCode TEXT,
  active TEXT DEFAULT 'Y',
  failedLoginCount TEXT DEFAULT '0'
);
