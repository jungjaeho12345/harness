// 배부 스풀 writer 테스트 — 실디스크·네트워크·타이머 없이 검증한다(ADR-008: 파일 스풀 outbound).
// 포맷(buildDistributionPayload)은 순수 함수라 그대로 호출하고, 쓰기(createSpoolWriter)는 가짜 fs를 주입한다
// (test/ftpWatcher.test.js의 주입 하네스와 동형 — inbound watcher의 대칭이 outbound writer다).
// CRITICAL 두 가지: ① 오염된 spoolDir/articleId/distributedAt이 fs에 도달하지 않는다(호출 0회로 단언).
// ② 파일명 재료는 문자열 강제변환 없이 typeof 게이트로 막는다 — null/undefined/숫자가 통과해
//    'AKR...__null.json' 같은 파일이 생기면 이 테스트가 실패해야 한다(구현을 고쳐라, 테스트를 완화하지 마라).

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildDistributionPayload, createSpoolWriter } from '../src/services/spoolWriter.js';

const ARTICLE_ID = 'AKR20260727123456789';
const MARKUP = '{"format":"yh-editor","version":1,"blocks":[{"type":"text","text":"본문 한 줄"}]}';
const DIST_AT = '2026-07-27T09:00:00.000Z';

// Article 행(본문 마크업) — 제외 대상 modifier를 일부러 채워 넣는다.
function sampleArticle(over = {}) {
  return {
    articleId: ARTICLE_ID,
    title: 'Article쪽 제목',
    content: 'article평문미사용',
    markupVersion: MARKUP,
    modifier: 'user-modifier',
    ...over,
  };
}

// Contents 행(공통정보·생애주기·잠금) — 실제 컬럼 전량. 제외 대상 컬럼에 식별 가능한 값을 넣어 유출을 잠근다.
function sampleContents(over = {}) {
  return {
    articleId: ARTICLE_ID,
    title: '기사 제목',
    content: 'contents평문미사용',
    author: '김기자',
    modifier: 'user-modifier',
    sender: 'user-sender',
    department: '사회부',
    departmentCode: '10',
    createdAt: '2026-07-27T08:00:00.000Z',
    editedAt: '2026-07-27T08:30:00.000Z',
    sentAt: '2026-07-27T09:00:00.000Z',
    distributedAt: null,
    embargoAt: null,
    secondEmbargoAt: '2026-07-28T00:00:00.000Z',
    status: 'EPS',
    lockYN: 'N',
    lockerUserId: 'locker-user',
    lockerSessionId: 'locker-session',
    lockerClientId: 'locker-client',
    lockedAt: '2026-07-27T08:40:00.000Z',
    coAuthor: null,
    category: null,
    region: null,
    attribute: null,
    keyword: null,
    internalComment: '내부메모',
    externalComment: '외부코멘트',
    attachmentFile: '/uploads/첨부.pdf',
    referenceFile: '/uploads/자료.hwp',
    ...over,
  };
}

// DistributionTarget 행 — 수신처에 무의미한 컬럼(active/타임스탬프)이 새지 않아야 한다.
function sampleTarget(over = {}) {
  return {
    id: 3,
    name: '연합TV',
    kind: 'press',
    spoolDir: 'yonhap-tv',
    active: 'Y',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...over,
  };
}

function buildSample(over = {}) {
  return buildDistributionPayload({
    article: sampleArticle(),
    contents: sampleContents(),
    target: sampleTarget(),
    audience: 'all',
    distributedAt: DIST_AT,
    ...over,
  });
}

// Contents에서 복사되는 필드 allowlist — 순서까지 계약이다.
const ARTICLE_FIELDS = [
  'author', 'coAuthor', 'department', 'departmentCode', 'category', 'region',
  'attribute', 'keyword', 'externalComment', 'embargoAt', 'secondEmbargoAt',
  'createdAt', 'sentAt', 'status',
];
const ARTICLE_KEYS = ['articleId', 'title', 'markupVersion', ...ARTICLE_FIELDS];

// ── A. buildDistributionPayload (순수 — fs 없음) ────────────────────────────

