// PK 정규형 비교자 단일 출처 (phase 75-p2 · code-review 후속)
//
// inventory(step1)·export(step3)가 행을 PK 정규형 오름차순으로 정렬할 때 쓰는 유일 비교자다.
// 두 곳이 같은 순서를 내야 export→재매니페스트가 inventory 매니페스트와 aggregateDigest가
// 동일하다(라운드트립 잠금 · decisions (5)(6)). 이전엔 두 파일에 바이트-동일 복제본이 있어
// 조용한 드리프트 위험이 있었으므로 여기로 단일화한다(복제 금지).
//
// 규칙: INTEGER PK는 BigInt 수치 비교(정규형은 십진 정수 문자열), 그 외/파싱 실패는 코드포인트
// 비교(astral 문자까지 결정적). 엔진마다 기본 행 순서가 다르므로 순서 비의존 판정이 필수다.

export function comparePk(pkTypeClass, a, b) {
  if (pkTypeClass === 'integer') {
    // 정규형은 십진 정수 문자열이므로 BigInt로 수치 비교. (정수 아닌 정규형은 문자열 폴백.)
    let ba;
    let bb;
    try { ba = BigInt(a); } catch { ba = null; }
    try { bb = BigInt(b); } catch { bb = null; }
    if (ba !== null && bb !== null) {
      if (ba < bb) return -1;
      if (ba > bb) return 1;
      return 0;
    }
  }
  // 코드포인트 비교(astral 문자까지 결정적).
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i += 1) {
    const da = ca[i].codePointAt(0);
    const db = cb[i].codePointAt(0);
    if (da !== db) return da - db;
  }
  return ca.length - cb.length;
}
