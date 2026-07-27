// 배부 실행 서비스 테스트 — 실디스크·네트워크·타이머 없이 검증한다(ADR-008: 파일 스풀 outbound).
// 하네스: in-memory DatabaseSync + 실제 모델 3종 + step0 createSpoolWriter에 가짜 fs 주입 + 고정 시계.
// CRITICAL 계약 4가지(완화 금지 — 실패하면 구현을 고쳐라):
//  ① distribute는 동기이고 어떤 입력에도 throw하지 않는다(상위 송고 경로를 실패시키면 안 된다).
//  ② 스풀 파일이 하나도 안 나갔으면 DB를 건드리지 않는다(배부시간 stamp·이력 모두 없음).
//  ③ Contents.distributedAt은 최초 1회만 stamp한다(재배부·2차 엠바고 2회 배부에도 최초 값 유지).
//  ④ 배부 1회 = 이력 1행(수신처 수와 무관)이며 송고이력 필터에 섞이지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createDistributionTargetModel } from '../src/models/distributionTargetModel.js';
import { createArticleService } from '../src/services/articleService.js';
import { createSpoolWriter } from '../src/services/spoolWriter.js';
import { createDistributionService } from '../src/services/distributionService.js';

const ROOT = '/spool/dist';
const NOW = '2026-07-27T09:00:00.000Z';
const COMPACT = '20260727T090000000Z'; // NOW에서 - : . 만 제거한 형태(파일명)
const ARTICLE_ID = 'AKR20260727000000001';
const MARKUP = '{"format":"yh-editor","version":1,"blocks":[{"type":"text","text":"본문 한 줄"},{"type":"text","text":"(끝)"}]}';
const TITLE = '기사 제목 — 태풍 북상';
const SECRET = '내부메모비밀';

// 기대 경로는 반드시 join으로 만든다 — Windows에서 join('/spool','kbs')는 '\spool\kbs'다(하드코딩 금지).
const fileFor = (dir, id = ARTICLE_ID, ts = COMPACT) => join(ROOT, dir, `${id}__${ts}.json`);

// in-memory fs. failWrite/failMkdir는 (path, 호출순번)을 받아 true면 그 호출만 throw시킨다.
function fakeFs({ failWrite = null, failMkdir = null } = {}) {
  const files = new Map(); // path -> { data, enc }
  const dirs = []; // mkdirSync 호출 인자 기록
  let mkdirN = 0;
  let writeN = 0;
  return {
    files,
    dirs,
    fs: {
      mkdirSync: (dir, opts) => {
        mkdirN += 1;
        dirs.push({ dir, opts });
        if (failMkdir && failMkdir(dir, mkdirN)) throw new Error(`EPERM: ${dir}`);
      },
      writeFileSync: (p, data, enc) => {
        writeN += 1;
        if (failWrite && failWrite(p, writeN)) throw new Error(`EACCES: ${p}`);
        files.set(p, { data, enc });
      },
    },
  };
}

function fakeLogger() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const push = (lv) => (m) => { lines[lv].push(m); };
  return { lines, logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') } };
}

