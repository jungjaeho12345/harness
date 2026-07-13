// deriveArticle(sourceId, mode, overrides) — 후속기사작성(followUp)/계속기사작성(continue).
// 두 기능 모두 "기존 기사를 바탕으로 새 기사를 작성"한다: 새 articleId·status RDS·원본 비파괴.
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
function markup(text, withEnd = false) {
  const blocks = [{ type: 'text', text }];
  if (withEnd) blocks.push({ type: 'text', text: END });
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}

// 원본을 송고까지 진행해 sender/sentAt/DPS 상태를 만든 뒤 파생 시 미복사를 검증한다.
function createSource(service) {
  const body = markup('원문 본문', true);
  const { articleId } = service.create({
    title: '원본 제목', markupVersion: body, author: 'kim',
    coAuthor: 'lee', category: '정치일반', region: '서울', attribute: '자동기사', keyword: '경제',
    internalComment: '내부', externalComment: '외부',
    attachmentFile: '/uploads/a.png', referenceFile: '/uploads/r.doc',
    embargoAt: '2026-06-20T00:00:00.000Z', secondEmbargoAt: '2026-06-21T00:00:00.000Z',
  });
  return { articleId, body };
}

test('deriveArticle(continue): 새 articleId를 발급하고 본문을 복사한다', () => {
  const { service, articleModel } = setup();
  const { articleId: sourceId, body } = createSource(service);
  const r = service.deriveArticle(sourceId, 'continue', { author: 'park' });
  assert.equal(r.ok, true);
  assert.notEqual(r.articleId, sourceId, '새 articleId(원본과 다름)');
  assert.match(r.articleId, /^AKR\d{17}$/);
  const dst = articleModel.getById(r.articleId);
  assert.equal(dst.article.markupVersion, body, 'continue=원본 본문 복사');
  assert.equal(dst.article.title, '원본 제목', '제목 복사');
});

test('deriveArticle(followUp): 본문은 빈 값, 제목·공통정보는 복사한다', () => {
  const { service, articleModel } = setup();
  const { articleId: sourceId } = createSource(service);
  const r = service.deriveArticle(sourceId, 'followUp', { author: 'park' });
  assert.equal(r.ok, true);
  const dst = articleModel.getById(r.articleId);
  assert.equal(dst.article.markupVersion, '', 'followUp=빈 본문(새로 작성)');
  assert.equal(dst.article.title, '원본 제목', '제목 복사');
  assert.equal(dst.contents.coAuthor, 'lee');
  assert.equal(dst.contents.category, '정치일반');
  assert.equal(dst.contents.region, '서울');
  assert.equal(dst.contents.attribute, '자동기사');
  assert.equal(dst.contents.keyword, '경제');
  assert.equal(dst.contents.internalComment, '내부');
  assert.equal(dst.contents.externalComment, '외부');
  assert.equal(dst.contents.attachmentFile, '/uploads/a.png');
  assert.equal(dst.contents.referenceFile, '/uploads/r.doc');
});

test('deriveArticle: author는 overrides 값으로 채운다(세션 stamp는 HTTP 책임)', () => {
  const { service, articleModel } = setup();
  const { articleId: sourceId } = createSource(service);
  const r = service.deriveArticle(sourceId, 'continue', { author: 'park' });
  assert.equal(articleModel.getById(r.articleId).contents.author, 'park');
});

test('deriveArticle: 엠바고는 초기화되고 status는 RDS, sender/sentAt/잠금은 미복사', () => {
  const { service, articleModel } = setup();
  const { articleId: sourceId } = createSource(service);
  // 원본을 송고해 sender/sentAt/DPS를 만든다.
  service.applyAction(sourceId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  for (const mode of ['followUp', 'continue']) {
    const r = service.deriveArticle(sourceId, mode, { author: 'park' });
    const c = articleModel.getById(r.articleId).contents;
    assert.equal(c.status, 'RDS', `${mode}: 신규는 RDS`);
    assert.equal(c.sender, null, `${mode}: 송고자 미복사`);
    assert.equal(c.sentAt, null, `${mode}: 송고시간 미복사`);
    assert.equal(c.distributedAt, null, `${mode}: 배부시간 미복사`);
    assert.ok(!c.embargoAt, `${mode}: 엠바고 초기화`);
    assert.ok(!c.secondEmbargoAt, `${mode}: 2차 엠바고 초기화`);
    assert.notEqual(c.lockYN, 'Y', `${mode}: 미잠금`);
  }
});

test('deriveArticle: 원본 기사는 파생 전후로 불변이다(DB 비파괴)', () => {
  const { service, articleModel } = setup();
  const { articleId: sourceId } = createSource(service);
  const before = articleModel.getById(sourceId);
  service.deriveArticle(sourceId, 'continue', { author: 'park' });
  service.deriveArticle(sourceId, 'followUp', { author: 'park' });
  const after = articleModel.getById(sourceId);
  assert.deepEqual(after, before, '원본 article/contents 불변');
});

test('deriveArticle: 원본이 없으면 not-found', () => {
  const { service } = setup();
  const r = service.deriveArticle('AKR000', 'continue', { author: 'park' });
  assert.deepEqual(r, { ok: false, reason: 'not-found' });
});

test('deriveArticle: 알 수 없는 모드는 unknown-mode', () => {
  const { service } = setup();
  const { articleId: sourceId } = createSource(service);
  const r = service.deriveArticle(sourceId, 'translate', { author: 'park' });
  assert.deepEqual(r, { ok: false, reason: 'unknown-mode' });
});

test('deriveArticle: 클라이언트가 보낸 status/sender/articleId는 무시한다', () => {
  const { service, articleModel } = setup();
  const { articleId: sourceId } = createSource(service);
  const r = service.deriveArticle(sourceId, 'continue', {
    author: 'park', status: 'DPS', sender: 'evil', articleId: 'AKR-FAKE',
  });
  assert.notEqual(r.articleId, 'AKR-FAKE', 'articleId는 새로 발급');
  const c = articleModel.getById(r.articleId).contents;
  assert.equal(c.status, 'RDS');
  assert.equal(c.sender, null);
});
