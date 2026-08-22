# Step 7: parity-closeout

phase를 닫는다. 새 기능은 만들지 않는다. **전 프로파일 계약 + 패리티 + 자기 결정성**을 한 번에 측정하고, 문서(`server-spring/README.md` · ADR-008/ADR-013 실측 문장)를 갱신하며, 미검증 공백과 인계 사항을 마감 시점 사실로 기록한다. 여기서 재측정한 수치가 **phase 71+의 기준선**이다 — 추정치를 섞지 마라.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — 전체(특히 decisions **(1)(3)(6)(12)** · open_questions (c) · forward_notes 전부)
- `phases/69-spring-articles/index.json` forward_notes **(10)** — 마감 실측을 남기는 형식·밀도(같은 밀도로 남긴다)
- `server-spring/README.md` — 갱신 대상: 구현 라우트 표(20 → **27**) · 미구현 라우트 수(19 → **12**) · admin-crud 도메인 설명(Z 전용·투영·삭제 경계)
- `docs/ADR.md` ADR-008(배부 아키텍처) · ADR-013(Spring 포팅) — 실측 1문장씩 추가(결정·이유·트레이드오프 본문 무수정)
- step0~step6의 요약(실측 수치 출처)

## 작업

### A. 전 게이트 재측정 (연속 2회 green)

아래를 순서대로 돌리고 **각 출력 수치를 그대로** 기록한다:
- 계약 4프로파일 전건(`node scripts/spring-contract.mjs`) — 프로파일별 `cases`·`covered`·`skipped`(default covered 16 → **23/39**)
- `--parity` — 프로파일별 `observations`·`diffs`(전부 0)
- `--dual-run` — 프로파일별 두 패스 pid·port·dataDir 상이 확인
- Java `sh ./mvnw -B verify`(테스트 수·실패 0·**총 소요시간**) · `sh ./mvnw -B -q package -DskipTests`(jar 크기)
- Node 축: `npm test` **1328** · `npm run lint` · `npm run build`
- 드리프트 게이트: `node scripts/contract-inventory-check.mjs --require-spec-paths`(routes 39·spec-paths 39/39 — Node·명세 무수정 증거)
- **Node 대상 계약 전건**: `npm run test:contract -- --require-full-coverage`(profiles=5 covered=39/39 — 계약 스위트·Node 서버 무수정의 최종 증거)

### B. 문서 갱신 (범위를 넘지 마라)

- `server-spring/README.md`: 라우트 표에 이 phase의 7행 추가(인증 클래스 Z 전용·비고) · 미구현 12 라우트 현재 동작 유지 · admin-crud 설명(수신 설정 SAFE 10키·배부 수신처 SAFE 7키·`receiver-config-delete`가 시스템 유일 행 삭제 라우트로 설정 행만 지운다는 경계·배부 수신처는 soft delete뿐이고 DELETE 라우트 부재·**배부 실행(스풀 쓰기·tick)은 여전히 미구현**).
- `docs/ADR.md` ADR-008: 실측 1문장(수신처 CRUD 4라우트가 Spring에 이식됐고 배부 실행은 여전히 미구현 — 앱 내 타이머·egress 0 유지). ADR-013 ④: phase 69 실측 문장 뒤에 phase 70 실측 1문장(계약 파일 2·프로파일 4·관측 수·diffs·Java 테스트 수). **결정·이유·트레이드오프 본문은 수정하지 않는다.**
- `docs/api-contract/**`·`contract/**`·`docs/news.md`·계획서는 **건드리지 않는다**.

### C. index.json 마감 기록

- 각 step status·summary가 실측으로 채워졌는지 확인하고 **forward_notes를 마감 시점 사실로 갱신**: (a) A의 수치 전부 (b) 미검증 공백(forward_notes (6)) (c) collection·배부 실행 phase 인계(forward_notes (1)(2)(3)) (d) 남은 12 라우트와 커버리지 게이트 조건 (e) open_questions (a)(b)(c)의 마감 결과.
- **행 삭제 경계를 마감으로 확정**: `receiver-config-delete`가 `ReceiverConfig` 설정 행만 지우고 다른 테이블 DELETE 0임을 실측으로 남긴다(decisions (1)).
- **NaN id 처분을 실측으로 확정**(open_questions (b)): receiver-config-delete와 distribution-targets update/deactivate의 NaN id가 각각 어떤 status였는지 Node 리포트 대조 실측값을 적는다.
- **결함 후보 #3(시크릿 필터 오라클)이 계약에 관측되는지** 확정하고 처분(재현·미수정) 기록.
- **인코딩·경로 파라미터 divergence**: 이 phase 7라우트에도 같은 divergence가 생기는지 step5·6 실측으로 확인하고 69 forward_notes (8) 원장에 누적(새 결함 아님).
- **정직한 공백**: gap #4(숫자 표현)·#5(비-ASCII)의 유일 방어선이 리포지토리 단위 테스트임을 명시.

