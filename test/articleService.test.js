import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createArticleService } from '../src/services/articleService.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const service = createArticleService({ articleModel, db });
  return { db, articleModel, service };
}

// syncEmbargoStatus는 배부 이력을 읽으므로 historyModel이 필요하다.
function setupWithHistory() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const service = createArticleService({ articleModel, db, historyModel });
  return { db, articleModel, historyModel, service };
}

const END = '(끝)';
// "(끝)" 마커 유무를 가진 본문 블록 JSON.
function markup(text, withEnd = false) {
  const blocks = [{ type: 'text', text }];
  if (withEnd) blocks.push({ type: 'text', text: END });
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}

test('create: status RDS로 저장하고 AKR 아이디를 생성한다', () => {
  const { service, articleModel } = setup();
  const r = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim', department: '정치부' });
  assert.equal(r.ok, true);
  assert.match(r.articleId, /^AKR\d{17}$/);
  const row = articleModel.getById(r.articleId);
  assert.equal(row.contents.status, 'RDS');
  assert.equal(row.contents.author, 'kim');
  assert.equal(row.contents.department, '정치부');
  assert.ok(row.contents.createdAt, 'createdAt이 설정된다');
  assert.equal(row.article.title, '제목');
});

test('create: 최초 보류(hold)는 권한별로 결정한다 ((Z|D)→DDH, R→RRH)', () => {
  const { service, articleModel } = setup();
  const zHold = service.create({ title: '제목', markupVersion: markup('본문'), author: 'admin' }, { role: 'Z', action: 'hold' });
  const dHold = service.create({ title: '제목', markupVersion: markup('본문'), author: 'desk' }, { role: 'D', action: 'hold' });
  const rHold = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' }, { role: 'R', action: 'hold' });
  assert.equal(articleModel.getById(zHold.articleId).contents.status, 'DDH');
  assert.equal(articleModel.getById(dHold.articleId).contents.status, 'DDH');
  assert.equal(articleModel.getById(rHold.articleId).contents.status, 'RRH');
});

test('create: 최초 송고·옵션 없음은 모두 RDS를 유지한다 (회귀 가드)', () => {
  const { service, articleModel } = setup();
  const zSend = service.create({ title: 'a', author: 'admin' }, { role: 'Z', action: 'send' });
  const rSend = service.create({ title: 'b', author: 'kim' }, { role: 'R', action: 'send' });
  const noOpts = service.create({ title: 'd', author: 'kim' }); // deriveArticle 등 기존 호출 경로
  assert.equal(articleModel.getById(zSend.articleId).contents.status, 'RDS');
  assert.equal(articleModel.getById(rSend.articleId).contents.status, 'RDS');
  assert.equal(articleModel.getById(noOpts.articleId).contents.status, 'RDS');
});

test('create: 공통정보 필드를 Contents에 조립해 저장한다', () => {
  const { service, articleModel } = setup();
  const r = service.create({
    title: '제목', author: 'kim',
    coAuthor: 'lee', category: '정치일반', region: '서울', attribute: '자동기사',
    keyword: '경제', embargoAt: '2026-06-20T00:00:00.000Z',
  });
  const c = articleModel.getById(r.articleId).contents;
  assert.equal(c.coAuthor, 'lee');
  assert.equal(c.category, '정치일반');
  assert.equal(c.region, '서울');
  assert.equal(c.attribute, '자동기사');
  assert.equal(c.keyword, '경제');
  assert.equal(c.embargoAt, '2026-06-20T00:00:00.000Z');
});

test('update: category를 부분 갱신하고, 미전달이면 기존 값을 보존한다', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({ title: '제목', author: 'kim', category: '정치일반' });
  service.update(articleId, { category: '경제일반' });
  assert.equal(articleModel.getById(articleId).contents.category, '경제일반');
  service.update(articleId, { region: '부산' });
  const c = articleModel.getById(articleId).contents;
  assert.equal(c.category, '경제일반', '미전달 category는 건드리지 않는다');
  assert.equal(c.region, '부산');
});

test('update: Article/Contents를 부분 갱신한다', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  const r = service.update(articleId, { title: '수정', region: '부산' });
  assert.equal(r.ok, true);
  const row = articleModel.getById(articleId);
  assert.equal(row.article.title, '수정');
  assert.equal(row.contents.title, '수정');
  assert.equal(row.contents.region, '부산');
  assert.equal(row.contents.author, 'kim', '미지정 필드는 보존');
});

