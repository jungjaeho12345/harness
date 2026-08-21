# Step 12: parity-closeout

phase를 닫는다. 새 기능은 만들지 않는다. **전 프로파일 계약 실행 + 패리티 + 자기 결정성**을 한 번에 측정하고, 문서(`server-spring/README.md` · ADR-013 실측 1문장)를 갱신하며, 미검증 공백과 인계 사항을 기록한다.

## 읽어야 할 파일

- `phases/69-spring-articles/index.json` — 전체(특히 decisions **(2)(3)(15)(16)(21)** · open_questions (d)(f) · forward_notes 전부)
- `server-spring/README.md` — 갱신 대상: 구현 라우트 표(7 → **20**) · 미구현 라우트 수(32 → **19**) · 계약 실행 절(프로파일 3 → **4**, `minimal` 설명) · "아직 검증되지 않은 것" 절
- `docs/ADR.md` ADR-013 — ④ 문장 끝의 phase 68 마감 실측 뒤에 **phase 69 실측 1문장 추가**(결정 내용·이유·트레이드오프 문단은 손대지 않는다)
- `phases/68-spring-auth/index.json` forward_notes (9) — 마감 실측을 기록하는 형식(이 phase도 같은 밀도로 남긴다)
- step0~step11의 요약(실측 수치의 출처)

## 배경

- 이 phase의 완료 판정은 **계약 4파일 green + Node 대비 diff 0 + 자기 결정성 diff 0**이다. 여기서 한 번에 재측정한 수치가 **phase 70+의 기준선**이 된다 — 추정치를 섞지 마라.
- `--dual-run`은 **하네스가 직접 소유**한다(프로파일마다 새 임시 DATA_DIR + 새 프로세스로 2패스 → 리포트 비교). "같은 인스턴스에 2회"는 상태를 갖는 대상(레이트리밋·계정 잠금·세션 스토어)에서 성립하지 않는다(68 decisions (6-a)).
- 이 phase는 기사 행을 **쓰는** 첫 구현이다 — 마감에 **DB 안전 실측**(리포 `news.db` 크기·mtime 무변 · `uploads/` 무변 · 잔존 java 프로세스 0 · OS 임시 디렉토리 잔존 0)을 반드시 남긴다.

## 작업

### A. 전 게이트 재측정 (연속 2회 green 확인)

아래를 순서대로 돌리고 **각 출력의 수치를 그대로** 기록한다(프로파일별 `cases`·`covered`·`skipped`, `[diff]`의 `observations`·`diffs`, Java 테스트 수, jar 크기, 소요시간).

- 계약 4프로파일 전건 · `--parity` · `--dual-run`
- Java `verify`(테스트 수·실패 0·**총 소요시간** — open_questions (f) 판단 입력)
- Node 축 무회귀: `npm test` **1328** · `npm run lint` · `npm run build`
- 드리프트 게이트: `node scripts/contract-inventory-check.mjs --require-spec-paths`(라우트 39·spec-paths 39/39 — 이 phase가 Node 라우트·명세를 건드리지 않았다는 증거)
- **Node 대상 계약 전건**: `npm run test:contract -- --require-full-coverage`(profiles=5 · covered=39/39) — 계약 스위트·Node 서버 무수정의 최종 증거

### B. 문서 갱신 (범위를 넘지 마라)

- `server-spring/README.md`: 라우트 표에 이 phase의 13행 추가(인증 클래스·비고 포함) · 미구현 19 라우트의 현재 동작 설명 유지 · 계약 실행 절에 **4 프로파일**과 `minimal`의 의미(스풀·토큰 미설정 = 전이 관측의 결정성) 추가 · "아직 검증되지 않은 것"에 forward_notes (4)의 8항목 반영 · **배부 훅이 없다는 사실과 그것이 패리티를 깨지 않는 근거**(수신처 0건) 1~2줄.
- `docs/ADR.md` ADR-013: ④의 마감 실측 문장 뒤에 phase 69 실측 1문장(계약 파일 수·프로파일 수·관측 수·diffs·Java 테스트 수). **결정·이유·트레이드오프 본문은 수정하지 않는다.**
- `docs/api-contract/**`·`contract/**`·`docs/news.md`·계획서는 **건드리지 않는다**.

