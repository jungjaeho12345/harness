// 기사 이력 데이터 접근 계층 — 직접 SQL (ORM 없음, ADR-002). 비즈니스 규칙 없음.
// ArticleHistory는 편집/생애주기 전이 이벤트 로그(append-only).
// 행 삭제 코드는 두지 않는다 (DB 비파괴). 분기/도메인 규칙은 서비스 책임.

// id는 자동 증가이므로 INSERT에서 제외한다.
const HISTORY_COLS = [
  'articleId', 'eventType', 'action', 'fromStatus', 'toStatus', 'actorUserId', 'createdAt',
];

function insertInto(db, table, cols, obj) {
  const present = cols.filter((c) => obj[c] !== undefined);
  if (present.length === 0) throw new Error(`${table}: 입력할 컬럼이 없습니다`);
  const ph = present.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${table} (${present.join(', ')}) VALUES (${ph})`)
    .run(...present.map((c) => obj[c]));
}

export function createArticleHistoryModel(db) {
  // 이력 1행 적재. 정의되지 않은 키는 컬럼에서 제외(undefined는 제외 → NULL 유지).
  function insert(record = {}) {
    insertInto(db, 'ArticleHistory', HISTORY_COLS, record);
  }

  // 해당 기사의 이력을 최신순(id DESC)으로 반환한다 — 목록은 최근 이벤트가 위에 오도록.
  function queryByArticle(articleId) {
    return db.prepare('SELECT * FROM ArticleHistory WHERE articleId = ? ORDER BY id DESC')
      .all(articleId);
  }

  return { insert, queryByArticle };
}
