# Step 4: reverse-export

**역방향(참조용) export 경로**를 만든다 — MySQL → SQLite `.db` 파일. 이것이 로드맵 P2 AC의 남은 절반이자 **롤백 자산**이다. 이 step이 끝나면 「이관이 되돌릴 수 있다」가 기계로 증명된다. **이 step은 이 phase의 안전 절단점이다**(index.json `order` 참조).

## 읽어야 할 파일

- `phases/75-mysql-migration/index.json` · `step2.md` · `step3.md`와 두 step의 summary
- `docs/db-mysql-mapping.md`
- `tools/news-migrator/` 전부 (특히 step3의 대조 검증기)
- `src/db/schema.js` (**export 산출물이 이 스키마와 동형이어야 Node 서버가 열 수 있다**)
- `src/db/connection.js` (Node 부트 연결 PRAGMA — 산출물이 그 연결로 열려야 한다)
- `docs/porting-plan-cpp-spring.md` §7의 「되돌림 지점: P3 완료 전 문제 시 Node 서버로 즉시 복귀(클라 무변경)」

## 배경 (동결된 사실)

1. **역방향 export의 형식을 SQLite 파일로 정하는 근거**: ① 소스와 **같은 형식**이라 step3의 대조 검증기를 **그대로 재사용**할 수 있다(비교기가 하나면 비교 규칙도 하나다) ② 그 산출물은 **Node 서버가 실제로 열 수 있는 DB**라서 참조용 덤프가 아니라 **작동하는 롤백 자산**이다 ③ JSON/CSV 덤프는 NULL vs 빈 문자열·숫자 표기·인코딩에서 새 divergence 축을 하나 더 만든다(이 phase가 줄이려는 바로 그 축이다).
2. 소스 실측: 7테이블 · 총 178행 · `Article.markupVersion` 최대 165,802바이트 · NULL과 빈 문자열 공존.
3. Node 정본은 `PK 자동 인덱스만 사용(보조 인덱스/FK 미선언)`이다.

## 작업

### A. `export` verb — MySQL → SQLite 파일

- 대상 파일이 **이미 있으면 덮어쓰지 말고 실패**한다(덮어쓰기는 되돌릴 수 없다).
- 스키마는 `src/db/schema.js`의 `SCHEMA` 상수와 **컬럼 이름·순서·PK·DEFAULT까지 동형**으로 만든다. 그 동형성을 **기계로 대조하는 테스트**를 둔다(step2 C의 baseline 대조 테스트와 같은 규율 — 수작업 대조 금지).
- 값 보존은 step3 B와 동일 규칙(NULL vs 빈 문자열 · 정수/문자열 구분 · id 재발번 금지).
- export 산출물은 리포 **밖** 경로에만 쓴다.

### B. 왕복 동일성 (round-trip)

`news.db`(원본) → MySQL(스테이징) → `export.db` 를 돌린 뒤 **원본과 export를 step3의 대조 검증기로 비교**해 **불일치 0**을 단언한다. 이것이 이 step의 핵심 AC다.

- 대조는 **SQLite ↔ SQLite** 방향이므로 검증기가 소스/대상 방언에 대해 대칭이어야 한다. 대칭이 아니면 대칭으로 만들고, 그 리팩터가 step3의 단언을 깨지 않는지 확인하라.
- 왕복 후 **원본 `news.db`는 여전히 바이트 무변**이어야 한다.

### C. 롤백 절차 초안

`docs/ops-mysql.md`에 절 하나를 **추가**한다(step8이 완성한다): 「Spring/MySQL에서 문제가 생겼을 때 Node/SQLite로 되돌리는 순서」 — ① Spring 정지 ② `export`로 현재 MySQL 상태를 `.db`로 내림 ③ 그 파일을 Node 서버의 `DATA_DIR`에 배치 ④ Node 기동 ⑤ 검증(로그인·목록·상세 1건). **원본 `news.db`는 지우지 않고 별도 이름으로 보존한다.**

## Acceptance Criteria

```bash
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
md5sum news.db
java -jar tools/news-migrator/target/news-migrator-*.jar export --target <staging> --out <리포 밖>/export.db
java -jar tools/news-migrator/target/news-migrator-*.jar verify --source news.db --target-sqlite <리포 밖>/export.db
md5sum news.db && ls -l news.db
# 무회귀
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
```

**종료 조건**
- 왕복 대조 **exit 0 · 7/7 테이블 · 178행 · 불일치 0**.
- `export.db`의 스키마가 `src/db/schema.js`와 기계 대조로 동형(컬럼 이름·순서·DEFAULT).
- 원본 `news.db` md5·크기 무변 · 부산물 파일 0.
- 대상 파일이 이미 있을 때 `export`가 **비-0 종료**한다.
- 마이그레이터·server-spring `clean verify` BUILD SUCCESS · Skipped 0 · `--parity` diffs 0(관측 수 step0과 동일).
- **변이 전건 결과표 기록.** 미기록 시 미완.

## 검증 절차

**변이 검증(최소 6종)** — 심고 red를 보고 원복한다.
- M1: MySQL 쪽 한 컬럼 값을 바꾸면 왕복 대조가 red인가.
- M2: export가 NULL을 빈 문자열로 쓰면 red인가(양방향).
- M3: export 스키마에서 컬럼 하나를 빼거나 **순서를 바꾸면** 동형 대조가 red인가.
- M4: 165,802바이트 본문이 export에서 잘리면 red인가.
- M5: `id`를 재발번하도록 바꾸면 red인가.
- M6: 산출물 파일이 이미 있는데 덮어쓰도록 바꾸면 해당 가드 테스트가 red인가.

+ **실사용 확인(권장 · 자동 판정 불가면 정직하게 기록)**: `export.db`를 임시 `DATA_DIR`에 놓고 **Node 서버를 실제로 띄워** 로그인·목록이 되는지 확인한다. 리포 `news.db`·`server/**`·`src/**`는 건드리지 않는다(임시 디렉토리 사본만).

green 즉시 커밋한다.

## 금지사항

- **export 산출물을 리포 안에 만들지 마라.** 이유: 리포에 DB 파일이 들어가면 `.gitignore`의 `news.db` 규칙과 충돌하고 실데이터가 커밋될 수 있다.
- **기존 파일을 덮어쓰지 마라.** 이유: 롤백 자산을 덮어쓰는 실수는 되돌릴 수 없다.
- **export 경로에서 `DELETE`/`DROP`을 쓰지 마라.** 이유: step2의 정적 게이트가 red를 내며, 「대상이 더러우면 비우고 시작」은 이 리포에서 금지된 사고방식이다.
- **JSON/CSV를 주 산출물로 삼지 마라.** 이유: 배경 1에 적은 대로 새 divergence 축을 만든다(부가 산출물로 낼 수는 있으나 AC의 대조는 SQLite 파일이 정본이다).
