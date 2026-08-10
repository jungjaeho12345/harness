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
  const historyModel = createArticleHistoryModel(db);
  const service = createArticleService({ articleModel, db, historyModel });
  return { db, articleModel, historyModel, service };
}

const END = '(끝)';
function markup(text, withEnd = false) {
  const blocks = [{ type: 'text', text }];
  if (withEnd) blocks.push({ type: 'text', text: END });
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}

test('history: 편집 저장(update) 시 eventType=edit 이력 1건이 기록된다(actorUserId=modifier)', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  service.update(articleId, { title: '수정', modifier: 'kim' });

  const rows = service.queryHistory(articleId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventType, 'edit');
  assert.equal(rows[0].action, null);
  assert.equal(rows[0].actorUserId, 'kim');
  assert.ok(rows[0].createdAt, 'createdAt이 stamp된다');
});

test('history: 전이 성공 시에만 eventType=status 이력이 기록된다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.equal(r.ok, true);

  const rows = service.queryHistory(articleId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventType, 'status');
  assert.equal(rows[0].action, 'send');
  assert.equal(rows[0].fromStatus, 'RDS');
  assert.equal(rows[0].toStatus, 'DPS');
  assert.equal(rows[0].actorUserId, 'desk');
});

test('history: 엠바고 RDS 송고(DES 진입) 이력 toStatus는 DES다', () => {
  const { service } = setup();
  const { articleId } = service.create({
    title: '제목', markupVersion: markup('본문', true), author: 'kim',
    embargoAt: '2026-06-25T09:00:00.000Z',
  });
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.deepEqual(r, { ok: true, status: 'DES' });

  const rows = service.queryHistory(articleId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventType, 'status');
  assert.equal(rows[0].action, 'send');
  assert.equal(rows[0].fromStatus, 'RDS');
  assert.equal(rows[0].toStatus, 'DES');
  assert.equal(rows[0].actorUserId, 'desk');
});

test('history: 전이 거부(no-end-marker) 시 이력이 기록되지 않는다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  const r = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.equal(r.ok, false);
  assert.equal(service.queryHistory(articleId).length, 0);
});

test('history: 정의되지 않은 전이 거부 시 이력이 기록되지 않는다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' }); // RDS → DPS (status 1건)
  const r = service.applyAction(articleId, 'R', 'send', { sessionId: 's2' }); // 거부
  assert.equal(r.ok, false);

  const rows = service.queryHistory(articleId);
  assert.equal(rows.length, 1, '거부된 전이는 기록되지 않는다');
  assert.equal(rows[0].action, 'send');
});

test('history: queryHistory({sendOnly})는 송고 status 이벤트만 반환한다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  service.update(articleId, { title: '수정', modifier: 'kim' });          // edit
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });   // status/send
  service.applyAction(articleId, 'D', 'approveDelete', { userId: 'desk', sessionId: 's1' }); // status/approveDelete

  const all = service.queryHistory(articleId);
  assert.equal(all.length, 3);

  const sendOnly = service.queryHistory(articleId, { sendOnly: true });
  assert.equal(sendOnly.length, 1);
  assert.equal(sendOnly[0].eventType, 'status');
  assert.equal(sendOnly[0].action, 'send');
});

