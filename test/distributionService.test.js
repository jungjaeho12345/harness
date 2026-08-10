// 배부 실행 서비스 테스트 — ADR-008 (4)(5).
// 하네스: in-memory DB + 실제 모델(대상 선정·DB 반영을 그대로 검증) + 가짜 spoolWriter(실제 FS 미접촉).
// CRITICAL: 배부는 부수효과다 — 한 수신처 실패가 다른 수신처를 막지 않고, 거짓 기록(distributedAt/이력)을 남기지 않는다.
// 시점 판정(엠바고 시각 비교)과 EPS→DPS 전이는 이 서비스의 책임이 아니다(phase 48 tick).

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createDistributionTargetModel } from '../src/models/distributionTargetModel.js';
import { createDistributionService } from '../src/services/distributionService.js';
import { createSpoolWriter } from '../src/services/spoolWriter.js';

const NOW = '2026-07-28T05:00:00.000Z';
const ARTICLE_ID = 'AKR20260728000000001';
// 입력은 POSIX 문자열 그대로, 기대값은 join()으로 — Windows/POSIX 양쪽에서 통과해야 한다.
const SPOOL_ROOT = '/spool/out';

// 호출을 기록하는 가짜 스풀 writer. failFor에 든 spoolDir는 실패로 응답한다.
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

function setup({ writer = fakeWriter(), targets = [], withArticle = true } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const distributionTargetModel = createDistributionTargetModel(db);

  if (withArticle) {
    articleModel.insert({
      article: { articleId: ARTICLE_ID, title: '제목', markupVersion: '{"blocks":[{"text":"본문 (끝)"}]}' },
      contents: {
        articleId: ARTICLE_ID, title: '제목', author: 'r1', status: 'DPS',
        createdAt: '2026-07-28T00:00:00.000Z', sentAt: '2026-07-28T04:00:00.000Z',
      },
    });
  }
  for (const t of targets) {
    distributionTargetModel.insert({
      active: 'Y', createdAt: NOW, updatedAt: NOW, ...t,
    });
  }

  const service = createDistributionService({
    distributionTargetModel, articleModel, historyModel, spoolWriter: writer, now: () => NOW,
  });
  return { db, service, writer, articleModel, historyModel, distributionTargetModel };
}

const contentsOf = (db) => db.prepare('SELECT * FROM Contents WHERE articleId = ?').get(ARTICLE_ID);
const historyOf = (db) => db.prepare('SELECT * FROM ArticleHistory WHERE articleId = ? ORDER BY id').all(ARTICLE_ID);

test('distributionService: 노출 메서드는 distribute 뿐이다(tick/타이머 진입점 없음)', () => {
  const { service } = setup();
  assert.deepEqual(Object.keys(service).sort(), ['distribute']);
});

test('kinds=[press]: 활성 언론사에만 쓰고 비활성·다른 kind는 건너뛴다', async () => {
  const { service, writer } = setup({
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: '폐지 언론사', kind: 'press', spoolDir: 'old-press', active: 'N' },
      { name: '포털', kind: 'nonpress', spoolDir: 'portal' },
    ],
  });

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'], actorUserId: 'desk1' });

  assert.equal(r.ok, true);
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].spoolDir, 'kbs');
  assert.equal(writer.calls[0].articleId, ARTICLE_ID);
  assert.equal(writer.calls[0].article.markupVersion, '{"blocks":[{"text":"본문 (끝)"}]}', '본문 행이 그대로 전달된다');
  assert.equal(writer.calls[0].contents.status, 'DPS');
  assert.deepEqual(r.distributed.map((d) => d.kind), ['press']);
  assert.deepEqual(r.failed, []);
});

test('kinds=[press,nonpress]: 두 kind 활성 대상 전부에 배부한다', async () => {
  const { service, writer, db } = setup({
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
      { name: '포털', kind: 'nonpress', spoolDir: 'portal' },
    ],
  });

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press', 'nonpress'], actorUserId: 'desk1' });

  assert.equal(r.ok, true);
  assert.deepEqual(writer.calls.map((c) => c.spoolDir).sort(), ['kbs', 'mbc', 'portal']);
  assert.equal(r.distributed.length, 3);
  assert.equal(contentsOf(db).distributedAt, NOW);
  const hist = historyOf(db);
  assert.deepEqual(hist.map((h) => `${h.eventType}:${h.action}`), ['distribute:press', 'distribute:nonpress']);
  assert.equal(hist[0].actorUserId, 'desk1');
});

test('대상 0건: 성공으로 끝내되 파일 쓰기·distributedAt·이력이 없다(송고를 막지 않는다)', async () => {
  const { service, writer, db } = setup({ targets: [] });
  const r = await service.distribute(ARTICLE_ID, { kinds: ['press', 'nonpress'] });

  assert.deepEqual(r, { ok: true, distributed: [], failed: [] });
  assert.equal(writer.calls.length, 0);
  assert.equal(contentsOf(db).distributedAt, null);
  assert.equal(historyOf(db).length, 0);
});

