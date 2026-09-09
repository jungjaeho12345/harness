// 운영 규모 점검의 순수 판정부 (phase 76 step8 작업 B).
//
// 무엇을 위한 코드인가: 리포 표본(178행)과 운영 데이터는 다르고, **다르면 컷오버 전에 알아야 하는** 축이 다섯이다
// (step8.md B): ① VARCHAR(768) 를 넘는 텍스트 PK(있으면 이관 자체가 **1406** 으로 실패한다) ② markupVersion 의
// 최대 **바이트**(max_allowed_packet 대비) ③ 4바이트 이모지·짝 없는 서로게이트 ④ NULL 과 빈 문자열의 분포
// ⑤ 정본 밖 테이블·컬럼(수기 ALTER 흔적). 이 파일에는 **판정만** 있고 파일·DB 접근은 호출자(scripts/db-scale-probe.mjs)의 몫이다.
//
// 상한 수치를 손으로 베끼지 않는다 — 상한은 마이그레이터 기반선(V1__baseline.sql)에서 읽고, 그 기반선은
// BaselineMatchesCanonicalSchemaTest 가 정본(src/db/schema.js)과 기계로 맞춘다. 잠금은
// scripts/lib/dbScaleProbe.self-test.mjs 가 한다.

/** 텍스트 PK 의 글자 상한 — 기반선 `VARCHAR(768)` 과 같아야 한다(파싱 결과와 교차 확인한다). */
export const TEXT_PK_LIMIT = 768;

/** 서버 설정값(2026-09-04 실측 · docs/ops-mysql.md). LONGTEXT 한 값이 이보다 크면 전송 단계에서 끊긴다. */
export const MAX_ALLOWED_PACKET = 67108864;

/** SQLite 가 스스로 만드는 내부 테이블 — 정본 밖이지만 사람이 만든 흔적이 아니다. */
const SQLITE_INTERNAL = /^sqlite_/i;

const TABLE_HEAD = /^CREATE TABLE IF NOT EXISTS\s+(\S+)\s*\($/i;
const VARCHAR_LIMIT = /^VARCHAR\((\d+)\)$/i;

/**
 * 기반선 SQL 에서 테이블·컬럼·`VARCHAR(n)` 상한·PK 여부를 읽는다.
 *
 * 파서가 단순해도 되는 이유는 기반선이 단순하기 때문이다(`CREATE TABLE IF NOT EXISTS` 일곱 개 · 제약은 컬럼
 * 줄 안에만 · 보조 인덱스 0). 형식이 바뀌면 여기서 **테이블 0개**가 나오고 호출자가 그것을 실패로 본다 —
 * 조용히 "정본 밖 테이블 없음"이 되지 않는다.
 */
export function parseBaselineTables(sqlText) {
  const tables = [];
  let current = null;
  for (const raw of String(sqlText ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!current) {
      const head = TABLE_HEAD.exec(line);
      if (head) current = { name: head[1], columns: [] };
      continue;
    }
    if (line.startsWith(')')) { tables.push(current); current = null; continue; }
    if (line.startsWith('--') || line === '') continue;
    const body = line.replace(/,$/, '');
    const [name, ...rest] = body.split(/\s+/);
    const type = rest[0] ?? '';
    const limit = VARCHAR_LIMIT.exec(type);
    current.columns.push({
      name,
      type,
      maxChars: limit ? Number(limit[1]) : null,
      primaryKey: /PRIMARY KEY/i.test(body),
    });
  }
  return tables;
}

/**
 * 문자열 한 값의 크기 — **글자(코드포인트) 수와 UTF-8 바이트 수를 따로** 낸다.
 *
 * 왜 둘 다인가: VARCHAR(768) 의 상한은 **글자**이고 `max_allowed_packet` 은 **바이트**다. 하나로 뭉치면
 * 한글 55,268자가 165,802바이트라는 사실이 보이지 않는다(baseline 함정 (i)).
 *
 * `loneSurrogates` 는 짝을 이루지 못한 UTF-16 서로게이트다 — 그 값은 유효한 UTF-8 로 옮길 수 없어
 * 이관 경로에서 치환되거나 거부된다. astral(4바이트 이모지)과 **다른 문제**라 따로 센다.
 */
export function stringStats(value) {
  const text = String(value ?? '');
  let chars = 0;
  let astral = 0;
  let loneSurrogates = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    chars += 1;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { astral += 1; i += 1; continue; }
      loneSurrogates += 1;
    }
    else if (code >= 0xdc00 && code <= 0xdfff) {
      loneSurrogates += 1;
    }
  }
  return { chars, bytes: Buffer.byteLength(text, 'utf8'), astral, loneSurrogates };
}

/**
 * 컬럼 하나의 분포. **NULL 과 빈 문자열을 구분**한다 — 둘을 합치면 두 방언이 갈리는 축 하나가 사라진다
 * (`docs/db-mysql-mapping.md` §7-1 「NULL vs 빈 문자열」).
 *
 * 상한 초과 판정은 `>` 다: 768자는 통과이고 769자부터 초과다(그 경계가 곧 MySQL 1406 의 경계다).
 */
export function summariseColumn(values, { maxChars = null } = {}) {
  const summary = {
    total: 0, nulls: 0, empties: 0, maxChars: 0, maxBytes: 0,
    overlong: 0, astralRows: 0, loneSurrogateRows: 0,
  };
  for (const value of values ?? []) {
    summary.total += 1;
    if (value === null || value === undefined) { summary.nulls += 1; continue; }
    const stats = stringStats(value);
    if (stats.chars === 0) summary.empties += 1;
    if (stats.chars > summary.maxChars) summary.maxChars = stats.chars;
    if (stats.bytes > summary.maxBytes) summary.maxBytes = stats.bytes;
    if (maxChars !== null && stats.chars > maxChars) summary.overlong += 1;
    if (stats.astral > 0) summary.astralRows += 1;
    if (stats.loneSurrogates > 0) summary.loneSurrogateRows += 1;
  }
  return summary;
}

/**
 * 두 요약을 합친다 — **운영 규모는 한 번에 읽을 수 없다**(호출자는 덩어리로 읽어 합친다).
 * 합계는 더하고 최댓값은 큰 쪽을 남긴다. 이 함수가 틀리면 큰 DB 에서만 수치가 조용히 작아진다.
 */
export function mergeSummaries(a, b) {
  return {
    total: a.total + b.total,
    nulls: a.nulls + b.nulls,
    empties: a.empties + b.empties,
    maxChars: Math.max(a.maxChars, b.maxChars),
    maxBytes: Math.max(a.maxBytes, b.maxBytes),
    overlong: a.overlong + b.overlong,
    astralRows: a.astralRows + b.astralRows,
    loneSurrogateRows: a.loneSurrogateRows + b.loneSurrogateRows,
  };
}

/**
 * 정본 밖 이름(테이블·컬럼). 대소문자는 무시하고(SQLite 식별자는 대소문자를 구분하지 않는다) SQLite 내부
 * 테이블은 뺀다. 순서는 입력 순서를 지킨다 — 사람이 읽을 목록이다.
 */
export function unknownNames(actual, canonical) {
  const known = new Set((canonical ?? []).map((name) => String(name).toLowerCase()));
  return (actual ?? []).filter((name) => {
    const lowered = String(name).toLowerCase();
    return !known.has(lowered) && !SQLITE_INTERNAL.test(lowered);
  });
}
