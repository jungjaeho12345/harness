// 배부 실패 재전송 서비스 테스트 — ADR-008 MVP-4.
// 하네스: in-memory DB + 실제 모델 + 가짜 spoolWriter(실제 FS 미접촉) + 고정 now (distributionService.test.js와 동형).
// CRITICAL: 재전송은 "실패분 복구 전용"이다 — 미해소 실패 행 없이는 어떤 스풀 쓰기도 일어나지 않고(임의 배부 차단),
// 수신처 kind가 실패 이력과 어긋나면 아무것도 보내지 않는다(엠바고 파기 차단).
// 재전송 식별자는 **historyId**(목록의 키)다 — 서버는 그 id가 미해소 집합에 속하는지 검증한 뒤
// 그 행에서 articleId·targetId·kind를 도출한다(클라이언트가 kind를 고르는 경로 봉쇄, ADR-004).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createDistributionTargetModel } from '../src/models/distributionTargetModel.js';
import { createDistributionRetryService } from '../src/services/distributionRetryService.js';
import { createArticleService } from '../src/services/articleService.js';

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

// write가 release()될 때까지 완료되지 않는 writer — 동시 재전송(single-flight) 검증용.
function blockingWriter() {
  const calls = [];
  let release;
  const gate = new Promise((res) => { release = res; });
  return {
    calls,
    release: () => release(),
    async write(args) {
      calls.push(args);
      await gate;
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
// 반환값은 새 행의 historyId다(재전송 식별자 계약 — insert가 id를 돌려준다).
function seedFailure(historyModel, { articleId = ARTICLE_ID, targetId, kind = 'press', reason = 'spool-write-failed', createdAt = NOW } = {}) {
  return historyModel.insert({ articleId, eventType: 'distribute-failed', action: kind, targetId, reason, actorUserId: 'sys', createdAt });
}
function seedRetry(historyModel, { articleId = ARTICLE_ID, targetId, kind = 'press', createdAt = NOW } = {}) {
  return historyModel.insert({ articleId, eventType: 'distribute-retry', action: kind, targetId, actorUserId: 'z1', createdAt });
}
// 사이클 경계(송고 이력) 시드 — 이 행보다 id가 작은(이전 사이클) 실패는 재전송 대상이 아니다.
function seedSend(historyModel, { articleId = ARTICLE_ID, createdAt = NOW } = {}) {
  return historyModel.insert({
    articleId, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DES',
    actorUserId: 'desk', createdAt,
  });
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
  seedSend(articleHistoryModel, {});
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
  seedSend(articleHistoryModel, {});
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
  seedSend(articleHistoryModel, {});
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
  seedSend(articleHistoryModel, { createdAt: '2026-08-05T00:00:00.000Z' });
  articleHistoryModel.insert({ articleId: ARTICLE_ID, eventType: 'distribute', action: 'press', actorUserId: 'sys', createdAt: '2026-08-05T00:01:00.000Z' });
  // 보류→엠바고 재설정→재송고로 새 사이클이 열림.
  seedSend(articleHistoryModel, { createdAt: '2026-08-06T00:00:00.000Z' });
  // 이번 사이클: press 전량 실패(distribute 행 없음).
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'press' });

  const [item] = service.list().items;
  // 전체 이력 판정(distributedKinds)이면 과거 사이클 배부 행 때문에 true가 된다 —
  // 그러면 "다음 tick이 전 대상에 배부한다"는 경고가 사라져, 경고가 막으려던 바로 그 중복이 무경고로 지나간다.
  assert.equal(item.kindDistributed, false, 'cycleDistributedKinds(현 사이클) 판정이어야 한다');
});

// ── phase 58 step4: list()의 N+1 제거 — target 호출당 캐시 + 경량 status 조회 ──

// 케이스 58-1
test('retryService.list: 같은 targetId 실패 3건이어도 findById는 distinct targetId 수만큼만 호출된다(호출당 캐시)', () => {
  const { service, articleHistoryModel, distributionTargetModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  // 같은 수신처에 실패 3건 — 서로 다른 기사 2건 + 다른 kind 1건.
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  seedFailure(articleHistoryModel, { articleId: 'AKR-OTHER', targetId: targetIds.kbs });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'nonpress' });

  let calls = 0;
  const orig = distributionTargetModel.findById;
  distributionTargetModel.findById = (id) => { calls += 1; return orig(id); };

  const items = service.list().items;
  assert.equal(items.length, 3);
  assert.equal(calls, 1, 'distinct targetId 1개 → 조회 1회(3회가 아니다)');
});

