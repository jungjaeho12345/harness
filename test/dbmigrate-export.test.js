// phase 75-p2 step3 — 엔진 중립 JSONL export(export.mjs) 잠금 테스트.
// news.db는 리포에 없다(baseline) — createSchema로 임시 SQLite에 결정적 픽스처를 넣어 소스로 삼는다.
// 소스는 항상 { readOnly: true }로 열고 어떤 경로에서도 소스에 쓰지 않는다(DB 비파괴 · decisions (2)).
// export는 canonical.mjs의 정규화를 그대로 쓰고(복제 금지), 라운드트립으로 inventory 매니페스트와
// aggregateDigest가 동일함을 잠근다(decisions (6)).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchema } from '../src/db/schema.js';
import { buildInventory } from '../scripts/db-migrate/inventory.mjs';
import { NULL_TOKEN } from '../scripts/db-migrate/canonical.mjs';
import { exportToNeutral, manifestFromExport } from '../scripts/db-migrate/export.mjs';

function md5(path) {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

// 임시 디렉토리에 파일 기반 SQLite 소스를 만들고 seed(db) 콜백으로 픽스처를 넣는다.
function makeSource(seed) {
  const dir = mkdtempSync(join(tmpdir(), 'dbmig-exp-'));
  const path = join(dir, 'src.db');
  const db = new DatabaseSync(path);
  try {
    createSchema(db);
    if (seed) seed(db);
  } finally {
    db.close();
  }
  return { dir, path };
}

function makeOutDir() {
  return mkdtempSync(join(tmpdir(), 'dbmig-out-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

const SEVEN_TABLES = [
  'User', 'Article', 'Contents', 'ArticleHistory',
  'ReceiverConfig', 'DistributionTarget', 'Photo',
];

function seedFull(db) {
  db.prepare("INSERT INTO User (userId, name) VALUES ('u2','이')").run();
  db.prepare("INSERT INTO User (userId, name) VALUES ('u1','김')").run();
  db.prepare("INSERT INTO Article (articleId, title) VALUES ('a1','제목1')").run();
  db.prepare("INSERT INTO Contents (articleId, title) VALUES ('a1','본문제목')").run();
  db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (3,'a1','create')").run();
  db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (1,'a1','edit')").run();
  db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (2,'a1','status')").run();
  db.prepare("INSERT INTO ReceiverConfig (id, name) VALUES (1,'수신처')").run();
  db.prepare("INSERT INTO DistributionTarget (id, name, kind) VALUES (1,'언론사','press')").run();
  db.prepare("INSERT INTO Photo (id, src, caption) VALUES (1,'/p/1.png','캡션')").run();
}

// 항목 1 — export하면 7개 .jsonl 파일 + 각 파일 줄 수 == rowCount.
test('export: 7개 .jsonl 파일이 생기고 각 파일 줄 수가 rowCount와 같다', () => {
  const src = makeSource(seedFull);
  const out = makeOutDir();
  try {
    const result = exportToNeutral(src.path, out);
    const files = readdirSync(out).filter((f) => f.endsWith('.jsonl')).sort();
    assert.deepEqual(files.sort(), SEVEN_TABLES.map((t) => `${t}.jsonl`).sort());

    const inv = buildInventory(src.path);
    for (const t of SEVEN_TABLES) {
      const text = readFileSync(join(out, `${t}.jsonl`), 'utf8');
      // 마지막 개행을 기준으로 줄 수 계산(빈 테이블 → 빈 파일 → 0줄).
      const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n').filter((l) => l !== '');
      assert.equal(lines.length, inv.tables[t].rowCount, `${t} 줄 수 == rowCount`);
      const entry = result.tables.find((r) => r.name === t);
      assert.equal(entry.rowCount, inv.tables[t].rowCount, `${t} 결과 rowCount`);
    }
  } finally {
    cleanup(src.dir);
    cleanup(out);
  }
});

// 항목 2 — 라운드트립 잠금(핵심): manifestFromExport의 aggregateDigest가 buildInventory와 전부 동일.
test('export: 라운드트립 — manifestFromExport aggregateDigest가 buildInventory와 테이블별 전부 동일', () => {
  const src = makeSource(seedFull);
  const out = makeOutDir();
  try {
    exportToNeutral(src.path, out);
    const fromExport = manifestFromExport(out);
    const fromSource = buildInventory(src.path);
    for (const t of SEVEN_TABLES) {
      assert.equal(
        fromExport.tables[t].rowCount,
        fromSource.tables[t].rowCount,
        `${t} rowCount 라운드트립 동일`,
      );
      assert.equal(
        fromExport.tables[t].aggregateDigest,
        fromSource.tables[t].aggregateDigest,
        `${t} aggregateDigest 라운드트립 동일 — export가 값·순서를 잃지 않았다`,
      );
    }
  } finally {
    cleanup(src.dir);
    cleanup(out);
  }
});

// 항목 3 — 결정성: 같은 소스를 두 outDir로 export하면 각 .jsonl이 byte-identical.
test('export: 결정성 — 같은 소스를 두 outDir로 export하면 각 .jsonl이 byte-identical', () => {
  const src = makeSource(seedFull);
  const out1 = makeOutDir();
  const out2 = makeOutDir();
  try {
    exportToNeutral(src.path, out1);
    exportToNeutral(src.path, out2);
    for (const t of SEVEN_TABLES) {
      const a = readFileSync(join(out1, `${t}.jsonl`));
      const b = readFileSync(join(out2, `${t}.jsonl`));
      assert.ok(a.equals(b), `${t}.jsonl byte-identical`);
    }
  } finally {
    cleanup(src.dir);
    cleanup(out1);
    cleanup(out2);
  }
});

// 항목 3 보강 — JSONL 키 순서가 schema-spec 컬럼 순서로 고정(런타임/엔진 키 순서 비의존).
test('export: JSONL 행 키 순서가 schema-spec 컬럼 순서로 결정적이다', () => {
  const src = makeSource((db) => {
    db.prepare("INSERT INTO User (userId, name, role) VALUES ('u1','김','reporter')").run();
  });
  const out = makeOutDir();
  try {
    exportToNeutral(src.path, out);
    const line = readFileSync(join(out, 'User.jsonl'), 'utf8').trim().split('\n')[0];
    const keys = Object.keys(JSON.parse(line));
    // schema-spec의 User 컬럼 순서: userId, name, password, role, ...
    assert.equal(keys[0], 'userId');
    assert.equal(keys[1], 'name');
    assert.equal(keys[2], 'password');
    assert.equal(keys[3], 'role');
  } finally {
    cleanup(src.dir);
    cleanup(out);
  }
});

// 항목 4 — NULL/빈 문자열 보존: NULL 컬럼과 '' 컬럼이 export에서 구별(정규형 토큰) → 라운드트립 후 다른 체크섬.
test('export: NULL 컬럼과 빈 문자열 컬럼이 구별되어 라운드트립 후에도 다른 체크섬', () => {
  const nullSrc = makeSource((db) => {
    db.prepare("INSERT INTO User (userId) VALUES ('k')").run(); // name → NULL
  });
  const emptySrc = makeSource((db) => {
    db.prepare("INSERT INTO User (userId, name) VALUES ('k','')").run();
  });
  const nullOut = makeOutDir();
  const emptyOut = makeOutDir();
  try {
    exportToNeutral(nullSrc.path, nullOut);
    exportToNeutral(emptySrc.path, emptyOut);

    const nullLine = JSON.parse(readFileSync(join(nullOut, 'User.jsonl'), 'utf8').trim());
    const emptyLine = JSON.parse(readFileSync(join(emptyOut, 'User.jsonl'), 'utf8').trim());
    // NULL은 전용 토큰, 빈 문자열은 ''.
    assert.equal(nullLine.name, NULL_TOKEN);
    assert.equal(emptyLine.name, '');
    assert.notEqual(nullLine.name, emptyLine.name);

    const nullManifest = manifestFromExport(nullOut);
    const emptyManifest = manifestFromExport(emptyOut);
    assert.notEqual(
      nullManifest.tables.User.aggregateDigest,
      emptyManifest.tables.User.aggregateDigest,
      'NULL 행과 빈 문자열 행은 라운드트립 후에도 서로 다른 체크섬',
    );
  } finally {
    cleanup(nullSrc.dir);
    cleanup(emptySrc.dir);
    cleanup(nullOut);
    cleanup(emptyOut);
  }
});

// 항목 5 — 비파괴: export 전후 소스 md5 동일.
test('export: exportToNeutral 실행 전후 소스 파일 md5가 동일하다 (DB 비파괴)', () => {
  const src = makeSource(seedFull);
  const out = makeOutDir();
  try {
    const before = md5(src.path);
    exportToNeutral(src.path, out);
    const after = md5(src.path);
    assert.equal(after, before, '읽기 전용 export는 소스 바이트를 바꾸지 않는다');
  } finally {
    cleanup(src.dir);
    cleanup(out);
  }
});

// 항목 6 — 덮어쓰기 거부: 비어 있지 않은 outDir로 export하면 throw(조용한 혼합 방지).
test('export: 비어 있지 않은 outDir로 export하면 거부(throw)한다', () => {
  const src = makeSource(seedFull);
  const out = makeOutDir();
  try {
    // outDir에 기존 파일을 심는다.
    writeFileSync(join(out, 'stale.jsonl'), 'stale\n', 'utf8');
    assert.throws(
      () => exportToNeutral(src.path, out),
      /비어 있지 않|not empty|non-?empty/i,
      '비어 있지 않은 outDir 덮어쓰기를 거부해야 한다',
    );
  } finally {
    cleanup(src.dir);
    cleanup(out);
  }
});

// 항목 6 보강 — 존재하지 않는 outDir은 만들어서 쓴다(빈 디렉토리는 허용).
test('export: 존재하지 않는 outDir을 만들어 쓴다(빈 디렉토리 허용)', () => {
  const src = makeSource(seedFull);
  const base = makeOutDir();
  const out = join(base, 'nested', 'neutral'); // 아직 없음
  try {
    const result = exportToNeutral(src.path, out);
    assert.ok(result.tables.length === 7);
    assert.ok(readdirSync(out).length === 7);
  } finally {
    cleanup(src.dir);
    cleanup(base);
  }
});

// 항목 7 — 큰 ArticleHistory.targetId가 export→라운드트립에서 정수 정규형으로 안정.
// (>2^53 정확 보존은 canonical.mjs의 BigInt 경로가 step1 단위 테스트에서 이미 잠겨 있고,
//  DB 읽기 경로에서 >2^53를 실제로 흘리려면 setReadBigInts가 필요하다 — inventory.mjs와 동일한
//  읽기 계약을 export도 그대로 따른다. 여기서는 step1 inventory 테스트와 같은 큰 값 2147483648로
//  export→라운드트립 안정을 잠근다.)
test('export: 큰 targetId(2147483648)가 export→라운드트립에서 정수 정규형으로 안정', () => {
  const src = makeSource((db) => {
    db.prepare(
      "INSERT INTO ArticleHistory (id, articleId, eventType, targetId) VALUES (2,'a','distribute',2147483648)",
    ).run();
    db.prepare(
      "INSERT INTO ArticleHistory (id, articleId, eventType, targetId) VALUES (1,'a','edit',NULL)",
    ).run();
  });
  const out = makeOutDir();
  try {
    exportToNeutral(src.path, out);
    const lines = readFileSync(join(out, 'ArticleHistory.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const byId = Object.fromEntries(lines.map((r) => [r.id, r]));
    assert.equal(byId['2'].targetId, '2147483648'); // 정수 정규형(선행 0·소수점 없음)
    assert.equal(byId['1'].targetId, NULL_TOKEN); // NULL targetId는 전용 토큰

    // 라운드트립 aggregateDigest 동일.
    assert.equal(
      manifestFromExport(out).tables.ArticleHistory.aggregateDigest,
      buildInventory(src.path).tables.ArticleHistory.aggregateDigest,
    );
  } finally {
    cleanup(src.dir);
    cleanup(out);
  }
});
