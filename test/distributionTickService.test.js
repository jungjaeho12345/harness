// 시점/엠바고 배부 tick 도메인 엔진 테스트 — phase 48 step1 (ADR-008 (3), ADR-006).
// 하네스: in-memory DB + 실제 articleModel/articleHistoryModel + 가짜 distributionService + 고정 now.
// CRITICAL: "무엇이 이미 배부됐는가/완결됐는가"의 판정 근거는 ArticleHistory(eventType='distribute')뿐이다
//   — distributedAt(마지막 시각 1개)이나 distribute() 반환값(실패 포함 가능)이 아니다.
//   전이 대상은 EPS만(EEH/EEK 부활 금지), 전이는 present-only(status만) + 이력 append-only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createDistributionTickService } from '../src/services/distributionTickService.js';

const NOW = '2026-07-28T05:00:00.000Z';
const PAST = '2026-07-28T04:00:00.000Z';   // now 이전 → 도래
const FUTURE = '2026-07-28T09:00:00.000Z'; // now 이후 → 도래 전
const A1 = 'AKR20260728000000001';
const A2 = 'AKR20260728000000002';

// 실물 distributionService와 동일한 사실 기록을 흉내내는 가짜:
//  - 성공한 kind마다 historyModel에 eventType='distribute', action=kind 이력 1행을 남긴다(tick의 완결 판정 근거).
//  - behavior를 주면 그 함수의 반환/부수효과로 대체(실패·미기록·pending·TOCTOU 재현용).
function fakeDistribution({ historyModel, now = () => NOW, behavior } = {}) {
  const calls = [];
  async function distribute(articleId, { kinds, actorUserId = null } = {}) {
    calls.push({ articleId, kinds, actorUserId });
    if (behavior) return behavior({ articleId, kinds, actorUserId });
    const distributed = [];
    for (const kind of kinds) {
      historyModel.insert({ articleId, eventType: 'distribute', action: kind, actorUserId, createdAt: now() });
      distributed.push({ targetId: `t-${kind}`, kind, spoolDir: kind, file: `/spool/${kind}/${articleId}.json` });
    }
    return { ok: true, distributed, failed: [] };
  }
  return { calls, distribute };
}

function setup({ now = () => NOW, distribution, withService = true } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const dist = distribution ?? fakeDistribution({ historyModel, now });
  const service = createDistributionTickService({
    articleModel,
    historyModel,
    distributionService: withService ? dist : undefined,
    now,
  });
  return { db, articleModel, historyModel, dist, service };
}

function insertEps(articleModel, { articleId, embargoAt, secondEmbargoAt } = {}) {
  articleModel.insert({
    article: { articleId, title: '제목' },
    contents: {
      articleId, title: '제목', author: 'r1', status: 'EPS',
      createdAt: '2026-07-28T00:00:00.000Z', sentAt: PAST,
      embargoAt, secondEmbargoAt,
    },
  });
}

const statusOf = (db, id) => db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(id).status;
const distActions = (db, id) => db.prepare(
  "SELECT action FROM ArticleHistory WHERE articleId = ? AND eventType = 'distribute' ORDER BY id",
).all(id).map((r) => r.action);
const historyRows = (db, id) => db.prepare('SELECT * FROM ArticleHistory WHERE articleId = ? ORDER BY id').all(id);

test('runTick만 노출한다(HTTP/세션/타이머 진입점 없음)', () => {
  const { service } = setup();
  assert.deepEqual(Object.keys(service).sort(), ['runTick']);
});

// 1) 1차 엠바고 도래 → press만 배부, nonpress 호출 없음.
test('1차만 설정·도래: press만 배부한다(nonpress 미포함)', async () => {
  const { service, dist, db, articleModel } = setup();
  insertEps(articleModel, { articleId: A1, embargoAt: PAST });

  const r = await service.runTick({ actorUserId: 'sys' });

  assert.equal(r.ok, true);
  assert.equal(r.checked, 1);
  assert.equal(dist.calls.length, 1);
  assert.deepEqual(dist.calls[0].kinds, ['press']);
  assert.deepEqual(distActions(db, A1), ['press']);
});

