// 기사 이력 데이터 접근 계층 — 직접 SQL (ORM 없음, ADR-002). 비즈니스 규칙 없음.
// ArticleHistory는 편집/생애주기 전이 이벤트 로그(append-only).
// 행 삭제 코드는 두지 않는다 (DB 비파괴). 분기/도메인 규칙은 서비스 책임.

// id는 자동 증가이므로 INSERT에서 제외한다.
const HISTORY_COLS = [
  'articleId', 'eventType', 'action', 'fromStatus', 'toStatus', 'actorUserId', 'createdAt',
  'markupVersion',
  'targetId', 'reason', // 배부 실패/재전송 이벤트 전용 — 그 외 이벤트는 NULL
];

// 배부 이벤트 조회 기본 창 — 보조 인덱스 없이 id DESC 스캔 + LIMIT(비용 인식, SCHEMA.md).
const DISTRIBUTION_EVENTS_DEFAULT_LIMIT = 500;

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
  // 본문 스냅샷(markupVersion)은 SELECT하지 않고 존재 여부(hasSnapshot)만 파생한다 —
  // /history는 이력보기/송고이력보기 모달도 쓰는 경량 목록. 본문은 querySnapshotById로만.
  function queryByArticle(articleId) {
    return db.prepare(
      `SELECT id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt,
              CASE WHEN markupVersion IS NOT NULL AND markupVersion != '' THEN 1 ELSE 0 END AS hasSnapshot
         FROM ArticleHistory WHERE articleId = ? ORDER BY id DESC`,
    ).all(articleId);
  }

  // 단건 스냅샷 조회 — 본문(markupVersion) 포함. 반드시 articleId로 스코프한다
  // (다른 기사의 스냅샷이 id만으로 새지 않게). 없으면 undefined.
  function querySnapshotById(articleId, id) {
    return db.prepare(
      `SELECT id, articleId, eventType, action, actorUserId, createdAt, markupVersion
         FROM ArticleHistory WHERE id = ? AND articleId = ?`,
    ).get(id, articleId);
  }

  // 스냅샷 보유 이력의 본문만 별도 조회 — 이력 목록의 '제목' 파생(서비스)용.
  // queryByArticle은 경량 계약(blob 미포함)을 유지해야 하고, 그 결과는 배부 멱등 판정도 공유하므로
  // blob 로딩을 그 경로에 끼워 넣지 않는다. 필터는 hasSnapshot 판정과 동형(IS NOT NULL AND != '').
  function querySnapshotsByArticle(articleId) {
    return db.prepare(
      `SELECT id, markupVersion FROM ArticleHistory
        WHERE articleId = ? AND markupVersion IS NOT NULL AND markupVersion != ''
        ORDER BY id DESC`,
    ).all(articleId);
  }

  // 배부 실패/재전송 이벤트만 읽는다 — 실패 목록(Z 전용)과 재전송 대상 확인의 유일한 조회 경로.
  // queryByArticle에 targetId/reason을 싣지 않는 이유: 그 응답은 전 사용자에게 열린 이력보기 계약이다.
  // eventType 어휘 단일 출처: src/services/distributionFailureLog.js (모델은 도메인 비의존 — 문자열만 둔다).
  function queryDistributionEvents({ articleId, limit } = {}) {
    const max = Number.isInteger(limit) && limit >= 1 ? limit : DISTRIBUTION_EVENTS_DEFAULT_LIMIT;
    const where = ['eventType IN (?, ?)'];
    const params = ['distribute-failed', 'distribute-retry'];
    if (articleId !== undefined) {
      where.push('articleId = ?');
      params.push(articleId);
    }
    return db.prepare(
      `SELECT id, articleId, eventType, action, targetId, reason, actorUserId, createdAt
         FROM ArticleHistory WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
    ).all(...params, max);
  }

  return { insert, queryByArticle, querySnapshotById, querySnapshotsByArticle, queryDistributionEvents };
}
