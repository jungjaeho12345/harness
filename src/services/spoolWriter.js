// 배부 스풀 writer — ADR-008 (1) 파일 스풀 outbound.
// 앱은 배부 스풀 루트 아래 수신처별 하위 폴더에 기사 파일(JSON, markupVersion 포함)을 "쓰기만" 한다.
// 실제 발송은 외부 전송기가 담당한다 — 이 모듈에는 네트워크 egress도 타이머도 없다.
//
// 이 모듈이 단일 출처로 소유하는 것:
//  (1) 외부로 나가는 파일의 shape(필드 allowlist) — 호출자가 페이로드를 조립하지 않는다.
//  (2) 경로 합성 안전성(spoolDir 슬러그 재검증 + articleId 화이트리스트).
//  (3) 원자적 게시(임시 파일 → rename).
// mkdir/writeFile/rename은 주입 가능하다 — 테스트는 실제 FS를 쓰지 않는다(ftpWatcher와 동형).

import { mkdir as fsMkdir, writeFile as fsWriteFile, rename as fsRename } from 'node:fs/promises';
import { join } from 'node:path';

import { sanitizeSpoolDir } from './spoolDir.js';

// 파일명에 합성되는 값이므로 경로 구분자·'..'·공백을 원천 차단한다(articleId 생성 규칙은 'AKR'+YYYYMMDD+난수 9자리).
const ARTICLE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// 외부 수신처로 나가는 필드 allowlist(블랙리스트 아님) — 새 컬럼이 추가돼도 기본값은 "미노출"이다.
// internalComment(내부코멘트)와 편집 잠금 컬럼(lockYN/locker*/lockedAt)은 의도적으로 제외한다.
const CONTENTS_FIELDS = [
  'articleId', 'title', 'author', 'coAuthor', 'department', 'departmentCode',
  'category', 'region', 'attribute', 'keyword', 'externalComment',
  'attachmentFile', 'referenceFile', 'createdAt', 'sentAt',
  'embargoAt', 'secondEmbargoAt', 'status',
];
// 본문 마크업은 Article 행에서 가져온다(ADR-008이 요구하는 필수 항목).
const ARTICLE_FIELDS = ['markupVersion'];

function pick(src, fields, out = {}) {
  if (!src) return out;
  for (const f of fields) if (src[f] !== undefined && src[f] !== null) out[f] = src[f];
  return out;
}

// ISO-8601을 파일명 안전한 compact 형태로: 2026-07-28T01:02:03.456Z → 20260728T010203456Z
function compactStamp(iso) {
  return String(iso).replace(/[-:.]/g, '');
}

export function createSpoolWriter({
  rootDir,
  mkdir = fsMkdir,
  writeFile = fsWriteFile,
  rename = fsRename,
  now = () => new Date().toISOString(),
}) {
  // 기사 1건을 수신처 1곳의 스풀 폴더에 쓴다. 실패는 throw하지 않고 { ok:false, reason }으로 반환한다
  // — 한 수신처의 실패가 다른 수신처나 송고(상태 전이)를 막아서는 안 된다(distributionService의 전제).
  async function write({ spoolDir, articleId, article, contents } = {}) {
    if (!rootDir) return { ok: false, reason: 'spool-disabled' };

    // DB에 저장된 값이라도 신뢰하지 않는다 — 경로 합성 직전이 마지막 방어 지점이다.
    const dir = sanitizeSpoolDir(spoolDir);
    if (dir === '') return { ok: false, reason: 'invalid-spool-dir' };
    if (typeof articleId !== 'string' || !ARTICLE_ID.test(articleId)) {
      return { ok: false, reason: 'invalid-article-id' };
    }

    const stamp = now();
    // 페이로드는 여기서만 조립한다(allowlist). title은 Contents 우선, 없으면 Article로 폴백.
    const payload = pick(article, ARTICLE_FIELDS, pick(contents, CONTENTS_FIELDS));
    payload.articleId = articleId;
    if (payload.title === undefined && article && article.title !== undefined) payload.title = article.title;
    // 스풀 기록 시각 = 배부 지시 시각(ADR-008 트레이드오프: 발송 완료가 아니다).
    payload.distributedAt = stamp;

    const targetDir = join(rootDir, dir);
    const name = `${articleId}_${compactStamp(stamp)}.json`;
    const finalPath = join(targetDir, name);
    // 같은 디렉토리 안 임시 파일에 먼저 쓴다 — 외부 전송기가 부분 기록 파일을 집어가지 못하게 한다
    // (수집 watcher가 부분 파일을 읽는 문제의 대칭). 같은 볼륨이라 rename이 원자적이다.
    const tmpPath = join(targetDir, `.${name}.tmp`);

    try {
      await mkdir(targetDir, { recursive: true });
      await writeFile(tmpPath, JSON.stringify(payload), 'utf8');
      await rename(tmpPath, finalPath);
      return { ok: true, file: finalPath };
    } catch {
      // 발송 실패 재전송은 후속(MVP-4) — 여기서는 결과만 보고한다.
      return { ok: false, reason: 'spool-write-failed' };
    }
  }

  return { write };
}
