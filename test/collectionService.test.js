import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleService } from '../src/services/articleService.js';
import { createReceiverConfigModel } from '../src/models/receiverConfigModel.js';
import { createCollectionService } from '../src/services/collectionService.js';
import * as parser from '../src/parsers/parser.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const articleService = createArticleService({ articleModel, db });
  const receiverConfigModel = createReceiverConfigModel(db);
  const collection = createCollectionService({ articleService, receiverConfigModel, parser });
  return { db, articleModel, receiverConfigModel, collection };
}

test('receive: 등록되지 않은 sourceId는 거부하고 아무 기사도 등록하지 않는다', () => {
  const { collection, articleModel } = setup();
  const r = collection.receive('unknown-src', '제목\n본문');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unregistered');
  assert.equal(articleModel.query().length, 0);
});

test('receive: 등록된 sourceId면 파싱해 기사로 등록하고 attribute=자동기사·status RDS를 기록한다', () => {
  const { collection, receiverConfigModel, articleModel } = setup();
  receiverConfigModel.insert({ sourceId: 'src-1', type: 'FTP', active: 'Y' });

  const r = collection.receive('src-1', '연합속보 제목\n본문 첫째줄\n본문 둘째줄');
  assert.equal(r.ok, true);
  assert.match(r.articleId, /^AKR\d{17}$/);

  const row = articleModel.getById(r.articleId);
  assert.equal(row.contents.attribute, '자동기사');
  assert.equal(row.contents.status, 'RDS');
  assert.equal(row.contents.title, '연합속보 제목');
  assert.equal(row.article.title, '연합속보 제목');

  // 본문은 markupVersion 블록 JSON에 저장된다 (제목 줄 포함, 평문 컬럼 미사용).
  const doc = JSON.parse(row.article.markupVersion);
  assert.equal(doc.format, 'yh-editor');
  assert.ok(doc.blocks.some((b) => b.text === '본문 첫째줄'));
  assert.ok(doc.blocks.some((b) => b.text === '연합속보 제목'));
});

test('receive: API 응답 객체({title,content})도 등록되고 자동기사 속성을 가진다', () => {
  const { collection, receiverConfigModel, articleModel } = setup();
  receiverConfigModel.insert({ sourceId: 'api-1', type: 'API', active: 'Y' });

  const r = collection.receive('api-1', { title: 'API 제목', content: 'API 본문' });
  assert.equal(r.ok, true);
  const row = articleModel.getById(r.articleId);
  assert.equal(row.contents.title, 'API 제목');
  assert.equal(row.contents.attribute, '자동기사');
});

test('receive: 비활성(active=N) 설정은 등록을 거부한다', () => {
  const { collection, receiverConfigModel, articleModel } = setup();
  receiverConfigModel.insert({ sourceId: 'off-1', type: 'FTP', active: 'N' });

  const r = collection.receive('off-1', '제목\n본문');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'inactive');
  assert.equal(articleModel.query().length, 0);
});

test('receive: parser는 주입 가능하다 — 가짜 parser/서비스로 네트워크 없이 동작한다', () => {
  let seen;
  const fakeParser = { parse: (p) => { seen = p; return { title: 'T', content: 'C' }; } };
  const created = [];
  const fakeArticleService = {
    create: (dto) => { created.push(dto); return { ok: true, articleId: 'AKR-fake' }; },
  };
  const fakeConfigs = { query: () => [{ sourceId: 's', active: 'Y' }] };

  const collection = createCollectionService({
    articleService: fakeArticleService,
    receiverConfigModel: fakeConfigs,
    parser: fakeParser,
  });

  const r = collection.receive('s', { raw: 'payload' });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, { raw: 'payload' }, '주입된 parser가 payload를 받는다');
  assert.equal(created[0].attribute, '자동기사', '등록 DTO에 자동기사 속성이 들어간다');
  assert.equal(created[0].title, 'T');
});