test('kinds 미지정·빈 배열·허용 밖 값은 아무것도 하지 않는다', async () => {
  const { service, writer } = setup({ targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }] });
  for (const kinds of [undefined, [], ['bogus'], 'press', null]) {
    const r = await service.distribute(ARTICLE_ID, { kinds });
    assert.deepEqual(r, { ok: true, distributed: [], failed: [] }, `kinds=${JSON.stringify(kinds)}`);
  }
  assert.equal(writer.calls.length, 0);
});

test('없는 기사: not-found로 거부하고 파일을 쓰지 않는다', async () => {
  const { service, writer } = setup({ withArticle: false, targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }] });
  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'] });
  assert.deepEqual(r, { ok: false, reason: 'not-found' });
  assert.equal(writer.calls.length, 0);
});

test('성공 시 distributedAt만 갱신하고 status·sentAt·본문은 불변이다', async () => {
  const { service, db } = setup({ targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }] });
  const before = contentsOf(db);
  await service.distribute(ARTICLE_ID, { kinds: ['press'] });
  const after = contentsOf(db);

  assert.equal(after.distributedAt, NOW);
  assert.equal(after.status, before.status);
  assert.equal(after.sentAt, before.sentAt);
  assert.equal(
    db.prepare('SELECT markupVersion FROM Article WHERE articleId = ?').get(ARTICLE_ID).markupVersion,
    '{"blocks":[{"text":"본문 (끝)"}]}',
  );
});

test('부분 실패: 한 수신처가 실패해도 나머지는 배부되고 failed로 보고된다', async () => {
  const writer = fakeWriter({ failFor: new Set(['mbc']) });
  const { service, db } = setup({
    writer,
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
    ],
  });

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  assert.equal(r.ok, true);
  assert.deepEqual(r.distributed.map((d) => d.targetId).length, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].reason, 'spool-write-failed');
  assert.equal(contentsOf(db).distributedAt, NOW, '1건이라도 성공하면 배부 시각을 기록한다');
  const hist = historyOf(db);
  assert.equal(hist.filter((h) => h.eventType === 'distribute').length, 1, 'kind 단위 distribute 행은 1건 그대로');
  assert.equal(hist.filter((h) => h.eventType === 'distribute-failed').length, 1, '실패 수신처의 distribute-failed 행이 1건 남는다');
});

test('전량 실패: distributedAt을 갱신하지 않고 이력도 남기지 않는다(거짓 기록 금지)', async () => {
  const writer = fakeWriter({ failFor: new Set(['kbs', 'portal']) });
  const { service, db } = setup({
    writer,
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: '포털', kind: 'nonpress', spoolDir: 'portal' },
    ],
  });

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press', 'nonpress'] });

  assert.equal(r.ok, true);
  assert.equal(r.distributed.length, 0);
  assert.equal(r.failed.length, 2);
  assert.equal(contentsOf(db).distributedAt, null);
  assert.equal(historyOf(db).filter((h) => h.eventType === 'distribute').length, 0, '거짓 기록 금지 — distribute 행 0건');
  assert.equal(historyOf(db).filter((h) => h.eventType === 'distribute-failed').length, 2, '수신처 단위 실패 2건은 영속된다');
});

test('spoolWriter 미주입: spool-disabled로 거부하고 DB를 건드리지 않는다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  articleModel.insert({ article: { articleId: ARTICLE_ID }, contents: { articleId: ARTICLE_ID, status: 'DPS' } });
  const service = createDistributionService({
    distributionTargetModel: createDistributionTargetModel(db), articleModel, now: () => NOW,
  });

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'] });
  assert.deepEqual(r, { ok: false, reason: 'spool-disabled' });
  assert.equal(contentsOf(db).distributedAt, null);
});

test('이력은 append-only — 기존 이력 행과 다른 테이블 행은 그대로 남는다(DB 비파괴)', async () => {
  const { service, db, historyModel } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }, { name: '포털', kind: 'nonpress', spoolDir: 'portal' }],
  });
  historyModel.insert({
    articleId: ARTICLE_ID, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS',
    actorUserId: 'desk1', createdAt: '2026-07-28T04:00:00.000Z',
  });
  const counts = () => ({
    article: db.prepare('SELECT COUNT(*) c FROM Article').get().c,
    contents: db.prepare('SELECT COUNT(*) c FROM Contents').get().c,
    targets: db.prepare('SELECT COUNT(*) c FROM DistributionTarget').get().c,
  });
  const before = counts();

  await service.distribute(ARTICLE_ID, { kinds: ['press', 'nonpress'], actorUserId: 'desk1' });

  assert.deepEqual(counts(), before, '배부는 어떤 행도 지우거나 추가하지 않는다(이력 제외)');
  const hist = historyOf(db);
  assert.equal(hist.length, 3);
  assert.equal(hist[0].action, 'send', '기존 송고 이력이 보존된다');
  assert.deepEqual(hist.slice(1).map((h) => h.action), ['press', 'nonpress']);
  // 배부 이력은 송고이력 필터(eventType='status' && action='send')에 걸리지 않는다.
  assert.equal(hist.filter((h) => h.eventType === 'status' && h.action === 'send').length, 1);
});

