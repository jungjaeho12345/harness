// 시점 배부(tick) 도메인 서비스 테스트 — ADR-008 (3)(5).
// 하네스: in-memory DB + 실제 sessionService/authorization(신뢰 경계를 그대로 검증) + 실제 articleModel/historyModel
// (도래·이력 판정을 실제 SQL로 검증) + 가짜 distributionService(호출 인자 기록, 결과/지연 조작) +
// 가짜 articleService(completeEmbargoDistribution 호출 기록·전이 결과 조작).
// CRITICAL: 멱등(같은 kind 재배부 금지)과 단일 실행(중첩 tick이 같은 kind를 두 번 스풀에 쓰지 않음)이 핵심 불변식이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createAuthorization } from '../src/services/authorization.js';
import { requiredDistributionKinds } from '../src/services/articleService.js';
import { createDistributionTickService } from '../src/services/distributionTickService.js';

const NOW = () => new Date('2026-01-01T00:00:00.000Z');
const PAST = '2025-12-31T00:00:00.000Z'; // NOW보다 과거 → 도래
const FUTURE = '2026-06-01T00:00:00.000Z'; // NOW보다 미래 → 미도래

let seq = 0;
function nextId() {
  seq += 1;
  return `AKR2026010100000${String(seq).padStart(2, '0')}`;
}

// 호출을 기록하고 결과를 조작할 수 있는 가짜 distributionService.
// deferred 옵션을 주면 write()가 외부에서 resolve 가능한 Promise를 반환한다(단일 실행 테스트용).
function fakeDistributionService({ shouldReject = false, deferred = false } = {}) {
  const calls = [];
  let resolveFn;
  const gate = deferred ? new Promise((resolve) => { resolveFn = resolve; }) : null;
  return {
    calls,
    resolveGate: resolveFn,
    async distribute(articleId, opts) {
      calls.push({ articleId, ...opts });
      if (deferred) await gate;
      if (shouldReject) throw new Error('distribute-failed');
      return { ok: true, distributed: [{ targetId: 1, kind: opts.kinds[0] }], failed: [] };
    },
  };
}

// 호출을 기록하고 articleId별로 결과를 조작할 수 있는 가짜 articleService.
function fakeArticleService(resultsByArticleId = {}) {
  const calls = [];
  return {
    calls,
    completeEmbargoDistribution(articleId, opts) {
      calls.push({ articleId, ...opts });
      return resultsByArticleId[articleId] ?? { ok: true, status: 'EPS', transitioned: false };
    },
  };
}

function setup({ distributionService, articleService, now = NOW } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const sessionService = createSessionService();
  const authorization = createAuthorization({ sessionService, articleModel });
  const service = createDistributionTickService({
    articleModel, historyModel, distributionService, articleService, authorization, now,
  });
  return { db, articleModel, historyModel, sessionService, authorization, service };
}

function sessionFor(sessionService, role, userId = 'z1') {
  return sessionService.createSession({
    userId, role, department: '편집국', departmentCode: 'ED', name: userId,
  });
}

function insertEps(articleModel, { embargoAt, secondEmbargoAt, sentAt } = {}) {
  const articleId = nextId();
  articleModel.insert({
    article: { articleId, title: '제목' },
    contents: {
      articleId, status: 'EPS', embargoAt: embargoAt ?? '', secondEmbargoAt: secondEmbargoAt ?? '',
      sentAt: sentAt ?? '', createdAt: '2025-12-01T00:00:00.000Z',
    },
  });
  return articleId;
}

function recordDistribute(historyModel, articleId, kind) {
  historyModel.insert({
    articleId, eventType: 'distribute', action: kind, actorUserId: null, createdAt: '2025-12-01T00:00:00.000Z',
  });
}

// ---- 인가 ----

test('세션 없음/잘못된 sid → unauthenticated, 후보 조회조차 하지 않는다', async () => {
  const ds = fakeDistributionService();
  const { service, articleModel } = setup({ distributionService: ds, articleService: fakeArticleService() });
  insertEps(articleModel, { embargoAt: PAST });

  for (const sid of ['bad-session', undefined, '']) {
    const r = await service.run(sid);
    assert.deepEqual(r, { ok: false, reason: 'unauthenticated' });
  }
  assert.equal(ds.calls.length, 0);
});

