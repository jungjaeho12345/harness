// SEA 번들 그래프의 import.meta 예산 잠금 (phase 61 테스트 게이트 보강).
// 배경: esbuild CJS 번들에서 import.meta는 빈 객체가 된다 — 참조 지점 수만큼 empty-import-meta
// 경고가 늘고, scripts/sea-build.mjs의 빌드 게이트는 "정확히 1건"만 허용한다(초과 = 빌드 실패).
// 그 1건은 server/index.js 모듈 스코프의 `const selfUrl = import.meta.url;` 캡처뿐이어야 한다.
// 이 테스트가 없으면 bootstrap 본문 등에 import.meta가 되살아나도 단위 스위트는 green이고
// 수십 초짜리 SEA 빌드에서야 red가 된다(phase 61 변이 검증 (5) 실측) — 여기서 즉시 잡는다.
// 스캔 범위 = SEA 번들 그래프 소스(server/** + src/**)뿐이다. scripts/**·web/**·test/**는
// 번들에 들어가지 않으므로 세지 않는다(빌드 스크립트 자신은 import.meta를 써도 안전하다).
// 주의(엄격성 — 의도된 설계): 이 스캔은 텍스트 기반이라 주석·문자열 안의 리터럴도 센다.
// server/**·src/**의 설명 주석에서는 그 단어를 쓰지 말고 '모듈 메타'라고 써라(server/index.js
// 1258행이 그 관행이다). 주석 제외 파싱은 넣지 않는다 — 파서 자체가 새 오탐·누락원이 된다.
// 파일시스템 읽기 전용 — DB·네트워크·프로세스 부수효과 없음.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('SEA 잠금: 번들 그래프(server/**+src/**)의 import.meta 참조는 server/index.js 모듈 스코프 selfUrl 캡처 정확히 1건뿐이다', () => {
  const files = [
    ...listJsFiles(path.join(REPO_ROOT, 'server')),
    ...listJsFiles(path.join(REPO_ROOT, 'src')),
  ];
  assert.ok(files.length > 0, '스캔 대상 파일이 없다 — 경로 확인');

  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      let idx = lines[i].indexOf('import.meta');
      while (idx !== -1) {
        hits.push({ file: path.relative(REPO_ROOT, file), line: i + 1, text: lines[i].trim() });
        idx = lines[i].indexOf('import.meta', idx + 1);
      }
    }
  }

  assert.equal(
    hits.length, 1,
    `import.meta 참조가 정확히 1건이어야 한다(빌드 게이트 empty-import-meta=1 계약). `
    + `이 스캔은 텍스트 기반이라 주석·문자열 안의 리터럴도 센다 — 설명이 필요하면 '모듈 메타'라고 써라. 발견:\n`
    + hits.map((h) => `  ${h.file}:${h.line} ${h.text}`).join('\n'),
  );
  assert.equal(hits[0].file, path.join('server', 'index.js'), '유일 참조는 server/index.js에 있어야 한다');
  assert.equal(
    hits[0].text, 'const selfUrl = import.meta.url;',
    '유일 참조는 모듈 스코프 selfUrl 캡처 그 자체여야 한다(다른 위치로 옮기거나 늘리지 마라)',
  );
});
