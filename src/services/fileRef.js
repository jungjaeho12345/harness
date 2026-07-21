// 파일/이미지 참조 스킴 방어 — 순수 헬퍼(외부 의존·부수효과 없음). 규칙의 단일 출처:
// 첨부/자료 파일(articleService)과 사진DB src(photoService)가 같은 규칙을 공유한다.
// /uploads 상대경로 또는 https:// 만 허용(저장 시점 심화 방어, ADR-004).
// 위험 스킴(javascript:/data:/http:/프로토콜상대//·제어문자·백슬래시 우회)은 빈 문자열로 무력화.
// clipboardEmbed.isAllowedHref(web)와 동일한 거부 기반 정규화 — 단, 상대경로는 /uploads 접두만 허용(서버 심화방어).
// (web 번들은 서버가 import할 수 없어 규칙을 순수 헬퍼로 재현한다.)
export function sanitizeFileRef(value) {
  const s = String(value);
  if (s === '') return ''; // 빈값 = 정상 클리어(× 버튼) — 통과
  // 제어문자·공백(U+0000~U+0020) 포함 시 거부 — 브라우저가 제거·정규화해 스킴이 되살아나는 은닉 차단.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20]/.test(s)) return '';
  if (s.includes('\\')) return ''; // 백슬래시(브라우저가 '/'로 정규화) 거부
  if (s.startsWith('//')) return ''; // 프로토콜상대(//host) 거부
  if (/^https:\/\//i.test(s)) return s; // https://(authority 포함)만 허용
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return ''; // 그 외 스킴(javascript:/data:/http: 등) 전부 거부
  if (!s.startsWith('/uploads/')) return ''; // 상대경로는 업로드 위치(/uploads/)만 신뢰
  if (/(^|\/)\.\.(\/|$)/.test(s)) return ''; // '..' 세그먼트 — 접두 검사를 우회하는 traversal 거부
  return s;
}
