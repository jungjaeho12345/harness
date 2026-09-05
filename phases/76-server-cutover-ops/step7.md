# Step 7: closeout

## 읽어야 할 파일

- `phases/76-server-cutover-ops/index.json` — 전체 scope·decisions·excluded, step0~6 summary.
- 이 phase의 모든 산출물: `scripts/lib/spoolCanon.mjs`(+test) · `scripts/operation-scenario.mjs` · `server-spring/.../SchemaGuard.java` · `client/lib/clientConfig.js`(리졸버) · `server/deprecationBanner.js` · `docs/ops-mysql.md`(§13).
- `phases/75-mysql-migration/index.json` `forward_notes` — 마감 실측·기록 형식의 본보기(수치·커맨드로 적는다).
- `docs/ops-mysql.md` §3(자격 싣기) · §10(하네스를 MySQL로) — 마감 커맨드의 정확한 형태.
- `server-spring/README.md` — 필요 시 라우트/관측 수치·환경변수 표 갱신 대상.

## 작업

이 phase를 마감한다. **새 기능을 만들지 않는다.** 게이트를 실측으로 재확인하고 P3의 남은 사람 몫·공백을 정직히 인계한다.

1. **마감 실측(연속 2회 · 수치 동일 확인 · flake는 재실행 2회 green으로 판정하고 숨기지 마라).** 최소 커맨드:
   - **축 A(컨테이너 가능)**: `node --test scripts/lib/spoolCanon.test.mjs` · `node --test test/client-server-target.test.js` · `node --test test/node-deprecation-banner.test.js` · `node scripts/operation-scenario.mjs --server node`(exit 0) · `npm test` · `npm run lint` · `npm run build`. **`npm test` 판정**: 기준선 **1328 + 이 phase가 더한 신규 케이스 N건**(step4 client-server-target + step5 node-deprecation-banner) = **1328+N**이고 **회귀(감소) 0**이다 — 절대 수 1328로 오독하지 말고 "1328 대비 신규만 증가·감소 0"으로 판정한다(실제 N은 마감 시점에 센다).
   - **축 B(개발 머신 · 포터블 JDK 25 · MySQL)**: jar 2개 빌드 → `node scripts/operation-scenario.mjs --dual --db sqlite`(스풀 diff 0) → `--dual --db mysql`(diff 0 · 잔존 `harness_ct_*` 0) → `server-spring ./mvnw -B clean verify`(0 fail / 0 skip) → `node scripts/spring-contract.mjs --parity`·`--db mysql --parity`(각 313관측 diffs 0 — **무회귀 확인**).
   - **DB 비파괴 단언**: 리포 `news.db`가 **있는 환경(개발 머신)에서는** md5가 phase 시작과 동일(phase 75 마감 기준 `7247e9e0dfe5cc8cd040ebb1dc9fb967`)이고, **없는 환경(컨테이너 · `.gitignore`)에서는** 여전히 없음(생성 0)이다 — 부재 환경에서 `md5sum news.db`를 그대로 돌려 거짓 실패를 내지 마라. `uploads/`도 같은 규칙(있으면 무변 / 없으면 생성 0), 잔존 임시 DB 0.
2. **문서 마감**: 필요 시 `server-spring/README.md`에 이 phase 산출물(시나리오 하네스·`NODE_SERVER_DEPRECATED`·`NEWS_SERVER_URL`·SchemaGuard 문구 정정)을 1~2줄로 반영. ADR 신설은 하지 않는다(이 phase는 아키텍처 결정을 뒤집지 않는다).
3. **`forward_notes` 작성**(`phases/76-server-cutover-ops/index.json`에 추가). 반드시 담을 것:
   - 마감 실측 전문(커맨드·수치).
   - **P3의 남은 사람 몫**(이 phase가 하지 않은 것): 운영 `news`로의 실제 데이터 컷오버 실행 · `GRANT DELETE ON news.ReceiverConfig` 부착(root) · 운영 cron 실제 재지정 · Node 실제 종료 시점.
   - **정직한 공백/후속 P3 항목**: helmet 등가 보안 헤더 11종(excluded (d)) · 커넥션 풀 확대(excluded (e)) · sqlite 분기·`node:sqlite` 제거 판단(excluded (c)) · 부트 백필 2종 이식(excluded (f)) · `User.userId` 769자 축(excluded (g)) · `DistributionTargetService.checkName`의 `String.trim()` 단일 출처화(phase 75 forward_notes (6)⑦).
   - **하네스가 못 보는 축의 방어선**: `--db mysql`은 GRANT 부재를 못 본다 → 유일 방어선은 `SHOW GRANTS` 육안 + `NewsAppMysqlWireTest`/`MinimumPrivilegeBoundaryTest`(스테이징).
   - **다음 사람이 먼저 열 파일**: `docs/ops-mysql.md`(§13 컷오버 실행 체크리스트) · `scripts/operation-scenario.mjs`(검증 게이트).
4. **등록 정리**: `phases/index.json`의 76 항목 note를 마감 요약으로 갱신(상태 전이·타임스탬프는 execute.py가 기록).

## Acceptance Criteria

```bash
# 축 A(컨테이너 가능)
node --test scripts/lib/spoolCanon.test.mjs test/client-server-target.test.js test/node-deprecation-banner.test.js
node scripts/operation-scenario.mjs --server node
npm test && npm run lint && npm run build

# 축 B(개발 머신 · 포터블 JDK 25 · MySQL — docs/ops-mysql.md §3 자격 로드)
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/operation-scenario.mjs --dual --db sqlite
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/operation-scenario.mjs --dual --db mysql
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --db mysql --parity
```

## 검증 절차

1. 축 A는 컨테이너에서, 축 B는 실행 환경에서 각각 연속 2회 돌려 수치 동일을 확인한다. flake는 재실행 2회 green으로 판정하고 기록한다.
2. DB 비파괴 단언(리포 `news.db` md5·`uploads/` 무변·잔존 임시 DB 0)을 확인한다.
3. `--parity`·`--db mysql --parity` 313관측 diffs 0(무회귀), 스풀 diff 0을 확인한다.
4. `forward_notes`에 남은 사람 몫·공백·방어선·먼저 열 파일이 커맨드/수치로 적혔는지 확인한다.
5. step 7을 업데이트한다(completed→summary / error→error_message / blocked→blocked_reason). 실행 환경이 아니어서 축 B를 못 돌리면 그 축을 blocked로 기록하고 사유를 남긴다(추측 green 금지).

## 금지사항

- 실측하지 않은 수치를 forward_notes에 적지 마라. 이유: 다음 단계가 그 값을 기준선으로 삼는다 — 미실측은 "미실측"으로 적는다.
- 축 B를 못 돌렸는데 green으로 기록하지 마라. 이유: 패리티 무회귀 판정이 공허해진다.
- 새 기능·리팩터를 끼워 넣지 마라. 이유: 마감 step은 게이트 재확인과 인계만 한다.
- sqlite 분기 제거·Node 실제 종료·운영 데이터 컷오버를 실행하지 마라. 이유: 롤백 레버 유지 + 그 실행은 P3의 사람 몫이다.
- 리포 `news.db`·`uploads/`·운영 `news`·`news_stage`에 쓰지 마라(DB 비파괴).
- 기존 테스트를 깨뜨리지 마라.
