# Step 10: parity-closeout

phase 72-spring-distribution을 닫는다 — **전건 재측정(연속 2회)** · 데이터 안전 단언 · 문서 갱신(`server-spring/README.md` · **ADR-013 ④ 실측 1문장**) · `index.json`의 `forward_notes` 작성.

**ADR-013 ④의 문장은 이 step이 유일하게 쓴다.** `phases/71-spring-collection`은 ADR을 고치지 않았으므로(그 phase decisions (1)), 이 한 문장이 **수집·배부 두 phase의 실측을 함께** 기록한다 — 71a 마감 실측과 이 phase 실측을 같은 문장에 담아라.

이 step은 **새 기능을 만들지 않는다**. 코드 변경이 필요하다고 판단되면 그것은 이 step의 산출물이 아니라 **발견**이며, 고칠지 이월할지를 근거와 함께 기록한다.

## 읽어야 할 파일

- `phases/72-spring-distribution/index.json` — 전문(scope · baseline · order · decisions · excluded · open_questions)
- `phases/72-spring-distribution/step0.md` ~ `step9.md` — 각 step이 남긴 실측·변이·미검증 항목
- **`phases/71-spring-collection/index.json`의 `forward_notes`** — 이 phase의 baseline이 그 수치로 갱신됐어야 한다. 그 phase가 남긴 divergence(리다이렉트·connect timeout·중복 헤더)와 미검증 목록을 **이 phase의 forward_notes가 다시 쓰지 말고 참조만** 하라(중복 기술 금지)
- `phases/70-spring-admin-crud/index.json` · `phases/69-spring-articles/index.json` · `phases/68-spring-auth/index.json` — `forward_notes`의 형식과 누적 항목(인코딩 divergence·잠금 사용자 미대조·`UserRepository` 바인딩 등은 **이 phase가 새 결함으로 보고하지 않고 누적만** 한다)
- `server-spring/README.md` — 라우트 표·프로파일 설명·env 표
- `docs/ADR.md` ADR-013 ④ — phase 68·69·70의 실측 문장(그 문장들은 **무수정**)

## 배경 (동결된 사실)

- 이 phase 종료 시점 구현 라우트는 **32**, 미구현 **7**(media-search · upload · photos-create · photos-search · articles-translate · stream · logs-stream).
- 계약 프로파일은 **5**(default · minimal · auth-negative · prod-cookie · **failclosed**).
- Spring 대상 `--require-full-coverage`는 여전히 **켜지 않는다**(excluded (g)).
- 문서 갱신 범위는 open_questions (d)의 기본 결정을 따른다(`docs/news.md`·`docs/api-contract/**`·계약 파일은 무수정).

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
- 무인자 실행: 5 프로파일의 `cases`·`covered=n/39`·`tests`·소요.
- `--parity`: 프로파일별 관측 수와 **총 관측 수** · diffs **0**.
- `--dual-run`: 프로파일별 diffs 0 + 두 패스의 **pid·port·DATA_DIR·DIST_SPOOL_DIR이 서로 달랐다는 로그 증거**.
- Node 축: `npm test` **1328** 불변 · lint·build clean · `contract-inventory-check` `routes=39 spec-paths=39/39` · **Node 대상** `--require-full-coverage` `profiles=5 cases=274 covered=39/39`(이 phase가 Node 서버·계약 스위트를 한 줄도 고치지 않았다는 최종 증거).

### B. 데이터 안전 단언

- 리포 `news.db` **size·mtime·md5 무변** · `uploads/` 항목 수·총 바이트 무변.
- 리포 안에 스풀 파일·`.tmp`·리포트가 **하나도** 없다(`git status --porcelain`에 미추적 파일 0).
- 전 실행 후 **java 프로세스 잔존 0** · OS 임시 `spring-contract-*`·`contract-*` 잔존 0.
- 리포트·로그에 **64-hex 세션 토큰 0건** · 시드 비밀번호(`reporter123`·`desk123`·`admin123`) 0건 · **수집 토큰 값 0건** · **스풀 절대경로 0건**.

### C. 스텁 금지·인벤토리 대조

- `HandlerInventoryTest.IMPLEMENTED_ROUTES` **32행** + Boot 기본 `/error`.
- 5개 리포트의 `routeId` 합집합을 뽑아 **계약 전용 유사 라우트(`x-`로 시작)를 제외한 실제 라우트 수**가 32와 일치하는지 확인한다 → "구현했는데 계약이 관측하지 않는 라우트" **0개**임을 실증한다.
- `PathPolicyWireTest`의 스텁 금지 프로브(`GET /api/media/search`)가 여전히 미구현을 가리키는지 확인.

### D. 문서 갱신 (범위 밖으로 넘어가지 마라)

