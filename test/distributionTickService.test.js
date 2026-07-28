// 시점 배부 tick 서비스 테스트 — ADR-008 (3)(5).
// 하네스: in-memory DB + 실제 모델(상태·이력이 DB에 어떻게 남는지 그대로 검증) + 가짜 distributionService.
// CRITICAL:
//  - tick은 외부 운영 루틴이 반복 호출한다 → 멱등해야 한다(이미 배부된 kind 재배부 0).
//  - 완결 판정 근거는 ArticleHistory의 eventType='distribute' 이력이다(배부 반환값이 아니다).
//  - 배부할 게 없어도 완결 판정은 수행한다(이력만 있고 전이가 밀린 기사의 자가 치유).
//  - 보류·킬(EEH/EEK)은 시각이 지나도 절대 배부·전이 대상이 아니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createDistributionTickService } from '../src/services/distributionTickService.js';

const T1 = '2026-07-28T05:00:00.000Z'; // 1차 엠바고
const T2 = '2026-07-28T09:00:00.000Z'; // 2차 엠바고
const BEFORE = '2026-07-28T04:00:00.000Z';
const BETWEEN = '2026-07-28T06:00:00.000Z';
const AFTER = '2026-07-28T10:00:00.000Z';

// 배부 호출을 기록하는 가짜 배부 서비스.
// 실제 서비스와 같은 계약: 성공 시 kind별로 ArticleHistory에 distribute 이력을 남긴다.
function fakeDistribution(historyModel, { fail = false, throwOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async distribute(articleId, { kinds, actorUserId } = {}) {
      calls.push({ articleId, kinds, actorUserId });
      if (throwOn && throwOn === articleId) throw new Error('배부 폭발');
      if (fail) {
        return { ok: true, distributed: [], failed: kinds.map((k) => ({ articleId, kind: k, reason: 'spool-write-failed' })) };
      }
      for (const kind of kinds) {
        historyModel.insert({
          articleId, eventType: 'distribute', action: kind, actorUserId, createdAt: T1,
        });
      }
      return { ok: true, distributed: kinds.map((k) => ({ targetId: 1, kind: k })), failed: [] };
    },
  };
}

function setup({ now = AFTER, distributionOpts, withService = true } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const distributionService = withService ? fakeDistribution(historyModel, distributionOpts) : undefined;

  let clock = now;
  const service = createDistributionTickService({
    articleModel, historyModel, distributionService, now: () => clock,
  });

  return {
    db,
    service,
    distributionService,
    articleModel,
    historyModel,
    setNow: (v) => { clock = v; },
  };
}

// 기사 1건 적재. status·엠바고 시각을 자유 지정.
function addArticle(articleModel, articleId, { status = 'EPS', embargoAt, secondEmbargoAt } = {}) {
  articleModel.insert({
    article: { articleId, title: '제목', markupVersion: '{"blocks":[{"text":"본문 (끝)"}]}' },
    contents: {
      articleId, title: '제목', author: 'r1', status,
      createdAt: '2026-07-28T00:00:00.000Z', sentAt: BEFORE,
      ...(embargoAt ? { embargoAt } : {}),
      ...(secondEmbargoAt ? { secondEmbargoAt } : {}),
    },
  });
}

