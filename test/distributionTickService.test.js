// 엠바고 시점 배부 tick 서비스 테스트 — ADR-008 (3): 앱 내 타이머가 아니라 외부 cron의 pull이 run()을 부른다.
// 하네스: in-memory DB + 실제 articleModel/articleHistoryModel/articleService + 가짜 distributionService.
//   가짜는 실물과 동일하게 "성공한 kind에만" (eventType='distribute', action=kind) 이력을 남긴다 —
//   이 이력이 멱등·승격 판정의 유일한 근거이므로, 빼면 검증 자체가 가짜가 된다.
// CRITICAL 잠그는 것:
//   (1) 대상 선정은 "엠바고 시각 + 미배부 여부" — 레거시 DPS도 잡고, 미송고·킬·보류·삭제는 절대 나가지 않는다.
//   (2) 상태 전이는 articleService.syncEmbargoStatus 위임(tick은 status를 직접 쓰지 않는다).
//   (3) 요약(HTTP 응답)에는 식별자와 사유만 — spoolDir·파일 경로·원시 에러 문자열 비노출.
//   (4) distributedAt 갱신은 distributionService의 책임(1차 후 T1, 2차 후 T2 — SCHEMA.md:49).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createDistributionTargetModel } from '../src/models/distributionTargetModel.js';
import { createArticleService } from '../src/services/articleService.js';
import { createDistributionService } from '../src/services/distributionService.js';
import { createSpoolWriter } from '../src/services/spoolWriter.js';
import { createDistributionTickService } from '../src/services/distributionTickService.js';

const T0 = '2026-07-28T05:00:00.000Z'; // 엠바고 미도래 기준 시각
const T1 = '2026-07-28T09:00:00.000Z'; // 1차 엠바고 시각
const T2 = '2026-07-28T12:00:00.000Z'; // 2차 엠바고 시각
const T9 = '2026-07-29T09:00:00.000Z'; // 재설정된 1차 엠바고 시각(T1·T2보다 뒤)
const T10 = '2026-07-29T12:00:00.000Z'; // 재설정된 2차 엠바고 시각
const SENT_AT = '2026-07-28T04:00:00.000Z';
const MARKUP = '{"blocks":[{"text":"본문 (끝)"}]}';

function harness() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const distributionTargetModel = createDistributionTargetModel(db);
  const articleService = createArticleService({ articleModel, db, historyModel });

  let seq = 0;
  // 송고까지 끝난 기사 1건을 만든다. distributed에 든 kind는 "이미 배부됨" 이력으로 심는다.
  // pastDistributed: 송고(사이클 경계)보다 **앞에** 남는 과거 배부 사이클의 이력.
  function addArticle({
    status = 'DES', embargoAt, secondEmbargoAt, distributed = [], pastDistributed = [],
  } = {}) {
    seq += 1;
    const articleId = `AKR2026072800000000${seq}`;
    articleModel.insert({
      article: { articleId, title: `제목${seq}`, markupVersion: MARKUP },
      contents: {
        articleId,
        title: `제목${seq}`,
        author: 'r1',
        sender: 'desk1',
        status,
        createdAt: `2026-07-28T00:00:0${seq}.000Z`,
        sentAt: SENT_AT,
        embargoAt,
        secondEmbargoAt,
      },
    });
    // 과거 사이클(재송고 전)에 이미 나간 배부 — 송고 이력보다 먼저 심는다.
    for (const kind of pastDistributed) {
      historyModel.insert({
        articleId, eventType: 'distribute', action: kind, actorUserId: 'desk1',
        createdAt: '2026-07-27T00:00:00.000Z',
      });
    }
    // 기존 송고 이력 — tick이 보존해야 하는 행이다(DB 비파괴 검증용).
    historyModel.insert({
      articleId, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: status,
      actorUserId: 'desk1', createdAt: SENT_AT,
    });
    for (const kind of distributed) {
      historyModel.insert({
        articleId, eventType: 'distribute', action: kind, actorUserId: 'desk1', createdAt: SENT_AT,
      });
    }
    return articleId;
  }

  const statusOf = (articleId) => articleModel.getById(articleId).contents.status;
  const contentsOf = (articleId) => articleModel.getById(articleId).contents;
  const counts = () => ({
    article: db.prepare('SELECT COUNT(*) c FROM Article').get().c,
    contents: db.prepare('SELECT COUNT(*) c FROM Contents').get().c,
    history: db.prepare('SELECT COUNT(*) c FROM ArticleHistory').get().c,
  });
  const historyOf = (articleId) => db
    .prepare('SELECT * FROM ArticleHistory WHERE articleId = ? ORDER BY id').all(articleId);

  return {
    db, articleModel, historyModel, distributionTargetModel, articleService,
    addArticle, statusOf, contentsOf, counts, historyOf,
  };
}

// 호출을 기록하는 가짜 배부 서비스. behavior 미지정이면 요청한 kind 전부 성공으로 응답한다.
// 실물(distributionService.js:86)과 동일하게 "실제 성공한 kind"에만 배부 이력을 남긴다.
function fakeDistribution({ historyModel, now = () => T1, behavior } = {}) {
  const calls = [];
  return {
    calls,
    async distribute(articleId, { kinds = [], actorUserId = null } = {}) {
      calls.push({ articleId, kinds: [...kinds], actorUserId });
      const res = behavior
        ? await behavior({ articleId, kinds, actorUserId })
        : {
          ok: true,
          distributed: kinds.map((kind, i) => ({
            targetId: i + 1, kind, spoolDir: `out/${kind}`, file: `/spool/out/${kind}/${articleId}.json`,
          })),
          failed: [],
        };
      for (const kind of new Set((res.distributed ?? []).map((d) => d.kind))) {
        historyModel.insert({
          articleId, eventType: 'distribute', action: kind, actorUserId, createdAt: now(),
        });
      }
      return res;
    },
  };
}

function tickWith(h, { distributionService, now, onError } = {}) {
  return createDistributionTickService({
    articleModel: h.articleModel,
    historyModel: h.historyModel,
    distributionService,
    articleService: h.articleService,
    ...(now ? { now } : {}),
    ...(onError ? { onError } : {}),
  });
}

// ── 1차 엠바고만 설정된 기사 ───────────────────────────────────────────────

