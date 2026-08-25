# Step 6: collection-closeout

phase 71-spring-collection을 닫는다 — **전건 재측정(연속 2회)** · 데이터 안전 단언 · 문서 갱신(`server-spring/README.md`) · `index.json`의 `forward_notes` 작성. 이 phase의 마감 실측이 **`phases/72-spring-distribution`의 baseline**이 된다.

이 step은 **새 기능을 만들지 않는다**. 코드 변경이 필요하다고 판단되면 그것은 이 step의 산출물이 아니라 **발견**이며, 고칠지 이월할지를 근거와 함께 기록한다.

## 읽어야 할 파일

- `phases/71-spring-collection/index.json` — 전문(scope · baseline · order · decisions · excluded · open_questions)
- `phases/71-spring-collection/step0.md` ~ `step5.md` — 각 step이 남긴 실측·변이·미검증 항목
- `phases/72-spring-distribution/index.json` — **이 phase가 인계하는 대상**. baseline이 "71a 마감 실측으로 갱신하고 시작하라"고 적혀 있다 — 그 갱신에 필요한 수치를 이 step이 만든다
- `phases/70-spring-admin-crud/index.json` · `phases/69-spring-articles/index.json` · `phases/68-spring-auth/index.json` — `forward_notes`의 형식과 **누적 이월 항목**(인코딩 divergence·잠금 사용자 미대조·`UserRepository` 바인딩 등은 **새 결함으로 보고하지 않고 누적만** 한다)
- `server-spring/README.md` — 라우트 표·프로파일 설명·env 표

## 배경 (동결된 사실)

- 이 phase 종료 시점 구현 라우트는 **29**, 미구현 **10**(distribution-tick · distribution-failures · distribution-retry · media-search · upload · photos-create · photos-search · articles-translate · stream · logs-stream).
- 계약 프로파일은 **5**(default · minimal · auth-negative · prod-cookie · **failclosed**)이고 `failclosed`의 `bootOnly`는 step5에서 제거됐다.
- Spring 대상 `--require-full-coverage`는 여전히 **켜지 않는다**(excluded (g)).
- **`docs/ADR.md`는 이 phase에서 고치지 않는다** — ADR-013 ④의 실측 1문장은 배부 phase 마감이 소유한다(decisions (1)). 이것을 어기면 같은 항목이 두 줄이 된다.

## 작업

