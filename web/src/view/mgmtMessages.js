// 관리 3화면(배부 대상·수신 설정·사용자)의 서버 거부 사유 → 사용자 문구 공용 매핑.
// 순수 모듈이다 — React·DOM·transport에 의존하지 않는다(View 계층 안의 문구 승격).
// 검증·인가의 진실은 서버이며 화면은 안내만 한다(ADR-004). 화면별 문구는 extra로만 덮어쓴다.

// 전역 에러 핸들러·httpModel 정규화 토큰 — 세 화면이 공유하는 공통 4종.
export const COMMON_REASON_MESSAGE = Object.freeze({
  unauthenticated: '로그인이 필요합니다. 다시 로그인해 주세요.',
  'internal-error': '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
  'network-error': '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  'invalid-response': '서버 응답을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
});

// 사유가 없거나 문자열이 아닌 경우의 문구 — `(null)`·`(undefined)`가 화면에 새지 않게 한다.
export const GENERIC_FAILURE_MESSAGE = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';

// extra: 화면별 문구(같은 키면 공통보다 우선). 반환값은 (reason) => string.
// 판정 순서: 비문자열/빈 문자열 → 일반 문구 · extra → 공통 → 미지 토큰 노출.
// 미지의 '문자열' 토큰은 그대로 노출한다 — 운영자가 새 서버 사유를 발견하는 단서다.
export function createReasonMessage(extra = {}) {
  const own = extra && typeof extra === 'object' ? extra : {};
  return function reasonMessage(reason) {
    if (typeof reason !== 'string' || reason === '') return GENERIC_FAILURE_MESSAGE;
    // 자기 소유 키만 본다 — 'toString' 같은 사유가 프로토타입 체인을 타지 않게.
    if (Object.hasOwn(own, reason)) return own[reason];
    if (Object.hasOwn(COMMON_REASON_MESSAGE, reason)) return COMMON_REASON_MESSAGE[reason];
    return `요청을 처리하지 못했습니다 (${reason}).`;
  };
}
