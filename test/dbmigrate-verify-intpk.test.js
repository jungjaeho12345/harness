// phase 75-p2 step4 보강 — verify.mjs의 INTEGER-PK 불일치 지목(mismatchedPks) 회귀 테스트.
//
// 기존 dbmigrate-verify.test.js의 항목 2는 TEXT PK('a1' · Article)에서만 mismatchedPks를
// 검증한다. 그러나 7 테이블 중 4개(ArticleHistory·ReceiverConfig·DistributionTarget·Photo)는
// INTEGER PK이고, verify가 운영 게이트로서 "어느 PK가 갈렸는지"를 지목할 때 그 PK가 정수인
// 경우의 (a) 대칭차 산출(diffPks)과 (b) 수치 정렬(comparePk의 BigInt 분기)은 어느 테스트도
// 직접 단언하지 않았다. 정수 PK가 사전식('10' < '2')으로 정렬되거나 대칭차를 놓치면 운영자가
// 잘못된/뒤섞인 PK를 보게 된다 — 이 파일이 그 경로를 잠근다.
//
// news.db는 리포에 없다(baseline) — createSchema 임시 SQLite + 결정적 픽스처를 소스로 삼는다.
// 소스는 { readOnly: true }로만 열린다(DB 비파괴). 이 테스트는 어떤 프로덕션 로직도 고치지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchema } from '../src/db/schema.js';
import { buildInventory } from '../scripts/db-migrate/inventory.mjs';
import { verifyManifests } from '../scripts/db-migrate/verify.mjs';

function makeSource(seed) {
  const dir = mkdtempSync(join(tmpdir(), 'dbmig-vintpk-'));
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

// INTEGER PK 테이블(ArticleHistory)에서 같은 rowCount·다른 값 → mismatchedPks가
// (a) 정확한 정수 PK를 지목하고 (b) 사전식이 아니라 수치 순으로 정렬된다.
test('verify: INTEGER PK 테이블의 mismatchedPks가 정확하고 수치 순으로 정렬된다', () => {
  // 두 소스 모두 id 2·10을 담되(수치 정렬이 '10' < '2' 사전식과 갈리도록),
  // B에서 두 행의 eventType을 바꿔 두 PK 모두 digest가 갈리게 한다.
  const a = makeSource((db) => {
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (10,'a','edit')").run();
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (2,'a','edit')").run();
  });
  const b = makeSource((db) => {
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (10,'a','status')").run();
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (2,'a','status')").run();
  });
  try {
    const result = verifyManifests(
      buildInventory(a.path, { detailed: true }),
      buildInventory(b.path, { detailed: true }),
    );
    assert.equal(result.ok, false);
    const hist = result.tables.find((t) => t.name === 'ArticleHistory');
    assert.equal(hist.rowCountMatch, true, '행 수는 같다(2행)');
    assert.equal(hist.digestMatch, false, '값이 갈려 aggregateDigest 불일치');
    // 수치 정렬: '2'가 '10'보다 앞. 사전식이면 ['10','2']가 되어 이 단언이 red.
    assert.deepEqual(
      hist.mismatchedPks,
      ['2', '10'],
      '정수 PK를 수치 순으로 정렬해 지목한다(사전식 ["10","2"]가 아니다)',
    );
  } finally {
    cleanup(a.dir);
    cleanup(b.dir);
  }
});

// INTEGER PK 대칭차: 같은 rowCount인데 한쪽에만 있는 정수 PK를 diffPks가 양쪽에서 지목한다.
test('verify: INTEGER PK 대칭차 — 한쪽에만 있는 정수 PK를 mismatchedPks가 지목한다', () => {
  // A: id 2·10 / B: id 2·20 → rowCount 동일(2), digest 갈림, 대칭차는 {10, 20}.
  const a = makeSource((db) => {
    db.prepare("INSERT INTO Photo (id, src) VALUES (2,'/p/2.png')").run();
    db.prepare("INSERT INTO Photo (id, src) VALUES (10,'/p/10.png')").run();
  });
  const b = makeSource((db) => {
    db.prepare("INSERT INTO Photo (id, src) VALUES (2,'/p/2.png')").run();
    db.prepare("INSERT INTO Photo (id, src) VALUES (20,'/p/20.png')").run();
  });
  try {
    const result = verifyManifests(
      buildInventory(a.path, { detailed: true }),
      buildInventory(b.path, { detailed: true }),
    );
    assert.equal(result.ok, false);
    const photo = result.tables.find((t) => t.name === 'Photo');
    assert.equal(photo.rowCountMatch, true, '행 수는 같다(2행)');
    assert.equal(photo.digestMatch, false, '행 집합이 갈려 aggregateDigest 불일치');
    // 대칭차 {10(A에만), 20(B에만)}를 수치 순으로 지목한다.
    assert.deepEqual(
      photo.mismatchedPks,
      ['10', '20'],
      '양쪽 대칭차의 정수 PK를 수치 순으로 전부 지목한다',
    );
  } finally {
    cleanup(a.dir);
    cleanup(b.dir);
  }
});
