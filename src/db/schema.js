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
    // 조회가 blob(markupVersion)을 읽지 않게 하는 것이 목적이다. 표시제목이 비어 있는(NULL) 스냅샷 행은
    // 부트 시 멱등 백필(backfillHistoryTitles)이 빈 컬럼만 채운다(컬럼 도입 이전 행 + 비문자열 본문 edge 행).
    // 이미 저장된 값은 재파생·덮어쓰지 않는다 — 파생 규칙이 바뀌어도 저장된 행은 옛 규칙 값 유지(phase 58 결정).
    // 조회의 행 단위 폴백은 그대로 남는다.
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

// 한 번에 읽는 백필 배치 크기 — 레거시 blob(markupVersion)을 통째로 JS 힙에 올리지 않기 위한 상한.
export const HISTORY_TITLE_BACKFILL_BATCH = 500;

// ArticleHistory의 빈 표시제목(snapshotTitle)을 그 행의 본문(markupVersion)에서 파생해 채운다.
// deriveTitle: (markupVersion) => string — 파생 규칙의 단일 출처(services/historyMeta.snapshotTitle)를
//   주입받는다. src/db는 services를 import하지 않는다(ADR-006) — 결선은 부트(합성 루트) 책임이다.
//   파생 규칙을 이 파일에 복제하지 마라(기록 경로와 백필 경로가 다른 제목을 내면 그 자체가 버그다).
// 대상: snapshotTitle IS NULL AND length(markupVersion) > 0 — 조회 술어(querySnapshotTitlesByArticle)와
//   동형이고, phase 58의 기록 게이트(typeof === 'string')보다 넓다: 비문자열 본문이 TEXT affinity로
//   저장된 행도 대상이다(DB에서 읽으면 문자열로 돌아와 파생이 정상 동작한다 — gap 봉합).
// 파생 결과가 ''여도 ''를 저장한다(NULL 유지 금지 — 매 부트 재스캔되는 영구 미완 백필이 된다).
//   파생값이 문자열이 아닌 행만 건너뛴다(NULL 유지 — 그 행의 표시는 조회 폴백이 정확히 처리한다).
// id 오름차순 커서 + 고정 배치 + 배치당 트랜잭션 — 커서는 건너뛴 행을 포함해 전진하므로
//   무한 루프가 불가능하고, blob 전량이 한 번에 힙에 올라오지 않는다.
// 실패 정책 = 전파(부팅 중단): 같은 부트 블록의 createSchema·backfillEmptyDepartments가 모두
//   try/catch 없이 전파한다 — DB가 이 UPDATE를 받지 못하는 상태면 그 DB로 요청을 받는 것 자체가
//   위험하고, 조용한 삼킴은 "개선이 안 됐는데 안 된 줄 모르는" 상태를 만든다. 배치당 커밋이므로
//   중간 실패에도 이전 배치의 진행은 보존되고, 멱등이므로 원인 해소 후 재기동이 이어서 완결한다.
// 채운 행 수를 반환한다(멱등 — 재호출 시 채운 행 수 0·저장된 값 불변).
export function backfillHistoryTitles(db, { deriveTitle } = {}) {
  if (typeof deriveTitle !== 'function') {
    throw new TypeError('backfillHistoryTitles: deriveTitle 함수 주입이 필요합니다 (조용한 no-op 금지)');
  }
  const select = db.prepare(
    `SELECT id, markupVersion FROM ArticleHistory
      WHERE snapshotTitle IS NULL AND length(markupVersion) > 0 AND id > ?
      ORDER BY id LIMIT ?`,
  );
  // UPDATE에도 IS NULL 술어를 남긴다 — SELECT 술어와 이중 방어(기존 값 무덮기).
  const update = db.prepare(
    'UPDATE ArticleHistory SET snapshotTitle = ? WHERE id = ? AND snapshotTitle IS NULL',
  );
  let filled = 0;
  let lastId = 0;
  for (;;) {
    const batch = select.all(lastId, HISTORY_TITLE_BACKFILL_BATCH);
    if (batch.length === 0) break;
    db.exec('BEGIN');
    try {
      for (const row of batch) {
        lastId = row.id; // 건너뛴 행 포함 전진 — 다음 배치가 같은 행을 다시 집지 않는다.
        const derived = deriveTitle(row.markupVersion);
        if (typeof derived !== 'string') continue; // 비문자열은 저장하면 표시 계약이 오염된다.
        filled += update.run(derived, row.id).changes;
      }
      db.exec('COMMIT');
    } catch (e) {
      // 원인 예외 보존 — SQLITE_FULL 등은 자동 롤백 후 명시 ROLLBACK이 'no transaction is active'로
      // 던진다. 그 2차 증상이 원인을 교체하면 부팅 실패 원인이 오보가 된다(phase 64 step4 C-1).
      try { db.exec('ROLLBACK'); } catch { /* 원인 예외 보존 — 롤백 실패는 원인에 종속된 2차 증상이다 */ }
      throw e;
    }
  }
  return filled;
}
