# Step 1: boot-wiring

## 읽어야 할 파일

- `CLAUDE.md` — TDD·계층·커밋 규칙(DB 비파괴)
- `docs/ADR.md` — **ADR-004**(in-process 세션 스토어 = 이 잠금의 존재 이유)·**ADR-005**(SSE도 프로세스 로컬)·**ADR-008**(타이머·egress 금지)·**ADR-010**(packaged 여부는 런타임 탐지가 아니라 명시 주입)
- `phases/65-instance-lock/index.json` — scope (A), decisions **(1)(5)(7)(8)(9)(10)(11)(12)(15)(16)(17)**, open_questions (c)
- `phases/65-instance-lock/step0.md` — 이 step이 결선할 모듈의 시그니처·규칙·실측 배경
- `src/db/instanceLock.js` — **step0 산출물**(`acquireInstanceLock`·`lockFilePath`·`classifyLockError`·`isLockHeld`·`releaseInstanceLock`)
- `server/index.js` 1250~1358행 — `openBootDatabase`(1258~1262) · `bootstrap()`(1267~1351) 전체 · 하단 argv 직접 실행 가드(1356~1358) · **1266행 CRITICAL 주석**(bootstrap 본문에 모듈 메타 참조 금지)
- `server/main.js` — SEA 엔트리(`bootstrap({ packaged: true })`) — 이 경로도 같은 잠금을 통과한다
- `test/same-origin-hardening.test.js` 135~205행(T4) — **bootstrap을 자식 프로세스로 실기 기동하는 전례**(env 정리·health 폴링·finally kill 패턴을 그대로 따라 쓴다)
- `test/boot-db-open.test.js` 40~63행 — `server/index.js`의 `new DatabaseSync(` 출현을 **정확히 1건**으로 잠그는 텍스트 스캔(깨뜨리면 즉시 red)
- `test/sea-import-meta-lock.test.js` — 모듈 메타 참조 출현 수 잠금(SEA 빌드 게이트)
- `packaging/server/README-배포.md` 137~143행(12절) — **콘솔 출력 = 크래시**라는 배포 계약(이 step의 메시지가 지켜야 할 규약. 문서 수정은 step4 소유)
- `.gitignore`

## 배경 (계획 단계 실측)

- 오늘 같은 `DATA_DIR`·다른 `PORT`로 서버를 둘 띄우면 **둘 다 health 200**이다(콘솔 출력 없음). 이 step이 그것을 끝낸다.
- 잠금 획득 비용은 콜드 5~6ms, 충돌 판정은 38ms(잠금 연결 busy_timeout 0 기준)다. 부팅 체감 영향은 없다.
- 보유 프로세스를 `SIGKILL`한 직후 다른 프로세스가 5ms 만에 획득한다 — **잔류 락으로 재기동이 막히는 오탐이 원리적으로 없다.** 이 성질을 T2 케이스가 실증한다.
- `bootstrap`은 현재 `fs.mkdirSync(paths.dataDir, {recursive:true})` → `openBootDatabase(paths.dbFile)` → `createSchema` → 백필 → `createLogService()` → 컨트롤러 조립 → `app.listen` 순서다.
- **Windows 콘솔 출력 함정**: Node 문서상 Windows에서 파이프에 연결된 `process.stderr.write`는 비동기다(`process.exit`가 버퍼를 잘라먹을 수 있다). 계획 단계 실측에서는 4KB 메시지가 15/15 도달했지만, 계약을 보장하려면 **`fs.writeSync(2, msg)`**(동기)로 쓴다.

## 작업

### A. 테스트 먼저 (red)

`test/instance-lock-boot.test.js`를 먼저 작성한다. 결선 전에는 T1(두 번째 인스턴스 거부)이 red여야 한다(현행은 둘 다 뜬다).

### B. `server/index.js` 부트 결선 (import 1줄 + 본문 5~8줄)

1. 상단 import 블록에 `import { acquireInstanceLock } from '../src/db/instanceLock.js';`를 추가한다(기존 `applyConnectionPragmas` import 줄 근처).
2. `bootstrap()` 본문에서 **`fs.mkdirSync(paths.dataDir, …)` 직후·`openBootDatabase(paths.dbFile)` 직전**에 잠금을 시도한다:

