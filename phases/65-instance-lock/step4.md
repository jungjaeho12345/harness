# Step 4: docs-closeout

## 읽어야 할 파일

- `CLAUDE.md` — 커밋 규칙·작업 종료 시 보고 규칙
- `phases/65-instance-lock/index.json` — scope·decisions **전부**·excluded·open_questions (a)(b)(c)
- `phases/65-instance-lock/step0.md`~`step3.md` — 이 step이 문서로 옮길 결정·실측의 원문
- `docs/ADR.md` — **ADR-004**(in-process 세션 스토어 트레이드오프 — 이 잠금이 그 트레이드오프의 대응책이다)·**ADR-008**(타이머·egress 금지)·**ADR-010**(SEA 배포)·**ADR-011**(클라이언트 셸의 `requestSingleInstanceLock` = 별개 축). 항목 형식(결정/이유/트레이드오프)을 그대로 따른다
- `docs/ARCHITECTURE.md` — 9~41행(디렉토리 구조), 85~92행(배포 산출물 — 서버 EXE), 111~123행(보안 경계)
- `packaging/server/README-배포.md` — 95~101행(8절 백업), 119~135행(11절 문제 해결), 137~143행(12절 로그 = 콘솔 출력 계약)
- `packaging/README-배포-통합.md` — 97~106행(8절 문제 해결 표)
- `phases/64-exe-backlog/index.json` — `forward_notes`(이 phase가 소진한 (b)·(d) 3건과 그대로 이월할 (c))와 step6 요약(마감 게이트의 실물 전례)
- `phases/index.json` — 최상위 phase 목록(65 항목 갱신 대상)

## 배경

- 이 phase는 **운영 계약**을 바꾼다: "데이터 폴더당 서버 인스턴스 1개". 운영자가 이 사실과 새 콘솔 메시지를 모르면, 잠금 메시지를 원인 불명 크래시로 오인한다 → 배포 문서 2종과 아키텍처 문서에 반드시 남긴다.
- phase 64 `forward_notes` (b)와 (d)의 3건이 이 phase로 소진된다. (c)의 2건(SIGINT 콘솔 Ctrl+C 실기 · `--fallback` 실빌드)은 **그대로 이월**한다.

## 작업

### A. `docs/ADR.md` — ADR-012 신설 (ADR-011 뒤에 추가)

제목 예: `### ADR-012: 서버는 데이터 폴더당 단일 인스턴스 — 전용 잠금 파일의 SQLite EXCLUSIVE 트랜잭션 (PID 파일·타이머 없음)`

**결정**에 반드시 담을 것

- 부팅 시 `<DATA_DIR>/instance-lock.db`에 전용 연결(`busy_timeout=0`)을 열고 `BEGIN EXCLUSIVE`를 **프로세스 수명 동안 유지**한다. 그 파일에는 테이블·행을 만들지 않는다(0바이트).
- 획득 실패가 `SQLITE_BUSY`면 = 다른 인스턴스 → stderr에 원인·데이터 폴더·해결 2가지를 쓰고 `exit 1`. 그 밖의 실패는 **경고 후 부팅 계속**(잠금 없이 뜬다).
- 판정 위치는 `bootstrap`의 `dataDir` 보장 직후·DB 열기 직전이며 dev·SEA exe 공통이다(packaged 여부 무관, `DATA_DIR` 기준).
- 클라이언트 Electron 셸의 `requestSingleInstanceLock`(ADR-011)과는 **별개 축**이다.

**이유**에 반드시 담을 것

