// 기사 아이디 생성 — SQLite Store Procedure 명세.
// 규칙: 'AKR' + YYYYMMDD + 난수 9자리. 이미 존재하면 난수를 다시 생성한다.

// Article·Contents 양쪽에서 유일한 기사 아이디를 생성한다.
export function generateArticleId(db) {
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const exists = db.prepare(
    'SELECT 1 FROM Article WHERE articleId = ? UNION ALL SELECT 1 FROM Contents WHERE articleId = ? LIMIT 1',
  );
  let id;
  do {
    const rand = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    id = `AKR${yyyymmdd}${rand}`;
  } while (exists.get(id, id));
  return id;
}
