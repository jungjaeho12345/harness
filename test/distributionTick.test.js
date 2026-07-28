// 시점 배부 오케스트레이션 테스트 — ADR-008 (3)(5).
// 하네스: in-memory DB + 실제 모델 + 실제 distributionService(가짜 spoolWriter) + 실제 articleService.
// CRITICAL: 완결 판정은 ArticleHistory distribute 이력 kind 기준. EPS→DPS 전이는 present-only(status만).
//   멱등: 두 번째 tick·이미 전이된 기사는 재배부/중복 이력/재전이 없음. DB 비파괴(행 삭제 0).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createDistributionTargetModel } from '../src/models/distributionTargetModel.js';
import { createDistributionService } from '../src/services/distributionService.js';
import { createArticleService } from '../src/services/articleService.js';

const T1 = '2026-07-28T09:00:00.000Z';
const T2 = '2026-07-28T18:00:00.000Z';
const BEFORE = '2026-07-28T08:00:00.000Z';
const BETWEEN = '2026-07-28T12:00:00.000Z';
const AFTER = '2026-07-28T20:00:00.000Z';

function fakeWriter({ failFor = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    async write(args) {
      calls.push(args);
      if (failFor.has(args.spoolDir)) return { ok: false, reason: 'spool-write-failed' };
      return { ok: true, file: `/spool/${args.spoolDir}/${args.articleId}.json` };
    },
  };
}

function setup({ writer = fakeWriter(), targets = [{ name: 'kbs', kind: 'press', spoolDir: 'kbs' }, { name: 'blog', kind: 'nonpress', spoolDir: 'blog' }], withService = true } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const distributionTargetModel = createDistributionTargetModel(db);
  for (const t of targets) {
    distributionTargetModel.insert({ active: 'Y', createdAt: T1, updatedAt: T1, ...t });
  }
  const distributionService = withService
    ? createDistributionService({ distributionTargetModel, articleModel, historyModel, spoolWriter: writer, now: () => BETWEEN })
    : undefined;
  const articleService = createArticleService({ articleModel, db, historyModel, distributionService });
  return { db, articleModel, historyModel, distributionTargetModel, distributionService, articleService, writer };
}

let seq = 0;
function insertEps(articleModel, { embargoAt, secondEmbargoAt } = {}) {
  seq += 1;
  const articleId = `AKR2026072800000000${seq}`;
  articleModel.insert({
    article: { articleId, title: '제목', markupVersion: '{"blocks":[{"text":"본문 (끝)"}]}' },
    contents: {
      articleId, title: '제목', author: 'r1', status: 'EPS',
      createdAt: '2026-07-28T00:00:00.000Z', sentAt: '2026-07-28T05:00:00.000Z',
      embargoAt: embargoAt ?? '', secondEmbargoAt: secondEmbargoAt ?? '',
    },
  });
  return articleId;
}

