# Step 0: spring-skeleton

## 목표
`server-spring/` 아래에 Spring Boot(Maven, Java 21) 프로젝트 골격을 만들고 **공개 `GET /api/health` → 200 `{"ok":true}`** 하나만 구현한다. 환경 경로·포트·쿠키 모드는 **전부 환경변수로 외부화**한다(스파이크의 `D:/` 하드코딩·전 라우트 기본잠금 결함을 반복하지 마라). 이 step은 DB 접근을 하지 않는다(health는 DB 불필요).

## 배경 (이 파일만으로 자기완결적)
- 이 phase는 Node/Express 서버(`server/index.js`)의 auth/session 슬라이스를 Spring으로 재구현하는 포팅의 첫 step이다. 계약은 이미 동결돼 있다(`docs/api-contract/**`, `contract/**`).
- 과거 세션에서 이 골격을 만들었으나 커밋 전 소실됐다 — 리포에 `server-spring/`이 없다는 전제로 새로 만든다.
- 참고 코드는 `spikes/p0-spring/`에 있으나 **그대로 베끼지 마라**: (a) 경로 `D:/` 하드코딩 금지, (b) `spring-boot-starter-security`(전 라우트 기본 잠금) 금지 — bcrypt 검증만 필요하면 `spring-security-crypto`만 쓴다, (c) 사본 DB 경로 하드코딩 금지 — 경로는 `APS_DB_FILE` 환경변수로만 받는다(이 step에서는 아직 안 씀).

## 읽어야 할 파일
- `docs/porting-plan-cpp-spring.md` §6.1(서버 매핑)·§4(불변식 8건) — 계층 규율·경계.
- `docs/ADR.md` ADR-006(얇은 transport + 계층형)·ADR-004(신뢰 경계=서버) — 요약만.
- `spikes/p0-spring/pom.xml`, `spikes/p0-spring/src/main/java/harness/p0_spring/P0SpringApplication.java`, `.../ApiController.java`(health 부분), `spikes/p0-spring/CONTRACT.md`(health 절) — 참고용. 결함(위 배경) 유의.
- `spikes/p0-spring/mvnw`, `mvnw.cmd`, `.mvn/`(있다면) — Maven 래퍼를 새 프로젝트로 복사해 오프라인/재현성 확보.

## 환경변수 계약 (이 phase 전체의 정본 — 이 step이 정의, 이후 step·하네스가 준수)
| 변수 | 필수 | 의미 |
|---|---|---|
| `APS_DB_FILE` | 예(step2부터) | SQLite `news.db` 절대 경로(하네스가 시드한 임시 파일). 미설정 시 **하드코딩 폴백 없이 부팅 실패**. 이 step은 읽지 않는다. |
| `PORT` | 예 | HTTP listen 포트. `server.port`에 매핑. |
| `HOST` | 아니오(기본 `127.0.0.1`) | bind 주소. `server.address`에 매핑. |
| `APS_PROD_COOKIE` | 아니오(기본 `false`) | `true`면 세션 쿠키 Secure+SameSite=None, 아니면 SameSite=Lax·Secure 없음(step3에서 사용). |

## 작업 (TDD — 테스트 먼저)
1. `server-spring/pom.xml`: parent `spring-boot-starter-parent`(스파이크와 동일 버전 계열), Java 21. 의존성은 **최소**로: `spring-boot-starter-web`(또는 스파이크의 `-webmvc` 계열, 스파이크 pom과 동일 아티팩트명 사용), 테스트 스타터. **`spring-boot-starter-security` 넣지 마라.** `<build><finalName>spring-auth</finalName>` 지정 → 산출물 경로를 `server-spring/target/spring-auth.jar`로 결정화(하네스가 이 고정 경로를 쓴다).
2. `server-spring/src/main/java/harness/spring_auth/SpringAuthApplication.java`: `@SpringBootApplication` 부트 클래스.
3. 설정 외부화: `PORT`→`server.port`, `HOST`→`server.address`를 환경변수에서 읽도록 `application.properties`(예: `server.port=${PORT}`, `server.address=${HOST:127.0.0.1}`)로 매핑. 하드코딩 포트/주소 금지.
4. **테스트 먼저**: `src/test/java/.../HealthControllerTest.java` — MockMvc로 `GET /api/health` → status 200 + JSON 본문 정확히 `{"ok":true}`(키 1개, 값 true)를 단언.
5. `HealthController`: `@GetMapping("/api/health")` → `{"ok":true}` 반환(공개, 인증 없음).
6. `server-spring/mvnw`·`mvnw.cmd`·`.mvn/`을 스파이크에서 복사(빌드 재현성).
7. 루트 `.gitignore`에 `server-spring/target/` 추가(빌드 산출물 커밋 금지).

## Acceptance Criteria (실행 커맨드)
```bash
# 1) Spring 유닛 테스트(MockMvc health) green
mvn -f server-spring/pom.xml -q test
# 2) 부트 가능한 jar 산출(고정 경로)
mvn -f server-spring/pom.xml -q -DskipTests package && test -f server-spring/target/spring-auth.jar
# 3) 실제 부팅 + health 왕복(환경변수 외부화 실증 — 하드코딩 포트 아님)
PORT=46990 HOST=127.0.0.1 java -jar server-spring/target/spring-auth.jar & SPRING_PID=$!; \
  for i in $(seq 1 60); do curl -sf http://127.0.0.1:46990/api/health && break || sleep 1; done; \
  RESULT=$(curl -s http://127.0.0.1:46990/api/health); kill $SPRING_PID; \
  echo "$RESULT" | grep -q '{"ok":true}'
# 4) Node 계약 스위트(현행)가 무영향인지 — server-spring 신설은 Node 러너에 무관
npm run lint
```
- 위 3)의 마지막 `grep`이 exit 0이어야 한다(health 본문 정확 일치).

## 검증 절차
- `mvn ... test` 로그에 HealthControllerTest 1건 pass 확인.
- jar 부팅 로그에 `D:/`·하드코딩 경로 문자열이 없어야 한다. 포트가 46990(환경변수)으로 뜨는지 확인.
- Maven이 의존성을 받지 못하면(오프라인/프록시 차단) 임의 하향(offline 스킵) 하지 말고 index.json step0 status를 `blocked` + `blocked_reason`(Maven 의존성 해석 실패, 필요한 저장소/프록시 설정)으로 기록하고 중단.

## 금지사항
- `spring-boot-starter-security`를 넣지 마라. 이유: 기본 시큐리티 필터가 전 라우트를 401로 잠가 이후 계약 케이스가 전부 깨진다(스파이크 pom 주석의 실측 함정).
- DB 경로·포트·bind 주소를 코드/properties에 하드코딩하지 마라. 이유: 하네스가 프로파일마다 다른 임시 DB·포트로 띄운다 — 하드코딩이면 프로파일 격리가 불가능하다.
- health 외 라우트를 만들지 마라. 이유: 이 step은 골격만이다. login/session 등은 step3~5 소유.
- 어떤 DataSource/JDBC 연결도 이 step에서 열지 마라. 이유: DB 접근은 step2에서 도입한다(이 step 부팅은 DB 없이 성립해야 한다).
