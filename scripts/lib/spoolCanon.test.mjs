// scripts/lib/spoolCanon.mjs 의 순수 정규화부 단위 테스트 (phase 76 step0).
//
// 왜 여기에 있고 npm test 가 돌지 않는가:
//   package.json 은 무수정 목록이고 `npm test` 는 "test/**/*.test.js" 만 훑는다(1328건 고정).
//   배부 스풀 바이트 대조 로직은 fs·서버 없이 순수 함수로 잠글 수 있어야 하므로(그래야 두 서버의
//   직렬화 divergence 를 대조가 조용히 삼키지 않는다는 성질을 격리 검증할 수 있다) 이 모듈로 빼서
//   여기서 잠근다. mysqlHarness.test.mjs 와 동형이다.
//
// 실행: node --test scripts/lib/spoolCanon.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STAMP,
  canonicalizeSpoolName,
  canonicalizeSpoolContent,
  readSpoolManifest,
  diffManifests,
} from './spoolCanon.mjs';

// 스풀 writer(src/services/spoolWriter.js)가 실제로 쓰는 형태:
//   JSON.stringify(payload) — 공백 없음 · 키 순서는 삽입 순서 · distributedAt 은 tick 벽시계.
//   파일명 = `${articleId}_${compactStamp(distributedAt)}.json`, compactStamp = ISO에서 [-:.] 제거.
const ISO = '2026-07-28T01:02:03.456Z';
const COMPACT = '20260728T010203456Z'; // compactStamp(ISO)

// --- 1. distributedAt 값만 STAMP 로, 그 외(값·키 순서)는 한 글자도 안 바꾼다 ---

test('canonicalizeSpoolContent 는 distributedAt 값만 STAMP 로 바꾸고 나머지를 보존한다', () => {
  const raw = `{"articleId":"AKR1","title":"제목","distributedAt":"${ISO}","status":"sent"}`;
  assert.equal(
    canonicalizeSpoolContent(raw),
    `{"articleId":"AKR1","title":"제목","distributedAt":"${STAMP}","status":"sent"}`,
  );
});

test('canonicalizeSpoolContent 는 distributedAt 이 없으면 원문 그대로다', () => {
  const raw = '{"articleId":"AKR1","title":"제목"}';
  assert.equal(canonicalizeSpoolContent(raw), raw);
});

// --- 2. 키 순서가 다른 두 원문은 content diff 로 잡힌다(정렬로 삼키지 않음) ---

test('키 순서만 다른 두 원문은 diffManifests 가 content diff 로 잡는다', () => {
  const rawA = `{"articleId":"AKR1","title":"T","distributedAt":"${ISO}"}`;
  const rawB = `{"title":"T","articleId":"AKR1","distributedAt":"2026-07-28T09:09:09.999Z"}`;
  const a = [{ key: 'r/AKR1', canonName: `AKR1_${STAMP}.json`, canonContent: canonicalizeSpoolContent(rawA) }];
  const b = [{ key: 'r/AKR1', canonName: `AKR1_${STAMP}.json`, canonContent: canonicalizeSpoolContent(rawB) }];
  const { equal, diffs } = diffManifests(a, b);
  assert.equal(equal, false);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].kind, 'content');
  assert.equal(diffs[0].key, 'r/AKR1');
});

// --- 3. 파일명은 compactStamp 부분만 정규화하고, 형태가 다르면 원문을 유지한다 ---

test('canonicalizeSpoolName 은 compactStamp 부분만 STAMP 로 바꾼다', () => {
  assert.equal(
    canonicalizeSpoolName(`AKR20260728123456789_${COMPACT}.json`),
    `AKR20260728123456789_${STAMP}.json`,
  );
});

test('canonicalizeSpoolName 은 타임스탬프 패턴이 아니면 원문을 그대로 돌려준다', () => {
  for (const name of ['weird-name.json', 'AKR1_notastamp.json', 'AKR1.json', `AKR1_${COMPACT}.txt`]) {
    assert.equal(canonicalizeSpoolName(name), name, `건드리면 안 된다: ${name}`);
  }
});