### A. 전건 재측정 (전부 **연속 2회**, 리포 루트 cwd)

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --dual-run
cd d:/agents/harness && npm test
cd d:/agents/harness && npm run lint
cd d:/agents/harness && npm run build
cd d:/agents/harness && node scripts/contract-inventory-check.mjs --require-spec-paths
cd d:/agents/harness && npm run test:contract -- --require-full-coverage
```

기록할 수치(**추정 금지 — 전부 실측**):

- Java 테스트 수(기준선 **670** 대비 증분) · `BUILD SUCCESS` · jar 바이트 수(기준선 35,641,225 B 대비).
- 무인자 실행: **5 프로파일**의 `cases`·`covered=n/39`·`tests`·소요.
- `--parity`: 프로파일별 관측 수와 **총 관측 수** · diffs **0**.
- `--dual-run`: 프로파일별 diffs 0 + 두 패스의 **pid·port·DATA_DIR·DIST_SPOOL_DIR이 서로 달랐다는 로그 증거**.
- Node 축: `npm test` **1328** 불변 · lint·build clean · `contract-inventory-check` `routes=39 spec-paths=39/39` · **Node 대상** `--require-full-coverage` `profiles=5 cases=274 covered=39/39`(이 phase가 Node 서버·계약 스위트를 한 줄도 고치지 않았다는 최종 증거).

### B. 데이터 안전 단언

- 리포 `news.db` **size·mtime·md5 무변** · `uploads/` 항목 수·총 바이트 무변.
- 리포 안에 리포트·임시 파일이 **하나도** 없다(`git status --porcelain`에 미추적 파일 0).
- 전 실행 후 **java 프로세스 잔존 0** · OS 임시 `spring-contract-*`·`contract-*` 잔존 0.
- 리포트·로그에 **64-hex 세션 토큰 0건** · 시드 비밀번호(`reporter123`·`desk123`·`admin123`) 0건 · **수집 토큰 값 0건**.

### C. 스텁 금지·인벤토리 대조

- `HandlerInventoryTest.IMPLEMENTED_ROUTES` **29행** + Boot 기본 `/error`.
- 5개 리포트의 `routeId` 합집합을 뽑아 **계약 전용 유사 라우트(`x-`로 시작)를 제외한 실제 라우트 수**가 29와 일치하는지 확인한다 → "구현했는데 계약이 관측하지 않는 라우트" **0개**임을 실증한다.
- `PathPolicyWireTest`의 스텁 금지 프로브(`GET /api/media/search`)가 여전히 미구현을 가리키는지 확인.

### D. 문서 갱신 (범위 밖으로 넘어가지 마라)

`server-spring/README.md`만 고친다:

- 라우트 표 27 → **29**(2행 추가) · 미구현 **10** 목록.
- 계약 프로파일 **5**와 `failclosed`의 의미(비-loopback 바인딩 + 토큰 미설정 = 수집 fail-closed).
- env 표에 `HOST` · `COLLECTION_TOKEN` · `DIST_SPOOL_DIR` 추가(**미설정 시 동작**을 각각 한 줄로: 바인드 기본 loopback · 토큰 미설정이면 헤더 미판독 · **스풀 미설정이면 배부 전면 비활성** — 마지막 항목은 아직 구현이 없지만 하네스가 이미 주입하므로 표에 둔다).
- **`app.collection.host`가 `server.address`에서 파생된다**는 사실과 그 이유(출처가 둘이면 fail-closed가 개방 쪽으로 오판한다).
- **ADR-008 정적 게이트**(`Adr008DisciplineTest`)의 존재와 예외 2파일(`HttpApiSourceFetcher.java`는 이 phase가 채웠고 `SpoolWriter.java`는 배부 phase가 채운다).
- 미검증 목록(아래 F ⑤)을 간결히.

### E. `index.json` 마감

- `steps`의 전 항목 상태를 확인한다(타임스탬프·`summary`는 실행 엔진·실행 세션이 기록한다 — 손으로 넣지 마라).
- `open_questions` 각 항목에 **마감 결과**를 덧붙인다((a) 절단 결과 · (b) 0.0.0.0 바인딩 실측 · (c) 타임아웃 · (d) 문서 범위 · (e) 중복 헤더 처분).

### F. `forward_notes` 작성 (**`phases/72-spring-distribution`의 최우선 입력**이다)

최소 다음을 포함한다:

1. **마감 실측 전문**(A의 수치) — "이 수치가 `72-spring-distribution`의 기준선이다. 추정치를 섞지 말 것." 그 phase의 baseline이 이 값으로 갱신되어야 한다는 사실을 명시한다.
2. **상속 자산의 계약** — ① 하네스 프로파일 축(`host`/`spool`/`token`)과 `bootOnly` 규칙(그리고 **`files: []`만 두면 러너가 디렉토리를 스캔해 확정 red가 된다**는 실측) ② `default.spool=true`라 **Spring 인스턴스에 `DIST_SPOOL_DIR`이 이미 주입돼 있다**(배부 phase에서 그 스풀이 처음 쓰인다) ③ `Adr008DisciplineTest`와 예외 2파일 목록 — 배부 phase는 `SpoolWriter.java`로 **빈 자리를 채울 뿐** 목록을 넓히지 않는다 ④ 별도 `@ConfigurationProperties` 분리 관례(`CollectionProperties` 선례 → 배부는 `SpoolProperties`, `AppProperties`와 그 9개 테스트 호출부는 무접촉).
3. **머지 순서(사고 예방)** — 이 phase를 **먼저 `feat-0-mvp`에 머지**하고, 배부 phase는 **그 머지 커밋에서 `feat-72-spring-distribution`으로 분기**한다. 스택 PR 바텀업 머지에서 `--delete-branch`가 다음 PR을 auto-close시킨 전례가 있으므로 **스택으로 쌓지 않는다**.
3-b. **[미기록 부채] `docs/ADR.md` ADR-013 ④의 실측 문장이 아직 없다.** 이 phase는 ADR을 고치지 않았고(decisions (1)) 그 한 문장은 **`72-spring-distribution` 마감에서 71a+72를 함께** 기록한다. **72가 지연·중단되면 이 phase의 실측이 ADR에 영구 미기록으로 남는다** — 그 사실을 부채로 명시하고, 72가 착수되지 않는 상태로 이 phase가 머지되면 오케스트레이터가 별도 판단(ADR 문장만 따로 넣을지)을 하도록 인계한다.
4. **SSE 신호 발행 지점(수집 축)** — `POST /api/collection/receive`·`/pull` **성공에만** `'create'`. SSE 도메인 phase가 소유한다(decisions (13)).
5. **미검증(정직한 공백)** — 최소: ① **비-loopback 바인딩의 실제 원격 접근**(테스트는 항상 127.0.0.1로 접속한다) ② FTP 스풀 수집 경로 전체(excluded (e)) ③ `logHostDiagnostics` 부트 경고 문구(excluded (f)) ④ 수집 성공의 SSE 신호 ⑤ 두 서버가 같은 `news.db`를 동시에 여는 상황 ⑥ 수집 토큰 회전·만료(그런 개념이 Node에도 없다).
6. **divergence(고치지 않았고 안전 방향)** — ① `HttpClient`가 **리다이렉트를 따라가지 않는다**(Node `fetch`는 follow) ② **connect timeout 10초**(Node는 없음). **요청 단계 무한 대기는 Node와 동일하게 남는다 — 느린 등록 endpoint가 Tomcat 워커를 점유할 수 있다.** ③ 중복 `x-collection-token` 헤더 처리(step5 실측 결과와 처분).
7. **`Date.parse`·엠바고 축은 이 phase의 소유가 아니다** — 배부 phase decisions (7)이 소유한다는 사실만 상기시킨다(중복 기술 금지).
8. **누적 이월**(새 결함으로 보고하지 말 것) — 인코딩·경로 파라미터 divergence(69 (8)) · 잠금 획득의 사용자 미대조(69 (12)) · `UserRepository` 바인딩 문자열화(69 (5)(b)) · `CsrfOriginFilter` 공백 Origin(68 (22)(c)) · Boot `/error`의 405·415 shape(68 (13)) · 로그 링 버퍼 내용 차이와 이력 실패 경고 문구 차이(69 (16)(g)) · `RateLimit-*` 헤더 범위(68 (15)).
9. **정적 게이트가 덮지 못하는 벡터와 실질 그물** — 문자열 분해·리플렉션은 통과한다. 실질 방어는 **행동 단언**(파일 개수·행 수·응답 키 집합·요청 횟수)이다(phase 70 gap_found 계열).

## Acceptance Criteria

위 A의 9개 커맨드가 **연속 2회 전부 exit 0**이고, 다음이 성립한다:

- `--parity`·`--dual-run` **diffs 0**(5 프로파일).
- Java `BUILD SUCCESS`, failures/errors/skipped 0.
- `npm test` **1328/1328** 불변 · lint·build clean.
- `contract-inventory-check --require-spec-paths` exit 0(`routes=39 spec-paths=39/39`).
- Node 대상 `--require-full-coverage` exit 0(`profiles=5 cases=274 covered=39/39`).
- B의 데이터 안전 단언 전건 통과.

```bash
cd d:/agents/harness && git status --porcelain
cd d:/agents/harness && git diff feat-0-mvp...HEAD --name-only
```

- 두 번째 커맨드의 전수 목록에 **`server/**`·`src/**`·`test/**`·`web/**`·`client/**`·`contract/**`·`docs/api-contract/**`·`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`·`package.json`·`docs/ADR.md`가 없어야 한다**(새 npm 의존성 0 · 새 Maven 의존성 0도 함께 확인). `docs/ADR.md`가 목록에 있으면 배부 phase의 소유를 침범한 것이다.

## 검증 절차

1. A를 **연속 2회** 돌려 flake 0을 확인한다. 한 번이라도 diff가 나오면 그 원인을 규명하기 전에는 phase를 닫지 마라.
2. C의 인벤토리 대조를 실제 리포트 파일로 수행한다(주장만 적지 마라).
3. B의 비밀 스캔을 리포트·로그 파일 전문 문자열 검색으로 수행한다(세션 토큰 정규식 `[0-9a-f]{64}` · 시드 비밀번호 3종 · 수집 토큰 리터럴).
4. **게이트 비공허성 재확인**: `Adr008DisciplineTest`에 변이 1종(`@Scheduled` 주입)을 넣어 red를 확인하고 원복한다. 마감 시점에도 게이트가 살아 있음을 실증한다.
5. **`bootOnly` 잔재 확인**: `scripts/spring-contract.mjs`에 `bootOnly: true`가 남아 있지 않은지(step5가 제거했어야 한다), 그리고 자기 검사 4번(비-`bootOnly` 프로파일의 `files` 비어 있음 금지)이 여전히 작동하는지 확인한다.
6. D의 문서 수치가 A의 실측과 **정확히 같은지** 대조한다(문서에 추정치를 적지 마라 — phase 70 remaining_gaps ④가 그 실수를 잡았다).
7. E·F를 작성한 뒤 `index.json`이 유효한 JSON인지 확인한다(`node -e`로 파싱).
8. `phases/index.json`의 `71-spring-collection` 항목 note를 마감 내용으로 갱신한다.
9. **커밋하지 마라** — 커밋·머지는 오케스트레이터의 판단이다.

## 금지사항

- 실측하지 않은 수치를 문서·`forward_notes`에 적지 마라. 이유: 배부 phase가 그 수치를 기준선으로 삼는다 — 추정치가 섞이면 무회귀 판정선이 거짓이 된다.
- `docs/ADR.md`를 고치지 마라. 이유: ADR-013 ④ 실측 1문장은 배부 phase 마감 소유다(두 phase가 각각 쓰면 같은 항목이 두 줄이 된다).
- `docs/news.md`·`docs/api-contract/**`·`contract/**`를 고치지 마라. 이유: 명세·계약 정본이다.
- 이 step에서 새 기능·리팩터링을 하지 마라. 이유: 마감 측정과 코드 변경이 섞이면 무엇을 측정한 것인지 알 수 없게 된다.
- 실패한 게이트를 '알려진 flake'로 넘기지 마라. 이유: 이 phase는 아웃바운드 네트워크와 새 바인딩 축을 들여왔다 — flake의 기본 가설은 '진짜 비결정성'이다.
- 누적 이월 항목을 새 결함으로 보고하지 마라. 이유: 68~70이 근거와 함께 폐색한 항목이며, 재보고는 리뷰 게이트의 신호를 흐린다.
- 배부 도메인의 설계·수치를 `forward_notes`에 미리 확정해 적지 마라. 이유: 그 phase가 자기 실측으로 정한다 — 여기서 적으면 '계획서 수치를 믿고 구현하지 마라'는 규율과 충돌한다.
