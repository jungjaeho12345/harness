// 순수 다이제스트 집계 코어 (26-realtime-log-viewer step2).
// (docs/LOGS.md: "매일 오전 6시에 전날 하루부터 오전 5시 59분까지 발생한 로그를 모아 전달한다.")
//   → 집계 윈도우 = 전날 06:00:00.000 ~ 당일(runDate) 05:59:59.999.
// (docs/ADR.md: 순수·결정적·외부 의존 0 철학.) 시각은 인자(runDate)로만 받는다 — Date.now()/전역 상태 접근 없음.
// 로컬 Date 컴포넌트 기반으로 윈도우를 계산한다(step0 formatLogLine과 동일 근거 — tz 무관 결정적).
// 06:00 트리거·Slack 전송은 이 코어와 무관(step3) — 트리거 방식과 독립적으로 단위 테스트 가능하게 분리한다.

// 다이제스트 lines 상한. 윈도우(최대 24h)가 매우 크면 페이로드가 비대해지므로 최근 N개로 제한한다.
// total/byLevel은 상한과 무관하게 전수 집계하고, lines만 상한을 둔다(다이제스트 표시/전송용 최근 라인).
const MAX_DIGEST_LINES = 10_000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

// runDate의 로컬 날짜를 'YYYY-MM-DD'로 — 다이제스트 대상 표기(= 윈도우 종료일 = runDate 로컬 날짜).
function formatDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 윈도우 경계 순수 함수: runDate(집계 실행일) → { start, end }(epoch ms).
//   start = 전날 06:00:00.000(runDate 로컬 날짜에서 하루 빼고 06:00; day-1은 Date 생성자가 월/년 경계 롤오버).
//   end   = 당일 05:59:59.999(runDate 로컬 날짜의 05:59:59 끝).
export function digestWindow(runDate) {
  const d = runDate instanceof Date ? runDate : new Date(runDate);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const start = new Date(y, m, day - 1, 6, 0, 0, 0).getTime();
  const end = new Date(y, m, day, 5, 59, 59, 999).getTime();
  return { start, end };
}

// 집계 순수 함수: entries(step0 entries() shape) + runDate → 다이제스트 객체.
//   윈도우 [start, end] 양끝 포함(start <= ts <= end)으로 필터·집계한다. 결정적: 같은 입력이면 항상 같은 결과.
//   입력 배열/엔트리는 절대 변형하지 않는다(filter/sort는 새 배열 위에서만 — append-only 불변).
export function computeLogDigest(entries, runDate) {
  const d = runDate instanceof Date ? runDate : new Date(runDate);
  const { start, end } = digestWindow(d);

  const inWindow = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.ts === 'number' && e.ts >= start && e.ts <= end)
    .sort((a, b) => a.ts - b.ts); // filter가 만든 새 배열 위에서 정렬 — 원본 불변.

  const byLevel = {};
  for (const e of inWindow) {
    const level = e.level || '';
    byLevel[level] = (byLevel[level] ?? 0) + 1;
  }

  const capped = inWindow.length > MAX_DIGEST_LINES
    ? inWindow.slice(-MAX_DIGEST_LINES)
    : inWindow;

  return {
    date: formatDate(d),          // 대상 표기 = runDate 로컬 날짜(= 윈도우 종료일).
    window: { start, end },
    total: inWindow.length,       // 윈도우 내 전체 엔트리 수(상한 무관).
    byLevel,                      // 레벨별 카운트.
    lines: capped.map((e) => e.line ?? ''), // 시각순 포맷 라인(상한 적용).
  };
}

// 'YYYY-MM-DD'(zero-pad 필수) → 로컬 Date(정오 고정 — 경계 계산엔 날짜 성분만 쓰이므로 DST 안전).
// 형식/범위 불일치(존재하지 않는 날 포함)면 null을 반환한다(throw 금지 — 호출부가 graceful 처리).
export function parseDateParam(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(y, mo - 1, day, 12, 0, 0, 0);
  // 롤오버 검출: 예) 2026-02-30 → 3월로 넘어가면 성분이 어긋난다 → 무효.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== day) return null;
  return date;
}