// --- 4. readSpoolManifest 는 주입 fs 로 다중 수신처·다중 기사 트리를 key 오름차순 평탄화 ---

function makeFakeFs(files) {
  function readdir(dir) {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const fileNames = new Set();
    const dirNames = new Set();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) fileNames.add(rest);
      else dirNames.add(rest.slice(0, slash));
    }
    // 디렉토리 먼저, 파일 나중 — 정렬 안 된 순서를 일부러 흘려 매니페스트 정렬을 시험한다.
    const entries = [];
    for (const n of dirNames) entries.push({ name: n, isDirectory: () => true });
    for (const n of fileNames) entries.push({ name: n, isDirectory: () => false });
    return Promise.resolve(entries);
  }
  function readFile(path) {
    if (!(path in files)) return Promise.reject(new Error(`ENOENT ${path}`));
    return Promise.resolve(files[path]);
  }
  return { readdir, readFile };
}

const CONTENT_1 = `{"articleId":"AKR1","distributedAt":"${ISO}"}`;
const CONTENT_2 = `{"articleId":"AKR2","distributedAt":"${ISO}"}`;
const CONTENT_3 = `{"articleId":"AKR3","distributedAt":"${ISO}"}`;

const TREE = {
  [`root/receiverB/AKR2_${COMPACT}.json`]: CONTENT_2,
  [`root/receiverA/AKR3_${COMPACT}.json`]: CONTENT_3,
  [`root/receiverA/AKR1_${COMPACT}.json`]: CONTENT_1,
};

test('readSpoolManifest 는 다중 수신처·다중 기사 트리를 key 오름차순으로 평탄화한다', async () => {
  const manifest = await readSpoolManifest('root', makeFakeFs(TREE));
  assert.deepEqual(manifest.map((e) => e.key), [
    'receiverA/AKR1', 'receiverA/AKR3', 'receiverB/AKR2',
  ]);
  assert.equal(manifest[0].canonName, `AKR1_${STAMP}.json`);
  assert.equal(manifest[0].canonContent, `{"articleId":"AKR1","distributedAt":"${STAMP}"}`);
});

// --- 5. 동일 트리 → equal · 파일 누락 → only-in diff ---

test('동일 트리는 equal: true, diffs: []', async () => {
  const fs = makeFakeFs(TREE);
  const a = await readSpoolManifest('root', fs);
  const b = await readSpoolManifest('root', fs);
  assert.deepEqual(diffManifests(a, b), { equal: true, diffs: [] });
});

test('한쪽에 파일이 빠지면 only-in diff 로 잡는다', async () => {
  const a = await readSpoolManifest('root', makeFakeFs(TREE));
  const missing = { ...TREE };
  delete missing[`root/receiverB/AKR2_${COMPACT}.json`];
  const b = await readSpoolManifest('root', makeFakeFs(missing));
  const { equal, diffs } = diffManifests(a, b);
  assert.equal(equal, false);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].kind, 'only-in-a');
  assert.equal(diffs[0].key, 'receiverB/AKR2');

  const swapped = diffManifests(b, a);
  assert.equal(swapped.diffs[0].kind, 'only-in-b');
});

// --- 7. name-kind diff: 같은 key·같은 content 인데 canonName 만 다르면 'name' diff (보강) ---
// 한 서버는 정상 stamp(`_<compactStamp>.json`)를, 다른 서버는 비패턴 파일명을 쓰면 articleId(마지막 '_' 앞)는
// 같아 key 가 겹치지만 canonName 은 갈린다 — diffManifests 가 이를 'name' kind 로 드러내야 한다(원문 값 그대로 진단).
test('canonName 만 다르면 diffManifests 가 name diff 로 잡는다(content 는 무변)', () => {
  const a = [{ key: 'r/AKR1', canonName: `AKR1_${STAMP}.json`, canonContent: 'X' }];
  const b = [{ key: 'r/AKR1', canonName: 'AKR1_notastamp.json', canonContent: 'X' }];
  const { equal, diffs } = diffManifests(a, b);
  assert.equal(equal, false);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].kind, 'name');
  assert.equal(diffs[0].key, 'r/AKR1');
  assert.equal(diffs[0].a, `AKR1_${STAMP}.json`);
  assert.equal(diffs[0].b, 'AKR1_notastamp.json');
});

