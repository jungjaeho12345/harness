// 송고 후처리 배부 훅 테스트 — 송고(applyAction 'send')가 끝난 뒤에만, 엠바고 설정에 따라
// 배부를 지시하는지 검증한다(ADR-008 (4), news.md 엠바고 규칙).
//
// CRITICAL 계약(완화 금지 — 실패하면 구현을 고쳐라):
//  ① 배부군은 "상태"가 아니라 "엠바고 설정"이 정한다. finalStatus==='DPS' ? 'all' 같은 단순 분기는
//     엠바고가 설정된 DDH 기사(lifecycle DDH.send='DPS')를 전량 배부해 엠바고를 파기한다.
//  ② 1차 엠바고가 설정된 기사는 상태(EPS/DPS)와 무관하게 이번에 배부하지 않는다(시각 배부는 phase 48).
//  ③ 배부 실패/예외가 송고를 롤백하거나 실패시키지 않는다(스풀 실패는 송고의 후처리 실패일 뿐이다).
//  ④ applyAction의 반환은 { ok, status } 정확히 2키다(HTTP 응답 계약 + 다수 정확일치 단언).

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleHistoryModel } from '../src/models/articleHistoryModel.js';
import { createDistributionTargetModel } from '../src/models/distributionTargetModel.js';
import { createArticleService } from '../src/services/articleService.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';

const EMBARGO_1 = '2026-07-28T09:00:00.000Z';
const EMBARGO_2 = '2026-07-29T09:00:00.000Z';

// 송고 가드(hasEndMarker)를 통과하려면 본문 블록에 "(끝)"이 있어야 한다.
function markup(withEnd = true) {
  const blocks = [{ type: 'text', text: '본문 한 줄' }];
  if (withEnd) blocks.push({ type: 'text', text: '(끝)' });
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}

// 호출 인자를 기록하는 가짜 배부 서비스. impl로 예외/실패 반환을 주입한다.
function fakeDistribution(impl) {
  const calls = [];
  return {
    calls,
    distribute(articleId, audience, options) {
      calls.push({ articleId, audience, options });
      if (typeof impl === 'function') return impl(articleId, audience, options);
      return { ok: true, attempted: 1, written: 1, failures: [], distributedAt: '2026-07-27T09:00:00.000Z' };
    },
  };
}

// distributionService를 주입하지 않는 호출 형태(기존 호출자)도 그대로 지원해야 한다.
function unitSetup(distributionService) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const articleModel = createArticleModel(db);
  const historyModel = createArticleHistoryModel(db);
  const service = distributionService === undefined
    ? createArticleService({ articleModel, db, historyModel })
    : createArticleService({ articleModel, db, historyModel, distributionService });
  return { db, articleModel, historyModel, service };
}

// 기사 1건 시드 — status 오버라이드는 모델 update로 직접 세팅한다(전이 경로 없이 DDH/DPS를 만든다).
function seed(h, { status, withEnd = true, ...contents } = {}) {
  const { articleId } = h.service.create({
    title: '제목', markupVersion: markup(withEnd), author: 'kim', ...contents,
  });
  if (status) h.articleModel.update(articleId, { contents: { status } });
  return articleId;
}

const contentsRow = (db, id) => db.prepare('SELECT * FROM Contents WHERE articleId = ?').get(id);

// ── A. 단위 — 가짜 distributionService 주입 ────────────────────────────────

test('훅: 엠바고 없는 RDS 기사를 D가 송고하면 전체 배부(all)를 1회 지시한다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h);

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'DPS');
  assert.equal(dist.calls.length, 1);
  assert.deepEqual(dist.calls[0], { articleId: id, audience: 'all', options: { actorUserId: 'desk' } });
});

test('훅: 2차 엠바고만 설정된 기사의 송고(EPS)는 언론사 배부(press)만 지시한다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { secondEmbargoAt: EMBARGO_2 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'EPS');
  assert.equal(dist.calls.length, 1);
  assert.equal(dist.calls[0].audience, 'press');
});