// 2) 1+2차에서 1차만 도래 → press 배부 후 EPS 유지, incomplete missing nonpress.
test('1+2차 중 1차만 도래: press 배부 후 EPS 유지·incomplete(missing nonpress)', async () => {
  const { service, dist, db, articleModel } = setup();
  insertEps(articleModel, { articleId: A1, embargoAt: PAST, secondEmbargoAt: FUTURE });

  const r = await service.runTick({ actorUserId: 'sys' });

  assert.deepEqual(dist.calls[0].kinds, ['press']);
  assert.deepEqual(distActions(db, A1), ['press']);
  assert.equal(statusOf(db, A1), 'EPS', '2차 미도래 → 완결 아님 → EPS 유지');
  assert.deepEqual(r.completed, []);
  assert.deepEqual(r.incomplete, [{ articleId: A1, missing: ['nonpress'] }]);
  assert.deepEqual(r.distributed, [{ articleId: A1, kinds: ['press'] }]);
});

// 3) 1+2차 둘 다 도래 → press+nonpress 배부 → DPS, completed, 이력 1행.
test('1+2차 둘 다 도래: 전량 배부 → DPS 전이 + embargoComplete 이력', async () => {
  const { service, db, articleModel } = setup();
  insertEps(articleModel, { articleId: A1, embargoAt: PAST, secondEmbargoAt: PAST });

  const r = await service.runTick({ actorUserId: 'sys' });

  assert.deepEqual(distActions(db, A1), ['press', 'nonpress']);
  assert.equal(statusOf(db, A1), 'DPS');
  assert.deepEqual(r.completed, [A1]);
  assert.deepEqual(r.incomplete, []);
  assert.deepEqual(r.distributed, [{ articleId: A1, kinds: ['press', 'nonpress'] }]);

  const trans = historyRows(db, A1).filter((h) => h.eventType === 'status' && h.action === 'embargoComplete');
  assert.equal(trans.length, 1);
  assert.equal(trans[0].fromStatus, 'EPS');
  assert.equal(trans[0].toStatus, 'DPS');
  assert.equal(trans[0].actorUserId, 'sys');
});

// 4) 멱등: 같은 조건으로 2회 연속 → 2회차 distribute 0건, 이력 불변, DPS 유지, checked 감소.
test('멱등: 반복 tick은 재배부 0건·이력 불변, DPS 유지', async () => {
  const { service, dist, db, articleModel } = setup();
  insertEps(articleModel, { articleId: A1, embargoAt: PAST, secondEmbargoAt: PAST });

  const r1 = await service.runTick({ actorUserId: 'sys' });
  const callsAfter1 = dist.calls.length;
  const histAfter1 = historyRows(db, A1).length;

  const r2 = await service.runTick({ actorUserId: 'sys' });

  assert.equal(r1.checked, 1);
  assert.equal(r2.checked, 0, '2회차엔 EPS 후보가 없다(이미 DPS)');
  assert.equal(dist.calls.length, callsAfter1, '2회차 distribute 호출 0건');
  assert.equal(historyRows(db, A1).length, histAfter1, '2회차 이력 증가 0');
  assert.equal(statusOf(db, A1), 'DPS');
  assert.deepEqual(r2.distributed, []);
  assert.deepEqual(r2.completed, []);
});

