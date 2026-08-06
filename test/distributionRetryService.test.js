// 배부 실패 재전송 서비스 테스트 — ADR-008 MVP-4.
// 하네스: in-memory DB + 실제 모델 + 가짜 spoolWriter(실제 FS 미접촉) + 고정 now (distributionService.test.js와 동형).
// CRITICAL: 재전송은 "실패분 복구 전용"이다 — 미해소 실패 행 없이는 어떤 스풀 쓰기도 일어나지 않고(임의 배부 차단),
// 수신처 kind가 실패 이력과 어긋나면 아무것도 보내지 않는다(엠바고 파기 차단).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createDistributionTargetModel } from '../src/models/distributionTargetModel.js';
import { createDistributionRetryService } from '../src/services/distributionRetryService.js';

const NOW = '2026-08-06T05:00:00.000Z';
const ARTICLE_ID = 'AKR20260806000000001';

function fakeWriter({ failFor = new Set(), throwFor = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    async write(args) {
      calls.push(args);
      if (throwFor.has(args.spoolDir)) throw new Error('disk on fire /secret/path');
      if (failFor.has(args.spoolDir)) return { ok: false, reason: 'spool-write-failed' };
      return { ok: true, file: `/spool/${args.spoolDir}/${args.articleId}.json` };
    },
  };
}

function setup({ writer = fakeWriter(), targets = [], withArticle = true, status = 'DPS', spoolWriter } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const articleHistoryModel = createArticleHistoryModel(db);
  const distributionTargetModel = createDistributionTargetModel(db);

  if (withArticle) {
    articleModel.insert({
      article: { articleId: ARTICLE_ID, title: '제목', markupVersion: '{"blocks":[{"text":"본문 (끝)"}]}' },
      contents: {
        articleId: ARTICLE_ID, title: '제목', author: 'r1', status,
        createdAt: '2026-08-06T00:00:00.000Z', sentAt: '2026-08-06T04:00:00.000Z',
      },
    });
  }
  const targetIds = {};
  for (const t of targets) {
    targetIds[t.spoolDir] = distributionTargetModel.insert({ active: 'Y', createdAt: NOW, updatedAt: NOW, ...t });
  }

  const onFailureSeen = [];
  const onHistoryErrorSeen = [];
  const service = createDistributionRetryService({
    articleHistoryModel,
    distributionTargetModel,
    articleModel,
    spoolWriter: spoolWriter !== undefined ? spoolWriter : writer,
    now: () => NOW,
    onFailure: (info) => onFailureSeen.push(info),
    onHistoryError: (info) => onHistoryErrorSeen.push(info),
  });
  return {
    db, service, writer, articleModel, articleHistoryModel, distributionTargetModel,
    targetIds, onFailureSeen, onHistoryErrorSeen,
  };
}

// 실패/재전송 이력 시드 헬퍼 — step2의 distributionService가 남기는 행과 같은 shape.
function seedFailure(historyModel, { articleId = ARTICLE_ID, targetId, kind = 'press', reason = 'spool-write-failed', createdAt = NOW } = {}) {
  historyModel.insert({ articleId, eventType: 'distribute-failed', action: kind, targetId, reason, actorUserId: 'sys', createdAt });
}
function seedRetry(historyModel, { articleId = ARTICLE_ID, targetId, kind = 'press', createdAt = NOW } = {}) {
  historyModel.insert({ articleId, eventType: 'distribute-retry', action: kind, targetId, actorUserId: 'z1', createdAt });
}

const contentsOf = (db) => db.prepare('SELECT * FROM Contents WHERE articleId = ?').get(ARTICLE_ID);
const distEventsOf = (db) => db
  .prepare("SELECT * FROM ArticleHistory WHERE eventType IN ('distribute-failed','distribute-retry') ORDER BY id")
  .all();

// ── list ────────────────────────────────────────────────────────────────

// 케이스 1
test('retryService.list: 미해소 실패가 없으면 { ok:true, items: [] }', () => {
  const { service } = setup();
  assert.deepEqual(service.list(), { ok: true, items: [] });
});