test('이력 기록 실패는 배부를 되돌리지 않는다', async () => {
  const { db } = setup({ targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }] });
  const broken = createDistributionService({
    distributionTargetModel: createDistributionTargetModel(db),
    articleModel: createArticleModel(db),
    historyModel: { insert() { throw new Error('이력 저장 실패'); } },
    spoolWriter: fakeWriter(),
    now: () => NOW,
  });

  const r = await broken.distribute(ARTICLE_ID, { kinds: ['press'] });
  assert.equal(r.ok, true);
  assert.equal(r.distributed.length, 1);
  assert.equal(contentsOf(db).distributedAt, NOW);
});

test('재배부: distributedAt은 최신 배부 시각으로 갱신되고 이력은 누적된다', async () => {
  const { db, distributionTargetModel, articleModel, historyModel } = setup({
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const make = (stamp) => createDistributionService({
    distributionTargetModel, articleModel, historyModel, spoolWriter: fakeWriter(), now: () => stamp,
  });

  await make('2026-07-28T05:00:00.000Z').distribute(ARTICLE_ID, { kinds: ['press'] });
  assert.equal(contentsOf(db).distributedAt, '2026-07-28T05:00:00.000Z');

  await make('2026-07-28T09:30:00.000Z').distribute(ARTICLE_ID, { kinds: ['press'] });
  assert.equal(contentsOf(db).distributedAt, '2026-07-28T09:30:00.000Z', '최근 배부 시각으로 갱신한다');
  // 과거 배부 사실은 이력에 남는다 — 정보 손실이 없다(ADR-008).
  assert.deepEqual(
    historyOf(db).map((h) => h.createdAt),
    ['2026-07-28T05:00:00.000Z', '2026-07-28T09:30:00.000Z'],
  );
});

test('레거시 행의 잘못된 spoolDir는 실제 writer가 거부해 failed로 격리된다(경로 조작 방어)', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  articleModel.insert({
    article: { articleId: ARTICLE_ID, title: '제목' },
    contents: { articleId: ARTICLE_ID, status: 'DPS' },
  });
  const distributionTargetModel = createDistributionTargetModel(db);
  // 서비스 검증을 우회해 저장된 값(구버전 데이터·직접 DB 편집)을 모사한다.
  distributionTargetModel.insert({ name: '수상한 대상', kind: 'press', spoolDir: '../../etc', active: 'Y' });
  distributionTargetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' });

  const fsCalls = [];
  const service = createDistributionService({
    distributionTargetModel,
    articleModel,
    historyModel: createArticleHistoryModel(db),
    // 실제 spoolWriter를 쓰되 FS 조작만 주입한다 — 경로 재검증이 실제로 동작하는지 확인.
    spoolWriter: createSpoolWriter({
      rootDir: SPOOL_ROOT,
      mkdir: async (...a) => { fsCalls.push(['mkdir', ...a]); },
      writeFile: async (...a) => { fsCalls.push(['writeFile', ...a]); },
      rename: async (...a) => { fsCalls.push(['rename', ...a]); },
      now: () => NOW,
    }),
    now: () => NOW,
  });

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  assert.equal(r.ok, true);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].reason, 'invalid-spool-dir');
  assert.equal(r.distributed.length, 1, '정상 수신처 배부는 계속된다');
  // 스풀 루트 밖으로 나가는 경로는 어떤 FS 호출에도 나타나지 않는다.
  for (const call of fsCalls) {
    assert.equal(String(call[1]).startsWith(join(SPOOL_ROOT, 'kbs')), true, JSON.stringify(call));
  }
});

test('실패는 onFailure로 표면화된다 — 무음 삼킴 금지(fire-and-forget 호출자가 결과를 보지 않는다)', async () => {
  const seen = [];
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  articleModel.insert({ article: { articleId: ARTICLE_ID }, contents: { articleId: ARTICLE_ID, status: 'DPS' } });
  const distributionTargetModel = createDistributionTargetModel(db);
  distributionTargetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' });
  distributionTargetModel.insert({ name: 'MBC', kind: 'press', spoolDir: 'mbc', active: 'Y' });

  const service = createDistributionService({
    distributionTargetModel,
    articleModel,
    historyModel: createArticleHistoryModel(db),
    spoolWriter: fakeWriter({ failFor: new Set(['mbc']) }),
    now: () => NOW,
    onFailure: (info) => seen.push(info),
  });

  await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].articleId, ARTICLE_ID);
  assert.equal(seen[0].spoolDir, 'mbc');
  assert.equal(seen[0].kind, 'press');
  assert.equal(seen[0].reason, 'spool-write-failed');
});

// ── TOCTOU 상태 가드(step 49-2) ──────────────────────────────────────────
// 수신처 2곳 이상이면 앞 쓰기의 await 동안 KILL(EEK)·보류(EEH)·삭제 승인(DPD)이 끼어들 수 있다.
// 레이스는 주입한 writer의 write 안에서 DB를 갱신해 **결정적으로** 재현한다(타이머·랜덤 금지).

