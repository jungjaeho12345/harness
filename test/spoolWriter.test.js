// 배부 스풀 writer 테스트 — ADR-008 (1) 파일 스풀 outbound.
// CRITICAL: 실제 파일시스템을 쓰지 않는다. mkdir/writeFile/rename을 주입해 호출 인자만 단언한다
// (수집 ftpWatcher 테스트와 동형 — 환경 의존·잔여 파일 0).
// 외부 수신처로 나가는 파일이므로 필드 allowlist(내부코멘트·편집 잠금 제외)가 이 모듈의 계약이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, join, sep } from 'node:path';
import { createSpoolWriter } from '../src/services/spoolWriter.js';

// 호출을 기록하는 가짜 FS. fail 집합에 든 op는 reject한다.
function fakeFs({ fail = new Set() } = {}) {
  const calls = { mkdir: [], writeFile: [], rename: [] };
  const op = (name) => async (...args) => {
    calls[name].push(args);
    if (fail.has(name)) throw new Error(`${name} 실패`);
    return undefined;
  };
  return { calls, mkdir: op('mkdir'), writeFile: op('writeFile'), rename: op('rename') };
}

const NOW = '2026-07-28T01:02:03.456Z';

// 입력은 POSIX 문자열 그대로 둔다 — 프로덕션이 이 입력을 OS 규약(join)으로 합성하는지가 검증 대상이다.
// 기대값은 반드시 join()으로 계산해 Windows/POSIX 양쪽에서 통과하게 한다.
const SPOOL_ROOT = '/spool/out';

function make(overrides = {}) {
  const fs = fakeFs(overrides.fsOptions);
  const writer = createSpoolWriter({
    rootDir: SPOOL_ROOT,
    mkdir: fs.mkdir,
    writeFile: fs.writeFile,
    rename: fs.rename,
    now: () => NOW,
    ...overrides.writer,
  });
  return { fs, writer };
}

const ARTICLE = { articleId: 'AKR20260728123456789', title: '본문 제목', markupVersion: '{"blocks":[{"text":"한글 본문 (끝)"}]}' };
const CONTENTS = {
  articleId: 'AKR20260728123456789',
  title: '기사 제목',
  author: 'reporter1',
  coAuthor: '공동작성',
  department: '정치부',
  departmentCode: 'P01',
  region: '서울',
  attribute: '자동기사',
  keyword: '키워드',
  externalComment: '외부코멘트',
  internalComment: '내부코멘트 — 절대 나가면 안 됨',
  attachmentFile: '/uploads/a.pdf',
  referenceFile: '',
  createdAt: '2026-07-28T00:00:00.000Z',
  sentAt: '2026-07-28T01:00:00.000Z',
  embargoAt: '',
  secondEmbargoAt: '2026-07-29T00:00:00.000Z',
  status: 'EPS',
  lockYN: 'Y',
  lockerUserId: 'desk1',
  lockerSessionId: 'sess-secret',
  lockerClientId: 'tab-1',
  lockedAt: '2026-07-28T00:30:00.000Z',
};

test('spoolWriter: 수신처 폴더를 recursive mkdir 후 임시 파일에 쓰고 rename으로 게시한다', async () => {
  const { fs, writer } = make();
  const r = await writer.write({ spoolDir: 'kbs', articleId: ARTICLE.articleId, article: ARTICLE, contents: CONTENTS });

  assert.equal(r.ok, true);
  assert.equal(fs.calls.mkdir.length, 1);
  assert.equal(fs.calls.mkdir[0][0], join(SPOOL_ROOT, 'kbs'));
  assert.deepEqual(fs.calls.mkdir[0][1], { recursive: true });

  // 임시 파일 → rename(원자적 게시). 부분 기록 파일을 외부 전송기가 집어가지 못하게 한다.
  assert.equal(fs.calls.writeFile.length, 1);
  assert.equal(fs.calls.rename.length, 1);
  const tmpPath = fs.calls.writeFile[0][0];
  const [renameFrom, renameTo] = fs.calls.rename[0];
  assert.equal(renameFrom, tmpPath);
  assert.equal(renameTo, r.file);
  assert.notEqual(tmpPath, renameTo, '임시 파일명과 최종 파일명이 같으면 원자적 게시가 아니다');
  assert.equal(String(tmpPath).startsWith(join(SPOOL_ROOT, 'kbs') + sep), true, `수신처 폴더 하위여야 함: ${tmpPath}`);
  assert.match(basename(tmpPath), /^\..+\.tmp$/, '임시 파일명은 .으로 시작하고 .tmp로 끝난다');
  assert.equal(fs.calls.writeFile[0][2], 'utf8');
});

test('spoolWriter: 파일명은 <articleId>_<timestamp>.json 이며 재배부해도 덮어쓰지 않는다', async () => {
  const { fs, writer } = make();
  await writer.write({ spoolDir: 'kbs', articleId: ARTICLE.articleId, article: ARTICLE, contents: CONTENTS });
  assert.equal(
    fs.calls.rename[0][1],
    join(SPOOL_ROOT, 'kbs', `${ARTICLE.articleId}_20260728T010203456Z.json`),
  );

  // 다른 시각에 다시 배부하면 다른 파일명 — 이전 배부본이 남는다(외부 전송기가 아직 안 가져갔을 수 있다).
  const second = createSpoolWriter({
    rootDir: SPOOL_ROOT, mkdir: fs.mkdir, writeFile: fs.writeFile, rename: fs.rename,
    now: () => '2026-07-28T01:02:04.000Z',
  });
  const r2 = await second.write({ spoolDir: 'kbs', articleId: ARTICLE.articleId, article: ARTICLE, contents: CONTENTS });
  assert.notEqual(r2.file, fs.calls.rename[0][1]);
});

