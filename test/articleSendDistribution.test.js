// 송고 시점 즉시 배부 훅 테스트 — news.md "엠바고 규칙" + ADR-008 (4).
// 판정표(이 파일이 잠그는 계약):
//   엠바고 없음 → DPS : ['press','nonpress'] 즉시
//   2차만 설정  → DES : ['press'] 즉시(송고 시 바로 언론사) → 첫 배부가 실제 실행되면 DES→EPS 승격
//   1차·1+2차   → DES : 즉시 배부 없음 (1차 시각 배부는 phase 48 tick) → DES 유지
//   R의 RDS 송고 / hold·kill·approveDelete / 거부된 송고 : 배부 없음
// CRITICAL: 배부는 부수효과다 — 실패해도 송고(상태 전이)를 되돌리지 않고, applyAction의 동기 반환 계약도 바꾸지 않는다.
// CRITICAL: 승격 근거는 distribute 반환의 distributed(실제 스풀 기록 성공 목록)뿐이다.
//   ok만 true이고 전 수신처 쓰기가 실패한 경우(mode 'allFailed')에도 승격하면
//   **배부되지 않은 기사가 완결 처리**된다 — 아래 실패 격리 테스트가 그 회귀를 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createArticleService } from '../src/services/articleService.js';

const BODY = '{"format":"yh-editor","version":1,"blocks":[{"text":"본문"},{"text":"(끝)"}]}';

// 호출 인자를 기록하는 가짜 배부 서비스. 반환 shape은 실물(distributionService.distribute)과 동형이다:
//   { ok:true, distributed:[{targetId,kind,spoolDir,file}], failed:[{targetId,kind,reason}] }
// 모드는 네 가지 — 성공(ok) / 호출 자체 실패(fail) / 예외(reject) / 호출은 성공했으나 전 수신처 쓰기 실패(allFailed).
function fakeDistribution({ mode = 'ok' } = {}) {
  const calls = [];
  return {
    calls,
    async distribute(articleId, opts) {
      calls.push({ articleId, ...opts });
      if (mode === 'reject') throw new Error('스풀 접근 불가');
      if (mode === 'fail') return { ok: false, reason: 'spool-disabled' };
      const kinds = Array.isArray(opts && opts.kinds) ? opts.kinds : [];
      if (mode === 'allFailed') {
        // 스풀 쓰기가 전부 실패한 상황 — 배부된 kind가 하나도 없으므로 승격 근거가 될 수 없다.
        return { ok: true, distributed: [], failed: kinds.map((kind, i) => ({ targetId: i + 1, kind, reason: 'spool-write-failed' })) };
      }
      // 요청 kind마다 수신처 1곳에 실제로 기록됐다고 본다.
      return {
        ok: true,
        distributed: kinds.map((kind, i) => ({ targetId: i + 1, kind, spoolDir: `dir-${kind}`, file: `${articleId}_1.json` })),
        failed: [],
      };
    },
  };
}

const statusOf = (db, articleId) => db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status;
const statusHistory = (db, articleId) => db
  .prepare("SELECT action, fromStatus, toStatus FROM ArticleHistory WHERE articleId = ? AND eventType = 'status' ORDER BY id")
  .all(articleId)
  .map((h) => [h.action, h.fromStatus, h.toStatus]);

function setup({ distributionService, contents = {}, body = BODY } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const service = createArticleService({ articleModel, db, historyModel, distributionService });

  const { articleId } = service.create({ title: '제목', markupVersion: body, author: 'r1', ...contents });
  if (contents.status) articleModel.update(articleId, { contents: { status: contents.status } });
  return { db, service, articleId, articleModel };
}

// 훅은 fire-and-forget이므로 마이크로태스크 큐를 한 바퀴 비운 뒤 단언한다.
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('엠바고 없는 RDS 기사를 D가 송고 → DPS + press·nonpress 즉시 배부', async () => {
  const distributionService = fakeDistribution();
  const { service, articleId } = setup({ distributionService });

  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk1' });
  await flush();

  assert.deepEqual(r, { ok: true, status: 'DPS' });
  assert.equal(distributionService.calls.length, 1);
  assert.equal(distributionService.calls[0].articleId, articleId);
  assert.deepEqual(distributionService.calls[0].kinds, ['press', 'nonpress']);
  assert.equal(distributionService.calls[0].actorUserId, 'desk1');
});

