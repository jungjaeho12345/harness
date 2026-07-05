// 로그 서비스 — 무의존 in-memory 링 버퍼 + 로그 포맷터 + EventEmitter 방출.
// (docs/LOGS.md: 로그 파일은 디스크에 저장하지 않는다 — 메모리에만 담는다.)
// (docs/ADR.md: 최소 의존성 철학 — 외부 로깅 라이브러리 없이 Node 내장 EventEmitter만 쓴다.)
// (docs/ADR-005: server 인프로세스 EventEmitter 실시간 패턴 재사용 — server/index.js L279 버스 패턴.)
// 순수/주입형: capacity/clock/emitter를 주입해 in-memory 단위 테스트가 결정적이다.
// 로깅은 애플리케이션 흐름을 멈추면 안 되므로 이상 입력은 coerce/무시로 흡수한다(throw 금지).

import { EventEmitter } from 'node:events';
import { computeLogDigest, parseDateParam } from './logDigest.js';

// 24시간치를 넉넉히 담기 위한 링 버퍼 상한(파일 미저장 — 메모리 보유).
// 예: 초당 ~0.5건이면 하루 ~43,200건 → 50,000으로 24h 윈도우를 여유 있게 커버한다.
const DEFAULT_CAPACITY = 50_000;

// 두 자리 zero-pad — 로컬 Date 컴포넌트 기반이라 실행 머신 타임존과 무관하게 결정적.
function pad2(n) {
  return String(n).padStart(2, '0');
}

// 순수 포맷터: 엔트리 → '[YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지'.
// 로컬 Date 접근자만 사용한다(toISOString()/Intl/tz 라이브러리 금지 — ISO의 T/Z 아님).
export function formatLogLine(entry = {}) {
  const d = new Date(entry.ts ?? Date.now());
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const level = coerceLevel(entry.level);
  const message = coerceMessage(entry.message);
  return `[${date} ${time}] [${level}] ${message}`;
}

// LEVEL은 대문자 문자열로 강제(알 수 없는 값도 대문자화만 — 검증/throw 없음).
function coerceLevel(level) {
  if (level === undefined || level === null) return '';
  return String(level).toUpperCase();
}

// 메시지는 문자열로 강제(개행이 있어도 그대로 둔다 — 라인 자체가 한 엔트리).
function coerceMessage(message) {
  if (message === undefined || message === null) return '';
  return typeof message === 'string' ? message : String(message);
}

export function createLogService({ capacity = DEFAULT_CAPACITY, clock = () => Date.now(), emitter = new EventEmitter() } = {}) {
  emitter.setMaxListeners(0); // 동시 구독자 수 제한 경고 방지(server/index.js L280 패턴).

  const buffer = []; // 시각 오름차순 링 버퍼(오래된 것이 앞). 파일/DB 기록 없음.

  // 현재 시각으로 엔트리를 만들어 버퍼에 push(초과 시 shift=FIFO)하고 'log' 이벤트로 방출한다.
  function log(level, message) {
    const ts = clockMs();
    const lvl = coerceLevel(level);
    const msg = coerceMessage(message);
    const entry = { ts, level: lvl, message: msg, line: formatLogLine({ ts, level: lvl, message: msg }) };
    buffer.push(entry);
    if (buffer.length > capacity) buffer.shift();
    emitter.emit('log', entry);
    return entry;
  }

  // clock이 Date/숫자 무엇을 반환하든 epoch ms로 정규화한다.
  function clockMs() {
    const t = clock();
    return t instanceof Date ? t.getTime() : Number(t);
  }

  // 현재 버퍼의 시각 오름차순 복사본을 반환한다(원본 배열/엔트리 노출·변형 금지).
  function entries({ since } = {}) {
    const src = since === undefined || since === null
      ? buffer
      : buffer.filter((e) => e.ts >= since);
    return src.map((e) => ({ ...e }));
  }

  // 'log' 이벤트 구독 — 구독 해제 함수를 반환한다(SSE 라우트가 신규 라인 수신에 사용).
  function subscribe(onEntry) {
    emitter.on('log', onEntry);
    return function unsubscribe() {
      emitter.off('log', onEntry);
    };
  }

  // 다이제스트 조회(읽기 전용) — 현재 버퍼 스냅샷을 순수 코어(computeLogDigest)로 집계한다(step2).
  //   dateStr 미지정이면 runDate = 현재 시각(clock, = 오늘 06:00 실행 가정). 'YYYY-MM-DD'면 그날 기준.
  //   잘못된 date는 throw하지 않고 { ok:false, reason:'invalid-date' }로 흡수한다(graceful).
  // 버퍼를 변형하지 않는다 — entries()는 복사본이고 computeLogDigest도 입력 불변(append-only 정신).
  function digest(dateStr) {
    let runDate;
    if (dateStr === undefined || dateStr === null || dateStr === '') {
      runDate = new Date(clockMs());
    } else {
      runDate = parseDateParam(dateStr);
      if (!runDate) return { ok: false, reason: 'invalid-date' };
    }
    return { ok: true, digest: computeLogDigest(entries(), runDate) };
  }

  const info = (message) => log('INFO', message);
  const warn = (message) => log('WARN', message);
  const error = (message) => log('ERROR', message);
  const debug = (message) => log('DEBUG', message);

  return { log, info, warn, error, debug, entries, subscribe, digest, emitter };
}
