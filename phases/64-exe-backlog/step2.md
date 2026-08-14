# Step 2: verify-scripts

## 읽어야 할 파일

- `CLAUDE.md` — TDD·아키텍처·커밋 규칙
- `phases/64-exe-backlog/index.json` — scope의 (A-1)(A-7)(A-8), decisions **(8)(9)(10)(11)(16)(17)(18)**
- `phases/63-integration/index.json` — decisions (10)~(13), forward_notes (e)(f)(g)(한글 인자·CLI import 금지)
- `scripts/verify-server-exe.mjs` — 전체. 특히 임시 디렉토리 생성 81~91행, 종료 처리 195~201행, 종료 후 DB 확인 203~228행, 성공/실패 출력 230~248행
- `scripts/verify-integration.mjs` — 전체. 특히 USAGE 35~43행, `pickFreePort` 140~153행, `appDataSnapshot` 188~202행, 시나리오 포트 선택 365~383행, `main()`의 임시 디렉토리·정리 603~655행
- **step0 산출물**: 두 파일의 갱신된 `parseArgs` — 이 step은 그 함수 **밖**만 만진다

## 배경 (실코드 확인 결과)

- **(A-1)** `verify-server-exe.mjs` 82~83행이 `verify-exe-data-*`(**시드된 news.db 포함**)와 `verify-exe-cwd-*` 두 임시 폴더를 만들지만, 성공·실패 어느 경로에서도 지우지 않는다. 실행할 때마다 시드 계정이 든 DB 파일이 `%TEMP%`에 쌓인다(자격증명 위생 문제이자 디스크 누수). 같은 리포의 `verify-integration.mjs` 645~655행은 이미 `--keep`가 아니면 정리하고 실패 시 경고만 남기는 관행을 갖고 있다.
- **(A-7)** `verify-integration.mjs`의 서버 포트는 `pickFreePort(host, 20000, 30000)` = **20000~49999**, CDP 포트는 `pickFreePort('127.0.0.1', 25000, 20000)` = **25000~44999**로 범위가 겹친다. `pickFreePort`가 실제 listen으로 확인하긴 하지만 CDP 포트는 서버 자식이 spawn된 **직후**(아직 bind 전일 수 있는 시점) 뽑히므로, 같은 번호를 CDP가 먼저 잡고 서버가 곧이어 EADDRINUSE로 죽는 경합이 성립한다. 이 파일 140~141행 주석이 기록하듯 포트 충돌로 시나리오가 오탐 실패한 전례가 이미 있다.
- **(A-8)** `appDataSnapshot`(188행)은 실사용자 `%APPDATA%\기사작성기`의 `config.json` 하나만 본다 — 그 폴더에 새 파일·폴더가 생겨도 "무변"으로 통과한다. 또 `main()`에는 SIGINT 핸들러가 없어 Ctrl+C로 중단하면 임시 디렉토리(시드 DB·Electron userData 포함)가 그대로 남는다.

## 작업

A → B 순서(파일이 다르므로 독립적이다).

### A. `scripts/verify-server-exe.mjs` — 임시 폴더 수명 (A-1)

1. 정리 함수를 하나 두고 **성공 경로에서만** 두 임시 디렉토리를 지운다: `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })`(Windows 파일 잠금 대비 — verify-integration 648행과 동형). 정리 실패는 `warn` 1줄이며 **종료 코드를 뒤집지 않는다**.
2. **실패 경로에서는 지우지 않는다.** 실패 출력(240~248행 블록)에 두 경로를 `보존됨` 라벨과 함께 명시한다 — 조사에 필요한 증거(시드 DB·서버가 쓴 행)를 스크립트가 없애면 안 된다.
3. 정리는 **자신이 mkdtemp로 만든 두 경로에만** 적용한다. `--portable`이 만드는 `<exeDir>/data/news.db`는 절대 건드리지 마라(헤더 12~13행 계약: 자기 임시 경로 밖의 어떤 파일도 삭제하지 않는다).
4. 정리 시점은 자식 종료(`child.kill` 이후)와 종료 후 DB 확인(`db.close()`) **뒤**여야 한다 — 열린 핸들이 있으면 Windows에서 EBUSY가 난다.
5. `--keep` 같은 새 플래그를 만들지 마라(decisions (8)).

### B. `scripts/verify-integration.mjs` — 포트 범위·스냅샷·중단 정리 (A-7·A-8)