```js
// 잠금 판정 실패가 부팅을 막지 않게 한 겹 더 감싼다 — 모듈이 예상 밖 예외를 던져도(버그·환경)
// '잠금 없이 뜬다'로 수렴한다(오탐 = 서버를 못 올림 = 최악 실패 모드).
let lock;
try {
  lock = acquireInstanceLock({ dataDir: paths.dataDir });
} catch (err) {
  lock = { status: 'unavailable', file: undefined, error: err };
}
if (lock.status === 'conflict') {
  try { fs.writeSync(2, <아래 D의 메시지>); } catch { /* 출력 실패가 종료를 막지 않는다 */ }
  process.exit(1);
}
```

- 출력 실패(리다이렉트된 stderr가 닫힌 서비스 배치 등)가 `process.exit(1)`을 건너뛰게 두지 마라 — **메시지가 안 나가더라도 두 번째 인스턴스는 반드시 죽는다**(조용한 split-brain보다 조용한 종료가 낫다).

3. `const logService = createLogService();` **이후**에 진단 1줄을 남긴다:
   - `lock.status === 'unavailable'` → `logService.warn(...)` (잠금 파일 경로 + 원인 메시지 요약. **부팅은 계속한다**)
   - `lock.status === 'acquired'` → `logService.info(...)` 1줄(잠금 파일 경로)
4. 그 외 부트 순서(DB 열기 → `createSchema` → 백필 → 서비스 조립 → 진단 로그 → `listen` → 스풀·watcher)는 **한 줄도 바꾸지 않는다**.

### C. 왜 이 위치인가 (구현 시 지켜야 할 불변식)

- 잠금은 `news.db`를 **열기 전에** 판정된다 → 두 번째 인스턴스는 DB 파일을 건드리지 않고 죽는다(마이그레이션·백필도 실행되지 않는다).
- `process.exit(1)`은 **conflict 이 한 곳에서만** 쓴다. bootstrap의 다른 어떤 실패 경로도 exit로 바꾸지 마라.
- `unavailable`은 **절대 부팅을 막지 않는다**. 오탐(운영자가 서버를 못 올림)이 이 phase의 최악 실패 모드다.
- 위 try/catch는 그 원칙을 코드로 못박는 안전망이다: **`conflict`라는 명시적 판정 외에는 어떤 경로로도 부팅이 중단되지 않는다**. `catch` 블록에서 다시 던지거나 exit하지 마라.

### D. 콘솔 메시지 계약 (stderr, conflict 1회)

문구는 재량이되 아래 요소를 **전부** 포함한다(테스트가 잠근다).

- 서버를 시작할 수 없다는 사실 + "이미 실행 중"이라는 원인
- **데이터 폴더 절대 경로**(`paths.dataDir`)
- 해결 2가지: ① 기존 서버(콘솔 창)를 종료한 뒤 다시 시작 ② 두 대를 함께 운영해야 하면 **`DATA_DIR`**를 서로 다른 폴더로 지정
- 왜 막는지 1줄: 같은 데이터 폴더로 두 개를 띄우면 로그인 세션·실시간 갱신이 서버마다 갈라지고 배부가 중복될 수 있다

PID·프로세스 목록은 **넣지 마라**(decisions·excluded (c) — 낡은 PID로 무관한 프로세스를 죽이라고 안내하게 된다). 세션·토큰·비밀번호류는 당연히 금지다.

### E. `.gitignore` 2줄

```
instance-lock.db
instance-lock.db-journal
```

이유: dev 부팅(`npm run server`)은 `DATA_DIR` 미설정 시 dataDir가 **cwd(리포 루트)** 라 잠금 파일이 리포에 생긴다 → 없으면 모든 후속 step의 `git status --porcelain` 판정이 오염된다.

### F. 테스트 계약 (`test/instance-lock-boot.test.js`)

전례는 `test/same-origin-hardening.test.js` T4다(자식 기동·env 정리·health 폴링·finally kill). 자식은 `spawn(process.execPath, [serverPath], { cwd: <임시>, env, stdio: ['ignore','pipe','pipe'] })`로 띄우고, env는 `PORT`·`DATA_DIR`(임시 폴더)·`SPA_DIR=''`를 주고 `NODE_ENV`·`FORCE_HTTPS`·`COLLECTION_TOKEN`·`RCV_SPOOL_DIR`·`DIST_SPOOL_DIR`는 **삭제**한다. 포트는 20000~34999에서 고른다(35000~44999는 통합 검증의 CDP 범위 — 침범 금지).