test('훅: 1차 엠바고만 설정된 기사의 송고(EPS)는 배부를 지시하지 않는다(시각 배부는 후속 phase)', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { embargoAt: EMBARGO_1 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'EPS');
  assert.equal(dist.calls.length, 0);
});

test('훅: 1+2차 엠바고가 모두 설정된 기사의 송고(EPS)는 배부를 지시하지 않는다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { embargoAt: EMBARGO_1, secondEmbargoAt: EMBARGO_2 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'EPS');
  assert.equal(dist.calls.length, 0);
});

test('훅: 엠바고 필드가 빈 문자열이면 미설정으로 보고 전체 배부한다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { embargoAt: '', secondEmbargoAt: '' });

  const r = h.service.applyAction(id, 'Z', 'send', { userId: 'admin' });

  assert.equal(r.status, 'DPS');
  assert.equal(dist.calls.length, 1);
  assert.equal(dist.calls[0].audience, 'all');
});

test('훅: hold/kill/approveDelete는 배부 트리거가 아니다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);

  const held = seed(h);
  assert.equal(h.service.applyAction(held, 'D', 'hold', { userId: 'desk' }).status, 'DDH');

  const killed = seed(h);
  assert.equal(h.service.applyAction(killed, 'D', 'kill', { userId: 'desk' }).status, 'DDK');

  const deleted = seed(h, { status: 'DPS' });
  assert.equal(h.service.applyAction(deleted, 'Z', 'approveDelete', { userId: 'admin' }).status, 'DPD');

  assert.equal(dist.calls.length, 0);
});

test('훅: R의 송고(RDS 유지 — 데스크 미송고)는 배부를 지시하지 않는다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h);

  const r = h.service.applyAction(id, 'R', 'send', { userId: 'kim' });

  assert.equal(r.status, 'RDS');
  assert.equal(dist.calls.length, 0);
});

test('훅: 전이 거부(no-end-marker/forbidden-transition/not-found)는 부작용이 없다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);

  const noEnd = seed(h, { withEnd: false });
  assert.deepEqual(h.service.applyAction(noEnd, 'D', 'send', { userId: 'desk' }), { ok: false, reason: 'no-end-marker' });

  const eps = seed(h, { status: 'EPS' }); // EPS에는 send 전이가 없다.
  assert.deepEqual(
    h.service.applyAction(eps, 'D', 'send', { userId: 'desk' }),
    { ok: false, reason: 'forbidden-transition' },
  );

  assert.deepEqual(
    h.service.applyAction('NOPE20260727000000001', 'D', 'send', { userId: 'desk' }),
    { ok: false, reason: 'not-found' },
  );

  assert.equal(dist.calls.length, 0);
});

test('훅: 엠바고 없는 DPS 기사의 재송고는 다시 전체 배부한다(정정본 배부)', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h);

  assert.equal(h.service.applyAction(id, 'D', 'send', { userId: 'desk' }).status, 'DPS');
  assert.equal(h.service.applyAction(id, 'D', 'send', { userId: 'desk' }).status, 'DPS');

  assert.equal(dist.calls.length, 2);
  assert.deepEqual(dist.calls.map((c) => c.audience), ['all', 'all']);
});

// ── A′. 엠바고 파기 방지 — DDH 송고(finalStatus가 EPS가 아니라 DPS인 경로) ──────
// articleService의 EPS 치환은 fromStatus==='RDS' 한정이라 DDH 기사는 엠바고가 있어도 DPS가 된다.
// 각 케이스는 r.status==='DPS'를 먼저 단언해 "상태로는 구분할 수 없다"는 전제를 고정한다.

test('훅(DDH): 1차 엠바고가 있으면 결과가 DPS여도 배부하지 않는다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { status: 'DDH', embargoAt: EMBARGO_1 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'DPS', '전제: DDH 송고는 EPS가 아니라 DPS다');
  assert.equal(dist.calls.length, 0, '1차 엠바고 파기 방지');
});

