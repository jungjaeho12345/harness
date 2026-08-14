# Step 5: db-busy-timeout

## 읽어야 할 파일

- `CLAUDE.md` — TDD·아키텍처·커밋 규칙(DB 비파괴)
- `docs/ADR.md` — **ADR-002**(node:sqlite 단일 파일 DB)·**ADR-006**(계층 방향). 이 step은 ADR을 **수정하지 않는다**
- `phases/64-exe-backlog/index.json` — scope의 (C-2), decisions **(15)(16)(17)(18)**, open_questions (a)
- `phases/59-history-title-backfill/index.json` — 부트 결선 seam(`runHistoryTitleBackfill`)을 export 헬퍼로 뽑아 테스트로 잠근 전례
- `server/index.js` 1250~1312행 — `bootstrap()` 전체. 특히 dataDir 보장 1269~1271행, `new DatabaseSync(paths.dbFile)` 1272행, `createSchema`/백필 1273~1278행, **1258행 주석**(이 본문에 모듈 메타 참조를 넣지 말라는 계약)
- `server/index.js`에서 `runHistoryTitleBackfill`이 export되고 `bootstrap`이 그것을 호출하는 부분 — 이 step이 따라 할 seam 모양
- `test/boot-history-backfill.test.js` — 부트 헬퍼를 in-memory DB로 잠그는 테스트 스타일
- `src/db/schema.js` — 같은 계층의 파일 스타일(순수 SQL·무의존)

## 배경 (실코드 확인 결과 + 계획 단계 실측)

- `bootstrap()` 1272행은 `new DatabaseSync(paths.dbFile)`로 DB를 연다. **계획 단계 실측(node v24.16.0)**: 이 연결의 `PRAGMA busy_timeout`은 `{ timeout: 0 }` — 잠금 경합 시 대기 없이 즉시 `SQLITE_BUSY`다.
- DB를 여는 직후 `createSchema`(멱등 `ALTER TABLE`)와 백필 2종이 **쓰기**를 수행하며, 이 전부가 `app.listen` **이전**이다. 같은 `data/` 폴더를 가리키는 인스턴스가 둘 뜨면(운영자가 exe를 두 번 실행하는 흔한 사고 — 포트 충돌은 그보다 **뒤에** 판정된다) 한쪽이 부팅 도중 SQLITE_BUSY로 죽는다.
- 같은 실측에서 `db.exec('PRAGMA busy_timeout = 5000')` 후 `db.prepare('PRAGMA busy_timeout').get()`은 `{ timeout: 5000 }`을 돌려준다(적용·읽기 확인 둘 다 가능).
- 백엔드 테스트 74개 스위트는 전부 자기 `DatabaseSync`를 만든다 — 부트 연결을 공유하지 않으므로 이 변경의 영향 범위는 프로덕션 부트 연결 하나다.

## 작업

### A. 테스트 먼저 (red)

`test/db-connection.test.js`(순수 헬퍼)와 `test/boot-db-open.test.js`(부트 결선 seam)를 red로 작성한다. 두 파일을 하나로 합쳐도 무방하다 — 단 두 계약을 **둘 다** 잠가야 한다.

### B. `src/db/connection.js` 신설 (DB 계층 — 무의존)

```js
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
// 연결 단위 PRAGMA 적용 + read-back 검증. 반환: { busyTimeoutMs } (DB가 실제로 보고한 값)
export function applyConnectionPragmas(db, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {})
```

- `busy_timeout`만 다룬다. `journal_mode`(WAL)·`synchronous`·`foreign_keys` 등 다른 PRAGMA는 **절대 건드리지 마라**(파일 레이아웃·백업 절차·내구성 정책이 바뀐다).
- `busyTimeoutMs`가 0 이상 정수가 아니면 `TypeError`를 던진다(조용한 no-op 금지 — `backfillHistoryTitles`의 주입 가드와 같은 house style). 0은 "즉시 실패"라는 명시적 선택이므로 허용한다.
- 적용 후 `PRAGMA busy_timeout`을 다시 읽어 기대값과 다르면 던진다(조용히 적용 안 된 채 진행 금지).
- 값의 근거·트레이드오프를 헤더 주석에 남긴다: 기본 5000ms는 널리 쓰이는 동기 SQLite 바인딩의 기본값과 같고, **대가는 외부 프로세스가 락을 오래 쥘 때 단일 스레드 서버가 최대 그 시간만큼 정지할 수 있다**는 것이다(현행은 즉시 500 응답).
- 계층 규율: 서비스·로거·express를 import하지 않는다.

