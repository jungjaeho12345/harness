import { describe, it, expect } from 'vitest';
import { LOCK_FAIL_MESSAGES, LOCK_FAIL_DEFAULT, lockFailMessage } from './lockMessages.js';

describe('lockMessages (편집 잠금 실패 사유 문구 — 컨트롤러 공용)', () => {
  it('6개 토큰을 기존 문구 그대로 돌려준다', () => {
    expect(lockFailMessage('locked')).toBe('편집중입니다.');
    expect(lockFailMessage('network-error')).toBe('서버에 연결하지 못해 편집 잠금을 얻지 못했습니다. 잠시 후 다시 시도해 주세요.');
    expect(lockFailMessage('invalid-response')).toBe('서버에 연결하지 못해 편집 잠금을 얻지 못했습니다. 잠시 후 다시 시도해 주세요.');
    expect(lockFailMessage('unauthenticated')).toBe('세션이 만료되었습니다. 다시 로그인한 뒤 편집해 주세요.');
    expect(lockFailMessage('forbidden')).toBe('이 기사를 편집할 권한이 없습니다.');
    expect(lockFailMessage('not-found')).toBe('기사를 찾을 수 없습니다.');
    expect(LOCK_FAIL_DEFAULT).toBe('편집 잠금을 얻지 못해 편집할 수 없습니다.');
    expect(Object.keys(LOCK_FAIL_MESSAGES)).toHaveLength(6);
  });

  it('미지의 문자열 토큰은 기본 문구 + (토큰) 형식이다', () => {
    expect(lockFailMessage('teapot')).toBe('편집 잠금을 얻지 못해 편집할 수 없습니다. (teapot)');
    expect(lockFailMessage('weird-reason')).toBe('편집 잠금을 얻지 못해 편집할 수 없습니다. (weird-reason)');
  });

  it('비문자열·빈 문자열 사유는 기본 문구만 돌려준다', () => {
    for (const bad of [null, undefined, '', 0, 7, {}, [], true, NaN]) {
      const out = lockFailMessage(bad);
      expect(out).toBe(LOCK_FAIL_DEFAULT);
      expect(out).not.toContain('null');
      expect(out).not.toContain('undefined');
      expect(out).not.toContain('[object Object]');
    }
  });

  it('프로토타입 체인 키는 문구로 새지 않는다', () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      const out = lockFailMessage(key);
      expect(out).toBe(`편집 잠금을 얻지 못해 편집할 수 없습니다. (${key})`);
      expect(out).not.toContain('function');
    }
  });
});