### D. 범위 정합 확인

- `git diff --stat`(phase 시작 030a2bf 대비)이 소유 경로에만: `server-spring/**` · `scripts/spring-contract.mjs` · `docs/ADR.md` · `phases/70-spring-admin-crud/**` · `phases/index.json` · `phases/69-spring-articles/index.json`(TASK 1 forward_notes).
- 무접촉 목록(`contract/**`·`docs/api-contract/**`·`docs/news.md`·`server/**`·`src/**`·`web/**`·`client/**`·`test/**`·`package.json`·`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`)에 **0줄** 변경임을 증명.
- 사용자 소유 미커밋 파일은 그대로(`git add -A` 금지 · `restore`/`checkout`/`stash`/`clean` 금지).

## Acceptance Criteria

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B verify
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B -q package -DskipTests
cd /home/user/harness && node scripts/spring-contract.mjs
cd /home/user/harness && node scripts/spring-contract.mjs --parity
cd /home/user/harness && node scripts/spring-contract.mjs --dual-run
cd /home/user/harness && npm test
cd /home/user/harness && npm run lint
cd /home/user/harness && npm run build
cd /home/user/harness && node scripts/contract-inventory-check.mjs --require-spec-paths
cd /home/user/harness && npm run test:contract -- --require-full-coverage
cd /home/user/harness && git status --porcelain
cd /home/user/harness && git diff --stat
```

- 3·4·5번: 전부 exit 0. 4프로파일 전건 green · 전 프로파일 `diffs=0`(패리티·자기 결정성). default covered = **23/39**.
- 6번: **1328/1328**(증감은 회귀).
- 10번: exit 0 · `profiles=5 covered=39/39`(Node 무수정 증거).
- 1번: failures/errors 0. 테스트 수는 기준선 **584**보다 커야 하며 최종 수치를 기록한다.

## 검증 절차

1. AC를 연속 2회(flake 0 — 1회 실패 시 재실행 2회, 재현되면 회귀).
2. `--dual-run` 프로파일마다 두 패스 pid·port·dataDir 상이 확인.
3. **DB 안전 실측**: 리포 `news.db` 크기·mtime · `uploads/` 크기·항목 수 무변 · 실행 후 잔존 java 0 · OS 임시 `spring-contract-*`·`contract-*` 잔존 0 · 리포트·로그에 세션 토큰(64-hex)·시드 비밀번호·수신 설정 시크릿(password/apiKey 원문) 0건.
4. **스텁 금지 게이트**: `HandlerInventoryTest` 구현 라우트가 정확히 **27**이고 그 27개가 전부 계약 케이스로 관측되는지 대조(관측되지 않는 구현 = 검증 없는 구현). `DELETE /api/distribution-targets/{id}`가 목록에 없음 확인.
5. **행 삭제 경계 최종 확인**: main 소스의 행 `DELETE` SQL이 `ReceiverConfig` 하나뿐임을 grep으로 확인.
6. **스텁 금지 프로브**: `PathPolicyWireTest` 프로브가 이 phase 종료 시점에도 미구현 라우트(media-search 등)를 가리키는지 확인 — 소유 phase 명시.
7. 범위 정합(D) 결과를 요약에 붙인다.
8. index.json step7 status·summary 갱신 + `phases/index.json`의 70 항목을 마감 형식으로 갱신.

## 금지사항

- 새 라우트·새 기능을 추가하지 마라. 이유: 마감 step의 임무는 측정과 기록이다.
- 실패한 게이트를 '알려진 이슈'로 적고 넘어가지 마라. 이유: 완료 정의가 계약 2파일 green + diff 0이다.
- 수치를 추정으로 적지 마라(테스트 수·관측 수·jar 크기·DB 크기). 이유: 이 수치가 phase 71+ 기준선이 된다.
- `docs/api-contract/**`·`contract/**`·정본 러너를 고치지 마라.
- ADR-008·ADR-013의 결정·이유·트레이드오프 문단을 다시 쓰지 마라(실측 문장만 추가).
- `git add -A`로 커밋하지 마라 · 리포 `news.db`·`uploads/`를 정리·재생성하지 마라. 이유: 사용자 미커밋 파일 보호 + DB 비파괴 최상위 규칙.
