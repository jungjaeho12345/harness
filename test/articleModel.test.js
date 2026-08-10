import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  return { db, articles: createArticleModel(db) };
}

// 테스트용 기사 한 건 ({ article, contents })을 만든다.
function makeArticle(id, overrides = {}) {
  return {
    article: {
      articleId: id,
      title: overrides.title ?? '제목',
      markupVersion: overrides.markupVersion ?? '{"format":"yh-editor","version":1,"blocks":[]}',
      modifier: overrides.modifier ?? 'kim',
    },
    contents: {
      articleId: id,
      title: overrides.title ?? '제목',
      author: overrides.author ?? 'kim',
      sender: overrides.sender ?? null,
      department: overrides.department ?? '정치부',
      createdAt: overrides.createdAt ?? '2026-06-14T00:00:00.000Z',
      sentAt: overrides.sentAt ?? null,
      distributedAt: overrides.distributedAt ?? null,
      status: overrides.status ?? 'RDS',
    },
  };
}

test('articleModel: insert가 Article+Contents를 함께 저장하고 getById가 둘 다 반환한다', () => {
  const { articles } = setup();
  articles.insert(makeArticle('AKR1'));
  const row = articles.getById('AKR1');
  assert.equal(row.article.articleId, 'AKR1');
  assert.equal(row.article.title, '제목');
  assert.equal(row.contents.articleId, 'AKR1');
  assert.equal(row.contents.status, 'RDS');
});

test('articleModel: getById는 둘 다 없으면 null을 반환한다', () => {
  const { articles } = setup();
  assert.equal(articles.getById('없음'), null);
});

test('articleModel: insert는 트랜잭션이다 — Contents 실패 시 Article도 롤백된다', () => {
  const { db, articles } = setup();
  // 같은 articleId의 Contents 행을 미리 만들어 두 번째 insert(Contents)에서 PK 충돌을 유발.
  db.prepare('INSERT INTO Contents (articleId) VALUES (?)').run('AKR1');

  assert.throws(() => articles.insert(makeArticle('AKR1')));

  // Article insert는 롤백되어 남아 있지 않아야 한다.
  const article = db.prepare('SELECT * FROM Article WHERE articleId = ?').get('AKR1');
  assert.equal(article, undefined, 'Article insert가 롤백되어야 함');
});

test('articleModel: update는 Article+Contents를 트랜잭션으로 부분 갱신한다', () => {
  const { articles } = setup();
  articles.insert(makeArticle('AKR1'));
  const changes = articles.update('AKR1', {
    article: { title: '수정된 제목' },
    contents: { status: 'DPS', sender: 'lee' },
  });
  assert.equal(changes, 2);
  const row = articles.getById('AKR1');
  assert.equal(row.article.title, '수정된 제목');
  assert.equal(row.contents.status, 'DPS');
  assert.equal(row.contents.sender, 'lee');
  assert.equal(row.contents.author, 'kim', '갱신하지 않은 필드는 보존된다');
});

test('articleModel: update는 한쪽 테이블만 갱신할 수 있다', () => {
  const { articles } = setup();
  articles.insert(makeArticle('AKR1'));
  const changes = articles.update('AKR1', { contents: { status: 'RRH' } });
  assert.equal(changes, 1);
  assert.equal(articles.getById('AKR1').contents.status, 'RRH');
});

test('articleModel: query는 부서 다중 선택(departments IN)을 지원한다', () => {
  const { articles } = setup();
  articles.insert(makeArticle('A', { department: '정치부' }));
  articles.insert(makeArticle('B', { department: '경제부' }));
  articles.insert(makeArticle('C', { department: '사회부' }));

  const rows = articles.query({ departments: ['정치부', '경제부'] });
  assert.deepEqual(rows.map((r) => r.articleId).sort(), ['A', 'B']);
});

test('articleModel: query는 특정 status 제외(excludeStatus NOT IN)를 지원한다', () => {
  const { articles } = setup();
  articles.insert(makeArticle('A', { status: 'RDS' }));
  articles.insert(makeArticle('B', { status: 'DPS' }));
  articles.insert(makeArticle('C', { status: 'RRH' }));

  const rows = articles.query({ excludeStatus: ['DPS', 'RRH'] });
  assert.deepEqual(rows.map((r) => r.articleId), ['A']);
});

test('articleModel: query는 status 포함(배열 IN)·작성자·송고자 필터를 지원한다', () => {
  const { articles } = setup();
  articles.insert(makeArticle('A', { status: 'DPS', author: 'kim', sender: 'lee' }));
  articles.insert(makeArticle('B', { status: 'RDS', author: 'kim' }));
  articles.insert(makeArticle('C', { status: 'DPS', author: 'park' }));

  assert.deepEqual(
    articles.query({ status: ['DPS'] }).map((r) => r.articleId).sort(),
    ['A', 'C'],
  );
  assert.deepEqual(
    articles.query({ author: 'kim' }).map((r) => r.articleId).sort(),
    ['A', 'B'],
  );
  assert.deepEqual(
    articles.query({ sender: 'lee' }).map((r) => r.articleId),
    ['A'],
  );
});

test('articleModel: query는 작성시간 범위(createdAtFrom/To)를 지원하고 createdAt 내림차순으로 정렬한다', () => {
  const { articles } = setup();
  articles.insert(makeArticle('A', { createdAt: '2026-06-10T00:00:00.000Z' }));
  articles.insert(makeArticle('B', { createdAt: '2026-06-12T00:00:00.000Z' }));
  articles.insert(makeArticle('C', { createdAt: '2026-06-14T00:00:00.000Z' }));

  const inRange = articles.query({
    createdAtFrom: '2026-06-11T00:00:00.000Z',
    createdAtTo: '2026-06-13T00:00:00.000Z',
  });
  assert.deepEqual(inRange.map((r) => r.articleId), ['B']);

  // 정렬: 최신(C) → 과거(A)
  assert.deepEqual(articles.query().map((r) => r.articleId), ['C', 'B', 'A']);
});