test('role R/D 세션 → forbidden, 배부 0회', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService } = setup({ distributionService: ds, articleService: fakeArticleService() });
  const r = sessionFor(sessionService, 'R', 'rep');
  const d = sessionFor(sessionService, 'D', 'desk');

  assert.deepEqual(await service.run(r), { ok: false, reason: 'forbidden' });
  assert.deepEqual(await service.run(d), { ok: false, reason: 'forbidden' });
  assert.equal(ds.calls.length, 0);
});

test('게이트가 스풀 설정 검사보다 먼저 수행된다: distributionService 미주입 + 비Z 세션 → forbidden', async () => {
  const { service, sessionService } = setup({ distributionService: undefined, articleService: fakeArticleService() });
  const r = sessionFor(sessionService, 'R', 'rep');
  const res = await service.run(r);
  assert.deepEqual(res, { ok: false, reason: 'forbidden' });
});

// ---- 실행 ----

test('distributionService 미주입 + Z 세션 → spool-disabled, DB 무변경', async () => {
  const { service, sessionService, articleModel, db } = setup({
    distributionService: undefined, articleService: fakeArticleService(),
  });
  const z = sessionFor(sessionService, 'Z');
  insertEps(articleModel, { embargoAt: PAST });
  const before = db.prepare('SELECT * FROM Contents').all();

  const res = await service.run(z);

  assert.deepEqual(res, { ok: false, reason: 'spool-disabled' });
  assert.deepEqual(db.prepare('SELECT * FROM Contents').all(), before);
});

test('1차만 설정 + embargoAt 도래 + 이력 없음 → distribute(articleId, { kinds:["press"], actorUserId }) 1회', async () => {
  const ds = fakeDistributionService();
  const as = fakeArticleService();
  const { service, sessionService, articleModel } = setup({ distributionService: ds, articleService: as });
  const z = sessionFor(sessionService, 'Z', 'zz1');
  const articleId = insertEps(articleModel, { embargoAt: PAST });

  const res = await service.run(z);

  assert.equal(res.ok, true);
  assert.equal(ds.calls.length, 1);
  assert.deepEqual(ds.calls[0], { articleId, kinds: ['press'], actorUserId: 'zz1' });
});

test('1차만 설정 + embargoAt 미도래 → distribute 미호출', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel } = setup({ distributionService: ds, articleService: fakeArticleService() });
  const z = sessionFor(sessionService, 'Z');
  insertEps(articleModel, { embargoAt: FUTURE });

  await service.run(z);
  assert.equal(ds.calls.length, 0);
});

test('1+2차 설정 + 둘 다 도래 + 이력 없음 → kinds:["press","nonpress"] 1회 호출', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel } = setup({ distributionService: ds, articleService: fakeArticleService() });
  const z = sessionFor(sessionService, 'Z');
  const articleId = insertEps(articleModel, { embargoAt: PAST, secondEmbargoAt: PAST });

  await service.run(z);

  assert.equal(ds.calls.length, 1);
  assert.deepEqual(ds.calls[0].kinds, ['press', 'nonpress']);
  assert.equal(ds.calls[0].articleId, articleId);
});

test('1+2차 설정 + 1차만 도래 → kinds:["press"]', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel } = setup({ distributionService: ds, articleService: fakeArticleService() });
  const z = sessionFor(sessionService, 'Z');
  insertEps(articleModel, { embargoAt: PAST, secondEmbargoAt: FUTURE });

  await service.run(z);

  assert.equal(ds.calls.length, 1);
  assert.deepEqual(ds.calls[0].kinds, ['press']);
});

