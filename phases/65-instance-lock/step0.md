# Step 0: lock-core

## 읽어야 할 파일

- `CLAUDE.md` — TDD·계층·커밋 규칙(DB 비파괴)
- `docs/ADR.md` — **ADR-002**(node:sqlite 단일 파일 DB)·**ADR-004**(in-process 세션 스토어 트레이드오프)·**ADR-006**(계층 방향)·**ADR-008**(앱 내 타이머 금지). 이 step은 ADR 문서를 **수정하지 않는다**(문서는 step4 소유)
- `phases/65-instance-lock/index.json` — scope (A), decisions **(2)(3)(4)(5)(6)(7)(10)(11)(12)(15)(16)(17)**
- `src/db/connection.js` — 이 step이 재사용할 `applyConnectionPragmas`(read-back 검증 포함)와 그 헤더 주석 규율
- `test/db-connection.test.js` — 같은 계층 모듈을 node:test로 잠그는 스타일(임시 파일 DB 경합 케이스 포함)
- `src/db/schema.js` — 같은 계층(`src/db/**`)의 무의존 파일 스타일
- `test/sea-import-meta-lock.test.js` — **`server/**`와 `src/**`의 모든 .js를 텍스트로 스캔**해 모듈 메타 참조를 "정확히 1건(server/index.js)"으로 잠근다 → 이 step이 만드는 `src/db/instanceLock.js`도 스캔 대상이다
- `src/models/articleModel.js`의 `tx()` catch — phase 64 C-1이 확립한 "정리 호출을 try/catch로 감싸 원인 예외를 보존한다" 패턴의 실물(이 step의 실패 경로 정리에 같은 규율을 쓴다)
- `phases/64-exe-backlog/index.json` — decisions (14)(15)(18)(전례: 순수 모듈 + 테스트로 잠그기, 정리 호출의 예외 삼킴, 데이터 무접촉 스냅샷)

## 배경 (계획 단계 실측 — 추측 아님, 그대로 신뢰해도 된다)

환경: Windows 10 / node v24.16.0 / `node:sqlite` `DatabaseSync`.

1. **하자 재현**: 같은 `DATA_DIR`·다른 `PORT`로 `node server/index.js`를 둘 띄우면 **둘 다 `/api/health` 200**으로 정상 기동하고 콘솔 출력은 없다. 오늘은 아무도 막지 않는다.
2. **채택 방식의 동작**: 전용 파일(`instance-lock.db`)에 `DatabaseSync` 연결을 열고 `PRAGMA busy_timeout = 0` → `BEGIN EXCLUSIVE`를 실행한 뒤 **커밋/롤백하지 않고 유지**하면, 다른 프로세스의 같은 시도가 `errcode=5`(`database is locked`)로 **38ms** 만에 실패한다.
3. **경합 정확도**: 4개 프로세스를 동시에 띄우는 라운드를 3회 반복 → 매번 정확히 1개만 획득(HELD), 3개는 errcode 5.
4. **같은 프로세스 안에서도** 두 번째 연결의 `BEGIN EXCLUSIVE`는 errcode 5로 차단된다 → **자식 프로세스 없이** conflict 경로를 단위 테스트로 실측할 수 있다.
5. **stale 락 없음**: 보유 프로세스를 `SIGKILL`로 죽인 직후 다른 프로세스가 **5ms** 만에 획득했다. 쓰레기 `-journal` 파일을 심어 둬도 SQLite가 복구하고 획득에 성공했다(획득 후 그 journal은 사라진다).
6. **busy_timeout 상호작용**: 잠금 연결의 busy_timeout이 5000이면 충돌 판정에 **7,563ms**가 걸린다(0이면 38ms). 잠금 연결은 반드시 0이다.
7. **오류 코드 표(실측)**: 다른 인스턴스 보유 = `errcode 5` / 부모 폴더 부재 = `14` / 손상 파일(텍스트) = `26`(BEGIN 단계) / 경로가 디렉토리 = `526`(open 단계).
8. **GC 함정**: 획득한 `DatabaseSync` 참조를 버리고 `global.gc()`를 2회 부르면 **외부 프로세스가 잠금을 획득한다**(= 잠금이 조용히 풀린다).
9. **파일 핸들 수명**: 잠금 보유 중에는 그 파일의 `unlink`가 `EBUSY`, 폴더 `rmSync`가 `EPERM`이다. 연결을 닫으면 즉시 삭제된다.
10. `applyConnectionPragmas(db, { busyTimeoutMs: 0 })`는 phase 64에서 이미 허용된 입력이다(0 = "즉시 실패"라는 명시적 선택 — `test/db-connection.test.js`에 케이스 존재).