const statusOf = (db, id) => db.prepare('SELECT status FROM Contents WHERE articleId = ?').get(id).status;
const historyOf = (db, id) => db.prepare('SELECT * FROM ArticleHistory WHERE articleId = ? ORDER BY id').all(id);
const countRows = (db, table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

test('노출 메서드는 tick 뿐이다(타이머·주기 실행 진입점 없음)', () => {
  const { service } = setup();
  assert.deepEqual(Object.keys(service).sort(), ['tick']);
});

test('1차 엠바고 도래: press 배부 후 EPS→DPS 전이 + embargoComplete 이력', async () => {
  const { service, distributionService, articleModel, db } = setup({ now: BETWEEN });
  addArticle(articleModel, 'AKR1', { embargoAt: T1 });

  const r = await service.tick({ actorUserId: 'admin1' });

  assert.equal(r.ok, true);
  assert.deepEqual(distributionService.calls, [{ articleId: 'AKR1', kinds: ['press'], actorUserId: 'admin1' }]);
  assert.equal(statusOf(db, 'AKR1'), 'DPS');

  const hist = historyOf(db, 'AKR1');
  assert.deepEqual(hist.map((h) => `${h.eventType}:${h.action}`), ['distribute:press', 'status:embargoComplete']);
  const done = hist.at(-1);
  assert.equal(done.fromStatus, 'EPS');
  assert.equal(done.toStatus, 'DPS');
  assert.equal(done.actorUserId, 'admin1');
  assert.deepEqual(r.completed, ['AKR1']);
});

test('시각 미도래: 배부·전이·이력이 전부 0', async () => {
  const { service, distributionService, articleModel, db } = setup({ now: BEFORE });
  addArticle(articleModel, 'AKR1', { embargoAt: T1, secondEmbargoAt: T2 });

  const r = await service.tick();

  assert.equal(distributionService.calls.length, 0);
  assert.equal(statusOf(db, 'AKR1'), 'EPS');
  assert.equal(historyOf(db, 'AKR1').length, 0);
  assert.deepEqual(r.completed, []);
});

test('1+2차: 1차만 지나면 press만 배부하고 EPS 유지, 2차 시각에 nonpress 배부 후 DPS', async () => {
  const { service, distributionService, articleModel, db, setNow } = setup({ now: BETWEEN });
  addArticle(articleModel, 'AKR1', { embargoAt: T1, secondEmbargoAt: T2 });

  await service.tick({ actorUserId: 'admin1' });
  assert.deepEqual(distributionService.calls.at(-1).kinds, ['press']);
  assert.equal(statusOf(db, 'AKR1'), 'EPS', '2차가 남았으므로 아직 완결이 아니다');

  setNow(AFTER);
  const r2 = await service.tick({ actorUserId: 'admin1' });

  assert.deepEqual(distributionService.calls.at(-1).kinds, ['nonpress'], '이미 배부한 press는 다시 보내지 않는다');
  assert.equal(statusOf(db, 'AKR1'), 'DPS');
  assert.deepEqual(r2.completed, ['AKR1']);
});

test('2차만 설정: 송고 시 press 이력이 있는 기사에 nonpress만 배부하고 DPS 전이', async () => {
  const { service, distributionService, articleModel, historyModel, db } = setup({ now: AFTER });
  addArticle(articleModel, 'AKR1', { secondEmbargoAt: T2 });
  // phase 47 송고 훅이 남긴 언론사 배부 이력.
  historyModel.insert({ articleId: 'AKR1', eventType: 'distribute', action: 'press', createdAt: BEFORE });

  const r = await service.tick();

  assert.deepEqual(distributionService.calls, [{ articleId: 'AKR1', kinds: ['nonpress'], actorUserId: null }]);
  assert.equal(statusOf(db, 'AKR1'), 'DPS');
  assert.deepEqual(r.completed, ['AKR1']);
});

test('2차만 설정 + 송고 시 press 실패: nonpress를 배부해도 미완결(EPS 유지)이며 요약에 드러난다', async () => {
  const { service, articleModel, db } = setup({ now: AFTER });
  addArticle(articleModel, 'AKR1', { secondEmbargoAt: T2 }); // press 이력 없음

  const r = await service.tick();

  assert.equal(statusOf(db, 'AKR1'), 'EPS', '언론사 배부 사실이 없으면 완결이 아니다(거짓 완결 금지)');
  assert.deepEqual(r.completed, []);
  assert.deepEqual(r.incomplete, [{ articleId: 'AKR1', missing: ['press'] }]);
});

test('멱등성: 같은 시각으로 두 번 호출해도 재배부 0, 상태·이력 불변', async () => {
  const { service, distributionService, articleModel, db } = setup({ now: BETWEEN });
  addArticle(articleModel, 'AKR1', { embargoAt: T1, secondEmbargoAt: T2 });

  await service.tick();
  const afterFirst = historyOf(db, 'AKR1').length;
  const contentsRows = countRows(db, 'Contents');

  const r2 = await service.tick();

  assert.equal(distributionService.calls.length, 1, '2회차는 배부하지 않는다');
  assert.equal(historyOf(db, 'AKR1').length, afterFirst, '이력이 중복 append되지 않는다');
  assert.equal(countRows(db, 'Contents'), contentsRows);
  assert.equal(statusOf(db, 'AKR1'), 'EPS');
  assert.deepEqual(r2.completed, []);
});

test('완결 전이도 멱등: DPS가 된 기사는 다음 tick의 대상이 아니다', async () => {
  const { service, distributionService, articleModel, db } = setup({ now: BETWEEN });
  addArticle(articleModel, 'AKR1', { embargoAt: T1 });

  await service.tick();
  const histLen = historyOf(db, 'AKR1').length;

  const r2 = await service.tick();

  assert.equal(distributionService.calls.length, 1);
  assert.equal(historyOf(db, 'AKR1').length, histLen, 'embargoComplete 이력이 두 번 쌓이지 않는다');
  assert.equal(r2.checkedCount, 0);
});

test('자가 치유: 배부 이력이 이미 다 있으면 배부 없이도 완결 전이한다', async () => {
  // 이전 tick이 이력까지 남기고 전이 직전에 중단된 상황 — 배부할 pending은 0이다.
  const { service, distributionService, articleModel, historyModel, db } = setup({ now: AFTER });
  addArticle(articleModel, 'AKR1', { embargoAt: T1, secondEmbargoAt: T2 });
  historyModel.insert({ articleId: 'AKR1', eventType: 'distribute', action: 'press', createdAt: T1 });
  historyModel.insert({ articleId: 'AKR1', eventType: 'distribute', action: 'nonpress', createdAt: T2 });

  const r = await service.tick();

  assert.equal(distributionService.calls.length, 0, '배부할 것이 없다');
  assert.equal(statusOf(db, 'AKR1'), 'DPS', '그래도 전이는 이뤄져야 한다(영구 EPS 고착 방지)');
  assert.deepEqual(r.completed, ['AKR1']);
  assert.deepEqual(r.distributed, []);
});

test('배부 실패: 이력이 없으므로 완결도 전이도 없고 요약에 실패가 남는다', async () => {
  const { service, articleModel, db } = setup({ now: BETWEEN, distributionOpts: { fail: true } });
  addArticle(articleModel, 'AKR1', { embargoAt: T1 });

  const r = await service.tick();

  assert.equal(statusOf(db, 'AKR1'), 'EPS');
  assert.deepEqual(r.completed, []);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].articleId, 'AKR1');
  assert.equal(r.failed[0].reason, 'spool-write-failed');
  assert.deepEqual(historyOf(db, 'AKR1'), [], '거짓 배부 이력을 만들지 않는다');
});

