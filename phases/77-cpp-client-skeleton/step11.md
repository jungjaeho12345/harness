# Step 11: integration-verify

로드맵 **AC ①②를 실기로 자동 판정**한다 — Qt 클라이언트를 **실 Spring 서버에 붙여** ① 로그인→목록 SSE 실시간 갱신을 확인하고 ② diag 이벤트를 자동 검증한다. **기존 verify 스크립트 계약을 재사용**한다(CDP는 없다 — Qt는 Chromium이 아니다 · 판정은 diag JSONL + 서버측 SSE 반영).

## 읽어야 할 파일
- `scripts/verify-integration.mjs` (정본 — `--server exe|spring` seam · 임시 DATA_DIR/userData 시드 · 로그인→목록 SSE→송고→행 소멸 시나리오 · before/after 스냅샷 무변 단언 · `scripts/lib/integrationMode.mjs`)
- `scripts/verify-client.mjs` (diag JSONL 계약 단언 러너 — 시나리오 A/B의 이벤트·필드 정본 · `CLIENT_DIAG_FILE` 주입 · 임시 DATA_DIR/userData 규율 · `ELECTRON_RUN_AS_NODE` 함정)
- `client/diag.js` (금지키 7종 · redaction — Qt Diag(step5)가 미러링한 계약)
- `docs/cutover-p4.md` §5(step5 — 유지/재매핑 diag 이벤트 목록 — 이 step이 소비한다) · §0(step0 툴체인)
- `phases/77-cpp-client-skeleton/index.json` decisions (6) · open_questions (3) · `client-qt/` 전체(step3~10 산출)
- `docs/ADR.md` ADR-017(Spring 동일 출처 SPA 서빙 · 같은 host:port) · ADR-013(Spring 기동 — `java -jar server-spring/target/*.jar` · `app.data-dir` 필수)

## 작업
1. **diag 자동 검증 경로 확정**(open_questions (3) — 착수 전 호출자 결정 필수). 두 옵션은 성격이 다르다:
   - **(가) `verify-integration.mjs`에 `--client electron|qt` 확장** — 주의: `--server exe|spring` seam은 판정 메커니즘(CDP)을 **보존한 채 서버 자식 생성 자리만** 바꾸지만, `--client qt`는 그렇지 않다. **Qt는 Chromium이 아니라 CDP(`/json/list`)가 없다** — 따라서 `--client qt`는 자식 생성 seam 교체가 아니라 **판정 경로 자체를 포크**해야 한다(CDP DOM 단언 → diag JSONL + 서버측 SSE 상태 단언). 기존 시나리오 코드의 상당 부분(렌더러 fetch·DOM 판정)이 Qt 경로에서 재사용되지 않는다.
   - **(나) `scripts/verify-client-qt.mjs` 신설** — Qt 전용 판정을 처음부터 diag JSONL + 서버측 상태로 짠다. (가)가 기존 파일에 두 판정 경로를 분기로 얹는 것보다 **오히려 깔끔할 수 있다**(판정 메커니즘이 근본적으로 다르므로).
   - 어느 쪽이든 **diag JSONL 계약(step5 유지 이벤트 이름·금지키 7종)** 을 재사용한다. 이 scripts/** 변경은 계약(contract/**·docs/api-contract/**)이 아니라 **검증 하네스**이므로 excluded (d)에 걸리지 않는다. **호출자가 (가)/(나) 중 무엇인지 정하기 전에는 이 step을 착수하지 마라** — 판정 경로 설계가 통째로 갈린다.
2. **시나리오**(오프스크린/헤드리스 가능한 범위):
   - Spring 서버를 임시 DATA_DIR로 기동(`--server spring` 경로 재사용 · MySQL/SQLite는 step0 실측 구성 따름).
   - Qt 클라 기동(임시 userData · `CLIENT_DIAG_FILE` 주입) → **로그인**(desk 세션) → **목록** 진입.
   - 서버측에서 기사 상태를 바꿔(예: Z/Node fetch로 새 기사 생성·송고) **SSE 무효화 → 목록 재조회로 행 등장/소멸**이 diag/화면 상태에 반영되는지 판정(AC ①).
   - diag JSONL에서 셸 계열 이벤트(app-ready·config-loaded·app-window·probe·window-open 등 step5 유지 목록)와 **금지키 0건**을 자동 단언(AC ②).
3. **데이터 안전**: 리포 `news.db`·`uploads/`·실사용자 %APPDATA%\기사작성기·dist/*/data에 절대 바인딩하지 않고, 종료 후 before/after 스냅샷 무변을 단언한다(verify-integration·verify-client 규율 승계).
4. **env 함정**: 자식 env에서 `ELECTRON_RUN_AS_NODE`·`NODE_OPTIONS` 제거, `NODE_ENV=production` 금지(평문 HTTP 세션 죽음). Qt 자식은 `QT_QPA_PLATFORM=offscreen`(헤드리스 판정).
5. diag 유지/재매핑 목록(step5 §5)과 실제 방출 이벤트가 일치하는지 이 step에서 최종 확인 — 어긋나면 step5 목록 또는 Qt Diag를 맞춘다(계약 재사용의 마지막 잠금).

## Acceptance Criteria
```
# Spring jar 준비(step0 실측 JDK로):
cd server-spring && ./mvnw -B -q package -DskipTests
# 통합 실기 — 호출자가 정한 옵션 하나로 실행(open_questions (3)):
#  (가) verify-integration.mjs에 Qt 판정 경로 분기 추가:
node scripts/verify-integration.mjs --server spring --client qt --scenario loopback   # exit 0
#  (나) Qt 전용 러너 신설:
node scripts/verify-client-qt.mjs --server spring                                     # exit 0
cd /home/user/harness && npm test     # 1328 pass(하네스 변경이 기존 JS 테스트 회귀 없음)
cd /home/user/harness && git diff --stat   # scripts/** + client-qt/** + docs 만 · 리포 news.db·uploads 무접촉
```
- 러너가 exit 0이고, 로그인→목록에서 **서버 상태 변경이 SSE 재조회로 목록에 반영**됨을 자동 판정한다(AC ①).
- diag JSONL에서 셸 계열 유지 이벤트가 관측되고 **금지키 7종 0건**이 자동 단언된다(AC ②).
- 종료 후 리포 `news.db`(md5 불변)·`uploads/`·실사용자 %APPDATA%가 before/after 무변이다.

## 검증 절차
1. 러너를 2회 돌려 exit 0·판정 동일(flake 0)을 확인한다(flake면 재실행 2회 연속 green 규약).
2. diag JSONL 전문을 스캔해 세션토큰·비밀번호·기사 본문·32-hex가 0건인지 확인(유출 표면 봉인).
3. before/after 스냅샷 diff로 실 데이터 무접촉을 확인한다.

## 금지사항
- 계약(contract/**·docs/api-contract/**·계약 러너)을 이 검증을 통과시키려 바꾸지 마라. 이유: 서버 계약은 동결(§2)이다 — 이 step은 검증 하네스만 만진다.
- CDP로 Qt 창을 붙으려 하지 마라. 이유: Qt는 Chromium이 아니라 `/json/list`가 없다 — 판정은 diag JSONL + 서버측 SSE 반영이다(open_questions (3)).
- 리포 `news.db`·실사용자 %APPDATA%에 바인딩하지 마라. 이유: 실 데이터 오염·삭제 위험(DB 비파괴 · verify 규율).
- `NODE_ENV=production`을 켜지 마라. 이유: 세션 쿠키 Secure가 켜져 평문 HTTP 세션이 조용히 죽는다(ARCHITECTURE 운영 환경변수 주의).