// n번째 write 완료 시 부수효과(예: 상태 전이)를 실행하는 가짜 writer. onWrite는 늦은 바인딩(hooks)으로
// 받는다 — setup()이 만드는 articleModel을 부수효과에서 써야 하기 때문(선후 순환 회피).
function hookedWriter(hooks = {}) {
  const calls = [];
  return {
    calls,
    async write(args) {
      calls.push(args);
      if (hooks.onWrite) hooks.onWrite(args, calls.length);
      return { ok: true, file: `/spool/${args.spoolDir}/${args.articleId}.json` };
    },
  };
}

test('상태 가드: 수신처 사이에 KILL(EEK)로 전이되면 남은 수신처 쓰기를 중단한다', async () => {
  const hooks = {};
  const writer = hookedWriter(hooks);
  const { service, articleModel, distributionTargetModel } = setup({
    writer,
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
    ],
  });
  // 첫 수신처 스풀 쓰기 도중 데스크가 엠바고 킬 — 두 번째 수신처 직전 재확인에 걸려야 한다.
  hooks.onWrite = (args, n) => {
    if (n === 1) articleModel.update(ARTICLE_ID, { contents: { status: 'EEK' } });
  };

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  assert.equal(r.ok, true, '반환 shape은 불변 — 부분 성공은 배부 성립이다');
  assert.equal(writer.calls.length, 1, '두 번째 수신처로는 쓰지 않는다');
  assert.equal(r.distributed.length, 1);
  assert.equal(r.distributed[0].spoolDir, 'kbs');
  const mbc = distributionTargetModel.query({ kind: 'press', active: 'Y' }).find((t) => t.spoolDir === 'mbc');
  assert.deepEqual(r.failed, [
    { articleId: ARTICLE_ID, targetId: mbc.id, kind: 'press', spoolDir: 'mbc', reason: 'status-changed' },
  ], '처리 못 한 수신처는 기존 failed shape 그대로 status-changed로 남는다');
});

test('상태 가드: kind 사이 전이(DPD)면 다음 kind는 시작하지 않고 targetId:null로 보고한다', async () => {
  const hooks = {};
  const writer = hookedWriter(hooks);
  const { service, articleModel, db } = setup({
    writer,
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: '포털', kind: 'nonpress', spoolDir: 'portal' },
    ],
  });
  hooks.onWrite = (args, n) => {
    if (n === 1) articleModel.update(ARTICLE_ID, { contents: { status: 'DPD' } });
  };

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press', 'nonpress'] });

  assert.equal(r.ok, true);
  assert.deepEqual(writer.calls.map((c) => c.spoolDir), ['kbs'], 'nonpress 쓰기는 일어나지 않는다');
  // 시작도 못 한 kind를 failed에 남기지 않으면 tick이 no-active-target으로 오보한다
  // (tick은 distributed∪failed에 등장한 kind만 "처리됨"으로 본다 — 회귀 가드).
  const nulls = r.failed.filter((f) => f.targetId === null);
  assert.deepEqual(nulls, [
    { articleId: ARTICLE_ID, targetId: null, kind: 'nonpress', reason: 'status-changed' },
  ], '아예 시작도 못 한 kind는 targetId:null 항목 정확히 1건으로 남는다');
  assert.equal(historyOf(db).filter((h) => h.action === 'nonpress').length, 0, 'nonpress 이력은 생기지 않는다');
});

test('상태 가드: 중단 전에 성공한 쓰기는 사실로 남는다(distributedAt·이력 미회수)', async () => {
  const hooks = {};
  const writer = hookedWriter(hooks);
  const { service, articleModel, db } = setup({
    writer,
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
    ],
  });
  hooks.onWrite = (args, n) => {
    if (n === 1) articleModel.update(ARTICLE_ID, { contents: { status: 'EEK' } });
  };

  await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  // 스풀 파일은 이미 나갔다 — 되돌리면 tick의 멱등 근거(append-only 이력)가 깨진다.
  assert.equal(contentsOf(db).distributedAt, NOW, '성공한 쓰기의 배부 시각은 그대로 기록된다');
  assert.deepEqual(
    historyOf(db).map((h) => `${h.eventType}:${h.action}`),
    ['distribute:press'],
    '성공한 kind의 배부 이력은 1건 남는다',
  );
  assert.equal(contentsOf(db).status, 'EEK', '가드는 status를 쓰지 않는다 — 읽기 전용');
});

test('상태 가드: 페이로드는 최초 스냅샷을 유지한다(재조회는 status 판정 전용)', async () => {
  const hooks = {};
  const writer = hookedWriter(hooks);
  const { service, articleModel } = setup({
    writer,
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
    ],
  });
  // 첫 쓰기 도중 제목이 바뀌어도(allowlist 안 상태 유지) 두 번째 수신처에는 같은 스냅샷이 나간다.
  hooks.onWrite = (args, n) => {
    if (n === 1) articleModel.update(ARTICLE_ID, { contents: { title: '바뀐 제목' } });
  };

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  assert.equal(r.distributed.length, 2, '상태가 allowlist 안이면 배부는 계속된다');
  assert.equal(writer.calls.length, 2);
  assert.equal(writer.calls[1].contents.title, '제목', '한 배치는 같은 본문을 내보낸다 — 정정 추적 가능성');
});

