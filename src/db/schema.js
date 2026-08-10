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
    // 계정 잠금(account lockout) 상태 — 로그인 핸들러 내부 전용. SAFE_FIELDS에는 넣지 않는다.
    ['failedLoginCount', "TEXT DEFAULT '0'"], // 연속 로그인 실패 횟수(문자열 정수)
    ['lockedUntil', 'TEXT'], // 잠금 해제 시각(ISO-8601 UTC). 비어 있으면 미잠금
    ['lastFailedLoginAt', 'TEXT'], // 마지막 실패 시각(ISO-8601 UTC)
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
    ['lockerClientId', 'VARCHAR'],
    ['lockedAt', 'VARCHAR'],
    ['coAuthor', 'VARCHAR'],
    ['category', 'VARCHAR'],
    ['region', 'VARCHAR'],
    ['attribute', 'VARCHAR'],
    ['keyword', 'VARCHAR'],
    ['internalComment', 'VARCHAR'],
    ['externalComment', 'VARCHAR'],
    ['attachmentFile', 'VARCHAR'],
    ['referenceFile', 'VARCHAR'],
  ],
  ArticleHistory: [
    ['id', 'INTEGER PRIMARY KEY'],
    ['articleId', 'VARCHAR'],
    ['eventType', 'VARCHAR'],
    ['action', 'VARCHAR'],
    ['fromStatus', 'VARCHAR'],
    ['toStatus', 'VARCHAR'],
    ['actorUserId', 'VARCHAR'],
    ['createdAt', 'VARCHAR'],
    ['markupVersion', 'VARCHAR'], // 편집(edit) 시점 본문 스냅샷 — status 전이는 NULL(본문 불변)
    // 이력 목록 표시용 제목 — 스냅샷 기록 시점에 historyMeta.snapshotTitle(markupVersion)로 파생해 저장한다.
    // 조회가 blob(markupVersion)을 읽지 않게 하는 것이 목적이다. 이전 버전에서 기록된 행은 NULL이고
    // 조회가 그 행에 한해 본문을 함께 읽어 파생한다(백필 없음 — 파생 규칙이 바뀌어도 저장된 행은 옛 규칙 값 유지).
    ['snapshotTitle', 'VARCHAR'],
    // INTEGER인 이유: VARCHAR(TEXT affinity)면 숫자 id가 문자열로 저장되어 DistributionTarget.id와의 매칭이 조용히 깨진다.
    ['targetId', 'INTEGER'], // 배부 실패/재전송 이벤트의 수신처(DistributionTarget.id) — 그 외 이벤트는 NULL
    ['reason', 'VARCHAR'], // 배부 실패 사유 고정 토큰 — 경로·본문·예외 원문 금지
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
  // 배부 대상(수신처) — ADR-008. 삭제 없음(active='N' soft delete).
  DistributionTarget: [
    ['id', 'INTEGER PRIMARY KEY'],
    ['name', 'VARCHAR'],
    ['kind', 'VARCHAR'], // 'press'(언론사) | 'nonpress'(비언론사) — enum 강제는 서비스 계층
    ['spoolDir', 'VARCHAR'], // 배부 스풀 하위 폴더명(슬러그 문자열) — 저장만, 파일 쓰기는 phase 47
    ['active', "VARCHAR DEFAULT 'Y'"],
    ['createdAt', 'VARCHAR'],
    ['updatedAt', 'VARCHAR'],
  ],
  Photo: [
    ['id', 'INTEGER PRIMARY KEY'],
    ['src', 'VARCHAR'],
    ['caption', 'VARCHAR'],
    ['sourceArticleId', 'VARCHAR'],
    ['registeredBy', 'VARCHAR'],
    ['createdAt', 'VARCHAR'],
  ],
};

// 테이블/컬럼을 생성한다. 이미 있으면 누락 컬럼만 additive하게 추가한다.
export function createSchema(db) {
  for (const [table, cols] of Object.entries(SCHEMA)) {
    const defs = cols.map(([name, def]) => `${name} ${def}`).join(', ');
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${defs})`);

    // 비파괴 멱등 마이그레이션: 기존 컬럼은 그대로 두고 누락분만 ADD COLUMN.
    // 대소문자 보정: SQLite 식별자는 대소문자 무시이므로 예전 DB가 'LockYN' 등 다른 표기로
    // 같은 컬럼을 가질 수 있다. 케이스 무시로 비교해 이미 있는 컬럼을 중복 추가(=duplicate column 오류)하지 않는다.
    const existing = new Set(
      db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name.toLowerCase()),
    );
    for (const [name, def] of cols) {
      if (!existing.has(name.toLowerCase())) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
      }
    }
  }
}

// 비어 있는 Contents.department를 작성자(author)와 이름이 일치하는 User의 부서로 보정한다.
// 비파괴: 빈 부서(NULL/'')만 채우고 기존 부서는 덮어쓰지 않으며, 매칭 사용자가 없거나
// 그 사용자의 부서도 비어 있으면 그대로 둔다. 보정한 행 수를 반환한다(멱등 — 재호출 시 0).
export function backfillEmptyDepartments(db) {
  return db.prepare(
    `UPDATE Contents
        SET department = (SELECT u.department FROM User u WHERE u.name = Contents.author),
            departmentCode = (SELECT u.departmentCode FROM User u WHERE u.name = Contents.author)
      WHERE (department IS NULL OR department = '')
        AND EXISTS (
          SELECT 1 FROM User u
           WHERE u.name = Contents.author
             AND u.department IS NOT NULL AND u.department != ''
        )`,
  ).run().changes;
}
