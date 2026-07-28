// 엠바고 완결(EPS→DPS) 판정 테스트 — ADR-008 (5) + news.md "엠바고 규칙"(256~263행).
// requiredDistributionKinds: "엠바고 설정 → 요구 배부 kind" 매핑의 단일 출처(순수 함수).
// completeEmbargoDistribution: 요구 배부 집합이 전부 배부 완료됐을 때만 EPS→DPS 전이(멱등, 동기).
// 시점 판정(tick)은 이 step의 범위가 아니다 — 여기선 "이미 배부된 이력"만 근거로 삼는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createArticleService, requiredDistributionKinds } from '../src/services/articleService.js';

const BODY = '{"format":"yh-editor","version":1,"blocks":[{"text":"본문"},{"text":"(끝)"}]}';

function setup({ withHistory = true, contents = {}, status = 'EPS' } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = withHistory ? createArticleHistoryModel(db) : undefined;
  const service = createArticleService({ articleModel, db, historyModel });

  const { articleId } = service.create({ title: '제목', markupVersion: BODY, author: 'r1', ...contents });
  articleModel.update(articleId, { contents: { status } });
  return { db, service, articleId, articleModel, historyModel };
}

function recordDistribute(historyModel, articleId, kind) {
  historyModel.insert({ articleId, eventType: 'distribute', action: kind, actorUserId: null, createdAt: new Date().toISOString() });
}

// ---- requiredDistributionKinds (순수 판정표) ----

test('requiredDistributionKinds: 1차만 설정 → press', () => {
  assert.deepEqual(requiredDistributionKinds({ embargoAt: '2026-07-29T00:00:00.000Z' }), ['press']);
});

test('requiredDistributionKinds: 2차만 설정 → press,nonpress', () => {
  assert.deepEqual(requiredDistributionKinds({ secondEmbargoAt: '2026-07-29T00:00:00.000Z' }), ['press', 'nonpress']);
});

test('requiredDistributionKinds: 1+2차 설정 → press,nonpress', () => {
  assert.deepEqual(requiredDistributionKinds({
    embargoAt: '2026-07-29T00:00:00.000Z', secondEmbargoAt: '2026-07-30T00:00:00.000Z',
  }), ['press', 'nonpress']);
});

test('requiredDistributionKinds: 둘 다 없음 → 빈 배열', () => {
  assert.deepEqual(requiredDistributionKinds({ embargoAt: '', secondEmbargoAt: '' }), []);
});

test('requiredDistributionKinds: 미전달/빈 객체 → 빈 배열(throw 금지)', () => {
  assert.deepEqual(requiredDistributionKinds(), []);
  assert.deepEqual(requiredDistributionKinds({}), []);
});

test('requiredDistributionKinds: 공백 문자열은 truthy → 설정으로 본다', () => {
  assert.deepEqual(requiredDistributionKinds({ embargoAt: ' ' }), ['press']);
  assert.deepEqual(requiredDistributionKinds({ secondEmbargoAt: ' ' }), ['press', 'nonpress']);
});

// ---- completeEmbargoDistribution ----

test('없는 기사 → not-found, DB 무변경', () => {
  const { service, db } = setup();
  const r = service.completeEmbargoDistribution('no-such-id', { actorUserId: 'z1' });
  assert.deepEqual(r, { ok: false, reason: 'not-found' });
  const rows = db.prepare('SELECT COUNT(*) AS c FROM ArticleHistory').get();
  assert.equal(rows.c, 0);
});

test('status가 EPS가 아니면 멱등 no-op(status 무변경, 이력 미기록)', () => {
  for (const status of ['RDS', 'DPS', 'EEH', 'DDK']) {
    const { service, articleId, db } = setup({ status, contents: { embargoAt: '2026-07-29T00:00:00.000Z' } });
    const r = service.completeEmbargoDistribution(articleId, { actorUserId: 'z1' });
    assert.deepEqual(r, { ok: true, status, transitioned: false }, status);
    assert.equal(db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status, status, status);
    const hist = db.prepare("SELECT * FROM ArticleHistory WHERE articleId = ? AND action = 'distributeComplete'").all(articleId);
    assert.equal(hist.length, 0, status);
  }
});

test('EPS + 1차만 설정 + press 배부됨 → DPS로 전이', () => {
  const { service, articleId, db, historyModel } = setup({ contents: { embargoAt: '2026-07-29T00:00:00.000Z' } });
  recordDistribute(historyModel, articleId, 'press');

  const r = service.completeEmbargoDistribution(articleId, { actorUserId: 'z1' });

  assert.deepEqual(r, {
    ok: true, status: 'DPS', transitioned: true, required: ['press'], distributed: ['press'],
  });
  assert.equal(db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status, 'DPS');
  const hist = db.prepare("SELECT * FROM ArticleHistory WHERE articleId = ? AND eventType = 'status' AND action = 'distributeComplete'").all(articleId);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].fromStatus, 'EPS');
  assert.equal(hist[0].toStatus, 'DPS');
  assert.equal(hist[0].actorUserId, 'z1');
});

