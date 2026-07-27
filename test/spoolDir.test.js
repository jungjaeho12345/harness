// 배부 스풀 하위 폴더명 검증기 테스트 — sanitizeSpoolDir는 순수 헬퍼다(fileRef.js와 동형 계약:
// 유효하면 원문 그대로, 아니면 ''). phase 47이 이 값을 스풀 루트에 합성하므로 저장 시점이 유일한 방어 지점이다.
// CRITICAL: 비문자열 입력은 강제변환 없이 거부해야 한다 — String(null)/'undefined'/'123'/'true'는
// 화이트리스트 정규식을 전부 통과하므로, 강제변환하면 검증기가 무력화된다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSpoolDir } from '../src/services/spoolDir.js';

test('sanitizeSpoolDir: 유효한 슬러그는 원문 그대로 반환한다', () => {
  for (const ok of ['kbs', 'yonhap-tv', 'press_01', 'a', '0', 'a'.repeat(64), 'x9-_z']) {
    assert.equal(sanitizeSpoolDir(ok), ok, `허용되어야 함: ${ok}`);
  }
});

test('sanitizeSpoolDir: 빈 값/공백만은 거부한다', () => {
  for (const bad of ['', '   ', '\t']) {
    assert.equal(sanitizeSpoolDir(bad), '', `거부되어야 함: ${JSON.stringify(bad)}`);
  }
});

test('sanitizeSpoolDir: 절대경로(POSIX)를 거부한다', () => {
  for (const bad of ['/etc/passwd', '/kbs', '/']) {
    assert.equal(sanitizeSpoolDir(bad), '', `거부되어야 함: ${bad}`);
  }
});

test('sanitizeSpoolDir: traversal(..)을 거부한다', () => {
  for (const bad of ['..', '../secret', 'a/../../b', '..\\..\\etc']) {
    assert.equal(sanitizeSpoolDir(bad), '', `거부되어야 함: ${bad}`);
  }
});

test('sanitizeSpoolDir: 경로 구분자(슬래시/백슬래시)를 거부한다', () => {
  for (const bad of ['a/b', 'a\\b', 'kbs/', 'kbs\\']) {
    assert.equal(sanitizeSpoolDir(bad), '', `거부되어야 함: ${bad}`);
  }
});

test('sanitizeSpoolDir: 드라이브 문자(콜론)를 거부한다', () => {
  for (const bad of ['C:\\spool', 'c:', 'c:kbs']) {
    assert.equal(sanitizeSpoolDir(bad), '', `거부되어야 함: ${bad}`);
  }
});

test('sanitizeSpoolDir: 널바이트를 거부한다', () => {
  assert.equal(sanitizeSpoolDir('kbs\u0000.txt'), '');
  assert.equal(sanitizeSpoolDir('kbs\u0000'), '');
});

test('sanitizeSpoolDir: 공백·제어문자를 거부한다', () => {
  for (const bad of ['kbs ', ' kbs', 'k bs', 'kbs\n', 'kbs\r', 'kbs\t']) {
    assert.equal(sanitizeSpoolDir(bad), '', `거부되어야 함: ${JSON.stringify(bad)}`);
  }
});

test('sanitizeSpoolDir: 선행 dot/구분기호(dotfile·옵션 오인)를 거부한다', () => {
  for (const bad of ['.hidden', '-kbs', '_kbs', '.', './kbs']) {
    assert.equal(sanitizeSpoolDir(bad), '', `거부되어야 함: ${bad}`);
  }
});

test('sanitizeSpoolDir: 화이트리스트 밖 문자(대문자·유니코드·기호)를 거부한다', () => {
  for (const bad of ['KBS', 'Kbs', '한국방송', 'kbs★', 'kbs.dir', 'kbs;rm', 'kbs$', 'kbs%20a']) {
    assert.equal(sanitizeSpoolDir(bad), '', `거부되어야 함: ${bad}`);
  }
});

test('sanitizeSpoolDir: 길이 초과(65자 이상)를 거부한다', () => {
  assert.equal(sanitizeSpoolDir('a'.repeat(65)), '');
  assert.equal(sanitizeSpoolDir('a'.repeat(200)), '');
});