**포트 충돌 오탐 방지(필수 계약)**: 랜덤 포트가 이미 쓰이면 서버가 EADDRINUSE로 죽어 "잠금 때문에 죽었다"로 오판된다. 둘 중 하나를 반드시 구현하라 — ① 기동 실패 시 **다른 포트로 1회 재시도**(`net.createServer` test-listen으로 빈 포트를 고르는 방식도 가능) ② 또는 자식이 기대와 다르게 죽은 모든 실패 단언에 **자식 stderr 원문을 메시지로 포함**한다(원인이 EADDRINUSE인지 잠금인지 실패 출력만 보고 가려낼 수 있어야 한다). 두 번째 인스턴스(B)의 종료 단언에서는 stderr 원문 포함이 **필수**다(잠금 메시지가 아닌 이유로 죽었을 때 즉시 드러나야 한다).

- **T1 두 번째 인스턴스 거부**: A 기동 → health 200 확인 → 같은 `DATA_DIR`·다른 포트로 B 기동 → B가 10초 안에 종료되고 `exitCode === 1`, B의 stderr에 (i) 데이터 폴더 경로 (ii) "이미 실행 중" 취지 (iii) `DATA_DIR` 문자열이 있다. B의 포트로는 health가 오지 않는다. **A는 여전히 health 200**이다(첫 인스턴스 무영향).
- **T1-b DB 무접촉**: B 기동 직전/직후 `<DATA_DIR>/news.db`의 size·mtimeMs가 같다(두 번째 인스턴스가 DB를 열지 않았다는 증거).
- **T2 stale 락 없음(오탐 안전성 실증)**: A를 `SIGKILL`로 죽이고 종료를 확인한 뒤, 같은 `DATA_DIR`·새 포트로 C를 기동 → **health 200**(재기동 성공). 이 케이스가 이 phase의 최악 실패 모드를 막는 회귀 잠금이다.
- **T3 fail-open**: 새 임시 `DATA_DIR`에 `instance-lock.db`를 텍스트 쓰레기로 만들어 두고 기동 → **health 200**(잠금을 못 걸어도 부팅은 계속된다).
- 모든 자식은 `finally`에서 `kill()` → 200ms 대기 → `exitCode === null`이면 `kill('SIGKILL')`. 임시 폴더 정리는 best-effort(`maxRetries:5, retryDelay:200`, 실패해도 테스트를 red로 만들지 마라).
- **리포 `news.db`·리포 루트를 `DATA_DIR`로 쓰지 마라.** 반드시 `mkdtemp` 임시 폴더다.

## Acceptance Criteria

```bash
node --test test/instance-lock-boot.test.js
node --test test/instance-lock.test.js test/boot-db-open.test.js test/same-origin-hardening.test.js
node --test test/sea-import-meta-lock.test.js test/runtime-paths.test.js test/host-binding.test.js
npm test
npm run lint
git status --porcelain
```

데이터 무접촉 스냅샷(자식 기동 **전** `save`, **후** `compare` — step0 AC와 같은 1줄 커맨드):

```bash
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" compare
```

## 검증 절차

1. AC를 전부 실행한다. T1이 결선 **전** red → 결선 **후** green이었음을 요약에 남긴다.
2. **육안 실기 1회**: 리포에서 `npm run server`를 두 콘솔에 각각 띄워(두 번째는 다른 `PORT`) 두 번째 콘솔에 나오는 메시지 원문을 요약에 그대로 붙인다. 확인 후 두 프로세스를 종료하고 리포 루트의 `instance-lock.db`가 `.gitignore`에 걸려 `git status --porcelain`에 나타나지 않는지 확인한다.
3. **변이 검증 4종**(각각 red 확인 후 원복):
   - (a) 잠금 호출을 통째로 제거 → T1 red.
   - (b) conflict에서 exit하지 않고 부팅을 계속 → T1 red.
   - (c) `unavailable`도 exit하게(fail-closed로 뒤집기) → **T3 red**(오탐 회귀를 이 케이스가 잡는다는 증거 — 요약에 명시하라).
   - (d) `acquireInstanceLock`이 첫 줄에서 예외를 던지도록 일시 변조(잠금 모듈 버그 시뮬레이션) → **서버는 여전히 health 200으로 뜬다**(T2·T3가 green 유지). 안전망 try/catch를 함께 제거하면 부팅이 죽는 것까지 확인해 "안전망이 실제로 그 경로를 막는다"를 실증하고, 둘 다 원복한다.
