# Step 12: closeout

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` **전문**(마감 시점의 사실을 여기에 되돌려 적는다)
- `phases/77-qt-client-skeleton/step0.md`~`step11.md`와 **각 step이 남긴 요약**(수치·변이 결과표·미검증 항목)
- `docs/ADR.md` **ADR-018**(step1) — 마감 실측 1문장을 **순수 추가**할 자리
- `docs/porting-plan-cpp-spring.md` §7(P4 행 · P5 행) · §5(에디터 리스크 — P5 인계 대상)
- **선례(형식 본보기)**: `phases/76-spring-cutover/index.json`의 `forward_notes` · `phases/74-spring-sse/index.json`의 `forward_notes`
- `packaging/체크리스트-육안확인.md`·`packaging/체크리스트-육안확인-P3.md` — 육안 항목의 형식(P4는 **항목 1~2개**만 남긴다)

## 배경

이 step은 **다음 사람이 P5를 시작할 수 있게 만드는 것**이 전부다. 이 리포의 규율은 셋이다: **마감 실측은 연속 2회** · **미검증은 정직하게 기록** · **인계는 `forward_notes`가 소유**.

## 작업

### A. 마감 실측 (연속 2회 · 두 회차 수치를 모두 적는다)

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario boot  --server exe
node scripts/verify-qt-client.mjs --scenario login --server exe
node scripts/verify-qt-client.mjs --scenario list  --server exe
node scripts/verify-qt-client.mjs --scenario list  --server spring
npm test
npm run lint
npm run build
node scripts/spa-parity.mjs
node scripts/spool-parity.mjs
node scripts/spring-contract.mjs --parity
git status --porcelain
```

- 각 커맨드의 **수치**(테스트 총계·관측 수·판정 항목 수·소요 시간)를 표로 남긴다.
- **자산 지문**: 리포 `news.db` 크기·md5(**무변**이어야 한다) · `uploads/` 파일 수·총 바이트 · `client-qt/release/news-client.exe` 크기.
- 두 회차가 다르면 **flake**이며, 재실행 2회 규약으로 판정하고 그 사실을 적는다(숨기지 마라).
- `server-spring`·`tools/news-migrator`의 `clean verify`를 돌렸다면 값을, 돌리지 않았다면 **「미측정」** 을 적는다.

### B. 문서

1. **`client-qt/README.md` 완성**:
   - 빌드 방법(`cmd /c client-qt\build.bat` · 툴체인 경로 4종 · `subdirs`인지 폴백인지)
   - 디렉토리 규약(`src/shell`·`src/net`·`src/ui`)과 **의존 방향**(View ← Controller ← Model · shell은 순수 판정 우선)
   - **diag 이벤트 처분 표**(승계/재매핑/소멸/신설)와 허용 이름 집합
   - **라우트 표와 계약 대조 방법**(무엇이 기계로 판정되고 무엇이 안 되는가 — `decisions` (4)의 한계 문장을 그대로)
   - **P4가 아닌 것**(에디터·6메뉴·우클릭·관리 화면·인쇄·i18n·패키징)과 그 소유 phase
   - **알려진 divergence**(예: 재시작 시 재로그인 — 웹은 1시간 지속 쿠키) · **미검증 항목**
2. **`docs/ADR.md` ADR-018에 마감 실측 1문장 순수 추가**(73·74·76의 선례 — 결정 본문은 고치지 마라). `git diff -U0`의 삭제 줄 **0**을 확인한다.
3. **육안 체크리스트**: P4에서 자동 판정이 못 보는 항목만 적는다(예: 「목록이 실제로 그려지는가」 · 「SSE 갱신이 눈에 보이는가」 · 한글 표시·폰트). `packaging/**`의 기존 파일을 **고치지 말고** P4용 짧은 목록을 `client-qt/README.md` 안에 두거나 별도 파일로 신설하라(형식은 기존 체크리스트를 본뜬다).

### C. `phases/77-qt-client-skeleton/index.json` 갱신