test('history: 편집(edit) 이력 행에 그 시점 본문(markupVersion) 스냅샷이 저장된다', () => {
  const { db, service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  const snap = markup('수정된 본문');
  service.update(articleId, { title: '수정', markupVersion: snap, modifier: 'kim' });

  const row = db.prepare('SELECT * FROM ArticleHistory WHERE articleId = ?').get(articleId);
  assert.equal(row.eventType, 'edit');
  assert.equal(row.markupVersion, snap, '편집 시점 본문이 스냅샷으로 저장된다');

  // 목록(queryHistory)은 본문 blob 없이 hasSnapshot만 노출한다(경량 목록).
  const [item] = service.queryHistory(articleId);
  assert.equal(item.markupVersion, undefined);
  assert.ok(item.hasSnapshot);
});

test('history: 본문 없는 메타 전용 편집의 스냅샷은 NULL이다(hasSnapshot falsy)', () => {
  const { db, service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  service.update(articleId, { title: '메타만 수정', modifier: 'kim' });

  const row = db.prepare('SELECT * FROM ArticleHistory WHERE articleId = ?').get(articleId);
  assert.equal(row.markupVersion, null);
  assert.ok(!service.queryHistory(articleId)[0].hasSnapshot);
});

test('history: status 전이 이력 행의 스냅샷은 NULL이다(본문 불변)', () => {
  const { db, service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  const row = db.prepare("SELECT * FROM ArticleHistory WHERE articleId = ? AND eventType = 'status'").get(articleId);
  assert.equal(row.markupVersion, null, '상태 전이는 스냅샷을 기록하지 않는다');
  assert.ok(!service.queryHistory(articleId)[0].hasSnapshot);
});

test('history: getHistorySnapshot이 단건 본문을 반환하고 없는/타기사 id는 not-found다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });
  const snap = markup('수정된 본문');
  service.update(articleId, { markupVersion: snap, modifier: 'kim' });
  const { id } = service.queryHistory(articleId)[0];

  const r = service.getHistorySnapshot(articleId, id);
  assert.equal(r.ok, true);
  assert.equal(r.item.markupVersion, snap);

  // 없는 id / 다른 기사의 articleId로는 not-found(스코프 — 스냅샷 유출 방지).
  assert.deepEqual(service.getHistorySnapshot(articleId, 99999), { ok: false, reason: 'not-found' });
  assert.deepEqual(service.getHistorySnapshot('AKR-OTHER', id), { ok: false, reason: 'not-found' });
});

test('history: getHistorySnapshot은 historyModel 미주입이면 not-found다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const service = createArticleService({ articleModel, db }); // historyModel 없음

  assert.deepEqual(service.getHistorySnapshot('AKR1', 1), { ok: false, reason: 'not-found' });
});

test('history: 이력 기록이 실패해도(historyModel.insert throw) 편집/전이는 정상 반환된다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const throwingHistory = {
    insert() { throw new Error('history down'); },
    queryByArticle() { return []; },
  };
  const service = createArticleService({ articleModel, db, historyModel: throwingHistory });

  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  // 편집: 이력 insert가 throw해도 update는 ok.
  const u = service.update(articleId, { title: '수정', modifier: 'kim' });
  assert.equal(u.ok, true);
  // 전이: 이력 insert가 throw해도 전이는 ok이고 status가 바뀐다.
  const a = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.deepEqual(a, { ok: true, status: 'DPS' });
  assert.equal(articleModel.getById(articleId).contents.status, 'DPS');
});

test('history: historyModel 미주입 시 기존 동작이 보존된다(기록 건너뜀, queryHistory 빈 배열)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const service = createArticleService({ articleModel, db }); // historyModel 없음

  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  assert.equal(service.update(articleId, { title: '수정', modifier: 'kim' }).ok, true);
  assert.deepEqual(
    service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' }),
    { ok: true, status: 'DPS' },
  );
  assert.deepEqual(service.queryHistory(articleId), []);
});

// --- phase 54 step1: 이력 insert 실패의 표면화(onHistoryError) ---
// 이력 행은 감사 기록만이 아니라 판정 입력이다(tick 멱등 판정·사이클 경계). 실패를 삼키는 동작은
// 유지하되, 선택 주입 콜백으로 "사실"만 남긴다 — 예외 승격·재시도·롤백은 하지 않는다.

// insert만 항상 던지는 이력 모델 스텁(조회 경로는 정상이어야 다른 흐름이 영향을 받지 않는다).
function throwingHistoryModel(message = 'db locked') {
  return {
    insert() { throw new Error(message); },
    queryByArticle() { return []; },
    querySnapshotById() { return undefined; },
  };
}

function setupFailingHistory(onHistoryError) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const service = createArticleService({
    articleModel, db, historyModel: throwingHistoryModel(), onHistoryError,
  });
  return { db, articleModel, service };
}