// 케이스 2
test('retryService.list: 항목 shape은 10키 정확히 — spoolDir·경로·예외 문자열 미노출', () => {
  const { service, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs-spool-slug' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds['kbs-spool-slug'] });

  const r = service.list();
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.deepEqual(
    Object.keys(r.items[0]).sort(),
    ['articleId', 'failedAt', 'historyId', 'kind', 'kindDistributed',
      'reason', 'targetActive', 'targetKind', 'targetName', 'targetId'].sort(),
    '정확히 이 키들뿐이어야 한다',
  );
  const body = JSON.stringify(r);
  assert.ok(!body.includes('kbs-spool-slug'), 'spoolDir 슬러그가 어떤 필드에도 없다');
  assert.ok(!body.includes('/spool'), '파일 경로가 없다');
});

// 케이스 3
test('retryService.list: targetName/targetKind/targetActive는 대상 행에서 — 행 부재 시 null/null/N 폴백', () => {
  const { service, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  seedFailure(articleHistoryModel, { targetId: 999, kind: 'nonpress' }); // 대상 행 없음(방어)

  const r = service.list();
  assert.equal(r.items.length, 2);
  const known = r.items.find((i) => i.targetId === targetIds.kbs);
  assert.equal(known.targetName, 'KBS');
  assert.equal(known.targetKind, 'press');
  assert.equal(known.targetActive, 'Y');
  const ghost = r.items.find((i) => i.targetId === 999);
  assert.equal(ghost.targetName, null);
  assert.equal(ghost.targetKind, null);
  assert.equal(ghost.targetActive, 'N');
});

// 케이스 4
test('retryService.list: 재전송 성공 이력이 뒤따르면 항목이 사라진다 (step1 판정 재사용)', () => {
  const { service, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  seedRetry(articleHistoryModel, { targetId: targetIds.kbs });
  assert.deepEqual(service.list().items, []);
});

// 케이스 5
test('retryService.list: 다른 기사·수신처·kind의 실패는 각각 별도 항목이다', () => {
  const { service, articleHistoryModel, targetIds } = setup({
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: '포털', kind: 'nonpress', spoolDir: 'portal' },
    ],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'press' });
  seedFailure(articleHistoryModel, { targetId: targetIds.portal, kind: 'nonpress' });
  seedFailure(articleHistoryModel, { articleId: 'AKR-OTHER', targetId: targetIds.kbs, kind: 'press' });

  const items = service.list().items;
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map((i) => `${i.articleId}:${i.targetId}:${i.kind}`)).size, 3);
});

// 케이스 6
test('retryService.list: limit은 정규화·클램프해 모델에 전달된다', () => {
  const { service, articleHistoryModel } = setup();
  const seenLimits = [];
  const origQuery = articleHistoryModel.queryDistributionEvents;
  articleHistoryModel.queryDistributionEvents = (args) => {
    seenLimits.push(args?.limit);
    return origQuery(args);
  };

  service.list({ limit: 5 });
  service.list({ limit: 999999 }); // 과도한 값 — 상한 클램프
  service.list({ limit: 'abc' }); // 비정수 — 기본값
  service.list();                 // 미지정 — 기본값

  assert.equal(seenLimits[0], 5);
  assert.ok(Number.isInteger(seenLimits[1]) && seenLimits[1] <= 1000, `상한 클램프: ${seenLimits[1]}`);
  assert.ok(Number.isInteger(seenLimits[2]) && seenLimits[2] >= 1, '비정수는 기본값으로');
  assert.equal(seenLimits[3], seenLimits[2], '미지정도 같은 기본값');
});

