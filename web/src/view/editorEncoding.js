// 에디터 입력모드(KSC-5601/Unicode) EUC-KR 바이트 모델 — 상태표시줄 Byte 표시용
// 순수 계산(zero-dep·DOM 비의존·입력 비파괴). TextEncoder는 EUC-KR을 지원하지 않으므로
// KS X 1001 전수 테이블(완성형 한글 2350자·한자 4888자)이 아니라 아래 코드포인트
// **블록 범위 기반 실용 근사**로 판정한다. 완성형 전 범위(0xAC00–0xD7A3)를 2B로 보는
// 것은 실제 수록분보다 넓은 과대근사이며 의도된 것이다. 환경설정 '언어'(라벨/lang
// 속성 전용)와는 완전 독립 — 언어 설정에 따라 판정 범위를 바꾸지 않는다.
//
// 분류 규칙(경계 포함):
//  - ASCII(cp <= 0x7F, 제어·개행·공백 포함) → 1바이트
//  - 아래 범위 → 2바이트
//    0x0370–0x03FF 그리스 / 0x0400–0x04FF 키릴 / 0x1100–0x11FF 한글 자모
//    0x3000–0x303F CJK 기호·구두점(전각 기호) / 0x3040–0x30FF 히라가나·가타카나
//    0x3130–0x318F 한글 호환 자모 / 0x4E00–0x9FFF CJK 통합 한자
//    0xAC00–0xD7A3 한글 음절(완성형) / 0xF900–0xFAFF CJK 호환 한자
//    0xFF00–0xFFEF 반각·전각 형태
//  - 그 외(이모지·비BMP·라틴 확장·아랍·태국 등) → 비호환: 바이트 0 기여 + incompatible 카운트
//    (바이트 총합 = 실제로 인코딩되는 페이로드 크기, 카운트 = 손실될 문자 신호 — 역할 분리)

const EUCKR_2B_RANGES = [
  [0x0370, 0x03ff],
  [0x0400, 0x04ff],
  [0x1100, 0x11ff],
  [0x3000, 0x303f],
  [0x3040, 0x30ff],
  [0x3130, 0x318f],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
];

// 입력모드 정규화 — 미지원/구값/undefined는 'unicode'로 폴백. 허용값은 'ksc5601' | 'unicode'.
export function normalizeInputMode(mode) {
  return mode === 'ksc5601' ? 'ksc5601' : 'unicode';
}

// EUC-KR(KS X 1001) 기준 바이트 수 근사 + 인코딩 비호환 문자 개수를 한 번의 순회로 계산.
// 코드포인트 단위 순회(for...of) — surrogate pair(이모지·비BMP)를 한 문자로 다룬다.
export function euckrStats(text) {
  let bytes = 0;
  let incompatible = 0;
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7f) {
      bytes += 1;
    } else if (EUCKR_2B_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) {
      bytes += 2;
    } else {
      incompatible += 1;
    }
  }
  return { bytes, incompatible };
}
