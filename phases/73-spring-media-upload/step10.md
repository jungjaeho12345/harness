# Step 10: parity-closeout

## 읽어야 할 파일

- `phases/73-spring-media-upload/index.json` — **전문**(특히 baseline의 기준 수치 · decisions (6)의 완화책 · (22)의 계약 밖 축 목록 · open_questions 전건).
- `phases/72-spring-distribution/index.json` — `forward_notes` **(1)**(마감 실측 전문의 형식) · **(6)(7)**(예외 목록 비공허성 재확인 절차) · **(8)**(미검증 정직 기록의 형식) · (9)(누적 이월) · (13)(진단 위생 — surefire 로그에 세션 토큰이 실린다).
- `server-spring/README.md` **전문**(라우트 표 · 미구현 목록 · 프로파일 수치 · divergence 절).
- `docs/ADR.md` **ADR-013 ④**(phase마다 실측 1문장이 누적된 자리).
- `phases/index.json`(top-level — 이 phase 항목의 `status`·`note` 갱신).
- step0~step9의 모든 산출물과 각 step 요약(구간 실측 수치).

## 배경 (동결된 사실)

- 기준선(계획 시점 실측): Java **1031** · `--parity` **265관측**(198/55/4/5/3) · `npm test` **1328** · 구현 라우트 **32/39** · 리포 `uploads/` **32항목 6,068,792 B**.
- 목표(step9 이후): `--parity` **296관측**(default **229** · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3) · 구현 라우트 **37/39** · 미구현 **2**(SSE만).
- `--require-full-coverage`는 **Spring 대상에서는 아직 켜지 않는다**(SSE 2 라우트가 남아 영구 red다). Node 대상에서만 켠다.
- Spring 대상 `covered`는 **프로파일별**이다 — default 단독은 24/39 → **29/39**가 정상이다(37/39가 아니다).
- **surefire 로그에는 임시 인스턴스의 64-hex 세션 토큰이 실릴 수 있다**(72 forward_notes (13)). 계약 리포트는 마스킹돼 있지만 surefire 로그는 아니다 — 공유 전에 훑어라.

## 작업

### A. 마감 실측 — 아래 9커맨드를 **연속 2회** 돌려 전부 exit 0이고 수치가 **완전히 동일**한지 확인한다(flake 0 확인)

```bash
# 0) jar 갱신(하네스는 스스로 빌드하지 않는다)
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B clean verify
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
# 1) Java 테스트 수치 + jar 바이트(clean 빌드 기준으로 인용하라 — 증분 빌드는 수십~수백 바이트 다르다)
# 2) 계약(무인자)
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs
# 3) 패리티
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
# 4) 자기 결정성
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --dual-run
# 5) Node 축 무회귀
cd d:/agents/harness && npm test
# 6)
cd d:/agents/harness && npm run lint
# 7)
cd d:/agents/harness && npm run build
# 8) 인벤토리
cd d:/agents/harness && node scripts/contract-inventory-check.mjs --require-spec-paths
# 9) Node 대상 전건(정본 무수정의 최종 증거)
cd d:/agents/harness && npm run test:contract -- --require-full-coverage
```

기대: (1) `Tests run: N / Failures: 0 / Errors: 0 / Skipped: 0` (2) `profiles=5` (3) **`296관측 diffs 0`** (4) **`296관측 diffs 0`** + 두 패스가 서로 다른 pid·port·DATA_DIR을 썼다는 로그 증거 (5) `1328 pass / 0 fail` (6)(7) exit 0 (8) `routes=39 spec-paths=39/39` (9) `profiles=5 cases=274 covered=39/39`.

### B. ADR-008 예외 목록의 **비공허성 재확인**(decisions (6) 완화책 ③ — 마감 시점에 다시 한다)

예외가 4파일로 늘었으므로 **군 × 파일**을 교차로 심어라. 각각 red를 확인하고 원복 후 `git diff`가 비어 있음을 확인한다.

