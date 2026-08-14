// 부트 연결 PRAGMA (phase 64 step5 C-2) — 서비스·로거·express를 import하지 않는 DB 계층 무의존 모듈.
// 다루는 것은 busy_timeout 하나뿐이다. journal_mode(WAL)·synchronous·foreign_keys 등 다른 PRAGMA는
// 절대 추가하지 마라 — 파일 레이아웃(-wal/-shm)·백업 절차(data/ 폴더 복사)·내구성 정책이 바뀐다.
//
// 값의 근거: node:sqlite 기본 busy_timeout은 0(실측 — 잠금 경합 시 대기 없이 즉시 SQLITE_BUSY)이고,
// 기본 5000ms는 널리 쓰이는 동기 SQLite 바인딩(better-sqlite3)의 기본값과 같다. 같은 data/ 폴더로
// 두 인스턴스가 동시에 부팅하는 흔한 사고(포트 충돌 판정은 그보다 뒤다)에서 createSchema·백필 쓰기가
// 즉시 죽는 것을 완화한다. 트레이드오프: 외부 프로세스가 락을 오래 쥐면 단일 스레드 서버가 최대
// 이 시간만큼 정지할 수 있다(현행 0은 즉시 500 응답) — 저장 실패보다 짧은 지연이 사용자에게 낫다.
// 적용 대상은 프로덕션 부트 연결 1개뿐이다 — 테스트 헬퍼·모델·서비스에 전역 기본으로 끼우지 마라
// (74개 스위트가 자기 in-memory DB로 도는 현행 구조가 "영향 범위 = 부트 연결 1개" 근거다).

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

// 연결 단위 PRAGMA 적용 + read-back 검증. 반환: { busyTimeoutMs } (DB가 실제로 보고한 값).
// busyTimeoutMs가 0 이상 정수가 아니면 TypeError(조용한 no-op 금지 — backfillHistoryTitles 주입
// 가드와 같은 규율). 0은 "즉시 실패"라는 명시적 선택이므로 허용한다.
export function applyConnectionPragmas(db, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError(`applyConnectionPragmas: busyTimeoutMs는 0 이상 정수여야 합니다: ${String(busyTimeoutMs)}`);
  }
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  // 적용 후 read-back — 조용히 적용 안 된 채 진행하면 경합 완화가 없다는 사실이 장애 때야 드러난다.
  const back = db.prepare('PRAGMA busy_timeout').get();
  const applied = back ? Number(back.timeout) : NaN;
  if (applied !== busyTimeoutMs) {
    throw new Error(`applyConnectionPragmas: busy_timeout read-back 불일치 — expected=${busyTimeoutMs} actual=${String(back && back.timeout)}`);
  }
  return { busyTimeoutMs: applied };
}