test('onHistoryError: update의 이력 insert 실패를 정확히 1회 표면화한다(eventType=edit)', () => {
  const seen = [];
  const { service, articleModel } = setupFailingHistory((info) => seen.push(info));
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });

  const u = service.update(articleId, { title: '수정', modifier: 'kim' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].articleId, articleId);
  assert.equal(seen[0].eventType, 'edit');
  assert.equal(seen[0].action ?? null, null, 'edit 이벤트에는 action이 없다');
  assert.equal(typeof seen[0].reason, 'string');
  assert.match(seen[0].reason, /db locked/);
  // 본 기능 비차단: 반환 계약과 실제 저장이 그대로다.
  assert.equal(u.ok, true);
  assert.equal(articleModel.getById(articleId).article.title, '수정');
});

test('onHistoryError: applyAction(전이 성공)의 이력 실패를 1회 표면화하고 전이는 유지된다', () => {
  const seen = [];
  const { service, articleModel } = setupFailingHistory((info) => seen.push(info));
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });

  const a = service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].articleId, articleId);
  assert.equal(seen[0].eventType, 'status');
  assert.equal(seen[0].action, 'send');
  assert.match(seen[0].reason, /db locked/);
  assert.deepEqual(a, { ok: true, status: 'DPS' });
  assert.equal(articleModel.getById(articleId).contents.status, 'DPS', '이력 실패가 전이를 되돌리지 않는다');
});

test('onHistoryError: 콜백에 본문 스냅샷(markupVersion)을 담지 않는다(마스킹 규율)', () => {
  const seen = [];
  const { service } = setupFailingHistory((info) => seen.push(info));
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문'), author: 'kim' });

  service.update(articleId, { title: '수정', modifier: 'kim', markupVersion: markup('비밀본문') });

  assert.equal(seen.length, 1);
  assert.equal('markupVersion' in seen[0], false);
  assert.equal(JSON.stringify(seen[0]).includes('비밀본문'), false);
});

test('onHistoryError: 콜백이 throw해도 편집/전이는 정상 반환된다(알림 실패 격리)', () => {
  const { service, articleModel } = setupFailingHistory(() => { throw new Error('알림 실패'); });
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });

  assert.equal(service.update(articleId, { title: '수정', modifier: 'kim' }).ok, true);
  assert.deepEqual(
    service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' }),
    { ok: true, status: 'DPS' },
  );
  assert.equal(articleModel.getById(articleId).contents.status, 'DPS');
});

test('onHistoryError: 미주입(오늘의 조립)이어도 이력 실패가 예외로 새지 않는다', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const service = createArticleService({ articleModel, db, historyModel: throwingHistoryModel() });

  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  assert.equal(service.update(articleId, { title: '수정', modifier: 'kim' }).ok, true);
  assert.deepEqual(
    service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' }),
    { ok: true, status: 'DPS' },
  );
});

// --- phase 56 step2: queryHistory 파생 필드(title/version/status) — sendOnly 필터 '전' 전체 이력 기준 ---

test('derive: queryHistory가 편집 스냅샷에서 제목(title)을 파생한다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  service.update(articleId, { markupVersion: markup('새 제목\n본문'), modifier: 'kim' });

  const rows = service.queryHistory(articleId);
  assert.equal(rows[0].title, '새 제목');
});

test('derive: 버전은 본문 편집마다 증가하고(최신순 [3,2]) 편집 0회 송고 행은 v1이다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  service.update(articleId, { markupVersion: markup('2판'), modifier: 'kim' });
  service.update(articleId, { markupVersion: markup('3판'), modifier: 'kim' });
  assert.deepEqual(service.queryHistory(articleId).map((r) => r.version), [3, 2]);

  // 편집 0회 + 송고 1회 — 최초 저장 본문 = v1.
  const { service: s2 } = setup();
  const { articleId: id2 } = s2.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  s2.applyAction(id2, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  assert.equal(s2.queryHistory(id2)[0].version, 1);
});

test('derive: 메타 전용 편집(본문 미포함)은 버전을 올리지 않는다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  service.update(articleId, { markupVersion: markup('2판'), modifier: 'kim' }); // 스냅샷 → v2
  service.update(articleId, { title: '메타만 수정', modifier: 'kim' });          // 스냅샷 없음 — 직전 값 유지
  assert.deepEqual(service.queryHistory(articleId).map((r) => r.version), [2, 2]);
});

