// 권한 정책 (phase 64 step3 B-1) — client/lib/permissionPolicy.js 순수 모듈을 node:test로 잠근다.
// 배경: main.js의 setPermissionRequestHandler가 인라인 조건식으로 판정하던 것을 순수 모듈로 뽑아
//   request/check 두 핸들러가 같은 술어를 쓰게 한다(main.js 헤더 계약·ADR-011 — 정책은 client/lib
//   단일 출처, Electron 없이 단위 테스트). 허용 집합은 clipboard 2종뿐이며 확대 금지다.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED_PERMISSIONS, isAllowedPermission } from '../client/lib/permissionPolicy.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('permissionPolicy — 허용 집합', () => {
  test('허용 집합은 정확히 clipboard-read·clipboard-sanitized-write 2종이다', () => {
    assert.deepEqual([...ALLOWED_PERMISSIONS].sort(), ['clipboard-read', 'clipboard-sanitized-write']);
  });

  test('허용 집합은 동결되어 있다(런타임 확대 금지)', () => {
    assert.ok(Object.isFrozen(ALLOWED_PERMISSIONS));
  });

  test('허용 2종은 정확 일치로 true', () => {
    assert.equal(isAllowedPermission('clipboard-read'), true);
    assert.equal(isAllowedPermission('clipboard-sanitized-write'), true);
  });
});

// 결선 텍스트 잠금 (phase 64 테스트 게이트 보강) — boot-db-open 전례 동형. 정책 모듈만 잠그면
// main.js가 인라인 조건식으로 되돌아가거나(request/check 표류) check 핸들러를 지워도 green이다.
// Electron 없이 잠글 수 있는 결선 증거는 텍스트 스캔뿐이다(main.js는 단위 테스트 불가 결선 파일).
describe('permissionPolicy — main.js 결선 텍스트 잠금(request/check 대칭)', () => {
  const mainText = fs.readFileSync(path.join(REPO_ROOT, 'client', 'main.js'), 'utf8');
  const lines = mainText.split('\n');
  // handler 등록 줄부터 3줄 창 안에 isAllowedPermission( 호출이 있어야 한다(등록·판정 동거 잠금).
  const wiredWithin = (needle) => {
    const idx = lines.findIndex((l) => l.includes(needle));
    if (idx < 0) return false;
    return lines.slice(idx, idx + 3).some((l) => l.includes('isAllowedPermission('));
  };

  test('permissionPolicy를 import한다(단일 출처 결선)', () => {
    assert.ok(mainText.includes("from './lib/permissionPolicy.js'"), 'main.js는 permissionPolicy 모듈을 import해야 한다');
  });

  test('setPermissionRequestHandler가 isAllowedPermission을 쓴다', () => {
    assert.ok(wiredWithin('setPermissionRequestHandler'), 'request 핸들러 등록 3줄 안에 isAllowedPermission 호출이 있어야 한다');
  });

  test('setPermissionCheckHandler가 등록되어 있고 isAllowedPermission을 쓴다(check 대칭)', () => {
    assert.ok(wiredWithin('setPermissionCheckHandler'), 'check 핸들러 등록 3줄 안에 isAllowedPermission 호출이 있어야 한다');
  });

  test("인라인 권한 조건식(permission === ')으로 되돌아가지 않는다(정책 표류 금지)", () => {
    assert.ok(!mainText.includes("permission === '"),
      "main.js에 인라인 권한 비교가 다시 나타나면 정책 단일 출처가 깨진다 — 이 스캔은 주석·문자열 안의 리터럴도 카운트한다(sea-import-meta-lock과 동일 엄격성): 주석에도 그 표현을 쓰지 마라");
  });
});

describe('permissionPolicy — fail-closed', () => {
  test('그 외 권한은 전부 false', () => {
    for (const p of ['media', 'notifications', 'geolocation', 'fullscreen', 'openExternal', 'clipboard-write', 'pointerLock']) {
      assert.equal(isAllowedPermission(p), false, p);
    }
  });

  test('대소문자 변형은 false(정확 일치만)', () => {
    assert.equal(isAllowedPermission('Clipboard-Read'), false);
    assert.equal(isAllowedPermission('CLIPBOARD-SANITIZED-WRITE'), false);
  });

  test('앞뒤 공백이 붙은 값은 false', () => {
    assert.equal(isAllowedPermission(' clipboard-read'), false);
    assert.equal(isAllowedPermission('clipboard-read '), false);
  });

  test('비문자열(null/undefined/숫자/객체/배열)은 전부 false', () => {
    for (const v of [null, undefined, 0, 1, {}, [], ['clipboard-read'], Symbol.for('clipboard-read')]) {
      assert.equal(isAllowedPermission(v), false, String(v?.toString?.() ?? v));
    }
  });

  test('빈 문자열은 false', () => {
    assert.equal(isAllowedPermission(''), false);
  });
});