test('대상 스코프: EEH·EEK·DPS·RDS 기사는 시각이 지나도 배부·전이 대상이 아니다', async () => {
  const { service, distributionService, articleModel, db } = setup({ now: AFTER });
  addArticle(articleModel, 'HOLD', { status: 'EEH', embargoAt: T1, secondEmbargoAt: T2 });
  addArticle(articleModel, 'KILL', { status: 'EEK', embargoAt: T1 });
  addArticle(articleModel, 'SENT', { status: 'DPS', embargoAt: T1 });
  addArticle(articleModel, 'DRAFT', { status: 'RDS', embargoAt: T1 });

  const r = await service.tick();

  assert.equal(distributionService.calls.length, 0);
  assert.equal(r.checkedCount, 0);
  for (const [id, status] of [['HOLD', 'EEH'], ['KILL', 'EEK'], ['SENT', 'DPS'], ['DRAFT', 'RDS']]) {
    assert.equal(statusOf(db, id), status, `${id} 상태 불변`);
    assert.equal(historyOf(db, id).length, 0);
  }
});

test('한 기사의 예외가 다른 기사의 배부를 막지 않는다', async () => {
  const { service, articleModel, db } = setup({ now: BETWEEN, distributionOpts: { throwOn: 'AKR1' } });
  addArticle(articleModel, 'AKR1', { embargoAt: T1 });
  addArticle(articleModel, 'AKR2', { embargoAt: T1 });

  const r = await service.tick();

  assert.equal(r.ok, true, 'tick 자체는 throw하지 않는다');
  assert.equal(statusOf(db, 'AKR1'), 'EPS');
  assert.equal(statusOf(db, 'AKR2'), 'DPS', '뒤 기사는 정상 처리된다');
  assert.equal(r.failed.some((f) => f.articleId === 'AKR1'), true);
});

test('엠바고 시각이 없는 EPS 기사는 배부·전이 대상이 아니다', async () => {
  const { service, distributionService, articleModel, db } = setup({ now: AFTER });
  addArticle(articleModel, 'AKR1', {}); // embargoAt/secondEmbargoAt 모두 없음

  const r = await service.tick();

  assert.equal(distributionService.calls.length, 0);
  assert.equal(statusOf(db, 'AKR1'), 'EPS');
  assert.deepEqual(r.completed, []);
});

