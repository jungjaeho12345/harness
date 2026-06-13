// 사용자 데이터 접근 계층 — 직접 SQL (ORM 없음, ADR-002). 비즈니스 규칙 없음.
// 삭제 함수는 두지 않는다: 비활성화는 active='N' 업데이트로 처리한다 (DB 비파괴).
// query는 비밀번호를 포함한 raw row를 반환한다 — 응답 정제는 서비스 계층 책임.

const COLUMNS = ['userId', 'name', 'password', 'role', 'department', 'departmentCode', 'active'];

export function createUserModel(db) {
  function findById(userId) {
    return db.prepare('SELECT * FROM User WHERE userId = ?').get(userId);
  }

  // 화이트리스트 컬럼만 AND 동등 필터로 적용한다 (임의 컬럼명 주입 차단).
  function query(filters = {}) {
    const conds = [];
    const params = [];
    for (const col of COLUMNS) {
      const v = filters[col];
      if (v === undefined || v === null) continue;
      conds.push(`${col} = ?`);
      params.push(v);
    }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM User${where}`).all(...params);
  }

  function insert(user) {
    const cols = COLUMNS.filter((c) => user[c] !== undefined);
    if (cols.length === 0) throw new Error('userModel.insert: 입력할 컬럼이 없습니다');
    const placeholders = cols.map(() => '?').join(', ');
    db.prepare(`INSERT INTO User (${cols.join(', ')}) VALUES (${placeholders})`)
      .run(...cols.map((c) => user[c]));
    return user.userId;
  }

  function update(userId, fields = {}) {
    const cols = COLUMNS.filter((c) => c !== 'userId' && fields[c] !== undefined);
    if (cols.length === 0) return 0;
    const set = cols.map((c) => `${c} = ?`).join(', ');
    return db.prepare(`UPDATE User SET ${set} WHERE userId = ?`)
      .run(...cols.map((c) => fields[c]), userId).changes;
  }

  return { findById, query, insert, update };
}
