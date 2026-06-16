// 이력 데이터 접근 계층 — 직접 SQL (ORM 없음, ADR-002). 비즈니스 규칙 없음 (ADR-006).
// ArticleHistory는 append-only: INSERT/SELECT만 둔다. DELETE/UPDATE 코드는 두지 않는다.

const HISTORY_COLS = [
  'articleId', 'eventType', 'actorUserId', 'actorRole',
  'fromStatus', 'toStatus', 'title', 'createdAt',
];

function insertInto(dbHandle, table, cols, obj) {
  const present = cols.filter((c) => obj[c] !== undefined);
  if (present.length === 0) throw new Error(`${table}: 입력할 컬럼이 없습니다`);
  const ph = present.map(() => '?').join(', ');
  return dbHandle.prepare(`INSERT INTO ${table} (${present.join(', ')}) VALUES (${ph})`)
    .run(...present.map((c) => obj[c]));
}

export function createArticleHistoryModel(db) {
  // 주어진 db 핸들로 INSERT만 수행한다 — 자체 트랜잭션을 열지 않는다.
  // step 2에서 기사 저장 트랜잭션 안에서 호출해 원자성을 보장하기 위함(중첩 tx 방지).
  function recordWithDb(dbHandle, entry) {
    return insertInto(dbHandle, 'ArticleHistory', HISTORY_COLS, entry).lastInsertRowid;
  }

  function record(entry) {
    return recordWithDb(db, entry);
  }

  function findByArticleId(articleId) {
    return db.prepare(
      'SELECT * FROM ArticleHistory WHERE articleId = ? ORDER BY createdAt ASC',
    ).all(articleId);
  }

  function findSendByArticleId(articleId) {
    return db.prepare(
      "SELECT * FROM ArticleHistory WHERE articleId = ? AND eventType = 'send' ORDER BY createdAt ASC",
    ).all(articleId);
  }

  return { record, recordWithDb, findByArticleId, findSendByArticleId };
}
