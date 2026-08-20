# Step 3: session-core

세션 스토어와 **세션 가드**를 만든다. HTTP도 컨트롤러도 없는 순수 서비스 계층이며, 이 phase에서 가장 보안 민감한 축이다.

phase 67 ④ 테스트 게이트가 이 축의 공백을 발견해 계약 케이스로 잠갔다: `sessionGuard.revalidate`를 "세션 스토어가 준 신원을 그대로 반환"하도록 변이했더니 계약 스위트 267 케이스가 **전부 green**이었다. 그 공백을 메우려고 `contract/cases/default/session-guard.contract.js`가 만들어졌다 — **Spring이 이 가드를 빼먹으면 비활성화·강등된 계정이 최대 1시간 이전 권한을 유지하는 권한 상승이 된다.**

## 읽어야 할 파일

- `phases/68-spring-auth/index.json` — decisions **(10)(13)(14)** · forward_notes (8)
- `src/services/sessionService.js` — **이식 원본**(69행). `IDENTITY_FIELDS` 5필드 투영, 로그인 시 같은 userId 세션 전멸, 1시간 슬라이딩, `liveSession`의 만료 판정 단일 지점, `peekSession`(비연장)
- `src/services/sessionGuard.js` — **이식 원본**(48행). 매 호출 User 행 재조회, 행 없음·`active='N'`이면 세션 **무효화**(같은 토큰으로 다시 통과 불가), 화이트리스트 투영으로 재도출, "캐시/타이머는 두지 않는다"는 주석의 근거
- `contract/cases/default/session-guard.contract.js` — 이 축이 **어떻게 검증되는지**(강등 → 재로그인 없이 403 / `GET /api/session`의 role이 DB 최신값 / `active='N'` 즉시 401 / 무효화의 영구성)
- `contract/cases/default/auth.contract.js` — 단일 세션 정책 케이스(이전 토큰 401), 세션 user 정확 5키
- `docs/ADR.md` ADR-004 — "로그인 시점 스냅샷이 아니라 매 요청 User 행 재조회로 재도출", 캐시·TTL 금지
- `docs/api-contract/openapi.yaml` — 최상위 `x-cross-cutting.sessionTransport`(단일 세션 정책 문구)
- `server-spring/src/main/java/.../model` (step2 산출물) — `User` 리포지토리 시그니처

## 배경 (동결된 계약 사실)

- 토큰은 **64-hex 랜덤**이며 역할·신원 정보를 담지 않는다(`sessionId` 정규식 `^[0-9a-f]{64}$`가 계약 케이스에 있다).
- 만료는 **1시간 슬라이딩**: 인증된 요청마다 갱신된다. 단 **비연장 조회(peek)** 경로가 따로 있어야 한다(SSE가 세션을 무한 연장하지 못하게 하는 축 — SSE 자체는 이 phase 범위 밖이지만 API는 여기서 만든다).
- **단일 세션 정책**: 로그인 성공은 같은 `userId`의 기존 세션을 **전부** 제거한다. 계약 스위트 전체가 이 정책 위에서 돌고 있어(케이스가 파일 끝에서 공용 세션을 복구한다) 다중 세션을 허용하면 계약이 red가 된다.
- **세션 가드**: 세션이 살아 있어도 매번 User 행을 다시 읽어 (1) 행이 없거나 `active='N'`이면 **세션을 스토어에서 제거**하고 거부 (2) 그 외에는 신원을 **DB 최신값으로 재도출**한다. 캐시·TTL·타이머 금지.
- 신원 투영은 정확히 5필드(`userId, role, department, departmentCode, name`) — 비밀번호·잠금 메타는 절대 담지 않는다.

## 작업

### A. `service` 패키지 — 세션 스토어

- 연산 4개: 세션 생성(사용자 행 → 토큰) · 갱신 조회(touch, 슬라이딩 연장) · 비연장 조회(peek) · 무효화.
- 저장은 **in-process**(동시성 안전 맵). 외부 스토어·Spring Session 금지(decisions (10)).
- 토큰 생성은 암호학적 난수 32바이트 → 소문자 hex 64자.
- 만료 판정은 **한 곳**에서만 한다(만료된 항목은 조회 시 제거).
- 시각은 주입된 `Clock`에서만 읽는다(decisions (14)).
- 생성 시 같은 `userId`의 기존 항목을 전부 제거한다.

### B. `service` 패키지 — 세션 가드

- 스토어와 **같은 인터페이스**를 갖는 데코레이터로 만든다(Node와 동형 — 소비처는 가드만 주입받고 스토어를 직접 보지 못한다).
- touch/peek 결과에 대해 매번 `User` 행을 재조회 → 행 없음·`active='N'`이면 **무효화 후 빈 결과**, 그 외에는 DB 행에서 5필드 투영으로 재도출.
- **캐시·TTL·백그라운드 갱신을 넣지 마라**(금지사항 참조).