test('상태 가드: 정상 경로(DPS/DES/EPS)는 전혀 막지 않는다 — 수신처 3곳 전부 배부', async () => {
  for (const status of ['DPS', 'DES', 'EPS']) {
    const writer = fakeWriter();
    const { service, articleModel } = setup({
      writer,
      targets: [
        { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
        { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
        { name: '포털', kind: 'nonpress', spoolDir: 'portal' },
      ],
    });
    articleModel.update(ARTICLE_ID, { contents: { status } });

    const r = await service.distribute(ARTICLE_ID, { kinds: ['press', 'nonpress'] });

    assert.equal(r.ok, true, `status=${status}`);
    assert.equal(r.distributed.length, 3, `status=${status}: 전 수신처에 배부된다`);
    assert.deepEqual(r.failed, [], `status=${status}`);
    assert.equal(writer.calls.length, 3, `status=${status}`);
  }
});

test('상태 가드: 중단으로 건너뛴 항목도 onFailure로 표면화된다(무음 삼킴 금지)', async () => {
  const seen = [];
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  articleModel.insert({ article: { articleId: ARTICLE_ID }, contents: { articleId: ARTICLE_ID, status: 'DPS' } });
  const distributionTargetModel = createDistributionTargetModel(db);
  distributionTargetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' });
  distributionTargetModel.insert({ name: 'MBC', kind: 'press', spoolDir: 'mbc', active: 'Y' });
  distributionTargetModel.insert({ name: '포털', kind: 'nonpress', spoolDir: 'portal', active: 'Y' });

  const hooks = {};
  const service = createDistributionService({
    distributionTargetModel,
    articleModel,
    historyModel: createArticleHistoryModel(db),
    spoolWriter: hookedWriter(hooks),
    now: () => NOW,
    onFailure: (info) => seen.push(info),
  });
  hooks.onWrite = (args, n) => {
    if (n === 1) articleModel.update(ARTICLE_ID, { contents: { status: 'EEK' } });
  };

  await service.distribute(ARTICLE_ID, { kinds: ['press', 'nonpress'] });

  // 처리 못 한 수신처(mbc) + 시작도 못 한 kind(nonpress) — 두 종류 전부 보고된다.
  assert.equal(seen.length, 2);
  assert.equal(seen[0].spoolDir, 'mbc');
  assert.equal(seen[0].reason, 'status-changed');
  assert.deepEqual(seen[1], { articleId: ARTICLE_ID, targetId: null, kind: 'nonpress', reason: 'status-changed' });
});

test('onFailure가 throw해도 배부와 기록은 정상 완료된다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  articleModel.insert({ article: { articleId: ARTICLE_ID }, contents: { articleId: ARTICLE_ID, status: 'DPS' } });
  const distributionTargetModel = createDistributionTargetModel(db);
  distributionTargetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' });
  distributionTargetModel.insert({ name: 'MBC', kind: 'press', spoolDir: 'mbc', active: 'Y' });

  const service = createDistributionService({
    distributionTargetModel,
    articleModel,
    historyModel: createArticleHistoryModel(db),
    spoolWriter: fakeWriter({ failFor: new Set(['kbs']) }),
    now: () => NOW,
    onFailure: () => { throw new Error('로그 실패'); },
  });

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'] });
  assert.equal(r.ok, true);
  assert.equal(r.distributed.length, 1);
  assert.equal(contentsOf(db).distributedAt, NOW);
});

// --- phase 54 step1: 이력 insert 실패의 표면화(onHistoryError) ---
// distribute 행은 tick의 "이미 배부됨" 멱등 판정 근거다 — 사라지면 중복 배부(회수 불가)로 이어진다.
// 그래도 배부 결과 자체는 바뀌지 않는다: 스풀은 실제로 나갔으므로 failed에 넣지 않는다.

// insert만 던지는 이력 모델 스텁(스풀 쓰기는 성공하는 시나리오를 만든다).
function throwingHistoryModel(message = 'db locked') {
  return {
    insert() { throw new Error(message); },
    queryByArticle() { return []; },
  };
}

function setupHistoryFailure({ onHistoryError, onFailure } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  articleModel.insert({ article: { articleId: ARTICLE_ID }, contents: { articleId: ARTICLE_ID, status: 'DPS' } });
  const distributionTargetModel = createDistributionTargetModel(db);
  distributionTargetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' });

  const service = createDistributionService({
    distributionTargetModel,
    articleModel,
    historyModel: throwingHistoryModel(),
    spoolWriter: fakeWriter(),
    now: () => NOW,
    onFailure,
    onHistoryError,
  });
  return { db, service };
}

test('이력 insert 실패는 onHistoryError로 표면화되고 배부 결과·distributedAt은 그대로다', async () => {
  const seen = [];
  const failures = [];
  const { db, service } = setupHistoryFailure({
    onHistoryError: (info) => seen.push(info),
    onFailure: (info) => failures.push(info),
  });

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'], actorUserId: 'desk' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].articleId, ARTICLE_ID);
  assert.equal(seen[0].eventType, 'distribute');
  assert.equal(seen[0].action, 'press', 'action에는 kind가 담긴다(articleService와 같은 shape)');
  assert.match(seen[0].reason, /db locked/);
  // 반환 shape은 오늘과 동일 — 이력 실패는 배부 실패가 아니다.
  assert.equal(r.ok, true);
  assert.equal(r.distributed.length, 1);
  assert.deepEqual(r.failed, []);
  assert.equal(contentsOf(db).distributedAt, NOW);
  // 두 신호를 섞지 않는다: onFailure는 "수신처 미발송" 전용이다.
  assert.deepEqual(failures, []);
});

test('onHistoryError가 throw해도 배부는 정상 완료된다(알림 실패 격리)', async () => {
  const { db, service } = setupHistoryFailure({
    onHistoryError: () => { throw new Error('로그 실패'); },
  });

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  assert.equal(r.ok, true);
  assert.equal(r.distributed.length, 1);
  assert.equal(contentsOf(db).distributedAt, NOW);
});

test('onHistoryError: 이력 insert가 성공하는 정상 경로에서는 호출 0회다', async () => {
  const seen = [];
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  articleModel.insert({ article: { articleId: ARTICLE_ID }, contents: { articleId: ARTICLE_ID, status: 'DPS' } });
  const distributionTargetModel = createDistributionTargetModel(db);
  distributionTargetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' });
  const service = createDistributionService({
    distributionTargetModel,
    articleModel,
    historyModel: createArticleHistoryModel(db),
    spoolWriter: fakeWriter(),
    now: () => NOW,
    onHistoryError: (info) => seen.push(info),
  });

  await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  assert.deepEqual(seen, []);
  assert.equal(historyOf(db).length, 1);
});

// --- phase 57 step2: 수신처 단위 스풀 쓰기 실패의 영속(distribute-failed, append-only) ---
// 기록 대상: targetId가 있고 reason이 재전송 가능 allowlist인 실패만.
// 비기록: status-changed 안전 중단·targetId:null kind 단위 항목(기존대로 onFailure로만 표면화).

const failedHistoryOf = (db) => db
  .prepare("SELECT * FROM ArticleHistory WHERE articleId = ? AND eventType = 'distribute-failed' ORDER BY id")
  .all(ARTICLE_ID);

// 케이스 1
test('실패 영속: 부분 실패 시 distribute-failed 1행 — action=kind, targetId 숫자, reason·actor·createdAt', async () => {
  const writer = fakeWriter({ failFor: new Set(['mbc']) });
  const { service, db, distributionTargetModel } = setup({
    writer,
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
    ],
  });
  const mbc = distributionTargetModel.query({ kind: 'press', active: 'Y' }).find((t) => t.spoolDir === 'mbc');

  await service.distribute(ARTICLE_ID, { kinds: ['press'], actorUserId: 'desk1' });

  const rows = failedHistoryOf(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventType, 'distribute-failed');
  assert.equal(rows[0].action, 'press', 'action=kind');
  assert.strictEqual(rows[0].targetId, mbc.id, 'targetId는 숫자(INTEGER)');
  assert.equal(rows[0].reason, 'spool-write-failed');
  assert.equal(rows[0].actorUserId, 'desk1');
  assert.equal(rows[0].createdAt, NOW, '주입한 now()로 stamp');
});

