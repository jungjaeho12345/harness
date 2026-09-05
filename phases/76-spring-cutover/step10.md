# Step 10: cutover-runbook-and-closeout

## 읽어야 할 파일

- `phases/76-spring-cutover/index.json` **전문**(scope · baseline · order · decisions · excluded · open_questions)
- `phases/76-spring-cutover/step0.md` ~ `step9.md`의 **결과 기록 전부**(측정표·변이 결과표·분기 판정)
- `docs/cutover-p3.md` §0~§8(앞 step들이 채운 것)
- `docs/ops-mysql.md` **§11 컷오버 런북**·**§12 결과표**·**§9 되돌리기** — P3판은 이것을 **대체하지 않고 확장**한다(어느 쪽이 정본인지 서로 가리키게 하라)
- `packaging/체크리스트-육안확인.md` **전문**(phase 60~65가 만든 육안 체크리스트의 형식·범위·판정 문구)
- `packaging/README-배포-통합.md` · `packaging/server/README-배포.md` · `packaging/client/README-배포-클라이언트.md`
- `docs/porting-plan-cpp-spring.md` §7 P3 행·**되돌림 지점(187행)**·§8 육안 게이트 문단
- `phases/75-mysql-migration/index.json` `forward_notes` 전문(형식의 본보기 — 12항)
- `phases/index.json`(top-level · 이 phase 항목 갱신 대상)

## 배경

앞의 열 step은 **자산**을 만들었다. 이 step은 그 자산을 **운영자가 쓸 수 있는 순서**로 묶고, 마감 실측으로 이 phase의 주장을 다시 증명하며, 다음 사람에게 넘긴다.

두 가지를 특히 조심하라:

1. **런북은 `phases/**`가 아니라 `docs/**`에 있어야 한다**(75 forward_notes (12)가 명시한 규율 — 운영자는 phase 문서를 열지 않는다).
2. **육안 체크리스트는 자동 판정이 불가능한 축만** 담는다(로드맵 §8: IME 체감·인쇄 출력·클립보드 실사용·SmartScreen). 자동 판정 가능한 것을 육안으로 내리면 그 축은 **다음 회차부터 아무도 안 본다.**

## 작업

### A. `docs/cutover-p3.md` 완성 — 컷오버 런북 P3판

앞 step들이 채운 §0~§8 위에 **§9 실행 런북**을 얹는다. 각 단계는 `무엇을 / 정확한 명령 / 성공 판정 / 실패 시 분기 / 되돌리려면`을 갖는다. 순서(조사표 5번의 값에 따라 스위퍼 단계 위치가 달라진다 — step6의 분기를 반영하라):