test('EPS + 1+2차 설정 + press만 배부됨 → 전이 안 함(nonpress 남음)', () => {
  const { service, articleId, historyModel, db } = setup({
    contents: { embargoAt: '2026-07-29T00:00:00.000Z', secondEmbargoAt: '2026-07-30T00:00:00.000Z' },
  });
  recordDistribute(historyModel, articleId, 'press');

  const r = service.completeEmbargoDistribution(articleId);

  assert.deepEqual(r, { ok: true, status: 'EPS', transitioned: false, required: ['press', 'nonpress'], distributed: ['press'] });
  assert.equal(db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status, 'EPS');
  const hist = db.prepare("SELECT * FROM ArticleHistory WHERE articleId = ? AND action = 'distributeComplete'").all(articleId);
  assert.equal(hist.length, 0);
});

test('EPS + 1+2차 설정 + press,nonpress 모두 배부됨 → 전이 성공', () => {
  const { service, articleId, historyModel } = setup({
    contents: { embargoAt: '2026-07-29T00:00:00.000Z', secondEmbargoAt: '2026-07-30T00:00:00.000Z' },
  });
  recordDistribute(historyModel, articleId, 'press');
  recordDistribute(historyModel, articleId, 'nonpress');

  const r = service.completeEmbargoDistribution(articleId, { actorUserId: 'z1' });

  assert.equal(r.ok, true);
  assert.equal(r.status, 'DPS');
  assert.equal(r.transitioned, true);
  assert.deepEqual(r.required, ['press', 'nonpress']);
  assert.deepEqual(r.distributed.sort(), ['nonpress', 'press']);
});

test('EPS + 2차만 설정 + press만 배부됨 → 전이 안 함', () => {
  const { service, articleId, historyModel, db } = setup({ contents: { secondEmbargoAt: '2026-07-29T00:00:00.000Z' } });
  recordDistribute(historyModel, articleId, 'press');

  const r = service.completeEmbargoDistribution(articleId);

  assert.deepEqual(r, { ok: true, status: 'EPS', transitioned: false, required: ['press', 'nonpress'], distributed: ['press'] });
  assert.equal(db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status, 'EPS');
});

test('EPS + 엠바고 컬럼 둘 다 비어 있음 → 전이 금지(no-embargo)', () => {
  const { service, articleId, db } = setup({ contents: {} });

  const r = service.completeEmbargoDistribution(articleId);

  assert.deepEqual(r, { ok: true, status: 'EPS', transitioned: false, reason: 'no-embargo' });
  assert.equal(db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status, 'EPS');
});

test('이미 DPS로 전이된 기사에 다시 호출 → no-op, distributeComplete 이력 1행만', () => {
  const { service, articleId, historyModel, db } = setup({ contents: { embargoAt: '2026-07-29T00:00:00.000Z' } });
  recordDistribute(historyModel, articleId, 'press');

  const r1 = service.completeEmbargoDistribution(articleId, { actorUserId: 'z1' });
  assert.equal(r1.transitioned, true);

  const r2 = service.completeEmbargoDistribution(articleId, { actorUserId: 'z1' });
  assert.deepEqual(r2, { ok: true, status: 'DPS', transitioned: false });

  const hist = db.prepare("SELECT * FROM ArticleHistory WHERE articleId = ? AND action = 'distributeComplete'").all(articleId);
  assert.equal(hist.length, 1);
});

test('historyModel 미주입 → 완결 판정 근거 없음 → 항상 전이 금지(안전측)', () => {
  const { service, articleId, db } = setup({ withHistory: false, contents: { embargoAt: '2026-07-29T00:00:00.000Z' } });

  const r = service.completeEmbargoDistribution(articleId);

  assert.equal(r.ok, true);
  assert.equal(r.transitioned, false);
  assert.equal(db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status, 'EPS');
});

test('다른 eventType 오염 무시 — eventType=status인 행은 배부로 세지 않는다', () => {
  const { service, articleId, historyModel, db } = setup({ contents: { embargoAt: '2026-07-29T00:00:00.000Z' } });
  // status 이벤트에 action='press'가 있어도 배부로 세면 안 된다.
  historyModel.insert({ articleId, eventType: 'status', action: 'press', fromStatus: 'RDS', toStatus: 'EPS', createdAt: new Date().toISOString() });

  const r = service.completeEmbargoDistribution(articleId);

  assert.equal(r.transitioned, false);
  assert.equal(db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(articleId).status, 'EPS');

  // 진짜 distribute 이벤트가 기록되면 전이된다.
  recordDistribute(historyModel, articleId, 'press');
  const r2 = service.completeEmbargoDistribution(articleId);
  assert.equal(r2.transitioned, true);
});