1. `server-spring/README.md`
   - 라우트 표 29 → **32**(3행 추가) · 미구현 **7** 목록. (27 → 29는 71a가 이미 했다.)
   - `app.distribution.spool-dir`(= `DIST_SPOOL_DIR`) 항목과 **미설정 시 동작**(배부 전면 비활성: tick·retry 503 · failures는 200 · 송고 훅 결선 없음). 71a가 env 표에 넣어 둔 줄이 있으면 그 줄을 정확히 하는 데 그친다.
   - **ADR-008 정적 게이트**(`Adr008DisciplineTest`)의 예외 2파일이 **모두 채워졌다**는 사실(`HttpApiSourceFetcher.java` = 71a · `SpoolWriter.java` = 이 phase)과 그 근거.
   - 미검증 목록(아래 F ⑦)을 간결히.
2. `docs/ADR.md` ADR-013 ④에 **실측 1문장** 추가 — **71a와 이 phase를 함께** 담는다(71a는 ADR을 고치지 않았다). 결정·이유·트레이드오프 본문과 phase 68·69·70 문장은 **무수정**.

### E. `index.json` 마감

- `steps`의 전 항목 상태를 확인한다(타임스탬프·`summary`는 실행 엔진·실행 세션이 기록한다 — 손으로 넣지 마라).
- `open_questions` 각 항목에 **마감 결과**를 덧붙인다((a) 송고 훅 · (b) GET 404 · (c) 문서 범위 · (d) 이력 실패 처분 · (e) 같은 밀리초 재기록 — 각각 무엇으로 결정됐고 무엇으로 실증했는지).

### F. `forward_notes` 작성 (다음 phase의 **최우선 입력**이다)

최소 다음을 포함한다:

1. **다음 도메인 묶음 권장 순서와 남은 7 라우트** — media·upload·photos(4, `media-upload.contract.js`) → SSE·logs-stream(2, `docs/api-contract/sse.md`·`sse-stream.contract.js`) → translate(1). **각 phase는 계획 단계에서 자기 계약 파일이 부르는 픽스처 라우트가 이미 구현돼 있는지 먼저 확인하라**(phase 69 forward_notes (2) 승계).
2. **SSE 신호 발행 지점 3곳**(decisions (23)의 인계) — 정확한 조건과 함께: ① `POST /api/distribution/tick` 성공 **AND `distributed`가 1건 이상**일 때 `'status'` ② `POST /api/distribution/retry` **성공에만** `'status'`(거부·실패에는 보내지 않는다) ③ `POST /api/collection/receive`·`/pull` 성공에 `'create'`. 그리고 phase 69 forward_notes (15)①이 남긴 기사 도메인 신호 지점도 함께 상기시킨다.
3. **`Date.parse` 이식 범위와 divergence**(decisions (7)) — 무엇을 덮고 무엇을 null로 떨어뜨리는지, 그 방향이 안전측인 이유, 그리고 그 사실이 tick 응답 `invalid` 배열로 표면화된다는 점.
4. **수집 축 divergence는 71a가 소유한다 — 참조만 하고 다시 쓰지 마라**(리다이렉트 미추종 · connect timeout 10초 · 중복 `x-collection-token` 헤더). 다만 잔여 위험 한 줄은 여기서도 상기시킨다: **요청 단계 무한 대기는 Node와 동일하게 남는다 — 느린 등록 endpoint가 Tomcat 워커를 점유할 수 있다.**
5. **ADR-008 정적 게이트의 예외 목록 규율** — 새 phase가 파일을 예외에 넣으려 하면 그 자체가 아키텍처 결정이다. `theExceptionListIsExactlyTwoFiles`가 그 사실을 diff에 드러낸다.
6. **정적 게이트가 덮지 못하는 벡터와 실질 그물** — 문자열 분해·리플렉션은 통과한다. 실질 방어는 **행동 단언**(스풀 파일 개수·이력 행 수·응답 키 집합·DB 행 수 감소 0)이다(phase 70 gap_found 계열).
7. **미검증(정직한 공백)** — 최소: ① 실패 원장이 있는 상태의 **계약(HTTP) 관측**은 여전히 없다(excluded (f) — Java 와이어 테스트가 소유) ② tick의 **재진입 스킵 7키 응답**은 계약이 관측하지 못한다(직렬 실행) ③ 다중 인스턴스 중복 tick(운영 규율 소유) ④ 스풀 파일을 **외부 전송기가 실제로 집어가는** 경로 전체 ⑤ 원자 이동의 **원자성 자체**(단위 테스트로 증명 불가 — 구현 형태만 관찰한다: step3 test13이 `SpoolFs` seam으로 `.tmp write → ATOMIC_MOVE` **호출 순서**를 잠근다. **step3에서 seam을 두지 못했다면 '구현 형태조차 무테스트'라고 여기에 명시하라** — 강등 사실을 숨기지 마라) ⑥ 엠바고 **과거 시각·파싱 불가**의 계약 관측(픽스처가 전부 미래 시각 — phase 69 forward_notes (4)⑨ 승계) ⑦ 두 서버가 같은 `news.db`를 동시에 여는 상황 ⑧ 비-loopback 바인딩의 **실제 원격 접근**(테스트는 127.0.0.1로만 접속한다).
8. **누적 이월**(새 결함으로 보고하지 말 것) — 인코딩·경로 파라미터 divergence(69 (8)) · 잠금 획득의 사용자 미대조(69 (12)) · `UserRepository` 바인딩 문자열화(69 (5)(b)) · `CsrfOriginFilter` 공백 Origin(68 (22)(c)) · Boot `/error`의 405·415 shape(68 (13)) · 로그 링 버퍼 내용 차이와 **이력 실패 경고 문구 차이**(69 (16)(g) — 다이제스트 본문을 동결하는 phase가 소유) · `RateLimit-*` 헤더 범위(68 (15)).
9. **스캔 상한 3종의 구분**(decisions (16)) — 표시용 창 / 재전송 게이트 / 중복 억제. 통일하면 각각 '복구 불가'와 '억제 무의미'로 끝난다는 사실과, 그 구분을 지키는 테스트 이름을 적는다.
10. **마감 실측 전문**(A의 수치) — "이 수치가 다음 phase의 기준선이다. 추정치를 섞지 말 것." **71a 마감 실측 + 이 phase 증분**을 함께 적어 P1 남은 phase가 한 곳만 보면 되게 한다.

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