// 케이스 7
test('retryService.list: 정렬은 최신 실패 우선(historyId DESC)', () => {
  const { service, articleHistoryModel, targetIds } = setup({
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
    ],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  seedFailure(articleHistoryModel, { targetId: targetIds.mbc });

  const ids = service.list().items.map((i) => i.historyId);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
  assert.ok(ids[0] > ids[1]);
});

// 케이스 7-1
test('retryService.list: kindDistributed=true — 같은 기사·kind에 distribute 행이 있는 부분 실패', () => {
  const { service, articleHistoryModel, targetIds } = setup({
    status: 'EPS',
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
    ],
  });
  // 이번 사이클: 송고 → kbs 성공(distribute 행) + mbc 실패.
  articleHistoryModel.insert({ articleId: ARTICLE_ID, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DES', actorUserId: 'desk', createdAt: NOW });
  articleHistoryModel.insert({ articleId: ARTICLE_ID, eventType: 'distribute', action: 'press', actorUserId: 'sys', createdAt: NOW });
  seedFailure(articleHistoryModel, { targetId: targetIds.mbc });

  const [item] = service.list().items;
  assert.equal(item.kindDistributed, true, 'tick은 press를 이미 배부됨으로 본다 — 중복 경고 불필요');
});

// 케이스 7-2
test('retryService.list: kindDistributed=false — 전 수신처 실패로 distribute 행이 없는 경우', () => {
  const { service, articleHistoryModel, targetIds } = setup({
    status: 'EPS',
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  articleHistoryModel.insert({ articleId: ARTICLE_ID, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DES', actorUserId: 'desk', createdAt: NOW });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const [item] = service.list().items;
  assert.equal(item.kindDistributed, false, '다음 tick이 전 대상에 배부할 수 있다 — 화면이 경고를 띄운다');
});

// 케이스 7-3
test('retryService.list: kindDistributed 판정은 kind별 독립 — press 배부 행이 nonpress 실패를 가리지 않는다', () => {
  const { service, articleHistoryModel, targetIds } = setup({
    status: 'EPS',
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: '포털', kind: 'nonpress', spoolDir: 'portal' },
    ],
  });
  articleHistoryModel.insert({ articleId: ARTICLE_ID, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DES', actorUserId: 'desk', createdAt: NOW });
  articleHistoryModel.insert({ articleId: ARTICLE_ID, eventType: 'distribute', action: 'press', actorUserId: 'sys', createdAt: NOW });
  seedFailure(articleHistoryModel, { targetId: targetIds.portal, kind: 'nonpress' });

  const [item] = service.list().items;
  assert.equal(item.kind, 'nonpress');
  assert.equal(item.kindDistributed, false, 'press 배부 행은 nonpress 판정에 관여하지 않는다');
});

// 케이스 7-4
test('retryService.list: 같은 기사 실패 3건이어도 queryByArticle 조회는 1회 (distinct articleId 캐시)', () => {
  const { service, articleHistoryModel, targetIds } = setup({
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
      { name: '포털', kind: 'nonpress', spoolDir: 'portal' },
    ],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  seedFailure(articleHistoryModel, { targetId: targetIds.mbc });
  seedFailure(articleHistoryModel, { targetId: targetIds.portal, kind: 'nonpress' });

  let calls = 0;
  const orig = articleHistoryModel.queryByArticle;
  articleHistoryModel.queryByArticle = (id) => { calls += 1; return orig(id); };

  const items = service.list().items;
  assert.equal(items.length, 3);
  assert.equal(calls, 1, 'distinct articleId 당 1회만 조회한다');
});

// 케이스 7-5
test('retryService.list: targetKind가 실패 kind와 다른 항목도 목록에 그대로 나온다 (숨기지 않는다)', () => {
  const { service, articleHistoryModel, targetIds, distributionTargetModel } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'press' });
  distributionTargetModel.update(targetIds.kbs, { kind: 'nonpress' }); // 재분류

  const items = service.list().items;
  assert.equal(items.length, 1, '재전송 불가 사유를 화면이 보여줄 수 있어야 한다');
  assert.equal(items[0].kind, 'press');
  assert.equal(items[0].targetKind, 'nonpress');
});

// 케이스 7-6
test('retryService.list: 사이클 경계 정합 — 과거 사이클 distribute 행이 이번 사이클 전량 실패를 가리지 않는다', () => {
  const { service, articleHistoryModel, targetIds } = setup({
    status: 'EPS', // CYCLE_SCOPED — 마지막 송고 이후만 센다
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  // 과거 사이클: 송고 → press 배부 완료.
  articleHistoryModel.insert({ articleId: ARTICLE_ID, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DES', actorUserId: 'desk', createdAt: '2026-08-05T00:00:00.000Z' });
  articleHistoryModel.insert({ articleId: ARTICLE_ID, eventType: 'distribute', action: 'press', actorUserId: 'sys', createdAt: '2026-08-05T00:01:00.000Z' });
  // 보류→엠바고 재설정→재송고로 새 사이클이 열림.
  articleHistoryModel.insert({ articleId: ARTICLE_ID, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DES', actorUserId: 'desk', createdAt: '2026-08-06T00:00:00.000Z' });
  // 이번 사이클: press 전량 실패(distribute 행 없음).
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'press' });

  const [item] = service.list().items;
  // 전체 이력 판정(distributedKinds)이면 과거 사이클 배부 행 때문에 true가 된다 —
  // 그러면 "다음 tick이 전 대상에 배부한다"는 경고가 사라져, 경고가 막으려던 바로 그 중복이 무경고로 지나간다.
  assert.equal(item.kindDistributed, false, 'cycleDistributedKinds(현 사이클) 판정이어야 한다');
});

// ── retry ───────────────────────────────────────────────────────────────

// 케이스 8
test('retryService.retry: 정상 경로 — 실패 수신처에만 정확히 1회 write, 반환에 file·spoolDir 없음', async () => {
  const { service, writer, articleHistoryModel, targetIds } = setup({
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
    ],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.mbc });

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.mbc, actorUserId: 'z1' });

  assert.equal(r.ok, true);
  assert.equal(writer.calls.length, 1, '다른 수신처로는 쓰지 않는다');
  assert.equal(writer.calls[0].spoolDir, 'mbc');
  assert.deepEqual(
    Object.keys(r).sort(),
    ['articleId', 'at', 'kind', 'ok', 'targetId'],
    'file·spoolDir가 반환에 없다',
  );
  assert.equal(r.articleId, ARTICLE_ID);
  assert.strictEqual(r.targetId, targetIds.mbc);
  assert.equal(r.kind, 'press', 'kind는 실패 이력에서 도출된다');
  assert.equal(r.at, NOW);
});

// 케이스 9
test('retryService.retry: 성공 후 distribute-retry 이력 1건 + distributedAt 갱신, 그 외 컬럼 불변', async () => {
  const { service, db, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  const before = contentsOf(db);

  await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs, actorUserId: 'z1' });

  const retries = distEventsOf(db).filter((h) => h.eventType === 'distribute-retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].action, 'press');
  assert.strictEqual(retries[0].targetId, targetIds.kbs);
  assert.equal(retries[0].actorUserId, 'z1');
  const after = contentsOf(db);
  assert.equal(after.distributedAt, NOW, 'present-only 갱신');
  assert.equal(after.status, before.status);
  assert.equal(after.sentAt, before.sentAt);
  assert.equal(after.lockYN, before.lockYN);
  assert.equal(
    db.prepare('SELECT markupVersion FROM Article WHERE articleId = ?').get(ARTICLE_ID).markupVersion,
    '{"blocks":[{"text":"본문 (끝)"}]}', '본문 불변',
  );
});

// 케이스 10
test('retryService.retry: 성공 후 list()에서 그 항목이 사라진다 (왕복)', async () => {
  const { service, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  assert.equal(service.list().items.length, 1);

  await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });

  assert.deepEqual(service.list().items, []);
});

// 케이스 11 (보안 핵심)
test('retryService.retry: 미해소 실패가 없는 쌍은 no-failure — write 0회·이력 0건 (임의 배부 차단)', async () => {
  const { service, writer, db, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  // 실패 이력이 전혀 없는 기사·수신처 쌍.
  const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });

  assert.deepEqual(r, { ok: false, reason: 'no-failure' });
  assert.equal(writer.calls.length, 0);
  assert.equal(distEventsOf(db).length, 0);
});

// 케이스 11-1 (계획 검토 반영 — "창 밖 실패도 재전송된다")
test('retryService.retry: 오래돼 표시 창 밖으로 밀린 실패도 재전송된다 (articleId 스코프 무제한 조회)', async () => {
  const { service, writer, articleHistoryModel, targetIds } = setup({
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
      { name: 'SBS', kind: 'press', spoolDir: 'sbs' },
      { name: '포털', kind: 'nonpress', spoolDir: 'portal' },
    ],
  });
  // 가장 오래된 실패(kbs) 뒤에 다른 수신처의 이벤트가 여럿 쌓인다 — 최근 N건 창이면 kbs가 밀려난다.
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs, createdAt: '2026-08-01T00:00:00.000Z' });
  seedFailure(articleHistoryModel, { targetId: targetIds.mbc });
  seedFailure(articleHistoryModel, { targetId: targetIds.sbs });
  seedFailure(articleHistoryModel, { targetId: targetIds.portal, kind: 'nonpress' });
  seedRetry(articleHistoryModel, { targetId: targetIds.mbc });
  seedRetry(articleHistoryModel, { targetId: targetIds.sbs });

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });

  assert.equal(r.ok, true, '표시용 작은 limit을 재전송 조회에 쓰면 오래된 실패가 no-failure로 오거부된다');
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].spoolDir, 'kbs');
});