test('1차만: 미도래 시각에는 배부하지 않고 상태·이력도 그대로다', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1 });
  const dist = fakeDistribution({ historyModel: h.historyModel });
  const before = h.counts();

  const r = await tickWith(h, { distributionService: dist, now: () => T0 }).run({ actorUserId: 'system' });

  assert.equal(r.ok, true);
  assert.equal(r.at, T0);
  assert.equal(r.scanned, 1, '후보이긴 하다(스캔은 됐다)');
  assert.deepEqual(r.distributed, []);
  assert.deepEqual(r.failed, []);
  assert.equal(dist.calls.length, 0);
  assert.equal(h.statusOf(id), 'DES');
  assert.deepEqual(h.counts(), before, 'self-heal도 쓸 게 없으면 쓰지 않는다');
});

test('1차만: 도래하면 press 1회 배부하고 DES→DPS로 완결한다(1차 배부가 곧 완결)', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1 });
  const dist = fakeDistribution({ historyModel: h.historyModel });

  const r = await tickWith(h, { distributionService: dist, now: () => T1 }).run({ actorUserId: 'system' });

  assert.equal(r.ok, true);
  assert.equal(dist.calls.length, 1);
  assert.deepEqual(dist.calls[0].kinds, ['press']);
  assert.equal(dist.calls[0].actorUserId, 'system');
  assert.deepEqual(r.distributed, [{ articleId: id, kinds: ['press'], status: 'DPS' }]);
  assert.equal(h.statusOf(id), 'DPS');
});

test('경계: embargoAt === now는 도래로 취급한다', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1 });
  const dist = fakeDistribution({ historyModel: h.historyModel });

  await tickWith(h, { distributionService: dist, now: () => T1 }).run({});

  assert.deepEqual(dist.calls.map((c) => c.articleId), [id]);
});

// ── 2차 엠바고만 / 1+2차 ─────────────────────────────────────────────────

test('2차만: 송고 즉시 press가 나간 EPS 기사에 nonpress를 배부하고 EPS→DPS로 완결한다', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'EPS', secondEmbargoAt: T2, distributed: ['press'] });
  const dist = fakeDistribution({ historyModel: h.historyModel, now: () => T2 });

  const r = await tickWith(h, { distributionService: dist, now: () => T2 }).run({ actorUserId: 'system' });

  assert.equal(dist.calls.length, 1);
  assert.deepEqual(dist.calls[0].kinds, ['nonpress'], '이미 나간 press를 다시 배부하지 않는다');
  assert.deepEqual(r.distributed, [{ articleId: id, kinds: ['nonpress'], status: 'DPS' }]);
  assert.equal(h.statusOf(id), 'DPS');
});

test('1+2차: 1차 시각에 press(DES→EPS), 2차 시각에 nonpress(EPS→DPS)', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1, secondEmbargoAt: T2 });

  const first = fakeDistribution({ historyModel: h.historyModel, now: () => T1 });
  const r1 = await tickWith(h, { distributionService: first, now: () => T1 }).run({ actorUserId: 'system' });
  assert.deepEqual(first.calls[0].kinds, ['press']);
  assert.deepEqual(r1.distributed, [{ articleId: id, kinds: ['press'], status: 'EPS' }]);
  assert.equal(h.statusOf(id), 'EPS');

  const second = fakeDistribution({ historyModel: h.historyModel, now: () => T2 });
  const r2 = await tickWith(h, { distributionService: second, now: () => T2 }).run({ actorUserId: 'system' });
  assert.deepEqual(second.calls[0].kinds, ['nonpress']);
  assert.deepEqual(r2.distributed, [{ articleId: id, kinds: ['nonpress'], status: 'DPS' }]);
  assert.equal(h.statusOf(id), 'DPS');

  assert.deepEqual(
    h.historyOf(id).filter((x) => x.eventType === 'distribute').map((x) => x.action),
    ['press', 'nonpress'],
  );
});

test('멱등: 같은 시각으로 연속 2회 실행해도 2회차는 배부 0건이고 DB가 그대로다', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1, secondEmbargoAt: T2 });
  const dist = fakeDistribution({ historyModel: h.historyModel, now: () => T1 });
  const tick = tickWith(h, { distributionService: dist, now: () => T1 });

  await tick.run({ actorUserId: 'system' });
  const afterFirst = h.counts();
  const callsAfterFirst = dist.calls.length;

  const r2 = await tick.run({ actorUserId: 'system' });

  assert.equal(dist.calls.length, callsAfterFirst, '2회차 distribute 호출 0건');
  assert.deepEqual(r2.distributed, []);
  assert.equal(h.statusOf(id), 'EPS', '상태 불변');
  assert.deepEqual(h.counts(), afterFirst, 'Contents/Article/ArticleHistory 행 수 불변(self-heal 쓰기 0건)');
});

// ── 상태 게이트 ──────────────────────────────────────────────────────────

test('제외 상태: EEK·EEH·DPD·RDS·DDH는 엠바고가 도래해도 절대 배부되지 않는다', async () => {
  const h = harness();
  const ids = ['EEK', 'EEH', 'DPD', 'RDS', 'DDH'].map((status) => [status, h.addArticle({ status, embargoAt: T1 })]);
  const dist = fakeDistribution({ historyModel: h.historyModel });
  const before = h.counts();

  const r = await tickWith(h, { distributionService: dist, now: () => T2 }).run({ actorUserId: 'system' });

  assert.equal(dist.calls.length, 0, '미송고·킬·보류·삭제 기사는 외부로 나가지 않는다');
  assert.equal(r.scanned, 0, '상태 allowlist 밖은 후보가 아니다');
  assert.deepEqual(r.distributed, []);
  for (const [status, id] of ids) assert.equal(h.statusOf(id), status, status);
  assert.deepEqual(h.counts(), before);
});

test('레거시 DPS: 엠바고가 설정됐지만 배부 이력이 없는 DPS 기사도 배부하되 상태는 DPS 그대로다', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DPS', embargoAt: T1, secondEmbargoAt: T2 });
  const dist = fakeDistribution({ historyModel: h.historyModel, now: () => T2 });

  const r = await tickWith(h, { distributionService: dist, now: () => T2 }).run({ actorUserId: 'system' });

  assert.deepEqual(dist.calls[0].kinds, ['press', 'nonpress']);
  assert.deepEqual(r.distributed, [{ articleId: id, kinds: ['press', 'nonpress'], status: 'DPS' }]);
  assert.equal(h.statusOf(id), 'DPS', '상태 역행 없음');
});

test('scanned: 엠바고가 설정된 후보만 센다(엠바고 없는 DPS 기사는 후보가 아니다)', async () => {
  const h = harness();
  h.addArticle({ status: 'DES', embargoAt: T1 });
  h.addArticle({ status: 'EPS', secondEmbargoAt: T2, distributed: ['press'] });
  h.addArticle({ status: 'DPS' });
  h.addArticle({ status: 'DPS' });
  h.addArticle({ status: 'DPS' });
  const dist = fakeDistribution({ historyModel: h.historyModel, now: () => T2 });

  const r = await tickWith(h, { distributionService: dist, now: () => T2 }).run({});

  assert.equal(r.scanned, 2);
  assert.equal(dist.calls.length, 2);
});

