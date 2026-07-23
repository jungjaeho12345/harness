// 공용약어(언론 관용 약어) 번들 정적 목록 + 사용자 약어와의 순수 병합 헬퍼.
// DOM/window/React/localStorage/transport 비의존 — simpTradTable.js와 동일한 오프라인 번들 데이터 성격.
// 도구>약어변환(수동)이 사용자 약어와 이 목록을 병합해 expandAbbrev로 확장한다. 같은 short는 사용자 우선.
// 환경설정 edit.noCommonAbbr=true면 공용약어를 제외한다. 약어관리 다이얼로그는 사용자 약어 전용(이 목록 미노출).
// 자동 키인터셉트는 없다 — 변환은 명시 액션(도구>약어변환)에서만.
//
// 형식: { short, long }[] — short(축약형)를 long(확장형)으로 확장한다. short와 long이 실제로 다른 항목만 둔다.
// abbrevConvert.expandAbbrev의 단어경계·최장일치·재확장 금지 의미론을 그대로 탄다(별도 처리 없음).

export const COMMON_ABBREVS = Object.freeze([
  // 정부 부처(축약형)
  { short: '기재부', long: '기획재정부' },
  { short: '국토부', long: '국토교통부' },
  { short: '산업부', long: '산업통상자원부' },
  { short: '복지부', long: '보건복지부' },
  { short: '노동부', long: '고용노동부' },
  { short: '여가부', long: '여성가족부' },
  { short: '해수부', long: '해양수산부' },
  { short: '중기부', long: '중소벤처기업부' },
  { short: '행안부', long: '행정안전부' },
  { short: '문체부', long: '문화체육관광부' },
  { short: '과기정통부', long: '과학기술정보통신부' },
  { short: '농식품부', long: '농림축산식품부' },
  // 위원회·사법
  { short: '금융위', long: '금융위원회' },
  { short: '금감원', long: '금융감독원' },
  { short: '공정위', long: '공정거래위원회' },
  { short: '방통위', long: '방송통신위원회' },
  { short: '권익위', long: '국민권익위원회' },
  { short: '인권위', long: '국가인권위원회' },
  { short: '선관위', long: '중앙선거관리위원회' },
  { short: '헌재', long: '헌법재판소' },
  { short: '대법', long: '대법원' },
  // 공기업·기관
  { short: '한전', long: '한국전력공사' },
  { short: '코레일', long: '한국철도공사' },
  { short: '마사회', long: '한국마사회' },
  { short: '수공', long: '한국수자원공사' },
  { short: '도공', long: '한국도로공사' },
  // 경제단체·노동
  { short: '전경련', long: '전국경제인연합회' },
  { short: '경총', long: '한국경영자총협회' },
  { short: '대한상의', long: '대한상공회의소' },
  { short: '무역협회', long: '한국무역협회' },
  { short: '한국노총', long: '한국노동조합총연맹' },
  { short: '민주노총', long: '전국민주노동조합총연맹' },
  // 국제기구
  { short: 'IMF', long: '국제통화기금' },
  { short: 'WHO', long: '세계보건기구' },
  { short: 'WTO', long: '세계무역기구' },
  { short: 'UN', long: '국제연합' },
  { short: 'EU', long: '유럽연합' },
  { short: 'OECD', long: '경제협력개발기구' },
  { short: 'ILO', long: '국제노동기구' },
  { short: 'IAEA', long: '국제원자력기구' },
  { short: 'NATO', long: '북대서양조약기구' },
  { short: 'ASEAN', long: '동남아시아국가연합' },
  { short: 'UNESCO', long: '유엔교육과학문화기구' },
  { short: 'OPEC', long: '석유수출국기구' },
]);

// 한 원소를 { short, long } 문자열 쌍으로 정규화(방어).
function normalizePair(p) {
  return { short: String(p?.short ?? ''), long: String(p?.long ?? '') };
}

// 사용자 약어 + 공용약어 병합(순수). 같은 short는 사용자 우선(공용에서 제외).
//  - includeCommon=false → 사용자 약어만(정규화).
//  - includeCommon=true  → [사용자 약어] + [공용약어 중 사용자 short에 없는 것].
// 입력 mutate 금지. userAbbrevs가 배열이 아니면 빈 사용자 목록으로 취급(방어).
export function mergeAbbrevs(userAbbrevs, { includeCommon = true } = {}) {
  const user = Array.isArray(userAbbrevs) ? userAbbrevs.map(normalizePair) : [];
  if (!includeCommon) return user;
  const userShorts = new Set(user.map((p) => p.short));
  const common = COMMON_ABBREVS
    .map(normalizePair)
    .filter((p) => !userShorts.has(p.short)); // 같은 short는 사용자 우선(공용 제외).
  return [...user, ...common];
}