// 케이스 12
test('retryService.retry: 이미 해소된 쌍을 다시 요청해도 no-failure', async () => {
  const { service, writer, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  seedRetry(articleHistoryModel, { targetId: targetIds.kbs });

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });
  assert.deepEqual(r, { ok: false, reason: 'no-failure' });
  assert.equal(writer.calls.length, 0);
});

// 케이스 13
test('retryService.retry: 기사 행이 없으면 not-found, write 0회', async () => {
  const { service, writer, articleHistoryModel, targetIds } = setup({
    withArticle: false,
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });
  assert.deepEqual(r, { ok: false, reason: 'not-found' });
  assert.equal(writer.calls.length, 0);
});

// 케이스 14
test('retryService.retry: 수신처 행이 없으면 not-found, write 0회', async () => {
  const { service, writer, articleHistoryModel } = setup({ targets: [] });
  seedFailure(articleHistoryModel, { targetId: 42 });

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: 42 });
  assert.deepEqual(r, { ok: false, reason: 'not-found' });
  assert.equal(writer.calls.length, 0);
});

// 케이스 15
test('retryService.retry: 비활성 수신처는 inactive, write 0회', async () => {
  const { service, writer, articleHistoryModel, targetIds, distributionTargetModel } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  distributionTargetModel.update(targetIds.kbs, { active: 'N' });

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });
  assert.deepEqual(r, { ok: false, reason: 'inactive' });
  assert.equal(writer.calls.length, 0);
});