// ── 실패·위생 ────────────────────────────────────────────────────────────

test('전량 실패: 승격 없이 failed로만 보고한다(거짓 완결 금지)', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1 });
  const dist = fakeDistribution({
    historyModel: h.historyModel,
    behavior: ({ articleId }) => ({
      ok: true,
      distributed: [],
      failed: [{ articleId, targetId: 3, kind: 'press', spoolDir: 'out/kbs', reason: 'spool-write-failed' }],
    }),
  });

  const r = await tickWith(h, { distributionService: dist, now: () => T1 }).run({ actorUserId: 'system' });

  assert.equal(r.ok, true);
  assert.deepEqual(r.distributed, []);
  assert.deepEqual(r.failed, [{ articleId: id, targetId: 3, kind: 'press', reason: 'spool-write-failed' }]);
  assert.equal(h.statusOf(id), 'DES', '배부되지 않은 기사는 승격하지 않는다');
});

test('부분 성공: 성공한 kind만 승격 근거가 된다(press 성공·nonpress 실패 → DPS 아님 EPS)', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1, secondEmbargoAt: T2 });
  const dist = fakeDistribution({
    historyModel: h.historyModel,
    now: () => T2,
    behavior: ({ articleId }) => ({
      ok: true,
      distributed: [{ targetId: 1, kind: 'press', spoolDir: 'out/kbs', file: `/spool/out/kbs/${articleId}.json` }],
      failed: [{ articleId, targetId: 2, kind: 'nonpress', spoolDir: 'out/portal', reason: 'spool-write-failed' }],
    }),
  });

  const r = await tickWith(h, { distributionService: dist, now: () => T2 }).run({ actorUserId: 'system' });

  assert.deepEqual(r.distributed, [{ articleId: id, kinds: ['press'], status: 'EPS' }]);
  assert.deepEqual(r.failed, [{ articleId: id, targetId: 2, kind: 'nonpress', reason: 'spool-write-failed' }]);
  assert.equal(h.statusOf(id), 'EPS');
});

test('경로 비노출: failed 항목에 spoolDir 키가 없고 요약 어디에도 스풀 경로 문자열이 없다', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1 });
  const dist = fakeDistribution({
    historyModel: h.historyModel,
    behavior: ({ articleId }) => ({
      ok: true,
      distributed: [],
      failed: [{
        articleId, targetId: 9, kind: 'press', spoolDir: 'out/kbs',
        file: '/srv/spool/out/kbs/tmp.json', reason: 'invalid-spool-dir',
      }],
    }),
  });

  const r = await tickWith(h, { distributionService: dist, now: () => T1 }).run({ actorUserId: 'system' });

  assert.deepEqual(Object.keys(r.failed[0]).sort(), ['articleId', 'kind', 'reason', 'targetId']);
  assert.equal(r.failed[0].articleId, id);
  const dump = JSON.stringify(r);
  assert.equal(dump.includes('out/kbs'), false, '서버 파일시스템 경로가 tick 응답으로 새지 않는다');
  assert.equal(dump.includes('/srv/spool'), false);
  assert.equal(dump.includes('spoolDir'), false);
});

test('예외 격리: 한 기사의 배부가 reject해도 다른 기사는 계속 배부되고 원시 에러 문자열은 노출되지 않는다', async () => {
  const h = harness();
  const bad = h.addArticle({ status: 'DES', embargoAt: T1 });
  const good = h.addArticle({ status: 'DES', embargoAt: T1 });
  const seen = [];
  const dist = fakeDistribution({
    historyModel: h.historyModel,
    behavior: ({ articleId }) => {
      if (articleId === bad) throw new Error('spool full at /srv/spool/out/kbs');
      return {
        ok: true,
        distributed: [{ targetId: 1, kind: 'press', spoolDir: 'out/kbs', file: 'x' }],
        failed: [],
      };
    },
  });

  const r = await tickWith(h, {
    distributionService: dist, now: () => T1, onError: (info) => seen.push(info),
  }).run({ actorUserId: 'system' });

  assert.equal(r.ok, true, 'run은 throw하지 않는다');
  assert.deepEqual(r.distributed, [{ articleId: good, kinds: ['press'], status: 'DPS' }]);
  assert.deepEqual(r.failed, [{ articleId: bad, targetId: null, kind: null, reason: 'tick-failed' }]);
  const dump = JSON.stringify(r);
  assert.equal(dump.includes('/srv/spool'), false, '에러 메시지로 경로가 우회 유출되지 않는다');
  assert.equal(dump.includes('spool full'), false);
  // 원인은 삼키지 않고 주입된 로거로 표면화한다(운영 신호 — 무음 삼킴 금지).
  assert.equal(seen.length, 1);
  assert.equal(seen[0].articleId, bad);
  assert.match(String(seen[0].error), /spool full/);
});

test('onError가 throw해도 스캔은 계속된다', async () => {
  const h = harness();
  h.addArticle({ status: 'DES', embargoAt: T1 });
  const good = h.addArticle({ status: 'DES', embargoAt: T1 });
  const dist = fakeDistribution({
    historyModel: h.historyModel,
    behavior: ({ articleId }) => {
      if (articleId !== good) throw new Error('boom');
      return { ok: true, distributed: [{ targetId: 1, kind: 'press' }], failed: [] };
    },
  });

  const r = await tickWith(h, {
    distributionService: dist, now: () => T1, onError: () => { throw new Error('로그 실패'); },
  }).run({});

  assert.equal(r.ok, true);
  assert.deepEqual(r.distributed.map((d) => d.articleId), [good]);
});

test('파싱 불가 엠바고 값: 배부하지 않고 invalid로 표면화한다(무음 삼킴 금지)', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: '내일 오전' });
  const dist = fakeDistribution({ historyModel: h.historyModel });

  const r = await tickWith(h, { distributionService: dist, now: () => T2 }).run({});

  assert.equal(dist.calls.length, 0);
  assert.equal(r.scanned, 1);
  assert.deepEqual(r.invalid, [{ articleId: id, field: 'embargoAt' }]);
  assert.equal(h.statusOf(id), 'DES');
});

test('distributionService 미주입: spool-disabled로 거부하고 DB를 건드리지 않는다', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1 });
  const before = h.counts();

  const r = await tickWith(h, { now: () => T1 }).run({ actorUserId: 'system' });

  assert.deepEqual(r, { ok: false, reason: 'spool-disabled' });
  assert.equal(h.statusOf(id), 'DES');
  assert.deepEqual(h.counts(), before);
});

