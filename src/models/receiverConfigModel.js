// 수집(자동기사) 수신 설정 데이터 접근 계층 — 직접 SQL (ORM 없음, ADR-002).
// id는 INTEGER PRIMARY KEY(ROWID alias)로 자동 증가하므로 insert에서 제외한다.

const COLUMNS = [
  'sourceId', 'type', 'name', 'host', 'port', 'username',
  'password', 'apiEndpoint', 'apiKey', 'active', 'createdAt',
];
const FILTERABLE = ['id', ...COLUMNS];

export function createReceiverConfigModel(db) {
  // 화이트리스트 컬럼만 AND 동등 필터로 적용한다.
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
    return db.prepare(`SELECT * FROM ReceiverConfig${where} ORDER BY id`).all(...params);
  }

  function insert(entry) {
    const cols = COLUMNS.filter((c) => entry[c] !== undefined);
    if (cols.length === 0) throw new Error('receiverConfigModel.insert: 입력할 컬럼이 없습니다');
    const ph = cols.map(() => '?').join(', ');
    return db.prepare(`INSERT INTO ReceiverConfig (${cols.join(', ')}) VALUES (${ph})`)
      .run(...cols.map((c) => entry[c])).lastInsertRowid;
  }

  // 설정 행만 삭제 — 이미 수집된 Article/Contents는 절대 건드리지 않는다 (DB 비파괴).
  function remove(id) {
    return db.prepare('DELETE FROM ReceiverConfig WHERE id = ?').run(id).changes;
  }

  return { query, insert, remove };
}
