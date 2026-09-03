// 비파괴 정적 게이트 (phase 75-p2 step2).
//
// scripts/db-migrate/** 전체에 (a) 파괴/쓰기 SQL 토큰과 (b) 쓰기 열기(read-write open)가
// 없음을 정적으로 잠근다. porting-plan §8의 '삭제 쿼리 0 정적 검사(마이그레이터 코드에
// DELETE/DROP 부재를 텍스트 잠금)'를 이 게이트가 구현한다. CLAUDE.md 최상위 규칙('DB에
// 있는 내용은 절대 삭제하지 않는다')·decisions (2)의 정적 관측 겹을 담당한다.
//
// 설계 원칙:
//  - 스캔 루트는 scripts/db-migrate/ 뿐이다(server/**·src/**는 DELETE/DROP을 정당하게 가진다 —
//    무접촉 목록이다). 이 테스트 파일 자신은 스캔 대상이 아니다(금지 토큰을 자가증명 입력으로 담는다).
//  - 오탐 회피: 금지 토큰은 **문자열 리터럴 안에서만** 본다(주석·식별자 제외). 이렇게 하면
//    canonical.mjs·inventory.mjs의 `createHash(`·`agg.update(`·주석의 'update'/'insert'가
//    오탐되지 않는다. 그럼에도 실제 파괴 SQL(db.exec('DELETE ...')·'DROP TABLE ...')은
//    문자열 리터럴이므로 여전히 잡힌다 — M2-1·M2-3이 이를 실증한다.
//  - 읽기 전용 규율: DatabaseSync가 소스 파일 경로로 열릴 때 { readOnly: true }를 요구한다.
//    `:memory:` 리터럴 open은 면제한다(schema-spec.mjs가 구조 파생용으로 읽기-쓰기로 연다) —
//    면제는 오직 `:memory:`에만 적용되며 파일 경로로 넓히지 않는다(M2-2 vs M2-2b가 실증).
//  - 비공허성: 판정 함수를 알려진 파괴 문자열/open에 직접 먹여 탐지력을 잠근다(B — 자가증명).
//    게이트를 느슨하게 만들면(어휘 삭제 등) 자가증명이 red가 된다(M2-4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOT = path.join(REPO_ROOT, 'scripts', 'db-migrate');

// 금지 어휘 — 다음 사람이 확장할 수 있게 상수 배열로 둔다. (SQL 문에서의 파괴/쓰기 토큰)
const FORBIDDEN_TOKENS = [
  'DROP',
  'DELETE',
  'TRUNCATE',
  'ALTER',
  'CREATE',
  'INSERT',
  'UPDATE',
  'REPLACE',
];

// --- 판정 함수(이 테스트가 소유 · 새 의존성 0 · 텍스트 스캔) ---

// 소스에서 문자열/템플릿 리터럴 내용만 추출한다(주석·코드 식별자 제외). 각 리터럴의 시작 줄을 기록.
// 템플릿의 ${...} 보간식은 건너뛴다(코드이지 SQL 리터럴이 아니다).
function extractStringLiterals(text) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    // 줄 주석
    if (c === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    // 블록 주석
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    // 따옴표 문자열
    if (c === "'" || c === '"') {
      const quote = c;
      const startLine = line;
      let content = '';
      i += 1;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') { content += text[i + 1] || ''; i += 2; continue; }
        if (text[i] === '\n') line += 1;
        content += text[i];
        i += 1;
      }
      i += 1; // 닫는 따옴표
      out.push({ content, line: startLine });
      continue;
    }
    // 템플릿 리터럴
    if (c === '`') {
      const startLine = line;
      let content = '';
      i += 1;
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\') { content += text[i + 1] || ''; i += 2; continue; }
        if (text[i] === '$' && text[i + 1] === '{') {
          // 보간식은 건너뛴다(중괄호 깊이 매칭).
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}') depth -= 1;
            else if (text[i] === '\n') line += 1;
            i += 1;
          }
          continue;
        }
        if (text[i] === '\n') line += 1;
        content += text[i];
        i += 1;
      }
      i += 1; // 닫는 백틱
      out.push({ content, line: startLine });
      continue;
    }
    i += 1;
  }
  return out;
}

