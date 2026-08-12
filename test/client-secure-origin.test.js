// secure-origin 스위치 판정 (phase 63 step0) — Electron·파일시스템 비의존 순수 모듈을 node:test로 잠근다.
// 대상: client/lib/secureOrigin.js(스위치 적용 여부·이름·값·재시작 필요의 단일 출처) +
//       client/lib/clientConfig.js의 readConfigFileSync(ready 전 동기 1회 읽기).
// CRITICAL: 스위치 값은 new URL(입력).origin이 만든 정규화 origin "하나"다 — 목록·와일드카드 금지,
//   콤마/공백/별표 혼입은 fail-closed(unsafe-value). Chromium은 이 값을 origin 문자열로 정확 비교한다.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SECURE_ORIGIN_SWITCH, FEATURE_SWITCH, SECURE_ORIGIN_FEATURE,
  isTrustedLocalOrigin, decideSecureOriginSwitches, mergeFeatureValue, requiresRestartForOrigin,
} from '../client/lib/secureOrigin.js';
import { CONFIG_SCHEMA_VERSION, readConfigFileSync } from '../client/lib/clientConfig.js';

// ---------------------------------------------------------------------------
describe('secureOrigin 상수', () => {
  test('스위치 이름·기능 문자열은 Chromium 계약과 일치한다', () => {
    assert.equal(SECURE_ORIGIN_SWITCH, 'unsafely-treat-insecure-origin-as-secure');
    assert.equal(FEATURE_SWITCH, 'enable-features');
    assert.equal(SECURE_ORIGIN_FEATURE, 'OverrideSecurityRestrictionsOnInsecureOrigin');
  });
});

// ---------------------------------------------------------------------------
describe('decideSecureOriginSwitches — 미적용', () => {
  test('null·비문자열·빈 문자열·공백만 → no-origin', () => {
    for (const input of [null, undefined, 123, {}, [], '', '   ']) {
      assert.deepEqual(decideSecureOriginSwitches(input), { apply: false, reason: 'no-origin' }, JSON.stringify(input));
    }
  });

  test('파싱 불가 문자열 → invalid', () => {
    for (const input of ['invalid', 'http://']) {
      assert.deepEqual(decideSecureOriginSwitches(input), { apply: false, reason: 'invalid' }, input);
    }
  });

  test('https는 이미 secure context — 미적용(already-secure)', () => {
    assert.deepEqual(decideSecureOriginSwitches('https://news.example.com'), { apply: false, reason: 'already-secure' });
  });

  test('loopback 계열은 Chromium이 기본 신뢰 — 미적용(loopback)', () => {
    for (const input of [
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      'http://127.5.5.5:3001',
      'http://[::1]:3001',
      'http://app.localhost:3001',
    ]) {
      assert.deepEqual(decideSecureOriginSwitches(input), { apply: false, reason: 'loopback' }, input);
    }
  });

  test('http(s) 밖 스킴 → unsupported-scheme', () => {
    for (const input of ['file:///C:/x', 'ftp://h:21', 'ws://h:3001', 'app://x']) {
      assert.deepEqual(decideSecureOriginSwitches(input), { apply: false, reason: 'unsupported-scheme' }, input);
    }
  });

  test('fail-closed: 콤마·공백·별표 혼입(손편집 config 방어) → unsafe-value', () => {
    for (const input of [
      'http://a.com,http://b.com', // 콤마 목록 — 복수 출처 금지
      'http://10.0.0.1:3001 http://10.0.0.2:3001', // 공백 구분 목록
      'http://*.example.com', // 와일드카드 서브도메인
      'http://10.0.0.1:3001,*', // 혼합
    ]) {
      assert.deepEqual(decideSecureOriginSwitches(input), { apply: false, reason: 'unsafe-value' }, input);
    }
  });
});

// ---------------------------------------------------------------------------
describe('decideSecureOriginSwitches — 적용', () => {
  const applied = [
    'http://10.10.91.90:3001',
    'http://192.168.0.10', // 기본 포트 생략
    'http://news-server:3001', // 호스트명
    'http://NEWS-Server:3001', // 대문자 → URL 정규화로 소문자
  ];

  for (const input of applied) {
    test(`${input} → 스위치 2개, 값은 new URL(입력).origin과 문자열 동일`, () => {
      const d = decideSecureOriginSwitches(input);
      const expected = new URL(input).origin;
      assert.equal(d.apply, true);
      assert.equal(d.origin, expected);
      assert.equal(d.switches.length, 2);
      assert.deepEqual(d.switches[0], { name: SECURE_ORIGIN_SWITCH, value: expected });
      assert.deepEqual(d.switches[1], { name: FEATURE_SWITCH, value: SECURE_ORIGIN_FEATURE });
      // 반환 origin과 첫 스위치 값은 같은 문자열이어야 한다(둘이 갈라지면 diag와 실적용이 어긋난다).
      assert.equal(d.switches[0].value, d.origin);
    });
  }

  test('대문자 호스트는 소문자 정규화 origin으로 적용된다(비정규화 값은 Chromium 매칭 실패)', () => {
    const d = decideSecureOriginSwitches('http://NEWS-Server:3001');
    assert.equal(d.switches[0].value, 'http://news-server:3001');
  });

  test('127.0.0.1.evil.com 접두 위장 호스트는 loopback이 아니다(점4자리 판정 규율)', () => {
    const d = decideSecureOriginSwitches('http://127.0.0.1.evil.com:3001');
    assert.equal(d.apply, true);
    assert.equal(d.origin, 'http://127.0.0.1.evil.com:3001');
  });

  test('existingFeatures가 있으면 enable-features 값은 병합 결과다(덮어쓰기 금지)', () => {
    const d = decideSecureOriginSwitches('http://10.10.91.90:3001', { existingFeatures: 'FooFeature' });
    assert.equal(d.switches[1].value, 'FooFeature,OverrideSecurityRestrictionsOnInsecureOrigin');
  });
});

