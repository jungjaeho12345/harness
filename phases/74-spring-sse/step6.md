# Step 6: parity-closeout  ← **P1 완결 선언**

## 읽어야 할 파일

**계획 문서**
- `phases/74-spring-sse/index.json` — 전문(특히 `baseline`·`decisions` (14)·`open_questions` (5)).
- `phases/74-spring-sse/step0.md`~`step5.md`의 summary — 구간 실측 수치를 이 step이 한 표로 모은다.
- `phases/73-spring-media-upload/index.json` — `forward_notes` (1)의 **마감 실측 전문 형식**(이 step이 같은 형식으로 쓴다) · (4) ADR-008 예외 규율 · (7) 미검증 · (8) 누적 이월.
- `phases/72-spring-distribution/index.json`·`phases/71-spring-collection/index.json`의 `forward_notes` — 누적 이월 항목의 원문.

**갱신 대상**
- `docs/ADR.md` — **ADR-013 ④**의 실측 문장(순수 추가 · 이 phase가 마지막 문장을 덧붙인다).
- `server-spring/README.md` — 「구현한 라우트」 표 · 「계약 스위트로 검증하기」 · 「ADR-008 규율은 정적 게이트가 지킨다」 · 「아직 검증되지 않은 것」.
- `scripts/spring-contract.mjs` — 합산 커버리지 게이트(아래 D).
- `phases/index.json` — 74 항목 추가.

**정본**
- `scripts/contract-run.mjs` **451~473행** `judgeCoverage` — 커버리지 판정 단위는 **(routeId, `endpoints.json`의 `expect` 태그) 쌍**이고 `x-` 접두 관측은 집계에서 제외된다. **이 파일은 무수정**이다 — 판정 규칙만 읽어 같은 규칙을 `spring-contract.mjs`에 구현한다.

## 배경 (동결된 사실)

1. **이 step은 프로덕션 코드를 한 줄도 고치지 않는다.** 문서·하네스·phase 파일만 바꾼다.
2. **`--require-full-coverage`를 그대로 켤 수 없다는 것이 조사 결과다.** `scripts/spring-contract.mjs`는 프로파일마다 `contract-run.mjs`를 **따로 spawn**하므로 러너의 커버리지 집계가 **프로파일 단위**다. `default` 단독의 최대치는 39가 아니다(계획 단계 실측: 기준선 default `covered=29/39` · 이 phase 종료 후 `32/39`). Node 대상의 `39/39`는 **한 프로세스가 5 프로파일을 전부 돌 때만** 나온다. 따라서 72·73이 인계한 "세 묶음이 전부 끝난 뒤에만 켠다"는 **러너 플래그 전달이 아니라 하네스의 합산 게이트 신설**로 이행해야 한다.
3. **이 phase 종료 시 Spring scope 표의 파일 집합이 각 프로파일 디렉토리 전체와 같아진다**(default 14 · minimal 3 · auth-negative 1 · failclosed 1 · prod-cookie 1 = **20파일**). 그래서 5개 Spring 리포트의 합산 커버리지는 Node 전수 실행과 같은 **39/39 · 미커버 0쌍**이 나와야 한다 — 그것을 **실측으로 확인한 뒤에만** 게이트를 켠다.
4. **ADR-013 ④는 순수 추가만 한다.** 기존 phase 68·69·70·71a·72·73 문장과 ADR-001~015의 다른 본문은 **한 글자도** 고치지 않는다.

## 작업

### A — 마감 실측 (9커맨드 · **연속 2회**)

두 패스(P1·P2)를 **직렬로** 돌리고 수치가 동일한지 확인한다. 다르면 그 사실을 숨기지 말고 기록하고, flake로 판정하려면 **재실행 2회**로 확인하라(73의 `npm test` flake 선례).

```bash
# ① Java
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
# ②  jar 크기(clean 빌드 기준으로 인용하라 — 증분 빌드는 수십~수백 바이트 다르다)
ls -l server-spring/target/server-spring-0.0.1-SNAPSHOT.jar
# ③ 무인자(케이스 실행)
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs
# ④ 패리티
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
# ⑤ 자기 결정성
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --dual-run
# ⑥ Node 스위트
cd /d/agents/harness && npm test
# ⑦ 린트·빌드
cd /d/agents/harness && npm run lint && npm run build
# ⑧ 인벤토리·스펙 경로
cd /d/agents/harness && node scripts/contract-inventory-check.mjs --require-spec-paths
# ⑨ Node 대상 전수 커버리지(이 phase가 Node 정본을 고치지 않았다는 최종 증거)
cd /d/agents/harness && npm run test:contract -- --require-full-coverage
```