test('derive: 상태는 전이 행 toStatus·이전 edit 행은 fromStatus 역승계다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판', true), author: 'kim' });
  service.update(articleId, { markupVersion: markup('새 본문', true), modifier: 'kim' }); // edit
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });      // status/send

  const rows = service.queryHistory(articleId);
  assert.equal(rows[0].status, 'DPS', 'status 행은 전이 후 상태');
  assert.equal(rows[1].status, 'RDS', '그보다 오래된 edit 행은 전이의 fromStatus 역승계');
});

test('derive: sendOnly는 파생 이후 필터다 — 송고 행의 버전·제목이 전체 조회와 정확히 일치한다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  service.update(articleId, { markupVersion: markup('2판\n본문'), modifier: 'kim' });
  service.update(articleId, { markupVersion: markup('마지막 제목\n본문', true), modifier: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  const sendOnly = service.queryHistory(articleId, { sendOnly: true });
  assert.equal(sendOnly.length, 1);
  assert.equal(sendOnly[0].version, 3, '필터로 잘린 edit 스냅샷까지 센 버전이다');
  assert.equal(sendOnly[0].title, '마지막 제목');

  const full = service.queryHistory(articleId);
  const same = full.find((r) => r.id === sendOnly[0].id);
  assert.deepEqual(sendOnly[0], same, '전체 조회의 같은 행과 값이 정확히 일치한다');
});

test('derive: sendOnly 여부와 무관하게 반환 행에 markupVersion이 없고 hasSnapshot은 남는다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  service.update(articleId, { markupVersion: markup('2판', true), modifier: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  for (const opts of [undefined, { sendOnly: true }]) {
    for (const r of service.queryHistory(articleId, opts)) {
      assert.equal('markupVersion' in r, false, '목록은 blob 없는 경량 계약');
      assert.notEqual(r.hasSnapshot, undefined);
    }
  }
});

test('derive: querySnapshotsByArticle가 없는 부분 스텁이어도 throw 없이 배열을 반환한다(title은 빈 값)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  // 기존 throwingHistoryModel 형태 — querySnapshotsByArticle 미구현.
  const stubHistory = {
    insert() {},
    queryByArticle() {
      return [
        {
          id: 2, articleId: 'AKR1', eventType: 'status', action: 'send', fromStatus: 'RDS',
          toStatus: 'DPS', actorUserId: 'desk', createdAt: '2026-06-16T00:00:02.000Z', hasSnapshot: 0,
        },
        {
          id: 1, articleId: 'AKR1', eventType: 'edit', action: null, fromStatus: null,
          toStatus: null, actorUserId: 'kim', createdAt: '2026-06-16T00:00:01.000Z', hasSnapshot: 1,
        },
      ];
    },
    querySnapshotById() { return undefined; },
  };
  const service = createArticleService({ articleModel, db, historyModel: stubHistory });

  const rows = service.queryHistory('AKR1');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.title), ['', ''], '스냅샷을 못 읽으면 제목만 빈다');
  assert.deepEqual(rows.map((r) => r.version), [2, 2], '버전은 hasSnapshot만으로 정확하다');
});

// 테스트 게이트 보강(phase 56) — 서비스의 가드 try/catch 두 곳(스냅샷 조회 실패·v1 본문 조회 실패)이
// 무검증이었다. 실패는 제목만 비우고 이력보기 자체는 죽지 않아야 한다(record() 실패 격리와 같은 정신).