1. **포트 범위 분리**: 서버 `pickFreePort(host, 20000, 15000)`(20000~34999) / CDP `pickFreePort('127.0.0.1', 35000, 10000)`(35000~44999). 둘 다 Windows 동적 포트 기본 범위(49152~65535) 아래에 둔다(decisions (9)). USAGE의 `--cdp-port` 설명 문구도 새 범위로 고친다.
2. **선택된 포트를 notes 1줄로 남긴다**(예: `ports server=<p> cdp=<c>`). 범위 분리를 실행 로그로 증명하는 유일한 수단이고 실패 진단 입력이다. 포트 번호는 비밀이 아니다(세션·토큰류는 절대 넣지 마라 — 462~463행 규율).
3. **`appDataSnapshot` 확장**: 기존 `{ available, exists, config }`에 최상위 엔트리 이름 목록(정렬, **비재귀**)을 추가한다. 비교 로직(633~636행)도 그 필드를 포함하도록 넓힌다. 기존 키는 제거·개명하지 않는다.
4. **임시 디렉토리 정리 함수 추출 + SIGINT 핸들러**:
   - 현재 `main()` 645~655행의 정리 블록을 함수로 뽑아 정상 종료와 SIGINT가 **같은 함수**를 쓰게 한다(중복 구현 금지). 중복 실행 가드(한 번만 수행)를 둔다.
   - `process.on('SIGINT', ...)`: `--keep`가 아니면 정리하고, 남은 경로가 있으면 출력한 뒤 `process.exit(130)`.
   - **자식 프로세스 킬을 핸들러에 넣지 마라**(decisions (11)) — 콘솔 Ctrl+C는 프로세스 그룹에 함께 전달되고, 전역 자식 레지스트리를 새로 만들면 시나리오 루프의 자식 소유와 이중 소유가 된다.
   - Windows에서는 프로그램적 SIGINT 전달이 TerminateProcess로 동작해 **자동 판정이 불가능하다**. 이 경로는 "미검증(콘솔 Ctrl+C 실기 필요)"으로 요약에 남긴다(phase 63의 미검증 기록 관행).
5. 시나리오 흐름·단언·판정(3분법 exit 0/1/2)·데이터 안전 4종 비교의 **의미는 한 글자도 바꾸지 않는다**.

## Acceptance Criteria

```bash
# [1] data snapshot 저장(실행 전)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" save

npm test
npm run lint

# [2] 임시 폴더 개수 기준선(verify-exe-* 접두)
node -e "const fs=require('fs'),os=require('os');console.log('BEFORE verify-exe tmp =',fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('verify-exe-')).length)"

# [3] 성공 경로 — 한글 exe 경로가 필요하므로 ASCII 경로의 node 러너로 돈다(아래 러너 코드 참조). exit 0 이어야 한다
node <scratchpad>/run-verify-server.mjs

# [4] 성공 후 개수 — [2]와 같아야 한다(누수 0)
node -e "const fs=require('fs'),os=require('os');console.log('AFTER-SUCCESS verify-exe tmp =',fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('verify-exe-')).length)"

# [5] 실패 경로 — node.exe를 서버 exe로 속여 기동 실패를 만든다. exit 1 + stderr에 보존된 두 경로가 찍혀야 한다
node scripts/verify-server-exe.mjs --exe "$(node -e 'process.stdout.write(process.execPath)')"; echo "exit=$? (must be 1)"

# [6] 실패 후 개수 — [4]보다 정확히 2 늘어야 한다(보존 실증). 확인 후 그 두 폴더는 손으로 지워도 된다
node -e "const fs=require('fs'),os=require('os');console.log('AFTER-FAILURE verify-exe tmp =',fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('verify-exe-')).length)"

# [7] 통합 스모크 loopback 1회 — exit 0 + notes에 ports 줄(서버 20000~34999 / cdp 35000~44999)
npm run verify:integration -- --scenario loopback

# [8] 통합 스모크의 임시 폴더 누수 0 (verify-integ-* 접두)
node -e "const fs=require('fs'),os=require('os');console.log('verify-integ tmp =',fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('verify-integ-')).length)"

# [9] data snapshot 비교(exit 1 = 실데이터를 건드렸다)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" compare

# [10] diff scope
git status --porcelain
```

`[3]`의 러너(스크래치패드에 만들고 **리포에 커밋하지 않는다**):

```js
// run-verify-server.mjs — 한글 exe 경로를 Bash 인라인으로 넘기지 않기 위한 ASCII 러너
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const exe = ['dist/기사작성기-server/기사작성기-server.exe', 'dist/기사작성기-server/article-server.exe']
  .find((p) => fs.existsSync(p));
if (!exe) { console.error('server exe not found - run: npm run dist:server'); process.exit(1); }
const r = spawnSync(process.execPath, ['scripts/verify-server-exe.mjs', '--exe', exe, '--spa', 'web/dist'],
  { cwd: 'D:/agents/harness', stdio: 'inherit' });
process.exit(r.status ?? 1);
```

