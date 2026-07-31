// 엠바고 datetime-local 표시 변환 — 순수 함수, DOM/React/transport 비의존.
// 계약: 필드 상태(f.embargoAt/f.secondEmbargoAt)는 항상 ISO-8601 UTC 문자열이다
// (SCHEMA.md:48 "시간 컬럼은 ISO-8601 UTC 문자열" — 서버 embargoPolicy(phase 48 tick)의 시각 비교·EPS/DES
// 치환이 이 포맷에 의존한다). 로컬 시각 변환은 여기(표시 계층)에서만 한다 — 상태·저장 dto에는 로컬 포맷을 싣지 않는다.
//
// isoToLocalInput: ISO UTC → 로컬 "YYYY-MM-DDTHH:mm"(datetime-local value). 빈 값·파싱 불가(레거시 자유
//   텍스트 잔재) → '' — 피커는 빈 표시가 되지만 원값(f.embargoAt)은 사용자가 피커로 값을 고르기 전까지 보존된다
//   (onChange가 발화할 때만 덮어쓰는 호출측 계약).
// localInputToIso: datetime-local 값(로컬) → ISO UTC 문자열. 빈 값 → ''(엠바고 해제). 브라우저는 유효값/''만
//   내보내지만, 포맷 불일치·달력에 없는 날짜(롤오버)는 방어적으로 ''를 돌려준다.

const pad2 = (n) => String(n).padStart(2, '0');

// datetime-local이 내보내는 로컬 포맷: YYYY-MM-DDTHH:mm(초는 step 설정 시에만 붙는다 — 선택 수용).
const LOCAL_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * ISO-8601 UTC 문자열 → 로컬 "YYYY-MM-DDTHH:mm" (datetime-local value).
 * 빈 값/파싱 불가 → '' (피커 빈 표시). 초 이하는 분으로 절삭한다.
 */
export function isoToLocalInput(iso) {
  if (iso === null || iso === undefined) return '';
  const s = String(iso).trim();
  if (s === '') return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * datetime-local 값(로컬 "YYYY-MM-DDTHH:mm[:ss]") → ISO-8601 UTC 문자열.
 * 빈 값 → '' (엠바고 해제). 포맷 불일치/달력에 없는 날짜(예: 2월 31일 롤오버) → ''.
 * 문자열 파싱(new Date(string))의 타임존 해석 편차를 피하려고 성분 분해 후 로컬 생성자로 조립한다.
 */
export function localInputToIso(localValue) {
  if (localValue === null || localValue === undefined) return '';
  const s = String(localValue).trim();
  if (s === '') return '';
  const m = LOCAL_INPUT_RE.exec(s);
  if (!m) return '';
  const [, y, mo, day, h, min, sec] = m;
  const d = new Date(
    Number(y), Number(mo) - 1, Number(day),
    Number(h), Number(min), Number(sec ?? 0),
  );
  // 롤오버 거부 — 생성 결과가 입력 성분과 다르면(2월 31일→3월 3일 등) 달력에 없는 날짜다.
  if (
    Number.isNaN(d.getTime())
    || d.getFullYear() !== Number(y)
    || d.getMonth() !== Number(mo) - 1
    || d.getDate() !== Number(day)
    || d.getHours() !== Number(h)
    || d.getMinutes() !== Number(min)
  ) return '';
  return d.toISOString();
}