test('payload: envelope 상위 키와 schema/version 리터럴이 고정이다', () => {
  const p = buildSample();
  assert.deepEqual(Object.keys(p), ['schema', 'version', 'distributedAt', 'audience', 'target', 'article']);
  assert.equal(p.schema, 'yh-dist-article');
  assert.equal(p.version, 1);
  assert.equal(p.distributedAt, DIST_AT);
  assert.equal(p.audience, 'all');
});

test('payload: article 키 집합이 확정 목록과 정확히 일치한다(순서 포함)', () => {
  const p = buildSample();
  assert.deepEqual(Object.keys(p.article), ARTICLE_KEYS);
  assert.equal(p.article.articleId, ARTICLE_ID);
  assert.equal(p.article.author, '김기자');
  assert.equal(p.article.department, '사회부');
  assert.equal(p.article.departmentCode, '10');
  assert.equal(p.article.secondEmbargoAt, '2026-07-28T00:00:00.000Z');
  assert.equal(p.article.status, 'EPS');
  assert.equal(p.article.externalComment, '외부코멘트');
});

test('payload: markupVersion은 원문 문자열 그대로다(파싱·재직렬화 없음)', () => {
  const p = buildSample();
  assert.equal(typeof p.article.markupVersion, 'string');
  assert.equal(p.article.markupVersion, MARKUP);
  // 왕복해도 원문이 보존된다(이스케이프 사고 방지).
  const round = JSON.parse(JSON.stringify(p));
  assert.equal(round.article.markupVersion, MARKUP);
});

test('payload: 제외 필드(내부코멘트·식별자·잠금·첨부·평문)가 새지 않는다 — 보안 계약', () => {
  const s = JSON.stringify(buildSample());
  for (const secret of [
    '내부메모', 'user-sender', 'user-modifier', 'locker-user', 'locker-session', 'locker-client',
    '/uploads/첨부.pdf', '/uploads/자료.hwp', 'contents평문미사용', 'article평문미사용',
    '2026-07-27T08:30:00.000Z', '2026-07-27T08:40:00.000Z',
  ]) {
    assert.ok(!s.includes(secret), `유출되면 안 됨: ${secret}`);
  }
  for (const key of [
    '"internalComment"', '"sender"', '"modifier"', '"lockYN"', '"lockerUserId"',
    '"lockerSessionId"', '"lockerClientId"', '"lockedAt"', '"attachmentFile"',
    '"referenceFile"', '"editedAt"', '"content"',
  ]) {
    assert.ok(!s.includes(key), `키가 나가면 안 됨: ${key}`);
  }
});

test('payload: title은 contents 우선 → article 폴백 → 둘 다 없으면 null', () => {
  assert.equal(buildSample().article.title, '기사 제목');
  assert.equal(
    buildDistributionPayload({
      article: sampleArticle(),
      contents: sampleContents({ title: undefined }),
    }).article.title,
    'Article쪽 제목',
  );
  assert.equal(
    buildDistributionPayload({
      article: sampleArticle({ title: undefined }),
      contents: sampleContents({ title: undefined }),
    }).article.title,
    null,
  );
});

test('payload: undefined 필드는 null로 정규화되고 키는 남는다', () => {
  const contents = sampleContents();
  for (const f of ARTICLE_FIELDS) delete contents[f];
  const p = buildDistributionPayload({ article: sampleArticle(), contents, target: sampleTarget() });
  assert.deepEqual(Object.keys(p.article), ARTICLE_KEYS);
  for (const f of ARTICLE_FIELDS) assert.equal(p.article[f], null, `${f}는 null이어야 함`);
  // audience/distributedAt 미지정도 키를 유지한 채 null이다.
  assert.equal(p.audience, null);
  assert.equal(p.distributedAt, null);
});