### C. 합성 루트

- 인증이 필요한 모든 소비처가 **가드만** 주입받도록 빈 구성을 잡는다(스토어 빈을 컨트롤러·필터에 직접 노출하지 않는다). 로그인 시 세션 생성 경로만 예외적으로 스토어 기능이 필요하지만, 그 역시 가드를 통해 위임한다(Node의 `createSession` 위임과 동형).

### D. 테스트(먼저 쓴다 — 전부 고정 시계 주입)

1. 토큰 형식(64-hex)·유일성.
2. 슬라이딩: TTL 직전 touch → 갱신되어 이후에도 유효 / TTL 경과 후에는 무효(경계값 포함).
3. **peek는 연장하지 않는다**: peek만 반복하면 TTL 경과 시점에 만료된다.
4. **단일 세션**: 같은 userId로 두 번 생성하면 첫 토큰이 무효.
5. **가드 — 강등**: 세션 생성 후 DB의 role을 바꾸면 다음 조회의 신원 role이 **새 값**이다(재로그인 없음).
6. **가드 — 비활성화**: `active='N'`으로 바꾸면 그 세션이 즉시 무효이고, **같은 토큰으로 다시 조회해도 계속 무효**(스토어에서 제거됐다는 음성 증거).
7. **가드 — 행 삭제 상황**: 행이 없으면 무효(테스트에서 행을 지우지 말고, 처음부터 없는 userId의 세션을 만들어 재현한다 — DB 비파괴).
8. 투영: 반환 신원에 비밀번호·잠금 컬럼 키가 **없다**.

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && node scripts/spring-contract.mjs --boot-check --profile auth-negative --profile prod-cookie
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

## 검증 절차

1. red 먼저(D의 8개 테스트). 특히 5·6은 **가드가 없으면 반드시 실패**해야 한다 — 구현 전 red를 확인해 요약에 남긴다.
2. **변이 실증 2종**(확인 후 원복): (a) 가드의 재조회를 제거하고 스토어 신원을 그대로 반환 → 테스트 5·6이 red인가(phase 67이 발견한 바로 그 공백을 Java 쪽에서 재현·차단), (b) 생성 시 기존 세션 제거를 빼면 → 테스트 4가 red인가.
3. 동시성 점검: 같은 세션에 대해 touch를 여러 스레드에서 호출해도 예외·데이터 경합이 없는지 간단히 확인한다(맵 선택이 적절한지의 근거).
4. `--boot-check` 2 프로파일이 여전히 green인지(기동 회귀 없음).
5. `git status --porcelain` 증분 = `server-spring/src/main/**` · `server-spring/src/test/**` · `phases/68-spring-auth/index.json`.
6. index.json step3 status·summary 갱신(변이 실증 결과 포함).

## 금지사항

- 세션 신원을 캐시하거나 TTL을 두지 마라(가드 결과 캐시 포함). 이유: 캐시 창이 곧 무효화 지연이고, 그 지연이 **비활성화·강등된 계정의 권한 유지 시간**이다(ADR-004의 명시 결정). PK 조회 1회는 마이크로초다.
- `spring-boot-starter-security`·Spring Session·`HttpSession`을 쓰지 마라. 이유: 세션 토큰의 형식(64-hex)·수명·단일 세션 정책·쿠키 속성이 전부 계약으로 동결돼 있어 프레임워크 기본 동작(JSESSIONID·세션 고정 보호·쿠키 속성)과 충돌한다.
- 이 계층에서 서블릿·HTTP 타입을 import하지 마라. 이유: ADR-006 계층 규율 — 서비스는 transport 비의존이어야 테스트가 HTTP 없이 이 축을 전수 검증할 수 있다.
- 세션 토큰을 로그·예외 메시지·`toString()`에 넣지 마라. 이유: 세션 토큰 자체가 권한이다(ADR-004·LOGS.md 마스킹).
- 주기 정리 타이머(스케줄러)를 만들지 마라. 이유: ADR-008의 "앱 내 타이머 0" 규율이며, 만료는 조회 시점 판정으로 충분하다(Node 동형). `@Scheduled`·`@EnableScheduling` 금지.
- 세션 만료를 쿠키 `Max-Age`에 위임하지 마라. 이유: 만료의 단일 진실은 서버 스토어이고 쿠키는 보조다(Node 주석이 명시).
- HTTP 컨트롤러·필터를 이 step에서 쓰지 마라. 이유: 다음 step들의 범위이며, 층을 섞으면 실패 원인 격리가 무너진다.