test('훅(DDH): 2차 엠바고만 있으면 결과가 DPS여도 언론사(press)에만 배부한다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { status: 'DDH', secondEmbargoAt: EMBARGO_2 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'DPS', '전제: DDH 송고는 EPS가 아니라 DPS다');
  assert.equal(dist.calls.length, 1);
  assert.equal(dist.calls[0].audience, 'press', "'all'이면 2차 엠바고 파기다");
});

test('훅(DDH): 1+2차 엠바고가 모두 있으면 결과가 DPS여도 배부하지 않는다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { status: 'DDH', embargoAt: EMBARGO_1, secondEmbargoAt: EMBARGO_2 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'DPS');
  assert.equal(dist.calls.length, 0);
});

test('훅(DDH): 엠바고가 없으면 보류 해제 송고는 정상적으로 전체 배부한다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { status: 'DDH' });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'DPS');
  assert.equal(dist.calls.length, 1);
  assert.equal(dist.calls[0].audience, 'all');
});

// 송고 완료 게이트(sent) — 엠바고 판정보다 앞선다. 이 게이트가 없으면 2차 엠바고가 설정된 기사를
// 기자(R)가 "송고"하는 것만으로 언론사에 나간다(전이 결과는 RDS = 데스크 미승인). 상태가 DPS/EPS가
// 아닌 유일한 send 결과가 이 경로라, 여기서만 게이트 소실이 관측된다.
test('훅(R): 2차 엠바고가 있어도 기자 송고(RDS 유지)는 배부하지 않는다(데스크 미승인 유출 금지)', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { secondEmbargoAt: EMBARGO_2 });

  const r = h.service.applyAction(id, 'R', 'send', { userId: 'kim' });

  assert.equal(r.status, 'RDS', '전제: 기자 송고는 데스크 미송고(RDS)로 남는다');
  assert.equal(dist.calls.length, 0, '데스크가 승인하지 않은 기사가 언론사로 나가면 안 된다');
});

test('훅: 엠바고가 추가된 DPS 기사의 재송고는 배부하지 않는다', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h, { status: 'DPS', embargoAt: EMBARGO_1 });

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(r.status, 'DPS');
  assert.equal(dist.calls.length, 0);
});

// ── 무롤백 계약 ────────────────────────────────────────────────────────────

test('훅: distribute가 throw해도 송고는 성공이고 상태 전이·sentAt·이력이 유지된다', () => {
  const dist = fakeDistribution(() => { throw new Error('spool exploded'); });
  const h = unitSetup(dist);
  const id = seed(h);

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.deepEqual(r, { ok: true, status: 'DPS' });
  const row = contentsRow(h.db, id);
  assert.equal(row.status, 'DPS');
  assert.equal(row.sender, 'desk');
  assert.ok(row.sentAt, 'sentAt이 stamp된다');
  const history = h.service.queryHistory(id);
  assert.equal(history.length, 1);
  assert.equal(history[0].eventType, 'status');
  assert.equal(history[0].toStatus, 'DPS');
});

test('훅: distribute가 { ok:false }를 반환해도 송고는 성공 처리된다', () => {
  const dist = fakeDistribution(() => ({ ok: false, reason: 'not-found' }));
  const h = unitSetup(dist);
  const id = seed(h);

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.deepEqual(r, { ok: true, status: 'DPS' });
  assert.equal(contentsRow(h.db, id).status, 'DPS');
});

test('훅: applyAction 반환은 { ok, status } 2키 그대로다(배부 결과 필드 추가 금지)', () => {
  const dist = fakeDistribution();
  const h = unitSetup(dist);
  const id = seed(h);

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.deepEqual(r, { ok: true, status: 'DPS' });
  assert.deepEqual(Object.keys(r).sort(), ['ok', 'status']);
});

test('훅: distributionService 미주입(기존 호출 형태)이어도 송고 동작이 동일하다', () => {
  const h = unitSetup(); // 주입 없음
  const id = seed(h);

  const r = h.service.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.deepEqual(r, { ok: true, status: 'DPS' });
  const row = contentsRow(h.db, id);
  assert.equal(row.status, 'DPS');
  assert.equal(row.distributedAt, null, '배부가 없으므로 배부시간도 없다');
  assert.equal(h.service.queryHistory(id).length, 1);
});

