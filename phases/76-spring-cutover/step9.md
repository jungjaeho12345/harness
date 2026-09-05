# Step 9: residual-decisions

## 읽어야 할 파일

- `phases/76-spring-cutover/index.json` — `excluded` (j)(k) · `open_questions` · `decisions` (13)
- `phases/75-mysql-migration/index.json` — `forward_notes` (3) ④(769자 PK) · (5) ②③(미측정: InnoDB 잠금·풀 1 성능) · (6) ⑤⑨⑩
- `docs/ADR.md` **ADR-016 ⑥**(풀 1 유지의 근거)·**트레이드오프 ④**(769자 PK) · **ADR-013** · **ADR-015**(SSE 스레드 모델) · **ADR-017**
- `docs/db-mysql-mapping.md` §7(divergence 8건)·**§7-1**(방어선 색인)·§8(미측정)
- `server-spring/src/main/java/harness/news/db/NewsDataSource.java`(**방언 지점 1파일** · `MAX_POOL_SIZE`) · `server-spring/src/test/java/harness/news/db/DialectSeamTest.java`
- `server-spring/src/test/java/harness/news/web/LogsStreamWireTest.java` **항목 22**(Hikari 상한 1로 순환 대기를 세우는 테스트 — 풀을 늘리면 이 테스트가 무의미해진다)
- `server-spring/src/main/java/harness/news/service/UserService.java`(`create` — 길이 검증이 **없다**) · `server-spring/src/test/java/harness/news/db/dialect/IdentityAndSizeProbeTest.java`(`axis8_*`)
- `contract/cases/default/users.contract.js`(무접촉 — 동결된 응답)

## 배경

75가 P3로 넘긴 이월 항목 중 **전환 후 정본이 바뀌기 때문에 지금 처분을 정해야 하는 것**이 둘이다.

**(1) `User.userId` 769자** — SQLite는 수락하고 MySQL은 **1406으로 거부**한다. 도달 경로는 관리자 사용자 생성 API이고 `UserService.create`에 길이 검증이 없다. 결과는 **Node 200 / Spring 500**이다. 지금까지는 "Node가 정본이니 divergence로 기록"이었지만, **컷오버 후에는 Spring이 정본**이다 — 즉 **그 입력은 그냥 실패한다**. 그런데 고치려면(400 + 사유 토큰) **Node 응답도 함께 바뀌어야** 계약이 성립하고, 그것은 계약 변경이다.

**(2) 커넥션 풀 1** — SQLite 단일 writer라는 원래 근거는 MySQL에서 사라졌다. 그런데 상수는 그대로다. 위험은 **로컬 파일 잠금이 네트워크 왕복 위의 전역 직렬화로 변질**되는 것이다: Tomcat 200 스레드가 Hikari 1을 기다리다 **30초 초과분이 500**이 된다. 반대로 늘리면 **74 ⑤가 폐색한 락 순서 결함의 방어선**(`LogsStreamWireTest` 항목 22 — 상한 1로 순환 대기를 세운다)이 무의미해진다.

**이 step은 둘 다 '측정하고 판정'한다. 기본 방향은 '바꾸지 않는다'이고, 바꾸려면 근거가 실측이어야 한다.**

## 작업

### A. 풀 1 천장 실측

**임시 인스턴스**(임시 `DATA_DIR` · MySQL 임시 DB)에 부하 프로브를 건다. 프로브는 **테스트 소스가 아니라 스크립트**로 두어도 되고(`scripts/`), Java 테스트로 두어도 된다 — 단 **`mvnw verify`를 느리게 만들지 마라**(부하 테스트를 기본 스위트에 넣으면 매 빌드가 늘어진다. 태그로 분리하거나 스크립트로 빼라).

측정 축(각각 **동시 요청 수를 계단식으로** 올리며):

1. **읽기 위주**(목록·상세) — p50/p95/최대 응답시간 · 500 발생 시점.
2. **쓰기 혼합**(작성·수정·잠금) — 같은 축.
3. **SSE 연결이 열린 상태**에서의 위 둘(74가 남긴 '완전 정지 소비자' 공백과 인접한 축이다 — **그 공백을 메우려 하지 말고**, 다만 SSE가 열려 있을 때 풀 경합이 달라지는지만 본다).
4. **30초 타임아웃 경계**: 대기가 30초를 넘으면 무엇이 나가는가(상태코드·본문·로그).