const DEFAULT_TARGETS = [
  { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
  { name: '기업홍보', kind: 'nonpress', spoolDir: 'corp' },
];

function setup({
  rootDir = ROOT,
  fsOver = {},
  targets = DEFAULT_TARGETS,
  contents = {},
  seed = true,
  withHistory = true,
  historyModel: historyOverride,
  spoolWriter: writerOverride,
  logger = null,
  now = () => NOW,
} = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const targetModel = createDistributionTargetModel(db);

  if (seed) {
    articleModel.insert({
      article: { articleId: ARTICLE_ID, title: 'Article쪽 제목', markupVersion: MARKUP, modifier: 'kim' },
      contents: {
        articleId: ARTICLE_ID,
        title: TITLE,
        author: '김기자',
        department: '사회부',
        departmentCode: '10',
        createdAt: '2026-07-27T08:00:00.000Z',
        sentAt: '2026-07-27T08:59:00.000Z',
        status: 'DPS',
        internalComment: SECRET,
        externalComment: '외부코멘트',
        lockYN: 'N',
        ...contents,
      },
    });
  }
  const targetIds = targets.map((t) => targetModel.insert({
    active: 'Y', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', ...t,
  }));

  const h = fakeFs(fsOver);
  const writer = writerOverride === undefined ? createSpoolWriter({ rootDir, fs: h.fs }) : writerOverride;

  // 모델 호출 계수 — "DB를 건드리지 않는다"는 계약을 호출 0회로 단언하기 위한 스파이.
  const calls = { getById: 0, update: 0, query: 0 };
  const spyArticleModel = {
    getById: (id) => { calls.getById += 1; return articleModel.getById(id); },
    update: (id, patch) => { calls.update += 1; return articleModel.update(id, patch); },
  };
  const spyTargetModel = {
    query: (f) => { calls.query += 1; return targetModel.query(f); },
  };

  const service = createDistributionService({
    articleModel: spyArticleModel,
    distributionTargetModel: spyTargetModel,
    historyModel: historyOverride !== undefined ? historyOverride : (withHistory ? historyModel : null),
    spoolWriter: writer,
    now,
    logger,
  });

  return { db, articleModel, historyModel, targetModel, targetIds, service, h, calls };
}

const historyRows = (db) => db.prepare('SELECT * FROM ArticleHistory WHERE articleId = ? ORDER BY id').all(ARTICLE_ID);
const contentsRow = (db) => db.prepare('SELECT * FROM Contents WHERE articleId = ?').get(ARTICLE_ID);

// ── A. 대상 선택 ────────────────────────────────────────────────────────────

test('대상: audience=all이면 활성 언론사+비언론사 폴더에 각각 1개씩 기록된다', () => {
  const { service, h } = setup();
  const r = service.distribute(ARTICLE_ID, 'all');

  assert.deepEqual(r, { ok: true, attempted: 2, written: 2, failures: [], distributedAt: NOW });
  assert.equal(h.files.size, 2);
  assert.ok(h.files.has(fileFor('kbs')), '언론사 폴더에 파일');
  assert.ok(h.files.has(fileFor('corp')), '비언론사 폴더에 파일');
});

test('대상: audience=press면 언론사 폴더만 쓴다(비언론사 폴더는 mkdir조차 하지 않는다)', () => {
  const { service, h } = setup();
  const r = service.distribute(ARTICLE_ID, 'press');

  assert.deepEqual(r, { ok: true, attempted: 1, written: 1, failures: [], distributedAt: NOW });
  assert.equal(h.files.size, 1);
  assert.ok(h.files.has(fileFor('kbs')));
  assert.deepEqual(h.dirs.map((d) => d.dir), [join(ROOT, 'kbs')], '비언론사 폴더는 만들지 않는다');
});

test('대상: active가 정확히 Y가 아닌 행은 제외된다(엄격 판정 — 관대 판정과 의도적으로 다르다)', () => {
  const { service, h } = setup({
    targets: [
      { name: '해지', kind: 'press', spoolDir: 'gone', active: 'N' },   // soft delete
      { name: '널', kind: 'press', spoolDir: 'nullish', active: null }, // 직접 SQL 손상 행
      { name: '소문자', kind: 'press', spoolDir: 'lower', active: 'y' },
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
    ],
  });
  const r = service.distribute(ARTICLE_ID, 'all');

  assert.equal(r.attempted, 1);
  assert.equal(r.written, 1);
  assert.equal(h.files.size, 1);
  assert.ok(h.files.has(fileFor('kbs')));
});

test('대상: 알 수 없는 kind(레거시/직접 SQL)는 어떤 audience에도 포함되지 않는다', () => {
  const options = {
    targets: [
      { name: '기타', kind: 'other', spoolDir: 'other' },
      { name: '널', kind: null, spoolDir: 'nokind' },
      { name: '대문자', kind: 'PRESS', spoolDir: 'upper' },
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
    ],
  };
  for (const audience of ['all', 'press']) {
    const { service, h } = setup(options);
    const r = service.distribute(ARTICLE_ID, audience);
    assert.equal(r.attempted, 1, `${audience}: 화이트리스트 kind만 대상이다`);
    assert.equal(h.files.size, 1);
    assert.ok(h.files.has(fileFor('kbs')));
  }
});

test('대상: audience=press인데 활성 언론사가 0건이면 비언론사로 대체 배부하지 않는다', () => {
  // 2차 엠바고 기사의 즉시 배부 경로다 — 언론사 수신처가 없다고 비언론사로 흘러가면 엠바고 파기다.
  // 대상 0건은 에러가 아니라 "아무것도 하지 않음"이며 DB도 건드리지 않는다.
  const { service, db, h, calls } = setup({
    targets: [{ name: '기업홍보', kind: 'nonpress', spoolDir: 'corp' }],
  });
  const r = service.distribute(ARTICLE_ID, 'press');

  assert.deepEqual(r, { ok: true, attempted: 0, written: 0, failures: [], distributedAt: null });
  assert.equal(h.files.size, 0);
  assert.equal(h.dirs.length, 0, '비언론사 폴더는 mkdir조차 하지 않는다');
  assert.equal(calls.update, 0);
  assert.equal(contentsRow(db).distributedAt, null);
  assert.equal(historyRows(db).length, 0);
});

test('audience: 알 수 없는 값은 invalid-audience이고 DB·fs를 전혀 건드리지 않는다', () => {
  // 'nonpress'는 phase 48 소관이라 지금은 거부다. 프로토타입 키('__proto__' 등)가 대상군을 얻으면 오발송이다.
  const bads = [
    'nonpress', 'ALL', 'All', 'PRESS', 'press ', ' all', '', 'both', undefined, null, 0, 1, true,
    {}, ['press'], '__proto__', 'constructor', 'toString', 'hasOwnProperty',
  ];
  for (const bad of bads) {
    const { service, h, calls } = setup();
    assert.deepEqual(
      service.distribute(ARTICLE_ID, bad),
      { ok: false, reason: 'invalid-audience' },
      `거부되어야 함: ${JSON.stringify(bad)}`,
    );
    assert.equal(h.files.size, 0);
    assert.equal(h.dirs.length, 0);
    assert.equal(calls.getById, 0, 'DB 조회에 도달하면 안 된다');
    assert.equal(calls.query, 0);
    assert.equal(calls.update, 0);
  }
  // 인자 자체가 없어도 같은 거부다(throw 없음).
  const { service } = setup();
  assert.deepEqual(service.distribute(), { ok: false, reason: 'invalid-audience' });
});

test('기사: 없는 articleId는 not-found이고 fs 접촉 0이다', () => {
  const { service, h, calls } = setup();
  assert.deepEqual(service.distribute('AKR00000000000000000', 'all'), { ok: false, reason: 'not-found' });
  assert.equal(h.files.size, 0);
  assert.equal(h.dirs.length, 0);
  assert.equal(calls.update, 0);
});

test('기사: Article 행이 없는 손상 기사는 not-found다(본문 없는 기사를 외부로 내보내지 않는다)', () => {
  const { service, h, db } = setup({ seed: false });
  db.prepare('INSERT INTO Contents (articleId, title, status) VALUES (?, ?, ?)')
    .run(ARTICLE_ID, TITLE, 'DPS');

  assert.deepEqual(service.distribute(ARTICLE_ID, 'all'), { ok: false, reason: 'not-found' });
  assert.equal(h.files.size, 0, '본문 없는 기사가 스풀에 나가면 안 된다');
  assert.equal(h.dirs.length, 0);
  assert.equal(contentsRow(db).distributedAt, null);
});

test('기사: Contents 행이 없는 손상 기사도 not-found다', () => {
  const { service, h, db } = setup({ seed: false });
  db.prepare('INSERT INTO Article (articleId, title, markupVersion) VALUES (?, ?, ?)')
    .run(ARTICLE_ID, TITLE, MARKUP);

  assert.deepEqual(service.distribute(ARTICLE_ID, 'all'), { ok: false, reason: 'not-found' });
  assert.equal(h.files.size, 0);
});

test('대상: 같은 spoolDir을 가진 활성 대상 2건은 앞선 것만 배부된다(덮어쓰기·과대보고 방지)', () => {
  const { service, h, targetIds } = setup({
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'KBS복제', kind: 'nonpress', spoolDir: 'kbs' }, // 직접 SQL로만 가능한 상태
    ],
  });
  const r = service.distribute(ARTICLE_ID, 'all');

  assert.equal(r.ok, true);
  assert.equal(r.attempted, 2);
  assert.equal(r.written, 1, '덮어쓰기를 배부 2건으로 과대 보고하면 안 된다');
  assert.deepEqual(r.failures, [{ targetId: targetIds[1], spoolDir: 'kbs', reason: 'duplicate-spool-dir' }]);
  assert.equal(h.files.size, 1);
  // id 오름차순이라 앞선 대상이 이긴다(결정적).
  assert.equal(JSON.parse(h.files.get(fileFor('kbs')).data).target.name, 'KBS');
});