// 5) 부분 배부 후 재tick: 1차만 끝난 상태에서 2차 시각 지난 뒤 → nonpress만 배부 → 완결.
test('부분 배부 후 재tick: nonpress만 배부(press 재배부 0)하고 완결 전이', async () => {
  const { service, db, articleModel } = setup({ now: () => NOW });
  // 1차만 도래한 상태로 첫 tick.
  insertEps(articleModel, { articleId: A1, embargoAt: PAST, secondEmbargoAt: FUTURE });
  await service.runTick({ actorUserId: 'sys' });
  assert.deepEqual(distActions(db, A1), ['press']);
  assert.equal(statusOf(db, A1), 'EPS');

  // 시계를 2차 도래 이후로 옮긴 새 서비스(같은 db/모델).
  const later = createDistributionTickService({
    articleModel,
    historyModel: createArticleHistoryModel(db),
    distributionService: fakeDistribution({ historyModel: createArticleHistoryModel(db), now: () => '2026-07-28T10:00:00.000Z' }),
    now: () => '2026-07-28T10:00:00.000Z',
  });
  const r = await later.runTick({ actorUserId: 'sys' });

  assert.deepEqual(distActions(db, A1), ['press', 'nonpress'], 'press는 재배부되지 않고 nonpress만 추가');
  assert.equal(statusOf(db, A1), 'DPS');
  assert.deepEqual(r.completed, [A1]);
  assert.deepEqual(r.distributed, [{ articleId: A1, kinds: ['nonpress'] }]);
});

// 6) 2차만 설정된 기사: 송고 훅이 남긴 distribute/press 이력이 있는 EPS → press 재배부 없이 2차 도래 시 nonpress만 → DPS.
test('2차만 설정 + 기존 press 이력: press 재배부 없이 nonpress만 배부 → DPS', async () => {
  const { service, dist, db, articleModel, historyModel } = setup();
  insertEps(articleModel, { articleId: A1, secondEmbargoAt: PAST }); // embargoAt 없음(2차만)
  // 송고 시점 즉시 배부된 press 이력.
  historyModel.insert({ articleId: A1, eventType: 'distribute', action: 'press', actorUserId: 'desk1', createdAt: PAST });

  const r = await service.runTick({ actorUserId: 'sys' });

  assert.equal(dist.calls.length, 1);
  assert.deepEqual(dist.calls[0].kinds, ['nonpress'], 'press는 required 아님(도래 대상 아님) → 재배부 없음');
  assert.deepEqual(distActions(db, A1), ['press', 'nonpress']);
  assert.equal(statusOf(db, A1), 'DPS');
  assert.deepEqual(r.completed, [A1]);
});

// 7) 도래 전: 미래 엠바고 → distribute 0건, EPS 유지, incomplete 표면화.
test('도래 전: 미래 엠바고는 배부 0건·EPS 유지·incomplete', async () => {
  const { service, dist, db, articleModel } = setup();
  insertEps(articleModel, { articleId: A1, embargoAt: FUTURE, secondEmbargoAt: FUTURE });

  const r = await service.runTick({ actorUserId: 'sys' });

  assert.equal(dist.calls.length, 0);
  assert.deepEqual(distActions(db, A1), []);
  assert.equal(statusOf(db, A1), 'EPS');
  assert.deepEqual(r.completed, []);
  assert.deepEqual(r.incomplete, [{ articleId: A1, missing: ['press', 'nonpress'] }]);
  assert.deepEqual(r.distributed, []);
});

// 8) 파싱 불가 값: embargoAt='곧' → 배부 0건, EPS 유지, 예외 없음.
test('파싱 불가 엠바고 값: 배부 0건·EPS 유지·예외 없음(fail-safe)', async () => {
  const { service, dist, db, articleModel } = setup();
  insertEps(articleModel, { articleId: A1, embargoAt: '곧' });

  const r = await service.runTick({ actorUserId: 'sys' });

  assert.equal(r.ok, true);
  assert.equal(dist.calls.length, 0);
  assert.equal(statusOf(db, A1), 'EPS');
  assert.deepEqual(r.incomplete, [{ articleId: A1, missing: ['press'] }]);
});

