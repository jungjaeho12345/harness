// 매니페스트 대조 검증 하네스 (phase 75-p2 step4)
//
// 두 매니페스트(소스 것 · 대상 것)를 받아 '전 행 대조 100%'를 기계 판정한다 — §7 P2 완료 게이트의
// 마지막 조각(대조). verify는 엔진 중립이다: 어느 엔진에서 온 매니페스트인지 모르고, rowCount와
// aggregateDigest(=값)만 본다. 구조(컬럼·타입·PK·인덱스)는 schema-canonical 명세(step0)가 따로 본다.
//
// 대상 매니페스트를 '생산하는' 엔진별 도구는 excluded (a)이며 엔진 결정(open_questions (1)) 후
// 후속 phase가 만든다. 이 분리가 이 phase를 엔진 결정과 독립시킨다.
//
// DB 비파괴(지배 규칙 · decisions (2)): 읽기만 한다 — 매니페스트 JSON 읽기, 소스 SQLite는
// buildInventory/manifestFromExport 경유로 { readOnly: true }로만 열린다. 아무것도 쓰지 않는다.
//
// CLI:
//   node scripts/db-migrate/verify.mjs <manifestA.json> <manifestB.json>
//   node scripts/db-migrate/verify.mjs --sources <a> <b>   (a·b는 소스 SQLite 파일 또는 export 디렉토리)
//   일치면 exit 0, 불일치면 exit 1 + 어느 테이블·어느 PK가 갈렸는지 출력.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { buildInventory } from './inventory.mjs';
import { manifestFromExport } from './export.mjs';

// 두 detailed 매니페스트의 rows 맵을 대조해 어긋난 PK 목록을 낸다.
// 어긋남 = 한쪽에만 있는 PK 또는 양쪽에 있으나 rowChecksum이 다른 PK.
// 정렬은 결정적이어야 한다(같은 입력 → 같은 출력): INTEGER 정규형은 BigInt 수치, 그 외 코드포인트.
function comparePk(a, b) {
  let ba;
  let bb;
  try { ba = BigInt(a); } catch { ba = null; }
  try { bb = BigInt(b); } catch { bb = null; }
  if (ba !== null && bb !== null) {
    if (ba < bb) return -1;
    if (ba > bb) return 1;
    return 0;
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

function diffPks(rowsA, rowsB) {
  const keys = new Set([...Object.keys(rowsA), ...Object.keys(rowsB)]);
  const mismatched = [];
  for (const k of keys) {
    if (rowsA[k] !== rowsB[k]) mismatched.push(k);
  }
  mismatched.sort(comparePk);
  return mismatched;
}

// 두 매니페스트를 대조한다.
// 반환: { ok, tables: [{ name, rowCountMatch, digestMatch, mismatchedPks?, onlyIn? }], summary }
export function verifyManifests(sourceManifest, targetManifest) {
  const aTables = (sourceManifest && sourceManifest.tables) || {};
  const bTables = (targetManifest && targetManifest.tables) || {};

  // 테이블 집합 대조 — 한쪽에만 있는 테이블 = 불일치. 이름 정렬로 결정적 출력.
  const names = [...new Set([...Object.keys(aTables), ...Object.keys(bTables)])].sort();

  const tables = [];
  let tableSetMatch = true;
  for (const name of names) {
    const a = aTables[name];
    const b = bTables[name];

    if (!a || !b) {
      tableSetMatch = false;
      tables.push({
        name,
        rowCountMatch: false,
        digestMatch: false,
        onlyIn: a ? 'a' : 'b',
      });
      continue;
    }

    const rowCountMatch = a.rowCount === b.rowCount;
    const digestMatch = a.aggregateDigest === b.aggregateDigest;
    const entry = { name, rowCountMatch, digestMatch };

    // 양쪽이 detailed(rows 맵 보유)이고 다이제스트가 갈리면 어긋난 PK를 지목한다.
    if (!digestMatch && a.rows && b.rows) {
      entry.mismatchedPks = diffPks(a.rows, b.rows);
    }
    tables.push(entry);
  }

  const ok = tableSetMatch && tables.every((t) => t.rowCountMatch && t.digestMatch);
  const mismatches = tables.filter((t) => !t.rowCountMatch || !t.digestMatch);
  const summary = {
    tableSetMatch,
    tableCount: names.length,
    mismatchCount: mismatches.length,
  };
  return { ok, tables, summary };
}

// 소스 경로(SQLite 파일) 또는 export 디렉토리에서 매니페스트를 만든다.
// 디렉토리면 export JSONL 라운드트립(manifestFromExport), 파일이면 읽기 전용 인벤토리(buildInventory).
function manifestFrom(path, { detailed }) {
  const st = statSync(path);
  if (st.isDirectory()) {
    // export 매니페스트는 rows 상세를 담지 않는다(요약 대조만). rowCount·aggregateDigest로 판정한다.
    return manifestFromExport(path);
  }
  return buildInventory(path, { detailed });
}

// 편의: 두 소스 경로(또는 export 디렉토리)에서 매니페스트를 만들어 대조한다.
export function verifySources(a, b, { detailed = true } = {}) {
  const ma = manifestFrom(a, { detailed });
  const mb = manifestFrom(b, { detailed });
  return verifyManifests(ma, mb);
}

// --- CLI (직접 인자 파싱 · 새 의존성 0) ---
function readManifest(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function report(result) {
  const lines = [];
  if (result.ok) {
    lines.push(`[verify] ok — 전 테이블 행 수·값 대조 일치 (tables=${result.summary.tableCount})`);
  } else {
    lines.push(`[verify] MISMATCH — 대조 불일치 (tables=${result.summary.tableCount}, mismatches=${result.summary.mismatchCount})`);
    for (const t of result.tables) {
      if (t.rowCountMatch && t.digestMatch) continue;
      if (t.onlyIn) {
        lines.push(`  - ${t.name}: 테이블이 ${t.onlyIn === 'a' ? '첫째(A)' : '둘째(B)'} 쪽에만 있음`);
        continue;
      }
      const parts = [];
      if (!t.rowCountMatch) parts.push('rowCount 불일치');
      if (!t.digestMatch) parts.push('aggregateDigest 불일치');
      lines.push(`  - ${t.name}: ${parts.join(' · ')}`);
      if (t.mismatchedPks && t.mismatchedPks.length > 0) {
        lines.push(`      어긋난 PK: ${t.mismatchedPks.join(', ')}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  let a;
  let b;
  let sourcesMode = false;
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sources') {
      sourcesMode = true;
    } else if (!argv[i].startsWith('--')) {
      positional.push(argv[i]);
    }
  }
  [a, b] = positional;

  if (!a || !b) {
    process.stderr.write(
      'usage: node scripts/db-migrate/verify.mjs <manifestA.json> <manifestB.json>\n'
      + '       node scripts/db-migrate/verify.mjs --sources <a> <b>\n',
    );
    process.exit(2);
    return;
  }

  const result = sourcesMode
    ? verifySources(a, b, { detailed: true })
    : verifyManifests(readManifest(a), readManifest(b));

  process.stdout.write(report(result));
  process.exit(result.ok ? 0 : 1);
}

// CLI 진입점(직접 실행 시에만). import 시에는 부작용 없음.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
