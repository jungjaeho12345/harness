// 기사 데이터 접근 계층 — 직접 SQL (ORM 없음, ADR-002). 비즈니스 규칙 없음.
// Article(본문 마크업)과 Contents(공통정보·생애주기·잠금)는 articleId로 1:1.
// 두 테이블을 함께 변경할 때는 하나의 트랜잭션으로 처리한다.
// 행 삭제 코드는 두지 않는다 (DB 비파괴 — 삭제는 status 전이로 서비스가 처리).

const ARTICLE_COLS = ['articleId', 'title', 'content', 'markupVersion', 'modifier'];
const CONTENTS_COLS = [
  'articleId', 'title', 'content', 'author', 'modifier', 'sender',
  'department', 'departmentCode', 'createdAt', 'editedAt', 'sentAt',
  'distributedAt', 'embargoAt', 'secondEmbargoAt', 'status',
  'lockYN', 'lockerUserId', 'lockerSessionId', 'lockedAt',
  'coAuthor', 'region', 'attribute', 'keyword',
  'internalComment', 'externalComment', 'attachmentFile', 'referenceFile',
];

function insertInto(db, table, cols, obj) {
  const present = cols.filter((c) => obj[c] !== undefined);
  if (present.length === 0) throw new Error(`${table}: 입력할 컬럼이 없습니다`);
  const ph = present.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${table} (${present.join(', ')}) VALUES (${ph})`)
    .run(...present.map((c) => obj[c]));
}

function updateSet(db, table, cols, pk, id, obj) {
  const present = cols.filter((c) => c !== pk && obj[c] !== undefined);
  if (present.length === 0) return 0;
  const set = present.map((c) => `${c} = ?`).join(', ');
  return db.prepare(`UPDATE ${table} SET ${set} WHERE ${pk} = ?`)
    .run(...present.map((c) => obj[c]), id).changes;
}

// Article+Contents 동시 변경의 원자성을 보장한다 — 실패 시 전체 롤백.
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function createArticleModel(db) {
  // Article·Contents 각각 조회해 { article, contents }로 반환한다 (둘 다 없으면 null).
  function getById(articleId) {
    const article = db.prepare('SELECT * FROM Article WHERE articleId = ?').get(articleId);
    const contents = db.prepare('SELECT * FROM Contents WHERE articleId = ?').get(articleId);
    if (!article && !contents) return null;
    return { article, contents };
  }

  function insert({ article, contents } = {}) {
    tx(db, () => {
      if (article) insertInto(db, 'Article', ARTICLE_COLS, article);
      if (contents) insertInto(db, 'Contents', CONTENTS_COLS, contents);
    });
    return (article && article.articleId) || (contents && contents.articleId);
  }

  function update(articleId, { article, contents } = {}) {
    return tx(db, () => {
      let changes = 0;
      if (article) changes += updateSet(db, 'Article', ARTICLE_COLS, 'articleId', articleId, article);
      if (contents) changes += updateSet(db, 'Contents', CONTENTS_COLS, 'articleId', articleId, contents);
      return changes;
    });
  }

  // Contents 조회 — 작성/송고/배부 시간 범위, 작성자/송고자/articleId/status,
  // 부서 다중 선택(department/departments), 특정 status 제외(excludeStatus)를 지원한다.
  function query(filters = {}) {
    const {
      articleId, author, sender, status,
      department, departments, excludeStatus,
      createdAtFrom, createdAtTo,
      sentAtFrom, sentAtTo,
      distributedAtFrom, distributedAtTo,
    } = filters;

    const conds = [];
    const params = [];

    for (const [col, v] of [['articleId', articleId], ['author', author], ['sender', sender]]) {
      if (v !== undefined && v !== null) {
        conds.push(`${col} = ?`);
        params.push(v);
      }
    }

    // status 포함 — 문자열 또는 배열(IN)
    if (status !== undefined && status !== null) {
      const arr = Array.isArray(status) ? status : [status];
      if (arr.length) {
        conds.push(`status IN (${arr.map(() => '?').join(', ')})`);
        params.push(...arr);
      }
    }

    // status 제외 — 문자열 또는 배열(NOT IN)
    if (excludeStatus !== undefined && excludeStatus !== null) {
      const arr = Array.isArray(excludeStatus) ? excludeStatus : [excludeStatus];
      if (arr.length) {
        conds.push(`status NOT IN (${arr.map(() => '?').join(', ')})`);
        params.push(...arr);
      }
    }

    // 부서 다중 선택 — departments 배열 우선, 없으면 department 단일
    let deptList = [];
    if (departments !== undefined && departments !== null) {
      deptList = Array.isArray(departments) ? departments : [departments];
    } else if (department !== undefined && department !== null) {
      deptList = [department];
    }
    if (deptList.length) {
      conds.push(`department IN (${deptList.map(() => '?').join(', ')})`);
      params.push(...deptList);
    }

    // 시간 범위 — ISO-8601 UTC 문자열은 사전식 비교로 범위가 성립한다.
    for (const [col, from, to] of [
      ['createdAt', createdAtFrom, createdAtTo],
      ['sentAt', sentAtFrom, sentAtTo],
      ['distributedAt', distributedAtFrom, distributedAtTo],
    ]) {
      if (from !== undefined && from !== null) {
        conds.push(`${col} >= ?`);
        params.push(from);
      }
      if (to !== undefined && to !== null) {
        conds.push(`${col} <= ?`);
        params.push(to);
      }
    }

    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM Contents${where} ORDER BY createdAt DESC`).all(...params);
  }

  // 제목/본문 검색 — 본문은 Article.markupVersion(블록 JSON)에 저장된다.
  function searchByText(q) {
    const like = `%${q}%`;
    return db.prepare(
      'SELECT * FROM Article WHERE title LIKE ? OR content LIKE ? OR markupVersion LIKE ?',
    ).all(like, like, like);
  }

  function setLock(articleId, { lockerUserId, lockerSessionId, lockedAt } = {}) {
    return db.prepare(
      "UPDATE Contents SET lockYN = 'Y', lockerUserId = ?, lockerSessionId = ?, lockedAt = ? WHERE articleId = ?",
    ).run(lockerUserId ?? null, lockerSessionId ?? null, lockedAt ?? null, articleId).changes;
  }

  function clearLock(articleId) {
    return db.prepare(
      "UPDATE Contents SET lockYN = 'N', lockerUserId = NULL, lockerSessionId = NULL, lockedAt = NULL WHERE articleId = ?",
    ).run(articleId).changes;
  }

  return { getById, insert, update, query, searchByText, setLock, clearLock };
}