test('대상: 앞 대상이 write 실패면 같은 spoolDir의 뒤 대상은 skip되지 않는다(성공 시에만 중복 집합)', () => {
  const { service, h, targetIds } = setup({
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'KBS복제', kind: 'nonpress', spoolDir: 'kbs' },
    ],
    fsOver: { failWrite: (p, n) => n === 1 }, // 첫 쓰기만 실패
  });
  const r = service.distribute(ARTICLE_ID, 'all');

  assert.equal(r.attempted, 2);
  assert.equal(r.written, 1, '앞 대상 실패 때문에 배부 가능한 수신처를 놓치면 안 된다');
  assert.deepEqual(r.failures, [{ targetId: targetIds[0], spoolDir: 'kbs', reason: 'write-failed' }]);
  assert.equal(h.files.size, 1);
  assert.equal(JSON.parse(h.files.get(fileFor('kbs')).data).target.name, 'KBS복제');
});

// ── B. 스풀 payload ─────────────────────────────────────────────────────────

test('payload: 기록된 파일이 스풀 포맷(schema/audience/target/article)과 일치한다', () => {
  const { service, h } = setup();
  service.distribute(ARTICLE_ID, 'all');

  const doc = JSON.parse(h.files.get(fileFor('kbs')).data);
  assert.equal(doc.schema, 'yh-dist-article');
  assert.equal(doc.version, 1);
  assert.equal(doc.audience, 'all');
  assert.equal(doc.distributedAt, NOW);
  assert.deepEqual(doc.target, { id: 1, name: 'KBS', kind: 'press', spoolDir: 'kbs' });
  assert.equal(doc.article.articleId, ARTICLE_ID);
  assert.equal(doc.article.markupVersion, MARKUP, '본문은 원문 문자열 그대로다');
  assert.equal(doc.article.title, TITLE, '제목은 Contents가 정본이다');
  assert.equal(doc.article.author, '김기자');
  assert.equal(doc.article.status, 'DPS');

  const other = JSON.parse(h.files.get(fileFor('corp')).data);
  assert.deepEqual(other.target, { id: 2, name: '기업홍보', kind: 'nonpress', spoolDir: 'corp' });
  assert.equal(other.audience, 'all');
});

