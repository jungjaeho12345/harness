// phase 59 테스트 게이트 보강 — 기존 두 스위트가 잠그지 않은 경계 2곳.
// (1) 배치 중간 실패: 배치당 트랜잭션 계약의 실측 — 이전 배치 커밋분 보존 + 실패 배치 원자 롤백
//     + 원인 해소 후 재실행이 잔여만 이어서 완결(커밋분 재파생 없음). index.json decisions (7)·(8)의
//     "중간 실패에도 진행 보존, 멱등이라 재기동이 이어서 완결"은 문서로만 있었고 테스트가 없었다.
// (2) 배부 판정 무접점: 백필은 snapshotTitle만 만진다 — phase 57의 배부 사이클 판정
//     (distribute 행·failedAt·미해소 실패·재전송 목록)이 백필 전후 완전히 동일해야 한다.
//     failedAt의 원천은 distribute-failed 행의 createdAt(사실 컬럼)이다 — 백필이 스치면 회귀다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema, backfillHistoryTitles, HISTORY_TITLE_BACKFILL_BATCH } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createDistributionTargetModel } from '../src/models/distributionTargetModel.js';
import { createDistributionRetryService } from '../src/services/distributionRetryService.js';
import { unresolvedFailures } from '../src/services/distributionFailureLog.js';
import { cycleDistributedKinds, latestSendId } from '../src/services/embargoPolicy.js';
import { runHistoryTitleBackfill } from '../server/index.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  return db;
}

// 이력 행 삽입 — undefined 컬럼은 INSERT에서 제외(→ NULL 유지). 새 행의 id를 반환한다.
function insertRow(db, { articleId = 'a1', eventType = 'edit', createdAt = '2026-08-01T00:00:00Z', ...rest } = {}) {
  const obj = { articleId, eventType, createdAt, ...rest };
  const cols = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const ph = cols.map(() => '?').join(', ');
  return Number(
    db.prepare(`INSERT INTO ArticleHistory (${cols.join(', ')}) VALUES (${ph})`)
      .run(...cols.map((k) => obj[k])).lastInsertRowid,
  );
}

function titleOf(db, id) {
  return db.prepare('SELECT snapshotTitle FROM ArticleHistory WHERE id = ?').get(id).snapshotTitle;
}

function countNullTitles(db) {
  return db.prepare('SELECT count(*) AS n FROM ArticleHistory WHERE snapshotTitle IS NULL').get().n;
}

// 보강 1: 배치 중간 실패 — 이전 배치 커밋분 보존 + 실패 배치 원자 롤백 + 재실행 이어서 완결.
// 파생 접두사(D1/D2)를 실행 회차마다 다르게 주입해 "커밋분을 재파생하지 않는다"까지 값으로 증명한다.
test('backfillHistoryTitles: 2번째 배치 중간에서 deriveTitle이 throw — 1번째 배치 커밋분 보존, 실패 배치 원자 롤백, 재실행이 잔여만 이어서 완결', () => {
  const db = freshDb();
  const total = HISTORY_TITLE_BACKFILL_BATCH + 3; // 2번째 배치는 3행 — 그중 2번째 행에서 폭발시킨다.
  const ins = db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, createdAt, markupVersion) VALUES ('a1', 'edit', '2026-08-01T00:00:00Z', ?)",
  );
  for (let i = 1; i <= total; i += 1) ins.run(`제목 ${i}\n본문`);

  const boomFirstLine = `제목 ${HISTORY_TITLE_BACKFILL_BATCH + 2}`;
  const derive1 = (mv) => {
    const first = String(mv).split('\n')[0];
    if (first === boomFirstLine) throw new Error('derive-boom');
    return `D1:${first}`;
  };

  // 실패는 전파된다(조용한 삼킴 금지 — 부팅 중단 정책).
  assert.throws(() => backfillHistoryTitles(db, { deriveTitle: derive1 }), /derive-boom/);

  // 이전 배치(1..BATCH)의 커밋분은 보존된다 — 배치당 COMMIT의 실측.
  assert.equal(
    countNullTitles(db), 3,
    '1번째 배치만 커밋 — NULL 잔여는 실패 배치의 3행뿐',
  );
  assert.equal(titleOf(db, 1), 'D1:제목 1');
  assert.equal(titleOf(db, HISTORY_TITLE_BACKFILL_BATCH), `D1:제목 ${HISTORY_TITLE_BACKFILL_BATCH}`);
  // 실패 배치는 통째로 롤백 — throw **이전에** UPDATE된 첫 행(BATCH+1)도 NULL로 돌아간다(원자성).
  assert.strictEqual(titleOf(db, HISTORY_TITLE_BACKFILL_BATCH + 1), null, '실패 배치 선행 UPDATE도 롤백');
  assert.strictEqual(titleOf(db, HISTORY_TITLE_BACKFILL_BATCH + 2), null);
  assert.strictEqual(titleOf(db, total), null);

  // 원인 해소 후 재실행 — 잔여 3행만 채우고(이어서 완결), 이미 커밋된 행은 재파생하지 않는다.
  // ROLLBACK이 트랜잭션을 정리했다는 것도 여기서 함께 증명된다(열린 tx가 남았으면 BEGIN이 throw).
  const derive2 = (mv) => `D2:${String(mv).split('\n')[0]}`;
  assert.equal(backfillHistoryTitles(db, { deriveTitle: derive2 }), 3, '재실행은 잔여 3행만 채운다');
  assert.equal(countNullTitles(db), 0, '완결 — NULL 잔여 0');
  assert.equal(
    titleOf(db, HISTORY_TITLE_BACKFILL_BATCH), `D1:제목 ${HISTORY_TITLE_BACKFILL_BATCH}`,
    '커밋분은 재파생·덮어쓰기되지 않는다(D1 유지)',
  );
  assert.equal(titleOf(db, HISTORY_TITLE_BACKFILL_BATCH + 1), `D2:제목 ${HISTORY_TITLE_BACKFILL_BATCH + 1}`, '롤백됐던 행은 재실행 회차의 파생으로 채워진다');
  assert.equal(titleOf(db, total), `D2:제목 ${total}`);
});

