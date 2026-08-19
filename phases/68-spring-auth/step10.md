# Step 10: parity-closeout

phase를 마감한다. 코드 신규 기능은 없다. 하는 일은 **전 프로파일 통합 실행 · 자기 결정성 · Node 대비 패리티 diff 0 · 문서화 · 정직한 공백 기록**이다.

## 읽어야 할 파일

- `phases/68-spring-auth/index.json` — scope · decisions 전부 · excluded · open_questions · forward_notes(이 step이 갱신한다)
- `phases/68-spring-auth/step0.md`~`step9.md` — 각 step의 금지사항·검증 절차(마감 점검표의 입력)
- `docs/api-contract/README.md` — "68+ (Spring 대상) 사용법" 3단계 · "동결 완료 범위" 표 형식(요약 수치 표기의 본보기) · "미검증·미동결 목록"(**이 phase가 새로 추가할 공백을 같은 형식으로 forward_notes에 적는다** — 이 파일 자체는 고치지 않는다)
- `docs/ADR.md` — ADR-001~012의 형식(결정/이유/트레이드오프 3단락)과 ADR-012(가장 최근 항목)
- `docs/ARCHITECTURE.md` — "디렉토리 구조"·"패턴"·"보안 경계" 절
- `docs/porting-plan-cpp-spring.md` §7 P1 완료 게이트 문구 · §4 불변식 8종
- `server-spring/README.md`(step0·step1이 쓴 것)

## 작업

### A. 통합 실행 (마감 실측)

```bash
cd /d/agents/harness
node scripts/spring-contract.mjs
node scripts/spring-contract.mjs --dual-run
node scripts/spring-contract.mjs --parity
```

- 1번: scope 표 전 프로파일(`default`·`auth-negative`·`prod-cookie`) 계약 green.
- 2번: **자기 결정성**. 하네스가 프로파일마다 **독립된 임시 DATA_DIR + 새 Spring 프로세스로 두 패스**를 돌려 리포트 2개를 비교한다. **"같은 인스턴스에 2회"는 상태를 갖는 대상에서 성립하지 않는다** — 로그인 IP 레이트리밋(15분/10회)·계정 잠금 카운터·세션 스토어가 패스 1의 상태를 그대로 들고 있기 때문에 `default`(패스당 6회 → 12회)와 `auth-negative`(패스 1이 11회 소진)는 확정 red가 된다. 러너의 `--dual-run`을 쓰지 않는 이유가 이것이며(그리고 러너 118행이 `--out` 병용을 거부한다), 이 사실을 마감 요약에도 한 줄 남긴다.
- 3번: Node 대비 **패리티 diff 0**(같은 파티션으로 뽑은 Node 리포트와 프로파일 쌍 비교).

세 커맨드의 **출력 수치를 그대로** index.json 요약에 옮긴다(프로파일 수·케이스 수·관측 수·diff 수·리포트 경로). 수치를 기억이나 추정으로 적지 마라.

### B. 문서

1. `docs/ADR.md`에 **ADR-013**을 추가한다(형식은 기존 항목과 동일: 결정/이유/트레이드오프). 담을 결정: Spring 서버는 `server-spring/` 독립 Maven 모듈이고 **`spring-boot-starter-security`·Spring Session을 쓰지 않는다**(계약이 동결한 세션 토큰·쿠키·에러 shape과 충돌) · DB 접근은 **직접 SQL 유지**이고 **Spring은 DDL을 실행하지 않는다**(스키마 소유자는 P2까지 Node) · 인증/CSRF/CORS/레이트리밋은 자체 서블릿 필터 체인이며 순서가 계약의 일부다 · 패리티 판정은 계약 스위트의 리포트 diff가 한다. 트레이드오프에는 프레임워크 기본값을 포기한 대가(직접 구현한 와이어 포맷·필터 순서를 계속 지켜야 한다)와 **helmet 등가 헤더·HTTPS 강제가 아직 없다**는 공백을 적는다.
2. `docs/ARCHITECTURE.md` "디렉토리 구조"에 `server-spring/` 항목을 추가한다(한두 줄 — 무엇이고 어떤 계층 구조인지). "패턴" 절에 Node/Spring 두 서버가 같은 계약을 구현하며 패리티는 계약 스위트가 판정한다는 한 줄을 넣는다.
3. `server-spring/README.md` 마감: 빌드·테스트·실행·계약 검증 커맨드, 설정 키 ↔ 환경변수 표, **이 서버가 구현한 라우트 목록과 아직 구현하지 않은 라우트의 동작**(미인증 401 / 인증 시 404 — decisions (8)), DB 비파괴 규칙(DDL 0·삭제 0·`app.data-dir` 필수).

### C. `phases/68-spring-auth/index.json` 마감

- 전 step의 status·summary 확정.
- `forward_notes` 갱신: (1)~(8) 항목을 **이번 실행 실측으로** 수정·보강하고, 최소한 다음을 포함한다 — 다음 도메인 묶음 착수 방법(scope 표에 행 추가) · 이 phase가 남긴 미검증 축(아래 D) · 결함 후보 #1·#2를 재현만 했다는 사실과 수정 시점 판단 · 보안 헤더/HTTPS 공백 · 포트 구간 잠금 테스트 후보.
- open_questions의 (a)(b)(e)(f)에 대해 **실제로 무엇을 택했는지** 결과를 적는다(미판정으로 남기지 마라).

### D. 정직한 공백 기록 (필수)

이 phase가 **검증하지 않은 것**을 목록으로 만든다. 최소한:

- 세션 1시간 슬라이딩 만료의 **실서버 시간축**(Java 단위 테스트는 고정 시계로 덮었지만 계약 스위트는 시계를 주입할 수 없다).
- 로그인 `inactive` 403 경로(계약 스위트가 시드 계정을 비활성화하지 않아 도달 불가 — `docs/api-contract/README.md` 미동결 목록 승계).
- 레이트리밋 15분 창 **리셋** 타이밍(초과 관측까지만 동결).
- 다이제스트 24h 창 경계의 실서버 검증(단위 테스트만 있다).
- 동시성: SQLite 커넥션 1 정책 아래에서의 실부하(계약 스위트는 직렬 실행이다).
- 두 서버가 **같은 news.db를 동시에** 여는 상황(P3 전환기) — 이 phase는 프로파일마다 DB를 분리했으므로 전혀 검증되지 않았다.

### E. 범위 정합 점검

`git diff --stat`(브랜치 분기점 대비)로 변경 파일 목록을 뽑아 **계획이 소유한 파일과 정확히 일치**하는지 확인한다. 다음 경로에 변경이 있으면 **회귀이며 되돌린다**: `server/**` · `src/**` · `web/**` · `client/**` · `test/**` · `contract/**` · `docs/api-contract/**` · `docs/news.md` · `spikes/**` · `packaging/**` · `.claude/**` · `phases/49-*` · `phases/50-*` · 리포 `news.db`.

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && node scripts/spring-contract.mjs
cd /d/agents/harness && node scripts/spring-contract.mjs --dual-run
cd /d/agents/harness && node scripts/spring-contract.mjs --parity
cd /d/agents/harness && npm test
cd /d/agents/harness && npm run lint
cd /d/agents/harness && npm run build
cd /d/agents/harness && npm run test:web
cd /d/agents/harness && node scripts/contract-inventory-check.mjs --require-spec-paths
cd /d/agents/harness && npm run test:contract -- --require-full-coverage
cd /d/agents/harness && git status --porcelain
```

- `npm test`는 **1328/1328**(기준선 무변). 늘거나 줄면 회귀다.
- 4번째(`--dual-run`)는 **하네스가 소유하는 자기 결정성 판정**이다(프로파일마다 새 DATA_DIR + 새 Spring 프로세스 2회). 러너의 `--dual-run`이 아니다 — 작업 A의 해설 참조.
- 마지막에서 두 번째 커맨드는 **Node 대상** 계약 전건 실행이다 — 이 phase가 Node 서버·계약 스위트를 건드리지 않았다는 최종 증거이며 covered 39/39 · exit 0이어야 한다.
- `npm run build`·`npm run test:web`는 프론트엔드 무영향 확인(이 phase는 web을 건드리지 않는다).

## 검증 절차

1. AC를 위에서부터 **끊김 없이** 실행하고 각 커맨드의 요약 줄을 기록한다.
2. **flake 규약**: 실패가 나오면 재실행 2회 연속 green일 때만 flake로 판정하고, 그 사실과 관측을 요약에 남긴다(1회 green으로 넘기지 마라).
3. `--parity`가 red면 **Spring을 고친다**(계약·러너·케이스를 고치지 않는다). 계약 자체가 틀렸다고 판단되면 고치지 말고 forward_notes에 근거를 남긴다.
4. 데이터 안전 최종 확인: 리포 `news.db`·`uploads/`의 크기·mtime이 phase 시작 시점과 동일한지(수치를 요약에 적는다). OS 임시 디렉토리에 `spring-contract-*`·`contract-*` 잔존 0.
5. 누출 최종 스캔: 리포트·로그·요약 어디에도 64-hex 세션 토큰·`SAMPLE_USERS` 비밀번호·쿠키 값·절대 경로 비밀이 없는지 확인한다.
6. E(범위 정합)를 수행하고 결과를 요약에 적는다.
7. 커밋은 **명시 경로만** `git add`한다(`-A` 금지 — 작업 트리에 사용자 소유 미커밋 파일이 있다). 커밋 메시지는 conventional commits. **PR 생성·머지는 이 step의 범위가 아니다**(오케스트레이터가 사용자 승인 아래 수행한다).
8. index.json step10 status·summary 갱신 + phase 전체 마감 요약(수치 표 형태 권장: 프로파일·케이스·관측·diff·npm test·lint·build).

## 금지사항

- 실측하지 않은 수치를 요약에 쓰지 마라. 이유: 이 요약이 phase 69+의 기준선이 된다 — 추정치가 들어가면 다음 phase의 회귀 판정이 통째로 틀어진다(phase 67에서도 계수 오차 1건이 실제로 발생했다).
- `--parity` red를 계약·케이스·러너 수정으로 넘기지 마라. 이유: 그 순간 패리티 판정이 거짓 green이 되고 이 phase의 산출물 전체가 무의미해진다(decisions (17)).
- `npm test`에 Java 빌드나 계약 스위트를 편입하지 마라. 이유: decisions (2)·excluded (j) — 서버 기동·JDK 의존이 기본 테스트 경로에 들어가면 전 개발 흐름이 툴체인에 묶인다.
- `docs/api-contract/**`·`contract/**`·`docs/news.md`를 고치지 마라. 이유: 계약은 정본이고 news.md는 무접촉 목록이다.
- 미검증 항목을 "검증됐다"고 적거나 생략하지 마라. 이유: 이 하네스의 게이트 문화는 "미검증의 정직한 기록"이며, 생략된 공백은 다음 phase가 안전하다고 **가정**하는 순간 사고가 된다.
- `git add -A`·`git restore`·`git checkout --`·`git stash`·`git clean`을 쓰지 마라. 이유: 사용자 소유 미커밋 파일이 작업 트리에 있다(index.json baseline).
- PR을 열거나 머지하지 마라. 이유: 공유 브랜치로의 머지는 사용자 명시 승인이 필요하다.