// 케이스 15-1 (보안 핵심)
test('retryService.retry: 수신처 kind가 실패 이력과 달라지면 kind-changed — write 0회·이력 0건 (엠바고 파기 차단)', async () => {
  const { service, writer, db, articleHistoryModel, targetIds, distributionTargetModel } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'press' });
  const eventsBefore = distEventsOf(db).length;
  distributionTargetModel.update(targetIds.kbs, { kind: 'nonpress' }); // 재분류

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });

  assert.deepEqual(r, { ok: false, reason: 'kind-changed' });
  assert.equal(writer.calls.length, 0);
  assert.equal(distEventsOf(db).length, eventsBefore, '게이트 거부는 이력을 남기지 않는다');
});

// 케이스 15-2
test('retryService.retry: kind-changed 거부는 항목을 소비하지 않는다 — kind 복원 후 재전송 성공', async () => {
  const { service, writer, articleHistoryModel, targetIds, distributionTargetModel } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'press' });
  distributionTargetModel.update(targetIds.kbs, { kind: 'nonpress' });

  await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });
  assert.equal(service.list().items.length, 1, '거부 후에도 목록에 남아 있다');

  distributionTargetModel.update(targetIds.kbs, { kind: 'press' }); // 원복
  const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });
  assert.equal(r.ok, true, '복구 경로가 존재한다');
  assert.equal(writer.calls.length, 1);
});