- `steps`의 상태는 실행 엔진이 기록한다 — **손으로 쓰지 마라**.
- **`forward_notes`를 추가**한다(배열). 최소 항목:
  1. **마감 실측 전문**(A의 표).
  2. **P5(에디터 코어)가 곧바로 쓸 수 있는 것**: 빌드 레시피·테스트 러너 결선 방법·`client-qt/src` 구조·Model 주입 지점·diag 이벤트 추가 방법·자동화 훅 사용법.
  3. **편집 표면 clientId의 결선 지점**(P5가 에디터 표면 수명에 붙일 자리 — `decisions` (3)).
  4. **미검증 항목 전부**: 실기로 부르지 않은 Model 메서드 · 요청 body shape 전수 미검증 · SSE 전송 지연 실측 결과 · **423/429 실기 미재현**(확정 결정 — 같은 인스턴스에서 재현하면 이후 시나리오가 죽는다) · Qt 쿠키 자 SameSite 실측 결과.
  4-1. **P8 이월 1건(반드시 적어라)**: **자동화 훅의 컴파일 타임 분리** — `CLIENT_SELFTEST=1` 가드는 **보안 경계가 아니라 사고 방지 장치**이므로, 프로덕션 빌드에서 훅 코드를 아예 제거하는 것(별도 빌드 구성/매크로)은 배포 형상 결정과 함께 **P8**이 소유한다.
  5. **divergence 목록**(웹/Electron 대비 다른 동작과 그 이유).
  6. **게이트의 한계**(diag는 화면 픽셀을 보지 못한다 — M11-2가 실증한 자리).
  7. **환경 함정**(비ASCII bash · cp949 배치 · VsDevCmd · Qt bin PATH · App Modernization auto-stash).
  8. **다음 phase 후보와 전제**(P5 착수 전 필요한 것 — 예: 실물 MS-IME 육안 확인은 P5 전제다).
- `open_questions` 중 **해소된 것**은 답과 근거를 그 항목에 이어 적는다(76의 `[해소 …]` 형식).

### D. `phases/index.json` 갱신

이 phase 항목의 `note`에 **마감 요약**을 적는다(형식은 73~76 항목 참조). 상태·타임스탬프는 실행 엔진/오케스트레이터가 기록한다.

## Acceptance Criteria

```
node -e "const j=require('./phases/77-qt-client-skeleton/index.json');if(!Array.isArray(j.forward_notes)||j.forward_notes.length<6){console.error('forward_notes missing');process.exit(1)};console.log('ok',j.forward_notes.length)"
node -e "JSON.parse(require('fs').readFileSync('./phases/index.json','utf8'));console.log('phases index ok')"
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
node scripts/verify-qt-client.mjs --scenario list --server spring
npm test
npm run lint
npm run build
git status --porcelain
```
- 전부 exit 0 · A의 2회 실측표가 요약과 `forward_notes`에 있다 · 무접촉 경로 diff 0.

## 검증 절차

1. **A를 연속 2회** 돌리고 두 표를 나란히 남긴다.
2. `docs/ADR.md`의 삭제 줄 0 확인(`git diff -U0`).
3. **README의 주장 전건을 다시 확인**한다 — 특히 「무엇이 기계로 판정되는가」 목록의 각 항목이 실제 테스트/커맨드와 대응하는지. 대응이 없으면 **주장을 지워라**(있는 척하는 게이트가 가장 비싼 부채다).
4. 각 step의 **변이 결과표가 전건 기록됐는지** 확인하고, 빠진 step이 있으면 그 사실을 `forward_notes`에 적는다.

## 되돌림

문서·`index.json` 갱신뿐이므로 되돌림은 해당 커밋 revert로 충분하다.

## 금지사항

- **미검증을 검증된 것처럼 적지 마라.** 이유: 이 리포의 인계는 다음 phase의 유일한 입력이고, 거짓 안심은 하류 전체를 오염시킨다.
- **`steps[].status`·타임스탬프를 손으로 쓰지 마라.** 이유: 실행 엔진이 기록한다 — 손으로 쓰면 실제 실행 이력과 어긋난다.
- **ADR-018 결정 본문을 고치지 마라.** 이유: 결정은 그 시점의 기록이고 소급 수정은 이력을 오염시킨다(추가만 허용).
- **`packaging/**`의 기존 체크리스트를 고치지 마라.** 이유: Electron 배포 자산이고 P8까지 살아 있다.
- **P5 작업을 미리 시작하지 마라.** 이유: 이 phase의 게이트는 P4이고, 에디터는 별도 계획·검토를 거친다.
