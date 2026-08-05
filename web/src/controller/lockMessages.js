// 편집 잠금 획득 실패 사유(서버 토큰 + httpModel 정규화 토큰) → 사용자 안내 문구 — 컨트롤러 공용.
// 순수 모듈이다(React·DOM·transport 비의존). 뷰의 mgmtMessages와 대칭이지만 계층이 다르다 —
// 컨트롤러는 view를 import하지 않으므로(View ← Controller ← Model) 이 모듈은 controller/ 아래에 둔다.
// 'locked'는 두 컨트롤러의 테스트가 문자열째 잠근 계약이라 절대 바꾸지 않는다.
// network-error/invalid-response는 phase49 step7 이후 httpModel이 값으로 돌려주는 실패다
// (reject하지 않는다 — 서버에 닿지 못했거나 비JSON 응답).

export const LOCK_FAIL_MESSAGES = Object.freeze({
  locked: '편집중입니다.',
  'network-error': '서버에 연결하지 못해 편집 잠금을 얻지 못했습니다. 잠시 후 다시 시도해 주세요.',
  'invalid-response': '서버에 연결하지 못해 편집 잠금을 얻지 못했습니다. 잠시 후 다시 시도해 주세요.',
  unauthenticated: '세션이 만료되었습니다. 다시 로그인한 뒤 편집해 주세요.',
  forbidden: '이 기사를 편집할 권한이 없습니다.',
  'not-found': '기사를 찾을 수 없습니다.',
});

export const LOCK_FAIL_DEFAULT = '편집 잠금을 얻지 못해 편집할 수 없습니다.';

// 사유 미상(null·undefined·예외·비문자열)일 때 '(null)'/'(undefined)' 같은 내부 값이 사용자 문구로 새지 않게 한다.
// 조회는 자기 소유 키만 본다('toString' 같은 사유가 프로토타입 체인을 타지 않게).
export function lockFailMessage(reason) {
  if (typeof reason !== 'string' || reason === '') return LOCK_FAIL_DEFAULT;
  if (Object.hasOwn(LOCK_FAIL_MESSAGES, reason)) return LOCK_FAIL_MESSAGES[reason];
  return `${LOCK_FAIL_DEFAULT} (${reason})`;
}