// 케이스 15-3
test('retryService.retry: kind 대소문자·공백 차이도 불일치다 (정규화 없는 엄격 비교)', async () => {
  for (const mutated of ['PRESS', ' press']) {
    const { service, writer, articleHistoryModel, targetIds, distributionTargetModel } = setup({
      targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
    });
    seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'press' });
    distributionTargetModel.update(targetIds.kbs, { kind: mutated });

    const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });
    assert.deepEqual(r, { ok: false, reason: 'kind-changed' }, `kind=${JSON.stringify(mutated)}`);
    assert.equal(writer.calls.length, 0);
  }
});

// 케이스 15-4 (계획 검토 반영 — 의도된 수용의 잠금)
test('retryService.retry: 같은 쌍에 kind 2종 동시 미해소면 최신 kind 기준으로 판정한다 — 옛 kind 항목의 잔류는 의도된 수용', async () => {
  // findUnresolvedFailure는 historyId 최대(최신) 항목을 고른다. 수신처의 현재 kind가 옛 실패의 kind와
  // 같아도 최신 실패의 kind와 다르면 kind-changed로 거부한다(안전 방향 — 어긋나면 아무것도 보내지 않는다).
  // 그 결과 옛 kind 항목은 재전송 경로가 없어 목록에 영구 잔류한다 — 이것은 결함이 아니라 의도된 수용이다.
  const { service, writer, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'press' });   // 옛 실패 — 현재 kind와 일치
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'nonpress' }); // 최신 실패 — 현재 kind와 불일치

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });

  assert.deepEqual(r, { ok: false, reason: 'kind-changed' }, '최신 실패의 kind(nonpress) 기준 — 안전 방향 거부가 정상이다');
  assert.equal(writer.calls.length, 0);
  assert.equal(service.list().items.length, 2, '두 항목 모두 목록에 남는다(press 항목의 잔류 포함 — 정상)');
});

// 케이스 16
test('retryService.retry: 배부 불가 status(EEK·RDS·DPD)는 status-changed — write 0회·이력 0건', async () => {
  for (const status of ['EEK', 'RDS', 'DPD']) {
    const { service, writer, db, articleHistoryModel, targetIds } = setup({
      status,
      targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
    });
    seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
    const before = distEventsOf(db).length;

    const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });
    assert.deepEqual(r, { ok: false, reason: 'status-changed' }, `status=${status}`);
    assert.equal(writer.calls.length, 0, `status=${status}`);
    assert.equal(distEventsOf(db).length, before, `status=${status}: 이력 불변`);
  }
});

