// 운영 규모 점검 (phase 76 step8 작업 B) — SQLite **사본** 한 개를 읽기 전용으로 열어, 컷오버 전에 알아야 하는
// 다섯 축을 잰다: ① VARCHAR(768) 를 넘는 텍스트 PK(있으면 이관이 **1406** 으로 실패한다) ② 최대 **바이트**
// (max_allowed_packet 대비 · markupVersion 이 대표 축이다) ③ 4바이트 이모지·짝 없는 서로게이트 ④ NULL 과 빈
// 문자열의 분포 ⑤ 정본 밖 테이블·컬럼(수기 ALTER 흔적).
//
// 사용: node scripts/db-scale-probe.mjs --source <사본.db> [--json <리포 밖 파일>] [--chunk <행>]
//
// CRITICAL(비파괴): **읽기 전용으로 연다**(readOnly) — 그래야 -wal/-shm 이 생기지 않는다. 부산물이 이미 있으면
//   시작 자체를 거부한다(마이그레이터 SourceFingerprint 와 같은 규율 · 그 사본은 "그대로"가 아니다).
//   열기 전후의 크기·md5 를 재서 한 바이트라도 변하면 실패로 남긴다. 운영 **원본은 열지 마라 — 사본만 만진다.**
// 값 원문은 출력하지 않는다 — 수치(글자 수·바이트 수·건수)만 낸다(기사 본문·계정 정보가 로그로 새지 않게).
// 판정부는 scripts/lib/dbScaleProbe.mjs 이고 시작할 때 그 자기검사를 스스로 돌린다.

import fs from 'node:fs';
import nodePath from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { flagValue } from './lib/cliArgs.mjs';
import { digestProblems, sidecarsOf } from './lib/loadRehearsal.mjs';
import {
  MAX_ALLOWED_PACKET, TEXT_PK_LIMIT, mergeSummaries, parseBaselineTables, summariseColumn, unknownNames,
} from './lib/dbScaleProbe.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const BASELINE_SQL = nodePath.join(REPO_ROOT, 'tools', 'news-migrator', 'src', 'main', 'resources', 'db', 'migration', 'V1__baseline.sql');
const SELF_TEST = nodePath.join(nodePath.dirname(SCRIPT_PATH), 'lib', 'dbScaleProbe.self-test.mjs');

const USAGE = `사용법: node scripts/db-scale-probe.mjs --source <사본.db> [--json <리포 밖 파일>] [--chunk <행>]
  --source <파일>  읽을 SQLite **사본**(운영 원본을 주지 마라 — 읽기만 해도 부산물이 생길 수 있다).
  --json <파일>    수치를 JSON 으로도 남긴다. **리포 안에는 쓰지 않는다.**
  --chunk <행>     한 번에 읽는 행 수(기본 2000 · 1 이상 정수). 운영 규모는 한 번에 읽지 않는다.`;

function usageDie(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const take = (i, flag) => {
    const v = flagValue(argv, i, flag);
    if (!v.ok) usageDie(v.message);
    return v.value;
  };
  const opts = { chunk: 2000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') { opts.source = take(i, '--source'); i += 1; }
    else if (a === '--json') { opts.json = take(i, '--json'); i += 1; }
    else if (a === '--chunk') { opts.chunk = Number(take(i, '--chunk')); i += 1; }
    else usageDie(`알 수 없는 인자: ${a}`);
  }
  if (!opts.source) usageDie('--source <사본.db> 가 필요하다.');
  if (!Number.isInteger(opts.chunk) || opts.chunk < 1) usageDie(`--chunk 값이 유효하지 않다(1 이상 정수): ${opts.chunk}`);
  return opts;
}