// 9) TOCTOU: 목록 조회 후 처리 직전에 status가 EEK로 바뀐 기사 → 배부/전이 0건, DPS로 되살아나지 않는다.
test('TOCTOU: 조회 후 KILL(EEK)된 기사는 배부·전이하지 않는다', async () => {
  const { service, dist, db, articleModel } = setup();
  insertEps(articleModel, { articleId: A1, embargoAt: PAST, secondEmbargoAt: PAST });

  // 목록 조회 직후 데스크가 KILL한 상황을 재현: query가 stale EPS 스냅샷을 돌려주되 실제 행은 EEK로 전이.
  const realQuery = articleModel.query;
  articleModel.query = (f) => {
    const rows = realQuery(f);
    db.prepare("UPDATE Contents SET status = 'EEK' WHERE articleId = ?").run(A1);
    return rows;
  };

  const r = await service.runTick({ actorUserId: 'sys' });

  assert.equal(dist.calls.length, 0, '죽은 기사에 배부하지 않는다');
  assert.equal(statusOf(db, A1), 'EEK', 'DPS로 부활하지 않는다');
  assert.deepEqual(r.completed, []);
  assert.equal(r.checked, 1, '후보로 훑긴 했으므로 checked에는 잡힌다');
});

// 10) 배부 실패: distribute가 {ok:true, distributed:[], failed:[...]}(이력 미기록) → 완결 전이 없음, EPS 유지, incomplete.
test('배부 실패(이력 미기록): 완결 전이 없음·EPS 유지·incomplete', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  insertEps(articleModel, { articleId: A1, embargoAt: PAST, secondEmbargoAt: PAST });

  const dist = fakeDistribution({
    historyModel,
    behavior: () => ({ ok: true, distributed: [], failed: [{ targetId: 't', reason: 'spool-write-failed' }] }),
  });
  const service = createDistributionTickService({ articleModel, historyModel, distributionService: dist, now: () => NOW });

  const r = await service.runTick({ actorUserId: 'sys' });

  assert.equal(dist.calls.length, 1);
  assert.deepEqual(distActions(db, A1), [], '이력 미기록 → 완결 근거 없음');
  assert.equal(statusOf(db, A1), 'EPS');
  assert.deepEqual(r.completed, []);
  assert.deepEqual(r.distributed, [], '실제 스풀 기록 성공분 0');
  assert.deepEqual(r.incomplete, [{ articleId: A1, missing: ['press', 'nonpress'] }]);
});

// 11) single-flight: 진행 중 두 번째 호출은 tick-in-progress, distribute 추가 호출 0건. 끝난 뒤 재실행 가능.
test('single-flight: 진행 중 재호출은 tick-in-progress이고 끝나면 다시 실행 가능', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  insertEps(articleModel, { articleId: A1, embargoAt: PAST }); // 1차만 → press 배부 후 완결

  const calls = [];
  let release;
  const gate = new Promise((res) => { release = res; });
  const dist = {
    calls,
    async distribute(articleId, { kinds, actorUserId }) {
      calls.push({ articleId, kinds });
      await gate;
      for (const k of kinds) historyModel.insert({ articleId, eventType: 'distribute', action: k, actorUserId, createdAt: NOW });
      return { ok: true, distributed: kinds.map((k) => ({ kind: k })), failed: [] };
    },
  };
  const service = createDistributionTickService({ articleModel, historyModel, distributionService: dist, now: () => NOW });

  const p1 = service.runTick({ actorUserId: 'sys' }); // 첫 호출: distribute await에서 정지
  const r2 = await service.runTick({ actorUserId: 'sys' }); // 겹친 호출

  assert.deepEqual(r2, { ok: false, reason: 'tick-in-progress' });
  assert.equal(calls.length, 1, '겹친 tick은 아무 배부도 하지 않는다');

  release();
  const r1 = await p1;
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.completed, [A1]);

  const r3 = await service.runTick({ actorUserId: 'sys' }); // 플래그 해제 후 재실행 가능
  assert.equal(r3.ok, true);
  assert.equal(r3.checked, 0);
});