// 보강 2: 배부 판정 무접점 — 백필 전후로 phase 57 판정 표면 5종이 완전히 동일하다.
// (a) queryDistributionEvents 행 자체(failedAt의 원천 createdAt·reason·targetId — 사실 컬럼)
// (b) unresolvedFailures 파생(failedAt 포함) (c) cycleDistributedKinds (d) latestSendId
// (e) distributionRetryService.list() 응답(HTTP로 나가는 실측 표면)
test('runHistoryTitleBackfill: 배부 사이클 판정과 무접점 — distribute 행·failedAt·미해소 실패·재전송 목록이 백필 전후 deep equal', () => {
  const db = freshDb();
  const articleId = 'AKR-DIST';
  db.prepare("INSERT INTO Contents (articleId, status) VALUES (?, 'DPS')").run(articleId);
  db.prepare(
    "INSERT INTO DistributionTarget (id, name, kind, spoolDir, active, createdAt) VALUES (7, '언론사A', 'press', 'spool-a', 'Y', '2026-08-01T00:00:00Z')",
  ).run();

  // 이력: 레거시 edit(백필 대상) → 송고 경계 → distribute(press) → distribute-failed(target 7) → 레거시 edit.
  const legacy1 = insertRow(db, { articleId, markupVersion: '제목줄A\n본문', createdAt: '2026-08-02T00:00:01Z' });
  insertRow(db, {
    articleId, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS', createdAt: '2026-08-02T00:00:02Z',
  });
  insertRow(db, { articleId, eventType: 'distribute', action: 'press', createdAt: '2026-08-02T00:00:03Z' });
  insertRow(db, {
    articleId, eventType: 'distribute-failed', action: 'press', targetId: 7,
    reason: 'spool-write-failed', createdAt: '2026-08-05T00:00:00Z',
  });
  const legacy2 = insertRow(db, { articleId, markupVersion: '제목줄B\n본문', createdAt: '2026-08-05T00:00:01Z' });

  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const targetModel = createDistributionTargetModel(db);
  const retryService = createDistributionRetryService({
    articleHistoryModel: historyModel, distributionTargetModel: targetModel, articleModel,
  });

  function judgmentSurfaces() {
    const distEvents = historyModel.queryDistributionEvents({ articleId });
    const historyRows = historyModel.queryByArticle(articleId);
    return {
      distEvents,
      failures: unresolvedFailures(distEvents),
      kinds: cycleDistributedKinds({ status: articleModel.getStatusById(articleId), historyRows }),
      boundary: latestSendId(historyRows),
      list: retryService.list(),
    };
  }

  const before = judgmentSurfaces();
  // 전제(공허 방지): 판정 표면이 실제로 살아 있는 상태에서 무접점을 증명한다.
  assert.equal(before.failures.length, 1, '전제: 미해소 실패 1건');
  assert.equal(before.failures[0].failedAt, '2026-08-05T00:00:00Z', '전제: failedAt = 실패 행 createdAt');
  assert.deepEqual(before.kinds, ['press'], '전제: 이번 사이클 press 배부됨');
  assert.equal(before.list.items.length, 1, '전제: 재전송 목록 1건');

  const filled = runHistoryTitleBackfill({ db });

  // 백필이 실제로 동작했다(공허 방지) — 레거시 edit 2행만 채워졌다.
  assert.equal(filled, 2);
  assert.equal(titleOf(db, legacy1), '제목줄A');
  assert.equal(titleOf(db, legacy2), '제목줄B');

  const after = judgmentSurfaces();
  assert.deepEqual(after.distEvents, before.distEvents, '배부 이벤트 행(사실 컬럼) 완전 불변');
  assert.deepEqual(after.failures, before.failures, '미해소 실패 파생(failedAt 포함) 불변');
  assert.deepEqual(after.kinds, before.kinds, '사이클 배부 kind 판정 불변');
  assert.strictEqual(after.boundary, before.boundary, '사이클 경계(latestSendId) 불변');
  assert.deepEqual(after.list, before.list, '재전송 목록 응답 불변');
});