test('2차만 설정 + 2차 도래 + press 이력 이미 있음 → kinds:["nonpress"]', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel, historyModel } = setup({
    distributionService: ds, articleService: fakeArticleService(),
  });
  const z = sessionFor(sessionService, 'Z');
  const articleId = insertEps(articleModel, { secondEmbargoAt: PAST });
  recordDistribute(historyModel, articleId, 'press');

  await service.run(z);

  assert.equal(ds.calls.length, 1);
  assert.deepEqual(ds.calls[0].kinds, ['nonpress']);
});

test('송고 시 press 예외 회복: 2차만 설정 + 2차 미도래 + press 이력 없음 → kinds:["press"] 1회', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel } = setup({ distributionService: ds, articleService: fakeArticleService() });
  const z = sessionFor(sessionService, 'Z');
  insertEps(articleModel, { secondEmbargoAt: FUTURE });

  await service.run(z);

  assert.equal(ds.calls.length, 1);
  assert.deepEqual(ds.calls[0].kinds, ['press']);
});

test('송고 시 press 예외 + 멱등: 2차만 설정 + 2차 미도래 + press 이력 있음 → distribute 미호출', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel, historyModel } = setup({
    distributionService: ds, articleService: fakeArticleService(),
  });
  const z = sessionFor(sessionService, 'Z');
  const articleId = insertEps(articleModel, { secondEmbargoAt: FUTURE });
  recordDistribute(historyModel, articleId, 'press');

  await service.run(z);

  assert.equal(ds.calls.length, 0);
});

test('멱등: press 이력이 이미 있고 1차만 설정 → distribute 미호출, completeEmbargoDistribution은 호출되어 전이 회복', async () => {
  const ds = fakeDistributionService();
  const as = fakeArticleService();
  const { service, sessionService, articleModel, historyModel } = setup({
    distributionService: ds, articleService: as,
  });
  const z = sessionFor(sessionService, 'Z');
  const articleId = insertEps(articleModel, { embargoAt: PAST });
  recordDistribute(historyModel, articleId, 'press');

  await service.run(z);

  assert.equal(ds.calls.length, 0);
  assert.equal(as.calls.length, 1);
  assert.equal(as.calls[0].articleId, articleId);
});

test('embargoAt이 "없음"/""/"not-a-date" → 미도래로 취급, 배부 0회(throw 금지)', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel } = setup({ distributionService: ds, articleService: fakeArticleService() });
  const z = sessionFor(sessionService, 'Z');
  for (const bad of ['없음', '', 'not-a-date']) {
    insertEps(articleModel, { embargoAt: bad });
  }

  const res = await service.run(z);

  assert.equal(res.ok, true);
  assert.equal(ds.calls.length, 0);
  assert.deepEqual(res.failed, []);
});

test('후보 0건 → { ok:true, evaluated:0, distributed:[], transitioned:[], failed:[] }', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService } = setup({ distributionService: ds, articleService: fakeArticleService() });
  const z = sessionFor(sessionService, 'Z');

  const res = await service.run(z);
  assert.deepEqual(res, { ok: true, evaluated: 0, distributed: [], transitioned: [], failed: [] });
});

test('실패 격리: 후보 3건 중 2번째의 distribute가 throw해도 1·3번째는 처리되고 failed에 담긴다', async () => {
  const as = fakeArticleService();
  const calls = [];
  const distributionService = {
    async distribute(articleId, opts) {
      calls.push({ articleId, ...opts });
      if (calls.length === 2) throw new Error('boom');
      // 1·3번째는 실제로 기록된 것으로 만든다 — 이 테스트는 throw 격리만 검증한다(빈 distributed의
      // "실패로 표면화" 검증은 별도 테스트가 담당한다).
      return { ok: true, distributed: opts.kinds.map((kind) => ({ targetId: 1, kind })), failed: [] };
    },
  };
  const { service, sessionService, articleModel } = setup({ distributionService, articleService: as });
  const z = sessionFor(sessionService, 'Z');
  const a1 = insertEps(articleModel, { embargoAt: PAST });
  const a2 = insertEps(articleModel, { embargoAt: PAST });
  const a3 = insertEps(articleModel, { embargoAt: PAST });

  const res = await service.run(z);

  assert.equal(res.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].articleId, a2);
  assert.ok(res.failed[0].reason);
  // 실패하지 않은 두 건은 completeEmbargoDistribution까지 처리된다.
  assert.deepEqual(as.calls.map((c) => c.articleId).sort(), [a1, a3].sort());
});