- 세션 스토어(ADR-004)·SSE EventEmitter(ADR-005)·배부 스풀 기록(ADR-008)이 전부 프로세스 로컬이라 같은 `news.db`를 공유하는 두 인스턴스는 split-brain이 된다. phase 64의 `busy_timeout=5000`이 부팅 즉사를 없애 공존이 더 쉬워졌다.
- OS 파일 락이라 **크래시·강제 종료 후 잔류 락이 없다**(실측: SIGKILL 직후 5ms 내 재획득). PID 파일 방식은 PID 재사용·`data\` 백업 복구로 잔류 락 오탐이 생겨 기각했다(오탐 = 운영자가 서버를 못 올림 = 최악 실패 모드).
- 경로 문자열이 아니라 파일 핸들로 판정하므로 심볼릭 링크·UNC/매핑 드라이브·대소문자 표기 차이가 같은 잠금으로 수렴한다.

**트레이드오프**에 반드시 담을 것

- 같은 데이터 폴더로 의도적 다중 기동이 불가능해진다(필요하면 `DATA_DIR` 분리).
- `data\`에 파일 1개(+ 잠금 유지 중 `-journal`)가 늘어난다.
- 잠금 파일을 열 수 없거나 손상된 드문 경우 잠금 없이 부팅한다(경고 1줄) — 부팅 차단 오탐보다 낫다는 선택이며, 그때는 오늘과 같은 무보호 상태다.
- 파일시스템 락에 의존하므로 `data\`를 **SMB/네트워크 드라이브**에 두는 배치는 이 결정의 검증 범위 밖이다. **두 방향 모두 미검증**임을 그대로 쓴다: ① 잠금이 동작하지 않아 두 인스턴스가 공존할 수 있고 ② 반대로 서버·클라이언트 측 락 잔류로 정상 재기동이 막힐 수도 있다. 권장 배치는 로컬 디스크이며, 네트워크 배치에서 재기동이 막히면 복구는 "모든 인스턴스 종료 확인 → 잔여 잠금 파일 제거(서버 중지 상태) → 재기동"이다. "잠금이 안 걸리는 방향뿐"이라고 단정하지 마라.
- 잠금 보유자를 앱이 식별할 수 없어 메시지에 PID를 넣지 못한다.

### B. `docs/ARCHITECTURE.md` (3줄 내외)

1. 디렉토리 구조의 `src/db/` 설명에 `instanceLock`(단일 인스턴스 잠금)을 추가한다.
2. "배포 산출물 (Windows 서버 EXE)" 또는 "보안 경계" 절에 계약 2줄: **데이터 폴더당 인스턴스 1개**(같은 `DATA_DIR`의 두 번째 부팅은 콘솔 메시지 + `exit 1`) · 잔류 락 없음(OS 해제) · 잠금 불가 시 경고 후 계속(부팅을 막지 않는다) · 타이머 없음(ADR-008).
3. 같은 절에 빌드 부작용 1줄: 배포 폴더에서 exe를 직접 띄운 적이 있으면 `<outDir>/data/`에 `instance-lock.db`가 남아, 이후 `npm run dist:server`가 "data/가 비어 있지 않다"는 **경고**를 출력한다(빌드는 계속되고 `data/`는 보존된다 — DB 비파괴 계약 그대로). 이는 정상이며 실패가 아니다.
4. 새 문장은 ADR-012를 참조한다. 기존 문장을 재작성하지 마라(추가만).

### C. `packaging/server/README-배포.md`

- **11절 문제 해결**에 항목 1개 추가: 콘솔에 "이미 실행 중" 메시지가 뜨고 즉시 종료되는 증상 → 원인(같은 `data\` 폴더로 두 번째 서버 실행) → 조치(기존 서버 콘솔 종료 후 재시작 / 두 대 운영이 필요하면 `DATA_DIR` 분리). 여기에 두 문장을 덧붙인다:
  - **복구 경로**: 기존 서버의 콘솔 창을 찾지 못하면 **작업 관리자에서 `기사작성기-server.exe`를 이름 기준으로 종료**하고, 그래도 정리되지 않으면 서버 PC를 재부팅한 뒤 한 번만 실행한다.
  - **안심 문장**: 강제 종료·정전 뒤에도 잠금은 남지 않는다(그냥 다시 켜면 된다) — 운영자의 가장 큰 불안이 그것이다.
- **10절 Windows 서비스**에 1줄 추가: 서비스가 기동 직후 종료·재시작을 반복(플래핑)하면 같은 `data\` 폴더로 다른 인스턴스(콘솔 실행 포함)가 떠 있는지 먼저 확인한다. 이 메시지는 **콘솔 전용**이라 서비스로 돌릴 때는 NSSM의 stdout/stderr 리다이렉트를 설정해 파일에서 확인해야 한다.
- **8절 백업**에 1줄: `data\`의 `instance-lock.db`는 0바이트 잠금 표식이라 백업·복구에 영향이 없다(서버 중지 상태에서는 지워도 무방하고, 다시 켜면 새로 만들어진다).
- 12절(로그·콘솔 계약)의 기존 문장은 **바꾸지 마라** — 새 메시지는 "콘솔에 글자 = 크래시" 계약의 한 사례다.

### D. `packaging/README-배포-통합.md`

8절 문제 해결 표에 1행 추가: 증상(서버 콘솔에 "이미 실행 중" 후 즉시 종료) / 원인(같은 데이터 폴더로 두 번째 서버 기동) / 조치(기존 서버 종료 후 재시작 또는 `DATA_DIR` 분리 — 서버 가이드 11절).

### E. 합쳐진 상태 재실증

step0~3이 합쳐진 HEAD에서 아래를 **직접 실행**한다(요약에 수치를 남긴다).

1. 전체 게이트: `npm test`(기준선 1289 + 증가분 명시) · `npm run lint` · `npm run build` · `npm run test:web`(2368/2368, 90 files. 1건 실패는 기지 flake 규약 — 재실행 2회 연속 green이면 통과, 그 사실을 요약에 남긴다).
2. 서버 배포 재조립: `npm run dist:server`(mode·소요·바이트 기록).
3. exe 검증 2종: `verify-server-exe` **full**(임시 DATA_DIR·SPA 주입)과 **portable**(폐기 가능한 **사본**을 대상으로 — 이 모드는 exe 옆 `data/`를 만든다). 잠금 파일이 새로 생기는 경로라 반드시 둘 다 돈다. portable 실행 후 사본의 `data/`에 `news.db`와 `instance-lock.db`가 함께 있는지 눈으로 확인하고 관측을 기록한다(위 B-3 문서 문장의 근거).
4. **배포 exe 이중 기동 실기**(이 phase의 최종 증거): 같은 임시 `DATA_DIR`로 서버 exe를 둘 띄워 ① 첫 번째 health 200 ② 두 번째가 `exit 1` + stderr 메시지 ③ 첫 번째가 여전히 health 200 ④ 첫 번째를 SIGKILL한 뒤 세 번째가 health 200(잔류 락 없음)을 확인한다. **SEA 번들에 새 모듈이 실제로 들어갔다는 증거**다.
5. 통합 검증: `npm run verify:integration`(= `--scenario all`) exit 0. 시나리오별 임시 `DATA_DIR`가 분리돼 있어 잠금 충돌이 없어야 한다 — 만약 충돌이 나면 그것은 제품 결함이 아니라 이 검증 스크립트의 자원 공유 문제이니 **원인을 요약에 기록하고 멈춰라**(임의로 스크립트를 고치지 말 것 — 그 판단은 리뷰 게이트의 몫이다).
6. 데이터 무접촉: 1~5 실행 전후로 리포 `news.db` 크기·mtime, `uploads/` 항목 수가 같다. 임시 폴더 누수 0(before/after 개수 비교). 사용자 미커밋 3건 원상태.

한글 경로가 필요한 실행(서버 exe·dist 폴더)은 **ASCII 경로의 node 러너 파일**(스크래치패드)에 담아 `node <ascii-path>`로 돌린다 — Bash 인라인에 한글을 넣지 마라. 러너는 리포에 커밋하지 않는다.

### F. phase 마감 기록

- `phases/65-instance-lock/index.json`: step0~4 status·summary 최종화 + 이 phase가 소진한 phase 64 forward_notes 항목((b)·(d) 3건)과 **그대로 이월하는 항목**((c)의 2건: SIGINT 콘솔 Ctrl+C 실기 미검증 · `--fallback` 실빌드 미검증)을 `forward_notes`로 남긴다. 이 phase가 새로 남기는 이월(잠금의 SMB/네트워크 드라이브 미검증)도 포함한다.
- `phases/index.json`: `65-instance-lock` 항목의 status·completed_at·note를 마감 내용으로 갱신한다(형식은 63·64 항목과 동형).

## Acceptance Criteria

```bash
npm test
npm run lint
npm run build
npm run test:web
npm run dist:server
node <scratchpad>/run-verify-server.mjs      # verify-server-exe full + portable(사본)
node <scratchpad>/run-exe-dual-boot.mjs      # 배포 exe 이중 기동 실기 (E-4)
npm run verify:integration
git status --porcelain
```

데이터 무접촉 스냅샷(전 `save` / 후 `compare` — step0~1 AC와 같은 커맨드):

```bash
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" compare
```

`run-verify-server.mjs` 뼈대(스크래치패드 전용 — full + portable 사본):

```js
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const REPO = 'D:/agents/harness';
const distDir = path.join(REPO, 'dist', '기사작성기-server');
const exeName = ['기사작성기-server.exe', 'article-server.exe'].find((n) => fs.existsSync(path.join(distDir, n)));
const run = (args) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'verify-server-exe.mjs'), ...args],
  { cwd: REPO, stdio: 'inherit' }).status;