// 문자열 리터럴 안의 금지 토큰(대소문자 무시 · 단어 경계)을 찾는다.
function findForbiddenInStrings(text) {
  const findings = [];
  if (FORBIDDEN_TOKENS.length === 0) return findings;
  const re = new RegExp(`\\b(${FORBIDDEN_TOKENS.join('|')})\\b`, 'gi');
  for (const lit of extractStringLiterals(text)) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lit.content)) !== null) {
      findings.push({ kind: 'destructive-sql', token: m[1].toUpperCase(), line: lit.line });
    }
  }
  return findings;
}

// DatabaseSync( 호출의 인자 텍스트를 괄호 깊이 매칭으로 읽는다(문자열 내부는 건너뛴다).
function readArgs(text, start) {
  let i = start;
  let depth = 1;
  let argsText = '';
  const n = text.length;
  while (i < n && depth > 0) {
    const c = text[i];
    if (c === '(') { depth += 1; argsText += c; i += 1; continue; }
    if (c === ')') { depth -= 1; if (depth === 0) break; argsText += c; i += 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      argsText += c;
      i += 1;
      while (i < n && text[i] !== q) {
        if (text[i] === '\\') { argsText += text[i] + (text[i + 1] || ''); i += 2; continue; }
        argsText += text[i];
        i += 1;
      }
      argsText += text[i] || '';
      i += 1;
      continue;
    }
    argsText += c;
    i += 1;
  }
  return argsText;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

// 소스 파일 경로로 열리는 DatabaseSync가 { readOnly: true } 없이 열리는 자리를 찾는다.
// `:memory:` 리터럴 첫 인자는 면제(구조 파생용 일회성 in-memory DB — 소스가 아니다).
function findReadWriteOpens(text) {
  const findings = [];
  const marker = 'DatabaseSync(';
  let idx = text.indexOf(marker);
  while (idx !== -1) {
    const open = idx + marker.length;
    const argsText = readArgs(text, open);
    const firstArgMemory = /^\s*['"]:memory:['"]/.test(argsText);
    const hasReadOnlyTrue = /readOnly\s*:\s*true/.test(argsText);
    if (!firstArgMemory && !hasReadOnlyTrue) {
      findings.push({
        kind: 'readwrite-open',
        line: lineAt(text, idx),
        detail: argsText.trim().slice(0, 100),
      });
    }
    idx = text.indexOf(marker, open);
  }
  return findings;
}

function listScannedFiles() {
  return readdirSync(SCAN_ROOT)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => path.join(SCAN_ROOT, f));
}

// --- A: 실제 파일 스캔 게이트 ---

test('스캔 루트 scripts/db-migrate/에 .mjs 도구가 존재한다(게이트가 공허하지 않다)', () => {
  const files = listScannedFiles();
  assert.ok(files.length > 0, 'scripts/db-migrate/에 스캔할 .mjs 파일이 하나도 없다 — 게이트가 공허하다');
});

test('scripts/db-migrate/** 문자열 리터럴에 파괴 SQL 토큰이 0건이다', () => {
  const offenders = [];
  for (const file of listScannedFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const f of findForbiddenInStrings(text)) {
      offenders.push(`${path.relative(REPO_ROOT, file)}:${f.line} — SQL 문자열에 파괴 토큰 '${f.token}'`);
    }
  }
  assert.equal(
    offenders.length,
    0,
    `scripts/db-migrate/**에 파괴/쓰기 SQL이 있다(DB 비파괴 위반):\n${offenders.join('\n')}`,
  );
});

test('scripts/db-migrate/**의 DatabaseSync 소스 open이 전부 { readOnly: true }다(:memory: 면제)', () => {
  const offenders = [];
  for (const file of listScannedFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const f of findReadWriteOpens(text)) {
      offenders.push(`${path.relative(REPO_ROOT, file)}:${f.line} — readOnly 없는 open: ${f.detail}`);
    }
  }
  assert.equal(
    offenders.length,
    0,
    `소스 파일 경로를 읽기-쓰기로 여는 DatabaseSync가 있다(읽기 전용 규율 위반):\n${offenders.join('\n')}`,
  );
});

