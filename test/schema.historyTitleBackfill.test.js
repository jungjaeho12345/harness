import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema, backfillHistoryTitles, HISTORY_TITLE_BACKFILL_BATCH } from '../src/db/schema.js';
import { snapshotTitle } from '../src/services/historyMeta.js';

// 블록 문서 헬퍼 — 실제 markupVersion 저장 형식({format,version,blocks})과 동형(historyMeta.test.js 관례).
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

function allRows(db) {
  return db.prepare('SELECT * FROM ArticleHistory ORDER BY id').all();
}

// 기본 주입 — 파생 규칙의 단일 출처(services/historyMeta.snapshotTitle)를 실제로 주입해 정합을 증명한다.
const derive = { deriveTitle: snapshotTitle };

// 케이스 1·14: 기본 백필 — 레거시 스냅샷 행의 빈 표시제목을 본문 첫 텍스트 줄로 채운다.
test('backfillHistoryTitles: 레거시 스냅샷 행 2건의 빈 표시제목을 채우고 채운 행 수를 반환한다', () => {
  const db = freshDb();
  const id1 = insertRow(db, { markupVersion: markup(textBlock('첫 기사 제목'), textBlock('본문')) });
  const id2 = insertRow(db, { markupVersion: markup(textBlock('둘째 기사 제목')) });

  const filled = backfillHistoryTitles(db, derive);

  assert.equal(filled, 2, '채운 행 수를 반환한다');
  assert.equal(titleOf(db, id1), '첫 기사 제목');
  assert.equal(titleOf(db, id2), '둘째 기사 제목');
});

// 케이스 2·14: 기존 값 무덮기 — 본문 첫 줄이 달라도 저장된 값은 그대로, 카운트에도 미포함.
test('backfillHistoryTitles: 이미 값이 있는 행은 재파생·덮어쓰기하지 않는다', () => {
  const db = freshDb();
  const kept = insertRow(db, {
    markupVersion: markup(textBlock('본문 첫 줄과 다른 제목')),
    snapshotTitle: '기존 제목',
  });
  const legacy = insertRow(db, { markupVersion: markup(textBlock('레거시 제목')) });

  const filled = backfillHistoryTitles(db, derive);

  assert.equal(filled, 1, '기존 값 행은 카운트에 들어가지 않는다');
  assert.equal(titleOf(db, kept), '기존 제목', '기존 값은 보존된다');
  assert.equal(titleOf(db, legacy), '레거시 제목');
});

// 케이스 3: 파생 결과가 빈 문자열이어도 ''를 저장한다(NULL 유지 금지 — 영구 미완 백필 방지).
test("backfillHistoryTitles: 첫 텍스트 블록이 공백뿐인 본문은 ''를 저장한다 (NULL 금지)", () => {
  const db = freshDb();
  const id = insertRow(db, { markupVersion: markup(textBlock('   '), textBlock('본문')) });

  backfillHistoryTitles(db, derive);

  assert.strictEqual(titleOf(db, id), '');
});

// 케이스 4: 멱등 — 2회차 채운 행 수 0 + 값 불변('' 행이 다시 UPDATE 대상이 되지 않는다는 것이 핵심).
test('backfillHistoryTitles: 멱등 — 2회차는 채운 행 수 0이고 저장된 값이 하나도 바뀌지 않는다', () => {
  const db = freshDb();
  insertRow(db, { markupVersion: markup(textBlock('제목')) });
  insertRow(db, { markupVersion: markup(textBlock('   ')) }); // ''로 저장되는 행 — 재대상화 금지의 핵심

  assert.equal(backfillHistoryTitles(db, derive), 2, '1회차는 2건');
  const after1 = allRows(db);

  assert.equal(backfillHistoryTitles(db, derive), 0, '2회차는 채운 행 수 0');
  assert.deepEqual(allRows(db), after1, '2회차 후 모든 값이 1회차와 동일하다');
});

