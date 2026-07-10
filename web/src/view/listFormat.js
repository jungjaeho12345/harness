// 기사 목록 표시 포맷 (news.md 기사 조회페이지).
// 작성시간/수정시간/송고시간 컬럼은 'YYYY-MM-DD HH:mm' 형식으로 표시한다.
// 시간은 ISO-8601 UTC 문자열로 저장되므로 문자열에서 직접 잘라 표시한다(타임존 이동·런타임 의존 없음).

// 9종 날짜형식 (news.md "# 에디터 환경설정 > 날짜형식: 9개의 날짜 포멧팅"). id=format 패턴, 토큰 YYYY/MM/DD/HH/mm.
export const DATE_FORMATS = Object.freeze([
  'YYYY-MM-DD HH:mm',
  'YYYY-MM-DD',
  'YYYY.MM.DD HH:mm',
  'YYYY.MM.DD',
  'YYYY/MM/DD HH:mm',
  'YYYY년 MM월 DD일 HH:mm',
  'YYYY년 MM월 DD일',
  'MM-DD HH:mm',
  'MM/DD/YYYY',
]);
export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD HH:mm';

// 현재 적용 날짜형식 (module-level 가변, 기본 DEFAULT_DATE_FORMAT). setDateFormat으로만 바뀐다.
// editorColoring.setEditorColors와 동일 구조 — 영속은 editorPrefs, 적용 결선은 Step 1.
let currentFormat = DEFAULT_DATE_FORMAT;

// 순수: ISO 문자열에서 YYYY/MM/DD/HH/mm를 정규식으로 추출해 format 토큰을 치환한다(Date 비사용 — 타임존 이동 방지).
// 토큰은 YYYY→MM→DD→HH→mm 순서로 각 1회씩 대소문자 구분 치환(MM=월, mm=분). iso 없음→''/미매치→원본(폴백).
export function applyDateFormat(iso, format) {
  if (!iso) return '';
  const s = String(iso);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return s;
  return String(format)
    .replace('YYYY', m[1])
    .replace('MM', m[2])
    .replace('DD', m[3])
    .replace('HH', m[4])
    .replace('mm', m[5]);
}

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // 한국 표준시 UTC+9 (DST 없음 — 고정 오프셋)

// 순수·결정적: epoch ms를 KST 벽시계 ISO 유사 문자열로 변환. +9h한 시각을 toISOString(UTC 표기)으로
// 읽으면 자릿수(YYYY-MM-DDTHH:mm)가 곧 KST 벽시계다 — applyDateFormat의 정규식과 호환.
// 내부에서 시각을 읽지 않는다(new Date()/Date.now() 금지) — 비결정성은 호출자(WriterPage) 몫.
export function kstIsoString(epochMs) {
  return new Date(epochMs + KST_OFFSET_MS).toISOString();
}

// module-level 현재 형식 설정(화이트리스트 — DATE_FORMATS에 없으면 무시/기본 유지).
export function setDateFormat(format) {
  if (DATE_FORMATS.includes(format)) currentFormat = format;
}

export function formatDateTime(iso) {
  return applyDateFormat(iso, currentFormat);
}

// 컬럼 키에 따라 셀 값을 표시 문자열로 변환한다(시간 컬럼만 포맷).
export function formatCell(key, value) {
  if (key === 'createdAt' || key === 'editedAt' || key === 'sentAt') return formatDateTime(value);
  return value === undefined || value === null ? '' : String(value);
}