// 케이스 3
test('실패 영속: 성공한 수신처에는 distribute-failed 행이 생기지 않는다 (성공 2/실패 1 → 실패 행 1건)', async () => {
  const writer = fakeWriter({ failFor: new Set(['sbs']) });
  const { service, db, distributionTargetModel } = setup({
    writer,
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
      { name: 'SBS', kind: 'press', spoolDir: 'sbs' },
    ],
  });
  const sbs = distributionTargetModel.query({ kind: 'press', active: 'Y' }).find((t) => t.spoolDir === 'sbs');

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  assert.equal(r.distributed.length, 2);
  const rows = failedHistoryOf(db);
  assert.equal(rows.length, 1, '실패한 수신처 1곳만 기록된다');
  assert.strictEqual(rows[0].targetId, sbs.id);
});

// 케이스 4
test('실패 영속: status-changed 중단 항목은 기록하지 않는다 (targetId 있는 잔여 수신처 포함, onFailure는 유지)', async () => {
  const seen = [];
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  articleModel.insert({ article: { articleId: ARTICLE_ID }, contents: { articleId: ARTICLE_ID, status: 'DPS' } });
  const distributionTargetModel = createDistributionTargetModel(db);
  distributionTargetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' });
  distributionTargetModel.insert({ name: 'MBC', kind: 'press', spoolDir: 'mbc', active: 'Y' });
  distributionTargetModel.insert({ name: '포털', kind: 'nonpress', spoolDir: 'portal', active: 'Y' });

  const hooks = {};
  const service = createDistributionService({
    distributionTargetModel,
    articleModel,
    historyModel: createArticleHistoryModel(db),
    spoolWriter: hookedWriter(hooks),
    now: () => NOW,
    onFailure: (info) => seen.push(info),
  });
  hooks.onWrite = (args, n) => {
    if (n === 1) articleModel.update(ARTICLE_ID, { contents: { status: 'EEK' } });
  };

  await service.distribute(ARTICLE_ID, { kinds: ['press', 'nonpress'] });

  assert.equal(failedHistoryOf(db).length, 0, '안전 중단은 영속하지 않는다 — 영원히 미해소로 남는 항목을 만들지 않는다');
  assert.equal(seen.length, 2, 'onFailure 통지는 기존대로 유지된다(무음 삼킴 아님)');
  assert.ok(seen.every((f) => f.reason === 'status-changed'));
});

