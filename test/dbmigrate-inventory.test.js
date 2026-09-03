// phase 75-p2 step1 — 읽기 전용 소스 인벤토리(inventory.mjs) 잠금 테스트.
// news.db는 리포에 없다(baseline) — createSchema로 임시 SQLite에 결정적 픽스처를 넣어 소스로 삼는다.
// 소스는 항상 { readOnly: true }로 열고 어떤 경로에서도 소스에 쓰지 않는다(DB 비파괴 · decisions (2)).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, rmSync, readFileSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchema } from '../src/db/schema.js';
import { buildInventory } from '../scripts/db-migrate/inventory.mjs';

function md5(path) {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

// 임시 디렉토리에 파일 기반 SQLite 소스를 만들고 seed(db) 콜백으로 픽스처를 넣는다.
function makeSource(seed) {
  const dir = mkdtempSync(join(tmpdir(), 'dbmig-inv-'));
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

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

const SEVEN_TABLES = [
  'User', 'Article', 'Contents', 'ArticleHistory',
  'ReceiverConfig', 'DistributionTarget', 'Photo',
];

// 항목 5 — 빈 소스: 7 테이블 rowCount 0, aggregateDigest 결정적 상수.
test('inventory: 빈 소스는 7 테이블 각각 rowCount:0 + 결정적 aggregateDigest', () => {
  const a = makeSource();
  const b = makeSource();
  try {
    const invA = buildInventory(a.path);
    const invB = buildInventory(b.path);
    for (const t of SEVEN_TABLES) {
      assert.ok(invA.tables[t], `테이블 ${t}가 매니페스트에 있어야 함`);
      assert.equal(invA.tables[t].rowCount, 0, `${t} 빈 테이블 rowCount 0`);
      assert.match(invA.tables[t].aggregateDigest, /^[0-9a-f]{64}$/);
      // 두 빈 소스가 같은 결정적 aggregateDigest(빈 집합의 상수).
      assert.equal(invA.tables[t].aggregateDigest, invB.tables[t].aggregateDigest, `${t} 빈 다이제스트 결정적`);
    }
    assert.equal(Object.keys(invA.tables).length, 7, '정확히 7 테이블');
  } finally {
    cleanup(a.dir);
    cleanup(b.dir);
  }
});

// 항목 6 — 픽스처 소스: rowCount 정확 + --detailed의 rows PK 집합 정확.
test('inventory: 픽스처 rowCount가 정확하고 detailed rows의 PK 집합이 정확하다', () => {
  const { dir, path } = makeSource((db) => {
    db.prepare("INSERT INTO User (userId, name) VALUES ('u1','김')").run();
    db.prepare("INSERT INTO User (userId, name) VALUES ('u2','이')").run();
    db.prepare("INSERT INTO Article (articleId, title) VALUES ('a1','제목1')").run();
    db.prepare("INSERT INTO ArticleHistory (articleId, eventType) VALUES ('a1','edit')").run();
    db.prepare("INSERT INTO ArticleHistory (articleId, eventType) VALUES ('a1','status')").run();
    db.prepare("INSERT INTO ArticleHistory (articleId, eventType) VALUES ('a1','create')").run();
  });
  try {
    const inv = buildInventory(path, { detailed: true });
    assert.equal(inv.tables.User.rowCount, 2);
    assert.equal(inv.tables.Article.rowCount, 1);
    assert.equal(inv.tables.ArticleHistory.rowCount, 3);
    assert.equal(inv.tables.Photo.rowCount, 0);

    // detailed면 rows(PK정규형 → 행체크섬) 맵이 있다.
    assert.deepEqual(Object.keys(inv.tables.User.rows).sort(), ['u1', 'u2']);
    // INTEGER PK는 정규형(십진 문자열)으로 키가 된다.
    assert.deepEqual(Object.keys(inv.tables.ArticleHistory.rows).sort(), ['1', '2', '3']);
    // 비-detailed면 rows가 없다.
    const summary = buildInventory(path);
    assert.equal(summary.tables.User.rows, undefined, '요약 모드에는 rows가 없다');
    assert.equal(summary.tables.User.rowCount, 2);
  } finally {
    cleanup(dir);
  }
});

// 항목 7 — 순서 비의존: 같은 논리 행을 다른 INSERT 순서로 넣으면 같은 aggregateDigest.
test('inventory: 순서 비의존 — INSERT 순서가 달라도 같은 aggregateDigest', () => {
  const s1 = makeSource((db) => {
    db.prepare("INSERT INTO User (userId, name) VALUES ('a','A')").run();
    db.prepare("INSERT INTO User (userId, name) VALUES ('b','B')").run();
    db.prepare("INSERT INTO User (userId, name) VALUES ('c','C')").run();
  });
  const s2 = makeSource((db) => {
    db.prepare("INSERT INTO User (userId, name) VALUES ('c','C')").run();
    db.prepare("INSERT INTO User (userId, name) VALUES ('a','A')").run();
    db.prepare("INSERT INTO User (userId, name) VALUES ('b','B')").run();
  });
  try {
    const i1 = buildInventory(s1.path);
    const i2 = buildInventory(s2.path);
    assert.equal(
      i1.tables.User.aggregateDigest,
      i2.tables.User.aggregateDigest,
      'PK 정규형 정렬로 순서 비의존 판정 — 엔진 기본 행 순서 차이를 흡수한다',
    );
  } finally {
    cleanup(s1.dir);
    cleanup(s2.dir);
  }
});

// INTEGER PK도 순서 비의존(수치 정렬).
test('inventory: INTEGER PK 순서 비의존 — 삽입 순서 무관 동일 다이제스트', () => {
  const s1 = makeSource((db) => {
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (10,'a','x')").run();
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (2,'a','y')").run();
  });
  const s2 = makeSource((db) => {
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (2,'a','y')").run();
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (10,'a','x')").run();
  });
  try {
    assert.equal(
      buildInventory(s1.path).tables.ArticleHistory.aggregateDigest,
      buildInventory(s2.path).tables.ArticleHistory.aggregateDigest,
    );
  } finally {
    cleanup(s1.dir);
    cleanup(s2.dir);
  }
});

// 항목 8 — NULL vs 빈 문자열 구별(행체크섬 통합 실증).
test('inventory: 한 컬럼이 NULL인 행과 빈 문자열인 행은 다른 체크섬을 낸다', () => {
  const nullSrc = makeSource((db) => {
    // name 미지정 → NULL
    db.prepare("INSERT INTO User (userId) VALUES ('k')").run();
  });
  const emptySrc = makeSource((db) => {
    db.prepare("INSERT INTO User (userId, name) VALUES ('k','')").run();
  });
  try {
    const nullInv = buildInventory(nullSrc.path, { detailed: true });
    const emptyInv = buildInventory(emptySrc.path, { detailed: true });
    assert.notEqual(
      nullInv.tables.User.rows.k,
      emptyInv.tables.User.rows.k,
      'NULL name 행과 빈 문자열 name 행은 서로 다른 정규형 → 다른 체크섬',
    );
    assert.notEqual(
      nullInv.tables.User.aggregateDigest,
      emptyInv.tables.User.aggregateDigest,
    );
  } finally {
    cleanup(nullSrc.dir);
    cleanup(emptySrc.dir);
  }
});

// 항목 9 — 큰 targetId 정수 정규형 안정.
test('inventory: ArticleHistory 큰 targetId(2147483648)도 정수 정규형으로 안정', () => {
  const { dir, path } = makeSource((db) => {
    db.prepare(
      "INSERT INTO ArticleHistory (id, articleId, eventType, targetId) VALUES (1,'a','distribute',2147483648)",
    ).run();
  });
  try {
    const inv = buildInventory(path, { detailed: true });
    assert.equal(inv.tables.ArticleHistory.rowCount, 1);
    // 결정적 체크섬(재실행 동일).
    const again = buildInventory(path, { detailed: true });
    assert.equal(inv.tables.ArticleHistory.rows['1'], again.tables.ArticleHistory.rows['1']);
  } finally {
    cleanup(dir);
  }
});

// 항목 10 — DB 비파괴: 실행 전후 소스 md5 무변.
test('inventory: buildInventory 실행 전후 소스 파일 md5가 동일하다 (DB 비파괴)', () => {
  const { dir, path } = makeSource((db) => {
    db.prepare("INSERT INTO User (userId, name) VALUES ('u1','김')").run();
    db.prepare("INSERT INTO Contents (articleId, title) VALUES ('a1','기사')").run();
  });
  try {
    const before = md5(path);
    buildInventory(path);
    buildInventory(path, { detailed: true });
    const after = md5(path);
    assert.equal(after, before, '읽기 전용 인벤토리는 소스 바이트를 바꾸지 않는다');
  } finally {
    cleanup(dir);
  }
});

// 항목 10 — 읽기 전용 파일 권한에서도 동작(가능한 환경에서).
test('inventory: 읽기 전용 파일 권한(0o444) 소스에서도 인벤토리가 나온다', () => {
  const { dir, path } = makeSource((db) => {
    db.prepare("INSERT INTO User (userId, name) VALUES ('u1','김')").run();
  });
  try {
    const before = md5(path);
    chmodSync(path, 0o444);
    const inv = buildInventory(path);
    assert.equal(inv.tables.User.rowCount, 1);
    const after = md5(path);
    assert.equal(after, before, '읽기 전용 권한에서도 소스 무변');
  } finally {
    try { chmodSync(path, 0o644); } catch { /* best-effort */ }
    cleanup(dir);
  }
});

// rowCount 교차검증: COUNT(*)와 순회 행 수가 일치(불일치면 던진다).
test('inventory: rowCount는 COUNT(*)와 실제 순회 수의 교차검증을 통과한다', () => {
  const { dir, path } = makeSource((db) => {
    for (let i = 0; i < 5; i += 1) {
      db.prepare('INSERT INTO Photo (src, caption) VALUES (?, ?)').run(`/p/${i}.png`, `c${i}`);
    }
  });
  try {
    const inv = buildInventory(path, { detailed: true });
    assert.equal(inv.tables.Photo.rowCount, 5);
    assert.equal(Object.keys(inv.tables.Photo.rows).length, 5);
  } finally {
    cleanup(dir);
  }
});

// 매니페스트가 소스 절대경로·타임스탬프 같은 비결정 필드를 담지 않는다(verify가 대조 가능해야 함).
test('inventory: 매니페스트는 결정적이다 — 같은 소스를 두 번 인벤토리하면 동일', () => {
  const { dir, path } = makeSource((db) => {
    db.prepare("INSERT INTO User (userId, name) VALUES ('u1','김')").run();
  });
  try {
    const a = JSON.stringify(buildInventory(path, { detailed: true }));
    const b = JSON.stringify(buildInventory(path, { detailed: true }));
    assert.equal(a, b, '같은 소스 → byte-identical 매니페스트');
  } finally {
    cleanup(dir);
  }
});