test('payload: target은 id·name·kind·spoolDir 4키만 갖는다', () => {
  const p = buildSample();
  assert.deepEqual(Object.keys(p.target), ['id', 'name', 'kind', 'spoolDir']);
  assert.deepEqual(p.target, { id: 3, name: '연합TV', kind: 'press', spoolDir: 'yonhap-tv' });
  const s = JSON.stringify(p);
  assert.ok(!s.includes('"active"'), 'active가 새면 안 됨');
  assert.ok(!s.includes('2026-07-01T00:00:00.000Z'), 'target.createdAt이 새면 안 됨');
  assert.ok(!s.includes('2026-07-02T00:00:00.000Z'), 'target.updatedAt이 새면 안 됨');
});

test('payload: article/contents/target 부재에도 throw하지 않고 키 집합이 유지된다(null-tolerant)', () => {
  // articleModel.getById는 Article·Contents 중 하나만 있어도 행을 반환한다 — 손상 행에서 TypeError가 나면 안 된다.
  const noArticle = buildDistributionPayload({ contents: sampleContents(), target: sampleTarget(), distributedAt: DIST_AT });
  assert.deepEqual(Object.keys(noArticle.article), ARTICLE_KEYS);
  assert.equal(noArticle.article.markupVersion, null);
  assert.equal(noArticle.article.title, '기사 제목');
  assert.equal(noArticle.article.articleId, ARTICLE_ID, 'Article이 없으면 Contents의 articleId를 쓴다');

  const noContents = buildDistributionPayload({ article: sampleArticle(), target: sampleTarget(), distributedAt: DIST_AT });
  assert.deepEqual(Object.keys(noContents.article), ARTICLE_KEYS);
  assert.equal(noContents.article.markupVersion, MARKUP);
  assert.equal(noContents.article.title, 'Article쪽 제목');
  assert.equal(noContents.article.status, null);

  const noTarget = buildDistributionPayload({ article: sampleArticle(), contents: sampleContents() });
  assert.deepEqual(Object.keys(noTarget.target), ['id', 'name', 'kind', 'spoolDir']);
  assert.deepEqual(noTarget.target, { id: null, name: null, kind: null, spoolDir: null });

  // 전부 없거나 인자 자체가 없어도 같은 shape이다.
  for (const p of [buildDistributionPayload({}), buildDistributionPayload(), buildDistributionPayload({ article: null, contents: null, target: null })]) {
    assert.deepEqual(Object.keys(p), ['schema', 'version', 'distributedAt', 'audience', 'target', 'article']);
    assert.deepEqual(Object.keys(p.article), ARTICLE_KEYS);
    assert.equal(p.article.articleId, null);
  }
});

// ── B/C 공용 하네스 — 가짜 fs(in-memory). 실디스크에 절대 닿지 않는다. ─────────

const ROOT = '/spool/dist';
const SPOOL_DIR = 'yonhap-tv';
const COMPACT = '20260727T090000000Z'; // DIST_AT('2026-07-27T09:00:00.000Z')에서 - : . 만 제거한 형태
// 기대 경로는 반드시 join으로 만든다 — Windows에서 join('/spool','kbs')는 '\spool\kbs'다(문자열 하드코딩 금지).
const EXPECTED_DIR = join(ROOT, SPOOL_DIR);

function fakeFs(over = {}) {
  const files = new Map(); // path -> { data, enc }
  const dirs = []; // mkdirSync 호출 인자 기록
  return {
    files,
    dirs,
    fs: {
      mkdirSync: over.mkdirSync ?? ((dir, opts) => { dirs.push({ dir, opts }); }),
      writeFileSync: over.writeFileSync ?? ((p, data, enc) => { files.set(p, { data, enc }); }),
    },
  };
}

// ── B. write() 정상 경로 — 인자는 { target, payload } 둘뿐이다 ───────────────

test('write: enabled이며 payload에서 파생한 결정적 경로에 쓰고 { ok, path }를 반환한다', () => {
  const h = fakeFs();
  const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
  assert.equal(w.enabled, true);

  const payload = buildSample();
  const r = w.write({ target: sampleTarget(), payload });

  assert.deepEqual(r, { ok: true, path: join(EXPECTED_DIR, `${ARTICLE_ID}__${COMPACT}.json`) });
  assert.equal(h.files.size, 1);
  assert.ok(h.files.has(r.path));
});