기대치:
- ① BUILD SUCCESS · Tests run 기록(**JDK 25 기준선 1246**에서 이 phase가 더한 수) · Failures 0 · Errors 0 · Skipped 0
- ④⑤ exit 0 · profiles=5 · **313관측 diffs 0**(default 246 · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3)
- ③ default **files=14** covered **32/39**
- ⑥ tests **1328** / pass 1328 / fail 0 / suites 51
- ⑧ routes=39 · spec-paths=39/39
- ⑨ exit 0 · profiles=5 · cases=274 · covered=39/39

**`--dual-run`이 서로 다른 프로세스·자원을 썼다는 로그 증거**(10 인스턴스의 pid·port·DATA_DIR이 전부 다름)를 발췌해 기록하라.

**데이터 안전 단언**(전건 확인 후 수치 기록):
- 리포 `news.db` 크기·mtime·md5 무변(기준값 606,208 B · md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967` — 이 phase 시작 시점에 다시 떠서 대조)
- 리포 `uploads/` 항목 수·바이트 무변(기준값 32항목 · 6,068,792 B)
- 리포 안 계약 리포트·`.tmp`·32-hex 산출물 **0건**
- `git status --porcelain` 미추적이 예상 목록뿐
- 하네스가 띄운 java 프로세스 **잔존 0**(남은 java는 StartTime으로 IDE 언어서버임을 확인)
- OS 임시의 `spring-contract-*`/`contract-*` 잔존 0(이 step이 만든 것은 직접 삭제)

**리포트 위생 스캔**(5개 리포트 전문 문자열 검색):
- 64-hex 세션 토큰 **0**
- 시드 비밀번호(`reporter123`·`desk123`·`admin123`) **0**
- 드라이브 문자로 시작하는 절대경로 **0**
- 32-hex 업로드 파일명 **0** · `/uploads/` 경로값 **0** · 스풀 파일명 패턴 **0**
- **로그 라인 실값 0** — `logs-stream` 관측의 `values`에 `recordKeys` 같은 **키 이름만** 있고 메시지 본문이 없는지 확인하라(이 phase가 새로 연 면이다)
- **외부 API 키는 검사하지 않는다 — 공허하기 때문이다**(하네스가 자식 env에서 지운다. 73 forward_notes (7)⑧)

**인벤토리 대조(주장이 아니라 파일로)**: 5개 리포트의 routeId 합집합에서 `x-` 접두 계약 전용 id를 뺀 집합이 **정확히 39**이고, `endpoints.json`으로 `METHOD PATH`로 풀었을 때 `HandlerInventoryTest.IMPLEMENTED_ROUTES` 39행과 **집합 동일**임을 스크립트로 확인하라 = "구현했는데 계약이 관측하지 않는 라우트 0개".

### B — `docs/ADR.md` ADR-013 ④에 실측 1문장 (순수 추가 · 1회만)

phase 73 문장 **뒤에** 이어 붙인다. 담을 것:
- phase 74(SSE 2라우트) 마감 실측: 계약 **20파일**(default 14 · minimal 3 · auth-negative 1 · failclosed 1 · prod-cookie 1) · **5 프로파일** · **패리티 관측 313, diffs 0**(default 246 · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3) · `--dual-run` 313관측 diffs 0 · Java **N 테스트 0 실패** · 구현 라우트 **39/39 — P1 포팅 라우트 완결** · DDL 0 · `DELETE FROM` 0.
- **ADR-008 정적 게이트의 예외는 4파일 그대로이고 이 phase는 그 파일을 0줄 고쳤다** — SSE가 앱 내 타이머·워커풀·백그라운드 스레드를 하나도 만들지 않았기 때문이다(ADR-015). 마감 시점에 SSE 소스에 타이머 변이를 심어 red를 재확인했다.
- 와이어 지점이 `JsonHttp`·`SseHttp` **둘**이 됐고 둘 다 `RawContentType` 한 seam을 쓴다는 사실, 그리고 그 사실을 정적 스캔이 잠근다는 것.

**형식 규율**: 기존 텍스트가 새 텍스트의 **접두사**임을 기계로 확인하라(아래 AC). 결정 본문과 phase 68~73 문장·ADR-014·ADR-015 본문은 **무수정**.

### C — `server-spring/README.md` 갱신

- 「구현한 라우트 · 아직 구현하지 않은 라우트」: **39/39**로 갱신하고 `GET /api/stream`(session)·`GET /api/logs/stream`(admin(Z))의 행을 추가한다. **"아직 구현하지 않은 라우트"가 0이 됐다**는 사실을 명시하고, 인벤토리 밖 표면 2종(`/uploads/**` 리소스 핸들러 · Boot `/error`)은 여전히 그 밖이라는 것을 유지하라.
- **「SSE 두 스트림」 절 신설**: ADR-015 요약(두 번째 와이어 지점 · 서블릿 비동기 · 트리거 스레드 쓰기 · 타이머 0) · 프레임 원문 바이트 · 인가 등급이 두 라우트에서 다르다는 것 · replay 2000 · 비연장 peek · 강등 봉인 · 누수 해제 3경로 · 계약이 못 보는 축과 그것을 잡는 Java 테스트 이름.
- 「계약 스위트로 검증하기」: scope 표 **20파일** · default 14파일 · **313관측** · default `covered=32/39`이고 **39/39는 5 프로파일 합산에서만** 나온다는 함정을 명시(73이 인계한 커버리지 함정의 최종 형태).
- 「ADR-008 규율은 정적 게이트가 지킨다」: 예외 **4파일 그대로** · 이 phase가 0줄 고쳤다는 사실 · SSE가 왜 예외가 필요 없는지 · 마감 변이 결과.
- 「아직 검증되지 않은 것(정직한 공백)」: 이 phase가 새로 만든 공백을 추가한다(아래 F의 목록과 같게).

### D — Spring 대상 합산 커버리지 게이트 판정·신설

1. **먼저 실측**: 5개 Spring 리포트를 합쳐 `judgeCoverage`와 **같은 규칙**((routeId, `expect` 태그) 쌍 · `x-` 제외)으로 미커버 쌍을 세라. **0쌍 · 39/39가 아니면 게이트를 켜지 말고** 무엇이 남았는지와 그 이유를 기록하라(그 경우 이 항목은 "판정: 아직 켜지 않는다"로 끝난다 — 그것도 정당한 결과다).
2. **0쌍이면** `scripts/spring-contract.mjs`에 `--require-full-coverage` 옵션을 신설한다:
   - 5개 Spring 리포트(대상=Spring 쪽만)의 관측을 합쳐 `docs/api-contract/endpoints.json`의 `expect` 쌍 전수를 만족하는지 판정.
   - 미달이면 **exit 1**로 실패하고 미커버 쌍을 나열한다. 플래그 없이는 지금과 동일(경고 없음/있음은 러너 형식을 따르라).
   - 판정 규칙을 `contract-run.mjs`에서 **복사해 오되**, 두 구현이 갈리지 않도록 "규칙의 정본은 `contract-run.mjs` 451~473행이며 여기 구현은 그 복제다"를 주석으로 명시하라.
   - **`scripts/contract-run.mjs`를 고치지 마라.**
3. **비공허성 실증**: scope 표에서 아무 행 하나(예: `logs.contract.js`)를 지우고 `--require-full-coverage`를 돌려 **exit 1 + 미커버 쌍 나열**을 확인한 뒤 원복하라. 그 결과를 표에 적어라. **이 실증이 없으면 게이트를 켜지 마라** — 켜기만 하고 비공허성을 확인하지 않은 게이트는 71a·72·73이 매번 발견한 "공허한 게이트"다.

4. **`JDK_HINT` 1줄 정정(이 phase가 이 파일에 하는 세 번째이자 마지막 변경 · 허용됨)**: `scripts/spring-contract.mjs` **55행**이 `const JDK_HINT = 'D:/agents/tools/jdk-21.0.12+8';`이고 그 값이 `BUILD_HINT` 문자열로 **사용자에게 출력**된다. 기준선이 JDK 25로 옮겨진 뒤(PR #119) 이 힌트는 **잘못된 빌드 명령을 안내**한다(그 JDK로 빌드하면 `release version 25 not supported`). **`'D:/agents/tools/jdk-25.0.4.1+1'`로 바꿔라 — 정확히 그 1줄만.** 이 파일에서 그 밖에 고치는 것은 scope 표 2행(step4·step5)과 위 2의 합산 게이트뿐이다. **`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`는 여전히 무수정이다.**

### E — `phases/index.json`에 74 항목 추가

`{"dir": "74-spring-sse", "status": "completed", "note": "..."}` — 73 항목과 같은 형식·같은 밀도로 마감 요약을 쓴다(수치·핵심 결정·변이 실증·무접촉 증거·다음 게이트).

### F — `phases/74-spring-sse/index.json`의 `forward_notes` 작성 (P2 인계)

최소 항목:
1. **마감 실측 전문**(A의 전 수치 · 구간별 Java 테스트 수 · jar 크기 · 5 프로파일 관측 분해).
2. **P1 완결 선언**: 39/39 · 계약 20파일 · 313관측 diffs 0 · Spring scope 표가 각 프로파일 디렉토리 전체와 같아졌다는 사실.
3. **ADR-008 예외 목록은 4파일에서 멈췄다** — SSE가 넓히지 않았고 그 근거는 ADR-015. 다음 phase가 넓히려 하면 그 자체가 아키텍처 결정이며 별도 ADR·리뷰가 필요하다.
4. **와이어 지점 2개 규율**(`JsonHttp`·`SseHttp` · 공유 seam `RawContentType` · 정적 스캔이 2개를 잠근다).
4b. **[이 phase의 가장 중요한 인계] replay-gate — 멀티스레드 서버가 단일스레드 정본을 이식할 때의 구조적 함정.** Node는 단일 스레드라 "ready write → subscribe" 사이에 다른 요청이 처리되지 않지만 Spring은 다른 워커가 동시에 돈다 — **그 창에서 신호가 유실**되고, `contract/lib/sse.js`가 "ready 수신 = 구독 완료"를 전제하는데 그 전제는 Node에서만 참이다. 해법은 `SseHttp.Stream`의 **prelude 모드 + 큐 + `endPrelude(dropUpTo)`**이며 규율은 「구독 먼저 → 스냅샷 → ready → replay → 드레인(seq 중복 제거)」이다(step2·step4·step5). **`decisions (4)`의 초안 서술("Node와 1:1")은 이 지점에서 부정확했고 index.json에 정정 문단이 붙어 있다.** 다음에 단일스레드 정본을 이식하는 사람은 **"등록 창"을 항상 먼저 의심하라.**
4b-1. **[② 재검토가 잡은 거짓 게이트 주장 — 반드시 이 형태로 인계하라] 계약은 이 유실을 잡지 못한다.** 계획 초안은 "구독을 뒤로 미루면 `logs.contract.js` B-4가 red"라고 적었으나 **실측은 반대다**: ① 그 파일 **170~178행**이 `seqBefore = maxLogSeq(s.frames)`를 ready 직후 샘플링하고 **주석이 "replay 잔여가 늦게 도착할 수 있어 '새 라인 도착'의 _하한만_ 본다"**고 명시한다 — 미도착 replay 프레임(seq 오름차순)이 그 predicate를 충족한다 ② `RequestLogFilter`(**44~52행**)가 **async 가드 없는 plain `Filter`**라 SSE 요청 자신의 액세스 로그가 항상 새 seq를 만든다. **따라서 유일 방어선은 step5 항목 7(b)(d)의 Java 경합 테스트**이고, M5-5·M6-11의 기대는 **「Java red · 계약 green」**이다. 이 패턴(계약이 못 보는 축)은 72 송고 훅 status·73 키 유출에서도 나왔다 — **다음 사람에게 "계약이 잡는다"고 적지 마라.**
4c. **`LogService`의 두 락 규율**(`notifyLock` → `bufferLock` 한 방향 · 통지는 버퍼 monitor 밖 · seq 순서 보존). Node에 없는 **seq 역전**을 막는 자리이고 **계약은 이 축을 못 본다**(`seq > seqBefore`만 본다).
4d. **push 시점 인가는 `Authorization.authorizePeek`(비연장)이다** — `authorize`(136행)·`editDps`(166행)가 `touchSession`을 쓴다는 실측 때문이며, 역할 표는 `CAPABILITIES` 한 출처를 공유한다.
5. **divergence 전수**(고치지 않고 기록): helmet 보안 헤더 11종 부재(ADR-013 기존 공백) · `Connection`/`Transfer-Encoding`의 실측 결과 · **Spring `RequestLogFilter`가 비동기 스트림에서 SSE 요청 자신의 액세스 로그를 스트림 중에 push한다**(Node는 스트림 종료 시점) · **`AsyncContext.setTimeout(0)`에서 소켓 강제 끊김 시 Tomcat이 `onError`/`onComplete`를 내는지 여부의 실측 결과와, 안 낼 경우 해제가 다음 write 실패까지 지연된다는 사실**(step4 항목 11(c)·step5 항목 13(c)) · 그 밖에 step4·step5가 실측한 것.
6. **미검증(정직한 공백)** — 각 항목의 유일한 방어선을 함께 적어라. 최소: 실제 브라우저 `EventSource`와의 상호운용 · 프록시/리버스프록시 버퍼링(`X-Accel-Buffering`을 Node도 보내지 않는다) · 매우 많은 동시 연결(수백)에서의 트리거 요청 지연 · 느린 소비자가 트리거 요청을 얼마나 지연시키는가 · 컨테이너 종료 중 열린 스트림의 정리 · `logs-stream` replay 2000건의 실제 전송 시간 · 웹 클라이언트(`web/**`)가 Spring 서버에 붙었을 때의 재연결 동작 · **prelude 큐 상한(`PRELUDE_MAX`) 초과 시의 drop-oldest 경로**(정상 부하에서 도달 불가하다고 판단했을 뿐 실부하로 확인하지 않았다 — 유일 방어선은 step2 항목 15의 단위 테스트다).
6b. **[② 재검토가 지목한 두 개의 정직한 공백 — 축소하지 말고 그대로 적어라]**
   - **(i) 블로킹 소비자 1개가 서버 전체를 정지시킬 수 있다 — Node와 비대칭이다.** Node `res.write`는 **논블로킹 버퍼링**이고 Spring `ServletOutputStream.write`는 **블로킹**이다. 완전히 멈춘 소비자가 `LogService`의 `notifyLock`을 물면 `RequestLogFilter`의 `finally`가 전 요청에서 그 락을 기다려 **모든 라우트가 정지**한다. **동시 연결 상한도 없다**(`excluded (d)` — Node `setMaxListeners(0)` 동형). step5 항목 20의 **관측 결과 수치를 여기 그대로 옮겨라.** 해법(비블로킹 write·write 타임아웃·연결 상한)은 전부 이 phase의 금지 철자·무접촉·배제 영역이므로 **P2 소유**다. 71a·72가 반복 확인한 "블로킹이 워커를 잠식해 전 라우트를 죽인다" 축의 재발 형태라는 점도 적어라.
   - **(ii) prelude 큐의 총 메모리가 무한이다.** 스트림당 상한은 `PRELUDE_MAX`(4096) 프레임이지만 **동시 연결 상한이 없으므로 총량에 상한이 없다**. step2 §A가 계산한 **스트림당 바이트 상한 수치**를 여기 옮기고, 총량이 `연결 수 × 그 수치`로 무한히 늘 수 있다는 사실을 명시하라.
7. **누적 이월**(71a~73의 목록을 갱신해 승계 — 새 결함으로 보고하지 마라).
8. **P2 인계**: 다음 단계가 무엇을 먼저 봐야 하는지(계약이 동결하지 못한 축의 목록 · helmet 등가 보안 헤더 공백 · Node 주석의 ADR 오인용 부채 · `DistributionTargetService.checkName`의 `String.trim()` 등).
9. **JDK 25 기준선 전환이 남긴 것**(④ 테스터 인계 · **작업 G**의 결과를 그대로 옮긴다): 이 phase 전체가 **포터블 Temurin JDK 25.0.4.1+1**에서 측정됐다는 사실 · `server-spring/pom.xml` `java.version=25`이고 `maven-compiler-plugin` 블록이 없다는 것(Spring Boot 부모가 `maven.compiler.release`로 전달) · **런타임 교체가 계약 관측을 하나도 흔들지 않았다**는 실측(전환 전후 296관측 diffs 0 동일) · 그리고 **G가 발견한 `Adr008DisciplineTest`의 JDK 25 표면 공백 목록과 그 처분**. 다음 phase가 그 공백을 메우려면 그 자체가 게이트 확장이며 별도 리뷰가 필요하다.
10. **환경 함정 기록**: 이 브랜치에는 `.github/modernize/java-upgrade/`(gitignore 대상)의 **VS Code GitHub Copilot App Modernization(java-upgrade) 세션**이 붙어 있었고, 그 세션이 포터블 JDK를 찾지 못해 **기준선 측정을 통째로 건너뛴 채** pom만 Java 25로 바꾼 커밋(`d1d5e84`)을 만든 전례가 있다. 그 커밋은 `wip-jdk25-upgrade`에 보존됐고 이 브랜치에서 제거됐으며, 이후 사용자 결정으로 **PR #119가 기준선을 정식으로 JDK 25로 옮겼다**(측정 동반). 세션 파일 4개에는 재개 금지 표지를 남겼으나 **재개되면 다시 pom을 건드릴 수 있다** — step0의 전제 확인(A0)이 그 자리를 지킨다. 이 사실을 다음 사람에게 그대로 넘겨라.

### G — **JDK 25가 ADR-008 정적 게이트에 여는 새 표면 조사**(④ 테스터 확인 항목 · 조사와 기록만 한다)

**배경(2026-08-30 계획 단계 실측)**: `Adr008DisciplineTest`의 5군 패턴은 **JDK 21 API 표면 기준**으로 작성됐다. 기준선이 JDK 25로 옮겨졌으므로(PR #119) JDK 22~25가 추가·정식화한 표면이 **패턴에 걸리지 않는 새 우회로**일 수 있다. 계획 단계에서 그 파일(908행)을 스캔한 결과 다음 문자열이 **0건**이다: `StructuredTaskScope` · `ScopedValue` · `Subtask` · `.fork(` · `.join(`. 반면 `Thread.of(Virtual|Platform)(`·`Thread.startVirtualThread(`·`Executors.new*(`는 **이미 걸린다**(가상 스레드 진입로는 이미 막혀 있다).

**이 게이트가 지금까지 매번 공허했다는 사실도 함께 기억하라** — 71a 12/12 통과 · 72 11/11 통과 · 73 8/10 통과. 즉 "green이니까 안전하다"가 아니라 **변이를 심어 red를 봤을 때만** 무엇이 잡히는지 알 수 있다.

1. **표면 열거**: JDK 25에서 정식화·추가된 동시성·파일·프로세스 API 중 이 게이트의 5군 취지(주기 실행 · 비동기/스레드 · 네트워크 · 파일 쓰기 · 외부 프로세스)에 해당하는 것을 열거하라. 최소로 확인할 것: `java.util.concurrent.StructuredTaskScope`(JEP 505 · `open()`/`fork()`/`join()`) · `java.lang.ScopedValue`(JEP 506 · `ScopedValue.where(...).run(...)`/`.call(...)`) · 모듈 import 선언(`import module java.base;`)이 **정규화되지 않은 이름 사용을 통해 패턴을 우회하는지**(패턴 대부분이 `\b식별자\b` 단어 매칭이므로 우회되지 않아야 한다 — 실제로 확인하라).
2. **비공허성 실증(각 항목 1회)**: 후보 철자를 `server-spring/src/main/java` 안의 **비-예외 파일 하나**(예: `ChangeBus.java`)에 한 줄 심고 `Adr008DisciplineTest`만 돌려 **red인지 green인지** 기록하라. **green이면 그것이 우회로다.** 심은 뒤 반드시 원복하고 `cmp`로 byte-identical을 확인하라.
3. **처분**: 우회로를 찾아도 **이 step에서 패턴을 추가하지 마라.** 이유: `Adr008DisciplineTest`는 이 phase 전체가 **0줄** 고치기로 못 박은 파일이고(AC 4), 게이트 확장은 그 자체가 아키텍처 결정이라 ADR·리뷰 게이트를 거쳐야 한다. 발견은 **표로 기록**해 `forward_notes` 9와 `server-spring/README.md`의 「ADR-008 규율은 정적 게이트가 지킨다」 절에 넘겨라.
4. **이 phase 자신의 소스에 대한 확인**(이건 지금 해야 한다): 이 phase가 만든 SSE 소스 전부(`SseHttp.java` · `ChangeBus.java` · `StreamController.java` · `LogsController.java` · `LogService.java` · `Authorization.java`)에 위 **JDK 25 신규 철자가 0건**임을 정적 스캔으로 단언하는 테스트가 있는지 확인하고(step2 항목 8 · step4 배경 9 · step5 항목 17이 각자 걸어 뒀다), 빠진 파일이 있으면 **그 스캔만** 더하라(게이트 파일이 아니라 이 phase 소유의 테스트에 넣는다). SSE는 서블릿 async를 쓰므로 **2군(비동기·스레드)과 정면으로 만나는 유일한 코드**다 — 여기가 가장 먼저 새는 자리다.

## Acceptance Criteria

```bash
# 1) A의 9커맨드 전건 exit 0 · 연속 2회 동일 수치(⑥의 알려진 flake는 재실행 2회로 판정)

# 2) ADR 순수 추가
git show <이 phase 시작 커밋>:docs/ADR.md > /tmp/adr-before.md
node -e "const fs=require('fs');const a=fs.readFileSync('/tmp/adr-before.md','utf8');const b=fs.readFileSync('docs/ADR.md','utf8');if(!b.startsWith(a)){console.error('ADR 순수 추가가 아니다');process.exit(1)}console.log('pure-append OK')"
#   (ADR-015는 step0이 이미 붙였으므로 기준은 **step0 직전** 커밋이다. step0 이후 커밋을 기준으로 하려면 ADR-013 ④ 문장이 파일 중간에 들어가므로 접두사 검사가 실패한다 —
#    그 경우 `git diff -U0 -- docs/ADR.md`로 **변경된 줄이 ADR-013 ④ 한 줄뿐**임을 확인하는 방식으로 대체하고, 그 사실을 기록하라.)

# 3) 무접촉 경로 — 이 phase 전체에 대해
git diff --stat <phase 시작 커밋>..HEAD -- contract docs/api-contract docs/news.md scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json spikes .github
#   기대: 출력 없음
#   (`docs/news.md`는 index.json 무수정 목록에 있는데 어느 AC도 확인하지 않았다 — ② 3차 검토 반영으로 여기 추가했다.
#    `.github`도 같은 이유다: `.github/modernize/`가 gitignore 대상이라 `git status`에 안 뜨므로 diff로만 확인된다.)

# 4) ADR-008 게이트 파일은 이 phase 전체에서 0줄 변경
git diff --stat <phase 시작 커밋>..HEAD -- server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java
#   기대: 출력 없음

# 5) RoutePolicy 0줄 · pom.xml 0줄(새 의존성 0)
git diff --stat <phase 시작 커밋>..HEAD -- server-spring/src/main/java/harness/news/web/RoutePolicy.java server-spring/pom.xml
#   기대: 출력 없음. pom은 base(`4543cea`)의 `java.version=25` 그대로여야 한다 — 이 phase는 pom을 0줄 고친다.

# 6) 합산 커버리지 게이트(D-2를 켰다면)
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --require-full-coverage
#   기대: exit 0 · 합산 covered=39/39 · 미커버 0쌍
```

**종료 조건 — 아래를 summary에 기록한다. 미기록 시 이 step은 미완이다.**
1. **마감 실측 전문**(9커맨드 × 2패스).
2. **변이 전건 결과표**(아래).
3. **`forward_notes` 10항목 작성 완료**(9=JDK 25 기준선·G의 표면 조사 결과 · 10=환경 함정).
4. **작업 G의 표면 조사 결과표 기록 완료** — 후보 철자별 red/green과 처분("패턴은 이 phase에서 추가하지 않는다")이 표로 남아야 한다. 미기록 시 이 step은 미완이다.

## 검증 절차 (변이)

| 변이 | 심는 곳 | 기대 |
|---|---|---|
| M6-1 | `StreamController.java`에 한정 이름 `@org.springframework.scheduling.annotation.Scheduled(fixedDelay=1000)` | `Adr008DisciplineTest` red — 예외 목록 4파일이 SSE에 열려 있지 않다는 실증 |
| M6-2 | `LogsController.java`에 `java.util.concurrent.Executors.newSingleThreadExecutor()` | `Adr008DisciplineTest` red |
| M6-3 | `SseHttp.java`에 `HttpClient.newHttpClient()` | `Adr008DisciplineTest` red(네트워크 군 — 예외 4파일이 아니다) |
| M6-4 | `ChangeBus.java`에 `Files.write(p, b)` | `Adr008DisciplineTest` red(파일 쓰기 군) |
| M6-5 | 예외 4파일 중 하나(`SpoolWriter.java`)에 `Thread.startVirtualThread(() -> {})` | `Adr008DisciplineTest` red — **군 교차 누출 금지**가 여전히 유효(73이 세운 완화책의 재확인) |
| M6-6 | scope 표에서 1행 삭제 | `--require-full-coverage` **exit 1** + 미커버 쌍 나열(D-3의 비공허 실증) |
| M6-7 | `SseHttp.CONTENT_TYPE`에서 공백 1개 제거 | `--parity` diff ≥ 1(SSE 관측 전부) — 마감 시점의 와이어 바이트 재확인 |
| M6-8 | `RawContentType.set(` 호출을 세 번째 클래스에 추가 | step2 항목 9(와이어 지점 2개 잠금) red |
| M6-9 | `ChangeBus.java`에 `java.util.concurrent.StructuredTaskScope` 사용 한 줄(JDK 25 정식 API) | **결과를 예단하지 마라** — 계획 단계 스캔에서 그 철자가 게이트 패턴에 0건이므로 **green(=우회로)일 가능성이 높다**. red든 green이든 그대로 기록하고 **패턴을 추가하지 마라**(작업 G-3). 원복 후 `cmp` byte-identical 확인 |
| M6-10 | `ChangeBus.java`에 `ScopedValue.where(V, x).run(() -> {})` 한 줄(JDK 25 정식 API) | 위와 동일 — 결과를 기록만 하고 게이트 파일은 0줄 유지 |
| M6-11 | **replay-gate 우회 재확인** — `LogsController`의 구독 등록을 `endPrelude` 뒤로 옮긴다 | **step5 항목 7(b)(d) red · 계약 green**(`--parity` 313관측 diffs 0 그대로). **[② 재검토 정정] "계약 B-4 red"를 기대하지 마라 — 달성 불가능하다**(B-4는 하한만 보고 그 하한이 replay 잔여·SSE 자신의 액세스 로그로 충족된다). 마감 시점에 **유일 방어선인 Java 경합 테스트가 여전히 살아 있는지** 재확인하는 자리다. Java red가 안 나면 반복 구성(≥50회·버퍼 2000건 이상)이 무너진 것이니 원인을 찾아 기록하라 |
| M6-12 | `LogService`의 `notifyLock` 제거 | step1 항목 5b red(seq 역전) · **계약은 green** — 계약이 못 보는 축이라는 사실의 마감 재확인 |

각 변이는 심고 → red 확인 → **원복 후 pristine 사본과 `cmp` byte-identical + `git status --porcelain` 무변**을 확인하고 표에 적어라. green→red→green 3단계를 모두 기록한다.

## 금지사항

- **프로덕션 코드를 고치지 마라.** 이유: 이 step은 마감이며, 여기서 코드가 바뀌면 앞 step들의 실측이 무효가 된다. 결함을 발견하면 그 step으로 되돌아가라.
- **`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`를 고치지 마라.** 이유: 정본 러너다. 합산 게이트는 `spring-contract.mjs`(가변)에 만든다.
- **합산 커버리지가 39/39가 아닌데 게이트를 켜지 마라.** 이유: 영구 red 게이트는 다음 사람이 무시하게 되고, 무시되는 게이트는 없는 것보다 나쁘다.
- **비공허성 실증 없이 게이트를 켜지 마라.** 이유: 71a·72·73이 매번 발견한 실패 양식이다(게이트가 켜져 있는데 아무것도 잡지 못한다).
- **`docs/ADR.md`의 결정 본문과 이전 phase 문장을 고치지 마라.** 이유: 각 문장은 그 시점의 기록이며 소급 수정은 이력을 오염시킨다.
- **알려진 flake를 숨기지 마라.** 이유: 73이 `npm test` 1건 실패를 재실행 2회로 판정하고 **기록했다**. 숨기면 다음 사람이 같은 시간을 다시 쓴다.
- **커밋·PR·머지를 임의로 하지 마라.** 이유: 이 리포에서 공유 브랜치로의 머지는 사용자 명시 승인이 필요하고, PR·머지 판단은 오케스트레이터 소유다.
- **`git add -A`를 쓰지 마라** — 명시 경로만.
