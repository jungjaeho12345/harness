// 사진DB 서비스 테스트 — 모델 주입·계약 단언.
// 계약: register는 sanitizeFileRef(단일 출처)로 src를 검증해 유효값만 등록하고({ ok, id }),
// 부적격 src는 insert 없이 { ok:false, reason:'invalid-src' }. registeredBy는 인자 userId
// (검증된 세션 도출)로만 stamp — dto.registeredBy는 무시한다(ADR-004). search는 얇은 위임.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createPhotoModel } from '../src/models/photoModel.js';
import { createPhotoService } from '../src/services/photoService.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const photoModel = createPhotoModel(db);
  return { db, photoModel, service: createPhotoService({ photoModel }) };
}

// insert 호출을 기록하는 스파이 모델 — "insert 미호출" 단언 전용.
function spyModel() {
  const calls = [];
  return {
    calls,
    insert: (record) => { calls.push(record); return calls.length; },
    searchByCaption: () => [],
  };
}

test('photoService.register: 유효 src(/uploads/·https://)를 등록하고 { ok, id }를 반환한다', () => {
  const { db, service } = setup();
  for (const src of ['/uploads/x.png', 'https://cdn/x.png']) {
    const r = service.register({ src, caption: '캡션' }, { userId: 'kim' });
    assert.equal(r.ok, true, `${src} 등록 성공`);
    assert.equal(typeof r.id, 'number');
    const row = db.prepare('SELECT * FROM Photo WHERE id = ?').get(r.id);
    assert.equal(row.src, src, '정규화된 src가 저장된다');
    assert.equal(row.caption, '캡션');
  }
});

test('photoService.register: registeredBy는 인자 userId로만 stamp — dto.registeredBy는 무시된다', () => {
  const { db, service } = setup();
  const r = service.register(
    { src: '/uploads/x.png', caption: 'c', registeredBy: 'attacker' },
    { userId: 'kim' },
  );
  assert.equal(r.ok, true);
  const row = db.prepare('SELECT * FROM Photo WHERE id = ?').get(r.id);
  assert.equal(row.registeredBy, 'kim', '세션 userId가 이긴다 (ADR-004)');
});

test('photoService.register: 부적격 src는 invalid-src — insert가 호출되지 않는다', () => {
  const model = spyModel();
  const service = createPhotoService({ photoModel: model });
  const bad = [
    'javascript:alert(1)',
    'data:image/png;base64,AAA',
    'http://x/y.png',
    '',
    '//evil/x.png',
    '/uploads/../etc/passwd.png',
    'C:\\evil\\x.png',
  ];
  for (const src of bad) {
    assert.deepEqual(
      service.register({ src, caption: 'c' }, { userId: 'kim' }),
      { ok: false, reason: 'invalid-src' },
      `거부되어야 함: ${JSON.stringify(src)}`,
    );
  }
  assert.equal(model.calls.length, 0, '부적격 src는 insert에 도달하지 않는다');
});

test('photoService.register: sourceArticleId/caption 미전달은 빈 문자열로, createdAt는 ISO로 stamp된다', () => {
  const { db, service } = setup();
  const r = service.register({ src: '/uploads/x.png' }, { userId: 'kim' });
  const row = db.prepare('SELECT * FROM Photo WHERE id = ?').get(r.id);
  assert.equal(row.caption, '', '캡션 미전달 → 빈 문자열');
  assert.equal(row.sourceArticleId, '', '출처 미전달 → 빈 문자열 (best-effort 출처 기록)');
  assert.match(row.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ISO-8601 UTC stamp');
});

test('photoService.search: 캡션 매칭 행을 반환한다 (얇은 위임)', () => {
  const { service } = setup();
  service.register({ src: '/uploads/a.png', caption: '광화문 야경' }, { userId: 'kim' });
  service.register({ src: '/uploads/b.png', caption: '해운대' }, { userId: 'kim' });

  const rows = service.search('광화문');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].src, '/uploads/a.png');
  assert.deepEqual(service.search('없음'), []);
});

test('photoService: 노출 메서드는 register/search 뿐 — remove/update 없음 (append-only)', () => {
  const { service } = setup();
  assert.deepEqual(Object.keys(service).sort(), ['register', 'search']);
});