// phase 58 step2 의미 이전(축소가 아니라 등가 이전 + 개선): 이 케이스는 제목 출처가 blob 조회
// (querySnapshotsByArticle)였을 때의 방어 계약이었다. 새 설계에서 제목 출처는 기록 시점에 저장된
// snapshotTitle 컬럼(querySnapshotTitlesByArticle)이므로, blob 조회가 throw해도 제목은 **유지**된다.
// 방어 계약 자체는 새 출처의 throw 케이스(아래 phase 58 묶음)로 그대로 이전해 잠갔다.
test('derive: querySnapshotsByArticle가 throw해도 제목이 유지된다(blob 조회 비의존 — 개선 계약)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const real = createArticleHistoryModel(db);
  const historyModel = { ...real, querySnapshotsByArticle() { throw new Error('snapshot query down'); } };
  const service = createArticleService({ articleModel, db, historyModel });

  const { articleId } = service.create({ title: '제목', markupVersion: markup('첫 제목\n본문', true), author: 'kim' });
  service.update(articleId, { markupVersion: markup('새 제목\n본문', true), modifier: 'kim' }); // 스냅샷 1건
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  const rows = service.queryHistory(articleId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.title), ['새 제목', '새 제목'], '신규 기록 경로 기사는 blob 없이 제목이 나온다');
  assert.deepEqual(rows.map((r) => r.version), [2, 2], '버전은 hasSnapshot 플래그만으로 정확하다');
  assert.deepEqual(rows.map((r) => r.status), ['DPS', 'RDS'], '상태 승계/역승계도 그대로다');
});

test('derive: v1 본문 조회(getById)가 throw해도 이력보기는 죽지 않는다(제목만 빈 값)', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  // 정상 서비스로 데이터를 만든 뒤(편집 0회 + 송고 1회 = 스냅샷 0건 → v1Body 조회 경로),
  // getById만 던지는 조립으로 같은 db를 다시 읽는다.
  const writer = createArticleService({ articleModel, db, historyModel });
  const { articleId } = writer.create({ title: '제목', markupVersion: markup('첫 제목\n본문', true), author: 'kim' });
  writer.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  const failingArticleModel = { ...articleModel, getById() { throw new Error('article read down'); } };
  const service = createArticleService({ articleModel: failingArticleModel, db, historyModel });

  const rows = service.queryHistory(articleId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '', 'v1 본문을 못 읽으면 제목만 빈다');
  assert.equal(rows[0].version, 1);
  assert.equal(rows[0].status, 'DPS');
});

test('derive: v1 본문 예외 — 편집 0회 송고 기사는 현재 본문에서 v1 제목을 파생한다', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('첫 제목\n본문', true), author: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  const rows = service.queryHistory(articleId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '첫 제목', '스냅샷 0건 = 현재 본문이 곧 v1 본문(동치)');
  assert.equal(rows[0].version, 1);

  const sendOnly = service.queryHistory(articleId, { sendOnly: true });
  assert.equal(sendOnly[0].title, '첫 제목');
  assert.equal(sendOnly[0].version, 1);
});

test('derive: 편집 스냅샷이 생기면 v1 구간 제목은 다시 빈다(현재 본문이 과거로 새지 않는다)', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('첫 제목\n본문', true), author: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });
  service.update(articleId, { markupVersion: markup('새 제목\n본문'), modifier: 'kim' });

  const rows = service.queryHistory(articleId);
  assert.equal(rows[0].title, '새 제목', '편집 행은 자기 스냅샷의 제목');
  assert.equal(rows[1].title, '', '송고 행(v1 구간)은 현재 본문 제목을 받지 않는다');
});

test('derive: 기사 본문 조회는 스냅샷 0건일 때만 — 스냅샷 보유/이력 0건 기사에서는 getById 0회', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const real = createArticleModel(db);
  let getByIdCalls = 0;
  const articleModel = { ...real, getById(id) { getByIdCalls += 1; return real.getById(id); } };
  const historyModel = createArticleHistoryModel(db);
  const service = createArticleService({ articleModel, db, historyModel });

  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  service.update(articleId, { markupVersion: markup('2판'), modifier: 'kim' }); // 스냅샷 1건
  const { articleId: emptyId } = service.create({ title: '이력 없음', markupVersion: markup('본문'), author: 'kim' });

  // setup 호출분(applyAction 등)이 섞이지 않게 queryHistory 직전 카운터를 리셋해 비교한다.
  getByIdCalls = 0;
  service.queryHistory(articleId);
  assert.equal(getByIdCalls, 0, '스냅샷이 1건 이상이면 본문을 조회하지 않는다');

  getByIdCalls = 0;
  service.queryHistory(emptyId);
  assert.equal(getByIdCalls, 0, '이력 0건이면 본문을 조회하지 않는다');
});