test('배부 비활성(distributionService 미주입): spool-disabled로 거부하고 DB를 건드리지 않는다', async () => {
  const { service, articleModel, db } = setup({ now: AFTER, withService: false });
  addArticle(articleModel, 'AKR1', { embargoAt: T1 });

  const r = await service.tick();

  assert.deepEqual(r, { ok: false, reason: 'spool-disabled' });
  assert.equal(statusOf(db, 'AKR1'), 'EPS');
  assert.equal(historyOf(db, 'AKR1').length, 0);
});

test('DB 비파괴: tick 전후 Article/Contents 행 수와 기존 이력이 보존된다', async () => {
  const { service, articleModel, historyModel, db } = setup({ now: AFTER });
  addArticle(articleModel, 'AKR1', { embargoAt: T1, secondEmbargoAt: T2 });
  addArticle(articleModel, 'AKR2', { status: 'EEK', embargoAt: T1 });
  historyModel.insert({ articleId: 'AKR1', eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'EPS', createdAt: BEFORE });

  const before = {
    article: countRows(db, 'Article'),
    contents: countRows(db, 'Contents'),
    history: countRows(db, 'ArticleHistory'),
  };

  await service.tick();
  await service.tick();

  assert.equal(countRows(db, 'Article'), before.article);
  assert.equal(countRows(db, 'Contents'), before.contents);
  assert.equal(countRows(db, 'ArticleHistory') >= before.history, true, '이력은 append만 된다');
  const sendRow = historyOf(db, 'AKR1').find((h) => h.action === 'send');
  assert.equal(sendRow.toStatus, 'EPS', '기존 송고 이력이 보존된다');
});

test('완결 전이는 status만 present-only로 쓴다(sentAt·distributedAt·본문 불변)', async () => {
  const { service, articleModel, db } = setup({ now: BETWEEN });
  addArticle(articleModel, 'AKR1', { embargoAt: T1 });
  const before = db.prepare('SELECT * FROM Contents WHERE articleId = ?').get('AKR1');

  await service.tick();

  const after = db.prepare('SELECT * FROM Contents WHERE articleId = ?').get('AKR1');
  assert.equal(after.status, 'DPS');
  assert.equal(after.sentAt, before.sentAt);
  assert.equal(after.distributedAt, before.distributedAt, 'distributedAt은 배부 서비스만 기록한다');
  assert.equal(after.embargoAt, before.embargoAt);
  assert.equal(
    db.prepare('SELECT markupVersion FROM Article WHERE articleId = ?').get('AKR1').markupVersion,
    '{"blocks":[{"text":"본문 (끝)"}]}',
  );
});

test('요약: 확인 건수·배부·완결·미완결·실패를 호출자에게 보고한다', async () => {
  const { service, articleModel, historyModel } = setup({ now: AFTER });
  addArticle(articleModel, 'DUE', { embargoAt: T1 });
  addArticle(articleModel, 'PARTIAL', { embargoAt: T1, secondEmbargoAt: '2099-01-01T00:00:00.000Z' });
  historyModel.insert({ articleId: 'PARTIAL', eventType: 'distribute', action: 'press', createdAt: T1 });

  const r = await service.tick();

  assert.equal(r.checkedCount, 2);
  assert.deepEqual(r.distributed, [{ articleId: 'DUE', kinds: ['press'] }]);
  assert.deepEqual(r.completed, ['DUE']);
  assert.deepEqual(r.incomplete, [{ articleId: 'PARTIAL', missing: ['nonpress'] }]);
  assert.deepEqual(r.failed, []);
});

// --- 테스트 단계 보강: 운영 오설정·경계 시각 ---

test('수신처가 0개면 배부 사실이 없으므로 EPS를 유지하고 미완결로 보고한다(설정 오류 표면화)', async () => {
  // distributionService는 대상이 없어도 ok:true/빈 결과를 준다 — 이력이 없으니 완결이 아니다.
  const { service, articleModel, db } = setup({ now: BETWEEN, distributionOpts: { fail: true } });
  addArticle(articleModel, 'AKR1', { embargoAt: T1 });

  const r = await service.tick();

  assert.equal(statusOf(db, 'AKR1'), 'EPS', '아무 데도 안 나갔는데 DPS로 올리면 거짓이다');
  assert.deepEqual(r.incomplete, [{ articleId: 'AKR1', missing: ['press'] }]);
});

test('경계 시각: 엠바고 시각과 정확히 같은 순간에 배부된다', async () => {
  const { service, distributionService, articleModel } = setup({ now: T1 });
  addArticle(articleModel, 'AKR1', { embargoAt: T1 });

  await service.tick();

  assert.deepEqual(distributionService.calls.at(-1).kinds, ['press']);
});