### C. `server/index.js` 부트 결선 (2~3줄 + export 1개)

```js
// 부트 DB 연결의 단일 관문 — 열기와 연결 설정이 갈라지지 않게 한 곳에 둔다.
export function openBootDatabase(dbFile, pragmaOptions = {})   // → DatabaseSync 인스턴스
```

- 본문은 `new DatabaseSync(dbFile)` + `applyConnectionPragmas(db, pragmaOptions)` + `return db`뿐이다.
- `bootstrap()` 1272행을 `const db = openBootDatabase(paths.dbFile);`로 바꾼다. 그 외 부트 순서(dataDir 보장 → DB 열기 → `createSchema` → 백필 → 서비스 조립 → listen)는 **한 줄도 바꾸지 않는다**.
- 라우트·미들웨어·`createApp`은 이 step의 소유가 아니다(무수정).
- **CRITICAL(SEA 안전)**: `server/index.js`에 모듈 메타 참조를 새로 만들지 마라 — 주석에 그 리터럴을 적는 것도 금지다(`test/sea-import-meta-lock.test.js`가 텍스트로 세고 SEA 빌드 게이트가 "정확히 1건"만 허용한다. 1258행 주석이 그래서 '모듈 메타'라고 쓴다).

### D. 테스트 계약

- `applyConnectionPragmas(db)` → read-back 5000. 명시값(예: 1200) → 그 값. `0` → 0. 재적용해도 값 불변(멱등).
- 비정수·음수·NaN·문자열 → `TypeError`.
- `openBootDatabase(':memory:')` → 반환된 연결의 `PRAGMA busy_timeout`이 5000이고, 그 연결에 `createSchema(db)`가 정상 동작한다(부트 경로가 실제로 적용한다는 결선 증거 — 이 케이스가 없으면 헬퍼만 있고 결선이 빠져도 green이다).
- (권장) 경합 실측 1케이스: `mkdtemp` 임시 폴더의 파일 DB에 연결 두 개를 열고 A가 `BEGIN IMMEDIATE` + 쓰기로 락을 잡은 상태에서 B의 쓰기가 실패하기까지 걸린 시간을 잰다 — B의 `busy_timeout`이 300이면 **150ms 이상**, 0이면 즉시(예: 100ms 미만). 하한을 이보다 조이지 마라(느린 머신에서 flake가 된다). 임시 폴더는 테스트가 반드시 정리하고, **리포 `news.db`에는 절대 연결하지 마라**.

## Acceptance Criteria

```bash
node --test test/db-connection.test.js
node --test test/boot-db-open.test.js
node --test test/boot-history-backfill.test.js
node --test test/sea-import-meta-lock.test.js
npm test
npm run lint

# [1] 실부팅 스모크 — 임시 DATA_DIR로 서버를 띄워 health 200을 받고 종료한다(리포 news.db 무접촉)
node <scratchpad>/run-boot-smoke.mjs

# [2] data snapshot 비교 — [1] 실행 전후로 리포 news.db·uploads/가 그대로여야 한다
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" compare

# [3] diff scope
git status --porcelain
```

`[1]`의 러너(스크래치패드 — 리포에 커밋하지 않는다). **실행 전에** 위 스냅샷 커맨드를 `save` 인자로 먼저 돌려라.

```js
// run-boot-smoke.mjs — 임시 DATA_DIR로 server/index.js를 띄워 health를 확인하고 끈다
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yh-boot-'));
const port = 31000 + Math.floor(Math.random() * 2000);
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1' };
for (const k of ['NODE_ENV', 'FORCE_HTTPS', 'SPA_DIR', 'RCV_SPOOL_DIR', 'DIST_SPOOL_DIR', 'COLLECTION_TOKEN']) delete env[k];
const child = spawn(process.execPath, ['server/index.js'], { cwd: 'D:/agents/harness', env, stdio: ['ignore', 'pipe', 'pipe'] });
let err = ''; child.stderr.on('data', (c) => { err += c; });
let ok = false;
for (let i = 0; i < 100 && !ok; i += 1) {
  if (child.exitCode !== null) break;
  try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }); ok = r.status === 200; } catch {}
  if (!ok) await new Promise((r) => setTimeout(r, 100));
}
child.kill(); await new Promise((r) => setTimeout(r, 300)); if (child.exitCode === null) child.kill('SIGKILL');
console.log(ok ? `boot-ok port=${port} dataDir=${dataDir}` : `boot-FAILED exit=${child.exitCode}\n${err}`);
fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(ok ? 0 : 1);
```