| 심는 곳 | 심는 코드 | 기대 |
|---|---|---|
| `HttpApiSourceFetcher.java` | `@org.springframework.scheduling.annotation.Scheduled(fixedDelay=1000) void t(){}` | 주기 실행 군 red |
| `HttpExternalProxyClient.java` | `Files.write(p, b);` | 파일 쓰기 군 red |
| `SpoolWriter.java` | `HttpClient c = HttpClient.newHttpClient();` | 네트워크 군 red |
| `UploadStore.java` | `CompletableFuture.runAsync(() -> {});` | 비동기 군 red |
| `UploadService.java`(비-예외) | `Files.write(p, b);` | 파일 쓰기 군 red |
| `MediaSearchService.java`(비-예외) | `HttpClient c = HttpClient.newHttpClient();` | 네트워크 군 red |

**6/6이 red가 아니면 예외 확대가 방어를 실제로 약화시킨 것이다** — 그 사실을 그대로 보고하고 게이트를 보강하라.

### C. 데이터 안전 단언(수치로)

- 리포 `news.db`: 크기·mtime·md5 무변.
- 리포 `uploads/`: **32항목 / 6,068,792 B 무변**.
- 리포 안에 업로드 산출물(`[0-9a-f]{32}.*`)·`.tmp`·계약 리포트 **0건**.
- `git status --porcelain` 미추적은 `.vscode/` 하나뿐.
- 하네스가 띄운 java 프로세스 잔존 0(남아 있는 java가 있으면 CreationDate로 IDE 언어서버인지 확인).
- OS 임시에 남긴 `spring-contract-*`/`contract-*` 정리(직전 step이 남긴 것은 그대로 둔다).
- **5개 리포트 전문 문자열 검색**: 64-hex 세션 토큰 0 · 시드 비밀번호(`reporter123`·`desk123`·`admin123`) 0 · 수집 토큰 리터럴 0 · **32-hex 업로드 파일명 0** · 드라이브 문자로 시작하는 절대경로 0. **외부 API 키는 여기서 검사하지 않는다 — 하네스가 키를 자식 env에서 지워 계약 env에 존재하지 않으므로 그 검사는 공허하다.** 그 축은 step5·step6·step7의 **센티넬 키 비유출 테스트**가 소유하며, 그 사실을 forward_notes 7⑧에 그대로 기록하라.
- **인벤토리 대조(주장이 아니라 파일로)**: 5개 리포트의 `routeId` 합집합에서 계약 전용 유사 라우트(`x-` 접두)를 빼면 **정확히 37**이고 `IMPLEMENTED_ROUTES` 37행과 일치함을 확인하라 = '구현했는데 계약이 관측하지 않는 라우트 0개'.

### D. 문서 갱신

1. `server-spring/README.md`:
   - 헤더의 구현 범위를 **라우트 37개 · 계약 18파일(default 12) · 5 프로파일 · 296관측 diffs 0 · Java N 테스트 · jar 바이트**로 갱신.
   - 라우트 표에 **5행 추가**(media-search · upload · photos-create · photos-search · articles-translate). 각 행의 '비고'에 이 phase가 동결한 축을 한 줄로: base64 JSON·확장자 14종·5MB·서버 발급 32-hex 이름 / 미인증 정적 서빙(capability URL) / append-only·세션 stamp / 데모 폴백 결정성·`error` 불리언 / **200 + `ok:false` graceful degrade**.
   - '나머지 7 라우트에는 스텁을 만들지 않았다' → **2 라우트(SSE)**로 고치고 `PathPolicyWireTest` 프로브가 이제 `GET /api/stream`을 가리킨다는 사실을 적어라.
   - `/uploads` 정적 마운트 절을 신설: 인벤토리 밖 · 리소스 핸들러(=`@RequestMapping` 인벤토리에 나타나지 않는다) · 세션 없이 200 · `Content-Type: image/png` 실측 · traversal 거부 · **ETag/Cache-Control divergence**.
   - divergence 절에 이 phase가 만든 항목을 추가(아래 E의 목록과 같은 내용).
   - '경로 정규화 divergence가 라우트를 늘릴 때마다 새로 생긴다'는 기존 문장의 수치를 갱신하라.
