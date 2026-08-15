// 서버 단일 인스턴스 잠금 (phase 65 step0) — DB 계층 무의존 모듈(node:sqlite·node:path·connection.js만).
// 같은 DATA_DIR(=같은 news.db)로 서버가 둘 뜨면 in-process 세션 스토어(ADR-004)·SSE(ADR-005)·
// 배부 스풀 기록(ADR-008)이 전부 프로세스 로컬이라 split-brain이 된다. 이 모듈은 전용 파일
// <dataDir>/instance-lock.db에 BEGIN EXCLUSIVE 트랜잭션을 프로세스 수명 동안 유지해 그것을 막는다.
//
// 선택 근거와 기각안(계획 단계 실측, Windows/node v24):
// - PID 파일(O_EXCL + stale 판정) 기각 — 크래시 후 파일이 영구 잔류하고 Windows PID는 빠르게
//   재사용되므로, 죽은 인스턴스의 PID를 무관한 산 프로세스가 물면 운영자가 서버를 못 올린다
//   (stale 락 오탐 = 이 phase가 정의한 최악 실패 모드). SQLite EXCLUSIVE는 OS 파일 락이라
//   SIGKILL 직후에도 5ms 만에 재획득됐다(잔류 락이 원리적으로 없다).
// - news.db 자체 EXCLUSIVE 기각 — 자기 부트 연결이 막혀 자멸한다. 잠금은 전용 파일에만 건다.
// - 잠금 연결의 busy_timeout은 0이다 — 5000이면 충돌 판정에 7,563ms, 0이면 38ms(실측).
//   두 번째 인스턴스는 즉시 죽어야 한다(부트 연결의 5000과 반대 축).
//
// CRITICAL(실측 함정): 획득한 DatabaseSync 참조를 버리면 GC가 잠금을 조용히 푼다(참조 드롭 +
// gc 2회 후 외부 프로세스가 획득 성공 — 실측). 그래서 핸들 보관은 호출부가 아니라 이 모듈
// 스코프 변수의 책임이다. 반대로 실패(conflict·unavailable) 경로는 그 시도로 연 핸들을 반드시
// 닫는다 — 안 닫으면 실패한 인스턴스가 잠금 파일 핸들을 수명 내내 물어 unlink가 EBUSY·폴더
// rmSync가 EPERM이 된다(운영자의 수동 복구 경로까지 막힌다). 닫기 실패는 삼킨다(phase 64 C-1).
//
// 이 모듈은 판정만 한다 — process.exit·console 출력·타이머·시그널 핸들러 금지(ADR-008).
// 종료·출력 결정은 부트(server/index.js bootstrap)의 책임이다. 잠금 파일에는 테이블·행을
// 만들지 않는다(0바이트 유지 — 잠금은 파일 내용이 아니라 열린 핸들에 있다).

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyConnectionPragmas } from './connection.js';

export const LOCK_FILENAME = 'instance-lock.db';

// 잠금 유지 연결 — 모듈 스코프 보관(GC로 조용히 풀리는 함정 방지). 프로세스 수명 = 잠금 수명.
let heldConnection = null;
let heldFile = null;

// 순수 — dataDir에서 잠금 파일 절대 경로를 만든다(파일시스템 접근 없음).
export function lockFilePath(dataDir) {
  return path.resolve(dataDir, LOCK_FILENAME);
}

// 순수 — 오류 분류. conflict는 SQLITE_BUSY(하위 8비트 5)뿐이다(확장 코드 261 등 포함).
// 그 외 전부(폴더 부재 14·손상 파일 26·경로가 디렉토리 526·errcode 없는 오류·undefined·null)는
// unavailable — 부팅 차단 오탐이 최악 실패 모드라, 모르는 실패는 "잠금 없이 계속"으로 수렴시킨다.
export function classifyLockError(err) {
  return (err?.errcode & 0xff) === 5 ? 'conflict' : 'unavailable';
}

// 잠금 획득 시도. 정상 입력에서는 예외를 밖으로 던지지 않는다 — 판정 결과만 돌려준다
// (dataDir 비문자열 같은 호출 계약 위반은 lockFilePath에서 TypeError가 날 수 있고, 부트의
// 안전망이 unavailable로 흡수한다). 전제: 프로세스당 dataDir는 1개다 — 이미 보유 중이면
// 다른 dataDir로 불러도 기존 보유(heldFile)를 그대로 돌려준다(bootstrap 단일 호출이 정본).
//   open: 테스트 주입 seam(기본은 실제 DatabaseSync 생성).
export function acquireInstanceLock({ dataDir, open = (file) => new DatabaseSync(file) } = {}) {
  if (heldConnection) return { status: 'acquired', file: heldFile };
  const file = lockFilePath(dataDir);
  let db;
  try {
    db = open(file);
    applyConnectionPragmas(db, { busyTimeoutMs: 0 });
    // COMMIT/ROLLBACK 하지 않는다 — EXCLUSIVE 유지가 잠금 그 자체다. 해제는 OS가 프로세스 종료 시 한다.
    db.exec('BEGIN EXCLUSIVE');
    heldConnection = db;
    heldFile = file;
    return { status: 'acquired', file };
  } catch (err) {
    if (db) {
      try { db.close(); } catch { /* 닫기 실패는 삼킨다 — 원인 오류를 대체하지 않는다(phase 64 C-1) */ }
    }
    return { status: classifyLockError(err), file, error: err };
  }
}

export function isLockHeld() {
  return heldConnection !== null;
}

// 테스트·정리 전용 — 운영에서는 호출하지 않는다(해제는 프로세스 종료가 전부다).
export function releaseInstanceLock() {
  if (!heldConnection) return;
  const db = heldConnection;
  heldConnection = null;
  heldFile = null;
  try { db.close(); } catch { /* 정리 전용 — 실패 무시 */ }
}