test('derive: 기존 필드가 모두 보존된다(파생은 추가일 뿐 대체가 아니다)', () => {
  const { service } = setup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판', true), author: 'kim' });
  service.update(articleId, { markupVersion: markup('2판', true), modifier: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  const base = ['id', 'articleId', 'eventType', 'action', 'fromStatus', 'toStatus', 'actorUserId', 'createdAt', 'hasSnapshot'];
  for (const r of service.queryHistory(articleId)) {
    for (const key of base) assert.ok(key in r, `${key} 보존`);
    for (const key of ['title', 'version', 'status']) assert.ok(key in r, `${key} 추가`);
  }
});

// --- phase 58 step2: 이력 제목의 기록 경로(snapshotTitle 컬럼 저장) + 조회 경로(단일 조회) ---
// 기록: record()가 스냅샷 있는 행에만 historyMeta.snapshotTitle 파생값을 함께 저장한다.
// 조회: queryHistory가 querySnapshotTitlesByArticle 하나만 읽는다(레거시 행 본문은 그 조회가 실어 준다
// — 2차 폴백 금지: 장애 시 최악 비용(blob 전량)이 되살아나는 경로를 만들지 않는다).

// 실제 모델을 래핑해 조회 호출 수와 단일 조회가 돌려준 항목을 관찰한다.
function spyingSetup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const real = createArticleHistoryModel(db);
  const calls = { titles: 0, snapshots: 0 };
  const returnedItems = [];
  const historyModel = {
    ...real,
    querySnapshotTitlesByArticle(id) {
      calls.titles += 1;
      const r = real.querySnapshotTitlesByArticle(id);
      returnedItems.push(...r);
      return r;
    },
    querySnapshotsByArticle(id) {
      calls.snapshots += 1;
      return real.querySnapshotsByArticle(id);
    },
  };
  const service = createArticleService({ articleModel, db, historyModel });
  return { db, articleModel, service, calls, returnedItems };
}

test('titleColumn: 본문 편집(update) 시 edit 행에 본문 첫 줄이 snapshotTitle로 저장된다', () => {
  const { db, service } = spyingSetup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  service.update(articleId, { markupVersion: markup('저장될 제목\n본문'), modifier: 'kim' });

  const row = db.prepare("SELECT snapshotTitle FROM ArticleHistory WHERE articleId = ? AND eventType = 'edit'").get(articleId);
  assert.equal(row.snapshotTitle, '저장될 제목');
});

test('titleColumn: 메타 전용 편집·상태 전이 행의 snapshotTitle은 NULL이다(스냅샷 없는 행은 컬럼 미적재)', () => {
  const { db, service } = spyingSetup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  service.update(articleId, { title: '메타만 수정', modifier: 'kim' });                 // markupVersion 미포함
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });     // status 전이

  const rows = db.prepare('SELECT eventType, snapshotTitle FROM ArticleHistory WHERE articleId = ? ORDER BY id').all(articleId);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.snapshotTitle, null, `${r.eventType} 행은 NULL`);
});

test('titleColumn: 첫 줄이 공백뿐인 본문의 snapshotTitle은 NULL이 아니라 빈 문자열이다(영구 레거시 오판 봉쇄)', () => {
  const { db, service, calls, returnedItems } = spyingSetup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  service.update(articleId, { markupVersion: markup('   \n본문'), modifier: 'kim' });

  // 기록: '' 그대로 저장 — || undefined 류로 NULL이 되면 그 행이 영구 레거시가 된다.
  const row = db.prepare("SELECT snapshotTitle FROM ArticleHistory WHERE articleId = ? AND eventType = 'edit'").get(articleId);
  assert.strictEqual(row.snapshotTitle, '', "빈 제목은 ''로 저장된다(NULL 금지)");

  // 조회: 제목 ''가 그대로 나오고 본문 폴백이 쓰이지 않는다.
  const rows = service.queryHistory(articleId);
  assert.strictEqual(rows[0].title, '');
  assert.equal(calls.snapshots, 0, 'blob 전량 조회는 호출되지 않는다');
  const item = returnedItems.find((s) => s.snapshotTitle === '');
  assert.ok(item, "단일 조회 항목의 snapshotTitle이 ''다");
  assert.strictEqual(item.markupVersion, null, '빈 제목 행의 본문은 JS 경계를 넘지 않는다');
});