test('조회 자체가 실패해도 throw하지 않는다(라우트가 500으로 새지 않게)', async () => {
  const h = harness();
  const broken = createDistributionTickService({
    articleModel: { query() { throw new Error('db down'); } },
    historyModel: h.historyModel,
    distributionService: fakeDistribution({ historyModel: h.historyModel }),
    articleService: h.articleService,
    now: () => T1,
  });

  const r = await broken.run({});
  assert.deepEqual(r, { ok: false, reason: 'tick-failed' });
});

// ── 동시 변경 재검증(TOCTOU)·중복 실행 방지 ──────────────────────────────

test('TOCTOU: 스캔 후 배부 전에 KILL(EEK)된 기사는 스풀로 나가지 않고 사유가 요약에 남는다', async () => {
  const h = harness();
  const a1 = h.addArticle({ status: 'DES', embargoAt: T1 });
  const a2 = h.addArticle({ status: 'DES', embargoAt: T1 });
  // 선행 기사 배부의 await 동안 나머지 한 건이 KILL된다 — 스캔 스냅샷은 아직 DES다(리뷰어 재현 시나리오).
  let killedId = null;
  let survivorId = null;
  const dist = fakeDistribution({
    historyModel: h.historyModel,
    behavior: async ({ articleId }) => {
      if (killedId === null) {
        survivorId = articleId;
        killedId = articleId === a1 ? a2 : a1;
        h.articleModel.update(killedId, { contents: { status: 'EEK' } });
      }
      return { ok: true, distributed: [{ targetId: 1, kind: 'press' }], failed: [] };
    },
  });

  const r = await tickWith(h, { distributionService: dist, now: () => T1 }).run({ actorUserId: 'system' });

  assert.equal(dist.calls.length, 1, 'KILL된 기사는 배부 지시조차 나가지 않는다');
  assert.deepEqual(dist.calls.map((c) => c.articleId), [survivorId]);
  assert.deepEqual(r.distributed, [{ articleId: survivorId, kinds: ['press'], status: 'DPS' }]);
  assert.deepEqual(
    r.failed,
    [{ articleId: killedId, targetId: null, kind: null, reason: 'status-changed' }],
    '무음 스킵 금지 — 요약에 고정 사유로 남는다(식별자·사유만)',
  );
  assert.equal(h.statusOf(killedId), 'EEK', 'KILL 상태는 건드리지 않는다');
  assert.deepEqual(
    h.historyOf(killedId).filter((x) => x.eventType === 'distribute'),
    [],
    'KILL된 기사에는 배부 이력도 남지 않는다',
  );
});

test('TOCTOU: 스캔 후 엠바고가 미래로 수정된 기사는 최신 contents로 재평가되어 배부하지 않는다', async () => {
  const h = harness();
  const a1 = h.addArticle({ status: 'DES', embargoAt: T1 });
  const a2 = h.addArticle({ status: 'DES', embargoAt: T1 });
  let deferredId = null;
  const dist = fakeDistribution({
    historyModel: h.historyModel,
    behavior: async ({ articleId }) => {
      if (deferredId === null) {
        deferredId = articleId === a1 ? a2 : a1;
        h.articleModel.update(deferredId, { contents: { embargoAt: T2 } });
      }
      return { ok: true, distributed: [{ targetId: 1, kind: 'press' }], failed: [] };
    },
  });

  const r = await tickWith(h, { distributionService: dist, now: () => T1 }).run({});

  assert.equal(dist.calls.length, 1, '미도래로 되돌아간 기사는 배부하지 않는다');
  assert.deepEqual(r.failed, [], '상태는 여전히 유효하므로 실패가 아니다 — 다음 tick이 다시 판정한다');
  assert.equal(h.statusOf(deferredId), 'DES');
});

test('single-flight: run() 동시 호출은 한쪽만 스캔하고 다른 쪽은 in-progress로 즉시 반환한다(중복 배부 금지)', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1 });
  const dist = fakeDistribution({
    historyModel: h.historyModel,
    // 배부 이력이 남기 전에 이벤트 루프를 넘긴다 — 두 번째 run의 스캔이 "미배부"를 보는 창(리뷰어 재현).
    behavior: async () => {
      await new Promise((resolve) => { setImmediate(resolve); });
      return { ok: true, distributed: [{ targetId: 1, kind: 'press' }], failed: [] };
    },
  });
  const tick = tickWith(h, { distributionService: dist, now: () => T1 });

  const [r1, r2] = await Promise.all([tick.run({ actorUserId: 'system' }), tick.run({ actorUserId: 'system' })]);

  assert.equal(dist.calls.length, 1, '스풀 1개·이력 1행 — 중복 배부 없음');
  assert.deepEqual(r1.distributed, [{ articleId: id, kinds: ['press'], status: 'DPS' }]);
  assert.equal(r2.ok, true);
  assert.equal(r2.scanned, 0);
  assert.equal(r2.skipped, 'in-progress');
  assert.deepEqual(r2.distributed, []);
  assert.deepEqual(r2.failed, []);
  assert.equal(h.historyOf(id).filter((x) => x.eventType === 'distribute').length, 1);

  // 진행 중 표시는 실행이 끝나면 해제된다 — 후속 run은 정상 스캔한다(멱등이라 재배부는 없다).
  const r3 = await tick.run({});
  assert.equal(r3.skipped, undefined);
  assert.equal(r3.scanned, 1);
  assert.deepEqual(r3.distributed, []);
});

test('활성 수신처 0곳: 성공도 실패도 0인 kind는 no-active-target으로 failed에 남는다(무기록 금지)', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1, secondEmbargoAt: T2 });
  const dist = fakeDistribution({
    historyModel: h.historyModel,
    now: () => T2,
    // press는 활성 수신처가 있어 성공, nonpress는 활성 수신처 0곳 — 실물 반환 shape 그대로
    // (distributionService는 수신처가 없는 kind를 distributed/failed 어디에도 남기지 않는다).
    behavior: () => ({
      ok: true,
      distributed: [{ targetId: 1, kind: 'press', spoolDir: 'out/kbs', file: 'x' }],
      failed: [],
    }),
  });

  const r = await tickWith(h, { distributionService: dist, now: () => T2 }).run({ actorUserId: 'system' });

  assert.deepEqual(dist.calls[0].kinds, ['press', 'nonpress']);
  assert.deepEqual(r.distributed, [{ articleId: id, kinds: ['press'], status: 'EPS' }]);
  assert.deepEqual(
    r.failed,
    [{ articleId: id, targetId: null, kind: 'nonpress', reason: 'no-active-target' }],
    '도래했는데 수신처 0곳인 kind가 요약에서 무음으로 사라지면 안 된다(경로 비노출 유지)',
  );
  assert.equal(h.statusOf(id), 'EPS', '성공한 press만 승격 근거가 된다');
});