test('completeEmbargoDistribution이 transitioned:true를 주면 반환 transitioned 배열에 articleId가 담긴다', async () => {
  const ds = fakeDistributionService();
  // articleId 확정 후에야 결과 맵을 채울 수 있으므로 setup()을 쓰지 않고 직접 구성한다.
  const db2 = new DatabaseSync(':memory:');
  createSchema(db2);
  const articleModel2 = createArticleModel(db2);
  const historyModel2 = createArticleHistoryModel(db2);
  const sessionService2 = createSessionService();
  const authorization2 = createAuthorization({ sessionService: sessionService2, articleModel: articleModel2 });
  const articleId = insertEps(articleModel2, { embargoAt: PAST });
  const as = fakeArticleService({ [articleId]: { ok: true, status: 'DPS', transitioned: true } });
  const svc = createDistributionTickService({
    articleModel: articleModel2, historyModel: historyModel2, distributionService: ds,
    articleService: as, authorization: authorization2, now: NOW,
  });
  const z2 = sessionFor(sessionService2, 'Z');

  const res = await svc.run(z2);

  assert.deepEqual(res.transitioned, [articleId]);
});

test('호출 순서: 같은 기사에 대해 distribute → completeEmbargoDistribution 순서로 호출된다', async () => {
  const order = [];
  const distributionService = {
    async distribute(articleId) {
      order.push(`distribute:${articleId}`);
      return { ok: true, distributed: [], failed: [] };
    },
  };
  const articleService = {
    completeEmbargoDistribution(articleId) {
      order.push(`complete:${articleId}`);
      return { ok: true, status: 'EPS', transitioned: false };
    },
  };
  const { service, sessionService, articleModel } = setup({ distributionService, articleService });
  const z = sessionFor(sessionService, 'Z');
  const articleId = insertEps(articleModel, { embargoAt: PAST });

  await service.run(z);

  assert.deepEqual(order, [`distribute:${articleId}`, `complete:${articleId}`]);
});

// ---- 단일 실행(single-flight) ----

test('단일 실행: 중첩 run은 busy로 거절되고 distribute는 1회만 호출된다', async () => {
  const ds = fakeDistributionService({ deferred: true });
  const { service, sessionService, articleModel } = setup({ distributionService: ds, articleService: fakeArticleService() });
  const z = sessionFor(sessionService, 'Z');
  insertEps(articleModel, { embargoAt: PAST });

  const p1 = service.run(z);
  // 첫 run이 distribute 내부 await에 진입할 시간을 준다.
  await Promise.resolve();
  await Promise.resolve();
  const p2 = service.run(z);
  ds.resolveGate();

  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(ds.calls.length, 1);
  assert.deepEqual(r2, { ok: false, reason: 'busy' });
  assert.equal(r1.ok, true);
});

test('게이트 우선순위: 첫 run이 진행 중일 때 role R 세션은 busy가 아니라 forbidden', async () => {
  const ds = fakeDistributionService({ deferred: true });
  const { service, sessionService, articleModel } = setup({ distributionService: ds, articleService: fakeArticleService() });
  const z = sessionFor(sessionService, 'Z');
  const r = sessionFor(sessionService, 'R', 'rep');
  insertEps(articleModel, { embargoAt: PAST });

  const p1 = service.run(z);
  await Promise.resolve();
  await Promise.resolve();
  const r2 = await service.run(r);
  assert.deepEqual(r2, { ok: false, reason: 'forbidden' });

  ds.resolveGate();
  const r1 = await p1;
  assert.equal(r1.ok, true);
});