test('titleColumn: 신규 기록만 있는 기사는 단일 조회 1회·blob 조회 0회·본문 전송 0건이다(핵심 성능 잠금)', () => {
  const { service, calls, returnedItems } = spyingSetup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  service.update(articleId, { markupVersion: markup('제목 v2\n본문'), modifier: 'kim' });
  service.update(articleId, { markupVersion: markup('제목 v3\n본문', true), modifier: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  calls.titles = 0; calls.snapshots = 0; returnedItems.length = 0;
  const rows = service.queryHistory(articleId);

  assert.equal(calls.titles, 1, '단일 조회 정확히 1회');
  assert.equal(calls.snapshots, 0, 'blob 전량 조회 0회');
  assert.equal(returnedItems.length, 2, '스냅샷 항목 2건');
  for (const s of returnedItems) assert.strictEqual(s.markupVersion, null, '본문이 JS 경계를 넘지 않는다');
  assert.deepEqual(rows.map((r) => r.title), ['제목 v3', '제목 v3', '제목 v2'], '제목은 정확하다');
});

test('titleColumn: 레거시 행(snapshotTitle NULL)은 단일 조회가 실어 준 본문에서 파생된다(blob 전량 조회 0회)', () => {
  const { db, service, calls } = spyingSetup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  // 이전 버전에서 기록된 레거시 edit 행 — snapshotTitle 없음(NULL).
  db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, actorUserId, createdAt, markupVersion) VALUES (?, 'edit', 'kim', ?, ?)",
  ).run(articleId, '2026-08-10T00:00:01.000Z', markup('레거시 제목\n본문'));

  calls.snapshots = 0;
  const rows = service.queryHistory(articleId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '레거시 제목', '레거시 행은 본문 첫 줄에서 파생된다');
  assert.equal(calls.snapshots, 0, '폴백 본문은 단일 조회가 실어 준다 — 2차 조회 없음');
});

test('titleColumn: 평문 레거시 본문도 첫 줄이 제목이고 JSON 접두어가 제목으로 노출되지 않는다', () => {
  const { db, service } = spyingSetup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, actorUserId, createdAt, markupVersion) VALUES (?, 'edit', 'kim', ?, ?)",
  ).run(articleId, '2026-08-10T00:00:01.000Z', '평문 제목줄\n평문 본문');
  db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, actorUserId, createdAt, markupVersion) VALUES (?, 'edit', 'kim', ?, ?)",
  ).run(articleId, '2026-08-10T00:00:02.000Z', markup('블록 제목\n본문'));

  const rows = service.queryHistory(articleId);
  assert.equal(rows[1].title, '평문 제목줄', '평문 레거시는 첫 줄 그대로');
  assert.equal(rows[0].title, '블록 제목', 'JSON 레거시는 파싱된 텍스트 첫 줄');
  for (const r of rows) assert.ok(!r.title.startsWith('{"'), 'JSON 접두어가 제목으로 새지 않는다(blob 절단 회귀 봉쇄)');
});

test('titleColumn: 레거시+신규 혼재 기사에서 두 행 모두 정확하고 레거시 행에만 본문이 실린다', () => {
  const { db, service, returnedItems } = spyingSetup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, actorUserId, createdAt, markupVersion) VALUES (?, 'edit', 'kim', ?, ?)",
  ).run(articleId, '2026-08-10T00:00:01.000Z', markup('레거시 제목\n본문'));
  service.update(articleId, { markupVersion: markup('신규 제목\n본문'), modifier: 'kim' });

  returnedItems.length = 0;
  const rows = service.queryHistory(articleId);
  assert.deepEqual(rows.map((r) => r.title), ['신규 제목', '레거시 제목']);
  assert.deepEqual(rows.map((r) => r.version), [3, 2]);

  assert.equal(returnedItems.length, 2);
  const [newer, older] = returnedItems; // id DESC
  assert.strictEqual(newer.markupVersion, null, '신규 행 본문은 실리지 않는다');
  assert.equal(typeof older.markupVersion, 'string', '레거시 행에만 본문이 실린다');
});

