// 배부 스풀 트리 정규화 + 바이트 대조 — phase 76 step0 (순수 모듈).
//
// 목적: Node(SQLite)와 Spring 이 **동일 seed 행**에서 `POST /api/distribution/tick` 만으로 쓴 스풀
//   파일 트리를, 서버 벽시계로 tick 시점에 찍히는 **볼러타일 필드 둘**(스풀 파일 안의 `distributedAt`
//   값과 파일명의 그 타임스탬프)만 가리고 나머지 원문은 그대로 두어 **바이트 대조**한다. 그것이
//   계약 패리티(HTTP 응답)가 못 보던 **파일 레벨** 축이다(index.json decisions (3)).
//
// CRITICAL(계약 패리티가 못 보던 축을 삼키지 않기 위한 규칙):
//  - JSON.parse 후 재직렬화 금지. 키 순서·이스케이프·숫자 표기·공백을 보존해야 두 서버의 직렬화
//    divergence(그리고 MySQL 왕복 divergence)를 대조가 잡는다.
//  - distributedAt 은 **값만** 가린다. 그 외 원문은 한 글자도 바꾸지 않는다.
//  - 파일명은 compactStamp 부분만 가린다. 패턴이 아니면 원문 그대로 둔다(정규화 실패를 조용히
//    삼키지 말 것 — diff 로 드러나야 한다).
//  - content 불일치를 보고할 때 스풀 값 원문을 싣지 않는다(기사 본문·개인정보) — 길이/sha256 등
//    비복원 지표만 싣는다(리포트·로그 위생).
//
// fs 는 주입 의존성이다(readdir/readFile) — 테스트는 실제 FS 를 쓰지 않는다(spoolWriter 와 동형).

import crypto from 'node:crypto';
import { readdir as fsReaddir, readFile as fsReadFile } from 'node:fs/promises';
import { posix } from 'node:path';

/** 볼러타일 필드를 가린 자리에 놓는 안정 토큰. */
export const STAMP = '<STAMP>';

// spoolWriter.compactStamp: ISO(2026-07-28T01:02:03.456Z) → 20260728T010203456Z.
// toISOString 은 항상 UTC(Z)·밀리초 3자리를 주므로 파일명의 stamp 는 `YYYYMMDDTHHMMSSsssZ` 형태다.
// 파일명은 `${articleId}_${compactStamp}.json` 이고 articleId 는 '_' 를 포함할 수 있으므로 끝에서
// 앵커한다($) — 마지막 `_<stamp>.json` 만 잡는다.
const STAMP_IN_NAME = /_(\d{8}T\d{9}Z)(\.json)$/;

// 스풀 파일 원문의 distributedAt — 키와 값 사이 공백까지 캡처로 보존하고 **값만** 치환한다.
const DISTRIBUTED_AT = /("distributedAt"\s*:\s*")([^"]*)(")/;

/**
 * 파일명의 타임스탬프 부분만 STAMP 로 치환한다. 패턴에 맞지 않으면 입력을 그대로 돌려준다.
 */
export function canonicalizeSpoolName(name) {
  return String(name).replace(STAMP_IN_NAME, `_${STAMP}$2`);
}

/**
 * 스풀 파일 원문에서 distributedAt 의 **값만** STAMP 로 치환한다(그 외는 무변경).
 */
export function canonicalizeSpoolContent(rawText) {
  return String(rawText).replace(DISTRIBUTED_AT, `$1${STAMP}$3`);
}

// 파일명에서 타임스탬프를 뺀 안정 articleId. 파일명은 `${articleId}_${compactStamp}.json` 이고
// compactStamp 에는 '_' 가 없으므로 마지막 '_' 앞이 articleId 다(articleId 자체의 '_' 는 보존된다).
// 형태가 다르면(stamp 없음) 키가 갈려 only-in 으로 드러난다 — 그건 diff 가 잡아야 할 일이다.
function stableArticleId(name) {
  const base = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
  const underscore = base.lastIndexOf('_');
  return underscore >= 0 ? base.slice(0, underscore) : base;
}

/**
 * rootDir 아래를 재귀로 훑어 { key, canonName, canonContent }[] 를 key 오름차순으로 돌려준다.
 *   key = "<수신처 하위폴더 slug>/<articleId>" (파일명의 타임스탬프를 뺀 안정 키)
 * .json 이 아닌 항목(원자적 게시 전의 .tmp 등)은 매니페스트에 넣지 않는다.
 */
export async function readSpoolManifest(rootDir, {
  readdir = (dir) => fsReaddir(dir, { withFileTypes: true }),
  readFile = (path) => fsReadFile(path, 'utf8'),
} = {}) {
  const out = [];
  await walk(String(rootDir), '', readdir, readFile, out);
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

async function walk(dir, relDir, readdir, readFile, out) {
  const entries = await readdir(dir);
  for (const entry of entries) {
    const name = entry.name;
    const full = posix.join(dir, name);
    if (entry.isDirectory()) {
      await walk(full, relDir ? posix.join(relDir, name) : name, readdir, readFile, out);
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const articleId = stableArticleId(name);
    const key = relDir ? `${relDir}/${articleId}` : articleId;
    const raw = await readFile(full);
    out.push({
      key,
      canonName: canonicalizeSpoolName(name),
      canonContent: canonicalizeSpoolContent(raw),
    });
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// content 불일치의 비복원 지표(원문은 절대 싣지 않는다).
function fingerprint(text) {
  return { length: String(text).length, sha256: sha256(text) };
}

/**
 * 두 매니페스트를 비교한다.
 *   반환: { diffs: [{ key, kind: 'only-in-a'|'only-in-b'|'name'|'content', ... }], equal }
 * key 오름차순으로 안정 출력한다. content diff 는 길이/sha256 지문만 싣는다.
 */
export function diffManifests(a, b) {
  const mapA = new Map((a ?? []).map((e) => [e.key, e]));
  const mapB = new Map((b ?? []).map((e) => [e.key, e]));
  const keys = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();

  const diffs = [];
  for (const key of keys) {
    const ea = mapA.get(key);
    const eb = mapB.get(key);
    if (!ea) { diffs.push({ key, kind: 'only-in-b' }); continue; }
    if (!eb) { diffs.push({ key, kind: 'only-in-a' }); continue; }
    // 파일명(articleId + STAMP)은 민감 본문이 아니므로 값 그대로 실어 진단을 돕는다.
    if (ea.canonName !== eb.canonName) {
      diffs.push({ key, kind: 'name', a: ea.canonName, b: eb.canonName });
    }
    if (ea.canonContent !== eb.canonContent) {
      diffs.push({ key, kind: 'content', a: fingerprint(ea.canonContent), b: fingerprint(eb.canonContent) });
    }
  }
  return { diffs, equal: diffs.length === 0 };
}