## 검증 절차

1. AC를 순서대로 실행한다. `[4]`가 `[2]`와 같고 `[6]`이 `[4]`+2인지 **숫자로** 확인한다(성공=정리, 실패=보존).
2. `[5]`의 stderr에 찍힌 두 경로가 실제로 존재하는지 확인한다(존재하지 않으면 "보존" 문구가 거짓이다). 확인 후 그 두 폴더는 지워도 된다.
3. `[7]` 출력에서 (i) `ports server=… cdp=…` 줄의 두 값이 각각 20000~34999 / 35000~44999인지, (ii) `data-safety ok(무변 4종)`인지, (iii) exit 0인지 확인한다.
4. **변이 검증 3종**(각각 확인 후 원복): (a) 성공 경로 정리 호출 제거 → `[4]`가 `[2]`+2가 된다, (b) 실패 경로에서도 정리하게 → `[6]`이 `[4]`와 같아진다(보존 계약 위반), (c) CDP 범위를 서버 범위와 겹치게 되돌림 → `[7]`의 ports 줄이 겹치는 범위를 출력한다.
5. `appDataSnapshot` 확장 확인: `[7]` 실행 중 실사용자 프로필이 바뀌지 않았으므로 `data-safety`가 ok여야 한다. 확장이 실제로 동작하는지는 임시로 `%APPDATA%\기사작성기`에 더미 파일을 만들고 재실행해 **FAIL이 뜨는지**로 1회 확인한 뒤, 더미 파일을 반드시 지운다(사용자 프로필이므로 다른 파일은 절대 건드리지 마라).
6. SIGINT 경로는 자동 판정 불가다 — "미검증(콘솔 Ctrl+C 실기 필요), 정리 함수 자체는 정상 경로 `[8]`이 실증"이라고 요약에 명시한다. 억지로 프로그램적 SIGINT를 만들어 자식 프로세스를 고아로 남기지 마라.
7. `git status --porcelain` 증분이 소유 파일(`scripts/verify-server-exe.mjs`·`scripts/verify-integration.mjs`·`phases/64-exe-backlog/index.json`)뿐인지 확인한다.
8. 아키텍처 체크리스트: dependencies·devDependencies 불변 · `web/**`·`src/**`·`server/**`·`client/**`·`docs/**`·`packaging/**` 무수정 · 두 파일의 `parseArgs`(step0 소유)·`scripts/sea-build.mjs`·`scripts/dist-server.mjs`(step1 소유) 무수정 · DB 무접촉(`[1]`/`[9]`).
9. `phases/64-exe-backlog/index.json`의 step2 status를 갱신한다.

## 금지사항

- 두 파일의 `parseArgs`를 고치지 마라(step0 소유). 이유: 같은 파일이라도 함수 경계를 지켜야 실패 원인이 분리된다.
- `verify-server-exe.mjs`가 자기 mkdtemp 경로 **밖**의 무엇도 지우게 하지 마라(특히 `--portable`의 `<exeDir>/data`). 이유: 그 모드는 배포 폴더 사본에 대고 도는 검증이고, 삭제 로직이 배포물을 지우는 사고는 되돌릴 수 없다.
- 실패 경로에서 임시 폴더를 지우지 마라. 이유: 실패 조사에 필요한 유일한 증거(시드 DB·서버가 쓴 행)를 없앤다.
- SIGINT 핸들러에서 자식 프로세스를 추적·킬하지 마라. 이유: 콘솔 Ctrl+C는 이미 프로세스 그룹에 전달되고, 전역 레지스트리를 새로 만들면 시나리오 루프와 이중 소유가 되어 정상 경로의 종료 순서까지 흔든다.
- 시나리오 단언·3분법 종료 코드(0/1/2)·데이터 안전 4종 비교의 의미를 바꾸지 마라. 이유: phase 63이 확정한 판정 계약이며, 여기서 흔들면 통합 검증 결과의 해석이 통째로 달라진다.
- 포트 범위를 49152 이상으로 올리지 마라. 이유: Windows 동적 포트 기본 범위(49152~65535)와 겹쳐 OS 임시 할당과 새 경합면이 생긴다(decisions (9)).
- notes·출력에 세션ID·쿠키·토큰류를 추가하지 마라(포트·경로는 무방). 이유: 스모크 로그가 평문 자격증명 유출 표면이 된다(현행 462~463행 규율).
- 한글 경로·인자를 Bash 인라인으로 넘기지 마라. 이유: 이 환경에서 깨진다 — ASCII 경로의 node 러너를 쓰고, 러너는 리포에 커밋하지 않는다.