test('2차 엠바고만 설정된 기사를 D가 송고 → DES + 언론사(press)만 즉시 배부 → 배부 성공 시 EPS 승격', async () => {
  const distributionService = fakeDistribution();
  const { service, articleId, db } = setup({
    distributionService, contents: { secondEmbargoAt: '2026-07-29T00:00:00.000Z' },
  });
  const counts = () => ({
    contents: db.prepare('SELECT COUNT(*) AS n FROM Contents').get().n,
    article: db.prepare('SELECT COUNT(*) AS n FROM Article').get().n,
  });

  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk1' });
  // 배부(비동기)가 끝나기 전 상태 — 송고 자체는 DES까지만 간다.
  const before = db.prepare('SELECT status, sender, sentAt FROM Contents WHERE articleId = ?').get(articleId);
  const countsBefore = counts();
  await flush();

  assert.deepEqual(r, { ok: true, status: 'DES' });
  assert.equal(before.status, 'DES');
  assert.equal(distributionService.calls.length, 1);
  assert.deepEqual(distributionService.calls[0].kinds, ['press']);

  const after = db.prepare('SELECT status, sender, sentAt FROM Contents WHERE articleId = ?').get(articleId);
  assert.equal(after.status, 'EPS', '첫 배부가 실제 실행되면 DES→EPS');
  // 승격은 status만 쓰는 present-only 업데이트다 — 송고자/송고시간·행 수는 변하지 않는다(DB 비파괴).
  assert.equal(after.sender, before.sender);
  assert.equal(after.sentAt, before.sentAt);
  assert.deepEqual(counts(), countsBefore);
  assert.deepEqual(statusHistory(db, articleId), [['send', 'RDS', 'DES'], ['embargo', 'DES', 'EPS']]);
});

test('1차 엠바고 설정 기사(1차만/1+2차)를 D가 송고 → DES + 즉시 배부 없음(시점 배부는 tick)', async () => {
  for (const contents of [
    { embargoAt: '2026-07-29T00:00:00.000Z' },
    { embargoAt: '2026-07-29T00:00:00.000Z', secondEmbargoAt: '2026-07-30T00:00:00.000Z' },
  ]) {
    const distributionService = fakeDistribution();
    const { service, articleId, db } = setup({ distributionService, contents });

    const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk1' });
    await flush();

    assert.deepEqual(r, { ok: true, status: 'DES' });
    assert.equal(distributionService.calls.length, 0, JSON.stringify(contents));
    assert.equal(statusOf(db, articleId), 'DES', JSON.stringify(contents));
    assert.deepEqual(statusHistory(db, articleId), [['send', 'RDS', 'DES']], JSON.stringify(contents));
  }
});

test('엠바고 설정된 DDH 기사를 D가 송고해도 DES + 전체 배부 없음(DDH 경로 누수 방어)', async () => {
  // phase 47 리뷰가 지적한 구멍: DDH 송고는 DPS로 떨어져 엠바고 기사가 press·nonpress 전량 배부됐다.
  for (const [contents, kinds] of [
    [{ embargoAt: '2026-07-29T00:00:00.000Z' }, []],
    [{ embargoAt: '2026-07-29T00:00:00.000Z', secondEmbargoAt: '2026-07-30T00:00:00.000Z' }, []],
    [{ secondEmbargoAt: '2026-07-30T00:00:00.000Z' }, ['press']],
  ]) {
    const distributionService = fakeDistribution();
    const { service, articleId, db } = setup({ distributionService, contents: { ...contents, status: 'DDH' } });

    const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk1' });
    await flush();

    const label = JSON.stringify(contents);
    assert.deepEqual(r, { ok: true, status: 'DES' }, label);
    assert.deepEqual(distributionService.calls.map((c) => c.kinds), kinds.length ? [kinds] : [], label);
    // 2차만 설정은 press 배부가 실행되므로 EPS로 승격되고, 1차 포함은 배부가 없어 DES에 머문다.
    assert.equal(statusOf(db, articleId), kinds.length ? 'EPS' : 'DES', label);
  }
});

test('R이 RDS 기사를 송고 → RDS 유지 + 배부 없음', async () => {
  const distributionService = fakeDistribution();
  const { service, articleId } = setup({ distributionService });

  const r = service.applyAction(articleId, 'R', 'send', { userId: 'r1' });
  await flush();

  assert.deepEqual(r, { ok: true, status: 'RDS' });
  assert.equal(distributionService.calls.length, 0);
});