// 케이스 58-2
test('retryService.list: status는 getStatusById 경량 조회로 — getById 0회·distinct 기사당 1회', () => {
  const { service, articleHistoryModel, articleModel, targetIds } = setup({
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
      { name: '포털', kind: 'nonpress', spoolDir: 'portal' },
    ],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  seedFailure(articleHistoryModel, { targetId: targetIds.mbc });
  seedFailure(articleHistoryModel, { targetId: targetIds.portal, kind: 'nonpress' });

  let getByIdCalls = 0;
  let statusCalls = 0;
  const origGet = articleModel.getById;
  const origStatus = articleModel.getStatusById;
  articleModel.getById = (id) => { getByIdCalls += 1; return origGet(id); };
  articleModel.getStatusById = (id) => { statusCalls += 1; return origStatus(id); };

  const items = service.list().items;
  assert.equal(items.length, 3);
  assert.equal(getByIdCalls, 0, 'status 하나를 위해 본문 blob 포함 전체 로드를 하지 않는다');
  assert.equal(statusCalls, 1, 'distinct 기사 1건 → 경량 조회 1회');
});

// 케이스 58-3
test('retryService.list: getStatusById가 없는 부분 스텁 모델에서도 getById 폴백으로 동일하게 동작한다', () => {
  const { service, articleHistoryModel, distributionTargetModel, articleModel, targetIds } = setup({
    status: 'EPS',
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedSend(articleHistoryModel, {});
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const full = service.list().items;

  // getById만 가진 부분 스텁(기존 retry 스위트의 스텁 스타일) — 신규 메서드 강제 없음.
  const stubService = createDistributionRetryService({
    articleHistoryModel,
    distributionTargetModel,
    articleModel: { getById: (id) => articleModel.getById(id) },
    now: () => NOW,
  });
  const stub = stubService.list().items;

  assert.deepEqual(stub, full, '항목 shape·kindDistributed가 완전히 동일하다');
  assert.deepEqual(
    Object.keys(stub[0]).sort(),
    ['articleId', 'failedAt', 'historyId', 'kind', 'kindDistributed',
      'reason', 'targetActive', 'targetKind', 'targetName', 'targetId'].sort(),
  );
});

// 케이스 58-4
test('retryService.list: 캐시는 호출당이다 — 호출 사이 수신처 변경이 다음 목록에 즉시 보인다', () => {
  const { service, articleHistoryModel, distributionTargetModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  let calls = 0;
  const orig = distributionTargetModel.findById;
  distributionTargetModel.findById = (id) => { calls += 1; return orig(id); };

  const first = service.list().items;
  assert.equal(first[0].targetActive, 'Y');
  assert.equal(calls, 1);

  distributionTargetModel.update(targetIds.kbs, { active: 'N' }); // 수신처 비활성화

  const second = service.list().items;
  assert.equal(calls, 2, '호출마다 다시 조회한다(호출 사이 캐시 금지)');
  assert.equal(second[0].targetActive, 'N', '변경이 다음 조회에 즉시 보인다');
});

// 케이스 58-5
test('retryService.list: 캐시 도입 후에도 투영은 화이트리스트다 — spoolDir·경로가 어디에도 없다', () => {
  const { service, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs-spool-slug' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds['kbs-spool-slug'] });
  seedFailure(articleHistoryModel, { articleId: 'AKR-OTHER', targetId: targetIds['kbs-spool-slug'] });

  const body = JSON.stringify(service.list());
  assert.ok(!body.includes('kbs-spool-slug'), 'spoolDir 슬러그가 어떤 필드에도 없다');
  assert.ok(!body.includes('/spool'), '파일 경로가 없다');
});

// 케이스 58-6
test('retryService.list: 기사 행이 없는 실패 항목(status undefined)도 기존과 같은 결과다', () => {
  const { service, articleHistoryModel, targetIds } = setup({
    withArticle: false,
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const items = service.list().items;
  assert.equal(items.length, 1, '기사 행 부재가 목록을 깨뜨리지 않는다');
  assert.equal(items[0].kindDistributed, false, 'status undefined → 사이클 판정은 기존과 동일(false)');
  assert.deepEqual(
    Object.keys(items[0]).sort(),
    ['articleId', 'failedAt', 'historyId', 'kind', 'kindDistributed',
      'reason', 'targetActive', 'targetKind', 'targetName', 'targetId'].sort(),
  );
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
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.mbc });

  const r = await service.retry({ historyId: hid, actorUserId: 'z1' });

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
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  const before = contentsOf(db);

  await service.retry({ historyId: hid, actorUserId: 'z1' });

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
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  assert.equal(service.list().items.length, 1);

  await service.retry({ historyId: hid });

  assert.deepEqual(service.list().items, []);
});

// 케이스 11 (보안 핵심)
test('retryService.retry: 실패 행이 아닌 historyId는 no-failure — write 0회·이력 0건 (임의 배부 차단)', async () => {
  const { service, writer, db, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  // 배부 이벤트가 전혀 없는 id.
  const ghost = await service.retry({ historyId: 424242 });
  assert.deepEqual(ghost, { ok: false, reason: 'no-failure' });

  // distribute-retry(해소) 행의 id를 넘겨도 실패 행이 아니므로 거부된다.
  const retryRowId = seedRetry(articleHistoryModel, { targetId: targetIds.kbs });
  const notFailure = await service.retry({ historyId: retryRowId });
  assert.deepEqual(notFailure, { ok: false, reason: 'no-failure' });

  assert.equal(writer.calls.length, 0);
  assert.equal(distEventsOf(db).length, 1, '게이트 거부는 이력을 남기지 않는다(시드 1건 그대로)');
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
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs, createdAt: '2026-08-01T00:00:00.000Z' });
  seedFailure(articleHistoryModel, { targetId: targetIds.mbc });
  seedFailure(articleHistoryModel, { targetId: targetIds.sbs });
  seedFailure(articleHistoryModel, { targetId: targetIds.portal, kind: 'nonpress' });
  seedRetry(articleHistoryModel, { targetId: targetIds.mbc });
  seedRetry(articleHistoryModel, { targetId: targetIds.sbs });

  const r = await service.retry({ historyId: hid });

  assert.equal(r.ok, true, '표시용 작은 limit을 재전송 조회에 쓰면 오래된 실패가 no-failure로 오거부된다');
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].spoolDir, 'kbs');
});

// 케이스 12
test('retryService.retry: 이미 해소된 실패의 historyId를 다시 요청해도 no-failure', async () => {
  const { service, writer, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  seedRetry(articleHistoryModel, { targetId: targetIds.kbs });

  const r = await service.retry({ historyId: hid });
  assert.deepEqual(r, { ok: false, reason: 'no-failure' });
  assert.equal(writer.calls.length, 0);
});

// 케이스 12-1 (그룹 접힘 — 목록의 키가 아닌 옛 실패 행 id)
test('retryService.retry: 같은 그룹에 더 새 실패가 있으면 옛 실패 행의 historyId는 no-failure (미해소 집합 멤버십)', async () => {
  const { service, writer, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const oldHid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  const newHid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs }); // 같은 (기사,수신처,kind) 그룹

  const stale = await service.retry({ historyId: oldHid });
  assert.deepEqual(stale, { ok: false, reason: 'no-failure' }, '목록에 없는 id는 재전송 경로가 아니다');
  assert.equal(writer.calls.length, 0);

  const fresh = await service.retry({ historyId: newHid });
  assert.equal(fresh.ok, true, '목록의 키(그룹 최신 실패)는 정상 재전송된다');
});

// 케이스 13
test('retryService.retry: 기사 행이 없으면 not-found, write 0회', async () => {
  const { service, writer, articleHistoryModel, targetIds } = setup({
    withArticle: false,
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const r = await service.retry({ historyId: hid });
  assert.deepEqual(r, { ok: false, reason: 'not-found' });
  assert.equal(writer.calls.length, 0);
});

// 케이스 14
test('retryService.retry: 수신처 행이 없으면 not-found, write 0회', async () => {
  const { service, writer, articleHistoryModel } = setup({ targets: [] });
  const hid = seedFailure(articleHistoryModel, { targetId: 42 });

  const r = await service.retry({ historyId: hid });
  assert.deepEqual(r, { ok: false, reason: 'not-found' });
  assert.equal(writer.calls.length, 0);
});

// 케이스 15
test('retryService.retry: 비활성 수신처는 inactive, write 0회', async () => {
  const { service, writer, articleHistoryModel, targetIds, distributionTargetModel } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  distributionTargetModel.update(targetIds.kbs, { active: 'N' });

  const r = await service.retry({ historyId: hid });
  assert.deepEqual(r, { ok: false, reason: 'inactive' });
  assert.equal(writer.calls.length, 0);
});

// 케이스 15-1 (보안 핵심)
test('retryService.retry: 수신처 kind가 실패 이력과 달라지면 kind-changed — write 0회·이력 0건 (엠바고 파기 차단)', async () => {
  const { service, writer, db, articleHistoryModel, targetIds, distributionTargetModel } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'press' });
  const eventsBefore = distEventsOf(db).length;
  distributionTargetModel.update(targetIds.kbs, { kind: 'nonpress' }); // 재분류

  const r = await service.retry({ historyId: hid });

  assert.deepEqual(r, { ok: false, reason: 'kind-changed' });
  assert.equal(writer.calls.length, 0);
  assert.equal(distEventsOf(db).length, eventsBefore, '게이트 거부는 이력을 남기지 않는다');
});

// 케이스 15-2
test('retryService.retry: kind-changed 거부는 항목을 소비하지 않는다 — kind 복원 후 재전송 성공', async () => {
  const { service, writer, articleHistoryModel, targetIds, distributionTargetModel } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'press' });
  distributionTargetModel.update(targetIds.kbs, { kind: 'nonpress' });

  await service.retry({ historyId: hid });
  assert.equal(service.list().items.length, 1, '거부 후에도 목록에 남아 있다');

  distributionTargetModel.update(targetIds.kbs, { kind: 'press' }); // 원복
  const r = await service.retry({ historyId: hid });
  assert.equal(r.ok, true, '복구 경로가 존재한다');
  assert.equal(writer.calls.length, 1);
});