0. **시작 전 체크리스트**(하나라도 비면 시작하지 않는다): 백업 2벌 · 정지 창 확보 · 롤백 판단 권한자 대기 · `SHOW GRANTS` 확인 · `news` 테이블 0개 확인 · jar·`web/` 산출물 준비 · 769자 PK 부재 확인(step8 B) · 스케줄러 작업 목록 확인 · **부분 적재 복구 절차가 손에 있는가**(step8 D-2) · **알려진 한계 낭독**(아래 셋을 **소리 내어 확인**한다): **(i) 풀 1 천장**(step9 측정값) **(ii) Spring `/api` 응답에는 보안 헤더가 없다 — SPA 문서에는 CSP만 붙였고 나머지 10종은 이월이다**(excluded (d) ② · step3의 '허용 diff N건'이 그 목록이다) **(iii) Spring에는 ADR-012 단일 인스턴스 잠금이 없다 — 서버를 두 번 띄우면 둘 다 뜨고 tick이 겹치면 중복 배부가 난다**(step7 A-2 실측값을 숫자로 낭독).
1. **Node 정지**(tick 스케줄러를 **먼저** 끈다 → 서버 정지). 순서가 중요하다.
2. **사본 2벌 + 봉인**(영구 보관 + 즉시 되돌림용). **[② 검토 반영 · 필수] 여기서 운영 `news.db`의 `md5`·크기·`mtime`을 기록해 봉인한다.** 이유: 컷오버 후에는 **Node가 실수로 기동돼 sqlite에 쓰는 것을 잡을 수단이 없다**(Spring은 MySQL을 보고, `verify`는 'Spring이 정상적으로 쓴 새 행'과 'Node가 잘못 쓴 행'을 구분하지 못한다). **봉인값이 유일한 분기 감지 수단**이다 — 컷오버 후 그 파일은 **영원히 바뀌지 않아야** 한다. 봉인값은 런북 본문이 아니라 **작업 기록지**에 적고, §9-8과 육안 체크리스트가 그것을 재측정한다.
3. `migrate` → `verify`(step8의 실측 소요 시간이 정지 창의 근거다).
4. **grant 부착**(root · 테이블이 생긴 지금에야 붙는다) → `SHOW GRANTS` 확인.
5. **Spring 기동**: **같은 host:port** · `DB_KIND=mysql` · `DATA_DIR`(= 기존 값 그대로) · `SPA_DIR`(= 기존 `web/`) · `DIST_SPOOL_DIR`(= 기존 값) · `APP_ENV`는 **production 금지**(평문 HTTP LAN).
6. **검증**: `/api/health` → SPA 진입(`/login.do`) → **`node scripts/verify-integration.mjs --server spring`** → tick 1회 수동 실행 → 스풀 파일 생성 확인 → (스위퍼 사용 시) 수집 1건 왕복.
7. **스케줄러 교체**(tick 작업 **교체**이지 추가가 아니다 · 스위퍼 등록).
8. **육안 체크리스트 실행**(아래 B) **+ 봉인 재측정**: §9-2에서 봉인한 운영 `news.db`의 `md5`·크기·`mtime`을 **다시 재서 무변인지 확인**한다. **바뀌었다면 Node가 어딘가에서 돌고 있다는 뜻이고, 그 순간 두 저장소가 갈리기 시작한 것이다** — 즉시 (i) Node 프로세스를 찾아 내리고 (ii) 언제부터 갈렸는지(파일 `mtime`)를 확인하며 (iii) 롤백 판단자를 부른다. **이 재측정은 컷오버 당일 1회로 끝내지 말고 며칠간 반복하도록 런북에 주기 항목으로 남겨라**(자동화하려면 `md5`를 재서 비교하는 한 줄 스크립트로 충분하다 — 앱 안에 넣지 마라).
9. **롤백**: 역순 1회 — 스케줄러/스위퍼 끄기 → Spring 정지 → (필요 시 `export`로 만든 `.db`를 `DATA_DIR`에 배치) → Node 기동 → 검증(`--server exe`) → tick 작업 되살리기. **롤백 판정 기준**(무엇을 보면 되돌리는가)을 숫자·현상으로 적어라. **주의 1**: `export` 산출물을 배치하면 그 파일이 새 정본이 되므로 **§9-2의 봉인값은 그 시점에 무효**다 — 롤백 직후 **새로 봉인**하라(그리고 이번에는 Spring이 돌지 않는지를 같은 방식으로 감시한다). **주의 2**: `export`를 **생략하고** 롤백하면 **컷오버 창 동안 MySQL에만 쓰인 기록이 대상 DB에만 남는다** — 그 상태에서 재컷오버하며 대상을 비우면 **유일본 삭제**다. 그래서 부분 적재 복구의 예외 조건 ④(step8 D-2 · step0 §0-1)가 「**컷오버 이후 생성된 행 0건 확인, 있으면 `export` 선행**」을 요구한다. **롤백에서 `export`를 생략했다면 그 사실을 작업 기록지에 굵게 남겨라** — 다음 사람이 조건 ④를 판정할 때 그것이 유일한 단서다.
10. **실패 분기**: 최소 10종(포트 점유 · **대상이 비어 있지 않은데 `migrate`(exit 1 — 부분 적재 복구는 step8 D-2)** · `migrate` 1406(769자 PK) · `verify` 불일치(exit 4) · grant 누락 500 · SPA 404 · **SPA는 뜨는데 콘솔에 CSP 위반** · 클라가 붙지 않음 · tick 401/403 · 스풀 미생성 · **서버가 두 개 떠 있음**(step7 A-2 — 감지 방법과 조치) · **봉인값 변화**(§9-8)). 각각 **실측한 문구**로.
11. **Node 은퇴의 전제 조건 목록**(decisions (6)): 무엇이 충족되면 `server/**`를 지워도 되는가 — 그때 무엇을 잃는가(패리티 대조군 · `test/**` 기반 · 되돌림 지점). **지금은 지우지 않는다.**
12. **[② 검토 반영] 부팅 로그 대조표 — "정상 기동"을 무엇으로 판정하는가.** 운영자가 컷오버 직후 보는 것은 콘솔이다. Node는 부팅에서 **최소 4줄**을 낸다(실측 `server/index.js` 1347~1389행): `serving SPA from <root>`(SPA 활성일 때만) · `API server on http://<host>:<port>`(**하드코딩이 아니라 실제 바인드 host** — 운영자가 노출 범위를 로그로 판단한다) · `distribution spool root <dir>`(설정 시) · `FTP watcher watching <dir>`(설정 시) — 여기에 출처·호스트 진단 경고(`logOriginDiagnostics`·`logHostDiagnostics`)가 조건부로 붙는다. **Spring이 같은 정보를 어떤 문구로 내는지 실측해 표로 만들어라**(Node 줄 ↔ Spring 줄 ↔ 없으면 '없음'). 특히: **SPA 활성 여부 · 실제 바인드 host:port · 스풀 루트 · DB 방언과 대상**. **없는 줄이 있으면 그 자체가 진단 공백**이다 — 이 phase에서 로그 1줄을 더하는 것은 계약 밖이고 값싸므로 **step2·step7의 범위에서 추가하는 것을 허용**하되(비밀·경로 마스킹 규율 준수) 여기서는 **표로 확정**하고 런북 §9-5의 성공 판정에 그 문구를 쓴다("이 줄이 보이면 정상").