test('titleColumn: querySnapshotTitlesByArticle가 throw하면 제목만 빈 값이고 blob 조회로 재시도하지 않는다(방어 이전)', () => {
  // 405행 케이스(구 blob 조회 방어)의 등가 이전 — 새 출처(단일 조회)의 장애에서 같은 계약을 잠근다.
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const real = createArticleHistoryModel(db);
  let blobCalls = 0;
  const historyModel = {
    ...real,
    querySnapshotTitlesByArticle() { throw new Error('title query down'); },
    querySnapshotsByArticle(id) { blobCalls += 1; return real.querySnapshotsByArticle(id); },
  };
  const service = createArticleService({ articleModel, db, historyModel });

  const { articleId } = service.create({ title: '제목', markupVersion: markup('첫 제목\n본문', true), author: 'kim' });
  service.update(articleId, { markupVersion: markup('새 제목\n본문', true), modifier: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  const rows = service.queryHistory(articleId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.title), ['', ''], '조회 실패 시 제목만 빈다');
  assert.deepEqual(rows.map((r) => r.version), [2, 2]);
  assert.deepEqual(rows.map((r) => r.status), ['DPS', 'RDS']);
  assert.equal(blobCalls, 0, '2차 폴백 금지 — 장애 시 최악 비용(blob 전량)이 되살아나면 안 된다');
});

test('titleColumn: 200자 초과 제목은 저장 컬럼도 조회 결과도 상한으로 절단된다', () => {
  const { db, service } = spyingSetup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판'), author: 'kim' });
  const long = '가'.repeat(300);
  service.update(articleId, { markupVersion: markup(`${long}\n본문`), modifier: 'kim' });

  const row = db.prepare("SELECT snapshotTitle FROM ArticleHistory WHERE articleId = ? AND eventType = 'edit'").get(articleId);
  assert.equal(row.snapshotTitle.length, 200, '기록 시점에 절단되어 저장된다');
  assert.equal(row.snapshotTitle, '가'.repeat(200));
  assert.equal(service.queryHistory(articleId)[0].title, '가'.repeat(200), '조회 결과도 같다');
});

test('titleColumn: queryHistory 반환 행 키 집합이 불변이다(snapshotTitle·markupVersion 미노출)', () => {
  const { service } = spyingSetup();
  const { articleId } = service.create({ title: '제목', markupVersion: markup('초판', true), author: 'kim' });
  service.update(articleId, { markupVersion: markup('2판', true), modifier: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  const base = ['id', 'articleId', 'eventType', 'action', 'fromStatus', 'toStatus', 'actorUserId', 'createdAt', 'hasSnapshot'];
  for (const opts of [undefined, { sendOnly: true }]) {
    for (const r of service.queryHistory(articleId, opts)) {
      for (const key of base) assert.ok(key in r, `${key} 보존`);
      for (const key of ['title', 'version', 'status']) assert.ok(key in r, `${key} 추가`);
      assert.equal('snapshotTitle' in r, false, '저장 컬럼 값은 응답에 싣지 않는다');
      assert.equal('markupVersion' in r, false, 'blob은 응답에 싣지 않는다');
    }
  }
});

test('onHistoryError: 정상 경로(insert 성공)에서는 호출 0회다(무소음)', () => {
  const seen = [];
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const service = createArticleService({
    articleModel, db, historyModel, onHistoryError: (info) => seen.push(info),
  });

  const { articleId } = service.create({ title: '제목', markupVersion: markup('본문', true), author: 'kim' });
  service.update(articleId, { title: '수정', modifier: 'kim' });
  service.applyAction(articleId, 'D', 'send', { userId: 'desk', sessionId: 's1' });

  assert.deepEqual(seen, []);
  assert.equal(service.queryHistory(articleId).length, 2);
});