test('write: mkdirSync가 (스풀 하위 폴더, { recursive: true })로 호출된다 — mkdir -p 동형', () => {
  const h = fakeFs();
  const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
  w.write({ target: sampleTarget(), payload: buildSample() });

  assert.equal(h.dirs.length, 1);
  assert.equal(h.dirs[0].dir, EXPECTED_DIR);
  assert.deepEqual(h.dirs[0].opts, { recursive: true });
});

test('write: 내용은 들여쓰기 2 + 끝 개행이고 인코딩은 utf8이며 JSON 왕복이 원본과 같다', () => {
  const h = fakeFs();
  const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
  const payload = buildSample();
  const r = w.write({ target: sampleTarget(), payload });

  const rec = h.files.get(r.path);
  assert.equal(rec.data, `${JSON.stringify(payload, null, 2)}\n`);
  assert.equal(rec.enc, 'utf8');
  assert.ok(rec.data.endsWith('\n'));
  assert.deepEqual(JSON.parse(rec.data), payload);
});

test('write: 파일명은 payload의 distributedAt·articleId에서 파생된다(별도 인자로 어긋날 여지 없음)', () => {
  const h = fakeFs();
  const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
  const target = sampleTarget();

  const later = w.write({ target, payload: buildSample({ distributedAt: '2026-07-27T09:00:00.001Z' }) });
  assert.equal(later.path, join(EXPECTED_DIR, `${ARTICLE_ID}__20260727T090000001Z.json`));

  const other = w.write({
    target,
    payload: buildSample({ article: sampleArticle({ articleId: 'AKR20260727000000001' }) }),
  });
  assert.equal(other.path, join(EXPECTED_DIR, `AKR20260727000000001__${COMPACT}.json`));
});

test('write: 같은 인자로 두 번 호출하면 같은 경로에 덮어쓴다(결정적·멱등 — 파일 1개)', () => {
  const h = fakeFs();
  const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
  const first = w.write({ target: sampleTarget(), payload: buildSample() });
  const second = w.write({ target: sampleTarget(), payload: buildSample() });

  assert.equal(first.path, second.path);
  assert.equal(h.files.size, 1, '재시도가 파일을 증식시키면 안 된다');
  assert.equal(h.files.get(first.path).data, `${JSON.stringify(buildSample(), null, 2)}\n`);
});

test('write: distributedAt이 1ms만 달라도 파일이 공존한다(정정본 배부 이력 보존)', () => {
  const h = fakeFs();
  const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
  w.write({ target: sampleTarget(), payload: buildSample() });
  w.write({ target: sampleTarget(), payload: buildSample({ distributedAt: '2026-07-27T09:00:00.001Z' }) });

  assert.equal(h.files.size, 2);
});

test('write: 한글 제목/본문이 UTF-8로 왕복된다(모지바케 없음)', () => {
  const h = fakeFs();
  const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
  const payload = buildSample({
    contents: sampleContents({ title: '한글 제목 — 태풍 북상' }),
  });
  const r = w.write({ target: sampleTarget(), payload });

  const rec = h.files.get(r.path);
  assert.equal(rec.enc, 'utf8');
  assert.ok(rec.data.includes('한글 제목 — 태풍 북상'));
  const back = JSON.parse(rec.data);
  assert.equal(back.article.title, '한글 제목 — 태풍 북상');
  assert.equal(back.article.markupVersion, MARKUP);
  assert.equal(back.target.name, '연합TV');
});

// ── C. 거부/실패 경로 — 어떤 경우에도 throw하지 않는다 ──────────────────────

