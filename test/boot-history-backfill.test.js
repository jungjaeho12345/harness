import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createArticleService } from '../src/services/articleService.js';
import { snapshotTitle } from '../src/services/historyMeta.js';
import { runHistoryTitleBackfill } from '../server/index.js';

// 블록 문서 헬퍼 — 실제 markupVersion 저장 형식({format,version,blocks})과 동형.
function markup(...blocks) {
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}
function textBlock(text) {
  return { type: 'text', text };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  return db;
}

// 이력 행 삽입 — undefined 컬럼은 INSERT에서 제외(→ NULL 유지). 새 행의 id를 반환한다.
function insertRow(db, { articleId = 'a1', eventType = 'edit', createdAt = '2026-08-01T00:00:00Z', ...rest } = {}) {
  const obj = { articleId, eventType, createdAt, ...rest };
  const cols = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const ph = cols.map(() => '?').join(', ');
  return Number(
    db.prepare(`INSERT INTO ArticleHistory (${cols.join(', ')}) VALUES (${ph})`)
      .run(...cols.map((k) => obj[k])).lastInsertRowid,
  );
}

function titleOf(db, id) {
  return db.prepare('SELECT snapshotTitle FROM ArticleHistory WHERE id = ?').get(id).snapshotTitle;
}

// 가짜 logService — 전 레벨을 한 배열에 모아 줄 수·내용을 단언한다(csrf-origin.test.js의 fakeLog 관례).
function fakeLog() {
  const lines = [];
  return {
    lines,
    debug: (m) => lines.push(['DEBUG', m]),
    info: (m) => lines.push(['INFO', m]),
    warn: (m) => lines.push(['WARN', m]),
    error: (m) => lines.push(['ERROR', m]),
  };
}

// 케이스 1: 기본 결선 — deriveTitle 없이 호출하면 services의 단일 출처(historyMeta.snapshotTitle)를 쓴다.
test('runHistoryTitleBackfill: deriveTitle 미주입 시 기본 결선이 historyMeta.snapshotTitle을 쓴다', () => {
  const db = freshDb();
  const bodyA = markup(textBlock('첫 기사 제목'), textBlock('본문'));
  const bodyB = markup(
    { type: 'embed', embedType: 'image', title: '사진 캡션', src: '/img/a.jpg' },
    textBlock('둘째 기사 제목'),
  );
  const id1 = insertRow(db, { markupVersion: bodyA });
  const id2 = insertRow(db, { markupVersion: bodyB });

  const filled = runHistoryTitleBackfill({ db, logService: fakeLog() });

  assert.equal(filled, 2, '반환값은 채운 행 수');
  assert.strictEqual(titleOf(db, id1), snapshotTitle(bodyA), '단일 출처 파생 결과와 정확히 같다');
  assert.strictEqual(titleOf(db, id2), snapshotTitle(bodyB), '임베드 선행 문서도 단일 출처와 같다');
});

// 케이스 2: 0건이면 로그 0줄 — 0은 신호가 아니다(매 부트 0건 로그는 링 버퍼 영구 소음).
test('runHistoryTitleBackfill: 채운 행이 0건이면 로그를 한 줄도 남기지 않는다', () => {
  const db = freshDb();
  insertRow(db, { eventType: 'status', fromStatus: 'RDS', toStatus: 'DPS' }); // 비스냅샷 행뿐
  const log = fakeLog();

  const filled = runHistoryTitleBackfill({ db, logService: log });

  assert.equal(filled, 0);
  assert.equal(log.lines.length, 0, '0건 로그 금지 — 부트 소음');
});

// 케이스 3: 1건 이상이면 INFO 정확히 1줄 — 건수만 담고 제목·본문은 담지 않는다(LOGS.md 마스킹).
test('runHistoryTitleBackfill: 채운 건수를 INFO 1줄로 남기고 본문·제목 문자열은 싣지 않는다', () => {
  const db = freshDb();
  // 표식이 첫 줄(=파생 제목)에 들어가게 심는다 — 제목을 로그에 덧붙이는 회귀도 이 단언에 걸리게.
  insertRow(db, { markupVersion: markup(textBlock('MARK-BODY-SECRET 제목'), textBlock('본문')) });
  insertRow(db, { markupVersion: markup(textBlock('둘째 제목')) });
  const log = fakeLog();

  runHistoryTitleBackfill({ db, logService: log });

  assert.equal(log.lines.length, 1, '정확히 1줄');
  const [level, message] = log.lines[0];
  assert.equal(level, 'INFO');
  assert.match(message, /2/, '채운 건수가 메시지에 있다');
  for (const [, m] of log.lines) {
    assert.ok(!String(m).includes('MARK-BODY-SECRET'), '본문/제목 문자열은 어떤 로그 줄에도 없다');
  }
});

// 케이스 4: logService 미주입에도 동작한다(백필 자체가 로그에 묶이지 않는다).
test('runHistoryTitleBackfill: logService 미주입에도 throw 없이 백필을 수행한다', () => {
  const db = freshDb();
  const id = insertRow(db, { markupVersion: markup(textBlock('제목')) });

  const filled = runHistoryTitleBackfill({ db });

  assert.equal(filled, 1);
  assert.strictEqual(titleOf(db, id), '제목');
});

