# Step 0: spring-skeleton

정식 Spring Boot 프로젝트 골격 `server-spring/`을 만든다. 이 step이 소유하는 것은 **빌드·설정·기동 경로**와 라우트 1개(`GET /api/health`)뿐이다. DB·세션·인증은 다음 step들이 올린다.

`GET /api/health`를 여기 넣는 이유: 계약 러너(`scripts/contract-run.mjs`)가 **모든 프로파일의 부팅 판정을 `/api/health` 200 `{ok:true}` 왕복으로** 한다. 이 라우트가 없으면 다음 step부터 하네스가 아예 돌지 않는다.

## 읽어야 할 파일

- `phases/68-spring-auth/index.json` — decisions **(1)(2)(4)(9)(13)(14)** · excluded · baseline(무접촉 목록·diff scope 규칙)
- `docs/porting-plan-cpp-spring.md` — §4 유지 불변식 8종, §6.1 Express→Spring 매핑 표
- `docs/api-contract/README.md` — "정본 관계"·"측정 조건"(SPA_DIR 미설정·외부 키 미설정 등)
- `docs/api-contract/endpoints.json` — `health` 행(`expect: ["success"]`, notes "응답 `{ok:true}` 고정")
- `docs/api-contract/openapi.yaml` — `health` 오퍼레이션(응답 스키마의 형식 본보기)
- `docs/ARCHITECTURE.md` — "디렉토리 구조"·"패턴"(백엔드 계층 규율)
- `docs/ADR.md` — ADR-002(직접 SQL)·ADR-006(계층)·ADR-004(신뢰 경계) — 이식 대상 규율
- `spikes/p0-spring/pom.xml` · `spikes/p0-spring/mvnw` · `spikes/p0-spring/.mvn/wrapper/maven-wrapper.properties` · `spikes/p0-spring/.gitignore` — **참고·복사 원본(수정 금지)**
- `spikes/p0-spring/src/main/resources/application.properties` — 스파이크가 절대경로를 하드코딩한 예(이 step은 그렇게 하지 않는다)

## 배경

- **툴체인**: 시스템 `java`는 1.8뿐이다. 포터블 JDK 21이 `D:\agents\tools\jdk-21.0.12+8`에 있고, **`JAVA_HOME`을 명시하지 않으면 빌드가 1.8로 떨어져 실패**한다. Maven은 리포에 설치하지 않고 mvnw 래퍼를 쓴다 — 스파이크의 래퍼 설정(래퍼 3.3.4 / maven 3.9.16)이 `~/.m2/wrapper/dists`에 이미 캐시돼 있으므로 **같은 값을 복사**하면 네트워크 없이 뜬다.
- **의존성 캐시 실측(계획 시점)**: `~/.m2/repository`에 `spring-boot-* 4.1.0`·`sqlite-jdbc 3.47.2.0`·`spring-security-crypto`가 있다. Spring Boot 4에서는 web 스타터 이름이 `spring-boot-starter-webmvc`, 테스트는 `spring-boot-starter-webmvc-test`다(스파이크 pom이 실증).
- **npm 파이프라인 무관**: `eslint`는 `**/*.js`만 보고 `npm test`는 `test/**/*.test.js` 글롭이다. `server-spring/`에는 `.js` 파일을 두지 않으므로 두 파이프라인이 영향을 받지 않아야 한다(그 사실을 AC로 확인한다).

## 작업

### A. Maven 모듈 골격 `server-spring/`

