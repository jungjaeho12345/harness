import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createReceiverConfigModel } from '../src/models/receiverConfigModel.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  return { db, configs: createReceiverConfigModel(db) };
}

test('receiverConfigModel: insert가 자동 증가 id를 반환하고 query로 조회된다', () => {
  const { configs } = setup();
  const id = configs.insert({
    sourceId: 'src-1', type: 'FTP', name: '연합FTP',
    host: '127.0.0.1', port: '21', active: 'Y',
  });
  assert.ok(Number(id) > 0, '자동 증가 id를 반환해야 함');

  const rows = configs.query({ id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceId, 'src-1');
  assert.equal(rows[0].type, 'FTP');
});

test('receiverConfigModel: query는 AND 동등 필터(sourceId/type/active)를 지원한다', () => {
  const { configs } = setup();
  configs.insert({ sourceId: 'a', type: 'FTP', active: 'Y' });
  configs.insert({ sourceId: 'b', type: 'API', active: 'Y' });
  configs.insert({ sourceId: 'c', type: 'API', active: 'N' });

  assert.deepEqual(configs.query({ type: 'API' }).map((r) => r.sourceId).sort(), ['b', 'c']);
  assert.deepEqual(configs.query({ type: 'API', active: 'Y' }).map((r) => r.sourceId), ['b']);
  assert.equal(configs.query().length, 3, '필터 없으면 전체');
});

test('receiverConfigModel: remove는 설정 행만 삭제한다 — 수집된 Article/Contents는 건드리지 않는다', () => {
  const { db, configs } = setup();
  // 이미 수집된 기사 한 건
  db.prepare('INSERT INTO Article (articleId, title) VALUES (?, ?)').run('AKR1', '자동기사');
  db.prepare("INSERT INTO Contents (articleId, attribute, status) VALUES (?, '자동기사', 'RDS')").run('AKR1');

  const id = configs.insert({ sourceId: 'src-1', type: 'FTP' });
  const changes = configs.remove(id);
  assert.equal(changes, 1);
  assert.equal(configs.query({ id }).length, 0, '설정 행은 삭제됨');

  // 수집된 기사는 그대로 보존되어야 한다 (DB 비파괴).
  assert.ok(db.prepare('SELECT 1 FROM Article WHERE articleId = ?').get('AKR1'), 'Article 보존');
  assert.ok(db.prepare('SELECT 1 FROM Contents WHERE articleId = ?').get('AKR1'), 'Contents 보존');
});

test('receiverConfigModel: 노출 메서드는 query/insert/remove 뿐이다', () => {
  const { configs } = setup();
  assert.deepEqual(Object.keys(configs).sort(), ['insert', 'query', 'remove']);
});