// 케이스 5·14: 비스냅샷 행(markupVersion NULL/'') 무접촉.
test('backfillHistoryTitles: markupVersion이 NULL/빈 문자열인 행(상태 전이 등)은 건드리지 않는다', () => {
  const db = freshDb();
  const t1 = insertRow(db, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' });
  const t2 = insertRow(db, { markupVersion: '' });

  const filled = backfillHistoryTitles(db, derive);

  assert.equal(filled, 0, '비스냅샷 행은 카운트에 포함되지 않는다');
  assert.strictEqual(titleOf(db, t1), null);
  assert.strictEqual(titleOf(db, t2), null);
});

// 케이스 6: DB 비파괴 — 행 수 불변 + snapshotTitle 외 전 컬럼 불변(삭제·재작성 0).
test('backfillHistoryTitles: 비파괴 — 행 수가 같고 snapshotTitle 외의 모든 컬럼이 완전히 동일하다', () => {
  const db = freshDb();
  insertRow(db, { markupVersion: markup(textBlock('제목A')), actorUserId: 'kim' });
  insertRow(db, { eventType: 'distribute-failed', action: 'auto', targetId: 7, reason: 'spool-write-failed' });
  insertRow(db, { markupVersion: markup(textBlock('제목B')), snapshotTitle: '이미 있는 제목' });
  insertRow(db, { eventType: 'status', fromStatus: 'DPS', toStatus: 'CMP' });
  const before = allRows(db);

  backfillHistoryTitles(db, derive);

  const after = allRows(db);
  assert.equal(after.length, before.length, '행 수 불변(삭제 0)');
  for (let i = 0; i < before.length; i += 1) {
    const restBefore = { ...before[i] };
    const restAfter = { ...after[i] };
    delete restBefore.snapshotTitle;
    delete restAfter.snapshotTitle;
    assert.deepEqual(restAfter, restBefore, `id=${before[i].id} — snapshotTitle 외 컬럼 불변`);
  }
});

// 케이스 7: 파생 정합(단일 출처) — 저장값이 historyMeta.snapshotTitle 직접 호출 결과와 정확히 같다.
// 하드코딩한 기대 문자열이 아니라 함수 호출 결과와 대조한다(규칙을 복제하면 red가 되게).
test('backfillHistoryTitles: 저장값은 historyMeta.snapshotTitle(본문) 호출 결과와 정확히 같다', () => {
  const db = freshDb();
  const bodies = [
    // (a) 임베드 블록이 첫 원소인 블록 문서 — 텍스트 블록만 세는 규칙.
    markup({ type: 'embed', embedType: 'image', title: '사진 캡션', src: '/img/a.jpg' }, textBlock('진짜 제목')),
    // (b) 깨진 JSON — 평문 취급.
    '{',
    // (c) 평문 레거시 — 첫 줄.
    '제목줄\n본문',
    // (d) 첫 줄이 200자를 넘는 문서 — 절단 결과 일치.
    markup(textBlock('가'.repeat(300))),
  ];
  const ids = bodies.map((b) => insertRow(db, { markupVersion: b }));

  backfillHistoryTitles(db, derive);

  ids.forEach((id, i) => {
    assert.strictEqual(titleOf(db, id), snapshotTitle(bodies[i]), `본문[${i}] — 파생 규칙 단일 출처 정합`);
  });
});

// 케이스 8: 여러 기사 혼재 — 전역 백필(기사 인자 없음), 정확히 대상 행만 채운다.
test('backfillHistoryTitles: 여러 기사 혼재 — 레거시/신규/비스냅샷 중 대상 행만 채운다 (전역 1회)', () => {
  const db = freshDb();
  const legacyA = insertRow(db, { articleId: 'A', markupVersion: markup(textBlock('A 레거시')) });
  const newB = insertRow(db, { articleId: 'B', markupVersion: markup(textBlock('B 본문')), snapshotTitle: 'B 저장 제목' });
  const transC = insertRow(db, { articleId: 'C', eventType: 'status', fromStatus: 'RDS', toStatus: 'DPS' });
  const legacyC = insertRow(db, { articleId: 'C', markupVersion: '제목줄C\n본문' });

  const filled = backfillHistoryTitles(db, derive);

  assert.equal(filled, 2, '레거시 2건만 채운다');
  assert.equal(titleOf(db, legacyA), 'A 레거시');
  assert.equal(titleOf(db, newB), 'B 저장 제목', '신규 행은 무접촉');
  assert.strictEqual(titleOf(db, transC), null, '전이 행은 무접촉');
  assert.equal(titleOf(db, legacyC), '제목줄C');
});

// 케이스 9: 구버전 테이블 — 컬럼 없이 생성 + 레거시 행 → createSchema(ADD COLUMN) → 백필 정상 동작.
test('backfillHistoryTitles: 구버전 테이블(snapshotTitle 없음) → createSchema → 백필이 그 행을 채운다', () => {
  const db = new DatabaseSync(':memory:');
  // 옛 버전: 표시제목 컬럼이 없는 ArticleHistory + 기존 행 (schema.test.js 437~453행 패턴).
  db.exec(
    'CREATE TABLE ArticleHistory (id INTEGER PRIMARY KEY, articleId VARCHAR, eventType VARCHAR, action VARCHAR, fromStatus VARCHAR, toStatus VARCHAR, actorUserId VARCHAR, createdAt VARCHAR, markupVersion VARCHAR)',
  );
  db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, createdAt, markupVersion) VALUES ('a1', 'edit', '2026-08-10T00:00:00Z', '제목줄\n본문')",
  ).run();

  createSchema(db); // snapshotTitle 컬럼이 이때 additive하게 추가된다.
  const filled = backfillHistoryTitles(db, derive);

  assert.equal(filled, 1);
  assert.equal(
    db.prepare("SELECT snapshotTitle FROM ArticleHistory WHERE articleId='a1'").get().snapshotTitle,
    '제목줄',
  );
});

