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
  assert.equal(historyOf(db).length, 1);
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
  assert.equal(historyOf(db).length, 0);
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