### C. index.json 마감 기록

- 각 step의 status·summary가 실측으로 채워졌는지 확인하고, **forward_notes를 마감 시점 사실로 갱신**한다: (a) A에서 측정한 수치 전부 (b) 이 phase가 남긴 미검증 공백(forward_notes (4)) (c) 배부 phase 인계(forward_notes (3)) (d) 계약 파일 상호 의존이라는 구조적 사실(forward_notes (2)) (e) 남은 라우트 19개와 커버리지 게이트 조건 (f) open_questions (d)(f)의 마감 결과.
- **forward_notes (8) 인코딩 경로 divergence를 step7 실측으로 확정한다**: 인증된 퍼센트 인코딩 경로(`/api/artic%6Ces/...`)에서 Spring과 Node가 각각 어떤 상태코드였는지 **실측값**을 적고, 계약이 관측하지 않는 축이라 **고치지 않았다**는 처분과 그 이유(매칭 정책 변경은 39 라우트 전부에 영향 — 경로 정규화 정책은 별도 판단)를 남긴다. **라우트를 늘리는 후속 phase마다 같은 divergence가 새로 생긴다**는 사실을 함께 인계한다.
- **forward_notes (9) 요구 스키마 확장의 전역 파급을 step2·step3 실측으로 확정한다**: 정본 픽스처를 확장해야 했던 이유와 영향받은 `@SpringBootTest` 개수, 드리프트 거부 단언이 넓어진 목록에서도 유효했는지를 적는다(후속 도메인 phase가 같은 함정을 반복하지 않게).
- **투영 방어의 실효 범위를 정직하게 적는다**(decisions (4)): 타입 경계 ①(i)(ii)와 와이어 ②가 **각각 어떤 벡터를 덮고 어떤 벡터를 덮지 않는지**, step11의 변이 실증에서 어느 층이 실제로 red였는지를 근거와 함께 남긴다. '2층이라 안전하다'로 뭉뚱그리지 마라.
- 이 phase에서 **발견했지만 고치지 않은 것**이 있으면 근거와 함께 남긴다(계약이 틀렸다고 판단되는 것도 고치지 말고 기록 — 68 decisions (17) 승계).

### D. 범위 정합 확인