// 케이스 10: 배치 경계 — 상수*2+1건이 1회 실행으로 전부 채워진다(배치 루프가 중간에 멈추지 않는다).
test('backfillHistoryTitles: 배치 경계 — HISTORY_TITLE_BACKFILL_BATCH*2+1건을 1회 실행으로 전부 채운다', () => {
  const db = freshDb();
  const total = HISTORY_TITLE_BACKFILL_BATCH * 2 + 1;
  const ins = db.prepare(
    "INSERT INTO ArticleHistory (articleId, eventType, createdAt, markupVersion) VALUES ('a1', 'edit', '2026-08-01T00:00:00Z', ?)",
  );
  for (let i = 1; i <= total; i += 1) ins.run(`제목 ${i}\n본문`);

  assert.equal(backfillHistoryTitles(db, derive), total, '전부 채우고 그 행 수를 반환한다');
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM ArticleHistory WHERE snapshotTitle IS NULL').get().n,
    0,
    'NULL로 남은 행이 없다',
  );
  assert.equal(titleOf(db, total), `제목 ${total}`, '마지막 배치의 마지막 행까지 채워진다');
  assert.equal(backfillHistoryTitles(db, derive), 0, '2회차는 0 (멱등)');
});

// 케이스 11: 주입 계약 — deriveTitle 미주입/비함수는 TypeError(조용한 no-op 금지), DB 무변경.
test('backfillHistoryTitles: deriveTitle 미주입/비함수는 TypeError를 throw하고 DB를 바꾸지 않는다', () => {
  const db = freshDb();
  const id = insertRow(db, { markupVersion: markup(textBlock('제목')) });
  const before = allRows(db);

  assert.throws(() => backfillHistoryTitles(db), TypeError, '옵션 자체 미전달');
  assert.throws(() => backfillHistoryTitles(db, {}), TypeError, 'deriveTitle 미주입');
  assert.throws(() => backfillHistoryTitles(db, { deriveTitle: 'not-a-function' }), TypeError, '비함수');

  assert.deepEqual(allRows(db), before, 'DB 무변경');
  assert.strictEqual(titleOf(db, id), null);
});