// ── 순서·시계·위임 ───────────────────────────────────────────────────────

test('후보는 순차로 처리한다(동시 실행 금지 — 상태/이력 쓰기 경합 방지)', async () => {
  const h = harness();
  h.addArticle({ status: 'DES', embargoAt: T1 });
  h.addArticle({ status: 'DES', embargoAt: T1 });
  h.addArticle({ status: 'DES', embargoAt: T1 });

  let inFlight = 0;
  let maxInFlight = 0;
  const dist = fakeDistribution({
    historyModel: h.historyModel,
    behavior: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return { ok: true, distributed: [{ targetId: 1, kind: 'press' }], failed: [] };
    },
  });

  await tickWith(h, { distributionService: dist, now: () => T1 }).run({});

  assert.equal(dist.calls.length, 3);
  assert.equal(maxInFlight, 1, 'Promise.all 병렬 배부 금지');
});

test('now 기본값은 ISO-8601 UTC 문자열이다(숫자 시계는 전 기사를 조용히 미도래로 만든다)', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: '2020-01-01T00:00:00.000Z' });
  const dist = fakeDistribution({ historyModel: h.historyModel, now: () => '2020-01-02T00:00:00.000Z' });

  // now 미주입 = 실서버 기본 경로. 과거 엠바고가 실제로 배부되어야 한다.
  const r = await tickWith(h, { distributionService: dist }).run({});

  assert.match(r.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(dist.calls.map((c) => c.articleId), [id]);
});

test('시계 계약 위반(파싱 불가 now): 아무것도 배부하지 않고 DB도 그대로다(안전 기본값 — 조기 배부 방지)', async () => {
  const h = harness();
  // 과거에 이미 도래한 엠바고 — 정상 시계라면 배부됐어야 하는 기사다.
  const id = h.addArticle({ status: 'DES', embargoAt: '2020-01-01T00:00:00.000Z' });
  const dist = fakeDistribution({ historyModel: h.historyModel });
  const before = h.counts();

  // 시계가 ISO-8601 문자열 계약을 어기면(고장·설정 오류) "지금"을 알 수 없다 —
  // 실시간 폴백으로 배부를 강행하지 않고 전량 미배부로 떨어져야 한다(embargoPolicy 안전 기본값의 결선 검증).
  const r = await tickWith(h, { distributionService: dist, now: () => '시계 고장' }).run({ actorUserId: 'system' });

  assert.equal(r.ok, true, 'run은 throw하지 않는다');
  assert.equal(r.at, '시계 고장', '실행 시각은 가공 없이 그대로 보고된다(운영자가 고장을 볼 수 있게)');
  assert.equal(r.scanned, 1, '후보 스캔 자체는 이뤄진다');
  assert.deepEqual(r.distributed, []);
  assert.deepEqual(r.failed, []);
  assert.equal(dist.calls.length, 0, '잘못된 시계로는 어떤 기사도 외부로 내보내지 않는다');
  assert.equal(h.statusOf(id), 'DES');
  assert.deepEqual(h.counts(), before, 'self-heal도 쓸 게 없으면 쓰기 0건');
});

test('self-heal: 배부 이력은 있는데 승격이 누락된 기사를 재정합한다(도래분 없음)', async () => {
  const h = harness();
  // 1차만 설정 + press 배부 이력 존재 → 이미 완결(DPS)이어야 하는데 DES로 남은 기사.
  const id = h.addArticle({ status: 'DES', embargoAt: T1, distributed: ['press'] });
  const dist = fakeDistribution({ historyModel: h.historyModel });

  const r = await tickWith(h, { distributionService: dist, now: () => T2 }).run({ actorUserId: 'system' });

  assert.equal(dist.calls.length, 0, '재배부는 하지 않는다');
  assert.equal(h.statusOf(id), 'DPS');
  assert.deepEqual(r.distributed, [], '이번 tick이 배부한 것은 없다');
  const embargoRows = h.historyOf(id).filter((x) => x.action === 'embargo');
  assert.equal(embargoRows.length, 1);
  assert.equal(embargoRows[0].actorUserId, 'system');
});

test('self-heal은 DES/EPS에서만 — 엠바고가 모두 해제된 DES 기사는 후보가 아니며 자동 승격되지 않는다', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', distributed: ['press'] });
  const dist = fakeDistribution({ historyModel: h.historyModel });
  const before = h.counts();

  const r = await tickWith(h, { distributionService: dist, now: () => T2 }).run({});

  assert.equal(r.scanned, 0);
  assert.equal(h.statusOf(id), 'DES', '배부되지 않은 기사를 완결 처리하지 않는다(phase 48 범위 밖)');
  assert.deepEqual(h.counts(), before);
});

// ── 실물 결선(distributedAt 계약) ────────────────────────────────────────

test('distributedAt은 distributionService가 갱신한다 — 1차 후 T1, 2차 후 T2(T2 > T1)', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1, secondEmbargoAt: T2 });
  h.distributionTargetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y', createdAt: T0, updatedAt: T0 });
  h.distributionTargetModel.insert({ name: '포털', kind: 'nonpress', spoolDir: 'portal', active: 'Y', createdAt: T0, updatedAt: T0 });

  // 실제 distributionService + 실제 spoolWriter. FS 조작만 주입해 디스크를 건드리지 않는다.
  const fsCalls = [];
  const realDistribution = (stamp) => createDistributionService({
    distributionTargetModel: h.distributionTargetModel,
    articleModel: h.articleModel,
    historyModel: h.historyModel,
    spoolWriter: createSpoolWriter({
      rootDir: 'spool-root',
      mkdir: async () => { fsCalls.push('mkdir'); },
      writeFile: async () => { fsCalls.push('writeFile'); },
      rename: async () => { fsCalls.push('rename'); },
      now: () => stamp,
    }),
    now: () => stamp,
  });

  const r1 = await tickWith(h, { distributionService: realDistribution(T1), now: () => T1 }).run({ actorUserId: 'system' });
  assert.deepEqual(r1.distributed, [{ articleId: id, kinds: ['press'], status: 'EPS' }]);
  assert.equal(h.contentsOf(id).distributedAt, T1);

  const r2 = await tickWith(h, { distributionService: realDistribution(T2), now: () => T2 }).run({ actorUserId: 'system' });
  assert.deepEqual(r2.distributed, [{ articleId: id, kinds: ['nonpress'], status: 'DPS' }]);
  assert.equal(h.contentsOf(id).distributedAt, T2);
  assert.equal(h.contentsOf(id).distributedAt > T1, true, '최근 배부 시각으로 갱신된다(SCHEMA.md:49)');

  // 과거 배부 사실은 append-only 이력에 남는다 — 정보 손실 없음.
  assert.deepEqual(
    h.historyOf(id).filter((x) => x.eventType === 'distribute').map((x) => x.action),
    ['press', 'nonpress'],
  );
  assert.equal(fsCalls.filter((c) => c === 'rename').length, 2, '수신처 2곳에 각각 1건씩 게시된다');
  assert.equal(JSON.stringify(r1).includes('kbs'), false, '실물 결선에서도 경로는 요약에 담기지 않는다');
  assert.equal(JSON.stringify(r2).includes('portal'), false);
});