// 케이스 15-3
test('retryService.retry: kind 대소문자·공백 차이도 불일치다 (정규화 없는 엄격 비교)', async () => {
  for (const mutated of ['PRESS', ' press']) {
    const { service, writer, articleHistoryModel, targetIds, distributionTargetModel } = setup({
      targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
    });
    const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'press' });
    distributionTargetModel.update(targetIds.kbs, { kind: mutated });

    const r = await service.retry({ historyId: hid });
    assert.deepEqual(r, { ok: false, reason: 'kind-changed' }, `kind=${JSON.stringify(mutated)}`);
    assert.equal(writer.calls.length, 0);
  }
});

// 케이스 15-4 (코드리뷰 반려 [med] — 재전송 식별자 historyId 재현 테스트)
test('retryService.retry: 같은 쌍에 kind 2종 동시 미해소여도 각 항목이 자기 historyId로 복구된다', async () => {
  // 과거 (articleId,targetId) 식별자에서는 findUnresolvedFailure가 최신(nonpress) 항목만 골라
  // 옛 press 항목이 영구 복구 불가였다(리뷰 재현). historyId 식별자는 목록의 키 그대로라 이 문제가 없다.
  const { service, writer, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const pressHid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'press' });   // 옛 실패 — 현재 kind와 일치
  const nonpressHid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs, kind: 'nonpress' }); // 최신 실패 — 현재 kind와 불일치
  assert.equal(service.list().items.length, 2, '두 kind 모두 미해소로 목록에 있다');

  // 옛 kind(press) 항목 — 수신처의 현재 kind(press)와 일치하므로 재전송된다.
  const pressRetry = await service.retry({ historyId: pressHid });
  assert.equal(pressRetry.ok, true, '옛 kind 항목도 historyId 지정으로 복구 가능해야 한다');
  assert.equal(pressRetry.kind, 'press');
  assert.equal(writer.calls.length, 1);

  // 최신 kind(nonpress) 항목 — 수신처 kind와 어긋나므로 안전 거부(kind-changed)가 유지된다.
  const nonpressRetry = await service.retry({ historyId: nonpressHid });
  assert.deepEqual(nonpressRetry, { ok: false, reason: 'kind-changed' });
  assert.equal(writer.calls.length, 1, 'kind 불일치 항목은 여전히 아무것도 보내지 않는다');
  assert.equal(service.list().items.length, 1, 'press 항목만 해소되고 nonpress 항목은 남는다');
});

