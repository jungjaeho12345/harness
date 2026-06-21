import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleService } from '../src/services/articleService.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const service = createArticleService({ articleModel, db });
  return { db, articleModel, service };
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
    coAuthor: 'lee', region: '서울', attribute: '자동기사',
    keyword: '경제', embargoAt: '2026-06-20T00:00:00.000Z',
  });
  const c = articleModel.getById(r.articleId).contents;
  assert.equal(c.coAuthor, 'lee');
  assert.equal(c.region, '서울');
  assert.equal(c.attribute, '자동기사');
  assert.equal(c.keyword, '경제');
  assert.equal(c.embargoAt, '2026-06-20T00:00:00.000Z');
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

test('applyAction: 엠바고 설정된 RDS 기사를 D가 송고하면 EPS로 진입한다 (sender/sentAt 기록)', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({
    title: '제목', markupVersion: markup('본문', true), author: 'kim',
    embargoAt: '2026-06-25T09:00:00.000Z',
  });
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.deepEqual(r, { ok: true, status: 'EPS' });
  const c = articleModel.getById(articleId).contents;
  assert.equal(c.status, 'EPS');
  assert.equal(c.sender, 'desk');
  assert.ok(c.sentAt, 'sentAt이 기록된다');
});

test('applyAction: 2차 엠바고만 설정돼도 RDS→EPS, Z 송고도 동일', () => {
  const { service, articleModel } = setup();
  const a = service.create({
    title: '제목', markupVersion: markup('본문', true), author: 'kim',
    secondEmbargoAt: '2026-06-26T09:00:00.000Z',
  });
  assert.deepEqual(service.applyAction(a.articleId, 'Z', 'send', { userId: 'admin' }), { ok: true, status: 'EPS' });
  assert.equal(articleModel.getById(a.articleId).contents.status, 'EPS');
});

test('applyAction: 엠바고 미설정 RDS 기사를 D가 송고하면 DPS를 유지한다 (회귀 보존)', () => {
  const { service, articleModel } = setup();
  const empty = service.create({ title: '빈엠바고', markupVersion: markup('본문', true), author: 'kim', embargoAt: '', secondEmbargoAt: '' });
  assert.deepEqual(service.applyAction(empty.articleId, 'D', 'send', { userId: 'desk' }), { ok: true, status: 'DPS' });
  assert.equal(articleModel.getById(empty.articleId).contents.status, 'DPS');
});

test('applyAction: 엠바고 설정된 RDS라도 R 송고는 RDS 유지 (EPS 진입은 D/Z 한정)', () => {
  const { service, articleModel } = setup();
  const { articleId } = service.create({
    title: '제목', markupVersion: markup('본문', true), author: 'kim',
    embargoAt: '2026-06-25T09:00:00.000Z',
  });
  assert.deepEqual(service.applyAction(articleId, 'R', 'send', { userId: 'kim' }), { ok: true, status: 'RDS' });
  assert.equal(articleModel.getById(articleId).contents.status, 'RDS');
});

test('applyAction: 엠바고 설정된 DDH 기사를 D가 송고해도 DPS 유지 (EPS는 RDS 송고 한정)', () => {
  const { service, articleModel } = setup();
  // D 최초 보류 → DDH, 엠바고 설정.
  const { articleId } = service.create({
    title: '제목', markupVersion: markup('본문', true), author: 'desk',
    embargoAt: '2026-06-25T09:00:00.000Z',
  }, { role: 'D', action: 'hold' });
  assert.equal(articleModel.getById(articleId).contents.status, 'DDH');
  assert.deepEqual(service.applyAction(articleId, 'D', 'send', { userId: 'desk' }), { ok: true, status: 'DPS' });
  assert.equal(articleModel.getById(articleId).contents.status, 'DPS');
});

test('applyAction: EPS 기사를 D가 KILL하면 EEK, 보류하면 EEH', () => {
  const { service, articleModel } = setup();
  const mkEps = () => {
    const a = service.create({
      title: '제목', markupVersion: markup('본문', true), author: 'kim',
      embargoAt: '2026-06-25T09:00:00.000Z',
    });
    service.applyAction(a.articleId, 'D', 'send', { userId: 'desk' }); // RDS → EPS
    assert.equal(articleModel.getById(a.articleId).contents.status, 'EPS');
    return a.articleId;
  };
  const killId = mkEps();
  assert.deepEqual(service.applyAction(killId, 'D', 'kill', { userId: 'desk' }), { ok: true, status: 'EEK' });
  assert.equal(articleModel.getById(killId).contents.status, 'EEK');

  const holdId = mkEps();
  assert.deepEqual(service.applyAction(holdId, 'D', 'hold', { userId: 'desk' }), { ok: true, status: 'EEH' });
  assert.equal(articleModel.getById(holdId).contents.status, 'EEH');
});

test('applyAction: EPS 기사 재송고(send)는 거부하고 status를 유지한다', () => {
  const { service, articleModel } = setup();
  const a = service.create({
    title: '제목', markupVersion: markup('본문', true), author: 'kim',
    embargoAt: '2026-06-25T09:00:00.000Z',
  });
  service.applyAction(a.articleId, 'D', 'send', { userId: 'desk' }); // RDS → EPS
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