2. `docs/ADR.md` **ADR-013 ④에 이 phase의 실측 1문장을 추가**한다(**1회만**). 결정 본문과 phase 68·69·70·71a·72 문장은 **무수정**. 포함할 것: 계약 18파일·5 프로파일·**296관측 diffs 0**·`--dual-run` 296관측 diffs 0·Java N 테스트 0 실패·구현 라우트 **37/39**·DDL 0·`DELETE FROM` 0·**ADR-008 정적 게이트 예외가 2 → 4파일로 늘었고 그 근거가 군마다 다르다는 사실**(수집 pull egress(`rcv.md`) / **`ADR-014` 서버 보유 키 프록시** / 배부 스풀 게시 / 업로드 저장)과 마감 시점 6종 교차 변이로 red를 재확인했다는 사실. **`ADR-014` 자체는 step2가 이미 신설했다 — 이 step은 그것을 참조만 하고 다시 쓰지 않는다**(ADR 추가는 phase당 필요한 만큼만이고, 여기서 추가하는 것은 ADR-013 ④의 실측 **1문장**뿐이다).
3. `phases/index.json`의 `73-spring-media-upload` 항목을 `completed`로 바꾸고 72 항목과 **같은 형식**의 `note`를 쓴다.

### E. `forward_notes` 작성 (`phases/73-spring-media-upload/index.json`에 추가)

최소 다음 항목을 **실측 수치와 함께** 담아라.