// 케이스 16
test('retryService.retry: 배부 불가 status(EEK·RDS·DPD)는 status-changed — write 0회·이력 0건', async () => {
  for (const status of ['EEK', 'RDS', 'DPD']) {
    const { service, writer, db, articleHistoryModel, targetIds } = setup({
      status,
      targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
    });
    const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
    const before = distEventsOf(db).length;

    const r = await service.retry({ historyId: hid });
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
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  const before = db.prepare('SELECT COUNT(*) c FROM ArticleHistory').get().c;

  const r = await service.retry({ historyId: hid });
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
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const r = await service.retry({ historyId: hid, actorUserId: 'z1' });

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
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const r = await service.retry({ historyId: hid });
  assert.deepEqual(r, { ok: false, reason: 'spool-write-failed' }, '예외 원문이 새지 않는다');
  const fails = distEventsOf(db).filter((h) => h.eventType === 'distribute-failed');
  assert.equal(fails[fails.length - 1].reason, 'spool-write-failed', '이력에도 고정 토큰만');
});

// 케이스 20
test('retryService.retry: historyId 문자열도 정규화되어 매칭된다 (HTTP 경계 정규화)', async () => {
  const { service, writer, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const r = await service.retry({ historyId: String(hid) });
  assert.equal(r.ok, true);
  assert.strictEqual(r.targetId, targetIds.kbs, '반환 targetId는 숫자다');
  assert.equal(writer.calls.length, 1);
});

// 케이스 20-1 (코드리뷰 반려 [low] — 비정상 historyId의 즉시 거부: 전역 스캔 봉쇄)
test('retryService.retry: 비정수·음수·빈 historyId는 즉시 no-failure — 이벤트 조회 자체가 없다', async () => {
  const { service, writer, articleHistoryModel } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  let queryCalls = 0;
  const origQuery = articleHistoryModel.queryDistributionEvents;
  articleHistoryModel.queryDistributionEvents = (args) => { queryCalls += 1; return origQuery(args); };

  for (const bad of [undefined, null, '', 'abc', 0, -1, 1.5, {}, [], NaN]) {
    const r = await service.retry({ historyId: bad });
    assert.deepEqual(r, { ok: false, reason: 'no-failure' }, `historyId=${JSON.stringify(bad)}`);
  }
  const noArg = await service.retry();
  assert.deepEqual(noArg, { ok: false, reason: 'no-failure' });

  assert.equal(queryCalls, 0, '무효 식별자는 어떤 이력 조회도 유발하지 않는다');
  assert.equal(writer.calls.length, 0);
});

// 케이스 20-2 (코드리뷰 반려 [low] — articleId 비문자열/빈 값의 전역 스캔 봉쇄)
test('retryService.retry: 이력 행의 articleId가 비문자열/빈 값이면 no-failure — articleId 미스코프 조회가 없다', async () => {
  // 실 DB에서는 articleId가 항상 문자열이지만, 방어가 무너지면 queryDistributionEvents가
  // articleId=undefined로 호출되어 **전 기사** 이벤트를 스캔한다(무스코프) — 그 경로를 봉쇄한다.
  for (const badArticleId of [null, undefined, '', 42]) {
    const seenQueries = [];
    const stubHistory = {
      getDistributionEventById: () => ({
        id: 7, articleId: badArticleId, eventType: 'distribute-failed', action: 'press',
        targetId: 1, reason: 'spool-write-failed', actorUserId: 'sys', createdAt: NOW,
      }),
      queryDistributionEvents: (args) => { seenQueries.push(args); return []; },
      queryByArticle: () => [],
      insert: () => 1,
    };
    const writer = fakeWriter();
    const service = createDistributionRetryService({
      articleHistoryModel: stubHistory,
      distributionTargetModel: { findById: () => undefined },
      articleModel: { getById: () => null },
      spoolWriter: writer,
      now: () => NOW,
    });

    const r = await service.retry({ historyId: 7 });
    assert.deepEqual(r, { ok: false, reason: 'no-failure' }, `articleId=${JSON.stringify(badArticleId)}`);
    assert.deepEqual(seenQueries, [], '스코프 없는 이벤트 조회가 실행되지 않는다');
    assert.equal(writer.calls.length, 0);
  }
});

// 케이스 21
test('retryService.retry: 페이로드는 현재 DB 행에서 만든다 (호출자 입력이 아니다 — ADR-004)', async () => {
  const { service, writer, articleHistoryModel, articleModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  await service.retry({ historyId: hid });

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
  const hid = seedFailure(realHistory, { targetId: kbs.id });
  const seen = [];
  const service = createDistributionRetryService({
    articleHistoryModel: {
      queryDistributionEvents: realHistory.queryDistributionEvents,
      queryByArticle: realHistory.queryByArticle,
      getDistributionEventById: realHistory.getDistributionEventById,
      insert() { throw new Error('db locked'); },
    },
    distributionTargetModel,
    articleModel,
    spoolWriter: fakeWriter(),
    now: () => NOW,
    onHistoryError: (info) => seen.push(info),
  });

  const r = await service.retry({ historyId: hid });

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
  seedSend(articleHistoryModel, { createdAt: '2026-08-06T04:00:00.000Z' });
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  const counts = () => ({
    article: db.prepare('SELECT COUNT(*) c FROM Article').get().c,
    contents: db.prepare('SELECT COUNT(*) c FROM Contents').get().c,
    targets: db.prepare('SELECT COUNT(*) c FROM DistributionTarget').get().c,
  });
  const before = counts();
  const historyBefore = db.prepare('SELECT COUNT(*) c FROM ArticleHistory').get().c;

  const r = await service.retry({ historyId: hid });
  assert.equal(r.ok, true, '송고 경계 이후의 실패는 정상 재전송된다');

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

// 케이스 24 (테스트 게이트 보강 — 변이 'RETRY_SCAN_LIMIT→표시 창 한도' 생존 킬)
// 케이스 11-1은 이벤트 6건만 시드해 limit>=6이면 어떤 창이든 통과한다 — 표시용 창의
// 기본값(200)·상한(1000)을 실제로 넘겨 "articleId 스코프 사실상 무제한" 계약을 행동으로 잠근다.
test('retryService.retry: 같은 기사에 이벤트가 1000건 넘게 쌓여도 가장 오래된 실패가 재전송된다 (표시 창 재사용 금지)', async () => {
  const { service, writer, articleHistoryModel, targetIds } = setup({
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
    ],
  });
  // 가장 오래된 미해소 실패(kbs) 뒤에 해소된 실패/재전송 쌍이 1100행 쌓인다 —
  // 게이트 조회가 표시용 창(기본 200·클램프 상한 1000)을 재사용하면 kbs 행이 창 밖으로 밀린다.
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs, createdAt: '2026-08-01T00:00:00.000Z' });
  for (let i = 0; i < 550; i += 1) {
    seedFailure(articleHistoryModel, { targetId: targetIds.mbc });
    seedRetry(articleHistoryModel, { targetId: targetIds.mbc });
  }

  const r = await service.retry({ historyId: hid });

  assert.equal(r.ok, true, '표시용 창 한도를 재전송 게이트 조회에 쓰면 오래된 실패가 no-failure로 오거부된다');
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].spoolDir, 'kbs');
});

