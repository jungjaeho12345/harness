// 계약 인벤토리 드리프트 게이트의 자동 실행 배선 (phase 67 리뷰 반영 — 2026-08-19).
// 배경: scripts/contract-inventory-check.mjs는 39 라우트 인벤토리(docs/api-contract/endpoints.json)가
//   ① server/**의 실제 라우트 표 ② openapi.yaml의 오퍼레이션과 1:1인지 기계 판정하는데,
//   지금까지 이 스크립트를 **호출하는 주체가 아무 데도 없었다**(npm run test:contract의
//   --require-spec-paths 옵션은 수동 실행 전용). 그래서 라우트가 늘거나 줄어도, 인벤토리의 필수
//   expect 태그가 지워져도 어떤 자동 게이트도 red가 되지 않았다.
// 이 테스트가 그 구멍을 막는다 — npm test에 편입되는 유일한 계약 축이다.
// 비용: 이 스크립트는 파일 읽기만 한다(서버 기동·네트워크·DB 접속 0). 계약 스위트 본체
//   (npm run test:contract, 서버 5회 기동)는 여전히 npm test 밖이다(phase 67 open_questions (c)).
// 판정은 얇게 유지한다: 규칙의 내용은 스크립트가 소유하고, 여기서는 "게이트가 실제로 돌고 exit 0"만 본다
//   (규칙을 여기에 복제하면 두 벌이 갈라진다).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(REPO_ROOT, 'scripts', 'contract-inventory-check.mjs');

test('contract-inventory-check --require-spec-paths가 exit 0이다(라우트 표·인벤토리·openapi 오퍼레이션 무드리프트)', () => {
  const res = spawnSync(process.execPath, [GATE, '--require-spec-paths'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000,
  });

  assert.equal(res.error, undefined, `게이트 실행 자체가 실패했다: ${res.error && res.error.message}`);
  assert.equal(
    res.status, 0,
    '계약 인벤토리 드리프트 게이트가 red다 — docs/api-contract/endpoints.json을 서버 라우트 표·openapi.yaml과'
    + ` 맞춰라(수동 재현: node scripts/contract-inventory-check.mjs --require-spec-paths).\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );
  assert.match(res.stdout, /inventory-ok routes=\d+/, `기대한 성공 요약이 없다.\nstdout:\n${res.stdout}`);
});