### B. 육안 체크리스트 개정판 — `packaging/체크리스트-육안확인-P3.md`(신설)

`packaging/체크리스트-육안확인.md`의 **형식을 그대로** 쓰되 대상이 다르다. **자동 판정이 되는 항목은 넣지 마라 — 자동 커맨드를 대신 적어라.** 후보:

- 한글 IME 조합 중 캐럿·"(끝)" 마커 동작(에디터 실사용 3분)
- 인쇄 출력물 육안 대조(Spring 서빙 SPA에서 인쇄)
- 클립보드 왕복(secure origin 스위치가 실제로 먹는가 — LAN 평문 접속)
- 이미지 업로드 → 본문 임베드 → **재로그인 후에도 보이는가**(`/uploads` 정적 서빙 · 공유 `DATA_DIR`)
- 목록 SSE 실시간 갱신 체감(두 브라우저 창)
- 상세보기 새 창 720×800
- 배부 대상 관리·수신 설정 화면(Z)에서 **삭제**가 실제로 되는가(**grant 축** — 자동 하네스가 구조적으로 못 보는 자리다. **이 항목을 빠뜨리지 마라**)
- 로그 화면(Z 전용 SSE)
- **[② 검토 반영] 운영 `news.db` 봉인값 재측정**(§9-2에서 적어 둔 `md5`·크기·`mtime`과 대조 — **다르면 즉시 중단·보고**). 자동 판정이 가능한 항목이지만 **컷오버 당일에 사람이 손으로 한 번 더 확인**할 가치가 있고, 무엇보다 **며칠간 반복해야 하는 항목**이라 체크리스트에 있어야 한다. 판정 문구: "봉인 시각의 md5와 오늘의 md5가 같다".
- **[② 검토 반영] 브라우저 개발자 콘솔에 CSP 위반 0건**(SPA 문서에 CSP를 붙였으므로 · 위반이 있으면 화면 기능이 조용히 죽는다)
- 롤백 후 같은 항목 재확인(축약판) **+ 롤백 직후 새 봉인값 기록**

각 항목에 **판정 문구**(무엇이 보이면 통과인가)와 **실패 시 어디를 보는가**를 적는다.

### C. 마감 실측 (연속 2회 · 두 회차 수치를 모두 기록)