test('update: status는 변경하지 않는다 (전이는 applyAction 전용)', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({ title: '제목' });
  service.update(articleId, { status: 'DPS', title: '수정' });
  assert.equal(articleModel.getById(articleId).contents.status, 'RDS');
});

test('query/search: 모델에 위임한다', () => {
  const { service } = setup();
  service.create({ title: '경제 뉴스', markupVersion: markup('금리 인상'), author: 'kim', department: '경제부' });
  service.create({ title: '정치 뉴스', markupVersion: markup('국회'), author: 'park', department: '정치부' });

  const byAuthor = service.query({ author: 'kim' });
  assert.equal(byAuthor.length, 1);
  assert.equal(byAuthor[0].author, 'kim');

  const found = service.search('금리');
  assert.equal(found.length, 1);
  assert.equal(found[0].title, '경제 뉴스');
});

test('applyAction: D가 RDS 기사를 송고("(끝)" 포함)하면 DPS로 전이하고 송고자/송고시간을 기록한다', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.deepEqual(r, { ok: true, status: 'DPS' });
  const c = articleModel.getById(articleId).contents;
  assert.equal(c.status, 'DPS');
  assert.equal(c.sender, 'desk');
  assert.ok(c.sentAt, 'sentAt이 기록된다');
});

test('applyAction: "(끝)" 없이 송고하면 거부하고 status를 바꾸지 않는다', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-end-marker');
  assert.equal(articleModel.getById(articleId).contents.status, 'RDS');
});

test('applyAction: 보류/KILL은 "(끝)" 없이도 진행된다', () => {
  const { service } = setup();
  const a = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  assert.deepEqual(service.applyAction(a.articleId, 'R', 'hold', { sessionId: 's1' }), { ok: true, status: 'RRH' });

  const b = service.create({ title: '제목2', markupVersion: markup('본문'), author: 'kim' });
  assert.deepEqual(service.applyAction(b.articleId, 'R', 'kill', { sessionId: 's1' }), { ok: true, status: 'RRK' });
});

test('applyAction: R이 RDS 기사를 송고("(끝)" 포함)하면 RDS를 유지한다', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  const r = service.applyAction(articleId, 'R', 'send', { userId: 'kim', sessionId: 's1' });
  assert.deepEqual(r, { ok: true, status: 'RDS' });
  assert.equal(articleModel.getById(articleId).contents.status, 'RDS');
});

test('applyAction: 엠바고 설정된 RDS 기사를 D가 송고하면 DES로 진입한다 (sender/sentAt 기록)', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({
    title: '제목', markupVersion: markup('본문', true), author: 'kim',
    embargoAt: '2026-06-25T09:00:00.000Z',
  });
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.deepEqual(r, { ok: true, status: 'DES' });
  const c = articleModel.getById(articleId).contents;
  assert.equal(c.status, 'DES');
  assert.equal(c.sender, 'desk');
  assert.ok(c.sentAt, 'sentAt이 기록된다');
});

test('applyAction: 2차 엠바고만 설정돼도 RDS→DES, Z 송고도 동일', () => {
  // 이 setup은 distributionService 미주입이라 배부 훅이 비활성이다 — DES→EPS 승격도 일어나지 않는다.
  const { service, articleModel } = setup();
  const a = service.create({
    title: '제목', markupVersion: markup('본문', true), author: 'kim',
    secondEmbargoAt: '2026-06-26T09:00:00.000Z',
  });
  assert.deepEqual(service.applyAction(a.articleId, 'Z', 'send', { userId: 'admin' }), { ok: true, status: 'DES' });
  assert.equal(articleModel.getById(a.articleId).contents.status, 'DES');
});

test('applyAction: 엠바고 미설정 RDS 기사를 D가 송고하면 DPS를 유지한다 (회귀 보존)', () => {
  const { service, articleModel } = setup();
  const empty = service.create({ title: '빈엠바고', markupVersion: markup('본문', true), author: 'kim', embargoAt: '', secondEmbargoAt: '' });
  assert.deepEqual(service.applyAction(empty.articleId, 'D', 'send', { userId: 'desk' }), { ok: true, status: 'DPS' });
  assert.equal(articleModel.getById(empty.articleId).contents.status, 'DPS');
});