**같은 프로브를 Node에도 걸어** 나란히 적는다. Node는 단일 프로세스·SQLite라 축이 다르지만, **운영자가 알고 싶은 것은 '전환 후 느려지는가'** 이므로 두 값이 나란히 있어야 의미가 있다.

**판정**: 조사표 1·7번의 실제 사용자 규모(동시 접속 대략치)와 비교해 **여유가 있는가**를 문장으로 답한다.

- 여유가 있으면 → **풀 1 유지**. ADR-016 ⑥에 **실측 문단을 추가**한다(결정 본문을 고치지 말고 결과만 덧붙인다 — ADR-013 ④의 선례).
- 여유가 없으면 → **확대는 이 phase에서 하지 않는다**. 대신 (i) 측정값 (ii) 확대에 필요한 작업 목록(별도 ADR + `LogsStreamWireTest` 항목 22 재설계 + 잠금 순서 재검증)을 `forward_notes`와 런북의 '알려진 한계'에 적는다. **운영자가 그 한계를 모른 채 컷오버하지 않게 하는 것**이 이 step의 실질 산출물이다.

### B. `User.userId` 769자 처분

1. **도달 가능성 재확인**: 관리자 생성 API로 769자 `userId`를 보내면 Spring에서 무슨 일이 나는가(500 · 사유 토큰 · 로그 문구). Node에서는 200인가. **실측하라.**
2. **운영 데이터에 실제로 그런 행이 있는가** — step8 B가 이미 잰다. 있으면 **이관 자체가 막히므로** 그것은 이 step이 아니라 **컷오버 차단 항목**이다(런북 §0 체크리스트로 올려라).
3. **처분 결정(기본)**: 이 phase는 **고치지 않는다**. 근거: 고치려면 Node 응답이 함께 바뀌어야 하고(계약 동결) 그것은 별도 판단이다(excluded (k)). 대신:
   - `docs/db-mysql-mapping.md` §7 ④와 §7-1의 방어선을 **P3 시점 문장으로 갱신**(전환 후에는 divergence가 아니라 **Spring의 실패**다 — 성격이 바뀌었다는 것을 적어라).
   - 관리자 화면·운영 문서에 **입력 길이 실질 한계**를 경고로 남긴다(`docs/cutover-p3.md` §8).
   - **실패가 조용하지 않은지** 확인: 500이 나갈 때 로그에 진단 가능한 문구가 남는가. 안 남으면 그것이 실제 문제다(로그 문구는 계약이 아니므로 **고칠 수 있다** — 다만 값·비밀을 싣지 마라).
4. **다른 두 텍스트 PK**(`Article.articleId`·`Contents.articleId`)는 서버가 생성한다(`'AKR'+YYYYMMDD+9자리`)므로 **사용자 입력에서 오지 않는다**는 사실을 **코드로 재확인**하고 기록한다(추정하지 마라).

### C. 그 밖의 이월 점검(짧게, 기록만)

- `DistributionTargetService.checkName`의 `String.trim()` → `NodeString.trim` 단일 출처 수렴(74·75가 연속 이월). **이 phase에서 고칠지**를 판단하라 — 고친다면 계약 무회귀를 확인하고, 안 고친다면 **세 번째 이월임을 명시**하라.
- `helmet` 등가 보안 헤더 11종 — excluded (d). **두 phase 연속 이월**임을 forward_notes에 굵게 남긴다.
- 부트 백필 2종 미이식 — 컷오버 후 판단(excluded (e)).

## Acceptance Criteria

```bash
# 1) 부하 프로브 (기본 스위트를 느리게 만들지 않는 형태로)
node <부하 프로브 스크립트>            # 또는 태그 분리된 Java 테스트

# 2) 769자 축 실측 (자동 판정)
node --test <userId 길이 축 검증>      # 또는 Java 테스트

# 3) 무회귀 — 이 step은 런타임 동작을 바꾸지 않는 것이 기본이다
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
node scripts/spring-contract.mjs --parity
node scripts/spring-contract.mjs --db mysql --parity
node scripts/spa-parity.mjs && node scripts/spool-parity.mjs

# 4) 풀 상수 무변 (바꾸지 않았다는 것이 AC다)
git diff -- server-spring/src/main/java/harness/news/db/NewsDataSource.java   # 무출력(또는 변경 시 ADR 동반)

# 5) ADR 순수 추가
git diff -U0 -- docs/ADR.md | grep -c '^-[^-]'    # 0
```