- `git diff --stat`(phase 시작 지점 대비)의 파일 목록이 계획이 소유한 경로에만 있는지 확인한다: `server-spring/**` · `scripts/spring-contract.mjs` · `server-spring/README.md` · `docs/ADR.md` · `phases/69-spring-articles/**` · `phases/index.json`.
- 무접촉 목록(`contract/**`·`docs/api-contract/**`·`server/**`·`src/**`·`web/**`·`client/**`·`test/**`·`package.json`·`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`)에 **단 한 줄의 변경도 없음**을 `git diff --stat`으로 증명한다.
- 사용자 소유 미커밋 파일은 그대로 둔다(`git add -A` 금지 · `restore`/`checkout`/`stash`/`clean` 금지).

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --dual-run
cd /d/agents/harness && npm test
cd /d/agents/harness && npm run lint
cd /d/agents/harness && npm run build
cd /d/agents/harness && node scripts/contract-inventory-check.mjs --require-spec-paths
cd /d/agents/harness && npm run test:contract -- --require-full-coverage
cd /d/agents/harness && git status --porcelain
cd /d/agents/harness && git diff --stat
```

- 3·4·5번: 전부 exit 0. 4프로파일 전건 green · 전 프로파일 `diffs=0`(패리티·자기 결정성 모두).
- 6번: **1328/1328**(증감은 회귀).
- 10번: exit 0 · `profiles=5 covered=39/39`(Node 서버·계약 스위트 무수정의 증거).
- 1번: failures/errors 0. 테스트 수는 기준선 276보다 커야 하며 최종 수치를 기록한다.

## 검증 절차

1. AC를 **연속 2회** 돌려 비고정 실패(flake)가 없는지 확인한다(1회 실패 시 재실행 2회 규약 — 재현되면 회귀로 다룬다).
2. `--dual-run` 출력에서 프로파일마다 **두 패스의 pid·port·dataDir이 서로 다른지** 확인해 '새 프로세스로 판정했다'는 사실을 요약에 남긴다.
3. **DB 안전 실측**: 리포 `news.db` 크기·mtime · `uploads/` 크기 · 실행 후 잔존 java 프로세스 0 · OS 임시 디렉토리의 `spring-contract-*`·`contract-*` 잔존 0 · 리포트·로그에 세션 토큰(64-hex)·시드 비밀번호 0건.
4. **스텁 금지 게이트 확인**: `HandlerInventoryTest`의 구현 라우트가 **정확히 20개**이고, 그 20개가 전부 계약 케이스로 관측되는지 대조한다(관측되지 않는 구현이 남아 있으면 그것이 '검증 없는 구현'이다 — 목록과 근거를 요약에 남긴다).
5. **투영 누출 최종 확인**: 타입 경계 테스트 2층(컨트롤러 패키지에 원본 행 타입 부재 · 직렬화 안전망) green + 계약 리포트·stdout 어디에도 잠금 세션/탭 컬럼명이 없음을 확인한다. 두 층이 덮지 **못하는** 벡터도 요약에 적는다(정직한 공백 — decisions (4)).
6. **스텁 금지 프로브 확인**: `PathPolicyWireTest`의 미구현 라우트 프로브가 가리키는 경로가 **이 phase 종료 시점에도 미구현**인지 확인한다(구현된 라우트를 가리키면 그 게이트는 이미 무력화된 것이다). 경로와 그 라우트가 어느 phase 소유인지를 요약에 적는다.
7. 범위 정합(D) 결과를 요약에 붙인다. `HandlerInventoryTest`의 **메서드명·실패 메시지 라우트 수 표기가 20으로 맞춰져 있는지**도 함께 확인한다(수치가 목록과 어긋난 채 green이면 그 테스트가 주장하는 문장이 거짓이다).
8. index.json step12 status·summary 갱신 + `phases/index.json`의 69 항목 note를 마감 형식(`[완료 YYYY-MM-DD: ...]` + 기존 설명)으로 갱신한다.

## 금지사항

- 새 라우트·새 기능을 추가하지 마라. 이유: 마감 step의 임무는 측정과 기록이다 — 여기서 늘어난 구현은 어떤 게이트도 검증하지 않는다.
- 실패한 게이트를 '알려진 이슈'로 적고 넘어가지 마라. 이유: 이 phase의 완료 정의가 계약 4파일 green + diff 0이다. 실패는 폐색하거나 phase를 닫지 않는다.
- 수치를 추정으로 적지 마라(테스트 수·관측 수·jar 크기·DB 크기). 이유: 이 수치가 phase 70+의 기준선이 된다 — 추정이 섞이면 다음 phase가 잘못된 기준선 위에서 회귀를 판정한다.
- `docs/api-contract/**`·`contract/**`·`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`를 고치지 마라. 이유: 계약 정본은 이 포팅에서 무수정이며, 고치는 순간 패리티 판정의 기준 자체가 흔들린다.
- ADR-013의 결정·이유·트레이드오프 문단을 다시 쓰지 마라(실측 1문장만 추가). 이유: 결정은 68이 내렸고 이 phase는 그 결정을 실행했을 뿐이다.
- `git add -A`로 커밋하지 마라. 이유: 작업 트리에 사용자 소유 미커밋 파일이 있다 — 명시 경로만 add 한다.
- 리포 `news.db`·`uploads/`를 정리·재생성하지 마라. 이유: DB 비파괴 최상위 규칙이며 그 두 경로는 무접촉 목록이다.