test('applyAction: 엠바고 설정된 RDS라도 R 송고는 RDS 유지 (DES 진입은 D/Z 한정)', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({
    title: '제목', markupVersion: markup('본문', true), author: 'kim',
    embargoAt: '2026-06-25T09:00:00.000Z',
  });
  assert.deepEqual(service.applyAction(articleId, 'R', 'send', { userId: 'kim' }), { ok: true, status: 'RDS' });
  assert.equal(articleModel.getById(articleId).contents.status, 'RDS');
});

test('applyAction: 엠바고 설정된 DDH 기사를 D가 송고해도 DES로 진입한다 (DDH 경로 누수 방어)', () => {
  const { service, articleModel } = setup();
  // D 최초 보류 → DDH, 엠바고 설정.
  const { articleId } = service.create({
    title: '제목', markupVersion: markup('본문', true), author: 'desk',
    embargoAt: '2026-06-25T09:00:00.000Z',
  }, { role: 'D', action: 'hold' });
  assert.equal(articleModel.getById(articleId).contents.status, 'DDH');
  assert.deepEqual(service.applyAction(articleId, 'D', 'send', { userId: 'desk' }), { ok: true, status: 'DES' });
  assert.equal(articleModel.getById(articleId).contents.status, 'DES');
});

test('applyAction: 엠바고 설정된 DPS 기사의 재송고는 DPS를 유지한다 (DES 되돌림 금지)', () => {
  // 이미 배부 이력이 있는 기사를 DES로 되돌리면 tick의 "미배부" 판정에 걸리지 않아 영구 고착된다.
  const { service, articleModel } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk' }); // RDS → DPS(엠바고 미설정)
  service.update(articleId, { embargoAt: '2026-06-25T09:00:00.000Z' });
  assert.deepEqual(service.applyAction(articleId, 'D', 'send', { userId: 'desk' }), { ok: true, status: 'DPS' });
  assert.equal(articleModel.getById(articleId).contents.status, 'DPS');
});

test('applyAction: DES 기사를 D가 KILL하면 EEK, 보류하면 EEH', () => {
  const { service, articleModel } = setup();
  const mkDes = () => {
    const a = service.create({
      title: '제목', markupVersion: markup('본문', true), author: 'kim',
      embargoAt: '2026-06-25T09:00:00.000Z',
    });
    service.applyAction(a.articleId, 'D', 'send', { userId: 'desk' }); // RDS → DES
    assert.equal(articleModel.getById(a.articleId).contents.status, 'DES');
    return a.articleId;
  };
  const killId = mkDes();
  assert.deepEqual(service.applyAction(killId, 'D', 'kill', { userId: 'desk' }), { ok: true, status: 'EEK' });
  assert.equal(articleModel.getById(killId).contents.status, 'EEK');

  const holdId = mkDes();
  assert.deepEqual(service.applyAction(holdId, 'D', 'hold', { userId: 'desk' }), { ok: true, status: 'EEH' });
  assert.equal(articleModel.getById(holdId).contents.status, 'EEH');
});

test('applyAction: 레거시 EPS 행도 KILL→EEK·보류→EEH가 유지된다 (마이그레이션 없음)', () => {
  // 기존 EPS 행은 DES로 바꾸지 않는다(사용자 확정 스펙 A.5) — 모델로 직접 주입해 레거시 행을 재현한다.
  const { service, articleModel } = setup();
  const mkLegacyEps = () => {
    const a = service.create({
      title: '제목', markupVersion: markup('본문', true), author: 'kim',
      embargoAt: '2026-06-25T09:00:00.000Z',
    });
    articleModel.update(a.articleId, { contents: { status: 'EPS' } });
    return a.articleId;
  };
  const killId = mkLegacyEps();
  assert.deepEqual(service.applyAction(killId, 'D', 'kill', { userId: 'desk' }), { ok: true, status: 'EEK' });
  assert.equal(articleModel.getById(killId).contents.status, 'EEK');

  const holdId = mkLegacyEps();
  assert.deepEqual(service.applyAction(holdId, 'D', 'hold', { userId: 'desk' }), { ok: true, status: 'EEH' });
  assert.equal(articleModel.getById(holdId).contents.status, 'EEH');
});