test('hold/kill/approveDelete는 배부하지 않는다', async () => {
  for (const [status, role, action] of [
    ['RDS', 'D', 'hold'], ['RDS', 'D', 'kill'], ['DPS', 'D', 'approveDelete'], ['RDS', 'R', 'hold'],
  ]) {
    const distributionService = fakeDistribution();
    const { service, articleId } = setup({ distributionService, contents: { status } });

    const r = service.applyAction(articleId, role, action, { userId: 'desk1' });
    await flush();

    assert.equal(r.ok, true, `${status}/${role}/${action}`);
    assert.equal(distributionService.calls.length, 0, `${status}/${role}/${action}`);
  }
});

test('거부된 송고((끝) 마커 없음 / 정의 외 전이)는 배부하지 않는다', async () => {
  const noMarker = fakeDistribution();
  const a = setup({ distributionService: noMarker, body: '{"blocks":[{"text":"본문"}]}' });
  const r1 = a.service.applyAction(a.articleId, 'D', 'send', { userId: 'desk1' });
  await flush();
  assert.deepEqual(r1, { ok: false, reason: 'no-end-marker' });
  assert.equal(noMarker.calls.length, 0);

  // 레거시 EPS 행(마이그레이션하지 않는다)과 신규 DES 행 모두 재송고가 거부되고 배부도 없다.
  for (const status of ['EPS', 'DES']) {
    const badTransition = fakeDistribution();
    const b = setup({ distributionService: badTransition, contents: { status } });
    const r2 = b.service.applyAction(b.articleId, 'D', 'send', { userId: 'desk1' });
    await flush();
    assert.equal(r2.ok, false, status);
    assert.equal(badTransition.calls.length, 0, status);
    assert.equal(statusOf(b.db, b.articleId), status, status);
  }
});

test('DPS 재송고와 DDH→DPS 송고도 press·nonpress로 배부한다', async () => {
  for (const status of ['DPS', 'DDH']) {
    const distributionService = fakeDistribution();
    const { service, articleId } = setup({ distributionService, contents: { status } });

    const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk1' });
    await flush();

    assert.deepEqual(r, { ok: true, status: 'DPS' }, status);
    assert.deepEqual(distributionService.calls[0].kinds, ['press', 'nonpress'], status);
  }
});

test('배부 실패·예외는 송고 결과와 상태 전이·이력을 바꾸지 않는다', async () => {
  for (const mode of ['fail', 'reject', 'allFailed']) {
    const distributionService = fakeDistribution({ mode });
    const { service, articleId, db } = setup({ distributionService });

    const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk1' });
    await flush();

    assert.deepEqual(r, { ok: true, status: 'DPS' }, mode);
    assert.equal(db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status, 'DPS', mode);
    const hist = db.prepare("SELECT * FROM ArticleHistory WHERE articleId = ? AND eventType = 'status'").all(articleId);
    assert.equal(hist.length, 1, mode);
    assert.equal(hist[0].toStatus, 'DPS', mode);
  }
});

test('엠바고 기사: 배부가 실제로 실행되지 않으면 DES에 머물고 승격되지 않는다(거짓 완결 금지)', async () => {
  // ① {ok:false} ② 예외 ③ 호출은 성공했으나 전 수신처 스풀 쓰기 실패 — 셋 다 "배부된 kind 0건"이다.
  for (const mode of ['fail', 'reject', 'allFailed']) {
    const distributionService = fakeDistribution({ mode });
    const { service, articleId, db } = setup({
      distributionService, contents: { secondEmbargoAt: '2026-07-29T00:00:00.000Z' },
    });

    const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk1' });
    await flush();

    assert.deepEqual(r, { ok: true, status: 'DES' }, mode);
    assert.equal(distributionService.calls.length, 1, mode);
    assert.equal(statusOf(db, articleId), 'DES', mode);
    assert.deepEqual(statusHistory(db, articleId), [['send', 'RDS', 'DES']], mode);
  }
});

test('distributionService 미주입이면 송고는 기존과 동일하게 동작한다(하위호환)', async () => {
  const { service, articleId, db } = setup({});
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk1' });
  await flush();

  assert.deepEqual(r, { ok: true, status: 'DPS' });
  assert.equal(db.prepare('SELECT distributedAt FROM Contents WHERE articleId = ?').get(articleId).distributedAt, null);
});

test('applyAction은 동기 반환 계약을 유지한다(Promise를 돌려주지 않는다)', () => {
  const distributionService = fakeDistribution();
  const { service, articleId } = setup({ distributionService });
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk1' });
  assert.equal(typeof r.then, 'undefined');
  assert.equal(r.status, 'DPS');
});