// ---------------------------------------------------------------------------
describe('isTrustedLocalOrigin', () => {
  test('loopback 계열 origin은 true', () => {
    for (const input of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001', 'http://app.localhost:3001']) {
      assert.equal(isTrustedLocalOrigin(input), true, input);
    }
  });

  test('LAN·위장 호스트·파싱 불가 입력은 false(fail-closed)', () => {
    for (const input of ['http://10.10.91.90:3001', 'http://127.0.0.1.evil.com:3001', 'not-a-url', null]) {
      assert.equal(isTrustedLocalOrigin(input), false, JSON.stringify(input));
    }
  });
});

// ---------------------------------------------------------------------------
describe('mergeFeatureValue', () => {
  test('빈 기존 값 → 기능 하나만', () => {
    assert.equal(mergeFeatureValue('', SECURE_ORIGIN_FEATURE), SECURE_ORIGIN_FEATURE);
  });

  test('비문자열 기존 값도 기능 하나로 수렴한다', () => {
    assert.equal(mergeFeatureValue(null, SECURE_ORIGIN_FEATURE), SECURE_ORIGIN_FEATURE);
    assert.equal(mergeFeatureValue(undefined, SECURE_ORIGIN_FEATURE), SECURE_ORIGIN_FEATURE);
  });

  test('기존 기능 뒤에 콤마로 병합한다(기존 플래그 보존)', () => {
    assert.equal(
      mergeFeatureValue('FooFeature', SECURE_ORIGIN_FEATURE),
      'FooFeature,OverrideSecurityRestrictionsOnInsecureOrigin',
    );
  });

  test('이미 있으면 중복 추가하지 않는다', () => {
    const existing = 'FooFeature,OverrideSecurityRestrictionsOnInsecureOrigin';
    assert.equal(mergeFeatureValue(existing, SECURE_ORIGIN_FEATURE), existing);
  });

  test('앞뒤 공백·빈 토큰은 정리한다', () => {
    assert.equal(
      mergeFeatureValue(' FooFeature , ,Bar ', SECURE_ORIGIN_FEATURE),
      'FooFeature,Bar,OverrideSecurityRestrictionsOnInsecureOrigin',
    );
  });
});

// ---------------------------------------------------------------------------
describe('requiresRestartForOrigin', () => {
  const LAN_A = 'http://10.10.91.90:3001';
  const LAN_B = 'http://192.168.0.10:3001';
  const LOOP = 'http://127.0.0.1:3001';

  test('미적용(null) → LAN 저장 = true (최초 설정이 가장 흔한 경로)', () => {
    assert.equal(requiresRestartForOrigin(null, LAN_A), true);
  });

  test('LAN A → LAN B = true (부팅 때 적용한 값과 다르다)', () => {
    assert.equal(requiresRestartForOrigin(LAN_A, LAN_B), true);
  });

  test('LAN A → 같은 LAN A = false', () => {
    assert.equal(requiresRestartForOrigin(LAN_A, LAN_A), false);
  });

  test('LAN A → loopback = false (새 출처가 스위치를 요구하지 않는다)', () => {
    assert.equal(requiresRestartForOrigin(LAN_A, LOOP), false);
  });

  test('미적용 → loopback = false', () => {
    assert.equal(requiresRestartForOrigin(null, LOOP), false);
  });

  test('미적용 → https·null = false (스위치 비대상)', () => {
    assert.equal(requiresRestartForOrigin(null, 'https://news.example.com'), false);
    assert.equal(requiresRestartForOrigin(null, null), false);
  });
});

// ---------------------------------------------------------------------------
describe('readConfigFileSync', () => {
  const DEFAULTS = { schemaVersion: CONFIG_SCHEMA_VERSION, serverUrl: null, bounds: null };

  test('정상 파일 → parseConfig와 동일 결과', () => {
    const raw = JSON.stringify({ schemaVersion: 1, serverUrl: 'http://10.10.91.90:3001' });
    const calls = [];
    const readFileSync = (file, enc) => { calls.push([file, enc]); return raw; };
    assert.deepEqual(
      readConfigFileSync('C:/tmp/config.json', { readFileSync }),
      { schemaVersion: CONFIG_SCHEMA_VERSION, serverUrl: 'http://10.10.91.90:3001', bounds: null },
    );
    assert.deepEqual(calls, [['C:/tmp/config.json', 'utf8']]);
  });

  test('파일 없음(readFileSync throw) → 기본값, throw 없음', () => {
    const readFileSync = () => { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; };
    assert.deepEqual(readConfigFileSync('C:/none/config.json', { readFileSync }), DEFAULTS);
  });

  test('깨진 JSON → 기본값', () => {
    assert.deepEqual(readConfigFileSync('x', { readFileSync: () => '{ broken' }), DEFAULTS);
  });

  test('화이트리스트 밖 키·손상 serverUrl은 버린다(parseConfig 공유 증거)', () => {
    const raw = JSON.stringify({ serverUrl: 'javascript:alert(1)', sessionId: 'S', bounds: 'x' });
    assert.deepEqual(readConfigFileSync('x', { readFileSync: () => raw }), DEFAULTS);
  });

  test('어떤 입력에도 throw하지 않는다', () => {
    for (const readFileSync of [
      () => { throw new TypeError('boom'); },
      () => 12345,
      () => null,
      () => '',
    ]) {
      assert.doesNotThrow(() => readConfigFileSync('x', { readFileSync }));
    }
  });
});