test('실물 결선: kind 사이 상태 전이 중단은 no-active-target이 아니라 status-changed로 보고된다', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1, secondEmbargoAt: T2 });
  h.distributionTargetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y', createdAt: T0, updatedAt: T0 });
  h.distributionTargetModel.insert({ name: '포털', kind: 'nonpress', spoolDir: 'portal', active: 'Y', createdAt: T0, updatedAt: T0 });

  // press 스풀 쓰기 await 도중 데스크가 삭제 승인(DPD) — 레이스를 결정적으로 재현.
  const writer = {
    calls: [],
    async write(args) {
      writer.calls.push(args.spoolDir);
      if (writer.calls.length === 1) h.articleModel.update(id, { contents: { status: 'DPD' } });
      return { ok: true, file: `/spool/${args.spoolDir}/${id}.json` };
    },
  };
  const dist = createDistributionService({
    distributionTargetModel: h.distributionTargetModel,
    articleModel: h.articleModel,
    historyModel: h.historyModel,
    spoolWriter: writer,
    now: () => T2,
  });

  const r = await tickWith(h, { distributionService: dist, now: () => T2 }).run({ actorUserId: 'system' });

  assert.deepEqual(writer.calls, ['kbs'], 'nonpress 쓰기는 일어나지 않는다');
  // 활성 수신처(portal)가 있는데 "수신처 0곳"으로 오보하면 운영자가 원인을 잘못 읽는다.
  assert.equal(r.failed.some((f) => f.reason === 'no-active-target'), false);
  assert.deepEqual(
    r.failed.filter((f) => f.kind === 'nonpress'),
    [{ articleId: id, targetId: null, kind: 'nonpress', reason: 'status-changed' }],
  );
  assert.equal(r.distributed.length, 1);
  assert.deepEqual(r.distributed[0].kinds, ['press'], '중단 전 성공한 press 배부는 사실로 남는다');
  assert.equal(h.statusOf(id), 'DPD', 'DPD는 불변 상태 — tick도 가드도 status를 되돌리지 않는다');
});

// ── DB 비파괴 ────────────────────────────────────────────────────────────

test('DB 비파괴: 행 수·송고 이력·sentAt/sender/본문은 tick 후에도 그대로다', async () => {
  const h = harness();
  const id = h.addArticle({ status: 'DES', embargoAt: T1, secondEmbargoAt: T2 });
  const dist = fakeDistribution({ historyModel: h.historyModel, now: () => T2 });
  const before = h.counts();
  const contentsBefore = h.contentsOf(id);

  await tickWith(h, { distributionService: dist, now: () => T2 }).run({ actorUserId: 'system' });

  const after = h.counts();
  assert.equal(after.article, before.article);
  assert.equal(after.contents, before.contents);
  assert.equal(after.history > before.history, true, '이력은 append-only로 늘어난다');

  const contentsAfter = h.contentsOf(id);
  assert.equal(contentsAfter.sentAt, contentsBefore.sentAt);
  assert.equal(contentsAfter.sender, contentsBefore.sender);
  assert.equal(contentsAfter.embargoAt, contentsBefore.embargoAt);
  assert.equal(contentsAfter.secondEmbargoAt, contentsBefore.secondEmbargoAt);
  assert.equal(h.articleModel.getById(id).article.markupVersion, MARKUP);

  const sends = h.historyOf(id).filter((x) => x.eventType === 'status' && x.action === 'send');
  assert.equal(sends.length, 1, '기존 송고 이력이 보존된다');
});

// ── 배부 사이클 경계 — 보류→엠바고 재설정→재송고 회귀(phase 51) ──────────────────
// 픽스처를 직접 심지 않고 실제 전이(applyAction/update)를 밟는다 — 결함이 상태 전이와
// append-only 이력의 상호작용에서 나오므로, 이력 순서까지 실물과 같아야 재현된다.
// 잠그는 것: 과거 사이클의 배부 이력이 (1) 새 사이클의 도래분 배부를 막지 않고
// (2) DES를 DPS로 거짓 완결시키지 않는다. 거짓 완결은 MUTABLE_STATUSES 밖이라 복구 경로가 없다.

// 엠바고 기사를 만들어 데스크가 송고한다(RDS→DES) — 송고 이력이 사이클 경계로 남는다.
function sendEmbargoArticle(h, contents) {
  const { articleId } = h.articleService.create({
    title: '엠바고 기사', markupVersion: MARKUP, author: 'r1', ...contents,
  });
  assert.deepEqual(
    h.articleService.applyAction(articleId, 'D', 'send', { userId: 'desk1' }),
    { ok: true, status: 'DES' },
    '엠바고가 설정된 기사의 송고는 DES(배부 전 대기)로 진입한다',
  );
  return articleId;
}

// 보류(DPS→DDH) → (선택) 엠바고 재설정 → 재송고(DDH→DES). 새 배부 사이클이 열린다.
function reopenCycle(h, articleId, embargoFields) {
  assert.deepEqual(
    h.articleService.applyAction(articleId, 'D', 'hold', { userId: 'desk1' }),
    { ok: true, status: 'DDH' },
  );
  if (embargoFields) h.articleService.update(articleId, { ...embargoFields, modifier: 'desk1' });
  assert.deepEqual(
    h.articleService.applyAction(articleId, 'D', 'send', { userId: 'desk1' }),
    { ok: true, status: 'DES' },
  );
}

