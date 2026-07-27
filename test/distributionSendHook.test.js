// 송고 후처리 배부 훅 테스트 — 송고(applyAction 'send')가 끝난 뒤에만, 엠바고 설정에 따라
// 배부를 지시하는지 검증한다(ADR-008 (4), news.md 엠바고 규칙).
//
// CRITICAL 계약(완화 금지 — 실패하면 구현을 고쳐라):
//  ① 배부군은 "상태"가 아니라 "엠바고 설정"이 정한다. finalStatus==='DPS' ? 'all' 같은 단순 분기는
//     엠바고가 설정된 DDH 기사(lifecycle DDH.send='DPS')를 전량 배부해 엠바고를 파기한다.
//  ② 1차 엠바고가 설정된 기사는 상태(EPS/DPS)와 무관하게 이번에 배부하지 않는다(시각 배부는 phase 48).
//  ③ 배부 실패/예외가 송고를 롤백하거나 실패시키지 않는다(스풀 실패는 송고의 후처리 실패일 뿐이다).
//  ④ applyAction의 반환은 { ok, status } 정확히 2키다(HTTP 응답 계약 + 다수 정확일치 단언).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createArticleService } from '../src/services/articleService.js';

const EMBARGO_1 = '2026-07-28T09:00:00.000Z';
const EMBARGO_2 = '2026-07-29T09:00:00.000Z';

// 송고 가드(hasEndMarker)를 통과하려면 본문 블록에 "(끝)"이 있어야 한다.
function markup(withEnd = true) {
  const blocks = [{ type: 'text', text: '본문 한 줄' }];
  if (withEnd) blocks.push({ type: 'text', text: '(끝)' });
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}

// 호출 인자를 기록하는 가짜 배부 서비스. impl로 예외/실패 반환을 주입한다.
function fakeDistribution(impl) {
  const calls = [];
  return {
    calls,
    distribute(articleId, audience, options) {
      calls.push({ articleId, audience, options });
      if (typeof impl === 'function') return impl(articleId, audience, options);
      return { ok: true, attempted: 1, written: 1, failures: [], distributedAt: '2026-07-27T09:00:00.000Z' };
    },
  };
}

// distributionService를 주입하지 않는 호출 형태(기존 호출자)도 그대로 지원해야 한다.
function unitSetup(distributionService) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const service = distributionService === undefined
    ? createArticleService({ articleModel, db, historyModel })
    : createArticleService({ articleModel, db, historyModel, distributionService });
  return { db, articleModel, historyModel, service };
}

// 기사 1건 시드 — status 오버라이드는 모델 update로 직접 세팅한다(전이 경로 없이 DDH/DPS를 만든다).
function seed(h, { status, withEnd = true, ...contents } = {}) {
  const { articleId } = h.service.create({
    title: '제목', markupVersion: markup(withEnd), author: 'kim', ...contents,
  });
  if (status) h.articleModel.update(articleId, { contents: { status } });
  return articleId;
}

const contentsRow = (db, id) => db.prepare('SELECT * FROM Contents WHERE articleId = ?').get(id);

// ── A. 단위 — 가짜 distributionService 주입 ────────────────────────────────

test('훅: 엠바고 없는 RDS 기사를 D가 송고하면 전체 배부(all)를 1회 지시한다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h);

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'DPS');
  assert.equal(dist.calls.length, 1);
  assert.deepEqual(dist.calls[0], { articleId: id, audience: 'all', options: { actorUserId: 'desk' } });
});

test('훅: 2차 엠바고만 설정된 기사의 송고(EPS)는 언론사 배부(press)만 지시한다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { secondEmbargoAt: EMBARGO_2 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'EPS');
  assert.equal(dist.calls.length, 1);
  assert.equal(dist.calls[0].audience, 'press');
});

test('훅: 1차 엠바고만 설정된 기사의 송고(EPS)는 배부를 지시하지 않는다(시각 배부는 후속 phase)', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { embargoAt: EMBARGO_1 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'EPS');
  assert.equal(dist.calls.length, 0);
});

test('훅: 1+2차 엠바고가 모두 설정된 기사의 송고(EPS)는 배부를 지시하지 않는다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { embargoAt: EMBARGO_1, secondEmbargoAt: EMBARGO_2 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'EPS');
  assert.equal(dist.calls.length, 0);
});

test('훅: 엠바고 필드가 빈 문자열이면 미설정으로 보고 전체 배부한다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { embargoAt: '', secondEmbargoAt: '' });

  const r = h.service.applyAction(id, 'Z', 'send', { userId: 'admin' });

  assert.equal(r.status, 'DPS');
  assert.equal(dist.calls.length, 1);
  assert.equal(dist.calls[0].audience, 'all');
});

test('훅: hold/kill/approveDelete는 배부 트리거가 아니다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);

  const held = seed(h);
  assert.equal(h.service.applyAction(held, 'D', 'hold', { userId: 'desk' }).status, 'DDH');

  const killed = seed(h);
  assert.equal(h.service.applyAction(killed, 'D', 'kill', { userId: 'desk' }).status, 'DDK');

  const deleted = seed(h, { status: 'DPS' });
  assert.equal(h.service.applyAction(deleted, 'Z', 'approveDelete', { userId: 'admin' }).status, 'DPD');

  assert.equal(dist.calls.length, 0);
});