test('applyAction: DES 기사 재송고(send)는 거부하고 status를 유지한다', () => {
  const { service, articleModel } = setup();
  const a = service.create({
    title: '제목', markupVersion: markup('본문', true), author: 'kim',
    embargoAt: '2026-06-25T09:00:00.000Z',
  });
  service.applyAction(a.articleId, 'D', 'send', { userId: 'desk' }); // RDS → DES
  const r = service.applyAction(a.articleId, 'D', 'send', { userId: 'desk' }); // DES + send = 거부
  assert.equal(r.ok, false);
  assert.equal(articleModel.getById(a.articleId).contents.status, 'DES');
});

test('applyAction: 레거시 EPS 기사 재송고(send)도 거부하고 status를 유지한다', () => {
  const { service, articleModel } = setup();
  const a = service.create({
    title: '제목', markupVersion: markup('본문', true), author: 'kim',
    embargoAt: '2026-06-25T09:00:00.000Z',
  });
  articleModel.update(a.articleId, { contents: { status: 'EPS' } });
  const r = service.applyAction(a.articleId, 'D', 'send', { userId: 'desk' }); // EPS + send = 거부
  assert.equal(r.ok, false);
  assert.equal(articleModel.getById(a.articleId).contents.status, 'EPS');
});

test('applyAction: D가 DPS 기사를 삭제승인하면 DPD로 전이한다 (행 삭제 아님)', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' }); // RDS → DPS
  const r = service.applyAction(articleId, 'D', 'approveDelete', { userId: 'desk', sessionId: 's1' });
  assert.deepEqual(r, { ok: true, status: 'DPD' });
  assert.ok(articleModel.getById(articleId), '행은 그대로 존재 (비파괴)');
});

test('applyAction: 정의되지 않은 전이는 거부하고 status를 유지한다', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' }); // RDS → DPS
  const r = service.applyAction(articleId, 'R', 'send', { sessionId: 's2' });        // DPS + R = 거부
  assert.equal(r.ok, false);
  assert.equal(articleModel.getById(articleId).contents.status, 'DPS');
});