const contentsOf = (db, id) => db.prepare('SELECT * FROM Contents WHERE articleId = ?').get(id);
const distKinds = (historyModel, id) => historyModel.queryByArticle(id).filter((r) => r.eventType === 'distribute').map((r) => r.action);
const statusEvents = (historyModel, id) => historyModel.queryByArticle(id).filter((r) => r.eventType === 'status');
const rowCount = (db, table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;

test('distributionService 미주입이면 tick은 no-op { ok:true, distributed:[], completed:[] }', async () => {
  const { articleService, articleModel } = setup({ withService: false });
  insertEps(articleModel, { embargoAt: T1 });
  const r = await articleService.distributionTick({ now: AFTER });
  assert.deepEqual(r, { ok: true, distributed: [], completed: [] });
});

test('1차만 EPS, now < embargoAt → 배부·전이 없음(EPS 유지, 파일 쓰기 0)', async () => {
  const { articleService, articleModel, writer, db, historyModel } = setup();
  const id = insertEps(articleModel, { embargoAt: T1 });
  const r = await articleService.distributionTick({ now: BEFORE });
  assert.deepEqual(r.distributed, []);
  assert.deepEqual(r.completed, []);
  assert.equal(writer.calls.length, 0);
  assert.equal(contentsOf(db, id).status, 'EPS');
  assert.deepEqual(distKinds(historyModel, id), []);
});

test('1차만 EPS, now >= embargoAt → press 배부 + distributedAt + distribute:press 이력 + EPS→DPS + status:embargoComplete', async () => {
  const { articleService, articleModel, writer, db, historyModel } = setup();
  const id = insertEps(articleModel, { embargoAt: T1 });
  const r = await articleService.distributionTick({ now: BETWEEN });
  assert.deepEqual(r.distributed, [{ articleId: id, kinds: ['press'] }]);
  assert.deepEqual(r.completed, [id]);
  // press 대상(kbs)에만 쓴다.
  assert.deepEqual(writer.calls.map((c) => c.spoolDir), ['kbs']);
  const c = contentsOf(db, id);
  assert.equal(c.status, 'DPS');
  assert.ok(c.distributedAt, 'distributedAt 기록');
  assert.deepEqual(distKinds(historyModel, id), ['press']);
  const st = statusEvents(historyModel, id);
  assert.equal(st.length, 1);
  assert.equal(st[0].action, 'embargoComplete');
  assert.equal(st[0].fromStatus, 'EPS');
  assert.equal(st[0].toStatus, 'DPS');
});

test('2차만 EPS(송고 시 press 이력 존재), now >= secondEmbargoAt → nonpress 배부 + 완결 → DPS', async () => {
  const { articleService, articleModel, historyModel, writer, db } = setup();
  const id = insertEps(articleModel, { secondEmbargoAt: T2 });
  // 송고 훅이 이미 press를 즉시 배부한 상황을 재현.
  historyModel.insert({ articleId: id, eventType: 'distribute', action: 'press', actorUserId: 'r1', createdAt: '2026-07-28T05:00:00.000Z' });
  const r = await articleService.distributionTick({ now: AFTER });
  assert.deepEqual(r.distributed, [{ articleId: id, kinds: ['nonpress'] }]);
  assert.deepEqual(r.completed, [id]);
  assert.deepEqual(writer.calls.map((c) => c.spoolDir), ['blog']);
  assert.equal(contentsOf(db, id).status, 'DPS');
});

test('1+2차 EPS: 1차만 지나면 press만·미완결(EPS), 2차도 지나면 nonpress·완결(DPS)', async () => {
  const { articleService, articleModel, writer, db, historyModel } = setup();
  const id = insertEps(articleModel, { embargoAt: T1, secondEmbargoAt: T2 });
  // 1차만 도래.
  const r1 = await articleService.distributionTick({ now: BETWEEN });
  assert.deepEqual(r1.distributed, [{ articleId: id, kinds: ['press'] }]);
  assert.deepEqual(r1.completed, []);
  assert.equal(contentsOf(db, id).status, 'EPS');
  assert.deepEqual(distKinds(historyModel, id).sort(), ['press']);
  // 2차 도래.
  const r2 = await articleService.distributionTick({ now: AFTER });
  assert.deepEqual(r2.distributed, [{ articleId: id, kinds: ['nonpress'] }]);
  assert.deepEqual(r2.completed, [id]);
  assert.equal(contentsOf(db, id).status, 'DPS');
  assert.deepEqual(distKinds(historyModel, id).sort(), ['nonpress', 'press']);
  assert.deepEqual(writer.calls.map((c) => c.spoolDir), ['kbs', 'blog']);
});

test('멱등성: 이미 배부·전이된 기사에 tick 재실행 → 추가 파일 쓰기 0·중복 이력 0·DPS 유지', async () => {
  const { articleService, articleModel, writer, db, historyModel } = setup();
  const id = insertEps(articleModel, { embargoAt: T1 });
  await articleService.distributionTick({ now: BETWEEN });
  const callsAfter1 = writer.calls.length;
  const r2 = await articleService.distributionTick({ now: AFTER });
  assert.deepEqual(r2.distributed, []);
  assert.deepEqual(r2.completed, []);
  assert.equal(writer.calls.length, callsAfter1, '재배부 없음');
  assert.equal(contentsOf(db, id).status, 'DPS');
  assert.deepEqual(distKinds(historyModel, id), ['press']);
  assert.equal(statusEvents(historyModel, id).length, 1, 'status 이력 1건 유지');
});

test('활성 대상 0으로 배부 실패 → 이력 없음·미완결·EPS 유지(다음 tick 재시도 가능)', async () => {
  const { articleService, articleModel, db, historyModel } = setup({ targets: [] });
  const id = insertEps(articleModel, { embargoAt: T1 });
  const r = await articleService.distributionTick({ now: BETWEEN });
  assert.deepEqual(r.completed, []);
  assert.equal(contentsOf(db, id).status, 'EPS');
  assert.deepEqual(distKinds(historyModel, id), []);
});

test('스풀 쓰기 실패해도 tick 전체는 멈추지 않고 EPS 유지', async () => {
  const writer = fakeWriter({ failFor: new Set(['kbs']) });
  const { articleService, articleModel, db } = setup({ writer });
  const id = insertEps(articleModel, { embargoAt: T1 });
  const r = await articleService.distributionTick({ now: BETWEEN });
  assert.equal(r.ok, true);
  assert.deepEqual(r.completed, []);
  assert.equal(contentsOf(db, id).status, 'EPS');
});

test('여러 EPS 기사를 한 tick에서 각각 독립 처리', async () => {
  const { articleService, articleModel, db } = setup();
  const a = insertEps(articleModel, { embargoAt: T1 }); // 완결 예정
  const b = insertEps(articleModel, { embargoAt: AFTER }); // 미도래
  const r = await articleService.distributionTick({ now: BETWEEN });
  assert.deepEqual(r.completed, [a]);
  assert.equal(contentsOf(db, a).status, 'DPS');
  assert.equal(contentsOf(db, b).status, 'EPS');
});

test('DB 비파괴: tick 전후 행 삭제 0(Article/Contents/DistributionTarget/ArticleHistory 감소 없음)', async () => {
  const { articleService, articleModel, db } = setup();
  insertEps(articleModel, { embargoAt: T1 });
  const before = ['Article', 'Contents', 'DistributionTarget', 'ArticleHistory'].map((t) => rowCount(db, t));
  await articleService.distributionTick({ now: BETWEEN });
  const after = ['Article', 'Contents', 'DistributionTarget', 'ArticleHistory'].map((t) => rowCount(db, t));
  for (let i = 0; i < before.length; i += 1) assert.ok(after[i] >= before[i], '행 감소 없음');
  // Article/Contents/DistributionTarget는 개수 불변(추가는 ArticleHistory에만).
  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.equal(after[2], before[2]);
});

test('EPS→DPS 전이는 present-only(status만 변경, sentAt·본문 불변)', async () => {
  const { articleService, articleModel, db } = setup();
  const id = insertEps(articleModel, { embargoAt: T1 });
  const before = contentsOf(db, id);
  await articleService.distributionTick({ now: BETWEEN });
  const after = contentsOf(db, id);
  assert.equal(after.status, 'DPS');
  assert.equal(after.sentAt, before.sentAt, 'sentAt 불변');
  assert.equal(after.author, before.author, 'author 불변');
  assert.equal(after.embargoAt, before.embargoAt, 'embargoAt 불변');
});
