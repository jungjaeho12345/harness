import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createDistributionTargetModel } from '../src/models/distributionTargetModel.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  return { db, targets: createDistributionTargetModel(db) };
}

test('distributionTargetModel: insert가 자동 증가 id를 반환하고 query로 조회된다', () => {
  const { targets } = setup();
  const id = targets.insert({
    name: '연합뉴스TV', kind: 'press', spoolDir: 'yonhap-tv',
    active: 'Y', createdAt: '2026-07-27T00:00:00.000Z',
  });
  assert.ok(Number(id) > 0, '자동 증가 id를 반환해야 함');

  const rows = targets.query({ id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '연합뉴스TV');
  assert.equal(rows[0].kind, 'press');
  assert.equal(rows[0].spoolDir, 'yonhap-tv');
});

test('distributionTargetModel: query는 화이트리스트 AND 동등 필터(kind/active/spoolDir)를 지원한다', () => {
  const { targets } = setup();
  targets.insert({ name: 'A사', kind: 'press', spoolDir: 'a', active: 'Y' });
  targets.insert({ name: 'B사', kind: 'nonpress', spoolDir: 'b', active: 'Y' });
  targets.insert({ name: 'C사', kind: 'nonpress', spoolDir: 'c', active: 'N' });

  assert.deepEqual(targets.query({ kind: 'nonpress' }).map((r) => r.name), ['B사', 'C사']);
  assert.deepEqual(targets.query({ kind: 'nonpress', active: 'Y' }).map((r) => r.name), ['B사']);
  assert.deepEqual(targets.query({ spoolDir: 'c' }).map((r) => r.name), ['C사']);
  assert.deepEqual(targets.query().map((r) => r.id), [1, 2, 3], '필터 없으면 전체를 id 오름차순으로');
  // 화이트리스트 밖 키는 무시한다 (임의 컬럼명 주입 차단).
  assert.equal(targets.query({ bogusColumn: "x' OR 1=1 --" }).length, 3);
});

test('distributionTargetModel: findById는 단건을 주고 없는 id는 undefined다', () => {
  const { targets } = setup();
  const id = targets.insert({ name: '연합뉴스TV', kind: 'press' });
  assert.equal(targets.findById(id).name, '연합뉴스TV');
  assert.equal(targets.findById(9999), undefined, '없는 id는 undefined');
});

test('distributionTargetModel: update(active=N)은 soft delete — 행은 그대로 남는다', () => {
  const { targets } = setup();
  const id = targets.insert({ name: '연합뉴스TV', kind: 'press', active: 'Y' });

  assert.equal(targets.update(id, { active: 'N' }), 1, 'changes 1');

  const rows = targets.query({ id });
  assert.equal(rows.length, 1, '행은 삭제되지 않고 남아야 함');
  assert.equal(rows[0].active, 'N');
  assert.equal(rows[0].name, '연합뉴스TV', '다른 컬럼은 보존');
});

test('distributionTargetModel: update는 present-only다 — 전달하지 않은 컬럼은 변하지 않는다', () => {
  const { targets } = setup();
  const id = targets.insert({
    name: '연합뉴스TV', kind: 'press', spoolDir: 'yonhap-tv',
    active: 'Y', createdAt: '2026-07-27T00:00:00.000Z',
  });

  assert.equal(targets.update(id, { name: '연합뉴스', updatedAt: '2026-07-27T01:00:00.000Z' }), 1);

  const row = targets.findById(id);
  assert.equal(row.name, '연합뉴스');
  assert.equal(row.updatedAt, '2026-07-27T01:00:00.000Z');
  assert.equal(row.kind, 'press', 'kind는 그대로');
  assert.equal(row.spoolDir, 'yonhap-tv', 'spoolDir는 그대로');
  assert.equal(row.active, 'Y', 'active는 그대로');
  assert.equal(row.createdAt, '2026-07-27T00:00:00.000Z', 'createdAt은 그대로');
});

test('distributionTargetModel: update에 갱신 필드가 없으면 SQL을 실행하지 않고 0을 반환한다', () => {
  let prepared = 0;
  const spyDb = {
    prepare() {
      prepared += 1;
      throw new Error('빈 fields로 SQL을 실행하면 안 된다');
    },
  };
  const targets = createDistributionTargetModel(spyDb);
  assert.equal(targets.update(1, {}), 0);
  assert.equal(targets.update(1), 0, '인자 생략도 0');
  assert.equal(prepared, 0, 'prepare가 호출되지 않아야 함');
});

test('distributionTargetModel: update는 id 컬럼을 SET하지 않는다', () => {
  const { targets } = setup();
  const id = targets.insert({ name: '연합뉴스TV', kind: 'press' });

  assert.equal(targets.update(id, { id: 99, name: '바뀐이름' }), 1);

  assert.equal(targets.findById(99), undefined, 'id는 변경되지 않아야 함');
  const row = targets.findById(id);
  assert.equal(row.id, 1);
  assert.equal(row.name, '바뀐이름');
});

test('distributionTargetModel: 삭제(delete/remove) 함수를 노출하지 않는다 (DB 비파괴)', () => {
  const { targets } = setup();
  assert.equal(targets.remove, undefined);
  assert.equal(targets.delete, undefined);
  assert.deepEqual(Object.keys(targets).sort(), ['findById', 'insert', 'query', 'update']);
});

test('distributionTargetModel: 대상 비활성화는 기사(Article/Contents)를 건드리지 않는다', () => {
  const { db, targets } = setup();
  db.prepare('INSERT INTO Article (articleId, title) VALUES (?, ?)').run('AKR1', '배부된 기사');
  db.prepare("INSERT INTO Contents (articleId, status) VALUES (?, 'DPS')").run('AKR1');

  const id = targets.insert({ name: '연합뉴스TV', kind: 'press', active: 'Y' });
  assert.equal(targets.update(id, { active: 'N' }), 1);

  // 배부 대상 비활성화는 이미 배부된 기사와 무관하다 (DB 비파괴).
  assert.ok(db.prepare('SELECT 1 FROM Article WHERE articleId = ?').get('AKR1'), 'Article 보존');
  assert.ok(db.prepare('SELECT 1 FROM Contents WHERE articleId = ?').get('AKR1'), 'Contents 보존');
  assert.equal(targets.query({ id }).length, 1, '대상 행도 보존(soft delete)');
});