test('시계: now()는 배부 1회에 한 번만 호출되어 모든 대상 파일이 같은 타임스탬프를 쓴다', () => {
  // 호출마다 다른 값을 주는 시계 — 대상마다 now()를 부르면 파일명·payload가 갈라진다.
  let n = 0;
  const clock = () => { n += 1; return `2026-07-27T09:00:0${n}.000Z`; };
  const { service, h } = setup({ now: clock });

  const r = service.distribute(ARTICLE_ID, 'all');
  assert.equal(n, 1, 'now()는 정확히 한 번만 호출된다');
  assert.equal(r.distributedAt, '2026-07-27T09:00:01.000Z');
  assert.equal(h.files.size, 2);

  const stamps = new Set([...h.files.values()].map((f) => JSON.parse(f.data).distributedAt));
  assert.deepEqual([...stamps], ['2026-07-27T09:00:01.000Z']);
  assert.ok(h.files.has(fileFor('kbs', ARTICLE_ID, '20260727T090001000Z')));
  assert.ok(h.files.has(fileFor('corp', ARTICLE_ID, '20260727T090001000Z')));
});

test('payload: 내부코멘트 등 제외 필드는 배부 파일에 담기지 않는다(보안 계약 회귀 잠금)', () => {
  const { service, h } = setup();
  service.distribute(ARTICLE_ID, 'all');

  for (const f of h.files.values()) {
    assert.ok(!f.data.includes(SECRET), '내부코멘트가 유출되면 안 된다');
    assert.ok(!f.data.includes('"internalComment"'));
    assert.ok(!f.data.includes('"lockYN"'));
    assert.equal(f.enc, 'utf8');
  }
});

// ── C. distributedAt 정책 ───────────────────────────────────────────────────

test('배부시간: 기록 성공 후 Contents.distributedAt이 주입 시계 값으로 stamp된다', () => {
  const { service, db, calls } = setup();
  assert.equal(contentsRow(db).distributedAt, null);

  service.distribute(ARTICLE_ID, 'all');
  assert.equal(contentsRow(db).distributedAt, NOW);
  assert.equal(calls.update, 1, 'stamp는 update 1회다');
});

