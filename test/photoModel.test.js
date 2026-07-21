// 사진DB 모델 테스트 — in-memory db + createSchema + insert/searchByCaption 단언.
// 계약: insert는 present-only INSERT 후 새 id(Number)를 반환, searchByCaption은 캡션
// 부분일치(LIKE)·id DESC(최신 우선). remove/update/delete는 없다(append-only·DB 비파괴).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createPhotoModel } from '../src/models/photoModel.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  return { db, photos: createPhotoModel(db) };
}

test('photoModel: insert가 자동 증가 id(Number)를 반환하고 searchByCaption으로 조회된다', () => {
  const { photos } = setup();
  const id = photos.insert({
    src: '/uploads/a.png', caption: '광화문 야경', sourceArticleId: 'AKR1',
    registeredBy: 'kim', createdAt: '2026-07-21T00:00:00.000Z',
  });
  assert.equal(typeof id, 'number', 'id는 Number여야 함');
  assert.ok(id > 0, '자동 증가 id를 반환해야 함');

  const rows = photos.searchByCaption('광화문');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].src, '/uploads/a.png');
  assert.equal(rows[0].registeredBy, 'kim');
});

test('photoModel: insert는 정의된 컬럼만 넣는다 (present-only — 미전달은 NULL)', () => {
  const { db, photos } = setup();
  const id = photos.insert({ src: 'https://cdn/x.png', caption: '부분입력' });
  const row = db.prepare('SELECT * FROM Photo WHERE id = ?').get(id);
  assert.equal(row.src, 'https://cdn/x.png');
  assert.equal(row.sourceArticleId, null, '미전달 컬럼은 NULL');
  assert.equal(row.registeredBy, null, '미전달 컬럼은 NULL');
});

test('photoModel: 입력할 컬럼이 하나도 없으면 throw', () => {
  const { photos } = setup();
  assert.throws(() => photos.insert({}), /입력할 컬럼이 없습니다/);
  assert.throws(() => photos.insert({ id: 99 }), /입력할 컬럼이 없습니다/, 'id는 화이트리스트 밖(자동 증가)');
});

test('photoModel: searchByCaption은 캡션 부분일치(LIKE)로 필터하고 매칭 없으면 빈 배열', () => {
  const { photos } = setup();
  photos.insert({ src: '/uploads/a.png', caption: '서울 광화문 야경' });
  photos.insert({ src: '/uploads/b.png', caption: '부산 해운대' });

  assert.deepEqual(photos.searchByCaption('광화문').map((r) => r.src), ['/uploads/a.png']);
  assert.deepEqual(photos.searchByCaption('없는캡션'), [], '매칭 없으면 빈 배열');
});

test('photoModel: searchByCaption 정렬은 id DESC (최신 등록 우선)', () => {
  const { photos } = setup();
  const first = photos.insert({ src: '/uploads/1.png', caption: '행사 사진 1' });
  const second = photos.insert({ src: '/uploads/2.png', caption: '행사 사진 2' });
  assert.deepEqual(photos.searchByCaption('행사').map((r) => r.id), [second, first]);
});

test('photoModel: 노출 메서드는 insert/searchByCaption 뿐 — remove/update/delete 없음 (append-only 가드)', () => {
  const { photos } = setup();
  assert.deepEqual(Object.keys(photos).sort(), ['insert', 'searchByCaption']);
  assert.equal(typeof photos.remove, 'undefined');
  assert.equal(typeof photos.update, 'undefined');
  assert.equal(typeof photos.delete, 'undefined');
});