test('플래그 해제: 첫 run 내부에서 예외가 발생해도 다음 run은 busy가 아니라 정상 실행된다', async () => {
  const throwingArticleModel = {
    query() { throw new Error('query-failed'); },
  };
  const ds = fakeDistributionService();
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const historyModel = createArticleHistoryModel(db);
  const sessionService = createSessionService();
  const authorization = createAuthorization({ sessionService, articleModel: null });
  const svc = createDistributionTickService({
    articleModel: throwingArticleModel, historyModel, distributionService: ds,
    articleService: fakeArticleService(), authorization, now: NOW,
  });
  const z = sessionFor(sessionService, 'Z');

  await assert.rejects(() => svc.run(z));

  // 정상 articleModel로 만든 새 서비스 인스턴스도 같은 프로세스 플래그를 공유하지만, 해제되었으므로 정상 실행된다.
  const realArticleModel = createArticleModel(db);
  const svc2 = createDistributionTickService({
    articleModel: realArticleModel, historyModel, distributionService: ds,
    articleService: fakeArticleService(), authorization, now: NOW,
  });
  const res = await svc2.run(z);
  assert.equal(res.ok, true);
});

// ---- 정합성 회귀(엠바고→kind 단일 출처) ----

test('정합성: tick의 kinds는 requiredDistributionKinds(contents)의 부분집합이고, 이력 전무 시 동일하다', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel } = setup({ distributionService: ds, articleService: fakeArticleService() });
  const z = sessionFor(sessionService, 'Z');
  const contents = { embargoAt: PAST, secondEmbargoAt: PAST };
  insertEps(articleModel, contents);

  await service.run(z);

  const required = requiredDistributionKinds(contents);
  assert.equal(ds.calls.length, 1);
  const kinds = ds.calls[0].kinds;
  assert.ok(kinds.every((k) => required.includes(k)));
  assert.deepEqual(kinds.sort(), required.slice().sort());
});

test('정합성: 2차만 설정 + press 이력 있음 → tick kinds=["nonpress"], required=["press","nonpress"], 차집합=이미 배부된 kind', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel, historyModel } = setup({
    distributionService: ds, articleService: fakeArticleService(),
  });
  const z = sessionFor(sessionService, 'Z');
  const contents = { secondEmbargoAt: PAST };
  const articleId = insertEps(articleModel, contents);
  recordDistribute(historyModel, articleId, 'press');

  await service.run(z);

  const required = requiredDistributionKinds(contents);
  assert.deepEqual(required, ['press', 'nonpress']);
  assert.deepEqual(ds.calls[0].kinds, ['nonpress']);
  const diff = required.filter((k) => !ds.calls[0].kinds.includes(k));
  assert.deepEqual(diff, ['press']);
});

// ---- 경합 유예(high 회귀) — tick↔송고 훅 press 경합으로 인한 되돌릴 수 없는 이중 배부 차단 ----
// articleService.applyAction은 EPS 커밋 후 press 배부를 await 없이(fire-and-forget) 호출한다.
// 그 창(스풀 write~history insert)에 tick이 돌면 "2차 엠바고만" 기사는 이력 없음으로 보여 press를
// 한 번 더 distribute할 수 있다 — 리뷰 승인안 a: sentAt 기준 유예(GRACE_MS) 안에서는 회복 배부를 보류한다.

const SENT_AT = '2026-01-01T00:00:00.000Z';
const WITHIN_GRACE = () => new Date('2026-01-01T00:00:10.000Z'); // sentAt + 10s (< 60s 유예).
const AFTER_GRACE = () => new Date('2026-01-01T00:01:05.000Z'); // sentAt + 65s (> 60s 유예).

test('(a) 유예 내: 2차만 설정 + 방금 송고(sentAt≈now) + press 이력 없음 → tick은 press를 재배부하지 않는다', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel } = setup({
    distributionService: ds, articleService: fakeArticleService(), now: WITHIN_GRACE,
  });
  const z = sessionFor(sessionService, 'Z');
  insertEps(articleModel, { secondEmbargoAt: FUTURE, sentAt: SENT_AT });

  const res = await service.run(z);

  assert.equal(res.ok, true);
  assert.equal(ds.calls.length, 0, '유예 내에는 tick이 press를 회복 배부하지 않아야 한다(송고 훅의 in-flight 배부를 신뢰)');
});