test('파싱 불가한 엠바고 값은 배부되지 않는다(판정 불가 → 보수적으로 보류)', async () => {
  const { service, distributionService, articleModel, db } = setup({ now: AFTER });
  addArticle(articleModel, 'AKR1', { embargoAt: '즉시' });
  addArticle(articleModel, 'AKR2', { embargoAt: '2026/07/28 05:00 KST말고' });

  const r = await service.tick();

  assert.equal(distributionService.calls.length, 0);
  assert.equal(statusOf(db, 'AKR1'), 'EPS');
  assert.equal(statusOf(db, 'AKR2'), 'EPS');
  assert.deepEqual(r.completed, []);
});

test('여러 기사 혼재: 도래·미도래·완결 대기가 한 tick에서 각각 올바르게 처리된다', async () => {
  const { service, articleModel, historyModel, db } = setup({ now: BETWEEN });
  addArticle(articleModel, 'DUE', { embargoAt: T1 });                       // 1차 도래 → 배부+완결
  addArticle(articleModel, 'LATER', { embargoAt: T2 });                     // 미도래
  addArticle(articleModel, 'BOTH', { embargoAt: T1, secondEmbargoAt: T2 }); // 1차만 도래 → 미완결
  addArticle(articleModel, 'HEAL', { embargoAt: T1 });                      // 이력만 있고 전이 밀림
  historyModel.insert({ articleId: 'HEAL', eventType: 'distribute', action: 'press', createdAt: T1 });

  const r = await service.tick();

  assert.equal(r.checkedCount, 4);
  assert.deepEqual(r.completed.sort(), ['DUE', 'HEAL']);
  assert.equal(statusOf(db, 'LATER'), 'EPS');
  assert.equal(statusOf(db, 'BOTH'), 'EPS');
  assert.deepEqual(
    r.incomplete.map((i) => `${i.articleId}:${i.missing.join('+')}`).sort(),
    ['BOTH:nonpress', 'LATER:press'],
  );
});

// --- 리뷰 반영: 배부 await 중 상태가 바뀌는 경합(TOCTOU) ---
// tick은 EPS 목록을 스냅샷으로 읽고, 스풀 쓰기(await) 동안 HTTP 핸들러가 끼어들 수 있다.
// 그 사이 데스크가 KILL/보류하면 스냅샷의 'EPS'로 전이 판정을 하면 안 된다(킬된 기사 부활 금지).

test('배부 중 데스크가 KILL하면 완결 전이하지 않는다(스냅샷 status로 판정 금지)', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  addArticle(articleModel, 'AKR1', { embargoAt: T1 });

  // 배부(await) 도중 다른 요청이 EPS→EEK로 바꾼 상황을 재현한다.
  const distributionService = {
    async distribute(articleId, { kinds }) {
      articleModel.update(articleId, { contents: { status: 'EEK' } });
      for (const kind of kinds) {
        historyModel.insert({ articleId, eventType: 'distribute', action: kind, createdAt: T1 });
      }
      return { ok: true, distributed: kinds.map((k) => ({ targetId: 1, kind: k })), failed: [] };
    },
  };
  const service = createDistributionTickService({
    articleModel, historyModel, distributionService, now: () => BETWEEN,
  });

  const r = await service.tick();

  assert.equal(statusOf(db, 'AKR1'), 'EEK', 'KILL된 기사를 DPS로 되살리면 안 된다');
  assert.deepEqual(r.completed, []);
  assert.equal(historyOf(db, 'AKR1').some((h) => h.action === 'embargoComplete'), false);
});

test('배부 중 기사가 사라져도 tick이 깨지지 않는다', async () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  addArticle(articleModel, 'AKR1', { embargoAt: T1 });

  const distributionService = {
    async distribute(articleId, { kinds }) {
      // 기사 조회가 비는 상황(이론적 경계)을 흉내낸다 — 행 삭제가 아니라 조회 실패 경로 방어 확인.
      db.prepare('UPDATE Contents SET articleId = ? WHERE articleId = ?').run('OTHER', articleId);
      for (const kind of kinds) {
        historyModel.insert({ articleId, eventType: 'distribute', action: kind, createdAt: T1 });
      }
      return { ok: true, distributed: kinds.map((k) => ({ targetId: 1, kind: k })), failed: [] };
    },
  };
  const service = createDistributionTickService({
    articleModel, historyModel, distributionService, now: () => BETWEEN,
  });

  const r = await service.tick();

  assert.equal(r.ok, true);
  assert.deepEqual(r.completed, []);
});
