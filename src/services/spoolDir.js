// 배부 스풀 하위 폴더명 검증 — 순수 헬퍼(부수효과·외부 의존 없음). 규칙의 단일 출처.
// 이 값은 phase 47에서 배부 스풀 루트 아래 하위 폴더명으로 실제 파일 경로에 합성되므로,
// 저장 시점(여기)이 경로 조작을 막는 유일한 방어 지점이다.
// 여기서 디렉토리를 만들거나 존재를 확인하지 않는다(ADR-008 — 스풀 쓰기는 phase 47의 책임).
// 계약은 fileRef.js와 동형: 유효하면 원문 그대로, 아니면 '' (throw 없음).

// 소문자 영숫자로 시작 + 이후 영숫자/-/_ , 총 1~64자.
// 이 한 줄이 절대경로·'..'·'/'·'\'·':'·널바이트·공백·제어문자·유니코드·대문자를 전부 거부한다.
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Windows 예약 장치명 — 그 이름의 디렉토리는 생성 자체가 불가라 phase 47이 무조건 실패한다.
// 화이트리스트가 이미 소문자만 통과시키므로 소문자 비교로 충분하다.
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function sanitizeSpoolDir(value) {
  // 1) 타입 게이트 — 강제변환(String(value)) 금지. 'null'/'undefined'/'123'/'true'는
  //    아래 화이트리스트를 전부 통과하므로, 변환하는 순간 검증기가 무력화된다.
  if (typeof value !== 'string') return '';
  // 2) 화이트리스트.
  if (!SLUG.test(value)) return '';
  // 3) 예약 장치명 거부.
  if (RESERVED.has(value)) return '';
  // 4) 통과 — 원문 그대로 반환한다(정규화·소문자 변환·trim 금지: 입력을 고쳐서 통과시키지 않는다).
  return value;
}