test('(b) 유예 경과: 같은 기사, now = sentAt + GRACE + 여유, press 이력 여전히 없음 → tick이 press를 회복 배부한다', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel } = setup({
    distributionService: ds, articleService: fakeArticleService(), now: AFTER_GRACE,
  });
  const z = sessionFor(sessionService, 'Z');
  insertEps(articleModel, { secondEmbargoAt: FUTURE, sentAt: SENT_AT });

  const res = await service.run(z);

  assert.equal(res.ok, true);
  assert.equal(ds.calls.length, 1, '유예가 지나도 press 이력이 없으면(송고 훅 배부 실패) tick이 회복 배부해야 한다');
  assert.deepEqual(ds.calls[0].kinds, ['press']);
});

test('(c) sentAt 없음(레거시 기사) → 유예 무관하게 회복 배부 허용(기존 동작 보존)', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel } = setup({
    distributionService: ds, articleService: fakeArticleService(), now: WITHIN_GRACE,
  });
  const z = sessionFor(sessionService, 'Z');
  insertEps(articleModel, { secondEmbargoAt: FUTURE }); // sentAt 미설정.

  const res = await service.run(z);

  assert.equal(res.ok, true);
  assert.equal(ds.calls.length, 1);
  assert.deepEqual(ds.calls[0].kinds, ['press']);
});

test('1차 엠바고(embargoAt truthy)는 도래 판정에 유예를 적용하지 않는다 — 실제 엠바고 시각 기반이라 경합 대상이 아니다', async () => {
  const ds = fakeDistributionService();
  const { service, sessionService, articleModel } = setup({
    distributionService: ds, articleService: fakeArticleService(), now: WITHIN_GRACE,
  });
  const z = sessionFor(sessionService, 'Z');
  // embargoAt(PAST) 도래 + sentAt이 now와 근접(유예 내)이어도, 1차 엠바고 판정에는 유예가 끼어들지 않는다.
  insertEps(articleModel, { embargoAt: PAST, sentAt: SENT_AT });

  await service.run(z);

  assert.equal(ds.calls.length, 1);
  assert.deepEqual(ds.calls[0].kinds, ['press']);
});

// ---- distribute 반환 반영(med 회귀) — 실패를 성공으로 오집계하지 않는다 ----

test('활성 대상 0건(distribute가 {ok:true, distributed:[], failed:[...]} 반환) → 그 기사는 성공 distributed로 잡히지 않고 failed로 표면화된다', async () => {
  const calls = [];
  const distributionService = {
    async distribute(articleId, opts) {
      calls.push({ articleId, ...opts });
      return {
        ok: true,
        distributed: [],
        failed: [{ targetId: 1, kind: 'press', reason: 'spool-write-failed' }],
      };
    },
  };
  const { service, sessionService, articleModel } = setup({ distributionService, articleService: fakeArticleService() });
  const z = sessionFor(sessionService, 'Z');
  const articleId = insertEps(articleModel, { embargoAt: PAST });

  const res = await service.run(z);

  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(res.distributed.length, 0, '실제로 기록된 kind가 없으므로 성공 distributed에 담기면 안 된다');
  assert.ok(
    res.failed.some((f) => f.articleId === articleId && f.kind === 'press'),
    'distributionService가 실패를 알렸으면 tick의 failed에도 표면화되어야 한다',
  );
});

test('distribute가 ok:false(reason 포함)를 반환 → distributed에 담기지 않고 failed에 그 이유가 담긴다', async () => {
  const distributionService = {
    async distribute() {
      return { ok: false, reason: 'spool-disabled' };
    },
  };
  const { service, sessionService, articleModel } = setup({ distributionService, articleService: fakeArticleService() });
  const z = sessionFor(sessionService, 'Z');
  const articleId = insertEps(articleModel, { embargoAt: PAST });

  const res = await service.run(z);

  assert.equal(res.ok, true);
  assert.equal(res.distributed.length, 0);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].articleId, articleId);
  assert.equal(res.failed[0].reason, 'spool-disabled');
});