test('applyAction: 존재하지 않는 기사는 not-found', () => {
  const { service } = setup();
  const r = service.applyAction('AKR000', 'D', 'send', { sessionId: 's1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-found');
});

// ── syncEmbargoStatus — 배부 사실을 상태에 반영한다(사람의 액션이 아니므로 transition을 거치지 않는다) ──

// 엠바고 기사를 만들고 지정한 상태로 둔다(전이 경로와 무관하게 픽스처를 고정한다).
function seedEmbargo(ctx, contents, status) {
  const { articleId } = ctx.service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim', ...contents });
  ctx.articleModel.update(articleId, { contents: { status, sender: 'desk', sentAt: '2026-07-28T00:00:00.000Z' } });
  return articleId;
}
const distHist = (ctx, articleId, kind) => ctx.historyModel.insert({ articleId, eventType: 'distribute', action: kind, createdAt: '2026-07-28T01:00:00.000Z' });

test('syncEmbargoStatus: 배부 이력만으로 승격한다(extraKinds 없이 — tick의 self-heal 경로)', () => {
  const ctx = setupWithHistory();
  const articleId = seedEmbargo(ctx, { secondEmbargoAt: '2026-07-29T00:00:00.000Z' }, 'DES');
  distHist(ctx, articleId, 'press');

  assert.deepEqual(ctx.service.syncEmbargoStatus(articleId), { ok: true, status: 'EPS' });
  assert.equal(ctx.articleModel.getById(articleId).contents.status, 'EPS');
});

test('syncEmbargoStatus: 이력이 아직 없어도 extraKinds 힌트로 승격한다(이력 기록 실패 보정)', () => {
  const ctx = setupWithHistory();
  const articleId = seedEmbargo(ctx, { secondEmbargoAt: '2026-07-29T00:00:00.000Z' }, 'DES');

  assert.deepEqual(ctx.service.syncEmbargoStatus(articleId, { extraKinds: ['press'] }), { ok: true, status: 'EPS' });
  assert.equal(ctx.articleModel.getById(articleId).contents.status, 'EPS');
});

test('syncEmbargoStatus: 이력 ∪ extraKinds 합집합으로 완결을 판정한다 (1+2차 → DPS)', () => {
  const ctx = setupWithHistory();
  const articleId = seedEmbargo(ctx, {
    embargoAt: '2026-07-29T00:00:00.000Z', secondEmbargoAt: '2026-07-30T00:00:00.000Z',
  }, 'EPS');
  distHist(ctx, articleId, 'press');

  assert.deepEqual(ctx.service.syncEmbargoStatus(articleId, { extraKinds: ['nonpress'] }), { ok: true, status: 'DPS' });
  assert.equal(ctx.articleModel.getById(articleId).contents.status, 'DPS');
});

test('syncEmbargoStatus: status만 쓰고 송고자/송고시간·본문·행 수는 건드리지 않는다(present-only)', () => {
  const ctx = setupWithHistory();
  const articleId = seedEmbargo(ctx, { secondEmbargoAt: '2026-07-29T00:00:00.000Z' }, 'DES');
  const before = ctx.articleModel.getById(articleId);
  const counts = () => ({
    contents: ctx.db.prepare('SELECT COUNT(*) AS n FROM Contents').get().n,
    article: ctx.db.prepare('SELECT COUNT(*) AS n FROM Article').get().n,
  });
  const countsBefore = counts();

  ctx.service.syncEmbargoStatus(articleId, { extraKinds: ['press'], actorUserId: 'tick' });

  const after = ctx.articleModel.getById(articleId);
  assert.equal(after.contents.status, 'EPS');
  assert.equal(after.contents.sender, before.contents.sender);
  assert.equal(after.contents.sentAt, before.contents.sentAt);
  assert.equal(after.contents.editedAt, before.contents.editedAt);
  assert.equal(after.article.markupVersion, before.article.markupVersion);
  assert.deepEqual(counts(), countsBefore);
});

test('syncEmbargoStatus: 상태가 실제로 바뀔 때만 이력 1건을 남긴다(멱등 재호출은 쓰기 0건)', () => {
  const ctx = setupWithHistory();
  const articleId = seedEmbargo(ctx, { secondEmbargoAt: '2026-07-29T00:00:00.000Z' }, 'DES');

  assert.deepEqual(ctx.service.syncEmbargoStatus(articleId, { extraKinds: ['press'], actorUserId: 'tick' }), { ok: true, status: 'EPS' });
  assert.deepEqual(ctx.service.syncEmbargoStatus(articleId, { extraKinds: ['press'], actorUserId: 'tick' }), { ok: true, status: 'EPS' });

  const rows = ctx.service.queryHistory(articleId).filter((r) => r.eventType === 'status');
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].action, rows[0].fromStatus, rows[0].toStatus, rows[0].actorUserId],
    ['embargo', 'DES', 'EPS', 'tick'],
  );
});

test('syncEmbargoStatus: 엠바고 미설정 기사는 쓰기 0건이다(자동 승격 없음)', () => {
  const ctx = setupWithHistory();
  const articleId = seedEmbargo(ctx, {}, 'DES');

  assert.deepEqual(ctx.service.syncEmbargoStatus(articleId, { extraKinds: ['press', 'nonpress'] }), { ok: true, status: 'DES' });
  assert.equal(ctx.articleModel.getById(articleId).contents.status, 'DES');
  assert.equal(ctx.service.queryHistory(articleId).filter((r) => r.eventType === 'status').length, 0);
});

test('syncEmbargoStatus: DES/EPS가 아닌 상태는 절대 바꾸지 않는다', () => {
  for (const status of ['RDS', 'DPS', 'EEK', 'EEH', 'DPD']) {
    const ctx = setupWithHistory();
    const articleId = seedEmbargo(ctx, { embargoAt: '2026-07-29T00:00:00.000Z' }, status);

    assert.deepEqual(ctx.service.syncEmbargoStatus(articleId, { extraKinds: ['press'] }), { ok: true, status }, status);
    assert.equal(ctx.articleModel.getById(articleId).contents.status, status, status);
    assert.equal(ctx.service.queryHistory(articleId).filter((r) => r.eventType === 'status').length, 0, status);
  }
});