// 케이스 5
test('실패 영속: invalid-spool-dir(레거시 거부 값)도 distribute-failed로 기록된다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  articleModel.insert({
    article: { articleId: ARTICLE_ID, title: '제목' },
    contents: { articleId: ARTICLE_ID, status: 'DPS' },
  });
  const distributionTargetModel = createDistributionTargetModel(db);
  distributionTargetModel.insert({ name: '수상한 대상', kind: 'press', spoolDir: '../../etc', active: 'Y' });
  distributionTargetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' });
  const bad = db.prepare("SELECT id FROM DistributionTarget WHERE name = '수상한 대상'").get();

  const service = createDistributionService({
    distributionTargetModel,
    articleModel,
    historyModel: createArticleHistoryModel(db),
    spoolWriter: createSpoolWriter({
      rootDir: SPOOL_ROOT,
      mkdir: async () => {},
      writeFile: async () => {},
      rename: async () => {},
      now: () => NOW,
    }),
    now: () => NOW,
  });

  await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  const rows = failedHistoryOf(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'invalid-spool-dir');
  assert.strictEqual(rows[0].targetId, bad.id);
});

// 케이스 6 (코드리뷰 반려 [med]로 의미 갱신 — 과거: "재실행 시 실패 행 누적"을 잠갔으나, 그 행동이
// 지속 실패에서 distribute-failed 무제한 누적 결함으로 판정됐다. 이제 같은 사유의 미해소 실패는 접힌다.)
test('실패 영속: 재실행이 기존 실패 행을 갱신·삭제하지 않는다 (append-only 불변 + 같은 사유는 억제)', async () => {
  const writer = fakeWriter({ failFor: new Set(['kbs']) });
  const { service, db, distributionTargetModel } = setup({
    writer,
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const kbs = distributionTargetModel.query({ kind: 'press', active: 'Y' })[0];

  await service.distribute(ARTICLE_ID, { kinds: ['press'] });
  const [first] = failedHistoryOf(db);
  await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  const rows = failedHistoryOf(db);
  assert.equal(rows.length, 1, '같은 사유의 미해소 실패가 최신이면 새 행을 만들지 않는다(케이스 10과 동형)');
  // 억제는 "insert 생략"일 뿐이다 — 기존 행은 한 바이트도 바뀌지 않는다(갱신·삭제 없음).
  assert.deepEqual({ ...rows[0] }, { ...first }, '기존 실패 행이 그대로 보존된다');
  assert.strictEqual(rows[0].targetId, kbs.id);
  assert.equal(rows[0].reason, 'spool-write-failed');
});

// 케이스 7
test('실패 영속: 이력 insert 실패가 배부를 되돌리지 않는다 (onHistoryError 표면화 — 본문 미포함)', async () => {
  const seen = [];
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  articleModel.insert({ article: { articleId: ARTICLE_ID }, contents: { articleId: ARTICLE_ID, status: 'DPS' } });
  const distributionTargetModel = createDistributionTargetModel(db);
  distributionTargetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' });
  distributionTargetModel.insert({ name: 'MBC', kind: 'press', spoolDir: 'mbc', active: 'Y' });

  const service = createDistributionService({
    distributionTargetModel,
    articleModel,
    historyModel: { insert() { throw new Error('db locked'); } },
    spoolWriter: fakeWriter({ failFor: new Set(['mbc']) }),
    now: () => NOW,
    onHistoryError: (info) => seen.push(info),
  });

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  assert.equal(r.ok, true, '이력 실패는 배부 실패가 아니다');
  assert.equal(r.distributed.length, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(contentsOf(db).distributedAt, NOW, 'distributedAt은 그대로 갱신된다');
  // distribute-failed insert + distribute insert 두 건 모두 표면화된다.
  const types = seen.map((s) => s.eventType).sort();
  assert.deepEqual(types, ['distribute', 'distribute-failed']);
  for (const info of seen) {
    assert.deepEqual(
      Object.keys(info).sort(),
      ['action', 'articleId', 'eventType', 'reason'],
      '사유·식별자만 담긴다 — 본문·페이로드 금지',
    );
  }
});

// 케이스 8
test('실패 영속: 반환 shape 불변 — { ok, distributed, failed }와 failed 항목 필드 그대로', async () => {
  const writer = fakeWriter({ failFor: new Set(['mbc']) });
  const { service } = setup({
    writer,
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
    ],
  });

  const r = await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  assert.deepEqual(Object.keys(r).sort(), ['distributed', 'failed', 'ok']);
  assert.deepEqual(
    Object.keys(r.failed[0]).sort(),
    ['articleId', 'kind', 'reason', 'spoolDir', 'targetId'],
    'tick의 화이트리스트 투영이 이 shape에 묶여 있다',
  );
});

// 케이스 9
test('실패 영속: DB 비파괴 — 배부 전후 행 수 불변, 기존 이력 보존', async () => {
  const writer = fakeWriter({ failFor: new Set(['kbs']) });
  const { service, db, historyModel } = setup({
    writer,
    targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  historyModel.insert({
    articleId: ARTICLE_ID, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS',
    actorUserId: 'desk1', createdAt: '2026-07-28T04:00:00.000Z',
  });
  const counts = () => ({
    article: db.prepare('SELECT COUNT(*) c FROM Article').get().c,
    contents: db.prepare('SELECT COUNT(*) c FROM Contents').get().c,
    targets: db.prepare('SELECT COUNT(*) c FROM DistributionTarget').get().c,
  });
  const before = counts();

  await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  assert.deepEqual(counts(), before);
  const hist = historyOf(db);
  assert.equal(hist[0].action, 'send', '기존 송고 이력이 보존된다');
  assert.equal(hist.filter((h) => h.eventType === 'distribute-failed').length, 1);
});

// --- 코드리뷰 반려 [med]: 지속 실패의 distribute-failed 중복 억제 ---
// tick은 주기 실행이다 — 같은 수신처가 같은 사유로 계속 실패하면 주기마다 실패 행이 무제한 누적된다.
// 그 그룹((articleId,targetId,action))의 최신 행이 이미 같은 reason의 미해소 실패면 insert를 생략한다.
// 판정은 distributionFailureLog의 기존 파생(unresolvedFailures)을 재사용한다 — 새 판정 규칙 금지.

// 케이스 10
test('실패 중복 억제: 같은 실패 2연속이면 distribute-failed 행은 1개다 (표면화는 매번 유지)', async () => {
  const writer = fakeWriter({ failFor: new Set(['kbs']) });
  const { service, db } = setup({ writer, targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }] });

  const r1 = await service.distribute(ARTICLE_ID, { kinds: ['press'] });
  const r2 = await service.distribute(ARTICLE_ID, { kinds: ['press'] }); // tick 반복 상황

  assert.equal(r1.failed.length, 1);
  assert.equal(r2.failed.length, 1, '기록을 생략해도 failed 반환(운영 표면화)은 매번 남는다');
  const rows = failedHistoryOf(db);
  assert.equal(rows.length, 1, '같은 reason의 미해소 실패가 최신이면 새 행을 만들지 않는다');
  assert.equal(rows[0].reason, 'spool-write-failed');
});

// 케이스 11
test('실패 중복 억제: reason이 달라지면 새 행이 남는다 (원인 변화는 사실 기록이다)', async () => {
  const state = { reason: 'spool-write-failed' };
  const writer = {
    calls: [],
    async write(args) { writer.calls.push(args); return { ok: false, reason: state.reason }; },
  };
  const { service, db } = setup({ writer, targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }] });

  await service.distribute(ARTICLE_ID, { kinds: ['press'] });
  state.reason = 'invalid-spool-dir';
  await service.distribute(ARTICLE_ID, { kinds: ['press'] });

  const rows = failedHistoryOf(db);
  assert.deepEqual(rows.map((r) => r.reason), ['spool-write-failed', 'invalid-spool-dir'], '사유가 다르면 각각 남는다');
});