```
cd server-spring && ./mvnw -B clean verify
cd tools/news-migrator && ./mvnw -B clean verify
node scripts/spring-contract.mjs --parity
node scripts/spring-contract.mjs --dual-run
node scripts/spring-contract.mjs --db mysql --parity
node scripts/spring-contract.mjs --db mysql --dual-run
node scripts/spring-contract.mjs --db mysql --require-full-coverage
node scripts/contract-inventory-check.mjs --require-spec-paths
node scripts/spa-parity.mjs
node scripts/spool-parity.mjs
node scripts/verify-integration.mjs --server spring --scenario loopback
node scripts/verify-integration.mjs --server exe --scenario loopback
npm test && npm run lint && npm run build
```

그리고 자산 지문: 리포 `news.db` md5·크기 · `uploads/` · `web/dist` · 두 jar 크기 · 잔존 `harness_ct_*` 0.

**수치가 하나라도 줄면 회귀다**(감소 0 · skip 0이 이 리포의 판정 규약이다).

### D. 교차 변이 (마감 재실증)

앞 step들이 만든 게이트 중 **최소 6종**을 다시 심어 red를 보고 원복한다. 특히:

- SPA 폴백의 `Accept` 게이트(step2 M1)
- SPA 대조기의 비교 항목 축소(step3 N4)
- 스풀 allowlist 키 추가 — **잠금 컬럼 노출**(step5 Q5 · 보안 축)
- 스위퍼의 멱등 제거(step6 R3)
- tick의 인가(step7 S2)
- 마이그레이터 비파괴 게이트(step8 T2 또는 75의 `flyway.clean()`·`Files.deleteIfExists`)

**그리고 각각을 심은 채 `--parity`를 돌려 계약이 green인지 재라** — "계약이 못 보는 축" 목록의 근거를 마감에서 다시 확정한다.

### E. 문서 정본 정리와 인계

- `server-spring/README.md`: SPA 서빙 절 · 새 하네스 3종(`spa-parity`·`spool-parity`·`verify-integration --server spring`) · **미검증 목록 갱신**.
- `docs/db-mysql-mapping.md` §7·§7-1: P3 시점 문장으로 갱신(769자 축의 성격 변화 등).
- `phases/76-spring-cutover/index.json`에 **`forward_notes`** 를 신설한다(75의 12항 형식). 최소 항목:
  1. 마감 실측 전문(연속 2회)
  2. **로드맵 P3 완료 게이트 3요소 대비 판정** — 문장이 아니라 **커맨드**로(무엇이 무엇을 증명했는가)
  3. **divergence 전수**(각 축의 유일 방어선을 파일·메서드로) — 누적 이월 승계 목록 포함
  4. **계약이 구조적으로 못 보는 축**의 확정 목록(이 phase가 늘린 것: SPA 응답 · 스풀 바이트 · 수집 스위퍼 경로 · tick 운영 경로 · 권한 오류)
  5. **미검증(정직한 공백)** — 최소: 운영 규모 동시 접속 · 스위퍼 장기 운용 · 롤백 실기(운영에서 해 본 적 없음) · **`/api` 응답의 보안 헤더 10종 + CSP**(SPA 응답에만 붙였다) · 이모지/서로게이트 일부 · **장기 운용에서의 다중 인스턴스**(step7 A-2는 실험실 1회 측정이다)
  5-1. **이 전환이 잃은 것(회귀로 명시)** — **ADR-012 단일 인스턴스 잠금**(Node는 `DATA_DIR` 범위로 막았고 Spring에는 없다 · step7 A-2 실측값 · 대안 `GET_LOCK`은 open_questions (9)에 기본 결정과 함께) · **`/api` 응답의 helmet 헤더 전량**. **"동등하게 옮겼다"고 적지 마라 — 무엇이 줄었는지가 다음 사람에게 가장 중요한 정보다.**
  6. **다음 단계 인계**: Node 은퇴 전제 조건 · 보안 헤더(**3연속 이월**) · 부트 백필 2종 · 풀 확대 · `NodeString.trim` 수렴 · P4(C++ 클라) 착수 전 확인 사항
  7. **사용자 실행 항목의 잔여**(무엇이 아직 안 됐는가 — grant · 비밀번호 교체 · 스케줄러)
  8. **환경 함정**(누적 + 이 phase에서 새로 만난 것)
  9. **다음 사람이 먼저 열 파일**(순서대로 · `docs/**` 우선)