1. `pom.xml` — parent `spring-boot-starter-parent:4.1.0`, `<java.version>21</java.version>`, groupId `harness`, artifactId `server-spring`. 의존성은 **이 step에서 필요한 최소**만: `spring-boot-starter-webmvc`, 테스트 `spring-boot-starter-webmvc-test`. (DB·BCrypt 의존성은 step2·step4가 각자 추가한다 — 안 쓰는 의존성을 미리 넣지 않는다.)
2. 래퍼 3종을 `spikes/p0-spring`에서 복사: `mvnw` · `mvnw.cmd` · `.mvn/wrapper/maven-wrapper.properties`(내용 무변경 — 캐시 히트 목적).
3. `server-spring/.gitignore` — 최소한 `target/`, `data/`, `*.log`, `.mvn/wrapper/maven-wrapper.jar`. **빌드 산출물·DB 사본은 커밋 금지**.
4. `server-spring/README.md` — 빌드·테스트·실행 커맨드(JAVA_HOME 명시 형태 그대로), 이 모듈이 npm 파이프라인과 분리돼 있다는 사실, 설정 키 ↔ 환경변수 대응표(작업 C), "이 서버는 스키마를 만들지 않는다"(decisions (4))는 한 줄.

### B. 패키지 구조

`harness.news` 아래 `config` · `db` · `model` · `service` · `controller` · `web`(필터·와이어 포맷)로 나눈다. 이 step에서는 실제로 클래스가 생기는 패키지만 만든다(빈 패키지 금지). 계층 규율은 decisions (13): 컨트롤러는 shape 매핑만, 서비스는 서블릿 타입을 import하지 않는다, 주입은 **생성자 주입만**.

### C. 설정 바인딩 (`config`)

- `@ConfigurationProperties("app")` 바인딩 타입 1개를 만든다. 이 step이 정의하는 키:
  - `app.data-dir` — **필수**. 없으면 기동 실패(명확한 메시지: 무슨 키가 없고 어떤 환경변수로 주는지). 이유는 금지사항 참조.
  - `app.env` — `production`이면 프로덕션 분기(쿠키·CSRF). 기본값은 비프로덕션.
  - `app.allowed-origins` — 콤마 구분 목록, 기본 빈 목록.
- `src/main/resources/application.properties`는 **절대경로를 하드코딩하지 않는다**. 값은 OS 환경변수에서 온다(`DATA_DIR`·`PORT`·`HOST`·`APP_ENV`·`ALLOWED_ORIGINS`). 어떤 환경변수가 어떤 키로 들어오는지는 README 표에 적는다.
- `java.time.Clock` 빈을 하나 정의한다(decisions (14) — 이후 세션 만료·계정 잠금·로그 다이제스트가 전부 이것을 주입받는다). 프로덕션 빈은 시스템 시계, 테스트는 고정 시계를 주입할 수 있어야 한다.

### D. `GET /api/health`

- 200 `{"ok":true}` — **정확히 1키**. 컨트롤러는 `controller` 패키지.
- 응답 Content-Type을 **실측**해 요약에 적는다(step5 decisions (9)의 입력이 된다 — 여기서 고치지는 않는다).

### E. 테스트(먼저 쓴다)

1. **와이어 테스트**: `@SpringBootTest(webEnvironment = RANDOM_PORT)` + 원시 HTTP 클라이언트로 `/api/health` 호출 → status 200 · 본문 키 집합이 정확히 `{ok}` · `ok == true` · Content-Type 문자열 관측. **MockMvc를 쓰지 마라**(금지사항 참조).
2. **설정 가드 테스트**: `app.data-dir` 미설정으로 컨텍스트를 띄우면 기동이 실패하고, 실패 메시지에 키 이름이 들어간다.