## 작업

### A. 테스트 먼저 (red)

`test/instance-lock.test.js`를 먼저 작성해 red를 확인한다(모듈이 없으므로 import 실패로 red).

### B. `src/db/instanceLock.js` 신설 (DB 계층 — 무의존)

시그니처만 고정하고 구현은 재량이다.

```js
export const LOCK_FILENAME = 'instance-lock.db';

// 순수 — dataDir에서 잠금 파일 절대 경로를 만든다(파일시스템 접근 없음).
export function lockFilePath(dataDir)                     // → string

// 순수 — 오류를 'conflict'(다른 인스턴스 보유) | 'unavailable'(그 외 전부)로 분류한다.
export function classifyLockError(err)                    // → 'conflict' | 'unavailable'

// 잠금 획득 시도. 예외를 밖으로 던지지 않는다(판정 결과만 돌려준다).
export function acquireInstanceLock({ dataDir, open })    // → { status, file, error? }
//   status: 'acquired' | 'conflict' | 'unavailable'
//   open: 테스트 주입 seam(기본 (file) => new DatabaseSync(file))

export function isLockHeld()          // → boolean (모듈이 잠금을 보유 중인가)
export function releaseInstanceLock() // → void (테스트·정리 전용. 운영에서는 호출하지 않는다)
```

**핵심 규칙(벗어나지 마라)**

- 획득한 연결 핸들은 **모듈 스코프 변수**에 보관한다. 반환값만 주고 보관을 호출부에 맡기지 마라 — 참조가 끊기면 GC가 잠금을 조용히 푼다(배경 8 실측).
- 잠금 연결에는 `applyConnectionPragmas(db, { busyTimeoutMs: 0 })`를 적용한다(배경 6). `src/db/connection.js`를 import해 재사용하고, PRAGMA를 직접 문자열로 다시 쓰지 마라.
- `BEGIN EXCLUSIVE`만 실행하고 **COMMIT/ROLLBACK 하지 않는다**(프로세스 수명 = 잠금 수명).
- 잠금 파일에 **테이블·행을 만들지 마라**(0바이트 유지). `CREATE TABLE`·`INSERT`·`PRAGMA journal_mode` 금지.
- **news.db를 잠금 대상으로 삼지 마라** — 자기 부트 연결이 막혀 자멸한다.
- 오류 분류는 `(err?.errcode & 0xff) === 5`만 `conflict`, 나머지 전부 `unavailable`(errcode가 없는 일반 Error·`undefined`·`null` 포함). 확장 코드(261 등)도 하위 8비트로 판정된다.
- **실패(conflict·unavailable) 시 그 시도로 연 핸들을 반드시 닫는다.** `open`이 성공한 뒤 `BEGIN EXCLUSIVE`가 던지는 경로가 실재하므로(실측: conflict는 open 성공 → BEGIN 실패, 손상 파일도 같은 모양), 닫지 않으면 **실패한 인스턴스가 잠금 파일 핸들을 프로세스 수명 내내 물고 있게 된다**(실측: 그 상태에서는 그 파일의 `unlink`가 EBUSY, 폴더 `rmSync`가 EPERM — 운영자가 수동 정리조차 못 한다). 닫기 자체가 던지면 **삼킨다**(원인 오류를 대체하지 마라 — phase 64 C-1과 같은 규율). 보유 참조도 남기지 않는다(`isLockHeld() === false`).
- 이미 보유 중에 다시 호출되면 **새 연결을 열지 말고** 같은 결과(`acquired`)를 돌려준다(멱등).
- 타이머·재시도·`setInterval`·시그널 핸들러·`process.on('exit')`·`process.exit` 금지(ADR-008 / 이 모듈은 판정만 한다 — 종료 결정은 step1의 부트가 한다).
- 계층: `express`·`src/services/**`·logService·`server/**`를 import하지 마라. 허용 import는 `node:sqlite`·`node:path`·`src/db/connection.js`뿐이다.
- **CRITICAL(SEA 안전)**: 이 파일에 모듈 메타 참조를 쓰지 마라 — **주석·문자열 안의 리터럴도 카운트된다**(`test/sea-import-meta-lock.test.js`가 `src/**`까지 스캔해 "정확히 1건"만 허용한다). 경로가 필요하면 인자로 받아라(이 모듈은 `dataDir`만 받는다). 설명이 필요하면 "모듈 메타"라고 한글로 쓴다.
- 헤더 주석에 **선택 근거와 기각안**을 남긴다(왜 PID 파일이 아닌지 = stale 락 오탐이 최악 실패 모드, 왜 news.db가 아닌지 = 자멸, 왜 busy_timeout 0인지 = 7.5초 vs 38ms 실측).