4. 실측 기록: A 부팅 시간, B 종료까지 걸린 시간, T2 재기동 성공 여부·시간, `npm test` 총계 증가분.
5. `git status --porcelain` 증분이 소유 파일(`server/index.js`·`test/instance-lock-boot.test.js`·`.gitignore`·`phases/65-instance-lock/index.json`)뿐인지 **시작 시점 스냅샷 대비**로 확인한다.
6. 아키텍처 체크리스트: 라우트·미들웨어·`createApp` 무수정 · 스키마 무변경 · `src/services/**`·`src/models/**`·`web/**`·`client/**`·`scripts/**`·`docs/**` 무수정 · dependencies 불변 · `server/index.js`의 `new DatabaseSync(` 출현 1건 유지(`node --test test/boot-db-open.test.js` green) · 모듈 메타 참조 수 불변(`node --test test/sea-import-meta-lock.test.js` green) · 새 타이머 0 · DB 행 생성·삭제 0.
7. `phases/65-instance-lock/index.json`의 step1 status를 갱신한다.

## 금지사항

- `unavailable`(잠금 파일 손상·열기 실패 등)에서 부팅을 막지 마라. 이유: stale/손상 상태로 **운영자가 서버를 못 올리는 것**이 이 phase가 정의한 최악 실패 모드이며, 잠금 없이 뜨는 것은 오늘과 같은 상태(경고 1줄로 관측 가능)다.
- 잠금 호출을 안전망 `try/catch` 없이 부트 경로에 두지 마라. 이유: 새 모듈의 예상 밖 예외 하나가 **모든 배치의 부팅을 막는다** — 잠금은 부가 기능이고 부팅이 본체다.
- conflict 외의 경로에 `process.exit`·`console.*`를 추가하지 마라. 이유: README-배포 12절이 "콘솔에 글자가 보이면 크래시"를 계약으로 못박았다 — 정상 부팅 경로가 콘솔에 뭔가 찍으면 운영자의 1차 진단 규칙이 무너진다.
- 잠금 메시지에 PID·프로세스 목록·`taskkill` 명령을 넣지 마라. 이유: 잠금 보유자를 앱이 식별할 수 없고(EXCLUSIVE 유지 중에는 다른 프로세스가 그 파일을 읽지도 못한다), 낡은 PID 안내는 무관한 프로세스를 죽이라는 지시가 된다.
- 잠금 위치를 `openBootDatabase` 뒤나 `listen` 근처로 옮기지 마라. 이유: 두 번째 인스턴스가 `createSchema`·백필을 실행한 뒤 죽으면 DB 무접촉 보장이 사라진다.
- `bootstrap()`의 나머지 순서(dataDir 보장 → DB 열기 → createSchema → 백필 → 서비스 조립 → listen)를 재배치하지 마라. 이유: phase 59~61이 실측으로 확정한 부트 계약이다.
- `server/index.js`에 `new DatabaseSync(`를 새로 쓰거나 모듈 메타 참조(그 리터럴을 주석에 적는 것 포함)를 추가하지 마라. 이유: 두 텍스트 잠금 테스트가 즉시 red가 되고 SEA 빌드 게이트가 실패한다.
- `setInterval`·`setTimeout`·시그널 핸들러로 잠금을 갱신·해제하지 마라. 이유: ADR-008(앱 내 타이머 금지)이고, 실측상 해제는 OS가 프로세스 종료 시 수행한다.
- `client/**`(Electron `requestSingleInstanceLock`)를 건드리지 마라. 이유: 별개 축이며 이미 존재한다 — 두 축을 섞으면 서버 잠금 실패가 클라이언트 부팅 문제로 오진된다.
- 자식 기동 테스트에서 `DATA_DIR`를 리포 루트로 주거나 `cwd`를 리포 루트로 주지 마라. 이유: 리포 `news.db`가 오염되고(비가역) 잠금 파일이 리포에 남는다.
