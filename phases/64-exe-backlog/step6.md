# Step 6: closeout

## 읽어야 할 파일

- `CLAUDE.md` — 커밋·보고 규칙
- `phases/64-exe-backlog/index.json` — scope 전체, decisions **(16)(17)(18)**, excluded, open_questions(요약에 판정 결과를 남길 대상)
- `phases/64-exe-backlog/step0.md` ~ `step5.md` — 각 step이 무엇을 소유했는지(요약 작성 입력)
- `phases/index.json` — 최상위 phase 목록(마지막 항목 형식 확인)
- `phases/58-backlog-perf/index.json` — 소규모 정리 phase의 마감 기록(step별 summary) 형식 전례

## 배경

step0~5는 각각 자기 파일만 검증했다. 이 step은 **합쳐진 상태**를 한 번에 재실증하고 phase를 닫는다. 특히 다음 세 가지는 여러 step의 변경이 동시에 얹힌 뒤에야 의미가 있다.

- `npm run dist:server` — step1(가드 기준축·폴백 경고)과 step5(부트 DB 연결)의 산출물이 함께 들어간 exe.
- `npm run dist:client` — step3(권한 정책 모듈)이 들어간 배포 폴더.
- `npm run verify:integration` — step2(포트 범위·스냅샷)와 위 두 산출물의 전 루프 실기 검증.

실행 코드 변경은 이 step에 없다(문제가 발견되면 고치는 것은 그 파일을 소유한 step의 몫이다 — 아래 금지사항).

## 작업

1. **전체 게이트 재실행**(AC) — 백엔드·웹·lint·build.
2. **배포 산출물 재조립 + 실기 재실증** — `dist:server` → `verify-server-exe`(full) → `dist:client` → `verify:integration --scenario all`.
3. **진행 기록 마감** — `phases/64-exe-backlog/index.json`의 각 step에 `summary`를 채우고 status를 `completed`로 만든다(구현 세션이 이미 채웠다면 사실 확인만 한다). 요약에는 각 항목의 **실측 수치**(테스트 증가분·빌드 소요·검증 소요·미검증 항목)를 남긴다.
4. **`phases/index.json` 갱신** — `64-exe-backlog` 항목의 status를 `completed`로 바꾸고 `completed_at`과 `note`(스코프 + 실측 결과 + 이월/미검증)를 기록한다.
5. **이월·미검증 목록 정리** — 이 phase가 남기는 것을 명시한다: (a) SIGINT 정리 경로 = 콘솔 Ctrl+C 실기 미검증(자동 판정 불가), (b) `--show` 없는 비표시 모드의 팝업 크기·클립보드 왕복 미검증(phase 63 §5 계약 유지), (c) excluded 5건(302 origin 승격·서버 HTTPS 종단·CompanyName 문자열·querySnapshotsByArticle 정리·육안 체크리스트 문서화)은 그대로 이월.
6. 커밋 후 오케스트레이터에 결과를 넘긴다(Slack 보고는 오케스트레이터 몫이다 — 이 step이 직접 하지 않는다).

## Acceptance Criteria

```bash
# [1] data snapshot 저장(모든 빌드·검증 전에)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" save

# [2] 전체 게이트 — 4종 전부 clean
npm test
npm run test:web
npm run lint
npm run build

# [3] 서버 배포 재조립 + 실기 검증(한글 exe 경로는 ASCII 러너로 — step2의 run-verify-server.mjs 재사용)
npm run dist:server
node <scratchpad>/run-verify-server.mjs

# [4] 클라이언트 배포 재조립
npm run dist:client

# [5] 통합 실기 스모크 — loopback + lan 전 루프. exit 0(정상) / exit 2(방화벽 환경 차단 — 제품 결함 아님)
npm run verify:integration -- --scenario all

# [6] 임시 폴더 누수 0 확인(step1·step2 항목의 최종 확인)
node -e "const fs=require('fs'),os=require('os');const l=fs.readdirSync(os.tmpdir());console.log('verify-exe='+l.filter(n=>n.startsWith('verify-exe-')).length,'verify-integ='+l.filter(n=>n.startsWith('verify-integ-')).length)"

# [7] data snapshot 비교(exit 1 = 실데이터를 건드렸다)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" compare

# [8] diff scope — 이 step의 증분은 phases/** 뿐이어야 한다
git status --porcelain
```

