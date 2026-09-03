// 읽기 전용 소스 인벤토리 (phase 75-p2 step1)
//
// 소스 SQLite를 { readOnly: true }로 열어 테이블별 행 수 + PK 정렬 행별 체크섬 매니페스트를 낸다.
// 이 매니페스트가 P2 '전 행 대조'의 오라클이다(step4 verify가 두 매니페스트를 대조한다).
//
// DB 비파괴(지배 규칙 · decisions (2)): 소스는 { readOnly: true }로만 열고 SELECT/PRAGMA만 실행하며
// 어떤 경로에서도 소스에 쓰지 않는다. 테이블·컬럼·PK·typeClass는 schema-spec에서 얻는다(재선언 금지).
// 값 정규화는 canonical.mjs 한 곳만 쓴다(복제 금지 — export·verify가 같은 오라클을 써야 한다).
//
// CLI:
//   node scripts/db-migrate/inventory.mjs <sourcePath> [--detailed] [--out <파일>]

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildCanonicalSchema } from './schema-spec.mjs';
import { canonicalizeValue, rowChecksum } from './canonical.mjs';
import { comparePk } from './pk-order.mjs';

const INVENTORY_VERSION = 1;

// PK 정규형 비교자는 pk-order.mjs 한 곳만 쓴다(export.mjs와 동일 순서 — 라운드트립 잠금 · decisions (5)).

// 소스 SQLite(읽기 전용)에서 매니페스트를 만든다.
// detailed=false: 테이블별 { rowCount, aggregateDigest }
// detailed=true : 위 + { rows: { <pk정규형>: <rowChecksum> } }
export function buildInventory(sourcePath, { detailed = false } = {}) {
  const schema = buildCanonicalSchema();
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  const warnings = [];
  try {
    const tables = {};
    for (const table of schema.tables) {
      const columnsInOrder = table.columns.map((c) => ({ name: c.name, typeClass: c.typeClass }));
      const pkName = table.primaryKey;
      const pkTypeClass = table.columns.find((c) => c.name === pkName).typeClass;

      // COUNT(*)와 실제 순회 행 수를 교차검증(둘이 다르면 커서/필터 버그 신호 — 던진다).
      const counted = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table.name}`).get().n);
      const rows = db.prepare(`SELECT * FROM ${table.name}`).all();
      if (rows.length !== counted) {
        throw new Error(
          `${table.name}: rowCount 교차검증 실패 (COUNT=${counted} · 순회=${rows.length})`,
        );
      }

      const entries = rows.map((row) => ({
        pk: canonicalizeValue(pkTypeClass, row[pkName], warnings),
        checksum: rowChecksum(columnsInOrder, row, warnings),
      }));
      // PK 정규형 오름차순 — 순서 비의존 판정의 근거.
      entries.sort((x, y) => comparePk(pkTypeClass, x.pk, y.pk));

      const agg = createHash('sha256');
      for (const e of entries) agg.update(e.checksum, 'utf8');

      const manifest = {
        rowCount: entries.length,
        aggregateDigest: agg.digest('hex'),
      };
      if (detailed) {
        const rowsMap = {};
        for (const e of entries) rowsMap[e.pk] = e.checksum;
        manifest.rows = rowsMap;
      }
      tables[table.name] = manifest;
    }

    const result = { version: INVENTORY_VERSION, tables };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  } finally {
    db.close();
  }
}

// --- CLI (직접 인자 파싱 · 새 의존성 0) ---
function parseArgs(argv) {
  const opts = { detailed: false, out: null, source: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--detailed') {
      opts.detailed = true;
    } else if (a === '--out') {
      opts.out = argv[i + 1];
      i += 1;
    } else if (!opts.source && !a.startsWith('--')) {
      opts.source = a;
    }
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.source) {
    process.stderr.write(
      'usage: node scripts/db-migrate/inventory.mjs <sourcePath> [--detailed] [--out <파일>]\n',
    );
    process.exit(1);
  }
  const inventory = buildInventory(opts.source, { detailed: opts.detailed });
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  if (opts.out) {
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    writeFileSync(opts.out, json, 'utf8');
    process.stdout.write(`[inventory] wrote ${opts.out}\n`);
  } else {
    process.stdout.write(json);
  }
}

// CLI 진입점(직접 실행 시에만). import 시에는 부작용 없음.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