test('사이클 경계: 보류 후 엠바고를 재설정해 재송고한 기사는 과거 배부 이력으로 거짓 완결되지 않고 새 시각에 배부된다', async () => {
  const h = harness();
  const id = sendEmbargoArticle(h, { embargoAt: T1 });
  const before = h.counts();

  // 1차 사이클: T1 도래 → press 배부 → 완결(DPS)
  const c1 = fakeDistribution({ historyModel: h.historyModel, now: () => T1 });
  const r1 = await tickWith(h, { distributionService: c1, now: () => T1 }).run({ actorUserId: 'system' });
  assert.deepEqual(r1.distributed, [{ articleId: id, kinds: ['press'], status: 'DPS' }]);
  assert.equal(h.statusOf(id), 'DPS');

  // 보류 → 엠바고를 미래(T9)로 재설정 → 재송고 → 새 사이클(DES)
  reopenCycle(h, id, { embargoAt: T9 });
  assert.equal(h.statusOf(id), 'DES');

  // (1) 미도래 tick: 배부 0건 + DES 유지. 과거 사이클 이력으로 DPS 승격이 일어나면
  //     이후 어떤 tick도 이 기사를 배부하지 못한다(무음 미배부 + 거짓 완결).
  const c2 = fakeDistribution({ historyModel: h.historyModel, now: () => T1 });
  const r2 = await tickWith(h, { distributionService: c2, now: () => T1 }).run({ actorUserId: 'system' });
  assert.equal(c2.calls.length, 0, '엠바고 시각 전에는 배부 지시 자체가 나가지 않는다');
  assert.deepEqual(r2.distributed, []);
  assert.deepEqual(r2.failed, []);
  assert.equal(h.statusOf(id), 'DES', '새 사이클의 DES가 과거 이력으로 완결 승격되면 안 된다');

  // (2) 재설정된 시각 도래 → press 1건 배부 후 완결
  const c3 = fakeDistribution({ historyModel: h.historyModel, now: () => T9 });
  const r3 = await tickWith(h, { distributionService: c3, now: () => T9 }).run({ actorUserId: 'system' });
  assert.equal(c3.calls.length, 1);
  assert.deepEqual(c3.calls[0].kinds, ['press']);
  assert.deepEqual(r3.distributed, [{ articleId: id, kinds: ['press'], status: 'DPS' }]);
  assert.equal(h.statusOf(id), 'DPS');

  // (3) 멱등: 같은 사이클 안에서는 다시 배부하지 않는다.
  const c4 = fakeDistribution({ historyModel: h.historyModel, now: () => T9 });
  const r4 = await tickWith(h, { distributionService: c4, now: () => T9 }).run({ actorUserId: 'system' });
  assert.equal(c4.calls.length, 0);
  assert.deepEqual(r4.distributed, []);

  const after = h.counts();
  assert.equal(after.article, before.article, '행 수는 줄지 않는다');
  assert.equal(after.contents, before.contents);
  assert.equal(after.history > before.history, true, '이력은 append-only로만 늘어난다');
});

test('사이클 경계: 새 사이클이어도 미도래 엠바고는 스풀에 한 건도 쓰이지 않는다(시각 게이트 불변)', async () => {
  const h = harness();
  const id = sendEmbargoArticle(h, { embargoAt: T1 });
  h.distributionTargetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y', createdAt: T0, updatedAt: T0 });

  // 실제 distributionService + spoolWriter. FS 조작만 주입해 디스크를 건드리지 않는다.
  const fsCalls = [];
  const realDistribution = (stamp) => createDistributionService({
    distributionTargetModel: h.distributionTargetModel,
    articleModel: h.articleModel,
    historyModel: h.historyModel,
    spoolWriter: createSpoolWriter({
      rootDir: 'spool-root',
      mkdir: async () => { fsCalls.push('mkdir'); },
      writeFile: async () => { fsCalls.push('writeFile'); },
      rename: async () => { fsCalls.push('rename'); },
      now: () => stamp,
    }),
    now: () => stamp,
  });

  await tickWith(h, { distributionService: realDistribution(T1), now: () => T1 }).run({ actorUserId: 'system' });
  assert.equal(fsCalls.filter((c) => c === 'rename').length, 1, '1차 사이클은 정상 게시된다');

  reopenCycle(h, id, { embargoAt: T9 });
  const r = await tickWith(h, { distributionService: realDistribution(T2), now: () => T2 }).run({ actorUserId: 'system' });

  assert.equal(fsCalls.filter((c) => c === 'rename').length, 1, '미도래 엠바고는 새 사이클에서도 나가지 않는다');
  assert.equal(fsCalls.filter((c) => c === 'writeFile').length, 1);
  assert.deepEqual(r.distributed, []);
  assert.deepEqual(r.failed, []);
  assert.equal(h.statusOf(id), 'DES');
});

test('사이클 경계: 재설정된 1+2차는 새 사이클에서 T9에 press(EPS), T10에 nonpress(DPS)로 배부된다', async () => {
  const h = harness();
  const id = sendEmbargoArticle(h, { embargoAt: T1 });

  const c1 = fakeDistribution({ historyModel: h.historyModel, now: () => T1 });
  await tickWith(h, { distributionService: c1, now: () => T1 }).run({ actorUserId: 'system' });
  assert.equal(h.statusOf(id), 'DPS');

  reopenCycle(h, id, { embargoAt: T9, secondEmbargoAt: T10 });

  const c2 = fakeDistribution({ historyModel: h.historyModel, now: () => T9 });
  const r2 = await tickWith(h, { distributionService: c2, now: () => T9 }).run({ actorUserId: 'system' });
  assert.deepEqual(c2.calls[0].kinds, ['press'], '2차 시각(T10)은 아직 미도래');
  assert.deepEqual(r2.distributed, [{ articleId: id, kinds: ['press'], status: 'EPS' }]);
  assert.equal(h.statusOf(id), 'EPS');

  const c3 = fakeDistribution({ historyModel: h.historyModel, now: () => T10 });
  const r3 = await tickWith(h, { distributionService: c3, now: () => T10 }).run({ actorUserId: 'system' });
  assert.deepEqual(c3.calls[0].kinds, ['nonpress'], '같은 사이클의 press는 다시 배부하지 않는다');
  assert.deepEqual(r3.distributed, [{ articleId: id, kinds: ['nonpress'], status: 'DPS' }]);
  assert.equal(h.statusOf(id), 'DPS');
});