// --- B: 비공허성 자가 증명 (판정 함수의 탐지력을 잠근다) ---

test('자가증명 — 파괴 SQL 문자열을 스캐너에 직접 먹이면 각 금지 토큰을 탐지한다', () => {
  // 어휘의 모든 토큰을 개별 SQL 문자열로 심어, 어느 하나라도 어휘에서 빠지면 red가 되게 한다(M2-4).
  const samples = {
    DROP: "db.exec('DROP TABLE User')",
    DELETE: "db.exec('DELETE FROM Contents')",
    TRUNCATE: "db.exec('TRUNCATE TABLE Photo')",
    ALTER: "db.exec('ALTER TABLE Article ADD COLUMN x')",
    CREATE: "db.exec('CREATE TABLE Foo (id INTEGER)')",
    INSERT: "db.prepare('INSERT INTO User VALUES (1)')",
    UPDATE: "db.prepare('UPDATE User SET name = ?')",
    REPLACE: "db.exec('REPLACE INTO User VALUES (1)')",
  };
  for (const token of FORBIDDEN_TOKENS) {
    const src = samples[token];
    assert.ok(src, `자가증명 샘플이 어휘 토큰 '${token}'에 대해 없다 — 샘플을 추가하라`);
    const found = findForbiddenInStrings(src).some((f) => f.token === token);
    assert.ok(found, `스캐너가 파괴 토큰 '${token}'를 탐지하지 못했다 — 게이트가 느슨해졌다`);
  }

  // 특히 DELETE는 §8 문구의 핵심이다 — 어휘에서 빠지면 이 단언이 red가 된다.
  assert.ok(
    findForbiddenInStrings("db.exec('DELETE FROM Contents')").some((f) => f.token === 'DELETE'),
    'DELETE 탐지가 사라졌다 — 어휘가 약화됐다(§8: DELETE/DROP 부재를 텍스트 잠금)',
  );
});

test('자가증명 — 오탐 원천(식별자·주석)은 탐지하지 않는다', () => {
  // 문자열 리터럴 밖의 토큰(코드 식별자·주석)은 잡지 않는다.
  const benign = [
    'const h = createHash("sha256");', // CREATE — 식별자
    'for (const e of x) agg.update(e);', // UPDATE — 메서드명
    "s.replace('a', 'b');", // REPLACE — 메서드명
    '// update the manifest and insert rows', // 주석의 update/insert
    'import { createSchema } from "../../src/db/schema.js";', // CREATE — import 식별자
  ];
  for (const src of benign) {
    assert.deepEqual(
      findForbiddenInStrings(src),
      [],
      `오탐이 발생했다(코드/주석을 파괴 SQL로 오인): ${src}`,
    );
  }
});

test('자가증명 — readOnly 규율: 파일 경로 open은 잡고 :memory:·readOnly:true는 통과한다', () => {
  // 파일 경로를 읽기-쓰기로 여는 자리는 잡힌다.
  assert.equal(
    findReadWriteOpens("const db = new DatabaseSync(sourcePath);").length,
    1,
    'readOnly 없는 파일-경로 open을 탐지하지 못했다',
  );
  assert.equal(
    findReadWriteOpens("const db = new DatabaseSync('/data/news.db');").length,
    1,
    'readOnly 없는 리터럴 파일-경로 open을 탐지하지 못했다',
  );

  // { readOnly: true }가 있으면 통과.
  assert.equal(
    findReadWriteOpens("const db = new DatabaseSync(sourcePath, { readOnly: true });").length,
    0,
    'readOnly:true open을 오탐했다',
  );

  // :memory: 는 면제(읽기-쓰기라도 통과) — 면제는 오직 :memory:에만.
  assert.equal(
    findReadWriteOpens("const db = new DatabaseSync(':memory:');").length,
    0,
    ':memory: open이 면제되지 않았다',
  );

  // 면제가 파일 경로로 넓혀지지 않았음을 실증: :memory:가 아닌 리터럴은 여전히 잡힌다.
  assert.equal(
    findReadWriteOpens("const db = new DatabaseSync(':notmemory:');").length,
    1,
    ':memory: 면제가 다른 리터럴로 새어나갔다(면제가 너무 넓다)',
  );
});