// ── 코드리뷰 반려 [high]: stale-cycle 게이트 ─────────────────────────────

// 재현(리뷰 시나리오 그대로): 보류→엠바고 재설정→재송고로 새 사이클이 열린 DES 기사에서,
// 이전 사이클(송고 경계 이전)의 실패 행으로 재전송하면 미도래 엠바고(2099) 기사가 스풀로 유출됐다.
test('retryService.retry: 이전 사이클(송고 경계 이전)의 실패는 stale-cycle 거부 — 스풀 0회·이력 0건', async () => {
  const { service, writer, db, articleModel, articleHistoryModel, targetIds } = setup({
    status: 'DES',
    targets: [{ name: '포털', kind: 'nonpress', spoolDir: 'portal' }],
  });
  // 2차 엠바고가 미래(2099)로 재설정된 기사 — 어떤 경로로도 nonpress가 지금 나가면 안 된다.
  articleModel.update(ARTICLE_ID, { contents: { secondEmbargoAt: '2099-01-01T00:00:00.000Z' } });

  // 이전 사이클: 송고 → nonpress 실패(미해소로 잔존).
  seedSend(articleHistoryModel, { createdAt: '2026-08-05T00:00:00.000Z' });
  const staleHid = seedFailure(articleHistoryModel, {
    targetId: targetIds.portal, kind: 'nonpress', createdAt: '2026-08-05T00:01:00.000Z',
  });
  // 보류→엠바고 재설정→재송고: 새 사이클 경계(실패 행보다 큰 id의 send 행).
  seedSend(articleHistoryModel, { createdAt: '2026-08-06T00:00:00.000Z' });
  const eventsBefore = distEventsOf(db).length;

  const r = await service.retry({ historyId: staleHid, actorUserId: 'z1' });

  assert.deepEqual(r, { ok: false, reason: 'stale-cycle' }, '이전 사이클 실패로는 재전송할 수 없다');
  assert.equal(writer.calls.length, 0, '미도래 엠바고 기사가 스풀로 유출되지 않는다');
  assert.equal(distEventsOf(db).length, eventsBefore, '게이트 거부는 이력을 남기지 않는다');
  assert.equal(contentsOf(db).distributedAt, null);
});

