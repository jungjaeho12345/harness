// 송고 시점 즉시 배부 훅 테스트 — news.md "엠바고 규칙" + ADR-008 (4).
// 판정표(이 파일이 잠그는 계약):
//   엠바고 없음 → DPS : ['press','nonpress'] 즉시
//   2차만 설정  → EPS : ['press'] 즉시 (송고 시 바로 언론사)
//   1차·1+2차   → EPS : 즉시 배부 없음 (1차 시각 배부는 phase 48 tick)
//   R의 RDS 송고 / hold·kill·approveDelete / 거부된 송고 : 배부 없음
// CRITICAL: 배부는 부수효과다 — 실패해도 송고(상태 전이)를 되돌리지 않고, applyAction의 동기 반환 계약도 바꾸지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createArticleService } from '../src/services/articleService.js';

const BODY = '{"format":"yh-editor","version":1,"blocks":[{"text":"본문"},{"text":"(끝)"}]}';

// 호출 인자를 기록하는 가짜 배부 서비스.
function fakeDistribution({ mode = 'ok' } = {}) {
  const calls = [];
  return {
    calls,
    async distribute(articleId, opts) {
      calls.push({ articleId, ...opts });
      if (mode === 'reject') throw new Error('스풀 접근 불가');
      if (mode === 'fail') return { ok: false, reason: 'spool-disabled' };
      return { ok: true, distributed: [], failed: [] };
    },
  };
}

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

test('2차 엠바고만 설정된 기사를 D가 송고 → EPS + 언론사(press)만 즉시 배부', async () => {
  const distributionService = fakeDistribution();
  const { service, articleId } = setup({
    distributionService, contents: { secondEmbargoAt: '2026-07-29T00:00:00.000Z' },
  });

  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk1' });
  await flush();

  assert.deepEqual(r, { ok: true, status: 'EPS' });
  assert.equal(distributionService.calls.length, 1);
  assert.deepEqual(distributionService.calls[0].kinds, ['press']);
});

test('1차 엠바고 설정 기사(1차만/1+2차)를 D가 송고 → EPS + 즉시 배부 없음(시점 배부는 tick)', async () => {
  for (const contents of [
    { embargoAt: '2026-07-29T00:00:00.000Z' },
    { embargoAt: '2026-07-29T00:00:00.000Z', secondEmbargoAt: '2026-07-30T00:00:00.000Z' },
  ]) {
    const distributionService = fakeDistribution();
    const { service, articleId } = setup({ distributionService, contents });

    const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk1' });
    await flush();

    assert.deepEqual(r, { ok: true, status: 'EPS' });
    assert.equal(distributionService.calls.length, 0, JSON.stringify(contents));
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

  const badTransition = fakeDistribution();
  const b = setup({ distributionService: badTransition, contents: { status: 'EPS' } });
  const r2 = b.service.applyAction(b.articleId, 'D', 'send', { userId: 'desk1' });
  await flush();
  assert.equal(r2.ok, false);
  assert.equal(badTransition.calls.length, 0);
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
  for (const mode of ['fail', 'reject']) {
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