test('배부시간: 이미 값이 있으면 갱신하지 않는다(재배부·2차 엠바고 2회 배부에도 최초 값 유지)', () => {
  const FIRST = '2026-01-01T00:00:00.000Z';
  const { service, db, h, calls } = setup({ contents: { distributedAt: FIRST } });

  const r = service.distribute(ARTICLE_ID, 'all');
  assert.equal(r.distributedAt, NOW, '반환값은 이번 배부 지시 시각이다');
  assert.equal(contentsRow(db).distributedAt, FIRST, 'DB의 최초 배부 시각은 불변이다');
  assert.equal(calls.update, 0, '갱신하지 않을 때는 UPDATE 자체를 하지 않는다');
  assert.equal(h.files.size, 2, '파일은 새 타임스탬프로 다시 나간다(정정본 배부 허용)');
  assert.equal(JSON.parse(h.files.get(fileFor('kbs')).data).distributedAt, NOW);
});

test('배부시간: written===0이면 stamp하지 않는다(대상 0건 / 비활성 / 전량 실패)', () => {
  const cases = [
    ['대상 0건', { targets: [] }],
    ['비활성', { rootDir: '' }],
    ['전량 실패', { fsOver: { failWrite: () => true } }],
  ];
  for (const [label, options] of cases) {
    const { service, db, calls } = setup(options);
    const r = service.distribute(ARTICLE_ID, 'all');
    assert.equal(r.ok, true, label);
    assert.equal(r.written, 0, label);
    assert.equal(r.distributedAt, null, `${label}: 지시 시각을 보고하면 안 된다`);
    assert.equal(contentsRow(db).distributedAt, null, `${label}: 배부시간이 찍히면 안 된다`);
    assert.equal(calls.update, 0, `${label}: DB 쓰기 0회`);
    assert.equal(historyRows(db).length, 0, `${label}: 이력 0행`);
  }
});

test('배부시간: stamp가 다른 Contents 컬럼과 Article 행을 건드리지 않는다', () => {
  const { service, db } = setup();
  const before = contentsRow(db);
  const beforeArticle = db.prepare('SELECT * FROM Article WHERE articleId = ?').get(ARTICLE_ID);

  service.distribute(ARTICLE_ID, 'all');

  const after = contentsRow(db);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const key of Object.keys(before)) {
    if (key === 'distributedAt') continue;
    assert.deepEqual(after[key], before[key], `${key}이 변경되면 안 된다`);
  }
  assert.equal(before.distributedAt, null);
  assert.equal(after.distributedAt, NOW);
  assert.deepEqual(db.prepare('SELECT * FROM Article WHERE articleId = ?').get(ARTICLE_ID), beforeArticle);
});

// ── D. 이력 ─────────────────────────────────────────────────────────────────

test('이력: 배부 1회에 eventType=distribute 1행이 append된다(action=대상군, createdAt=배부 지시 시각)', () => {
  const { service, db } = setup();
  service.distribute(ARTICLE_ID, 'all', { actorUserId: 'desk' });

  const rows = historyRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventType, 'distribute');
  assert.equal(rows[0].action, 'all');
  assert.equal(rows[0].fromStatus, null);
  assert.equal(rows[0].toStatus, null);
  assert.equal(rows[0].actorUserId, 'desk');
  assert.equal(rows[0].createdAt, NOW);
  assert.equal(rows[0].markupVersion, null, '배부는 본문 스냅샷을 남기지 않는다');
});

test('이력: actorUserId 미전달(시스템 트리거)이면 null이고 audience가 action에 그대로 들어간다', () => {
  const { service, db } = setup();
  service.distribute(ARTICLE_ID, 'press');

  const rows = historyRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'press');
  assert.equal(rows[0].actorUserId, null);
  // options에 null을 넘겨도 throw하지 않는다.
  assert.equal(service.distribute(ARTICLE_ID, 'press', null).ok, true);
  assert.equal(historyRows(db).length, 2, '재배부는 이력 1행을 더 쌓는다(중복 방지 가드 없음)');
});

