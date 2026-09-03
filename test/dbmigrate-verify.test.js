// phase 75-p2 step4 — 매니페스트 대조 검증 하네스(verify.mjs) 잠금 테스트.
// news.db는 리포에 없다(baseline) — createSchema로 임시 SQLite에 결정적 픽스처를 넣어 소스로 삼는다.
// 소스는 항상 { readOnly: true }로 열고 어떤 경로에서도 소스에 쓰지 않는다(DB 비파괴 · decisions (2)).
// verify는 두 매니페스트(소스·대상)를 받아 '전 행 대조 100%'를 기계 판정한다(§7 P2 완료 게이트의 마지막 조각).
// 불일치면 exit 1 + 어느 테이블·어느 PK가 갈렸는지 출력(P2 실행 phase의 운영 게이트가 이 exit 코드를 쓴다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSchema } from '../src/db/schema.js';
import { buildInventory } from '../scripts/db-migrate/inventory.mjs';
import { exportToNeutral } from '../scripts/db-migrate/export.mjs';
import { verifyManifests, verifySources } from '../scripts/db-migrate/verify.mjs';

const VERIFY_CLI = fileURLToPath(new URL('../scripts/db-migrate/verify.mjs', import.meta.url));

// 임시 디렉토리에 파일 기반 SQLite 소스를 만들고 seed(db) 콜백으로 픽스처를 넣는다.
function makeSource(seed) {
  const dir = mkdtempSync(join(tmpdir(), 'dbmig-vrf-'));
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
  return mkdtempSync(join(tmpdir(), 'dbmig-vrf-out-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

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

// 항목 1 — 같은 소스에서 낸 두 매니페스트는 ok:true.
test('verify: 같은 소스에서 낸 두 매니페스트는 ok:true', () => {
  const src = makeSource(seedFull);
  try {
    const a = buildInventory(src.path, { detailed: true });
    const b = buildInventory(src.path, { detailed: true });
    const result = verifyManifests(a, b);
    assert.equal(result.ok, true);
    for (const t of result.tables) {
      assert.equal(t.rowCountMatch, true, `${t.name} rowCountMatch`);
      assert.equal(t.digestMatch, true, `${t.name} digestMatch`);
    }
  } finally {
    cleanup(src.dir);
  }
});

// 항목 2 — 한 컬럼 값이 다른 두 소스: ok:false · 그 테이블 digestMatch:false · mismatchedPks에 정확히 그 PK.
test('verify: 한 행의 한 컬럼 값이 다르면 그 테이블 digestMatch:false + mismatchedPks에 정확히 그 PK', () => {
  const a = makeSource(seedFull);
  const b = makeSource((db) => {
    seedFull(db);
    // Article a1의 제목을 바꾼다(한 컬럼 값 차이).
    db.prepare("UPDATE Article SET title='제목2' WHERE articleId='a1'").run();
  });
  try {
    const ma = buildInventory(a.path, { detailed: true });
    const mb = buildInventory(b.path, { detailed: true });
    const result = verifyManifests(ma, mb);
    assert.equal(result.ok, false);
    const article = result.tables.find((t) => t.name === 'Article');
    assert.equal(article.rowCountMatch, true, 'rowCount는 같다(행 수 동일)');
    assert.equal(article.digestMatch, false, 'aggregateDigest가 갈린다');
    assert.deepEqual(article.mismatchedPks, ['a1'], '어긋난 PK를 정확히 지목한다');
    // 다른 테이블은 일치.
    const user = result.tables.find((t) => t.name === 'User');
    assert.equal(user.digestMatch, true);
  } finally {
    cleanup(a.dir);
    cleanup(b.dir);
  }
});

// 항목 3 — rowCount가 다르면 rowCountMatch:false.
test('verify: 한쪽에 행이 추가되면 rowCountMatch:false', () => {
  const a = makeSource(seedFull);
  const b = makeSource((db) => {
    seedFull(db);
    db.prepare("INSERT INTO User (userId, name) VALUES ('u3','박')").run();
  });
  try {
    const ma = buildInventory(a.path, { detailed: true });
    const mb = buildInventory(b.path, { detailed: true });
    const result = verifyManifests(ma, mb);
    assert.equal(result.ok, false);
    const user = result.tables.find((t) => t.name === 'User');
    assert.equal(user.rowCountMatch, false, 'rowCount 불일치');
  } finally {
    cleanup(a.dir);
    cleanup(b.dir);
  }
});

// 항목 4 — 테이블 하나가 없는 매니페스트: 테이블 집합 불일치로 ok:false.
test('verify: 테이블 집합이 다르면 ok:false (테이블 누락 감지)', () => {
  const src = makeSource(seedFull);
  try {
    const a = buildInventory(src.path, { detailed: true });
    const b = buildInventory(src.path, { detailed: true });
    // b에서 테이블 하나를 제거한다.
    delete b.tables.Photo;
    const result = verifyManifests(a, b);
    assert.equal(result.ok, false, '테이블 집합 불일치는 전체 실패');
    const photo = result.tables.find((t) => t.name === 'Photo');
    assert.ok(photo, 'Photo 항목이 결과에 나온다');
    assert.equal(photo.onlyIn, 'a', 'Photo는 a쪽에만 있다');
  } finally {
    cleanup(src.dir);
  }
});

// 항목 5 — 순서 비의존: INSERT 순서만 다른 두 소스는 ok:true(aggregateDigest 성질 통합 실증).
test('verify: INSERT 순서만 다른 두 소스는 ok:true (순서 비의존)', () => {
  const a = makeSource((db) => {
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (1,'a','edit')").run();
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (2,'a','status')").run();
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (3,'a','create')").run();
  });
  const b = makeSource((db) => {
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (3,'a','create')").run();
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (1,'a','edit')").run();
    db.prepare("INSERT INTO ArticleHistory (id, articleId, eventType) VALUES (2,'a','status')").run();
  });
  try {
    const result = verifyManifests(
      buildInventory(a.path, { detailed: true }),
      buildInventory(b.path, { detailed: true }),
    );
    assert.equal(result.ok, true, 'INSERT 순서는 판정에 영향 없다');
  } finally {
    cleanup(a.dir);
    cleanup(b.dir);
  }
});

// 항목 6 — export ↔ inventory 교차: export 매니페스트와 inventory 매니페스트가 ok:true(도구 간 정합).
test('verify: verifySources — export 디렉토리와 소스 SQLite가 ok:true (도구 간 정합)', () => {
  const src = makeSource(seedFull);
  const out = makeOutDir();
  try {
    exportToNeutral(src.path, out);
    const result = verifySources(src.path, out);
    assert.equal(result.ok, true, 'export 라운드트립 매니페스트와 소스 인벤토리가 일치');
  } finally {
    cleanup(src.dir);
    cleanup(out);
  }
});

// 항목 7 — CLI 게이트 계약: 일치면 exit 0, 불일치면 exit 1 + 갈린 테이블/PK 출력.
test('verify: CLI가 일치에 exit 0, 불일치에 exit 1 (운영 게이트 계약)', () => {
  const workdir = makeOutDir();
  const same = makeSource(seedFull);
  const diff = makeSource((db) => {
    seedFull(db);
    db.prepare("UPDATE Article SET title='다른제목' WHERE articleId='a1'").run();
  });
  try {
    const mSame = join(workdir, 'same.json');
    const mA = join(workdir, 'a.json');
    const mB = join(workdir, 'b.json');
    writeFileSync(mSame, JSON.stringify(buildInventory(same.path, { detailed: true })), 'utf8');
    writeFileSync(mA, JSON.stringify(buildInventory(same.path, { detailed: true })), 'utf8');
    writeFileSync(mB, JSON.stringify(buildInventory(diff.path, { detailed: true })), 'utf8');

    // 일치 → exit 0.
    const okOut = execFileSync('node', [VERIFY_CLI, mSame, mA], { encoding: 'utf8' });
    assert.match(okOut, /ok|일치|PASS/i);

    // 불일치 → exit 1 + 갈린 테이블/PK 출력.
    let threw = false;
    try {
      execFileSync('node', [VERIFY_CLI, mA, mB], { encoding: 'utf8' });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1, '불일치는 exit 1');
      const text = `${err.stdout || ''}${err.stderr || ''}`;
      assert.match(text, /Article/, '갈린 테이블 이름을 출력한다');
      assert.match(text, /a1/, '갈린 PK를 출력한다');
    }
    assert.equal(threw, true, '불일치 CLI는 비-0으로 종료해야 한다');
  } finally {
    cleanup(workdir);
    cleanup(same.dir);
    cleanup(diff.dir);
  }
});

// 항목 8 — --sources 플래그로 두 경로에서 매니페스트를 만들어 대조(일치 exit 0).
test('verify: CLI --sources 로 두 소스를 직접 대조 (일치 exit 0)', () => {
  const a = makeSource(seedFull);
  const b = makeSource(seedFull);
  try {
    const out = execFileSync('node', [VERIFY_CLI, '--sources', a.path, b.path], { encoding: 'utf8' });
    assert.match(out, /ok|일치|PASS/i);
  } finally {
    cleanup(a.dir);
    cleanup(b.dir);
  }
});
