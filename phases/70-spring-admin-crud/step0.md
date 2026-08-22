# Step 0: spool-dir

배부 스풀 하위 폴더명(slug) 검증 순수 헬퍼를 이식한다. HTTP·DB 비의존, 부수효과 0. 라우트를 늘리지 않으므로 계약 scope는 그대로다 — 이 step의 판정은 Java 단위 테스트 + 무회귀뿐이다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — 전체(특히 decisions **(2)** · order (b))
- `src/services/spoolDir.js` — 이식 정본(1:1). 규칙·타입 게이트·예약 장치명·throw 없음(유효=원문/무효=`''`)
- `server-spring/src/main/java/harness/news/service/FileRef.java` — 같은 계열(파일 참조 검증)의 이식 선례. 순수 헬퍼 패키지 배치·명명 규약을 맞춘다
- `server-spring/src/test/java/harness/news/service/FileRefTest.java` — 테스트 스타일(경계·비문자열·제어문자) 참고. **제어문자는 날바이트 금지** — `String.valueOf((char) 0)` 같은 상수로 쓴다(69 step1 forward_notes ④: 날바이트를 넣으면 git이 파일을 바이너리로 취급해 diff가 사라진다)

## 작업 (테스트 먼저)

1. **테스트 먼저** — `server-spring/src/test/java/harness/news/service/SpoolDirTest.java`를 쓴다. `src/services/spoolDir.js`의 계약을 전부 덮는다:
   - 유효 슬러그(소문자 영숫자 시작, `[a-z0-9_-]`, 1~64자) → 원문 그대로 반환(정규화 금지 — 통과 값이 입력과 **바이트 동일**함을 단언).
   - 거부 → `""`(throw 아님): 대문자 포함 · `..` · `/` · `\` · `:` · 널바이트(`String.valueOf((char) 0)`) · 공백 · 제어문자 · 유니코드 · 65자(경계: 64자 통과 / 65자 거부) · 숫자·`-`·`_`로 시작.
   - **타입 게이트**: 비문자열(`null`·정수·불리언·맵) → `""`(강제변환 없음 — `"123"`·`"true"`·`"null"`이 통과하면 안 된다).
   - 예약 장치명: `con`·`prn`·`aux`·`nul`·`com1`~`com9`·`lpt1`~`lpt9` → `""`(소문자 비교로 충분 — 화이트리스트가 이미 소문자만 통과).
2. 테스트가 red(클래스 부재)임을 확인한다.
3. `server-spring/src/main/java/harness/news/service/SpoolDir.java`를 구현한다:
   - 시그니처 예: `public static String sanitize(Object value)` 또는 `String sanitize(String value)` + 타입 진입 게이트. 비문자열이 도달할 수 있는 호출부(step4 서비스가 임의 body 값을 넘긴다)를 고려해 **비문자열을 안전하게 `""`로 떨구는 진입점**을 둔다.
   - 정규식 `^[a-z0-9][a-z0-9_-]{0,63}$` 단일 상수 + 예약 장치명 `Set` 단일 상수.
   - throw 금지. 정규화·소문자화·trim 금지.
4. 테스트 green 확인.

## Acceptance Criteria

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B verify
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B -q package -DskipTests
cd /home/user/harness && node scripts/spring-contract.mjs --parity
cd /home/user/harness && npm test
```

- 1번: failures/errors 0. 테스트 수는 기준선 **584**보다 커야 한다(SpoolDirTest 신규분).
- 3번: exit 0 · 전 프로파일 `diffs=0`(라우트를 늘리지 않았으므로 phase 69 마감과 동일한 170관측 diffs 0).
- 4번: **1328/1328**(불변).

## 검증 절차

1. 구현 전 SpoolDirTest가 red(클래스 부재)임을 관측·기록한다.
2. **변이 실증**(원복): 타입 게이트를 `String.valueOf(value)` 강제변환으로 바꾸면 비문자열 케이스가 red가 되는지 확인해 그 테스트가 진짜 방어선인지 증명한다.
3. `git diff --stat`이 `server-spring/**`에만 있고 무접촉 목록에 변경 0임을 확인한다.
4. main 소스에 DDL(CREATE/ALTER/DROP TABLE) 0 · 행 삭제 0.

## 금지사항

- `String(value)`류 강제변환을 타입 게이트 앞에 넣지 마라. 이유: `"123"`·`"true"`가 화이트리스트를 통과해 경로 조작 방어가 무력화된다(정본 주석의 결함).
- 디렉토리 생성·존재 확인·파일 쓰기를 넣지 마라. 이유: 스풀 쓰기는 배부 실행 phase(ADR-008) 소유이며, 이 헬퍼는 순수 검증만 한다.
- throw로 거부하지 마라. 이유: 정본은 무효 입력에 `""`를 반환한다(fileRef.js 동형) — throw로 바꾸면 호출부의 흐름이 갈린다.
- 통과 값을 정규화(소문자화·trim)하지 마라. 이유: 입력을 고쳐서 통과시키면 저장값이 요청과 달라져 되읽기 계약이 어긋난다.