test('이력: 대상 3건을 배부해도 이력은 1행이다(수신처별 행이 아니다)', () => {
  const { service, db, h } = setup({
    targets: [
      { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
      { name: 'MBC', kind: 'press', spoolDir: 'mbc' },
      { name: '기업홍보', kind: 'nonpress', spoolDir: 'corp' },
    ],
  });
  const r = service.distribute(ARTICLE_ID, 'all');

  assert.equal(r.written, 3);
  assert.equal(h.files.size, 3);
  assert.equal(historyRows(db).length, 1);
});

test('이력: distribute 행은 송고이력 필터(sendOnly)에 섞이지 않는다', () => {
  const { service, db, articleModel, historyModel } = setup();
  const articleService = createArticleService({ articleModel, db, historyModel });
  // 송고 이력(전이 기록 형태 그대로)을 먼저 쌓는다.
  historyModel.insert({
    articleId: ARTICLE_ID, eventType: 'status', action: 'send',
    fromStatus: 'RDS', toStatus: 'DPS', actorUserId: 'desk', createdAt: '2026-07-27T08:59:00.000Z',
  });

  service.distribute(ARTICLE_ID, 'all', { actorUserId: 'desk' });

  assert.equal(articleService.queryHistory(ARTICLE_ID).length, 2);
  const sendOnly = articleService.queryHistory(ARTICLE_ID, { sendOnly: true });
  assert.equal(sendOnly.length, 1, '송고이력 = status + send 계약이 유지된다');
  assert.equal(sendOnly[0].eventType, 'status');
  assert.equal(sendOnly[0].action, 'send');
});

test('이력: distribute 행의 hasSnapshot은 0이다(기사이력비교 목록에서 자동 제외)', () => {
  const { service, historyModel } = setup();
  service.distribute(ARTICLE_ID, 'all');

  const rows = historyModel.queryByArticle(ARTICLE_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventType, 'distribute');
  assert.equal(rows[0].hasSnapshot, 0);
  assert.equal(rows[0].markupVersion, undefined, '목록은 본문 blob을 싣지 않는다');
});

test('이력: historyModel 미주입이어도 배부는 정상 동작한다(이력만 생략)', () => {
  const { service, db, h } = setup({ withHistory: false });
  const r = service.distribute(ARTICLE_ID, 'all');

  assert.equal(r.ok, true);
  assert.equal(r.written, 2);
  assert.equal(h.files.size, 2);
  assert.equal(contentsRow(db).distributedAt, NOW);
  assert.equal(historyRows(db).length, 0);
});

test('이력: historyModel.insert가 throw해도 배부는 ok이고 파일·배부시간이 유지된다', () => {
  const { service, db, h } = setup({
    historyModel: { insert() { throw new Error('history down'); } },
  });
  const r = service.distribute(ARTICLE_ID, 'all');

  assert.equal(r.ok, true);
  assert.equal(r.written, 2);
  assert.equal(h.files.size, 2);
  assert.equal(contentsRow(db).distributedAt, NOW);
});

// ── E. 실패/비활성 ──────────────────────────────────────────────────────────

test('비활성: spoolWriter 미주입/비활성이면 아무것도 하지 않고 ok:true다(에러가 아니다)', () => {
  const cases = [
    { rootDir: '' }, // 스풀 루트 미설정
    { rootDir: '   ' }, // 공백만
    { spoolWriter: null }, // writer 미주입
    { spoolWriter: { enabled: false, write: () => { throw new Error('불려서는 안 됨'); } } },
  ];
  for (const options of cases) {
    const { service, db, h, calls } = setup(options);
    assert.deepEqual(
      service.distribute(ARTICLE_ID, 'all'),
      { ok: true, attempted: 0, written: 0, failures: [], distributedAt: null },
    );
    assert.equal(h.files.size, 0);
    assert.equal(h.dirs.length, 0, 'fs 호출 0회');
    assert.equal(calls.query, 0, '비활성이면 대상 조회도 하지 않는다');
    assert.equal(calls.update, 0);
    assert.equal(contentsRow(db).distributedAt, null);
    assert.equal(historyRows(db).length, 0);
  }
});

test('실패: 오염된 spoolDir 대상만 skip되고 나머지는 정상 기록된다', () => {
  const { service, db, h, targetIds } = setup({
    targets: [
      { name: '오염', kind: 'press', spoolDir: '../etc' },
      { name: '기업홍보', kind: 'nonpress', spoolDir: 'corp' },
    ],
  });
  const r = service.distribute(ARTICLE_ID, 'all');

  assert.equal(r.ok, true);
  assert.equal(r.attempted, 2);
  assert.equal(r.written, 1);
  assert.deepEqual(r.failures, [{ targetId: targetIds[0], spoolDir: '../etc', reason: 'invalid-spool-dir' }]);
  assert.equal(h.files.size, 1);
  assert.ok(h.files.has(fileFor('corp')));
  assert.equal(contentsRow(db).distributedAt, NOW, '부분 성공도 배부 개시다');
  assert.equal(historyRows(db).length, 1);
});

test('실패: 특정 폴더의 writeFileSync가 throw해도 나머지는 기록되고 부분 성공으로 수렴한다', () => {
  const { service, db, h, targetIds } = setup({
    fsOver: { failWrite: (p) => p.includes('kbs') },
  });
  const r = service.distribute(ARTICLE_ID, 'all');

  assert.equal(r.ok, true);
  assert.equal(r.attempted, 2);
  assert.equal(r.written, 1);
  assert.deepEqual(r.failures, [{ targetId: targetIds[0], spoolDir: 'kbs', reason: 'write-failed' }]);
  assert.equal(h.files.size, 1);
  assert.ok(h.files.has(fileFor('corp')));
  assert.equal(contentsRow(db).distributedAt, NOW);
  assert.equal(historyRows(db).length, 1);
});

test('실패: 전량 실패면 written 0 · failures가 attempted와 같고 DB는 무변경이다', () => {
  const { service, db, h, calls } = setup({ fsOver: { failMkdir: () => true } });
  const r = service.distribute(ARTICLE_ID, 'all');

  assert.equal(r.ok, true, '배부 실패가 상위(송고)를 실패시키면 안 된다');
  assert.equal(r.written, 0);
  assert.equal(r.attempted, 2);
  assert.equal(r.failures.length, r.attempted);
  assert.ok(r.failures.every((f) => f.reason === 'write-failed'));
  assert.equal(r.distributedAt, null);
  assert.equal(h.files.size, 0);
  assert.equal(calls.update, 0);
  assert.equal(contentsRow(db).distributedAt, null);
  assert.equal(historyRows(db).length, 0);
});

test('견고성: distribute는 어떤 경우에도 throw하지 않는다(모델 예외도 결과 객체로 수렴)', () => {
  const boom = () => { throw new Error('db down'); };
  const okWriter = { enabled: true, write: () => ({ ok: true, path: 'p' }) };

  const s1 = createDistributionService({
    articleModel: { getById: boom, update: boom },
    distributionTargetModel: { query: () => [] },
    spoolWriter: okWriter,
    now: () => NOW,
  });
  assert.deepEqual(s1.distribute(ARTICLE_ID, 'all'), { ok: false, reason: 'error' });

  const s2 = createDistributionService({
    articleModel: { getById: () => ({ article: { articleId: ARTICLE_ID }, contents: { articleId: ARTICLE_ID } }), update: boom },
    distributionTargetModel: { query: boom },
    spoolWriter: okWriter,
    now: () => NOW,
  });
  assert.deepEqual(s2.distribute(ARTICLE_ID, 'all'), { ok: false, reason: 'error' });

  // 의존성이 아예 없어도 생성·호출이 throw하지 않는다.
  assert.deepEqual(createDistributionService().distribute(ARTICLE_ID, 'all'), { ok: false, reason: 'error' });
  assert.deepEqual(createDistributionService({}).distribute(ARTICLE_ID, 'press'), { ok: false, reason: 'error' });
});

test('견고성: writer가 계약을 어기고 throw해도 그 대상만 실패로 흡수되고 나머지는 계속된다', () => {
  const { service, db, targetIds } = setup({
    spoolWriter: {
      enabled: true,
      write: ({ target }) => {
        if (target.spoolDir === 'kbs') throw new Error('계약 위반');
        return { ok: true, path: `p/${target.spoolDir}` };
      },
    },
  });
  const r = service.distribute(ARTICLE_ID, 'all');

  assert.equal(r.ok, true);
  assert.equal(r.written, 1);
  assert.deepEqual(r.failures, [{ targetId: targetIds[0], spoolDir: 'kbs', reason: 'write-failed' }]);
  assert.equal(contentsRow(db).distributedAt, NOW);
});

test('견고성: 배부시간 stamp가 실패해도 파일은 이미 나갔으므로 ok:true다', () => {
  // update만 throw하는 서비스를 별도로 조립한다(파일 기록은 정상).
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const targetModel = createDistributionTargetModel(db);
  articleModel.insert({
    article: { articleId: ARTICLE_ID, title: '제목', markupVersion: MARKUP },
    contents: { articleId: ARTICLE_ID, title: TITLE, status: 'DPS' },
  });
  targetModel.insert({ name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' });
  const fsh = fakeFs();
  const svc = createDistributionService({
    articleModel: { getById: (id) => articleModel.getById(id), update: () => { throw new Error('update down'); } },
    distributionTargetModel: targetModel,
    historyModel: createArticleHistoryModel(db),
    spoolWriter: createSpoolWriter({ rootDir: ROOT, fs: fsh.fs }),
    now: () => NOW,
  });

  const r = svc.distribute(ARTICLE_ID, 'press');
  assert.equal(r.ok, true);
  assert.equal(r.written, 1);
  assert.equal(r.distributedAt, NOW);
  assert.equal(fsh.files.size, 1);
  assert.equal(historyRows(db).length, 1, 'stamp 실패가 이력 기록을 막지 않는다');
});

// ── F. 로깅·아키텍처 가드 ───────────────────────────────────────────────────

test('로깅: 성공은 info, 실패는 warn으로 남고 기사 제목·본문·내부코멘트가 로그에 담기지 않는다', () => {
  const { lines, logger } = fakeLogger();
  const { service, targetIds } = setup({ logger, fsOver: { failWrite: (p) => p.includes('kbs') } });

  service.distribute(ARTICLE_ID, 'all');

  assert.equal(lines.info.length, 1);
  assert.ok(lines.info[0].includes(ARTICLE_ID));
  assert.ok(lines.info[0].includes('corp'));
  assert.ok(lines.info[0].includes('all'));
  assert.equal(lines.warn.length, 1);
  assert.ok(lines.warn[0].includes('write-failed'));
  assert.ok(lines.warn[0].includes(String(targetIds[0])));

  const all = [...lines.debug, ...lines.info, ...lines.warn, ...lines.error];
  for (const line of all) {
    assert.ok(!line.includes(TITLE), '제목이 로그에 담기면 안 된다');
    assert.ok(!line.includes(SECRET), '내부코멘트가 로그에 담기면 안 된다');
    assert.ok(!line.includes('본문 한 줄'), '본문이 로그에 담기면 안 된다');
    assert.ok(!line.includes('yh-dist-article'), 'payload가 로그에 담기면 안 된다');
  }
});

test('로깅: 비활성·대상 0건은 debug로만 남고, logger가 throw해도 배부는 계속된다', () => {
  const disabled = fakeLogger();
  const a = setup({ logger: disabled.logger, rootDir: '' });
  a.service.distribute(ARTICLE_ID, 'all');
  assert.equal(disabled.lines.debug.length, 1);
  assert.equal(disabled.lines.warn.length, 0);

  const empty = fakeLogger();
  const b = setup({ logger: empty.logger, targets: [] });
  b.service.distribute(ARTICLE_ID, 'all');
  assert.equal(empty.lines.debug.length, 1);

  // 부분 구현/예외 logger도 배부를 막지 않는다.
  const broken = { info() { throw new Error('logger down'); } };
  const c = setup({ logger: broken });
  const r = c.service.distribute(ARTICLE_ID, 'all');
  assert.equal(r.ok, true);
  assert.equal(r.written, 2);
  assert.equal(c.h.files.size, 2);
});

test('아키텍처: 모듈 소스에 실 fs·네트워크·타이머·SQL·역의존이 없다', () => {
  // test/ 안에서 실 fs를 쓰는 것은 소스 검사 목적이므로 허용된다.
  const src = readFileSync(new URL('../src/services/distributionService.js', import.meta.url), 'utf8');

  // 파일 IO는 전부 주입된 spoolWriter 경유다(경로 합성조차 이 모듈에 없다).
  for (const banned of ['node:fs', 'node:path', 'existsSync', 'writeFileSync', 'mkdirSync']) {
    assert.ok(!src.includes(banned), `금지: ${banned}`);
  }
  // ADR-008 — 앱 내 타이머·egress 금지. 시각 도래 배부는 phase 48의 tick pull이다.
  for (const banned of ['setTimeout', 'setInterval', 'fetch(', 'http']) {
    assert.ok(!src.includes(banned), `금지: ${banned}`);
  }
  // 서비스→서비스 역의존(순환) 금지 + env 판독 금지(스풀 루트는 부트스트랩이 정한다).
  for (const banned of ['articleService', 'process.env', 'require(']) {
    assert.ok(!src.includes(banned), `금지: ${banned}`);
  }
  // DB 비파괴 — 이 모듈은 SQL을 갖지 않는다.
  for (const banned of ['DELETE FROM', 'DROP', 'TRUNCATE', 'db.prepare']) {
    assert.ok(!src.includes(banned), `금지: ${banned}`);
  }
  assert.ok(src.includes('buildDistributionPayload'), '스풀 포맷은 단일 출처에 위임한다');
});
