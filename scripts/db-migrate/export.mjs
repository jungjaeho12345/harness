// 엔진 중립 JSONL export (phase 75-p2 step3)
//
// 소스 SQLite를 { readOnly: true }로 읽어 테이블당 1개의 JSONL(<TableName>.jsonl)로 새 출력
// 디렉토리에만 쓴다. 이것이 §7 P2 게이트의 '역방향(참조용 export) 경로 확보'이며, 어떤 미래
// 대상 엔진의 적재 도구든 읽을 수 있는 결정적 데이터 산출물이다(decisions (6)).
//
// DB 비파괴(지배 규칙 · decisions (2)): 소스는 { readOnly: true }로만 열고 SELECT만 실행하며
// 어떤 경로에서도 소스에 쓰지 않는다. 출력은 항상 새(비어 있는) 디렉토리에만 쓴다 — 비어 있지
// 않으면 거부한다(기존 산출물과 조용한 혼합 방지).
//
// 값 정규화는 canonical.mjs 한 곳만 쓴다(복제 금지 — inventory·verify가 같은 오라클을 써야
// export→재매니페스트가 inventory 매니페스트와 aggregateDigest가 동일하다 = 라운드트립 잠금).
// 테이블·컬럼 순서·PK·typeClass는 schema-spec에서 얻는다(재선언 금지).
//
// CLI:
//   node scripts/db-migrate/export.mjs <sourcePath> <outDir>

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import {
  mkdirSync, readdirSync, existsSync, writeFileSync, readFileSync,
} from 'node:fs';
import { buildCanonicalSchema } from './schema-spec.mjs';
import { canonicalizeValue, rowChecksum } from './canonical.mjs';

const EXPORT_MANIFEST_VERSION = 1;

// PK 정규형 비교자: INTEGER PK는 BigInt 수치 비교, TEXT PK는 코드포인트 비교.
// inventory.mjs와 동일한 순서 규율(decisions (5)) — 이 순서로 JSONL을 쓰므로 export→재매니페스트가
// inventory 매니페스트와 같은 aggregateDigest를 낸다. 순서가 갈리면 라운드트립 잠금 테스트가 red다.
function comparePk(pkTypeClass, a, b) {
  if (pkTypeClass === 'integer') {
    let ba;
    let bb;
    try { ba = BigInt(a); } catch { ba = null; }
    try { bb = BigInt(b); } catch { bb = null; }
    if (ba !== null && bb !== null) {
      if (ba < bb) return -1;
      if (ba > bb) return 1;
      return 0;
    }
  }
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i += 1) {
    const da = ca[i].codePointAt(0);
    const db = cb[i].codePointAt(0);
    if (da !== db) return da - db;
  }
  return ca.length - cb.length;
}

// outDir이 이미 존재하고 비어 있지 않으면 throw(덮어쓰기/혼합 방지). 없으면 만든다.
function ensureEmptyOutDir(outDir) {
  if (existsSync(outDir)) {
    const entries = readdirSync(outDir);
    if (entries.length > 0) {
      throw new Error(
        `출력 디렉토리가 비어 있지 않습니다(non-empty outDir) — 조용한 혼합 방지: ${outDir}`,
      );
    }
    return;
  }
  mkdirSync(outDir, { recursive: true });
}

// 소스(읽기 전용)를 엔진 중립 JSONL로 outDir에 쓴다. 테이블당 <TableName>.jsonl.
// 각 줄: JSON.stringify({ <col>: <정규형 문자열>, ... }) — 키 순서는 schema-spec 컬럼 순서.
// 행 순서는 PK 정규형 오름차순(결정적 · 두 번 export하면 byte-identical).
export function exportToNeutral(sourcePath, outDir) {
  const schema = buildCanonicalSchema();
  ensureEmptyOutDir(outDir);

  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const tables = [];
    for (const table of schema.tables) {
      const columnsInOrder = table.columns.map((c) => ({ name: c.name, typeClass: c.typeClass }));
      const pkName = table.primaryKey;
      const pkTypeClass = table.columns.find((c) => c.name === pkName).typeClass;

      const rows = db.prepare(`SELECT * FROM ${table.name}`).all();

      // 각 행을 정규형 객체로 만들고 PK 정규형을 부기한다.
      const records = rows.map((row) => {
        const obj = {};
        for (const col of columnsInOrder) {
          obj[col.name] = canonicalizeValue(col.typeClass, row[col.name]);
        }
        return { pk: canonicalizeValue(pkTypeClass, row[pkName]), obj };
      });
      // PK 정규형 오름차순 — inventory와 같은 순서(순서 비의존 판정 · 결정적 바이트).
      records.sort((x, y) => comparePk(pkTypeClass, x.pk, y.pk));

      const lines = records.map((r) => JSON.stringify(r.obj));
      const text = lines.length > 0 ? `${lines.join('\n')}\n` : '';
      writeFileSync(join(outDir, `${table.name}.jsonl`), text, 'utf8');

      tables.push({ name: table.name, rowCount: records.length });
    }
    return { tables };
  } finally {
    db.close();
  }
}

// export된 JSONL 디렉토리에서 inventory와 동형의 매니페스트를 파생(라운드트립 검증용).
// 값은 이미 정규형이지만 rowChecksum이 canonicalizeValue를 다시 통과시켜도 멱등이다
// (integer는 BigInt 재파싱 동일 · text는 String 동일 · NULL_TOKEN은 그대로).
// 행 순서가 이미 PK 오름차순으로 쓰였으므로 파일 순서대로 접으면 buildInventory와 동일한
// aggregateDigest가 나온다(라운드트립 잠금 · decisions (6)).
export function manifestFromExport(outDir) {
  const schema = buildCanonicalSchema();
  const tables = {};
  for (const table of schema.tables) {
    const columnsInOrder = table.columns.map((c) => ({ name: c.name, typeClass: c.typeClass }));
    const file = join(outDir, `${table.name}.jsonl`);
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const lines = raw.length === 0 ? [] : raw.replace(/\n$/, '').split('\n').filter((l) => l !== '');

    const agg = createHash('sha256');
    for (const line of lines) {
      const row = JSON.parse(line);
      agg.update(rowChecksum(columnsInOrder, row), 'utf8');
    }

    tables[table.name] = {
      rowCount: lines.length,
      aggregateDigest: agg.digest('hex'),
    };
  }
  return { version: EXPORT_MANIFEST_VERSION, tables };
}

// --- CLI (직접 인자 파싱 · 새 의존성 0) ---
function main(argv) {
  const [source, outDir] = argv;
  if (!source || !outDir) {
    process.stderr.write('usage: node scripts/db-migrate/export.mjs <sourcePath> <outDir>\n');
    process.exit(1);
  }
  const result = exportToNeutral(source, resolve(outDir));
  const total = result.tables.reduce((n, t) => n + t.rowCount, 0);
  process.stdout.write(`[export] wrote ${result.tables.length} JSONL files (${total} rows) to ${outDir}\n`);
}

// CLI 진입점(직접 실행 시에만). import 시에는 부작용 없음.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
