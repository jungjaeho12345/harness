// 사진DB 데이터 접근 계층 — 직접 SQL (ORM 없음, ADR-002). 비즈니스 규칙 없음.
// Photo는 append-only(등록) + 캡션 검색(read)만 — 행 삭제/수정 코드는 두지 않는다 (DB 비파괴).
// id는 INTEGER PRIMARY KEY(ROWID alias)로 자동 증가하므로 insert에서 제외한다.

const PHOTO_COLS = ['src', 'caption', 'sourceArticleId', 'registeredBy', 'createdAt'];

export function createPhotoModel(db) {
  // 사진 1행 적재 — present-only INSERT(정의된 컬럼만, undefined 제외 → NULL 유지). 새 행 id 반환.
  function insert(record = {}) {
    const cols = PHOTO_COLS.filter((c) => record[c] !== undefined);
    if (cols.length === 0) throw new Error('photoModel.insert: 입력할 컬럼이 없습니다');
    const ph = cols.map(() => '?').join(', ');
    return Number(
      db.prepare(`INSERT INTO Photo (${cols.join(', ')}) VALUES (${ph})`)
        .run(...cols.map((c) => record[c])).lastInsertRowid,
    );
  }

  // 캡션 부분일치(LIKE) 검색 — 최신 등록이 위에 오도록 id DESC.
  function searchByCaption(q) {
    return db.prepare('SELECT * FROM Photo WHERE caption LIKE ? ORDER BY id DESC').all(`%${q}%`);
  }

  return { insert, searchByCaption };
}
