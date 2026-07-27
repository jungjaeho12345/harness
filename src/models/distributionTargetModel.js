// 배부(distribution) 대상(수신처) 데이터 접근 계층 — 직접 SQL (ORM 없음, ADR-002). 비즈니스 규칙 없음.
// 삭제 함수를 두지 않는다: 대상 제거는 active='N' update(soft delete)가 유일한 경로다 (DB 비파괴).
// 검증(kind enum·spoolDir 슬러그·name 필수)은 서비스 계층 책임이다 (ADR-006).
// spoolDir는 문자열 컬럼일 뿐이다 — 이 계층은 디렉토리를 만들거나 파일을 쓰지 않는다 (ADR-008, 스풀 쓰기는 phase 47).
// id는 INTEGER PRIMARY KEY(ROWID alias)로 자동 증가하므로 insert/update 대상에서 제외한다.

const COLUMNS = ['name', 'kind', 'spoolDir', 'active', 'createdAt', 'updatedAt'];
const FILTERABLE = ['id', ...COLUMNS];

export function createDistributionTargetModel(db) {
  // 화이트리스트 컬럼만 AND 동등 필터로 적용한다 (임의 컬럼명 주입 차단).
  function query(filters = {}) {
    const conds = [];
    const params = [];
    for (const col of FILTERABLE) {
      const v = filters[col];
      if (v === undefined || v === null) continue;
      conds.push(`${col} = ?`);
      params.push(v);
    }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM DistributionTarget${where} ORDER BY id`).all(...params);
  }

  function findById(id) {
    return db.prepare('SELECT * FROM DistributionTarget WHERE id = ?').get(id);
  }

  // present-only INSERT(정의된 컬럼만, undefined 제외 → NULL/DEFAULT 유지). 새 행 id 반환.
  function insert(entry = {}) {
    const cols = COLUMNS.filter((c) => entry[c] !== undefined);
    if (cols.length === 0) throw new Error('distributionTargetModel.insert: 입력할 컬럼이 없습니다');
    const ph = cols.map(() => '?').join(', ');
    return Number(
      db.prepare(`INSERT INTO DistributionTarget (${cols.join(', ')}) VALUES (${ph})`)
        .run(...cols.map((c) => entry[c])).lastInsertRowid,
    );
  }

  // present-only SET — 전달하지 않은 컬럼은 건드리지 않는다. id는 SET 대상이 아니다.
  function update(id, fields = {}) {
    const cols = COLUMNS.filter((c) => fields[c] !== undefined);
    if (cols.length === 0) return 0;
    const set = cols.map((c) => `${c} = ?`).join(', ');
    return db.prepare(`UPDATE DistributionTarget SET ${set} WHERE id = ?`)
      .run(...cols.map((c) => fields[c]), id).changes;
  }

  return { query, findById, insert, update };
}