test('syncEmbargoStatus: 존재하지 않는 기사는 not-found', () => {
  const ctx = setupWithHistory();
  assert.deepEqual(ctx.service.syncEmbargoStatus('AKR000'), { ok: false, reason: 'not-found' });
});

// ── 파일참조 가드 — 첨부/자료 파일은 /uploads 상대경로 또는 https:// 만 저장 (서버 심화 방어, ADR-004) ──

test('create: 위험 스킴 파일참조는 빈 문자열로 무력화해 저장한다', () => {
  const { service, articleModel } = setup();
  const r = service.create({
    title: 't', author: 'kim',
    attachmentFile: 'javascript:alert(1)', referenceFile: 'javascript:alert(1)',
  });
  const c = articleModel.getById(r.articleId).contents;
  assert.equal(c.attachmentFile, '');
  assert.equal(c.referenceFile, '');
});

test('update: 위험 스킴 파일참조는 빈 문자열로 무력화해 저장한다', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({ title: 't', author: 'kim' });
  service.update(articleId, { attachmentFile: 'javascript:alert(1)' });
  assert.equal(articleModel.getById(articleId).contents.attachmentFile, '');
});

test('create/update: /uploads 상대경로 파일참조는 그대로 저장한다', () => {
  const { service, articleModel } = setup();
  const r = service.create({
    title: 't', author: 'kim',
    attachmentFile: '/uploads/stored-a.pdf', referenceFile: '/uploads/stored-r.docx',
  });
  let c = articleModel.getById(r.articleId).contents;
  assert.equal(c.attachmentFile, '/uploads/stored-a.pdf');
  assert.equal(c.referenceFile, '/uploads/stored-r.docx');

  service.update(r.articleId, { attachmentFile: '/uploads/updated-a.pdf', referenceFile: '/uploads/updated-r.docx' });
  c = articleModel.getById(r.articleId).contents;
  assert.equal(c.attachmentFile, '/uploads/updated-a.pdf');
  assert.equal(c.referenceFile, '/uploads/updated-r.docx');
});

test('create: https:// 파일참조는 그대로 저장한다', () => {
  const { service, articleModel } = setup();
  const r = service.create({ title: 't', author: 'kim', attachmentFile: 'https://example.com/x.pdf' });
  assert.equal(articleModel.getById(r.articleId).contents.attachmentFile, 'https://example.com/x.pdf');
});

test('create/update: 우회 벡터 파일참조는 모두 빈 문자열로 저장한다', () => {
  const { service, articleModel } = setup();
  const vectors = [
    'http://evil/x',              // http 스킴
    '//evil/x',                   // 프로토콜상대
    '/\\evil',                    // 백슬래시(브라우저가 /로 정규화)
    ' javascript:alert(1)',       // 선행 공백 은닉
    'java\tscript:alert(1)',      // 제어문자 은닉
    '/uploads/../etc/passwd',     // 경로 traversal
  ];
  for (const v of vectors) {
    const r = service.create({ title: 't', author: 'kim', attachmentFile: v, referenceFile: v });
    const c = articleModel.getById(r.articleId).contents;
    assert.equal(c.attachmentFile, '', `create 거부: ${JSON.stringify(v)}`);
    assert.equal(c.referenceFile, '', `create 거부: ${JSON.stringify(v)}`);

    const u = service.create({ title: 't', author: 'kim', attachmentFile: '/uploads/ok.pdf' });
    service.update(u.articleId, { attachmentFile: v });
    assert.equal(articleModel.getById(u.articleId).contents.attachmentFile, '', `update 거부: ${JSON.stringify(v)}`);
  }
});

test('update: 빈 문자열 파일참조(첨부 제거)는 그대로 통과한다', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({ title: 't', author: 'kim', attachmentFile: '/uploads/a.pdf' });
  service.update(articleId, { attachmentFile: '' });
  assert.equal(articleModel.getById(articleId).contents.attachmentFile, '');
});

test('update: 파일참조 미전달이면 기존 값을 보존한다 (DB 비파괴)', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({ title: 't', author: 'kim', attachmentFile: '/uploads/a.pdf' });
  service.update(articleId, { region: '부산' });
  const c = articleModel.getById(articleId).contents;
  assert.equal(c.attachmentFile, '/uploads/a.pdf', '미전달 파일 필드는 건드리지 않는다');
  assert.equal(c.region, '부산');
});