// 12) distributionService 미주입 → spool-disabled, DB 무변경(읽지도 않는다).
test('distributionService 미주입: spool-disabled로 거부하고 DB를 건드리지 않는다', async () => {
  const { service, db, articleModel } = setup({ withService: false });
  insertEps(articleModel, { articleId: A1, embargoAt: PAST, secondEmbargoAt: PAST });
  const before = statusOf(db, A1);

  const r = await service.runTick({ actorUserId: 'sys' });

  assert.deepEqual(r, { ok: false, reason: 'spool-disabled' });
  assert.equal(statusOf(db, A1), before);
  assert.equal(historyRows(db, A1).length, 0);
});

// invalid-clock: now가 오프셋 없는/파싱 불가 값 → invalid-clock, 배부 0건.
test('invalid-clock: 파싱 불가 now → invalid-clock으로 배부 0건', async () => {
  const { service, dist, db, articleModel } = setup({ now: () => '곧' });
  insertEps(articleModel, { articleId: A1, embargoAt: PAST });

  const r = await service.runTick({ actorUserId: 'sys' });

  assert.deepEqual(r, { ok: false, reason: 'invalid-clock' });
  assert.equal(dist.calls.length, 0);
  assert.equal(statusOf(db, A1), 'EPS');
});

// 13) DB 비파괴: tick 전후 Article/Contents 행 수 동일, 기존 이력 행 소실 0(이력은 증가만).
test('DB 비파괴: 행 수 불변·기존 이력 보존(이력은 증가만)', async () => {
  const { service, db, articleModel, historyModel } = setup();
  insertEps(articleModel, { articleId: A1, embargoAt: PAST, secondEmbargoAt: PAST });
  historyModel.insert({
    articleId: A1, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'EPS',
    actorUserId: 'desk1', createdAt: PAST,
  });
  const counts = () => ({
    article: db.prepare('SELECT COUNT(*) c FROM Article').get().c,
    contents: db.prepare('SELECT COUNT(*) c FROM Contents').get().c,
  });
  const before = counts();
  const histBefore = historyRows(db, A1).length;

  await service.runTick({ actorUserId: 'sys' });

  assert.deepEqual(counts(), before, 'Article/Contents 행 수 불변');
  assert.ok(historyRows(db, A1).length > histBefore, '이력은 증가만');
  assert.equal(
    historyRows(db, A1).filter((h) => h.eventType === 'status' && h.action === 'send').length,
    1,
    '기존 송고 이력 보존',
  );
});

// 14) 격리: 한 기사에서 예외가 나도 다른 기사는 정상 처리된다.
test('격리: 한 기사에서 예외가 나도 나머지 기사는 처리되고 예외 기사는 incomplete로 표면화', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  insertEps(articleModel, { articleId: A1, embargoAt: PAST }); // 정상 처리 → 완결
  insertEps(articleModel, { articleId: A2, embargoAt: PAST }); // distribute에서 예외

  const dist = {
    calls: [],
    async distribute(articleId, { kinds, actorUserId }) {
      this.calls.push({ articleId, kinds });
      if (articleId === A2) throw new Error('배부 폭발');
      for (const k of kinds) historyModel.insert({ articleId, eventType: 'distribute', action: k, actorUserId, createdAt: NOW });
      return { ok: true, distributed: kinds.map((k) => ({ kind: k })), failed: [] };
    },
  };
  const service = createDistributionTickService({ articleModel, historyModel, distributionService: dist, now: () => NOW });

  const r = await service.runTick({ actorUserId: 'sys' });

  assert.equal(r.ok, true);
  assert.ok(r.completed.includes(A1), '정상 기사는 완결된다');
  assert.equal(statusOf(db, A1), 'DPS');
  assert.equal(statusOf(db, A2), 'EPS', '예외 기사는 전이되지 않는다');
  assert.ok(r.incomplete.some((i) => i.articleId === A2), '예외 기사는 incomplete로 표면화');
});
