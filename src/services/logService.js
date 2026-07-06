// 로그 서비스 — 자체 경량 로거(zero-dep, LOGS.md).
// log4j '스타일'(레벨 서열 + [YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지 포맷)의 무의존 구현이다.
// 보존은 in-memory 링 버퍼만 사용한다(파일/DB 저장 금지 — LOGS.md "파일 미저장" + DB 비파괴 규칙).
// 시계는 주입(now)으로 결정성을 확보한다(sessionService 선례 — Date.now() 직접 호출 금지).
// 타임존은 주입 가능한 고정 오프셋(기본 KST=540분)으로, ts에 오프셋을 더한 뒤 UTC getter로만 계산한다.

export const LOG_LEVELS = Object.freeze(['DEBUG', 'INFO', 'WARN', 'ERROR']); // log4j 스타일 서열(낮음→높음)

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SIX_AM_MS = 6 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ts(epoch ms)를 tzOffsetMinutes 벽시계 기준 'YYYY-MM-DD HH:MM:SS'로 포맷한다.
// 프로세스 TZ에 의존하지 않도록 오프셋을 더한 뒤 UTC getter로만 자릿수를 뽑는다.
export function formatTimestamp(ts, tzOffsetMinutes) {
  const d = new Date(ts + tzOffsetMinutes * MS_PER_MINUTE);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
    + ` ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

// now: 시계 주입(epoch ms). cap: 링 버퍼 상한(줄 수) — 24시간에 cap을 넘기면 오래된 항목이
// evict되어 digest()가 그만큼 놓칠 수 있다(문서화된 트레이드오프). tzOffsetMinutes: 표시/다이제스트 경계 타임존.
export function createLogService({ now = () => Date.now(), cap = 10000, tzOffsetMinutes = 540 } = {}) {
  const buffer = []; // 오래된→최신. 길이는 절대 cap을 초과하지 않는다(FIFO evict).
  const listeners = new Set();
  let seq = 0; // 프로세스 수명 동안 단조 증가 — evict돼도 재사용하지 않는다(SSE replay 중복 필터용).

  function log(level, message) {
    const upper = String(level).toUpperCase();
    const lv = LOG_LEVELS.includes(upper) ? upper : 'INFO';
    const msg = String(message);
    const ts = now();
    seq += 1;
    const record = {
      seq,
      ts,
      level: lv,
      message: msg,
      line: `[${formatTimestamp(ts, tzOffsetMinutes)}] [${lv}] ${msg}`,
    };
    buffer.push(record);
    if (buffer.length > cap) buffer.shift();
    for (const listener of listeners) listener(record);
    return record;
  }

  const debug = (message) => log('DEBUG', message);
  const info = (message) => log('INFO', message);
  const warn = (message) => log('WARN', message);
  const error = (message) => log('ERROR', message);

  // 현재 버퍼 복사본(오래된→최신). SSE 접속 replay용.
  function snapshot() {
    return buffer.slice();
  }

  // 새 record마다 listener(record)를 호출한다. 반환값은 해제 함수.
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // atMs 이하이면서 로컬(tzOffset) 시각이 06:00:00.000인 가장 최근 경계를 잡고,
  // [경계-24h, 경계) 반열림 구간의 record를 반환한다 — "전날 06:00 ~ 당일 05:59:59.999"(LOGS.md).
  function digest(atMs = now()) {
    const shifted = atMs + tzOffsetMinutes * MS_PER_MINUTE;
    const sinceSixAm = (((shifted - SIX_AM_MS) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
    const boundary = atMs - sinceSixAm;
    const start = boundary - MS_PER_DAY;
    return buffer.filter((r) => r.ts >= start && r.ts < boundary);
  }

  function size() {
    return buffer.length;
  }

  function subscriberCount() {
    return listeners.size;
  }

  return { log, debug, info, warn, error, snapshot, subscribe, digest, size, subscriberCount };
}