TDD 순서: 위 두 테스트를 먼저 작성해 **red를 눈으로 확인**한 뒤 구현한다(요약에 red 관측을 적는다).

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests && ls target/*.jar
cd /d/agents/harness && npm test
cd /d/agents/harness && npm run lint
cd /d/agents/harness && node scripts/contract-inventory-check.mjs
cd /d/agents/harness && git status --porcelain
```

## 검증 절차

1. **red 먼저**: E의 두 테스트를 구현 전에 돌려 실패를 관측하고 요약에 남긴다.
2. `verify`가 green이면 `package`로 실행 가능한 jar가 나오는지 확인한다(step1의 하네스가 이 jar를 띄운다). jar 경로를 요약에 적는다.
3. **수동 기동 실측 1회**: 임시 디렉토리를 `DATA_DIR`로 주고 임의 포트로 jar를 띄운 뒤 `/api/health`를 호출해 status·본문·**Content-Type 문자열 원문**을 요약에 기록한다. 확인 후 프로세스를 반드시 종료한다.
4. `npm test`가 **1328/1328**인지 확인한다(늘거나 줄면 회귀 — 이 step은 `test/**`·`package.json`을 건드리지 않는다).
5. `npm run lint` clean — `server-spring/`에 `.js` 파일이 없으므로 lint 대상이 늘지 않아야 한다.
6. `contract-inventory-check` exit 0 — 이 스크립트는 `server/**`의 `.js`만 스캔한다. `server-spring/`이 스캔에 끼어들지 않았는지 출력(routes=39)으로 확인한다.
7. `git status --porcelain` 증분이 소유 파일뿐인지 확인한다: `server-spring/`의 pom·래퍼 3종·`.gitignore`·`README.md`·`src/main/**`·`src/test/**`, `phases/68-spring-auth/index.json`. **`server-spring/target/`이 증분에 보이면 `.gitignore`가 잘못된 것이다.**
8. 의존성 해석에 네트워크가 필요했는지(캐시 히트 여부)를 요약에 기록한다 — step2의 오프라인 폴백 판단 입력이다.
9. `phases/68-spring-auth/index.json`의 step0 status·summary를 갱신한다(실측 Content-Type·jar 경로·red 관측 포함).

## 금지사항

- `spring-boot-starter-security`·`spring-session-*`을 추가하지 마라. 이유: 전 라우트 기본 잠금과 프레임워크 기본 401/403 응답 shape이 계약(`{ok:false, reason:...}` JSON)과 충돌하고, 로그인 폼·CSRF 토큰 기본 동작이 계약 스위트를 무너뜨린다(스파이크 `pom.xml` 주석의 실측 경고).
- 이 step에서 DB·JDBC 의존성을 추가하지 마라. 이유: 이 step에는 DB를 여는 코드가 없다. 안 쓰는 의존성이 들어가면 step2의 오프라인 폴백 판정(decisions (3))이 흐려진다.
- `MockMvc`로 와이어 계약을 판정하지 마라. 이유: 이 phase의 합격 기준은 **실제 HTTP 바이트**(헤더 문자열·Set-Cookie 직렬화)이고 MockMvc는 서블릿 컨테이너의 직렬화 경로를 그대로 재현하지 않는다. 전 기동(RANDOM_PORT) + 원시 HTTP만 쓴다.
- `application.properties`에 절대경로(리포 경로·`web/dist`·`news.db`)를 하드코딩하지 마라. 이유: 스파이크는 일회성이라 그렇게 했지만, 정식 서버가 그러면 하네스가 프로파일별 임시 DATA_DIR을 주입할 수 없고 **리포 `news.db`를 여는 사고**로 직행한다.
- `app.data-dir` 기본값을 cwd나 리포 경로로 두지 마라. 이유: 설정 누락이 조용히 리포 `news.db`를 여는 경로가 된다 — DB 비파괴 규칙의 1차 방어선은 "모르면 뜨지 않는다"이다(불변식 7: 런타임 탐지보다 명시 주입).
- `spikes/**`를 수정하지 마라(복사만 한다). 이유: P0 스파이크는 go/no-go 판정 근거로 보존되는 증거물이다.
- `package.json`·`test/**`·`server/**`·`src/**`·`contract/**`·`docs/api-contract/**`를 건드리지 마라. 이유: Node 서버·계약은 이 phase에서 무수정이 규율이다(decisions (17)). 이 step은 npm 쪽 파일을 하나도 바꾸지 않는다.
- `git add -A`를 쓰지 마라. 이유: 작업 트리에 사용자 소유 미커밋 파일이 있다(index.json baseline 참조).