## 검증 절차

1. AC를 전부 실행한다. 새 케이스가 red → green 순서를 거쳤음을 요약에 남긴다.
2. `[1]`이 `boot-ok`로 끝나는지 확인한다 — 부트 경로에 헬퍼를 끼운 뒤에도 서버가 그대로 뜬다는 증거다.
3. **변이 검증 3종**(각각 red 확인 후 원복): (a) `applyConnectionPragmas`가 아무것도 하지 않게 → 헬퍼 케이스와 `openBootDatabase` 케이스 둘 다 red, (b) `bootstrap`의 호출을 다시 `new DatabaseSync(...)`로 되돌림 → `openBootDatabase` 결선 케이스는 여전히 green이지만 **그 사실을 요약에 남겨라**(그래서 결선 케이스는 반드시 `openBootDatabase`를 호출해야 하고, bootstrap이 그 함수를 쓰는지는 `git diff`로 눈 확인한다), (c) 잘못된 값(-1)에 `TypeError`를 던지지 않게 → 입력 가드 케이스 red.
4. 실측 기록: 기본값 read-back 값, 경합 케이스에서 잰 지연(ms), `[1]`의 부팅 소요.
5. `git status --porcelain` 증분이 소유 파일(`src/db/connection.js`·`server/index.js`·`test/db-connection.test.js`·`test/boot-db-open.test.js`·`phases/64-exe-backlog/index.json`)뿐인지 확인한다.
6. 아키텍처 체크리스트: 스키마·컬럼·인덱스 무변경 · 라우트·미들웨어·`createApp` 무수정 · `src/services/**`·`src/models/**`·`web/**`·`client/**`·`scripts/**`·`docs/**` 무수정 · dependencies 불변 · `server/index.js`의 모듈 메타 참조 수 불변(`test/sea-import-meta-lock.test.js` green) · DB 행 생성·삭제 0.
7. `phases/64-exe-backlog/index.json`의 step5 status를 갱신한다. 이 항목이 리뷰에서 기각되면 step5만 통째로 되돌리면 된다는 사실(격리 설계)을 요약에 남겨라.

## 금지사항

- `journal_mode=WAL`·`synchronous`·`foreign_keys` 등 다른 PRAGMA를 함께 넣지 마라. 이유: WAL은 `news.db-wal`/`-shm` 파일을 만들어 "백업 = data/ 폴더 복사"라는 배포 계약과 .gitignore·정리 스크립트 전제를 바꾼다. 이번 항목은 부팅 경합 완화 하나다.
- 값을 5000보다 크게 잡지 마라(설정 env로 노출하는 것도 이번 스코프 밖이다). 이유: 동기 SQLite + 단일 스레드라 대기 시간이 그대로 전 사용자 정지 시간이 된다.
- 테스트·다른 코드에서 `applyConnectionPragmas`를 전역 기본으로 끼우지 마라(테스트 헬퍼·모델·서비스 어디에도). 이유: 74개 스위트가 자기 in-memory DB로 도는 현행 구조가 이 변경의 "영향 범위 = 부트 연결 1개" 근거다.
- `bootstrap()`의 순서(dataDir 보장 → DB 열기 → createSchema → 백필 → listen)를 재배치하지 마라. 이유: phase 59·60·61이 실측으로 확정한 부트 계약이다.
- `server/index.js`에 모듈 메타 참조를 새로 만들거나 그 리터럴을 주석에 적지 마라. 이유: SEA 빌드 게이트가 "정확히 1건"만 허용해 배포 빌드가 즉시 실패한다.
- 라우트·미들웨어·컨트롤러 조립을 건드리지 마라. 이유: 이 phase의 무수정 원칙이며, 부트 1줄 예외의 경계가 곧 이 step의 스코프다.
- 리포 루트 `news.db`에 연결하는 테스트·러너를 만들지 마라. 이유: 실데이터 오염은 되돌릴 수 없고, DB 비파괴는 절대 규칙이다.