function runSelfTest() {
  if (!fs.existsSync(SELF_TEST)) usageDie(`판정부 자기검사 파일이 없다: ${SELF_TEST} — 조용히 건너뛰지 않는다.`);
  const result = spawnSync(process.execPath, ['--test', SELF_TEST], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(String(result.stdout ?? '') + String(result.stderr ?? ''));
    usageDie('판정부 자기검사가 실패했다 — 빨간 판정부로는 재지 않는다.');
  }
  process.stdout.write('  판정부 자기검사 통과 (node --test scripts/lib/dbScaleProbe.self-test.mjs)\n');
}

function fileDigest(file) {
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  return { size: bytes.length, md5: createHash('md5').update(bytes).digest('hex') };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const source = nodePath.resolve(opts.source);
  process.stdout.write(`db-scale-probe 시작 source=${source}\n`);
  runSelfTest();

  if (!fs.existsSync(source)) usageDie(`사본이 없다: ${source}`);
  const sidecars = sidecarsOf(source, (path) => fs.existsSync(path));
  if (sidecars.length > 0) {
    usageDie(`사본 옆에 부산물이 있다 ${JSON.stringify(sidecars)} — 서버를 정상 종료한 뒤 사본을 다시 뜨라(부산물을 지우지 마라).`);
  }
  const jsonOut = opts.json ? nodePath.resolve(opts.json) : null;
  if (jsonOut && !nodePath.relative(REPO_ROOT, jsonOut).startsWith('..')) usageDie(`--json 은 리포 안에 쓸 수 없다: ${jsonOut}`);

  const baseline = parseBaselineTables(fs.readFileSync(BASELINE_SQL, 'utf8'));
  if (baseline.length === 0) usageDie(`기반선에서 테이블을 하나도 읽지 못했다(${BASELINE_SQL}) — 형식이 바뀌었다.`);
  const pkLimits = baseline.flatMap((table) => table.columns
    .filter((column) => column.primaryKey && column.maxChars !== null)
    .map((column) => ({ table: table.name, column: column.name, maxChars: column.maxChars })));
  for (const pk of pkLimits) {
    if (pk.maxChars !== TEXT_PK_LIMIT) usageDie(`기반선의 텍스트 PK 상한이 ${TEXT_PK_LIMIT} 가 아니다: ${pk.table}.${pk.column}=${pk.maxChars}`);
  }

  const before = fileDigest(source);
  const db = new DatabaseSync(source, { readOnly: true });
  const problems = [];
  const report = { source, sourceDigest: before, textPkLimit: TEXT_PK_LIMIT, maxAllowedPacket: MAX_ALLOWED_PACKET, tables: [] };
  try {
    const actualTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    report.unknownTables = unknownNames(actualTables, baseline.map((table) => table.name));
    for (const table of baseline) {
      if (!actualTables.some((name) => name.toLowerCase() === table.name.toLowerCase())) {
        problems.push(`사본에 정본 테이블이 없다: ${table.name}`);
        continue;
      }
      const actualColumns = db.prepare(`PRAGMA table_info(${table.name})`).all().map((row) => row.name);
      const unknownColumns = unknownNames(actualColumns, table.columns.map((column) => column.name));
      const rows = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table.name}`).get().n);
      const summaries = {};
      for (const column of table.columns) summaries[column.name] = summariseColumn([], { maxChars: column.maxChars });
      for (let offset = 0; offset < rows; offset += opts.chunk) {
        const chunk = db.prepare(`SELECT * FROM ${table.name} LIMIT ? OFFSET ?`).all(opts.chunk, offset);
        for (const column of table.columns) {
          const values = chunk.map((row) => (column.name in row ? row[column.name] : null));
          summaries[column.name] = mergeSummaries(summaries[column.name], summariseColumn(values, { maxChars: column.maxChars }));
        }
      }
      report.tables.push({
        table: table.name, rows, columns: table.columns.length, unknownColumns,
        columnSummaries: Object.fromEntries(table.columns.map((column) => [column.name, summaries[column.name]])),
      });
    }
  }
  finally {
    db.close();
  }
  problems.push(...digestProblems('사본', before, fileDigest(source)));
  const sidecarsAfter = sidecarsOf(source, (path) => fs.existsSync(path));
  if (sidecarsAfter.length > 0) problems.push(`읽는 동안 부산물이 생겼다 ${JSON.stringify(sidecarsAfter)} — 읽기 전용으로 열리지 않았다`);

  // --- 사람이 읽는 표 (값 원문 없음) ---
  const overlong = [];
  const astral = [];
  const lone = [];
  let maxBytes = { where: '-', bytes: 0 };
  process.stdout.write(`\n테이블            행     컬럼  정본 밖 컬럼\n`);
  for (const table of report.tables) {
    process.stdout.write(`${table.table.padEnd(18)}${String(table.rows).padStart(6)}${String(table.columns).padStart(7)}  ${table.unknownColumns.length === 0 ? '-' : table.unknownColumns.join(', ')}\n`);
    for (const [column, summary] of Object.entries(table.columnSummaries)) {
      const where = `${table.table}.${column}`;
      if (summary.overlong > 0) overlong.push(`${where} ${summary.overlong}행(최대 ${summary.maxChars}자)`);
      if (summary.astralRows > 0) astral.push(`${where} ${summary.astralRows}행`);
      if (summary.loneSurrogateRows > 0) lone.push(`${where} ${summary.loneSurrogateRows}행`);
      if (summary.maxBytes > maxBytes.bytes) maxBytes = { where, bytes: summary.maxBytes };
    }
  }
  const totalRows = report.tables.reduce((sum, table) => sum + table.rows, 0);
  const totalColumns = report.tables.reduce((sum, table) => sum + table.columns, 0);
  const totalCells = report.tables.reduce((sum, table) => sum + table.rows * table.columns, 0);
  report.totals = { tables: report.tables.length, rows: totalRows, columns: totalColumns, cells: totalCells };
  report.findings = { overlong, astral, lone, maxBytes, unknownTables: report.unknownTables };

  process.stdout.write(`\n합계: ${report.tables.length}테이블 · ${totalRows}행 · ${totalColumns}컬럼 · ${totalCells}셀\n`);
  process.stdout.write(`정본 밖 테이블: ${report.unknownTables.length === 0 ? '없음' : report.unknownTables.join(', ')}\n`);
  process.stdout.write(`텍스트 PK ${TEXT_PK_LIMIT}자 초과(1406 위험): ${overlong.length === 0 ? '없음' : overlong.join(' · ')}\n`);
  process.stdout.write(`최대 값 바이트: ${maxBytes.where} ${maxBytes.bytes}B (max_allowed_packet ${MAX_ALLOWED_PACKET}B 의 ${(maxBytes.bytes / MAX_ALLOWED_PACKET * 100).toFixed(4)}%)\n`);
  process.stdout.write(`4바이트 이모지(astral): ${astral.length === 0 ? '없음' : astral.join(' · ')}\n`);
  process.stdout.write(`짝 없는 서로게이트: ${lone.length === 0 ? '없음' : lone.join(' · ')}\n`);
  const nullEmpty = report.tables.flatMap((table) => Object.entries(table.columnSummaries)
    .filter(([, summary]) => summary.nulls > 0 && summary.empties > 0)
    .map(([column, summary]) => `${table.table}.${column} NULL ${summary.nulls}/빈 ${summary.empties}`));
  process.stdout.write(`NULL 과 빈 문자열이 **섞인** 컬럼: ${nullEmpty.length === 0 ? '없음' : nullEmpty.join(' · ')}\n`);
  report.findings.nullEmptyMixed = nullEmpty;

  if (jsonOut) {
    fs.mkdirSync(nodePath.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`JSON: ${jsonOut}\n`);
  }
  if (problems.length > 0) process.stderr.write(`${problems.map((p) => `FAIL ${p}`).join('\n')}\n`);
  process.stdout.write(`db-scale-probe → ${problems.length === 0 ? 'ok' : 'FAILED'} (사본 무변 ${before.size}B md5 ${before.md5})\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main();