test('사이클 경계: 엠바고를 고치지 않은 재송고는 도래한 kind에 정정본을 다시 배부한다(의도된 동작 — 되돌리지 말 것)', async () => {
  // 근거: phases/51-security-hotfix/step3.md §배경 "의도된 동작 변화".
  // 재송고로 새 사이클이 열리면 과거 사이클에 나간 kind는 "정정본 재배부" 대상이다 —
  // phase 49가 DPS 재송고에 확정한 "이미 배부된 곳에 정정본" 의미론과 동형이며,
  // 대안(과거 이력을 계속 세는 것)은 곧 영구 미배부 결함이다. 재배부는 사이클당 1회다.
  const h = harness();
  const id = sendEmbargoArticle(h, { embargoAt: T1 });

  const c1 = fakeDistribution({ historyModel: h.historyModel, now: () => T1 });
  await tickWith(h, { distributionService: c1, now: () => T1 }).run({ actorUserId: 'system' });
  assert.equal(h.statusOf(id), 'DPS');
  const afterFirst = h.counts();

  reopenCycle(h, id); // 엠바고 시각은 그대로 둔 채 재송고

  const c2 = fakeDistribution({ historyModel: h.historyModel, now: () => T2 });
  const r2 = await tickWith(h, { distributionService: c2, now: () => T2 }).run({ actorUserId: 'system' });
  assert.equal(c2.calls.length, 1);
  assert.deepEqual(c2.calls[0].kinds, ['press'], '도래한 kind에 정정본이 다시 나간다');
  assert.deepEqual(r2.distributed, [{ articleId: id, kinds: ['press'], status: 'DPS' }]);
  assert.equal(h.statusOf(id), 'DPS');

  const c3 = fakeDistribution({ historyModel: h.historyModel, now: () => T2 });
  const r3 = await tickWith(h, { distributionService: c3, now: () => T2 }).run({ actorUserId: 'system' });
  assert.equal(c3.calls.length, 0, '사이클 내 배부 이력으로 이후 tick은 멱등이다');
  assert.deepEqual(r3.distributed, []);

  const after = h.counts();
  assert.equal(after.article, afterFirst.article);
  assert.equal(after.contents, afterFirst.contents);
  assert.equal(after.history > afterFirst.history, true);
  const distRows = h.historyOf(id).filter((x) => x.eventType === 'distribute');
  assert.deepEqual(distRows.map((x) => x.action), ['press', 'press'], '과거 사이클 이력이 남고 새 배부가 append된다');
  assert.equal(distRows[0].createdAt, T1, '과거 배부 이력 행은 수정되지 않는다');
});

test('사이클 경계 미적용(DPS): 완결 기사를 정정본으로 재송고해도 tick은 이미 나간 수신처로 다시 배부하지 않는다', async () => {
  // phase 49 계약(DPS 재송고 = 이미 배부된 곳에 정정본)의 tick 쪽 무손상 검증이다.
  // 재송고 이력은 배부 이력보다 **뒤**에 남으므로, DPS까지 사이클 경계를 적용하면 tick이
  // "이번 사이클 미배부"로 오판해 이미 press를 받은 수신처로 한 번 더 내보낸다(회수 불가).
  // 송고 훅 자체의 정정본 배부는 articleSendDistribution.test.js의 계약이다 —
  // 여기 harness의 articleService에는 distributionService가 없어 훅이 돌지 않으므로 tick만 관측된다.
  const h = harness();
  const id = sendEmbargoArticle(h, { embargoAt: T1 });

  const c1 = fakeDistribution({ historyModel: h.historyModel, now: () => T1 });
  await tickWith(h, { distributionService: c1, now: () => T1 }).run({ actorUserId: 'system' });
  assert.equal(h.statusOf(id), 'DPS', '1차 사이클 완결');

  // 보류를 거치지 않는 DPS→DPS 재송고(고침 후 재송) — 상태는 DPS 그대로다.
  assert.deepEqual(
    h.articleService.applyAction(id, 'D', 'send', { userId: 'desk1' }),
    { ok: true, status: 'DPS' },
  );
  const afterResend = h.counts();

  // 회귀 재현 조건 확인 — 이 순서(배부 < 재송고)가 아니면 아래 단언은 아무것도 잡지 못한다.
  const rows = h.historyOf(id);
  const lastSend = [...rows].reverse().find((r) => r.eventType === 'status' && r.action === 'send');
  const lastDist = [...rows].reverse().find((r) => r.eventType === 'distribute');
  assert.ok(lastSend.id > lastDist.id, '재송고 이력이 배부 이력 뒤에 남는다');

  const c2 = fakeDistribution({ historyModel: h.historyModel, now: () => T2 });
  const r2 = await tickWith(h, { distributionService: c2, now: () => T2 }).run({ actorUserId: 'system' });

  assert.equal(c2.calls.length, 0, 'tick은 완결 기사의 정정본 재배부에 개입하지 않는다(송고 훅의 책임)');
  assert.deepEqual(r2.distributed, []);
  assert.deepEqual(r2.failed, []);
  assert.equal(h.statusOf(id), 'DPS');
  assert.equal(h.counts().history, afterResend.history, '배부 이력이 늘지 않는다(중복 배부 0건)');
});

test('TOCTOU: 배부 직전에 상태가 바뀌면 "이미 배부됨" 판정도 새 상태 기준으로 다시 센다(중복 배부 금지)', async () => {
  const h = harness();
  // 과거 사이클에 press가 나간 뒤 재송고된 기사(스냅샷 DES) — 사이클 기준이면 미배부로 보인다.
  const target = h.addArticle({ status: 'DES', embargoAt: T1, pastDistributed: ['press'] });
  // 후보는 createdAt DESC로 처리되므로 나중에 추가한 driver가 먼저 배부된다(아래 단언으로 고정).
  const driver = h.addArticle({ status: 'DES', embargoAt: T1 });

  const dist = fakeDistribution({
    historyModel: h.historyModel,
    behavior: async ({ articleId }) => {
      // 선행 기사의 await 동안 target이 완결(DPS)로 전이된다 — allowlist 안이라 TOCTOU 가드는 통과한다.
      if (articleId === driver) h.articleModel.update(target, { contents: { status: 'DPS' } });
      return { ok: true, distributed: [{ targetId: 1, kind: 'press' }], failed: [] };
    },
  });

  const r = await tickWith(h, { distributionService: dist, now: () => T1 }).run({ actorUserId: 'system' });

  assert.deepEqual(dist.calls.map((c) => c.articleId), [driver], 'DPS로 전이된 기사는 전체 이력 기준으로 이미 배부됨');
  assert.deepEqual(r.distributed, [{ articleId: driver, kinds: ['press'], status: 'DPS' }]);
  assert.equal(h.statusOf(target), 'DPS');
  assert.equal(
    h.historyOf(target).filter((x) => x.eventType === 'distribute').length, 1,
    '같은 수신처로 중복 배부되지 않는다(회수 불가)',
  );
});