// 케이스 12·14: 비문자열 파생값 행은 건너뛴다(NULL 유지·카운트 제외·throw 금지) —
// 이어서 2회차 실행이 0·값 불변이어야 한다. 커서 없이 구현하면 NULL로 남은 행이
// 매 배치 다시 잡혀 이 케이스가 무한 루프로 red가 된다.
test('backfillHistoryTitles: 비문자열 파생값 행은 건너뛰고 나머지는 채운다 — 2회차도 0·값 불변', () => {
  const db = freshDb();
  const skip = insertRow(db, { markupVersion: 'SKIP-ME\n본문' });
  const ok1 = insertRow(db, { markupVersion: '제목1\n본문' });
  const ok2 = insertRow(db, { markupVersion: '제목2\n본문' });
  const fake = (mv) => (String(mv).startsWith('SKIP-ME') ? undefined : String(mv).split('\n')[0]);

  const first = backfillHistoryTitles(db, { deriveTitle: fake });

  assert.equal(first, 2, '건너뛴 행은 카운트에서 빠진다');
  assert.strictEqual(titleOf(db, skip), null, '건너뛴 행은 NULL 유지(조회 폴백이 표시를 처리)');
  assert.equal(titleOf(db, ok1), '제목1', '같은 실행의 다른 행은 정상적으로 채워진다');
  assert.equal(titleOf(db, ok2), '제목2');

  const after1 = allRows(db);
  const second = backfillHistoryTitles(db, { deriveTitle: fake });
  assert.equal(second, 0, '멱등 — 채운 행 수 0(건너뛴 행이 SELECT에 다시 잡혀도 UPDATE·카운트 0)');
  assert.deepEqual(allRows(db), after1, '값 불변');
});

// 케이스 13: 비문자열 본문 행(TEXT affinity 저장)도 대상이다 — phase 58 기록 게이트보다 넓다(gap 봉합).
test('backfillHistoryTitles: 비문자열 본문 행(TEXT affinity)도 채운다 — 백필 대상은 컬럼 도입 이전 행만이 아니다', () => {
  const db = freshDb();
  // 숫자 바인딩 → VARCHAR(TEXT affinity)로 '12345' 저장. length > 0이지만
  // phase 58 기록 게이트(typeof === 'string')는 통과하지 못해 제목이 NULL로 남는 행.
  const id = insertRow(db, { markupVersion: 12345 });
  const stored = db.prepare('SELECT markupVersion FROM ArticleHistory WHERE id = ?').get(id).markupVersion;
  assert.equal(typeof stored, 'string', '전제: DB에서 읽으면 문자열로 돌아온다');

  const filled = backfillHistoryTitles(db, derive);

  assert.equal(filled, 1, '기록 게이트보다 넓은 술어 — 이 행도 대상이다');
  assert.strictEqual(titleOf(db, id), snapshotTitle(stored), '저장값은 DB에서 읽은 값의 파생 결과와 같다');
});

// 케이스 14: 반환값 의미 — 채울 게 없으면 0(빈 테이블·전부 값 있음 모두).
test('backfillHistoryTitles: 채울 게 없으면 0을 반환한다', () => {
  const db = freshDb();
  assert.equal(backfillHistoryTitles(db, derive), 0, '빈 테이블은 0');
  insertRow(db, { markupVersion: markup(textBlock('제목')), snapshotTitle: '제목' });
  assert.equal(backfillHistoryTitles(db, derive), 0, '전부 값이 있으면 0');
});