// 케이스 12
test('실패 중복 억제: 해소(distribute-retry) 후 재실패면 새 행이 남는다', async () => {
  const writer = fakeWriter({ failFor: new Set(['kbs']) });
  const { service, db, historyModel, distributionTargetModel } = setup({
    writer, targets: [{ name: 'KBS', kind: 'press', spoolDir: 'kbs' }],
  });
  const kbs = distributionTargetModel.query({})[0];

  await service.distribute(ARTICLE_ID, { kinds: ['press'] });
  // 재전송으로 해소 — 그룹 최신이 distribute-retry가 된다.
  historyModel.insert({
    articleId: ARTICLE_ID, eventType: 'distribute-retry', action: 'press',
    targetId: kbs.id, actorUserId: 'z1', createdAt: NOW,
  });
  await service.distribute(ARTICLE_ID, { kinds: ['press'] }); // 다시 실패

  const rows = failedHistoryOf(db);
  assert.equal(rows.length, 2, '해소 이후의 재실패는 새 사실이다 — 반드시 남는다');
});

// 케이스 13
test('실패 중복 억제: 다른 수신처·다른 kind의 실패는 억제되지 않는다 (그룹 단위 판정)', async () => {
  const writer = fakeWriter({ failFor: new Set(['kbs', 'mbc', 'portal']) });
  const { service, db } = setup({
    writer,
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
      { name: '포털', kind: 'nonpress', spoolDir: 'portal' },
    ],
  });

  await service.distribute(ARTICLE_ID, { kinds: ['press', 'nonpress'] });

  const rows = failedHistoryOf(db);
  assert.equal(rows.length, 3, '수신처 3곳 각각의 첫 실패는 전부 남는다');
  assert.equal(new Set(rows.map((r) => `${r.targetId}:${r.action}`)).size, 3);
});