test('write: rootDir 미설정/빈값/공백/비문자열이면 비활성이고 fs를 건드리지 않는다', () => {
  for (const bad of [undefined, '', '   ', '\t', 123, 0, null, true, {}, []]) {
    const h = fakeFs();
    const w = createSpoolWriter({ rootDir: bad, fs: h.fs });
    assert.equal(w.enabled, false, `비활성이어야 함: ${JSON.stringify(bad)}`);
    assert.deepEqual(w.write({ target: sampleTarget(), payload: buildSample() }), { ok: false, reason: 'disabled' });
    assert.equal(h.dirs.length, 0);
    assert.equal(h.files.size, 0);
  }
  // fs 미주입도 비활성이다(기본값 없음 — 실디스크로 새지 않는다).
  const noFs = createSpoolWriter({ rootDir: ROOT });
  assert.equal(noFs.enabled, false);
  assert.deepEqual(noFs.write({ target: sampleTarget(), payload: buildSample() }), { ok: false, reason: 'disabled' });
  // 인자 자체가 없어도 throw하지 않는다.
  assert.equal(createSpoolWriter().enabled, false);
  assert.deepEqual(createSpoolWriter().write(), { ok: false, reason: 'disabled' });
});

test('write: 오염된 spoolDir은 invalid-spool-dir이고 fs에 도달하지 않는다', () => {
  const bads = [
    '../etc', '..', 'a/b', 'a\\b', '/abs', 'C:\\x', 'kbs\u0000', 'con', 'nul', 'KBS',
    '.hidden', ' kbs', '', 'a'.repeat(65), null, undefined, 123, true, {},
  ];
  for (const bad of bads) {
    const h = fakeFs();
    const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
    const r = w.write({ target: sampleTarget({ spoolDir: bad }), payload: buildSample() });
    assert.deepEqual(r, { ok: false, reason: 'invalid-spool-dir' }, `거부되어야 함: ${JSON.stringify(bad)}`);
    assert.equal(h.dirs.length, 0, '경로 조작이 mkdir에 도달하면 안 된다');
    assert.equal(h.files.size, 0, '경로 조작이 write에 도달하면 안 된다');
  }
  // 키 누락·target 자체 부재도 같은 거부다.
  const h = fakeFs();
  const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
  const payload = buildSample();
  for (const target of [{ id: 1, name: 'x', kind: 'press' }, {}, null, undefined]) {
    assert.deepEqual(w.write({ target, payload }), { ok: false, reason: 'invalid-spool-dir' });
  }
  assert.equal(h.dirs.length, 0);
  assert.equal(h.files.size, 0);
});

test('write: 오염된 articleId는 invalid-article-id이고 fs에 도달하지 않는다', () => {
  const bads = ['../x', 'a/b', 'a\\b', '', ' AKR1', 'AKR 1', 'AKR;rm', 'a'.repeat(65), null, undefined, 123, true, {}];
  for (const bad of bads) {
    const h = fakeFs();
    const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
    const payload = buildSample();
    payload.article.articleId = bad;
    const r = w.write({ target: sampleTarget(), payload });
    assert.deepEqual(r, { ok: false, reason: 'invalid-article-id' }, `거부되어야 함: ${JSON.stringify(bad)}`);
    assert.equal(h.dirs.length, 0);
    assert.equal(h.files.size, 0);
  }
  // article 자체 부재·payload 부재도 같은 거부다(옵셔널 체이닝 결과 undefined가 타입 게이트에 걸린다).
  const h = fakeFs();
  const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
  for (const payload of [{ distributedAt: DIST_AT }, {}, null, undefined]) {
    assert.deepEqual(w.write({ target: sampleTarget(), payload }), { ok: false, reason: 'invalid-article-id' });
  }
  assert.equal(h.dirs.length, 0);
  assert.equal(h.files.size, 0);
});

