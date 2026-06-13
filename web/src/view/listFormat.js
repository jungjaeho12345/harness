// 기사 목록 표시 포맷 (news.md 기사 조회페이지).
// 작성시간/수정시간 컬럼은 'YYYY-MM-DD HH:mm' 형식으로 표시한다.
// 시간은 ISO-8601 UTC 문자열로 저장되므로 문자열에서 직접 잘라 표시한다(타임존 이동·런타임 의존 없음).

export function formatDateTime(iso) {
  if (!iso) return '';
  const s = String(iso);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

// 컬럼 키에 따라 셀 값을 표시 문자열로 변환한다(시간 컬럼만 포맷).
export function formatCell(key, value) {
  if (key === 'createdAt' || key === 'editedAt') return formatDateTime(value);
  return value === undefined || value === null ? '' : String(value);
}
