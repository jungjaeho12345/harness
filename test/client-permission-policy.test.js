// 권한 정책 (phase 64 step3 B-1) — client/lib/permissionPolicy.js 순수 모듈을 node:test로 잠근다.
// 배경: main.js의 setPermissionRequestHandler가 인라인 조건식으로 판정하던 것을 순수 모듈로 뽑아
//   request/check 두 핸들러가 같은 술어를 쓰게 한다(main.js 헤더 계약·ADR-011 — 정책은 client/lib
//   단일 출처, Electron 없이 단위 테스트). 허용 집합은 clipboard 2종뿐이며 확대 금지다.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWED_PERMISSIONS, isAllowedPermission } from '../client/lib/permissionPolicy.js';

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