// --- 8. readSpoolManifest 는 .json 이 아닌 항목(원자적 게시 전의 .tmp 등)을 매니페스트에서 제외한다(보강) ---
// spoolWriter 는 tmp→rename 으로 원자 게시한다 — 반쯤 써진 .tmp 가 매니페스트에 새면 두 서버 대조가 거짓 diff 를 낸다.
test('readSpoolManifest 는 .json 이 아닌 항목(.tmp 등)을 건너뛴다', async () => {
  const tree = {
    [`root/receiverA/AKR1_${COMPACT}.json`]: CONTENT_1,
    [`root/receiverA/AKR9_${COMPACT}.json.tmp`]: '{"partial":true}',
    ['root/receiverA/README.txt']: 'not a spool file',
  };
  const manifest = await readSpoolManifest('root', makeFakeFs(tree));
  assert.deepEqual(manifest.map((e) => e.key), ['receiverA/AKR1']);
});

// --- 9. stableArticleId 는 articleId 자체의 '_' 를 보존한다(마지막 '_' 앞만 stamp 로 취급) (보강) ---
// 파일명 `${articleId}_${compactStamp}.json` 에서 마지막 '_' 앞이 articleId 다 — articleId 안의 '_' 는 key 에 남는다.
test('readSpoolManifest 는 articleId 내부의 밑줄을 보존한다(마지막 밑줄만 stamp 경계)', async () => {
  const tree = {
    [`root/pressZ/PRESS_A_${COMPACT}.json`]: `{"articleId":"PRESS_A","distributedAt":"${ISO}"}`,
  };
  const manifest = await readSpoolManifest('root', makeFakeFs(tree));
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].key, 'pressZ/PRESS_A');
  assert.equal(manifest[0].canonName, `PRESS_A_${STAMP}.json`);
});

// --- 6. content diff 리포트에 스풀 값 원문이 실리지 않는다(길이/해시만) ---

test('content diff 리포트는 스풀 값 원문을 싣지 않고 길이/해시만 싣는다', () => {
  const secret = 'SENSITIVE-ARTICLE-BODY-개인정보';
  const rawA = `{"articleId":"AKR1","body":"${secret}","distributedAt":"${ISO}"}`;
  const rawB = `{"articleId":"AKR1","body":"다른내용","distributedAt":"${ISO}"}`;
  const a = [{ key: 'r/AKR1', canonName: `AKR1_${STAMP}.json`, canonContent: canonicalizeSpoolContent(rawA) }];
  const b = [{ key: 'r/AKR1', canonName: `AKR1_${STAMP}.json`, canonContent: canonicalizeSpoolContent(rawB) }];
  const { diffs } = diffManifests(a, b);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].kind, 'content');

  const serialized = JSON.stringify(diffs);
  assert.ok(!serialized.includes(secret), `원문이 실렸다: ${serialized}`);
  assert.ok(!serialized.includes('다른내용'), `원문이 실렸다: ${serialized}`);
  // 비복원 지표만: 길이와 해시.
  assert.equal(typeof diffs[0].a.length, 'number');
  assert.equal(typeof diffs[0].b.length, 'number');
  assert.match(diffs[0].a.sha256, /^[0-9a-f]{64}$/);
  assert.match(diffs[0].b.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(diffs[0].a.sha256, diffs[0].b.sha256);
});