// (1) full — 원본 exe 대상(임시 DATA_DIR·SPA 주입: 이 모드는 배포 폴더에 data/를 만들지 않는다)
const full = run(['--exe', path.join(distDir, exeName), '--spa', path.join(REPO, 'web', 'dist')]);
// (2) portable — 반드시 폐기 가능한 '사본'을 대상으로(이 모드는 exe 옆 data/news.db를 만든다)
const probe = path.join(os.tmpdir(), 'portable-probe-65');
fs.rmSync(probe, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.cpSync(distDir, probe, { recursive: true });
fs.rmSync(path.join(probe, 'data'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const portable = run(['--exe', path.join(probe, exeName), '--portable']);
console.log('full=', full, 'portable=', portable, 'probe data/=', fs.readdirSync(path.join(probe, 'data')).join(','));
// 관측 기록 후 사본 정리: fs.rmSync(probe, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
```

`run-exe-dual-boot.mjs` 뼈대(스크래치패드 전용 — 한글 경로는 **파일 안에서만** 다룬다):

```js
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn } from 'node:child_process';
const REPO = 'D:/agents/harness';
const exe = ['dist/기사작성기-server/기사작성기-server.exe', 'dist/기사작성기-server/article-server.exe']
  .map((p) => path.join(REPO, p)).find((p) => fs.existsSync(p));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-boot-'));
const boot = (port) => {
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, HOST: '127.0.0.1' };
  for (const k of ['NODE_ENV', 'FORCE_HTTPS', 'SPA_DIR', 'RCV_SPOOL_DIR', 'DIST_SPOOL_DIR', 'COLLECTION_TOKEN']) delete env[k];
  const c = spawn(exe, [], { cwd: dataDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  return { c, err: () => err };
};
// 1) 첫 인스턴스 health 200 → 2) 두 번째 exit 1 + stderr 메시지 → 3) 첫 인스턴스 여전히 200
// → 4) 첫 인스턴스 SIGKILL 후 세 번째 health 200(잔류 락 없음). 포트는 20000~34999에서 고른다.
// 마지막에 모든 자식 kill + dataDir 정리(maxRetries 5·retryDelay 200).
```

## 검증 절차

1. AC를 전부 실행하고 **관측값**(테스트 총계, 빌드 mode·바이트·소요, exe 이중 기동의 exit code와 stderr 원문, verify 결과 줄)을 요약에 기록한다.
2. E-4의 stderr 원문을 요약에 그대로 붙인다 — 배포 산출물에서 메시지가 실제로 보인다는 유일한 증거다.
3. 문서 4종의 변경이 **추가 위주**인지 확인한다(기존 문장 재작성 금지). ADR-012는 결정/이유/트레이드오프 3요소를 모두 갖췄는지 점검한다.
4. 점검표를 요약에 남긴다: (A) 잠금 코어 · (A) 부트 결선 · (A) 실기 이중 기동 · (A) stale 락 재기동 · (A) fail-open · (B-1) make-icon · (B-2) --cdp-port · (B-3) openBootDatabase close — 각 항목의 검증 커맨드와 결과.
5. `git status --porcelain` 증분이 소유 파일(`docs/ADR.md`·`docs/ARCHITECTURE.md`·`packaging/server/README-배포.md`·`packaging/README-배포-통합.md`·`phases/65-instance-lock/index.json`·`phases/index.json`)뿐인지 **시작 시점 스냅샷 대비**로 확인한다. 사용자 미커밋 3건은 손대지 마라.
6. 아키텍처 체크리스트: 코드 변경 0(이 step은 문서·기록만) · dependencies 불변 · 스키마 무변경 · DB 행 생성·삭제 0.
7. 미검증으로 남는 항목을 요약과 `forward_notes`에 명시한다(SMB/네트워크 드라이브 잠금 · phase 64 이월 2건).

## 금지사항

- 이 step에서 코드(`src/**`·`server/**`·`scripts/**`·`test/**`)를 고치지 마라. 이유: 문서 step이 코드를 만지면 리뷰가 "무엇이 검증된 상태인지"를 잃는다 — 재실증에서 결함이 나오면 고치지 말고 **기록하고 멈춘 뒤** 리뷰 게이트에 올려라.
- `docs/news.md`를 건드리지 마라. 이유: 이 phase의 무접촉 목록이며 제품 스펙 정본이다.
- ADR-011(클라이언트 셸)의 단일 인스턴스 잠금 문장을 고치거나 두 축을 한 항목으로 합치지 마라. 이유: 서버 잠금과 셸 잠금은 대상·메커니즘·실패 모드가 다르다 — 합치면 장애 시 진단이 엉킨다.
- 문서에 **PID 기반** 안내(특정 PID를 찾아 `taskkill /PID`로 죽이라는 절차)를 적지 마라. 이유: 앱이 잠금 보유자를 식별하지 못하고, 낡은 PID 안내는 무관한 프로세스를 죽이라는 지시가 된다. **이름 기준 종료**(작업 관리자에서 `기사작성기-server.exe`) 안내는 허용이며 위 C가 요구하는 항목이다.
- `npm run dist:client`를 돌리지 마라(필요 없다). 이유: 클라이언트 코드가 한 줄도 바뀌지 않았고, 350MB 재조립은 검증 가치 없이 시간과 디스크만 쓴다(통합 검증은 기존 클라이언트 exe로 충분하다).
- `verify-server-exe --portable`을 **배포 원본** 폴더에 돌리지 마라. 이유: 그 모드는 exe 옆에 `data/news.db`를 만든다 — 반드시 폐기 가능한 사본을 대상으로 하라(스크립트 헤더의 CRITICAL 계약).
- 재실증에서 실패가 나왔는데 스크립트·테스트를 손봐서 green을 만들지 마라. 이유: 마감 게이트의 목적이 사실 확인이며, 게이트를 맞춰 고치는 순간 그 사실이 사라진다.