### C. `src/db/connection.js` 헤더 주석 1줄 정정 (동작 무변경)

"적용 대상은 프로덕션 부트 연결 1개뿐이다" 문장이 사실과 어긋나게 된다 — **부트 연결과 인스턴스 잠금 연결 2곳**임을 밝히고, "테스트 헬퍼·모델·서비스에 전역 기본으로 끼우지 마라"는 규율 문장은 그대로 유지한다. 코드는 한 글자도 바꾸지 마라.

### D. 테스트 계약 (`test/instance-lock.test.js`)

임시 폴더(`fs.mkdtempSync(path.join(os.tmpdir(), ...))`)만 쓴다. **리포 `news.db`·리포 루트에는 절대 연결하지 마라.**

1. `lockFilePath('X')`가 `X` 아래 `LOCK_FILENAME` 경로를 만든다(파일시스템 접근 없이).
2. 획득 성공: `acquireInstanceLock({ dataDir: tmp })` → `status === 'acquired'`, `file`이 존재, `isLockHeld() === true`.
3. **잠금 파일에 데이터가 없다**: 획득 후 파일 크기 0(테이블·행 미생성 증거).
4. **conflict(실 OS 잠금)**: 테스트가 직접 `new DatabaseSync(lockFile)` + `PRAGMA busy_timeout = 0` + `BEGIN EXCLUSIVE`로 먼저 잡아 둔 뒤 `acquireInstanceLock`을 호출 → `status === 'conflict'`, 예외가 밖으로 새지 않는다(배경 4가 이 케이스의 근거다). 케이스 끝에 그 raw 연결은 반드시 `ROLLBACK` + `close`한다.
4-b. **conflict 후 핸들 누수 0**: 위 4에서 raw 연결까지 닫은 뒤 `fs.rmSync(dir, { recursive: true, force: true })`가 **재시도 없이 성공**한다(실패한 acquire가 자기 핸들을 닫았다는 증거 — 실측상 열린 핸들이 남으면 EPERM이다). `isLockHeld() === false`도 함께 단언한다. unavailable 경로(케이스 6, 손상 파일)에도 같은 단언을 둔다.
5. **unavailable — 폴더 부재**: 존재하지 않는 하위 경로를 `dataDir`로 주면 `status === 'unavailable'`(예외 전파 금지).
6. **unavailable — 손상 파일**: 잠금 파일 자리에 텍스트를 써 두고 호출 → `status === 'unavailable'`(errcode 26).
7. `classifyLockError` 단위: `{errcode:5}`·`{errcode:261}` → `'conflict'` / `{errcode:14}`·`{errcode:26}`·`{errcode:526}`·`new Error('x')`·`undefined`·`null` → `'unavailable'`.
8. 멱등: 획득 후 다시 호출해도 `'acquired'`이고 새 연결이 열리지 않는다(`open` 주입 seam으로 호출 횟수 0 확인).
9. `releaseInstanceLock()` 후 `isLockHeld() === false`이고 같은 폴더로 재획득이 성공한다(배경 5·9의 동형 확인).
10. `open` 주입으로 conflict/unavailable 분기를 결정적으로 한 번 더 잠근다(가짜 오류 객체 `{errcode:5}` / `{errcode:26}`).

**정리(teardown)**: 각 케이스는 `releaseInstanceLock()`으로 핸들을 닫은 뒤 `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })`로 임시 폴더를 지운다. 정리 실패가 테스트를 red로 만들지 않게 하라(try/catch — 임시 폴더는 os.tmpdir 안이다). 열린 핸들이 남으면 삭제가 EPERM으로 실패한다(배경 9).

## Acceptance Criteria

```bash
node --test test/instance-lock.test.js
node --test test/db-connection.test.js test/boot-db-open.test.js
node --test test/sea-import-meta-lock.test.js
npm test
npm run lint
git status --porcelain
```

데이터 무접촉 스냅샷(테스트 실행 **전** `save`, **후** `compare`):

```bash
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" compare
```

## 검증 절차

1. AC를 전부 실행한다. 새 케이스가 red → green 순서를 거쳤음을 요약에 남긴다(`npm test`는 기준선 1289에서 증가한다 — 증가분을 기록하라).
2. **변이 검증 4종**(각각 red 확인 후 원복):
   - (a) 획득한 핸들을 모듈 스코프에 보관하지 않게(지역 변수로) → `isLockHeld`·`releaseInstanceLock`·멱등 케이스 red.
   - (b) `classifyLockError`가 모든 오류를 `'conflict'`로 → unavailable 케이스 2종 red(**오탐 방향 회귀를 이 테스트가 잡는다는 증거** — 요약에 명시하라).
   - (c) `BEGIN EXCLUSIVE` 대신 아무것도 하지 않게 → conflict 케이스 red.
   - (d) 실패 경로의 `db.close()`를 제거 → 케이스 4-b(rmSync 성공) red(핸들 누수 회귀 검출 증거).
