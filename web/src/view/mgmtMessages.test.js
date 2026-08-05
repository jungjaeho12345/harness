import { describe, it, expect } from 'vitest';
import { COMMON_REASON_MESSAGE, GENERIC_FAILURE_MESSAGE, createReasonMessage } from './mgmtMessages.js';

describe('mgmtMessages (관리화면 공용 실패 사유 문구)', () => {
  it('공통 토큰 4종을 기존 문구 그대로 매핑한다', () => {
    const msg = createReasonMessage();
    expect(msg('unauthenticated')).toBe('로그인이 필요합니다. 다시 로그인해 주세요.');
    expect(msg('internal-error')).toBe('서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
    expect(msg('network-error')).toBe('서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    expect(msg('invalid-response')).toBe('서버 응답을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    // 공통 맵은 정확히 4종이다(화면별 문구는 extra로만 들어온다).
    expect(Object.keys(COMMON_REASON_MESSAGE).sort()).toEqual(
      ['internal-error', 'invalid-response', 'network-error', 'unauthenticated'],
    );
  });

  it('extra가 공통 항목을 덮어쓴다(화면별 우선)', () => {
    const msg = createReasonMessage({ 'network-error': '화면 전용 문구' });
    expect(msg('network-error')).toBe('화면 전용 문구');
    // 공용 맵 자체는 오염되지 않는다.
    expect(COMMON_REASON_MESSAGE['network-error']).toBe('서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  });

  it('extra에만 있는 화면별·도메인 토큰도 매핑한다', () => {
    const msg = createReasonMessage({
      forbidden: '권한이 없습니다. 배부 대상 관리는 관리자(Z) 전용입니다.',
      'invalid-spool-dir': '스풀 폴더명을 확인해 주세요.',
    });
    expect(msg('forbidden')).toBe('권한이 없습니다. 배부 대상 관리는 관리자(Z) 전용입니다.');
    expect(msg('invalid-spool-dir')).toBe('스풀 폴더명을 확인해 주세요.');
  });

  it('미지의 문자열 토큰은 원문을 괄호로 노출한다(운영 단서 유지)', () => {
    const msg = createReasonMessage({ forbidden: 'x' });
    expect(msg('weird-reason')).toBe('요청을 처리하지 못했습니다 (weird-reason).');
    expect(msg('teapot')).toBe('요청을 처리하지 못했습니다 (teapot).');
  });

  it('비문자열·빈 문자열 사유는 토큰 없는 일반 문구로 수렴한다', () => {
    const msg = createReasonMessage({ forbidden: 'x' });
    for (const bad of [null, undefined, '', 0, 42, {}, [], true, NaN]) {
      const out = msg(bad);
      expect(out).toBe(GENERIC_FAILURE_MESSAGE);
      expect(out).not.toContain('null');
      expect(out).not.toContain('undefined');
      expect(out).not.toContain('[object Object]');
      expect(out).not.toContain('NaN');
    }
  });

  it('프로토타입 체인 키는 문구로 새지 않는다', () => {
    const msg = createReasonMessage({ forbidden: 'x' });
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf']) {
      const out = msg(key);
      expect(out).toBe(`요청을 처리하지 못했습니다 (${key}).`);
      expect(out).not.toContain('function');
      expect(out).not.toContain('native code');
    }
  });

  it('extra 객체는 자기 소유 키만 본다(상속 키 무시)', () => {
    const inherited = Object.create({ forbidden: '상속된 문구' });
    const msg = createReasonMessage(inherited);
    expect(msg('forbidden')).toBe('요청을 처리하지 못했습니다 (forbidden).');
  });

  it('extra가 비객체면 공통 매핑만 쓴다', () => {
    for (const bad of [null, undefined, 'x', 3]) {
      const msg = createReasonMessage(bad);
      expect(msg('network-error')).toBe('서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      expect(msg('forbidden')).toBe('요청을 처리하지 못했습니다 (forbidden).');
    }
  });
});
