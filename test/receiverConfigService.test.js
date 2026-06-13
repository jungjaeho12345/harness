import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createReceiverConfigModel } from '../src/models/receiverConfigModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createAuthorization } from '../src/services/authorization.js';
import { createReceiverConfigService } from '../src/services/receiverConfigService.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const receiverConfigModel = createReceiverConfigModel(db);
  const sessionService = createSessionService();
  const authorization = createAuthorization({ sessionService, articleModel: null });
  const service = createReceiverConfigService({ receiverConfigModel, authorization });
  return { db, receiverConfigModel, sessionService, service };
}

function sessionFor(sessionService, role, userId = 'u') {
  return sessionService.createSession({
    userId, role, department: '정치부', departmentCode: 'POL', name: userId,
  });
}

test('create/query/remove: Z 세션은 전체 CRUD가 통과한다', () => {
  const { service, sessionService, receiverConfigModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');

  const c = service.create(z, { sourceId: 'src-1', type: 'FTP', active: 'Y' });
  assert.equal(c.ok, true);
  assert.ok(Number(c.id) > 0);

  const q = service.query(z, { sourceId: 'src-1' });
  assert.equal(q.ok, true);
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].sourceId, 'src-1');

  const rem = service.remove(z, c.id);
  assert.equal(rem.ok, true);
  assert.equal(rem.changes, 1);
  assert.equal(receiverConfigModel.query({ id: c.id }).length, 0);
});

test('비-Z(R/D) 세션은 forbidden, 미인증은 unauthenticated', () => {
  const { service, sessionService } = setup();
  const r = sessionFor(sessionService, 'R', 'rep');
  const d = sessionFor(sessionService, 'D', 'desk');

  assert.equal(service.query(r, {}).reason, 'forbidden');
  assert.equal(service.create(d, { sourceId: 'x' }).reason, 'forbidden');
  assert.equal(service.remove(r, 1).reason, 'forbidden');

  assert.equal(service.query('bad-session', {}).reason, 'unauthenticated');
  assert.equal(service.create(undefined, {}).reason, 'unauthenticated');
});

test('비-Z는 실제로 설정을 생성하지 못한다 (게이트가 모델 호출을 차단)', () => {
  const { service, sessionService, receiverConfigModel } = setup();
  const r = sessionFor(sessionService, 'R', 'rep');
  service.create(r, { sourceId: 'should-not-exist', type: 'FTP' });
  assert.equal(receiverConfigModel.query({ sourceId: 'should-not-exist' }).length, 0);
});

test('remove는 설정 행만 삭제한다 — 수집된 Article/Contents는 보존한다 (DB 비파괴)', () => {
  const { service, sessionService, db, receiverConfigModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');

  // 이미 수집된 자동기사 한 건
  db.prepare('INSERT INTO Article (articleId, title) VALUES (?, ?)').run('AKR1', '자동기사');
  db.prepare("INSERT INTO Contents (articleId, attribute, status) VALUES (?, '자동기사', 'RDS')").run('AKR1');

  const { id } = service.create(z, { sourceId: 'src-1', type: 'FTP' });
  const rem = service.remove(z, id);
  assert.equal(rem.ok, true);
  assert.equal(receiverConfigModel.query({ id }).length, 0, '설정 행은 삭제됨');

  assert.ok(db.prepare('SELECT 1 FROM Article WHERE articleId = ?').get('AKR1'), 'Article 보존');
  assert.ok(db.prepare('SELECT 1 FROM Contents WHERE articleId = ?').get('AKR1'), 'Contents 보존');
});
