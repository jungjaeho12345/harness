# server-spring

기사 작성기의 **Spring Boot 서버**다(포팅 계획서 P1 — REST 계약 패리티 대상). 현행 Node 서버(`server/**`·`src/**`)와
**공존**하며, 두 서버가 같은 계약(`docs/api-contract/**`)을 만족하는지는 계약 스위트(`contract/**`)가 판정한다.
계약과 다르면 **Spring을 고친다** — Node·계약은 이 포팅에서 무수정이다.

- 좌표: groupId `harness` · artifactId `server-spring` · base package `harness.news` · Java 21 · Spring Boot 4.1.0
- 계층: `controller → service → repository → db` (컨트롤러는 shape 매핑만, 서비스는 서블릿 타입 비의존, **생성자 주입만**)
- 현재 구현 범위(phase 68 step0): 빌드·설정·기동 경로 + `GET /api/health` 하나. DB·세션·인증은 후속 step이 올린다.

## 이 서버는 스키마를 만들지 않는다

DDL을 **한 줄도 실행하지 않는다**: `ddl-auto`·`schema.sql`·`data.sql`·Flyway·Liquibase 전부 금지이고 코드에도
`CREATE`/`ALTER`/`DROP` 문자열이 없다. 스키마 생성·마이그레이션은 Node 서버(`src/db/schema.js`)가 소유한다.
행 삭제 SQL도 0이다(무효화는 soft delete·UPDATE로만).

같은 이유로 **`app.data-dir`은 필수**다. 미설정이면 기동을 거부한다 — 경로를 추정하면 설정 누락이 조용히
리포의 `news.db`를 여는 사고가 된다("모르면 뜨지 않는다").

## 빌드 · 테스트 · 실행

시스템 `java`는 1.8이라 **`JAVA_HOME`을 명시하지 않으면 빌드가 실패한다**. 포터블 JDK 21을 쓴다.

```bash
# 테스트 포함 전체 빌드
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify

# 실행 가능한 jar 만들기 (target/server-spring-0.0.1-SNAPSHOT.jar)
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B package -DskipTests

# 기동 (DATA_DIR 필수 — 아래 표 참조)
DATA_DIR=/경로/임시데이터 PORT=15731 "D:/agents/tools/jdk-21.0.12+8/bin/java.exe" \
  -jar target/server-spring-0.0.1-SNAPSHOT.jar

# 생존 확인
curl -i http://127.0.0.1:15731/api/health   # 200 {"ok":true}
```

의존성·mvnw 배포판은 `~/.m2`에 이미 캐시돼 있어 `-o`(오프라인)로도 `verify`가 통과한다.

## npm 파이프라인과 분리돼 있다

Java 빌드를 npm 파이프라인에 섞지 않는다. `npm test`·`npm run lint`·`npm run build`는 이 모듈을 **보지 않는다**
(`eslint`는 `**/*.js`만 보고 `npm test`는 `test/**/*.test.js` 글롭인데, 여기에는 `.js` 파일이 없다).
반대로 Maven도 Node 쪽을 건드리지 않는다. 두 파이프라인은 각자의 커맨드로만 돈다.

## 설정 키 ↔ 환경변수

값은 전부 OS 환경변수에서 온다. `src/main/resources/application.properties`에는 **절대경로를 하드코딩하지 않는다**
— 계약 하네스가 프로파일마다 임시 `DATA_DIR`을 주입해야 하기 때문이다.

| 설정 키 | 환경변수 | 기본값 | 설명 |
|---|---|---|---|
| `app.data-dir` | `DATA_DIR` | **없음(필수)** | 데이터 디렉토리 절대경로. 미설정이면 기동 실패(메시지에 키·환경변수 이름 포함). |
| `app.env` | `APP_ENV` | `development` | `production`이면 프로덕션 분기(쿠키 Secure·SameSite=None, CSRF allowlist 엄격). Node의 `NODE_ENV`를 읽지 않는다. |
| `app.allowed-origins` | `ALLOWED_ORIGINS` | 빈 목록 | CORS allowlist(콤마 구분). |
| `server.port` | `PORT` | `15000` | 계약 하네스는 **[15000, 20000)**에서 빈 포트를 프로브해 주입한다(러너·verify 구간과 서로소). |
| `server.address` | `HOST` | `127.0.0.1` | 기본 loopback — `HOST` 명시 설정 시에만 LAN에 열린다(Node 서버와 동일 규율). |

## 시계

세션 만료·계정 잠금·로그 다이제스트 창은 전부 주입된 `java.time.Clock` 빈을 쓴다
(`System.currentTimeMillis()` 직접 호출 금지 — 테스트 결정성의 전제). 프로덕션 빈은 `Clock.systemUTC()`이고,
테스트는 `@TestConfiguration` + `@Primary`로 고정 시계를 끼운다(`ClockBeanTest` 참조).

## 테스트 규율

- 와이어 계약은 **전 기동(`RANDOM_PORT`) + 원시 HTTP 클라이언트**로만 판정한다. **MockMvc 금지** —
  이 포팅의 합격 기준은 실제 HTTP 바이트(헤더 문자열·Set-Cookie 직렬화)이고 MockMvc는 서블릿 컨테이너의
  직렬화 경로를 그대로 재현하지 않는다.
- 테스트는 리포 `news.db`를 열지 않는다. DB가 필요한 테스트는 `@TempDir`의 임시 파일 DB + **테스트 리소스에만
  존재하는 DDL 픽스처**를 쓴다(main 소스에는 DDL이 없다).