3. 실측 기록(요약에 숫자로): conflict 판정에 걸린 시간, 획득 후 잠금 파일 크기, 실패 후 `rmSync` 성공 여부, `npm test` 총계.
4. `git status --porcelain` 증분이 소유 파일(`src/db/instanceLock.js`·`test/instance-lock.test.js`·`src/db/connection.js`·`phases/65-instance-lock/index.json`)뿐인지 확인한다. **시작 시점 스냅샷 대비 증분**으로 판정하고, 사용자 미커밋 3건(`.claude/skills/...`·`phases/49-...`·`phases/50-...`)은 손대지 마라.
5. 아키텍처 체크리스트: 스키마·컬럼·인덱스 무변경 · `server/**`·`src/services/**`·`src/models/**`·`web/**`·`client/**`·`scripts/**`·`docs/**` 무수정 · dependencies 불변 · DB 행 생성·삭제 0 · 새 타이머 0(`grep -n "setInterval\|setTimeout" src/db/instanceLock.js`가 0건) · 모듈 메타 참조 수 불변(`node --test test/sea-import-meta-lock.test.js` green — 이 테스트는 `src/**`도 스캔한다).
6. `phases/65-instance-lock/index.json`의 step0 status를 갱신한다.

## 금지사항

- `server/index.js`를 이 step에서 만지지 마라(결선은 step1 소유). 이유: 결선과 코어가 한 step에 섞이면 실패 원인이 "잠금 로직"인지 "부트 순서"인지 격리되지 않는다.
- `server/index.js`에 `new DatabaseSync(`를 추가하지 마라(이 step 밖의 규율이지만 기억하라). 이유: `test/boot-db-open.test.js`가 그 리터럴을 "정확히 1건"으로 텍스트 잠금하고 있다.
- 잠금 파일에 테이블·행을 만들지 마라. 이유: 잠금은 파일 내용이 아니라 열린 핸들에 있다 — 데이터를 넣는 순간 백업·복구·마이그레이션 대상이 하나 늘고 DB 비파괴 규칙의 표면이 넓어진다.
- `journal_mode`(WAL)·`synchronous` 등 다른 PRAGMA를 건드리지 마라. 이유: 파일 레이아웃(`-wal`/`-shm`)이 바뀌어 "백업 = data/ 폴더 복사" 계약과 .gitignore 전제가 깨진다.
- 실패(conflict·unavailable) 경로에서 열린 핸들을 그대로 두지 마라. 이유: 실측상 그 핸들이 살아 있으면 잠금 파일의 `unlink`가 EBUSY, 상위 폴더 `rmSync`가 EPERM이 되어 **운영자의 수동 복구 경로까지 막힌다**(phase 64 C-1이 닫은 것과 같은 결함 클래스를 새 모듈에 다시 들이지 마라).
- 이 파일에 모듈 메타 참조를 쓰지 마라(주석·문자열 포함). 이유: `test/sea-import-meta-lock.test.js`가 `server/**`뿐 아니라 **`src/**`까지** 텍스트로 스캔해 "정확히 1건"만 허용한다 — 한 글자만 적어도 즉시 red이고 SEA 빌드 게이트가 실패한다.
- 타이머·하트비트·재시도 루프를 넣지 마라. 이유: ADR-008이 앱 내 타이머를 금지하며, 실측상 잠금 해제는 OS가 프로세스 종료 시 수행하므로 갱신이 필요 없다.
- `process.exit`·`console.*`를 이 모듈에 쓰지 마라. 이유: 이 모듈은 판정만 한다 — 종료·출력 결정은 부트(step1)의 책임이고, 콘솔 출력 규약(크래시만)을 라이브러리가 깨면 안 된다.
- 리포 루트나 리포 `news.db`를 dataDir로 쓰는 테스트를 만들지 마라. 이유: 실데이터 오염은 되돌릴 수 없고, 리포 루트에 잠금 파일이 생기면 diff scope 판정이 오염된다.
- `src/db/connection.js`의 **코드**를 바꾸지 마라(주석 1줄만 허용). 이유: phase 64가 실측으로 확정한 부트 연결 계약이며, 이 step의 스코프는 새 모듈이다.