test('retryService.retry: 송고 경계 이후(이번 사이클)의 실패는 stale-cycle에 걸리지 않는다', async () => {
  const { service, writer, articleHistoryModel, targetIds } = setup({
    status: 'DES',
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  seedSend(articleHistoryModel, { createdAt: '2026-08-06T00:00:00.000Z' });
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs, createdAt: '2026-08-06T00:01:00.000Z' });

  const r = await service.retry({ historyId: hid });
  assert.equal(r.ok, true, '이번 사이클의 실패는 정상 복구 경로다');
  assert.equal(writer.calls.length, 1);
});

test('retryService.retry: 송고 이력이 없으면(경계 미확정) stale-cycle 거부가 없다 — 기존 복구 경로 보존', async () => {
  const { service, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const r = await service.retry({ historyId: hid });
  assert.equal(r.ok, true, '경계를 확정할 수 없으면 거부하지 않는다(수동 시드·레거시 데이터)');
});

// ── 코드리뷰 반려 [med]: 동시 재전송 single-flight ───────────────────────

test('retryService.retry: 같은 실패의 동시 재전송은 한쪽만 성공 — 다른 쪽은 retry-in-flight, 스풀 1회', async () => {
  const writer = blockingWriter();
  const { service, db, articleHistoryModel, targetIds } = setup({
    writer,
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  // 첫 호출이 write에서 대기하는 동안 두 번째 호출이 게이트를 통과하면 스풀이 2회 나간다(리뷰 재현).
  const pending = Promise.all([
    service.retry({ historyId: hid, actorUserId: 'z1' }),
    service.retry({ historyId: hid, actorUserId: 'z1' }),
  ]);
  writer.release();
  const [first, second] = await pending;

  assert.equal(first.ok, true, '먼저 진입한 호출만 스풀을 쓴다');
  assert.deepEqual(second, { ok: false, reason: 'retry-in-flight' });
  assert.equal(writer.calls.length, 1, '스풀 쓰기는 정확히 1회다');
  assert.equal(
    distEventsOf(db).filter((h) => h.eventType === 'distribute-retry').length, 1,
    '해소 이력도 1건뿐이다',
  );
});

test('retryService.retry: 다른 수신처의 재전송은 직렬화되지 않는다 (가드 키는 articleId:targetId)', async () => {
  const writer = blockingWriter();
  const { service, articleHistoryModel, targetIds } = setup({
    writer,
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
    ],
  });
  const kbsHid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });
  const mbcHid = seedFailure(articleHistoryModel, { targetId: targetIds.mbc });

  const pending = Promise.all([
    service.retry({ historyId: kbsHid }),
    service.retry({ historyId: mbcHid }),
  ]);
  writer.release();
  const [kbs, mbc] = await pending;

  assert.equal(kbs.ok, true);
  assert.equal(mbc.ok, true, '다른 수신처 재전송은 서로를 막지 않는다');
  assert.deepEqual(writer.calls.map((c) => c.spoolDir).sort(), ['kbs', 'mbc']);
});