`npm run test:web`은 web/** 무수정이므로 **2368/2368(90 files)** 이 그대로 나와야 한다. 비고정 실패가 1건 뜨면 최대 2회 재실행 + 단독 실행으로 판정한다(기지 flake 규약).

`[5]`가 exit 2(BLOCKED)로 끝나면 제품 실패가 아니다 — 출력의 `netsh` 안내를 그대로 요약에 옮기고, 방화벽 허용 후 재실행이 가능하면 재실행 결과를 기록한다. LAN 인터페이스가 없어 skip이면 그 사실을 적는다.

## 검증 절차

1. AC를 순서대로 전부 실행한다. `[2]`의 4종은 **2회 연속 동일 결과**여야 한다(간헐 실패 배제).
2. 최종 수치를 요약에 남긴다: 백엔드 테스트 수(기준선 1242 → 최종 N, 증가분의 출처를 step별로 명시) · 웹 2368 · lint·build clean · `dist:server` 산출물(mode·exe 크기·소요) · `dist:client` 산출물(파일 수·바이트·소요) · `verify:integration` 시나리오별 상태와 소요.
3. `[3]`의 verify-server-exe 출력에서 (i) `verify-ok`, (ii) 임시 폴더 정리가 일어났는지(`[6]`의 `verify-exe=` 값이 실행 전과 같은지)를 확인한다.
4. `[5]`의 출력에서 (i) `ports server=… cdp=…` 두 값이 겹치지 않는 범위인지, (ii) `data-safety ok(무변 4종)`인지, (iii) `unverified` 항목이 phase 63과 같은 것들뿐인지(새로 늘지 않았는지) 확인한다.
5. **12개 채택 항목의 최종 점검표**를 요약에 만든다: A-1~A-8·B-1~B-2·C-1~C-2 각각에 대해 "적용됨 / 검증 커맨드 / 미검증이면 그 사유"를 한 줄씩. 적용됐다고 적을 근거가 없는 항목은 미적용으로 적어라(추정 금지).
6. `git status --porcelain` 증분이 `phases/64-exe-backlog/index.json`·`phases/index.json`뿐인지 확인한다(step0~5가 각자 커밋을 끝냈다는 전제). 커밋되지 않은 소스 변경이 남아 있으면 그 step으로 돌려보내라.
7. 사용자 미커밋 파일(`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`)이 시작 시점 상태 그대로인지 확인한다.
8. 커밋 메시지는 conventional commits(`docs(64-exe-backlog): phase 마감 …`).

## 금지사항

- 이 step에서 실행 코드(`src/**`·`server/**`·`client/**`·`scripts/**`)를 고치지 마라. 이유: 소유 경계가 무너지면 어느 step이 무엇을 깨뜨렸는지 추적할 수 없다 — 문제가 나오면 그 파일을 소유한 step으로 되돌려 고친다.
- 실패한 AC를 "환경 탓"으로 통과 처리하지 마라(단, `[5]`의 exit 2는 스크립트가 정의한 **환경 차단** 판정이므로 그대로 기록한다). 이유: 이 phase의 산출물은 배포물이며, 통과 판정이 곧 배포 가능 판정이다.
- 기준선 수치를 추정으로 적지 마라. 이유: 다음 phase가 이 숫자를 기준선으로 삼는다 — 틀린 기준선은 하류 전체를 오염시킨다.
- `phases/index.json`의 기존 항목(0~63)을 수정·재정렬하지 마라. 이유: 완료된 phase의 기록은 감사 원장이다.
- `docs/**`를 고치지 마라. 이유: 이 phase는 ADR·아키텍처 결정을 바꾸지 않는다(문서 변경 불요 — 필요하다고 판단되면 별도 phase의 명시적 결정으로 한다).
- `dist/**`를 커밋하지 마라. 이유: `.gitignore`가 막고 있고 수백 MB 바이너리는 저장소를 파괴한다.
- Slack 보고를 이 step에서 직접 하지 마라. 이유: 보고 창구는 오케스트레이터 한 곳이다(중복 보고는 진행 상황을 왜곡한다).