1. **마감 실측 전문**(9커맨드 × 2회 · 구간별 Java 테스트 수 · jar 바이트 · 프로파일별 관측·cases·covered).
2. **남은 2 라우트와 다음 phase 권장 사항** — SSE 2(`stream`·`logs-stream`). **SSE는 와이어 단일 지점 규율이 처음 진짜로 흔들리는 축**이다(스트림 응답을 `JsonHttp` 한 지점으로 쓸 수 없다). 이 phase가 만든 선례를 반드시 인계하라: **정적 서빙은 리소스 핸들러로 인벤토리 밖에 두어 `HandlerInventoryTest`를 우회하지 않았다** — SSE는 인벤토리 **안**이므로 그 수법을 쓸 수 없고, `RawContentType` seam을 스트림용으로 넓힐지 별도 결정이 필요하다. 그리고 **72 forward_notes (3)의 SSE 신호 발행 지점 3묶음**을 그대로 이어 붙여라(그 phase의 완료 조건에 항목별로 넣을 것).
3. **`PathPolicyWireTest` 프로브의 다음 이동** — 지금은 `GET /api/stream`. SSE phase가 그것을 구현하면 후보는 `logs-stream` 하나이고 그마저 끝나면 **인벤토리 안에 후보가 없다**. 그때는 인벤토리 밖 경로로 옮기되 프로브의 의미가 '스텁 금지'에서 '미정의 경로 404 shape'으로 바뀐다는 것을 명시하고 옮겨라.
4. **ADR-008 예외 목록 규율의 현재 상태** — **4파일**이고 자리(경로)까지 고정이며 군 교차 누출 단언이 신설 2파일에도 걸려 있다. 다음 phase가 항목을 더 늘리려 하면 **그 자체가 아키텍처 결정**이다. 마감 6종 교차 변이 결과를 표로 남겨라.
5. **Node 의미론 단일 출처의 현재 목록** — `NodeNumber`(수) · `NodeString`(공백) · `NodeInstants`(시각) · **`NodeBase64`(base64)** · **`NodeUri`(encodeURIComponent)**. 로컬 재구현 금지 규율과 그 위반이 낳은 실제 사고(phase 70 `Double.parseDouble`)를 상기시켜라.
6. **divergence 전수(고치지 않고 기록)** — ① `path.extname`을 win32 알고리즘으로 구현(POSIX 호스트에서 Node와 갈리는 입력이 있으나 **화이트리스트 판정 결과는 같다**는 실측 근거를 함께) ② `Photo` 조회가 `SELECT *`가 아니라 6컬럼 명시(컬럼 추가 시 안전측) ③ 정적 서빙의 ETag/`Cache-Control`/`Accept-Ranges` 헤더가 express.static과 다르다(계약 리포트가 싣지 않는 헤더) ④ 요청 본문 크기 상한이 Spring에는 없다(Node는 전역 100kb + 2라우트 10mb — 전역 도입은 30여 라우트에 파급되므로 하지 않았다) ⑤ 비-png 확장자의 `Content-Type`(step8 관측 기록) ⑥ open_questions (1)의 결정(**이식한다 — ② 확정**)과 그 대가(예외 파일 +1 · 키 설정 경로는 계약이 동결하지 못한다) ⑦ **[② 검토 반영 · 문서 부채] Node 주석의 ADR 오인용** — `src/services/mediaSearch.js` 1행과 `src/services/translate.js` 2행이 서버 프록시를 'ADR-005'로 인용하는데 **ADR-005는 SSE 단방향 무효화 스트림 결정**이다. 실제 근거는 이 phase가 step2에서 신설한 **`ADR-014`**다. `src/**`는 무수정 목록이므로 **고치지 않고 기록만 한다** — Node 주석을 손대는 phase(P2/P3 전환 소유)가 함께 정정하라. ⑧ **`HttpRequest.timeout`의 잔여 위험**(응답 헤더까지만 덮는다 — 본문을 천천히 흘리는 외부 API는 Tomcat 워커를 점유한다. 71a가 실측한 것과 동일하며 이제 그 표면이 미디어·번역까지 넓어졌다).
7. **미검증(정직한 공백)** — ① 키가 설정된 서버의 실제 미디어/번역 응답 shape(계약이 관측할 수 없다 — 하네스가 키를 지운다) ② 5MB 정확 경계의 **계약** 관측(Java 테스트만 본다) ③ 업로드 파일명 충돌의 실제 발생 확률과 500 경로 ④ 정적 서빙의 대용량 파일·Range 요청 ⑤ 동시 업로드의 디렉토리 생성 경쟁 ⑥ 비-ASCII 파일명이 응답 `filename`으로 왕복할 때의 인코딩(계약 픽스처는 ASCII뿐) ⑦ `/uploads` 파일의 수명·정리 정책(앱이 지우지 않는다 — 운영 소유) ⑧ **[② 재검토 med] 키 유출 축은 Java 센티넬 테스트만 본다** — 계약 하네스가 API 키 4종을 자식 env에서 지우므로 **계약 env에는 키 문자열이 애초에 존재하지 않는다**. 따라서 '계약 리포트에 키가 없다'는 사실은 아무것도 증명하지 못하고(리포트 위생 검사에 키 항목을 넣어도 **공허**하다), 이 축의 유일한 방어선은 `HttpExternalProxyClientTest`(step5) · `MediaSearchServiceTest`(step6) · `TranslationServiceTest`(step7)의 **센티넬 키 비유출 단언 3면**(반환 맵 직렬화 전문 · `LogService` 링 버퍼 · 예외 메시지·원인 체인)이다. 로그 링 버퍼는 `GET /api/logs/digest`로 **밖으로 나간다**(ADR-007) — 거기 들어간 한 조각은 곧 응답이다.
8. **누적 이월**(72 forward_notes (9)를 그대로 이어받아 갱신) — 경로 정규화 divergence(이제 **5개 라우트만큼 더 생겼다**) · `DistributionTargetService.checkName`의 `String.trim()` · Boot `/error`의 405·415 shape · 로그 다이제스트 본문 차이 · `RateLimit-*` 헤더 범위.
9. **진단 위생** — surefire 로그의 세션 토큰(72 (13) 승계) + **이 phase 신규**: 업로드 테스트 실패 시 assertion 메시지에 임시 경로가 실린다(리포 밖 `@TempDir`이라 실해는 없지만 공유 전에 훑어라).
10. **환경 함정** — IDE가 `target/`에 JDK 25 클래스를 남기면 `mvnw -B verify`가 `Tests run: 0`으로 즉사 → `clean verify` 1회.

