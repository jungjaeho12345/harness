# Step 0: spring-skeleton

첫 Spring **구현** phase(포팅 로드맵 P1)의 서버 골격을 만든다. 이 phase는 auth/session 도메인 묶음까지만 구현한다 — articles/collection/distribution/media/full-logs/SSE는 후속 phase(69+) 범위다.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도·계약을 파악하라:

- `/home/user/harness/CLAUDE.md` (규칙: DB 비파괴 · 매 작업 Slack · TDD · conventional commits · UTF-8)
- `/home/user/harness/docs/ADR.md` (특히 ADR-001 경계 · ADR-004 세션 인가 · ADR-006 계층 분리 · ADR-009 CSRF)
- `/home/user/harness/docs/porting-plan-cpp-spring.md` (§6.1 Express→Spring 매핑 · §7 P1)
- `/home/user/harness/spikes/p0-spring/**` — **참고용 스파이크**(프로덕션 아님). `pom.xml`·`CONTRACT.md`·`src/main/java/harness/p0_spring/*.java`(ApiController·SessionStore·NewsDb·SpaFallback·WebConfig)·`.mvn/wrapper/**`·`mvnw`. 구조·의존성·부트 시퀀스를 그대로 참고하되 코드를 복사만 하지 말고 이 phase의 계약(읽기전용 아님·세션 가드·잠금)에 맞게 재작성한다.
- `/home/user/harness/docs/api-contract/README.md`, `docs/api-contract/endpoints.json`(라우트 id: `health`)
- `/home/user/harness/spikes/p0-spring/CONTRACT.md` — `GET /api/health` 계약(200 `{"ok":true}` · 1줄)

## 작업

새 프로덕션 서버 모듈 `server-spring/`(리포 루트 하위)을 만든다. **`spikes/p0-spring/`은 건드리지 않는다.**

1. Maven 프로젝트: `server-spring/pom.xml`
   - parent `spring-boot-starter-parent`(스파이크와 동일 버전 `4.1.0`), `java.version` = 21.
   - 의존성: `spring-boot-starter-web`(=webmvc), `org.xerial:sqlite-jdbc`(스파이크와 동일 버전), `org.springframework.security:spring-security-crypto`(BCrypt 검증 전용 — **`spring-boot-starter-security`는 금지**: 전 라우트 기본 잠금으로 계약이 깨진다), 테스트 `spring-boot-starter-test`.
   - `groupId` = `harness`, `artifactId` = `server-spring`, 패키지 base = `harness.server`(스파이크의 `harness.p0_spring`와 구분).
   - Maven Wrapper 포함(`server-spring/mvnw`·`.mvn/wrapper/**` — 스파이크에서 복사하거나 `mvn -N wrapper:wrapper`). AC가 `./mvnw`로 돈다.
2. 부트 클래스 `Application`(`@SpringBootApplication`). Spring Security auto-config가 클래스패스에 없으므로 별도 제외 불필요하나, 혹시 들어오면 `@SpringBootApplication(exclude=...)`로 보안 자동설정을 끈다.
3. **설정 주입(단일 출처)**: 서버 구성을 환경변수/커맨드라인 인자로 주입받는 `AppConfig`(`@ConfigurationProperties(prefix="app")` 또는 `@Value`)를 만든다. 최소 키:
   - `app.db-path` — SQLite 파일 경로(읽기/쓰기 대상. step1이 소비). **리포 `news.db`를 기본값으로 두지 마라** — 기본값 없이 주입 필수로 하거나, 미주입 시 부팅 실패시킨다.
   - `app.prod-cookie` (boolean, 기본 false) — 세션 쿠키 속성 모드(step3이 소비: true=Secure+SameSite=None, false=SameSite=Lax). 이 step에서는 값만 바인딩한다.
   - 포트/호스트는 표준 `server.port`·`server.address`로 주입(스파이크 방식).
4. `GET /api/health` 컨트롤러 → 200 `application/json` `{"ok":true}`(정확 1키). httpModel은 상태코드가 아니라 JSON 본문만 읽으므로 **모든 응답은 JSON 바디 필수**라는 원칙을 이 골격부터 잠근다.
5. **구현 금지 표면(계약)**: CORS·CSRF Origin 가드·CSP·HTTPS 강제·전역 레이트리밋을 넣지 마라. 동일 출처 배치에서 no-op이며 어설픈 재현(Origin==Host)은 로그인 POST를 403시킨다(spikes CONTRACT.md "구현 금지"). (단 `/api/login` 전용 IP 레이트리밋은 step3에서 별도로 넣는다.)
6. 정적 서빙/SPA 폴백은 이 phase 범위 밖(계약 하네스가 `SPA_DIR=''` 동형으로 39 라우트만 측정). 넣지 마라.

시그니처는 재량이되 다음 핵심 규칙을 박아라: 응답 JSON은 `LinkedHashMap`/명시 shape로 키 순서·집합을 계약과 일치, health는 `{ok:true}` 정확 1키.

## Acceptance Criteria

```bash
# server-spring 빌드 + 이 step의 테스트 통과
cd /home/user/harness/server-spring && ./mvnw -q -DskipTests=false test

# health 라우트 실측(테스트로 커버되면 생략 가능) — MockMvc 테스트가 GET /api/health → 200 {"ok":true} 를 단언
```

- 최소 1개 Spring 테스트(`@SpringBootTest`+`MockMvc` 또는 `@WebMvcTest`)가 `GET /api/health` → 200 · body `{"ok":true}` · `Content-Type: application/json`을 단언한다(TDD: 먼저 실패하는 테스트 작성 → 구현 → green).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `server-spring/` 신설이며 `spikes/p0-spring/`·`server/`·`src/`·`web/`·`contract/`·`docs/`는 한 줄도 바뀌지 않았는가?
   - `spring-boot-starter-security`를 넣지 않았는가(BCrypt는 `spring-security-crypto`만)?
   - CORS/CSRF/CSP/HTTPS강제/전역 레이트리밋을 넣지 않았는가?
   - DB 경로가 주입 단일 출처이고 리포 `news.db`를 기본값으로 두지 않았는가?
3. 결과 반영: 성공 → index.json step0 `completed` + `summary`(모듈 경로·패키지 base·주입 키·health 테스트). Maven 의존성 다운로드가 프록시/네트워크로 막히면 → `blocked` + `blocked_reason`(구체 사유·재현 커맨드). 3회 자가교정 후에도 컴파일/테스트 실패면 → `error` + `error_message`.

## 금지사항

- `spikes/p0-spring/`를 수정·재사용(같은 패키지로 이동)하지 마라. 이유: 스파이크는 탐색 산출물이고, 프로덕션 서버는 독립 모듈로 계약을 다시 잠가야 검토가 독립적이다.
- `spring-boot-starter-security`를 추가하지 마라. 이유: 전 라우트 기본 인증 필터가 걸려 SPA·계약이 죽는다(BCrypt 검증만 필요하면 `spring-security-crypto`로 충분).
- 리포 루트 `news.db`를 DB 경로 기본값/테스트 대상으로 삼지 마라. 이유: DB 비파괴 최상위 규칙 — 계약 하네스와 테스트는 임시 시드 DB만 연다.
- `server/**`·`src/**`·`web/**`·`contract/**`·`docs/**`·`package.json`을 수정하지 마라. 이유: 이 step은 신규 Java 모듈만 추가한다(기존 npm test 1328 불변).
- 기존 테스트를 깨뜨리지 마라.