- `phases/index.json`(top-level)의 `76-spring-cutover` 항목 `note`를 마감 요약으로 갱신한다(72~75 항목의 형식).

## Acceptance Criteria

```bash
# 1) 마감 실측 13커맨드 × 2회 — 전부 성공, 두 회차 수치 동일
#    (위 C의 목록 그대로. 각 실행에 `Tests run:` / 관측 수 / exit code를 기록)

# 2) 무접촉 최종 확인
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs \
  server src web client test package.json docs/news.md spikes \
  server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java \
  server-spring/src/test/java/harness/news/db/NoSchemaSqlInMainSourcesTest.java \
  server-spring/src/main/java/harness/news/web/RoutePolicy.java \
  server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java   # 무출력

# 3) 다른 세션 산출물 무접촉
git status --porcelain    # step0 스냅샷의 4종이 그대로 있고 커밋에 섞이지 않았다

# 4) 리포 자산 무변
md5sum news.db
```

- 2번이 **무출력**. 특히 `HandlerInventoryTest`가 0줄이라는 것은 **SPA 서빙이 인벤토리 밖에 정직하게 있다**는 증거다.
- `forward_notes` 9항이 전부 존재하고, **미검증 항목이 비어 있지 않다**(공백이 0인 phase는 없다 — 없다고 적으면 그것이 거짓이다).
- **교차 변이 결과표**(D의 6종 + 각각의 계약 green 여부)가 기록됐다.
- 육안 체크리스트가 **자동 판정 가능한 항목을 담고 있지 않다**(담았다면 자동 커맨드로 바꿔라).

## 검증 절차

1. 마감 실측은 **연속 2회**이고 **두 회차 수치를 모두 적는다**(평균 금지). 다르면 flake 규약(재실행 2회)으로 판정하고 그 사실을 적는다.
2. 런북을 **직접 따라 해 본다** — 임시 환경에서 §9의 1~9를 처음부터 끝까지(운영 대신 리허설 자산으로). 따라 하다 막히면 그 자리가 런북의 결함이다.
3. 롤백 절차도 **실제로 한 번 돌린다**(Spring 정지 → export `.db` 배치 → Node 기동 → `--server exe` 검증). 롤백을 해 보지 않은 롤백 절차는 절차가 아니다.
4. `docs/cutover-p3.md`를 **운영자 시점으로** 읽어라: 리포 구조를 모르는 사람이 따라 할 수 있는가.

## 되돌림 절차

- 이 step은 문서와 forward_notes 중심이다. 되돌림은 추가분 제거.
- **운영 되돌림 절차 자체가 이 step의 산출물**이다 — §9-9가 그것이고, 검증 절차 3이 그것을 실제로 돌려 본다.

## 금지사항

- **런북을 `phases/**`에만 두지 마라.** 이유: 운영자는 phase 문서를 열지 않는다(75 forward_notes (12)).
- **`docs/ops-mysql.md` §11을 지우거나 덮어쓰지 마라.** 이유: P2의 기록이고 여전히 유효하다. P3판은 **확장**이며 서로를 가리켜야 한다.
- **자동 판정 가능한 항목을 육안 체크리스트로 내리지 마라.** 이유: 다음 회차부터 아무도 안 본다.
- **미검증 항목을 비워 두지 마라.** 이유: 이 리포의 규율은 '정직한 공백'이다. 공백을 감추면 다음 사람이 없는 방어선을 믿는다.
- **`server/**`·`src/**`를 지우지 마라.** 이유: decisions (6) — 롤백 레버이자 패리티 대조군이다.
- **수치를 인계값으로 대체하지 마라.** 이유: 마감은 **재측정**이다. 앞 step의 값을 복사해 넣으면 회귀를 못 본다.
- **`git add -A` 금지 · 다른 세션 산출물 4종 무접촉.** 이유: 워킹 트리에 상주하는 타 세션 작업물이 커밋에 섞인 전례가 있다.
- **PR 머지를 임의로 하지 마라.** 이유: 공유 `feat-0-mvp`로의 머지는 사용자 명시 승인이 필요하다.