- 두 번째 커맨드의 전수 목록에 **`server/**`·`src/**`·`test/**`·`web/**`·`client/**`·`contract/**`·`docs/api-contract/**`·`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`·`package.json`이 없어야 한다**(새 npm 의존성 0 · 새 Maven 의존성 0도 함께 확인). **`docs/ADR.md`는 이 목록에 있어야 한다**(ADR-013 ④ 1문장 — 이 phase가 소유한다).
- **71a가 이미 머지돼 있어야 한다**: `git diff feat-0-mvp...HEAD`에 수집 라우트·`CollectionProperties`·`Adr008DisciplineTest` 신설이 **보이지 않아야** 정상이다(보인다면 리베이스 대신 스택으로 쌓은 것이다 — baseline 규율 위반).

## 검증 절차

1. A를 **연속 2회** 돌려 flake 0을 확인한다. 한 번이라도 diff가 나오면 그 원인을 규명하기 전에는 phase를 닫지 마라.
2. C의 인벤토리 대조를 실제 리포트 파일로 수행한다(주장만 적지 마라).
3. B의 비밀 스캔을 리포트·로그 파일 전문 문자열 검색으로 수행한다(세션 토큰 정규식 `[0-9a-f]{64}` · 시드 비밀번호 3종 · 수집 토큰 리터럴 · 스풀 절대경로 조각).
4. **게이트 비공허성 재확인**: `Adr008DisciplineTest`에 변이 1종(`@Scheduled` 주입)을 넣어 red를 확인하고 원복한다. 마감 시점에도 게이트가 살아 있음을 실증한다.
5. D의 문서 수치가 A의 실측과 **정확히 같은지** 대조한다(문서에 추정치를 적지 마라 — phase 70 remaining_gaps ④가 그 실수를 잡았다).
6. E·F를 작성한 뒤 `index.json`이 유효한 JSON인지 확인한다(`node -e`로 파싱).
7. `phases/index.json`의 `72-spring-distribution` 항목 note를 마감 내용으로 갱신한다(71a 항목은 그 phase가 이미 갱신했다 — 덮어쓰지 마라).
8. **커밋하지 마라** — 커밋·머지는 오케스트레이터의 판단이다.

## 금지사항

- 실측하지 않은 수치를 문서·`forward_notes`에 적지 마라. 이유: 다음 phase가 그 수치를 기준선으로 삼는다 — 추정치가 섞이면 무회귀 판정선이 거짓이 된다.
- `docs/news.md`·`docs/api-contract/**`·`contract/**`를 고치지 마라. 이유: 명세·계약 정본이다.
- ADR-013의 결정·이유·트레이드오프 본문과 phase 68·69·70 실측 문장을 고치지 마라. 이유: 과거 기록을 덮어쓰면 결정의 이력이 사라진다.
- 이 step에서 새 기능·리팩터링을 하지 마라. 이유: 마감 측정과 코드 변경이 섞이면 무엇을 측정한 것인지 알 수 없게 된다.
- 실패한 게이트를 '알려진 flake'로 넘기지 마라. 이유: 이 phase는 파일 쓰기·시간축·동시성을 동시에 들여왔다 — flake의 기본 가설은 '진짜 비결정성'이다.
- 누적 이월 항목을 새 결함으로 보고하지 마라. 이유: 68~70이 근거와 함께 폐색한 항목이며, 재보고는 리뷰 게이트의 신호를 흐린다.