// 케이스 17
test('retryService: spoolWriter 미주입이면 retry는 spool-disabled(DB 무접촉), list는 정상', async () => {
  const { service, db, articleHistoryModel, targetIds } = setup({
    spoolWriter: null,
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  const before = db.prepare('SELECT COUNT(*) c FROM ArticleHistory').get().c;

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });
  assert.deepEqual(r, { ok: false, reason: 'spool-disabled' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ArticleHistory').get().c, before);
  assert.equal(contentsOf(db).distributedAt, null);

  const l = service.list();
  assert.equal(l.ok, true, '조회는 스풀 설정과 무관하다');
  assert.equal(l.items.length, 1);
});

// 케이스 18
test('retryService.retry: 재전송 실패는 새 distribute-failed 행 append — 항목은 목록에 남고 distributedAt 불변', async () => {
  const writer = fakeWriter({ failFor: new Set(['kbs']) });
  const { service, db, articleHistoryModel, targetIds, onFailureSeen } = setup({
    writer,
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs, actorUserId: 'z1' });

  assert.deepEqual(r, { ok: false, reason: 'spool-write-failed' });
  const fails = distEventsOf(db).filter((h) => h.eventType === 'distribute-failed');
  assert.equal(fails.length, 2, '새 실패 행이 append된다(갱신·삭제 없음)');
  assert.equal(fails[1].actorUserId, 'z1');
  assert.equal(service.list().items.length, 1, '항목은 여전히 미해소다');
  assert.equal(contentsOf(db).distributedAt, null, '실패는 distributedAt을 갱신하지 않는다');
  assert.equal(onFailureSeen.length, 1, '재전송 실패는 onFailure로 표면화된다');
  assert.ok(!('spoolDir' in onFailureSeen[0]), 'onFailure 인자에도 경로가 없다');
});

// 케이스 19
test('retryService.retry: write가 throw해도 서비스는 throw하지 않고 spool-write-failed로 수렴한다', async () => {
  const writer = fakeWriter({ throwFor: new Set(['kbs']) });
  const { service, db, articleHistoryModel, targetIds } = setup({
    writer,
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });
  assert.deepEqual(r, { ok: false, reason: 'spool-write-failed' }, '예외 원문이 새지 않는다');
  const fails = distEventsOf(db).filter((h) => h.eventType === 'distribute-failed');
  assert.equal(fails[fails.length - 1].reason, 'spool-write-failed', '이력에도 고정 토큰만');
});

// 케이스 20
test('retryService.retry: targetId 문자열도 숫자 대상과 매칭된다 (HTTP 경계 정규화)', async () => {
  const { service, writer, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: String(targetIds.kbs) });
  assert.equal(r.ok, true);
  assert.strictEqual(r.targetId, targetIds.kbs, '반환 targetId는 숫자다');
  assert.equal(writer.calls.length, 1);
});

// 케이스 21
test('retryService.retry: 페이로드는 현재 DB 행에서 만든다 (호출자 입력이 아니다 — ADR-004)', async () => {
  const { service, writer, articleHistoryModel, articleModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });

  const row = articleModel.getById(ARTICLE_ID);
  // sqlite 행은 null-prototype이라 양쪽 모두 spread로 평범한 객체로 만들어 값만 비교한다.
  assert.deepEqual({ ...writer.calls[0].article }, { ...row.article }, 'article은 DB 행 그대로');
  assert.deepEqual({ ...writer.calls[0].contents }, { ...row.contents, distributedAt: null }, 'contents는 write 시점 DB 행 그대로(distributedAt 갱신 전)');
  assert.equal(writer.calls[0].articleId, ARTICLE_ID);
});

// 케이스 22
test('retryService.retry: 이력 insert가 throw해도 결과는 그대로이고 onHistoryError가 호출된다', async () => {
  const { db, articleModel, distributionTargetModel } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const kbs = distributionTargetModel.query({})[0];
  const realHistory = createArticleHistoryModel(db);
  seedFailure(realHistory, { targetId: kbs.id });
  const seen = [];
  const service = createDistributionRetryService({
    articleHistoryModel: {
      queryDistributionEvents: realHistory.queryDistributionEvents,
      queryByArticle: realHistory.queryByArticle,
      insert() { throw new Error('db locked'); },
    },
    distributionTargetModel,
    articleModel,
    spoolWriter: fakeWriter(),
    now: () => NOW,
    onHistoryError: (info) => seen.push(info),
  });

  const r = await service.retry({ articleId: ARTICLE_ID, targetId: kbs.id });

  assert.equal(r.ok, true, '이력 실패는 이미 나간 재전송을 되돌리지 않는다');
  assert.equal(contentsOf(db).distributedAt, NOW);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].eventType, 'distribute-retry');
  assert.match(seen[0].reason, /db locked/);
});

// 케이스 23
test('retryService.retry: DB 비파괴 — 전후 행 수 불변, 기존 이력 보존', async () => {
  const { service, db, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  articleHistoryModel.insert({
    articleId: ARTICLE_ID, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS',
    actorUserId: 'desk', createdAt: '2026-08-06T04:00:00.000Z',
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  const counts = () => ({
    article: db.prepare('SELECT COUNT(*) c FROM Article').get().c,
    contents: db.prepare('SELECT COUNT(*) c FROM Contents').get().c,
    targets: db.prepare('SELECT COUNT(*) c FROM DistributionTarget').get().c,
  });
  const before = counts();
  const historyBefore = db.prepare('SELECT COUNT(*) c FROM ArticleHistory').get().c;

  await service.retry({ articleId: ARTICLE_ID, targetId: targetIds.kbs });

  assert.deepEqual(counts(), before);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM ArticleHistory').get().c, historyBefore + 1,
    '이력은 append만 된다(삭제 0)',
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM ArticleHistory WHERE action = 'send'").get().c, 1,
    '기존 송고 이력이 보존된다',
  );
});