test('훅: R의 송고(RDS 유지 — 데스크 미송고)는 배부를 지시하지 않는다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h);

  const r = h.service.applyAction(id, 'R', 'send', { userId: 'kim' });

  assert.equal(r.status, 'RDS');
  assert.equal(dist.calls.length, 0);
});

test('훅: 전이 거부(no-end-marker/forbidden-transition/not-found)는 부작용이 없다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);

  const noEnd = seed(h, { withEnd: false });
  assert.deepEqual(h.service.applyAction(noEnd, 'D', 'send', { userId: 'desk' }), { ok: false, reason: 'no-end-marker' });

  const eps = seed(h, { status: 'EPS' }); // EPS에는 send 전이가 없다.
  assert.deepEqual(
    h.service.applyAction(eps, 'D', 'send', { userId: 'desk' }),
    { ok: false, reason: 'forbidden-transition' },
  );

  assert.deepEqual(
    h.service.applyAction('NOPE20260727000000001', 'D', 'send', { userId: 'desk' }),
    { ok: false, reason: 'not-found' },
  );

  assert.equal(dist.calls.length, 0);
});

test('훅: 엠바고 없는 DPS 기사의 재송고는 다시 전체 배부한다(정정본 배부)', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h);

  assert.equal(h.service.applyAction(id, 'D', 'send', { userId: 'desk' }).status, 'DPS');
  assert.equal(h.service.applyAction(id, 'D', 'send', { userId: 'desk' }).status, 'DPS');

  assert.equal(dist.calls.length, 2);
  assert.deepEqual(dist.calls.map((c) => c.audience), ['all', 'all']);
});

// ── A′. 엠바고 파기 방지 — DDH 송고(finalStatus가 EPS가 아니라 DPS인 경로) ──────
// articleService의 EPS 치환은 fromStatus==='RDS' 한정이라 DDH 기사는 엠바고가 있어도 DPS가 된다.
// 각 케이스는 r.status==='DPS'를 먼저 단언해 "상태로는 구분할 수 없다"는 전제를 고정한다.

test('훅(DDH): 1차 엠바고가 있으면 결과가 DPS여도 배부하지 않는다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { status: 'DDH', embargoAt: EMBARGO_1 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'DPS', '전제: DDH 송고는 EPS가 아니라 DPS다');
  assert.equal(dist.calls.length, 0, '1차 엠바고 파기 방지');
});

test('훅(DDH): 2차 엠바고만 있으면 결과가 DPS여도 언론사(press)에만 배부한다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { status: 'DDH', secondEmbargoAt: EMBARGO_2 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'DPS', '전제: DDH 송고는 EPS가 아니라 DPS다');
  assert.equal(dist.calls.length, 1);
  assert.equal(dist.calls[0].audience, 'press', "'all'이면 2차 엠바고 파기다");
});

test('훅(DDH): 1+2차 엠바고가 모두 있으면 결과가 DPS여도 배부하지 않는다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { status: 'DDH', embargoAt: EMBARGO_1, secondEmbargoAt: EMBARGO_2 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'DPS');
  assert.equal(dist.calls.length, 0);
});

test('훅(DDH): 엠바고가 없으면 보류 해제 송고는 정상적으로 전체 배부한다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { status: 'DDH' });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'DPS');
  assert.equal(dist.calls.length, 1);
  assert.equal(dist.calls[0].audience, 'all');
});

test('훅: 엠바고가 추가된 DPS 기사의 재송고는 배부하지 않는다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { status: 'DPS', embargoAt: EMBARGO_1 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'DPS');
  assert.equal(dist.calls.length, 0);
});

// ── 무롤백 계약 ────────────────────────────────────────────────────────────

test('훅: distribute가 throw해도 송고는 성공이고 상태 전이·sentAt·이력이 유지된다', () => {
  const dist = fakeDistribution(() => { throw new Error('spool exploded'); });
  const h = unitSetup(dist);
  const id = seed(h);

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.deepEqual(r, { ok: true, status: 'DPS' });
  const row = contentsRow(h.db, id);
  assert.equal(row.status, 'DPS');
  assert.equal(row.sender, 'desk');
  assert.ok(row.sentAt, 'sentAt이 stamp된다');
  const history = h.service.queryHistory(id);
  assert.equal(history.length, 1);
  assert.equal(history[0].eventType, 'status');
  assert.equal(history[0].toStatus, 'DPS');
});

test('훅: distribute가 { ok:false }를 반환해도 송고는 성공 처리된다', () => {
  const dist = fakeDistribution(() => ({ ok: false, reason: 'not-found' }));
  const h = unitSetup(dist);
  const id = seed(h);

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.deepEqual(r, { ok: true, status: 'DPS' });
  assert.equal(contentsRow(h.db, id).status, 'DPS');
});

test('훅: applyAction 반환은 { ok, status } 2키 그대로다(배부 결과 필드 추가 금지)', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h);

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.deepEqual(r, { ok: true, status: 'DPS' });
  assert.deepEqual(Object.keys(r).sort(), ['ok', 'status']);
});

test('훅: distributionService 미주입(기존 호출 형태)이어도 송고 동작이 동일하다', () => {
  const h = unitSetup(); // 주입 없음
  const id = seed(h);

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.deepEqual(r, { ok: true, status: 'DPS' });
  const row = contentsRow(h.db, id);
  assert.equal(row.status, 'DPS');
  assert.equal(row.distributedAt, null, '배부가 없으므로 배부시간도 없다');
  assert.equal(h.service.queryHistory(id).length, 1);
});
