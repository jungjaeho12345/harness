// DB 스키마 — node:sqlite(DatabaseSync) 직접 SQL. (ADR-002)
// 비파괴 멱등 마이그레이션만 허용: CREATE TABLE IF NOT EXISTS + additive ALTER ADD COLUMN.
// 절대 DROP/DELETE 하지 않는다. PK 자동 인덱스만 사용(보조 인덱스/FK 미선언).

// 각 테이블의 단일 진실 공급원 — [컬럼명, 정의]의 순서 있는 목록.
// 첫 컬럼이 PK다. User는 TEXT, Article/Contents/ReceiverConfig는 VARCHAR.
const SCHEMA = {
  User: [
    ['userId', 'TEXT PRIMARY KEY'],
    ['name', 'TEXT'],
    ['password', 'TEXT'],
    ['role', 'TEXT'],
    ['department', 'TEXT'],
    ['departmentCode', 'TEXT'],
    ['active', "TEXT DEFAULT 'Y'"],
    // 계정 잠금(account-lockout) — Contents의 편집잠금(lockYN)과 무관한 별도 개념.
    // 연속 실패 횟수(증가·비교는 Number 파싱 후 String 재저장)와 자동해제 시각(ISO-8601 UTC).
    ['failedLoginCount', "TEXT DEFAULT '0'"],
    ['lockedUntil', 'TEXT'],
  ],
  Article: [
    ['articleId', 'VARCHAR PRIMARY KEY'],
    ['title', 'VARCHAR'],
    ['content', 'VARCHAR'],
    ['markupVersion', 'VARCHAR'],
    ['modifier', 'VARCHAR'],
  ],
  Contents: [
    ['articleId', 'VARCHAR PRIMARY KEY'],
    ['title', 'VARCHAR'],
    ['content', 'VARCHAR'],
    ['author', 'VARCHAR'],
    ['modifier', 'VARCHAR'],
    ['sender', 'VARCHAR'],
    ['department', 'VARCHAR'],
    ['departmentCode', 'VARCHAR'],
    ['createdAt', 'VARCHAR'],
    ['editedAt', 'VARCHAR'],
    ['sentAt', 'VARCHAR'],
    ['distributedAt', 'VARCHAR'],
    ['embargoAt', 'VARCHAR'],
    ['secondEmbargoAt', 'VARCHAR'],
    ['status', 'VARCHAR'],
    ['lockYN', "VARCHAR DEFAULT 'N'"],
    ['lockerUserId', 'VARCHAR'],
    ['lockerSessionId', 'VARCHAR'],
    ['lockedAt', 'VARCHAR'],
    ['coAuthor', 'VARCHAR'],
    ['region', 'VARCHAR'],
    ['attribute', 'VARCHAR'],
    ['keyword', 'VARCHAR'],
    ['internalComment', 'VARCHAR'],
    ['externalComment', 'VARCHAR'],
    ['attachmentFile', 'VARCHAR'],
    ['referenceFile', 'VARCHAR'],
  ],
  ReceiverConfig: [
    ['id', 'INTEGER PRIMARY KEY'],
    ['sourceId', 'VARCHAR'],
    ['type', 'VARCHAR'],
    ['name', 'VARCHAR'],
    ['host', 'VARCHAR'],
    ['port', 'VARCHAR'],
    ['username', 'VARCHAR'],
    ['password', 'VARCHAR'],
    ['apiEndpoint', 'VARCHAR'],
    ['apiKey', 'VARCHAR'],
    ['active', "VARCHAR DEFAULT 'Y'"],
    ['createdAt', 'VARCHAR'],
  ],
};

// 테이블/컬럼을 생성한다. 이미 있으면 누락 컬럼만 additive하게 추가한다.
export function createSchema(db) {
  for (const [table, cols] of Object.entries(SCHEMA)) {
    const defs = cols.map(([name, def]) => `${name} ${def}`).join(', ');
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${defs})`);

    // 비파괴 멱등 마이그레이션: 기존 컬럼은 그대로 두고 누락분만 ADD COLUMN.
    const existing = new Set(
      db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name),
    );
    for (const [name, def] of cols) {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
      }
    }
  }
}