test('sanitizeSpoolDir: 길이 경계값 1/63/64/65를 정확히 가른다 (off-by-one 잠금)', () => {
  // 화이트리스트는 /^[a-z0-9][a-z0-9_-]{0,63}$/ — 선행 1자 + 최대 63자 = 총 64자가 상한이다.
  // 63자가 빠지면 {0,62}/{0,64} 같은 off-by-one 변경이 테스트를 통과해 버린다.
  assert.equal(sanitizeSpoolDir('a'), 'a', '1자는 허용');
  assert.equal(sanitizeSpoolDir('a'.repeat(63)), 'a'.repeat(63), '63자는 허용');
  assert.equal(sanitizeSpoolDir('a'.repeat(64)), 'a'.repeat(64), '64자는 허용(상한)');
  assert.equal(sanitizeSpoolDir('a'.repeat(65)), '', '65자는 거부(상한+1)');
  // 구분기호가 섞인 경계도 같은 상한을 따른다(문자 종류가 길이 판정을 바꾸지 않는다).
  assert.equal(sanitizeSpoolDir(`a${'-'.repeat(63)}`), `a${'-'.repeat(63)}`, '총 64자');
  assert.equal(sanitizeSpoolDir(`a${'-'.repeat(64)}`), '', '총 65자');
});

test('sanitizeSpoolDir: Windows 예약 장치명을 대소문자 무시로 거부한다', () => {
  for (const bad of ['con', 'nul', 'com1', 'com9', 'lpt1', 'lpt9', 'aux', 'prn']) {
    assert.equal(sanitizeSpoolDir(bad), '', `거부되어야 함: ${bad}`);
  }
  // 대문자 변형은 화이트리스트에서 이미 걸리지만, 규칙 회귀 방지를 위해 함께 잠근다.
  for (const bad of ['NUL', 'CON', 'Com1', 'LPT9', 'AUX', 'PRN']) {
    assert.equal(sanitizeSpoolDir(bad), '', `거부되어야 함: ${bad}`);
  }
  // 예약명을 포함하되 완전 일치가 아닌 이름은 허용된다(과잉 차단 금지).
  assert.equal(sanitizeSpoolDir('console'), 'console');
  assert.equal(sanitizeSpoolDir('com10'), 'com10');
  assert.equal(sanitizeSpoolDir('con1'), 'con1');
});

test('sanitizeSpoolDir: 예약 장치명의 확장자 변형(con.txt·nul.log 등)도 거부한다', () => {
  // Windows는 확장자가 붙어도 장치명으로 해석한다("con.txt" 폴더 생성 불가) — phase 47이 무조건 실패하는 값이다.
  // 현재는 화이트리스트가 '.'을 막아 자연 거부되지만, 훗날 '.'을 허용하는 규칙 완화가 들어오면
  // RESERVED 집합의 완전일치 비교만으로는 뚫린다. 그 회귀를 여기서 잠근다.
  for (const bad of [
    'con.txt', 'nul.log', 'aux.dat', 'prn.ps', 'com1.dat', 'lpt9.txt',
    'CON.TXT', 'NUL.log', 'con.', 'com1.tar.gz',
  ]) {
    assert.equal(sanitizeSpoolDir(bad), '', `거부되어야 함: ${bad}`);
  }
});

test('sanitizeSpoolDir: 비문자열 입력은 강제변환 없이 거부한다(throw 금지)', () => {
  // String(null)==='null', String(undefined)==='undefined', String(123)==='123',
  // String(true)==='true' 는 전부 화이트리스트를 통과한다 — 반드시 typeof 게이트로 선차단해야 한다.
  for (const bad of [null, undefined, 123, 0, true, false, {}, [], ['kbs'], () => 'kbs', Symbol('kbs'), 12n]) {
    assert.equal(sanitizeSpoolDir(bad), '', `거부되어야 함: ${String(typeof bad)}`);
  }
  // 인자 없는 호출도 안전해야 한다.
  assert.equal(sanitizeSpoolDir(), '');
  // String 객체 래퍼도 원시 문자열이 아니므로 거부한다(typeof는 'object').
  assert.equal(sanitizeSpoolDir(Object('kbs')), '');
  // toString으로 우회를 시도하는 객체도 거부한다.
  assert.equal(sanitizeSpoolDir({ toString: () => 'kbs' }), '');
});