test('retryService.retry: 재전송 실패 후 가드가 해제되어 재시도할 수 있다 (영구 잠금 아님)', async () => {
  const state = { fail: true };
  const calls = [];
  const writer = {
    calls,
    async write(args) {
      calls.push(args);
      return state.fail ? { ok: false, reason: 'spool-write-failed' } : { ok: true, file: '/spool/x.json' };
    },
  };
  const { service, articleHistoryModel, targetIds } = setup({
    writer,
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const hid = seedFailure(articleHistoryModel, { targetId: targetIds.kbs });

  const failed = await service.retry({ historyId: hid });
  assert.equal(failed.reason, 'spool-write-failed');

  state.fail = false;
  // 실패로 append된 새 실패 행이 그룹 최신이 된다 — 목록의 새 키로 재시도한다.
  const [item] = service.list().items;
  const r = await service.retry({ historyId: item.historyId });
  assert.equal(r.ok, true, 'in-flight 가드가 실패 경로에서도 해제된다');
  assert.equal(calls.length, 2);
});

// ── phase 58 테스트 게이트 보강: failedAt × 재송고 사이클 × 새 기록 경로(snapshotTitle 행) 교차 ──
// phase 58 이후 편집(edit) 행은 snapshotTitle 컬럼을 함께 적재한다(articleService.record).
// 그 행들이 실패 목록 파생·failedAt·사이클 경계(latestSendId)·재전송 게이트를 오염시키지 않고,
// 재송고로 새 사이클이 열린 뒤의 새 실패에서 failedAt이 갱신됨(ARCHITECTURE.md [실패복구] 문서 계약)을 잠근다.
test('retryService: 재송고 사이클 후 failedAt 갱신 — snapshotTitle 적재 edit 행이 끼어도 경계·목록 판정이 정확하다', async () => {
  const { db, service, writer, articleModel, articleHistoryModel, targetIds } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  // 새 기록 경로 그대로: 같은 db/모델 위의 실제 articleService가 edit 행을 남긴다(snapshotTitle 포함).
  const articleService = createArticleService({ articleModel, db, historyModel: articleHistoryModel });

  // 1사이클: 실패 t1 → 목록 failedAt = t1.
  const T1 = '2026-08-06T05:00:00.000Z';
  const h1 = seedFailure(articleHistoryModel, { targetId: targetIds.kbs, createdAt: T1 });
  const first = service.list().items;
  assert.equal(first.length, 1);
  assert.equal(first[0].failedAt, T1, '1사이클 첫 실패 시각');

  // 실패와 재송고 사이에 본문 편집 2회 — phase 58의 새 기록 경로가 snapshotTitle 컬럼을 적재한다.
  articleService.update(ARTICLE_ID, {
    markupVersion: '{"blocks":[{"type":"text","text":"고침 제목"},{"type":"text","text":"본문 (끝)"}]}',
    modifier: 'desk',
  });
  articleService.update(ARTICLE_ID, {
    markupVersion: '{"blocks":[{"type":"text","text":"고침 제목 2"},{"type":"text","text":"본문 (끝)"}]}',
    modifier: 'desk',
  });
  const editRows = db.prepare(
    "SELECT snapshotTitle FROM ArticleHistory WHERE articleId = ? AND eventType = 'edit'",
  ).all(ARTICLE_ID);
  assert.equal(editRows.length, 2);
  for (const e of editRows) assert.equal(typeof e.snapshotTitle, 'string', '새 기록 경로 확인(컬럼 적재)');

  // 재송고 — 새 사이클 경계. 이전 사이클 실패의 재전송은 stale-cycle로 거부된다(스풀 0회).
  seedSend(articleHistoryModel, {});
  const stale = await service.retry({ historyId: h1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale-cycle', 'snapshotTitle 적재 edit 행이 send 경계 판정을 흐리지 않는다');
  assert.equal(writer.calls.length, 0);

  // 2사이클: 새 실패 t2 → failedAt이 t2로 갱신된다(문서 계약: 재송고로 새 사이클이 열리면 새 행·갱신).
  const T2 = '2026-08-06T07:00:00.000Z';
  const h2 = seedFailure(articleHistoryModel, { targetId: targetIds.kbs, createdAt: T2 });
  const second = service.list().items;
  assert.equal(second.length, 1, '같은 그룹은 1건으로 접힌다(최신 실패)');
  assert.equal(second[0].failedAt, T2, '새 사이클의 실패로 failedAt 갱신');
  assert.equal(second[0].historyId, h2);
  assert.equal(second[0].kindDistributed, false, '이번 사이클 distribute 행 없음 — edit 행이 오염시키지 않는다');

  // 새 사이클 실패는 정상 복구된다 — 스풀 1회, 이후 목록 해소.
  const ok = await service.retry({ historyId: h2 });
  assert.equal(ok.ok, true);
  assert.equal(writer.calls.length, 1);
  assert.deepEqual(service.list().items, [], '재전송 성공으로 해소');
});
