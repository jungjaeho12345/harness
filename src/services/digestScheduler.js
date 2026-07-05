// 다이제스트 스케줄러 — 매일 06:00에 전날 하루치 로그 다이제스트를 집계해 전송한다 (26-realtime-log-viewer step3).
// (docs/LOGS.md: "매일 오전 6시에 전날 하루치 로그를 모아 harness-orchestrator에게 전달한다.")
//
// in-process 타이머(주입형·기본 off): 로그 버퍼가 in-memory(파일 미저장)라 다이제스트도 같은 프로세스
// 메모리에서만 계산 가능하다 → push는 in-process가 필연이다. 외부 cron은 프로세스 밖이라 버퍼에 접근할 수
// 없고, 대신 pull(GET /api/logs/digest, step2)로 커버된다. (index.json scheduler_location 근거.)
//
// 집계 로직은 재구현하지 않고 step2 순수 코어(computeLogDigest)에 위임한다(단일 소스).
// clock/setTimer/clearTimer/sendDigest를 전부 주입 가능하게 해 실제 타이머 없이 결정적으로 테스트한다.
// 생성만으로는 아무 것도 하지 않는다(기본 off) — 부트스트랩이 명시 start()할 때만 예약한다.

import { computeLogDigest } from './logDigest.js';

// 순수·결정적: now(로컬 Date) → 다음 hour시(로컬)까지 남은 ms.
//   now가 오늘 hour시 이전이면 오늘 hour시까지, hour시 이후(같은 시각 포함)면 내일 hour시까지.
//   로컬 Date 컴포넌트 기반(step0 formatLogLine/step2 digestWindow와 동일 근거 — tz 무관 결정적).
export function msUntilNextRun(now, hour = 6) {
  const d = now instanceof Date ? now : new Date(now);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
  if (target.getTime() <= d.getTime()) {
    // 이미 오늘 hour시가 지났으면(경계 시각 포함) 다음 날로 넘긴다. Date가 월/년 롤오버를 처리한다.
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - d.getTime();
}

export function createDigestScheduler({
  logService,
  sendDigest = () => {}, // 주입형 전송 함수(Slack 어댑터). 기본 no-op.
  clock = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  hour = 6,
} = {}) {
  let timer; // 현재 예약 핸들(미예약이면 undefined).

  // 다음 hour시까지 예약한다. 발화 후에도 이 함수로 재예약해 매일 반복한다.
  function schedule() {
    const delay = msUntilNextRun(now(), hour);
    timer = setTimer(fire, delay);
  }

  // 발화: 현재 시각 기준으로 step2 코어 집계 → 전송(예외 격리) → 다음 06:00 재예약.
  function fire() {
    try {
      const runDate = now();
      const entries = logService ? logService.entries() : [];
      const digest = computeLogDigest(entries, runDate);
      sendDigest(digest); // 전송 실패가 스케줄러를 죽이면 안 되므로 try 내에서 호출.
    } catch {
      // 집계/전송 실패는 삼킨다 — Slack 장애가 스케줄러/서버를 죽이면 안 된다(격리).
    }
    schedule(); // 예외 여부와 무관하게 항상 다음 06:00 재예약(매일 반복 보장).
  }

  // clock이 Date/숫자 무엇을 반환하든 Date로 정규화한다.
  function now() {
    const t = clock();
    return t instanceof Date ? t : new Date(t);
  }

  function start() {
    schedule();
  }

  function stop() {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  }

  return { start, stop };
}