test('spoolWriter: 페이로드는 allowlist 필드만 담고 내부코멘트·편집 잠금 컬럼은 싣지 않는다', async () => {
  const { fs, writer } = make();
  await writer.write({
    spoolDir: 'kbs',
    articleId: ARTICLE.articleId,
    article: ARTICLE,
    // 미지의 컬럼이 섞여 들어와도 통과하지 못한다(블랙리스트가 아닌 allowlist).
    contents: { ...CONTENTS, secretColumn: 'leak' },
  });

  const payload = JSON.parse(fs.calls.writeFile[0][1]);
  assert.equal(payload.articleId, ARTICLE.articleId);
  assert.equal(payload.title, '기사 제목');
  assert.equal(payload.markupVersion, ARTICLE.markupVersion);
  assert.equal(payload.status, 'EPS');
  assert.equal(payload.secondEmbargoAt, '2026-07-29T00:00:00.000Z');
  assert.equal(payload.distributedAt, NOW, '스풀 기록 시각을 서버가 stamp한다(ADR-008)');

  for (const forbidden of ['internalComment', 'lockYN', 'lockerUserId', 'lockerSessionId', 'lockerClientId', 'lockedAt', 'secretColumn']) {
    assert.equal(Object.hasOwn(payload, forbidden), false, `외부로 나가면 안 되는 필드: ${forbidden}`);
  }
});

test('spoolWriter: 한글 본문이 UTF-8로 그대로 직렬화된다', async () => {
  const { fs, writer } = make();
  await writer.write({ spoolDir: 'kbs', articleId: ARTICLE.articleId, article: ARTICLE, contents: CONTENTS });
  const raw = fs.calls.writeFile[0][1];
  assert.match(raw, /한글 본문/);
  assert.equal(JSON.parse(raw).department, '정치부');
});

test('spoolWriter: contents 없이(article만) 써도 성공하고 없는 필드는 생략된다', async () => {
  const { fs, writer } = make();
  const r = await writer.write({ spoolDir: 'kbs', articleId: ARTICLE.articleId, article: ARTICLE });
  assert.equal(r.ok, true);
  const payload = JSON.parse(fs.calls.writeFile[0][1]);
  assert.equal(payload.articleId, ARTICLE.articleId);
  assert.equal(payload.title, ARTICLE.title, 'Contents.title이 없으면 Article.title로 폴백한다');
  assert.equal(Object.hasOwn(payload, 'author'), false);
});

test('spoolWriter: 잘못된 spoolDir는 파일을 쓰지 않고 invalid-spool-dir로 거부한다', async () => {
  for (const bad of ['/etc', '..', 'a/b', 'KBS', '', '   ', null, undefined, 123, 'con', 'a'.repeat(65)]) {
    const { fs, writer } = make();
    const r = await writer.write({ spoolDir: bad, articleId: ARTICLE.articleId, article: ARTICLE, contents: CONTENTS });
    assert.deepEqual(r, { ok: false, reason: 'invalid-spool-dir' }, `거부되어야 함: ${String(bad)}`);
    assert.equal(fs.calls.mkdir.length, 0, '거부 시 디렉토리도 만들지 않는다');
    assert.equal(fs.calls.writeFile.length, 0);
  }
});

test('spoolWriter: 잘못된 articleId는 파일을 쓰지 않고 invalid-article-id로 거부한다', async () => {
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '', '   ', null, undefined, 42, {}, 'a'.repeat(65), 'AKR\u0000x']) {
    const { fs, writer } = make();
    const r = await writer.write({ spoolDir: 'kbs', articleId: bad, article: ARTICLE, contents: CONTENTS });
    assert.deepEqual(r, { ok: false, reason: 'invalid-article-id' }, `거부되어야 함: ${String(bad)}`);
    assert.equal(fs.calls.writeFile.length, 0);
  }
});

test('spoolWriter: FS 실패는 throw하지 않고 spool-write-failed로 반환한다', async () => {
  for (const op of ['mkdir', 'writeFile', 'rename']) {
    const { writer } = make({ fsOptions: { fail: new Set([op]) } });
    const r = await writer.write({ spoolDir: 'kbs', articleId: ARTICLE.articleId, article: ARTICLE, contents: CONTENTS });
    assert.deepEqual(r, { ok: false, reason: 'spool-write-failed' }, `${op} 실패가 격리되어야 한다`);
  }
});

test('spoolWriter: rootDir 미설정이면 쓰지 않고 거부한다', async () => {
  const fs = fakeFs();
  const writer = createSpoolWriter({ mkdir: fs.mkdir, writeFile: fs.writeFile, rename: fs.rename });
  const r = await writer.write({ spoolDir: 'kbs', articleId: ARTICLE.articleId, article: ARTICLE, contents: CONTENTS });
  assert.equal(r.ok, false);
  assert.equal(fs.calls.writeFile.length, 0);
});