// ── B. 통합 — 실제 결선(createControllers) + 가짜 fs ────────────────────────
// 실디스크·네트워크·타이머 접촉 0. 스풀 루트는 가짜 경로이고 fs는 주입한다.

const ROOT = '/spool/dist';
const DEFAULT_TARGETS = [
  { name: 'KBS', kind: 'press', spoolDir: 'kbs' },
  { name: '기업홍보', kind: 'nonpress', spoolDir: 'corp' },
];

function fakeFs({ failWrite = false } = {}) {
  const files = new Map(); // path -> { data, enc }
  const dirs = [];
  return {
    files,
    dirs,
    fs: {
      mkdirSync: (dir, opts) => { dirs.push({ dir, opts }); },
      writeFileSync: (p, data, enc) => {
        if (failWrite) throw new Error(`EACCES: ${p}`);
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

// wire=false면 배부 옵션을 하나도 주지 않는다(기존 호출 형태 = 배부 비활성).
function wiredSetup({ wire = true, failWrite = false, targets = DEFAULT_TARGETS } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const h = fakeFs({ failWrite });
  const log = fakeLogger();
  const sessionService = createSessionService();
  const controllers = wire
    ? createControllers(db, { sessionService, distSpoolDir: ROOT, spoolFs: h.fs, logger: log.logger })
    : createControllers(db, { sessionService });

  const targetModel = createDistributionTargetModel(db);
  for (const t of targets) {
    targetModel.insert({
      active: 'Y', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', ...t,
    });
  }
  return { db, controllers, h, log, articleModel: createArticleModel(db) };
}

// 기대 경로는 반드시 join으로 조립한다 — Windows에서 join('/spool','kbs')는 '\spool\kbs'다.
const filesIn = (h, dir) => [...h.files.keys()].filter((p) => p.startsWith(`${join(ROOT, dir)}${sep}`));
const readPayload = (h, path) => JSON.parse(h.files.get(path).data);

function makeArticle(s, { status, ...contents } = {}) {
  const c = s.controllers.article.create({
    title: '제목', markupVersion: markup(true), author: 'kim', department: '사회부', ...contents,
  });
  assert.equal(c.ok, true);
  if (status) s.articleModel.update(c.articleId, { contents: { status } });
  return c.articleId;
}

test('결선: 엠바고 없는 송고는 언론사·비언론사 폴더에 각각 파일을 쓰고 배부시간·이력을 남긴다', () => {
  const s = wiredSetup();
  const id = makeArticle(s);
  // 이전 송고 흔적을 심어 둔다 — 후처리가 전이 이전에 실행되면 파일에 이 옛 값이 실린다.
  s.articleModel.update(id, { contents: { sentAt: '2020-01-01T00:00:00.000Z' } });

  const r = s.controllers.article.applyAction(id, 'D', 'send', { userId: 'desk' });
  assert.deepEqual(r, { ok: true, status: 'DPS' });

  assert.equal(s.h.files.size, 2);
  const pressFiles = filesIn(s.h, 'kbs');
  const nonpressFiles = filesIn(s.h, 'corp');
  assert.equal(pressFiles.length, 1, '언론사 폴더에 1개');
  assert.equal(nonpressFiles.length, 1, '비언론사 폴더에 1개');

  const row = contentsRow(s.db, id);
  assert.ok(row.distributedAt, 'Contents.distributedAt이 stamp된다');

  const items = s.controllers.article.queryHistory(id);
  assert.equal(items.length, 2);
  assert.equal(items[0].eventType, 'distribute', '최신순(id DESC) — 배부 이력이 위');
  assert.equal(items[0].action, 'all');
  assert.equal(items[0].actorUserId, 'desk');
  assert.equal(items[1].eventType, 'status');

  // 커밋 순서 불변식: 파일 내용은 "전이 이후" 값이어야 한다.
  for (const p of [...pressFiles, ...nonpressFiles]) {
    const payload = readPayload(s.h, p);
    assert.equal(payload.article.status, 'DPS', '파일에 전이 이후 상태가 실린다');
    assert.equal(payload.article.sentAt, row.sentAt, '파일의 sentAt은 이번 송고에서 stamp된 값이다');
    assert.notEqual(payload.article.sentAt, '2020-01-01T00:00:00.000Z');
    assert.equal(payload.article.articleId, id);
  }
});

test('결선: 2차 엠바고만 있는 송고는 언론사 폴더에만 쓰고 상태는 EPS로 유지된다', () => {
  const s = wiredSetup();
  const id = makeArticle(s, { secondEmbargoAt: EMBARGO_2 });

  const r = s.controllers.article.applyAction(id, 'D', 'send', { userId: 'desk' });
  assert.deepEqual(r, { ok: true, status: 'EPS' });

  const pressFiles = filesIn(s.h, 'kbs');
  assert.equal(s.h.files.size, 1);
  assert.equal(pressFiles.length, 1);
  assert.equal(filesIn(s.h, 'corp').length, 0, '비언론사에는 배부하지 않는다');

  const row = contentsRow(s.db, id);
  assert.equal(row.status, 'EPS', '배부 후에도 EPS를 유지한다(전이 추가 금지)');
  assert.ok(row.distributedAt);

  const payload = readPayload(s.h, pressFiles[0]);
  assert.equal(payload.article.status, 'EPS');
  assert.equal(payload.article.secondEmbargoAt, EMBARGO_2);
  assert.equal(payload.audience, 'press');
});

test('결선: 1차 엠바고가 있는 송고는 파일을 쓰지 않고 배부시간·배부이력도 남기지 않는다', () => {
  const s = wiredSetup();
  const id = makeArticle(s, { embargoAt: EMBARGO_1 });

  const r = s.controllers.article.applyAction(id, 'D', 'send', { userId: 'desk' });
  assert.deepEqual(r, { ok: true, status: 'EPS' });

  assert.equal(s.h.files.size, 0);
  assert.equal(s.h.dirs.length, 0, '폴더 생성조차 하지 않는다');
  assert.equal(contentsRow(s.db, id).distributedAt, null);

  const items = s.controllers.article.queryHistory(id);
  assert.equal(items.length, 1);
  assert.equal(items[0].eventType, 'status');
});

test('결선(DDH): 2차 엠바고만 있는 보류 기사의 송고는 DPS가 되지만 언론사에만 배부한다', () => {
  const s = wiredSetup();
  const id = makeArticle(s, { status: 'DDH', secondEmbargoAt: EMBARGO_2 });

  const r = s.controllers.article.applyAction(id, 'D', 'send', { userId: 'desk' });
  assert.equal(r.status, 'DPS', '전제: DDH 송고 결과는 DPS다');

  const pressFiles = filesIn(s.h, 'kbs');
  assert.equal(pressFiles.length, 1);
  assert.equal(filesIn(s.h, 'corp').length, 0, 'DPS라고 전체 배부하면 2차 엠바고 파기다');
  assert.equal(readPayload(s.h, pressFiles[0]).article.status, 'DPS');
});

test('결선(R): 2차 엠바고 기사의 기자 송고는 스풀 파일·배부시간·배부이력을 남기지 않는다', () => {
  const s = wiredSetup();
  const id = makeArticle(s, { secondEmbargoAt: EMBARGO_2 });

  const r = s.controllers.article.applyAction(id, 'R', 'send', { userId: 'kim' });

  assert.deepEqual(r, { ok: true, status: 'RDS' });
  assert.equal(s.h.files.size, 0, '데스크 미승인 기사가 스풀에 나가면 안 된다');
  assert.equal(s.h.dirs.length, 0, '폴더 생성조차 하지 않는다');
  assert.equal(contentsRow(s.db, id).distributedAt, null);

  const items = s.controllers.article.queryHistory(id);
  assert.equal(items.length, 1);
  assert.equal(items[0].eventType, 'status');
});

test('결선: 스풀 쓰기가 모두 실패해도 송고는 성공이고 배부시간·배부이력은 남지 않는다', () => {
  const s = wiredSetup({ failWrite: true });
  const id = makeArticle(s);

  const r = s.controllers.article.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.deepEqual(r, { ok: true, status: 'DPS' });
  const row = contentsRow(s.db, id);
  assert.equal(row.status, 'DPS');
  assert.equal(row.sender, 'desk');
  assert.equal(row.distributedAt, null, '나간 파일이 없으면 배부시간도 없다');
  assert.equal(s.h.files.size, 0);

  const items = s.controllers.article.queryHistory(id);
  assert.equal(items.length, 1);
  assert.equal(items[0].eventType, 'status');
  assert.ok(
    s.log.lines.warn.some((m) => m.includes('distribution spool failed')),
    `실패가 로그로 표면화된다: ${JSON.stringify(s.log.lines.warn)}`,
  );
});

test('결선: 송고이력(sendOnly)은 배부 이후에도 status/send 1건만 반환한다', () => {
  const s = wiredSetup();
  const id = makeArticle(s);
  s.controllers.article.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.equal(s.controllers.article.queryHistory(id).length, 2, '배부 이력이 실제로 쌓인 상태');
  const sendHistory = s.controllers.article.queryHistory(id, { sendOnly: true });
  assert.equal(sendHistory.length, 1);
  assert.equal(sendHistory[0].eventType, 'status');
  assert.equal(sendHistory[0].action, 'send');
});

// ── C. 기본 비활성 잠금 ────────────────────────────────────────────────────

test('기본값: 배부 옵션을 주지 않은 createControllers는 배부하지 않는다', () => {
  const s = wiredSetup({ wire: false });
  const id = makeArticle(s);

  const r = s.controllers.article.applyAction(id, 'D', 'send', { userId: 'desk' });

  assert.deepEqual(r, { ok: true, status: 'DPS' });
  assert.equal(s.h.files.size, 0);
  assert.equal(s.h.dirs.length, 0);
  assert.equal(contentsRow(s.db, id).distributedAt, null);
  assert.equal(s.controllers.article.queryHistory(id).length, 1);
});

test('기본값: DIST_SPOOL_DIR 환경변수가 설정돼 있어도 컨트롤러는 그것을 읽지 않는다', () => {
  const envDir = join(tmpdir(), `dist-spool-env-guard-${process.pid}-${Date.now()}`);
  const prev = process.env.DIST_SPOOL_DIR;
  try {
    process.env.DIST_SPOOL_DIR = envDir;
    const s = wiredSetup({ wire: false });
    const id = makeArticle(s);

    const r = s.controllers.article.applyAction(id, 'D', 'send', { userId: 'desk' });

    assert.deepEqual(r, { ok: true, status: 'DPS' });
    assert.equal(contentsRow(s.db, id).distributedAt, null);
    assert.equal(s.controllers.article.queryHistory(id).length, 1);
    assert.equal(existsSync(envDir), false, 'env를 읽었다면 실디스크에 스풀 폴더가 생긴다');
  } finally {
    if (prev === undefined) delete process.env.DIST_SPOOL_DIR;
    else process.env.DIST_SPOOL_DIR = prev;
  }
});

// ── D. 아키텍처 가드 ───────────────────────────────────────────────────────

test('가드: 기사 서비스에 파일시스템·네트워크·타이머가 없다', () => {
  const src = readFileSync(new URL('../src/services/articleService.js', import.meta.url), 'utf8');
  for (const forbidden of ['node:fs', 'fetch', 'setInterval', 'setTimeout']) {
    assert.equal(src.includes(forbidden), false, `articleService에 ${forbidden}이 없어야 한다`);
  }
});

test('가드: 컨트롤러는 스풀 루트 환경변수를 판독하지 않는다(부트스트랩 전용)', () => {
  const src = readFileSync(new URL('../src/controllers/index.js', import.meta.url), 'utf8');
  assert.equal(src.includes('DIST_SPOOL_DIR'), false, '환경변수 판독은 부트스트랩 한 곳에서만 한다');
});