test('write: 오염된 distributedAt은 invalid-timestamp — 강제변환 결함 잠금(CRITICAL)', () => {
  // 문자열 강제변환을 쓰면 null→'null', undefined→'undefined', 숫자→'1753612800000'이 되어
  // 느슨한 패턴을 통과하고 'AKR...__null.json' 같은 파일이 만들어진다. 반드시 typeof 게이트로 선차단해야 한다.
  const bads = [
    null, undefined, 1753612800000, 0, true, false, {}, [], new Date(DIST_AT),
    'null', 'undefined', 'true', '1753612800000', '2026-07-27', 'now', '', '   ',
    '2026-07-27T09:00:00Z', // 밀리초 없음 — now()의 toISOString은 항상 ms를 포함한다(엄격 유지)
    '2026-07-27T09:00:00.000', // Z 없음
    '../../evil', 'a/b',
  ];
  for (const bad of bads) {
    const h = fakeFs();
    const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
    const payload = buildSample();
    payload.distributedAt = bad;
    const r = w.write({ target: sampleTarget(), payload });
    assert.deepEqual(r, { ok: false, reason: 'invalid-timestamp' }, `거부되어야 함: ${JSON.stringify(bad)}`);
    assert.equal(h.dirs.length, 0, 'fs에 도달하면 안 된다');
    assert.equal(h.files.size, 0, "'AKR...__null.json'이 만들어지면 안 된다");
  }
});

test('write: mkdirSync가 throw하면 write-failed로 변환하고 writeFileSync를 호출하지 않는다', () => {
  const written = [];
  const h = fakeFs({
    mkdirSync: () => { throw new Error('EPERM: operation not permitted'); },
    writeFileSync: (p) => { written.push(p); },
  });
  const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });

  const r = w.write({ target: sampleTarget(), payload: buildSample() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'write-failed');
  assert.match(r.message, /EPERM/);
  assert.equal(written.length, 0);
});

test('write: writeFileSync가 throw하면 write-failed와 message를 돌려준다(throw 전파 없음)', () => {
  const h = fakeFs({ writeFileSync: () => { throw new Error('EACCES: permission denied'); } });
  const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });

  const r = w.write({ target: sampleTarget(), payload: buildSample() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'write-failed');
  assert.match(r.message, /EACCES/);
  assert.equal(r.path, undefined);
});

test('write: 직렬화 불가 payload(순환 참조)도 throw 없이 write-failed다', () => {
  const h = fakeFs();
  const w = createSpoolWriter({ rootDir: ROOT, fs: h.fs });
  const payload = buildSample();
  payload.self = payload;

  const r = w.write({ target: sampleTarget(), payload });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'write-failed');
  assert.equal(typeof r.message, 'string');
  assert.equal(h.files.size, 0);
});

// ── D. 아키텍처 가드 (소스 문자열 검사) ────────────────────────────────────

test('아키텍처: 모듈 소스에 실 fs·네트워크·타이머·강제변환이 없다', () => {
  // test/ 안에서 실 fs를 쓰는 것은 소스 검사 목적이므로 허용된다.
  const src = readFileSync(new URL('../src/services/spoolWriter.js', import.meta.url), 'utf8');

  for (const banned of ['node:fs', "require('fs')", 'setTimeout', 'setInterval', 'fetch(', 'process.env']) {
    assert.ok(!src.includes(banned), `금지: ${banned}`);
  }
  // 쓰기 전용 — 읽기·삭제·이동·존재확인(TOCTOU) 없음.
  for (const banned of ['existsSync', 'readFileSync', 'unlinkSync', 'rmSync', 'rename']) {
    assert.ok(!src.includes(banned), `금지: ${banned}`);
  }
  // 검증 규칙 재구현 금지 — 슬러그 규칙의 단일 출처는 spoolDir.js다.
  assert.ok(src.includes('sanitizeSpoolDir'), 'sanitizeSpoolDir에 위임해야 한다');
  assert.ok(!/\^\[a-z0-9\]/.test(src), '슬러그 정규식을 재구현하면 안 된다');
  // DB 비파괴 — 이 모듈은 SQL을 갖지 않는다.
  for (const banned of ['DELETE FROM', 'DROP', 'TRUNCATE']) {
    assert.ok(!src.includes(banned), `금지: ${banned}`);
  }
  // 문자열 강제변환은 catch 절의 에러 메시지 변환 단 한 곳뿐이다(파일명 재료 검증 경로에는 0건).
  const coercions = src.match(/String\([^)]*/g) ?? [];
  assert.equal(coercions.length, 1, '강제변환은 에러 메시지 변환 1곳만 허용된다');
  assert.match(coercions[0], /String\(err/);
});