## Acceptance Criteria

위 A의 9커맨드가 **연속 2회** 전부 exit 0이고 수치가 동일할 것. 그리고:

```bash
cd d:/agents/harness && git status --porcelain
# → 변경은 server-spring/** · docs/ADR.md · phases/73-spring-media-upload/** · phases/index.json 뿐
#   (scripts/spring-contract.mjs는 step9에서 이미 변경됨) · 미추적은 .vscode/ 뿐
cd d:/agents/harness && git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json
# → 출력 없음(정본 무수정의 기계 증거)
```

**AC 마지막 항목(필수)**: 아래 '검증 절차'의 변이 **전건**에 대해 `변이 | 심은 곳 | 기대 | 실제(red/green) | 원복 확인(git diff 공백)` 표를 **step 요약에 기록**하라. **미기록이면 이 step은 미완이다** — 빌드 green과 관측 수 불변만으로 만족되는 AC는 공허하다(index.json decisions (23)).

## 검증 절차 (변이 포함)

1. B표의 **6종 교차 변이**를 전부 실행하고 6/6 red를 확인한 뒤 원복·`git diff` 공백을 확인한다.
2. **변이 X(계약 무회귀의 비공허성)**: `UploadService`의 확장자 화이트리스트에서 `hwp` 하나를 뺀다 → `--parity`가 `upload:ext-allowlist` 관측에서 red(`acceptedExtCount` 14 → 13) → 원복. 계약이 실제로 이 phase의 코드를 보고 있다는 증거다.
3. **변이 Y(정적 서빙)**: 리소스 핸들러 등록을 지운다 → 계약 `x-uploads-static`이 404로 red → 원복.
4. `--dual-run` 로그에서 두 패스의 pid·port·DATA_DIR이 **실제로 달랐다**는 줄을 인용해 요약에 남겨라(같은 인스턴스 2회면 자기 결정성 판정이 성립하지 않는다).
5. 문서 갱신 후 README의 수치와 실측 수치를 **한 줄씩 대조**하라(README에 추정치를 쓰지 마라).

## 금지사항

- **Spring 대상 `--require-full-coverage`를 켜지 마라.** 이유: SSE 2 라우트가 남아 영구 red이고, 그 red가 정상이다. 마지막 phase가 켠다.
- **`docs/ADR.md`의 ADR-013 결정 본문과 이전 phase 문장을 고치지 마라.** 이유: 그 문장들은 각 phase의 마감 실측 기록이며 소급 수정은 이력을 오염시킨다. **추가는 1문장, 1회다.**
- **README에 추정치를 쓰지 마라.** 이유: 다음 phase가 그것을 baseline으로 읽는다(이 phase가 72의 1022를 그대로 믿었다면 기준선이 틀렸을 것이다 — 실제로는 1031이었다).
- **`--keep`으로 남긴 계약 리포트를 리포 안에 두지 마라.** 이유: 리포 오염이자 토큰 유출 표면이다. 확인 후 직접 삭제하라.
- **커밋·PR·머지를 임의로 하지 마라.** 이유: 공유 `feat-0-mvp`로의 머지는 사용자 명시 승인이 필요하고, 커밋 시점은 오케스트레이터 판단이다.
- **변이를 심은 채로 마감하지 마라.** 이유: 원복 누락은 곧 규율 파괴다 — 모든 변이 뒤에 `git diff`가 비어 있음을 확인하라.
