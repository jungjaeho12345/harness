# Step 3: schemaguard-mysql-message

## 읽어야 할 파일

- `phases/76-server-cutover-ops/index.json` — scope·decisions (5)(7)·environment(축 B).
- `server-spring/src/main/java/harness/news/db/SchemaGuard.java` — 특히 `verify()`(102~128행). 문제 목록 뒤에 붙는 **처방 문장**(126행)이 dialect 무관하게 sqlite 시절 처방("Node 서버로 데이터 디렉토리를 준비한 뒤 다시 실행하세요")이다. 이 클래스에는 `this.mysql`(boolean)·`this.target`(문자열)이 이미 있다.
- `server-spring/src/test/java/harness/news/db/SchemaGuardTest.java` · `server-spring/src/test/java/harness/news/db/dialect/MysqlSchemaGuardTest.java` — 이 문구를 실측하는 기존 테스트. 여기에 케이스를 더한다.
- `docs/ops-mysql.md` §11-8(실패 분기) — "적재 전/부분 적재 상태로 기동" 행이 mysql 모드의 올바른 처방이 **`migrate`**임을 이미 못 박았다(문서 정본).
- `docs/db-mysql-mapping.md`(참고) · `server-spring/README.md`(DB_KIND·verify 요구 환경변수).

## 배경

phase 75 forward_notes (6) ⑩: mysql 모드에서 스키마가 비었을 때 `SchemaGuard`가 내는 거부 메시지의 **처방 문장이 sqlite 시절 것**이라 운영자를 잘못 안내한다. mysql 모드의 올바른 처방은 `tools/news-migrator`의 **`migrate`**다. **문구만 고치면 되고 계약 관측·상태 코드·라우트는 건드리지 않는다.**

## 작업

`SchemaGuard.verify()`의 처방 문장을 **dialect별로** 만든다. TDD로 진행한다.

1. **테스트 먼저**(`MysqlSchemaGuardTest`에 케이스 추가): mysql 대상에서 스키마가 비어 `verify()`가 던지는 `IllegalStateException` 메시지가
   - `migrate`(또는 `tools/news-migrator`의 이관 처방)를 **가리키고**,
   - sqlite 시절 문구("Node 서버로 데이터 디렉토리를 준비")를 **포함하지 않는다**.
   그리고 `SchemaGuardTest`(sqlite 대상)의 기존 케이스는 sqlite 처방을 **그대로 유지**함을 재단언한다(회귀 방지).
2. **구현**: 126행의 처방을 `this.mysql`에 따라 분기한다. mysql이면 "`tools/news-migrator`로 `migrate`한 뒤 다시 실행하세요"류(정확한 문안은 재량 · `docs/ops-mysql.md` §11-8과 일관되게), sqlite면 기존 문장 유지. 문제 목록(`테이블 없음 = …`)과 예외 타입·앞부분("DB 스키마가 이 서버의 요구를 만족하지 않습니다 (…)")은 **바꾸지 마라**.

**계약 무영향 보장**: 이 메시지는 부팅 실패 시 예외 텍스트일 뿐 어떤 HTTP 응답에도 실리지 않는다. `--parity`·`--dual-run` 313관측·`npm test` 1328은 무회귀여야 한다.

## Acceptance Criteria

```bash
# --- 축 B(개발 머신 · 포터블 JDK 25) ---
# 이 문구는 sqlite 대상 테스트로 검증 가능 — 대상 테스트만 골라 MySQL 요구를 피한다
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -Dtest=SchemaGuardTest,MysqlSchemaGuardTest test   # 통과

# 전체 게이트(MySQL 필요 — decisions(14): verify는 MySQL 없으면 fail)
# docs/ops-mysql.md §3 절차로 자격을 싣고(§ '§3 로드 절차 + NEWS_APP_* 로 옮겨싣기') :
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify   # Tests 0 fail / 0 skip
```

> 주의: `mvnw verify` 전체는 `MysqlConfiguredGuardTest` 때문에 MySQL과 `NEWS_APP_MYSQL_*`·`NEWS_CT_MYSQL_*` 자격을 요구한다(`docs/ops-mysql.md` §3의 "`mvnw verify`를 돌리는 정확한 형태"). 개발 머신이 아니면 대상 테스트(`-Dtest=…`) AC까지만 돌리고 전체 verify는 orchestrator가 실행 환경에서 돌린다.

## 검증 절차

1. 대상 테스트 AC를 먼저 돌려 문구 분기를 확인한다(MySQL 불요 · sqlite 픽스처).
2. 실행 환경이면 full `clean verify`로 0 fail / 0 skip을 확인한다.
3. 아키텍처 체크리스트:
   - `verify()`의 예외 타입·문제 목록·앞부분 문장을 바꾸지 않았는가(**처방 문장만** 분기)?
   - `RoutePolicy`·`ReasonStatus`·`contract-run.mjs`·`Adr008DisciplineTest`·`NoSchemaSqlInMainSourcesTest`를 고치지 않았는가?
   - 어떤 HTTP 응답도 바뀌지 않았는가(계약 무영향)?
4. step 3을 업데이트한다(completed→summary / error→error_message / blocked→blocked_reason).

## 금지사항

- 예외 타입·문제 목록·"DB 스키마가 …" 앞부분·`this.target` 표기를 바꾸지 마라. 이유: 기존 테스트·런북 §11-8이 그 형태에 결합돼 있다 — 처방 문장 한 곳만 dialect 분기한다.
- 스키마를 만들거나 고치는 코드(DDL)를 추가하지 마라. 이유: 이 서버는 DDL 0이 설계다(`NoSchemaSqlInMainSourcesTest`가 잠근다).
- 계약 관측을 바꾸지 마라. 이유: 이 문구는 응답이 아니라 부팅 예외 텍스트다 — 313관측·1328 테스트는 무회귀여야 한다.
- 기존 테스트를 깨뜨리지 마라.