// 케이스 5: 멱등 결선 — 2회차는 채운 행 수 0·추가 로그 0줄·값 불변("대상 0건"이 아니라 "채운 행 수 0"이 계약).
test('runHistoryTitleBackfill: 2회 호출 시 2회차는 채운 행 수 0, 추가 로그 0줄, 값 불변', () => {
  const db = freshDb();
  insertRow(db, { markupVersion: markup(textBlock('제목')) });
  insertRow(db, { markupVersion: markup(textBlock('   ')) }); // ''로 저장되는 행 포함
  const log = fakeLog();

  assert.equal(runHistoryTitleBackfill({ db, logService: log }), 2);
  const linesAfter1 = log.lines.length;
  const rowsAfter1 = db.prepare('SELECT * FROM ArticleHistory ORDER BY id').all();

  assert.equal(runHistoryTitleBackfill({ db, logService: log }), 0, '2회차 채운 행 수 0');
  assert.equal(log.lines.length, linesAfter1, '2회차 추가 로그 0줄');
  assert.deepEqual(db.prepare('SELECT * FROM ArticleHistory ORDER BY id').all(), rowsAfter1, '값 불변');
});

// 케이스 6 E2E 시드 — 레거시 3건(임베드 선행 1건 + 200자 초과 1건 필수) + 신규 1건 + 전이 1건.
// 임베드 선행·200자 절단은 파생 규칙이 백필 경로에서 복제·단순화되면 제목이 달라지는 입력이다.
function seedE2E(db, articleId = 'AKR-E2E') {
  const legacy1 = markup(
    { type: 'embed', embedType: 'image', title: '사진 캡션', src: '/img/a.jpg' },
    textBlock('임베드 뒤 진짜 제목'),
  );
  const legacy2 = markup(textBlock('가'.repeat(300)), textBlock('본문'));
  const legacy3 = markup(textBlock('셋째 레거시 제목'), textBlock('본문'));
  const bodyNew = markup(textBlock('신규 경로 제목'), textBlock('본문'));
  insertRow(db, { articleId, markupVersion: legacy1, createdAt: '2026-08-01T00:00:01Z' });
  insertRow(db, { articleId, markupVersion: legacy2, createdAt: '2026-08-01T00:00:02Z' });
  insertRow(db, {
    articleId, eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS', createdAt: '2026-08-01T00:00:03Z',
  });
  insertRow(db, { articleId, markupVersion: legacy3, createdAt: '2026-08-01T00:00:04Z' });
  // phase 58 경로로 저장된 신규 행 — 기록 시점 파생 제목이 함께 저장돼 있다.
  insertRow(db, {
    articleId, markupVersion: bodyNew, snapshotTitle: snapshotTitle(bodyNew), createdAt: '2026-08-01T00:00:05Z',
  });
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const service = createArticleService({ articleModel, db, historyModel });
  return { articleId, historyModel, service };
}

// 케이스 6: E2E 실측 — 백필 후 조회에 실리는 blob이 0건이 되고 queryHistory 결과는 완전히 동일하다.
test('runHistoryTitleBackfill: E2E — 백필 후 blob 적재 3→0, queryHistory는 백필 전과 deep equal', () => {
  const db = freshDb();
  const { articleId, historyModel, service } = seedE2E(db);

  const blobsBefore = historyModel.querySnapshotTitlesByArticle(articleId)
    .filter((s) => s.markupVersion !== null);
  assert.equal(blobsBefore.length, 3, '백필 전: 레거시 3건의 blob이 실려 온다');
  const before = service.queryHistory(articleId);
  assert.equal(before.length, 5, '전제: 이력 5건');

  runHistoryTitleBackfill({ db });

  const blobsAfter = historyModel.querySnapshotTitlesByArticle(articleId)
    .filter((s) => s.markupVersion !== null);
  assert.equal(blobsAfter.length, 0, '백필 후: 조회에 실리는 blob 0건 — 이 phase의 목적');
  assert.deepEqual(service.queryHistory(articleId), before, '표시(제목·버전·상태·키 집합)는 그대로 — 바뀌면 회귀');
});

// 케이스 7: sendOnly 필터 경로도 백필 전후 동일 — 파생 승계가 필터 전에 전체 이력 기준으로 돈다.
test('runHistoryTitleBackfill: E2E — queryHistory(sendOnly)도 백필 전후 deep equal', () => {
  const db = freshDb();
  const { articleId, service } = seedE2E(db);
  const before = service.queryHistory(articleId, { sendOnly: true });
  assert.equal(before.length, 1, '전제: 송고 전이 1건');

  runHistoryTitleBackfill({ db });

  assert.deepEqual(service.queryHistory(articleId, { sendOnly: true }), before);
});

// 케이스 8: 빈 제목 레거시 행 — ''가 저장돼도 표시 제목은 백필 전(폴백 파생 '')과 같고 blob은 더 안 실린다.
test('runHistoryTitleBackfill: E2E — 첫 줄이 공백뿐인 레거시 행도 표시 동일 + blob 미적재', () => {
  const db = freshDb();
  const articleId = 'AKR-BLANK';
  const rowId = insertRow(db, { articleId, markupVersion: markup(textBlock('   '), textBlock('본문')) });
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const service = createArticleService({ articleModel, db, historyModel });

  const before = service.queryHistory(articleId);
  assert.equal(before[0].title, '', '백필 전: 폴백 파생 제목이 빈 문자열');

  runHistoryTitleBackfill({ db });

  assert.strictEqual(titleOf(db, rowId), '', "''가 저장된다(NULL 금지)");
  assert.deepEqual(service.queryHistory(articleId), before, '표시 제목은 백필 전과 동일');
  const blobs = historyModel.querySnapshotTitlesByArticle(articleId)
    .filter((s) => s.markupVersion !== null);
  assert.equal(blobs.length, 0, "'' 저장이 폴백을 되살리지 않는다 — blob 0건");
});