- 3번의 두 `--parity`가 **313관측 diffs 0**.
- 4번이 무출력이거나, 출력이 있다면 **같은 커밋에 ADR 문단 + `LogsStreamWireTest` 항목 22 재설계가 함께** 있어야 한다(둘 중 하나만 있으면 미완이다).
- **측정표(필수)**: 부하 프로브의 계단별 수치(동시 수 · p50 · p95 · 최대 · 500 건수)를 Node·Spring 나란히. **평균만 적지 마라.**
- **변이 전건 결과표(필수)** — 최소 4종:
  - **U1** `MAX_POOL_SIZE`를 1 → 10으로 임시 변경 → 기대: `LogsStreamWireTest` 항목 22가 red 또는 **무의미해진다**. 어느 쪽인지 **실측**하고(red가 아니라 '조용히 통과'라면 그 자체가 발견이다) 원복.
  - **U2** 부하 프로브의 동시 요청 수를 1로 낮춤 → 기대: 어떤 천장도 관측되지 않는다(프로브가 실제로 부하를 거는지의 자기검사).
  - **U3** 768자 `userId` 생성 → 기대: 양쪽 성공. **769자** → 기대: Node 200 / Spring 500. 경계 1글자 차이를 잡는지.
  - **U4** 769자 축을 **바이트가 아니라 글자로** 계산하는 실수 재현(한글 769자 = 2307바이트) → 기대: 다른 지점에서 실패. **바이트와 글자를 섞지 마라**는 75 교훈 ⑤의 재확인이고, 결과를 기록하라.
  - 각 변이에 기대/실제/원복 확인.

## 검증 절차

1. 부하 프로브는 **다른 무거운 작업과 동시에 돌리지 마라**(`mvnw verify`·계약 하네스와 동시 실행 금지). 측정이 환경을 재게 된다.
2. 계단별로 **2회씩** 재고 두 값을 모두 적는다.
3. 프로브가 만든 데이터는 임시 DB에만 남기고, 임시 DB는 지운다(잔존 `harness_ct_*` 0 확인).
4. 769자 실측은 **임시 인스턴스**에서만 — 운영·`news_stage`에 쓰지 마라.

## 되돌림 절차

- 이 step의 기본은 **런타임 코드 0줄 변경**이다. 되돌림은 프로브 스크립트·문서·ADR 문단 제거.
- 만약 풀 상수를 바꿨다면(권장하지 않음) 되돌림은 상수 원복 + `LogsStreamWireTest` 원복 + ADR 문단 제거이며, **되돌린 뒤 313관측 × 2축을 다시 재라**.

## 금지사항

- **측정 없이 풀을 늘리지 마라.** 이유: ADR-016 ⑥이 그 상수에 74 ⑤의 방어선이 걸려 있다고 명시했다.
- **`LogsStreamWireTest` 항목 22를 지우거나 완화하지 마라.** 이유: 그것이 잠그는 것은 데드락 방어선이고, 지우면 74가 폐색한 결함이 되살아난다.
- **`UserService.create`에 길이 검증을 넣지 마라.** 이유: Node 응답이 함께 바뀌어야 계약이 성립한다(excluded (k)). 넣고 싶다면 별도 결정으로 올려라.
- **`contract/**`·`users.contract.js`를 고치지 마라.** 이유: 계약 동결.
- **부하 프로브를 기본 스위트에 넣어 `mvnw verify`를 느리게 만들지 마라.** 이유: 매 빌드가 늘어지면 사람이 게이트를 건너뛴다.
- **"괜찮아 보인다"로 판정하지 마라.** 이유: 이 step의 산출물은 숫자다. 여유가 없으면 없다고 적어야 운영자가 안다.
- **바이트와 글자를 섞지 마라.** 이유: 768은 **바이트** 상한이다(utf8mb4 단일 컬럼 인덱스 3072바이트 / 4).