test('articleModel: searchByText는 제목과 본문(markupVersion)을 검색한다', () => {
  const { articles } = setup();
  articles.insert(makeArticle('A', {
    title: '경제 전망', markupVersion: '{"blocks":[{"text":"올해 금리 인상"}]}',
  }));
  articles.insert(makeArticle('B', {
    title: '정치 일정', markupVersion: '{"blocks":[{"text":"국회 본회의"}]}',
  }));

  assert.deepEqual(articles.searchByText('경제').map((r) => r.articleId), ['A'], '제목 검색');
  assert.deepEqual(articles.searchByText('금리').map((r) => r.articleId), ['A'], '본문 검색');
  assert.equal(articles.searchByText('없는단어').length, 0);
});

test('articleModel: setLock/clearLock이 잠금 컬럼을 갱신한다', () => {
  const { articles } = setup();
  articles.insert(makeArticle('AKR1'));

  articles.setLock('AKR1', { lockerUserId: 'kim', lockerSessionId: 'sess-1', lockerClientId: 'tab-1', lockedAt: '2026-06-14T01:00:00.000Z' });
  let c = articles.getById('AKR1').contents;
  assert.equal(c.lockYN, 'Y');
  assert.equal(c.lockerUserId, 'kim');
  assert.equal(c.lockerSessionId, 'sess-1');
  assert.equal(c.lockerClientId, 'tab-1');
  assert.equal(c.lockedAt, '2026-06-14T01:00:00.000Z');

  articles.clearLock('AKR1');
  c = articles.getById('AKR1').contents;
  assert.equal(c.lockYN, 'N');
  assert.equal(c.lockerUserId, null);
  assert.equal(c.lockerSessionId, null);
  assert.equal(c.lockerClientId, null);
  assert.equal(c.lockedAt, null);
});

test('articleModel: 행 삭제 함수를 노출하지 않는다 (DB 비파괴)', () => {
  const { articles } = setup();
  assert.equal(articles.delete, undefined);
  assert.equal(articles.remove, undefined);
});

// --- phase 58 step3: getStatusById — status 한 컬럼만 읽는 경량 조회 ---
// 배부 실패 목록(distributionRetryService.list)이 status 하나를 위해 getById(본문 blob 포함
// 2쿼리 전체 로드)를 부르는 N+1을 없애기 위한 조회. 반환 3분기: 문자열 / null(컬럼 NULL) / undefined(행 부재).

test('articleModel: getStatusById가 해당 기사의 status 문자열을 반환한다', () => {
  const { articles } = setup();
  articles.insert(makeArticle('AKR1', { status: 'DPS' }));
  assert.strictEqual(articles.getStatusById('AKR1'), 'DPS');
});

test('articleModel: getStatusById는 없는 기사면 undefined다(부재와 NULL 구분)', () => {
  const { articles } = setup();
  assert.strictEqual(articles.getStatusById('AKR-NONE'), undefined);
});

test('articleModel: getStatusById는 status가 NULL인 행에서 null이다', () => {
  const { db, articles } = setup();
  db.prepare('INSERT INTO Contents (articleId, title) VALUES (?, ?)').run('AKR1', '상태 미지정');
  assert.strictEqual(articles.getStatusById('AKR1'), null);
});

test('articleModel: getStatusById는 update 직후 값을 즉시 반영한다(캐시 없음)', () => {
  const { articles } = setup();
  articles.insert(makeArticle('AKR1', { status: 'RDS' }));
  assert.strictEqual(articles.getStatusById('AKR1'), 'RDS');
  articles.update('AKR1', { contents: { status: 'DPS' } });
  assert.strictEqual(articles.getStatusById('AKR1'), 'DPS');
});

test('articleModel: getStatusById는 Contents에서 status만 SELECT한다(blob 미접촉 — 경량 잠금)', () => {
  const { db, articles } = setup();
  articles.insert(makeArticle('AKR1', { status: 'DPS' }));

  // db.prepare 래핑 — getStatusById 실행 중 준비된 SQL을 수집한다.
  const prepared = [];
  const spyDb = {
    prepare(sql) { prepared.push(sql); return db.prepare(sql); },
    exec(sql) { return db.exec(sql); },
  };
  const spyModel = createArticleModel(spyDb);

  assert.strictEqual(spyModel.getStatusById('AKR1'), 'DPS');
  assert.equal(prepared.length, 1, '쿼리는 1건뿐이다');
  const sql = prepared[0];
  assert.match(sql, /SELECT\s+status\s+FROM\s+Contents/i, 'Contents에서 status만 선택한다');
  assert.equal(sql.includes('*'), false, 'SELECT * 금지');
  assert.equal(sql.includes('Article'), false, 'Article 테이블 미접촉');
  assert.equal(sql.includes('markupVersion'), false, '본문 blob 미접촉');
});

test('articleModel: getStatusById 신설 후에도 getById는 { article, contents } 전 컬럼을 반환한다(회귀)', () => {
  const { articles } = setup();
  articles.insert(makeArticle('AKR1', { status: 'DPS' }));
  const row = articles.getById('AKR1');
  assert.ok(row.article && row.contents);
  assert.equal(row.article.markupVersion, '{"format":"yh-editor","version":1,"blocks":[]}', '본문 포함');
  for (const c of ['articleId', 'title', 'author', 'status', 'lockYN', 'department', 'createdAt']) {
    assert.ok(c in row.contents, `contents.${c} 포함`);
  }
});
