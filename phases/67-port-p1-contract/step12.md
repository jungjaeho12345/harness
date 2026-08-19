# Step 12: dual-run-closeout

**이중 실행 diff 하네스**(`scripts/contract-diff.mjs`)를 만들고, 이 phase의 완료 판정을 실증한다: 커버리지 **39/39** · 전 케이스 green · **Node×2 리포트 diff 0** · 기존 스위트 무회귀. 그리고 미동결·미검증 항목을 정직하게 기록하고 phase를 마감한다.

## 읽어야 할 파일

- `phases/67-port-p1-contract/index.json` — 전체(특히 decisions **(11)(12)(13)(18)(19)(23)(25)(26)** · excluded 전항 · open_questions 전항의 **판정 결과**)
- `phases/67-port-p1-contract/step1.md` — 러너 CLI(`--out`·`--base-url-map`·`--credentials`·`--boot-check`·`--require-full-coverage`·`--require-spec-paths`)와 **리포트 스키마 B**(`x-` 접두사 규칙·`skipped` 사유 2종 `profile-unavailable`/`profile-boot-failed`)
- `phases/67-port-p1-contract/step2.md` — lib의 리포트 정규화·마스킹 규칙(diff가 무엇을 비교하는지의 근거)
- `phases/67-port-p1-contract/step0.md` — `scripts/contract-inventory-check.mjs`의 `--require-spec-paths` 동작
- `docs/api-contract/**` 전체 — 마감 시점의 실제 산출물(README에 미검증 목록을 갱신한다)
- `docs/porting-plan-cpp-spring.md` §7 P1 행 · §8 검증 전략 — 이 phase가 어디까지 했고 68+가 무엇을 이어받는지 대조
- `scripts/verify-integration.mjs` 700~740행 — 종합 판정·exit 코드·요약 출력 형식의 본보기

## 배경

- 이중 실행 패리티의 기계 판정은 "같은 스위트를 두 서버에 돌려 **정규화 리포트가 동일**한가"다. Spring 서버가 없는 지금은 **같은 Node 서버를 두 번** 돌려 diff 0을 확인하는 것으로 (a) 리포트 정규화가 실제로 결정적이고 (b) diff 도구가 동작한다는 두 전제를 실증한다.
- diff 도구가 "항상 0"을 내면 68+에서 거짓 green을 만든다 — **차이를 실제로 잡는다는 증거(변이)** 가 이 step의 핵심 산출물이다.

## 작업

### A-0. `scripts/contract-run.mjs`에 `--dual-run` 추가

- `--dual-run`: 같은 대상에 스위트를 **연속 2회** 실행해 리포트 2개를 **OS 임시 디렉토리**에 쓰고, 곧바로 `contract-diff.mjs`의 비교 함수를 호출해 판정한다. 두 리포트 경로와 diff 결과를 stdout에 남기고, 차이가 있으면 exit 1.
- 이유: AC 커맨드에 경로 리터럴을 넣지 않아도 되고(플랫폼 의존 제거), 리포 안에 산출물이 남지 않는다.
- `--dual-run`은 `--base-url-map`과 함께 써도 동작해야 한다(68+에서 Spring을 두 번 돌려 자기 결정성을 먼저 확인하는 용도).

### A. `scripts/contract-diff.mjs`

```
node scripts/contract-diff.mjs <reportA.json> <reportB.json> [--json] [--max-diff <n>]
```
- 비교 로직은 **재사용 가능한 함수로 export**하고 CLI는 얇은 래퍼로 둔다(러너의 `--dual-run`이 그 함수를 쓴다 — 비교 규칙이 두 벌로 갈라지면 안 된다).
- 두 리포트를 읽어 `observations`를 `(profile, routeId, tag, caseId)` 키로 정렬·매칭하고 필드별로 비교한다: `status`·`ok`·`reason`·`bodyKeys`·`values`·`headers`.
- 차이 종류를 구분해 출력한다: `only-in-A` / `only-in-B` / `value-mismatch(field)` / `skipped-vs-observed`.
- **`skipped` 항목은 관측과 같지 않다**(한쪽이 프로파일 미제공으로 건너뛰었으면 그것은 차이다).
- 동일하면 `contract-diff-ok observations=<n>` + exit 0, 다르면 차이 목록(기본 상위 50건) + `contract-diff-FAILED diffs=<n>` + exit 1.
- 인자 가드: 파일 2개 필수·존재 확인·JSON 파싱 실패 시 명확한 메시지 + exit 1(`scripts/lib/cliArgs.mjs` 재사용).

### B. `docs/api-contract/README.md` 마감 절 추가

- **동결 완료 범위**: 39/39 라우트 · 프로파일 5종 · 케이스 수(실측) · 리포트 관측 수(실측).
- **미검증·미동결 목록**(정직한 공백 — 각 항목에 "왜"와 "누가 소유하는가"): 배부 실패 원장이 있는 상태의 failures/retry · tick 동시성(`skipped:'in-progress'`) · 로그 다이제스트 24h 창 경계 · 정의 외 role(403 `unknown-role`) 도달 경로 · **`POST /api/login`의 `inactive` 403(도달 경로 없음 — 시드 계정 비활성화 금지)** · 배부 없는 환경의 `EPS` 진입 · 외부 API 키가 설정된 서버의 media/translate 동작 · 업로드 5MB 정확 경계 · 프로덕션 HTTPS 강제(308)/HSTS · SPA 정적 서빙/폴백 · 레이트리밋 창 리셋 · **OpenAPI 스키마 수준 검증(YAML 파서 미도입 — 자동 판정은 인벤토리 ↔ 라우트 표, 인벤토리 ↔ YAML 경로 존재, 인벤토리 ↔ 리포트 커버리지 3종까지)**.
- **코드 ↔ 스펙 문서 차이** 절을 **최종 확정**한다. 최소 **2건은 필수 기록**이다(step0에서 시작해 이후 step이 append한 것): ① 계획서 §6.1 "사유 토큰 21종" ↔ 실측(전역 `STATUS_BY_REASON` 22 + 라우트 로컬 매핑 다수) ② 부록 A #19 "필터 15키" ↔ 실측 `FILTER_KEYS` **13키**. 여기에 step6이 수집한 `docs/news.md` 전이표 대비 차이(있으면)를 더한다. 처분은 전부 **코드가 정본**이며 계획서·news.md 파일은 고치지 않는다(index.json open_questions (b)).
- **68+ 사용법**: Spring 서버를 띄우고 `--base-url-map`으로 프로파일별 base URL을 주면 같은 스위트가 돈다는 것, 사전조건(계정 3종은 **userId만** 명시 + 비밀번호는 `SAMPLE_USERS`와 동일하다는 문구 또는 `--credentials <file>` 주입 · 프로파일 필수 3종/선택 2종), 그리고 `contract-diff.mjs`로 Node 리포트와 비교하는 절차.

### C. 정합·마감

- `phases/index.json`의 67 항목 `status`·`note` 갱신(다른 phase 항목은 건드리지 마라).
- `phases/67-port-p1-contract/index.json`의 `forward_notes`를 작성한다: 68+가 이어받을 것(도메인 묶음별 Spring 구현 순서 제안·프로파일 프리셋 요구(필수 3/선택 2)·`--credentials` 주입 경로·미동결 목록), 이 phase가 발견한 서버 결함 후보(있다면 전부, 수정 없이), 그리고 **"계약 스위트의 상시 게이트 편입은 68+ Spring 실행 시점에 별도 잡으로 상시화한다"**(지금은 `npm run test:contract` 수동 실행 — index.json open_questions (c)의 확정 처분).
- openapi.yaml 전체를 한 번 훑어 step 간 형식 불일치(태그 이름·스키마 참조·description 누락)를 정리한다(**내용 변경이 아니라 형식 정합만** — 실측을 바꾸지 마라).
- **openapi.yaml의 YAML 파싱 가능성 1회 확인**: 리포에 파서를 들이지 않고(의존성 0 유지) 외부 수단으로 문서가 유효한 YAML/OpenAPI로 파싱되는지 한 번 확인하고 **확인 방법과 결과를 `docs/api-contract/README.md`와 step 요약에 기록**한다(예: 에디터/온라인 뷰어/일회성 도구 — 무엇을 썼는지 적는다). 자동 게이트가 아니므로 "확인했다"는 사실과 한계(이후 편집은 재확인 필요)를 함께 남긴다.

## Acceptance Criteria

```bash
node scripts/contract-inventory-check.mjs --require-spec-paths
npm run test:contract -- --require-full-coverage
npm run test:contract -- --dual-run --require-full-coverage
npm test
npm run test:web
npm run lint
npm run build
git status --porcelain
```

- 리포트는 **OS 임시 디렉토리**에만 쓴다(리포 안에 산출물을 남기지 않는다 — `--dual-run`이 경로를 stdout에 출력한다). 변이 검증(아래 1번)에서 리포트 사본을 편집할 때도 임시 경로에서만 작업한다.
- 기대: 커버리지 39/39 · 두 커맨드 모두 exit 0(`--dual-run`은 내부 diff까지 0) · `npm test` **1327/1327**(기준선 그대로) · `npm run test:web` 기준선 유지(비고정 flake 1건은 **재실행 2회**로 판정) · lint·build clean.

## 검증 절차

1. **diff 도구 변이 검증 3종**(각각 확인 후 원복/삭제):
   - (a) 리포트 사본 하나에서 `status` 값 1개를 바꾼다 → `value-mismatch(status)` 1건 + exit 1.
   - (b) 사본에서 관측 1건을 통째로 지운다 → `only-in-A` 1건 + exit 1.
   - (c) 한 프로파일만 실행한 리포트(`--profile default --out <임시경로A>`)와 전체 리포트(`--out <임시경로B>`)를 비교 → 다수의 `only-in-B` + exit 1(= 프로파일 누락이 통과로 위장되지 않는다는 증거). 임시 경로는 리포 밖(OS 임시 디렉토리)만 쓴다.
2. **커버리지 게이트 변이**: `endpoints.json`의 한 라우트에 도달 가능한 태그를 하나 더 추가해 `--require-full-coverage`가 red가 되는지 확인하고 원복(게이트가 살아 있다는 증거).
3. **전체 게이트 2회**: `npm test` · `npm run test:web` · `npm run lint` · `npm run build`를 돌리고, web 스위트가 1건 실패하면 재실행 2회로 판정한다(알려진 비고정 flake).
4. **범위 정합**: `git diff --stat feat-0-mvp...HEAD`가 계획의 소유 파일 목록과 정확히 일치하는지 확인한다(`docs/api-contract/**`·`contract/**`·`scripts/contract-*.mjs`·`package.json` 1줄·`phases/**`). 범위 밖 파일이 커밋에 들어갔으면 그 자리에서 되돌린다. **사용자 미커밋 파일은 절대 건드리지 마라**(증분 판정은 시작 시점 스냅샷 대비).
5. **데이터 무접촉 최종 확인**: 리포 `news.db` 크기·mtime과 `uploads/` 엔트리 수가 phase 시작 시점과 같은지 확인(러너의 단언과 별개로 사람이 한 번 더 본다). 임시 디렉토리 잔존 여부도 확인한다.
6. **누출 최종 확인**: 최종 리포트 2개를 스캔해 64-hex 토큰·bcrypt 해시·`AKR` articleId·절대 경로·로그 라인이 없는지 확인하고 결과를 요약에 남긴다.
7. `docs/api-contract/README.md`의 미검증 목록이 step3~step11 요약에 기록된 미검증 항목을 **빠짐없이** 반영했는지 대조한다(각 step summary를 다시 읽고 체크).
8. index.json step12 status·summary·forward_notes 갱신 + `phases/index.json` 67 항목 갱신.

## 금지사항

- diff가 통과하도록 정규화를 느슨하게 만들지 마라(예: `values`를 비우거나 `bodyKeys` 비교를 끄기). 이유: 그 순간 68+ Spring 패리티 판정이 거짓 green이 된다 — 이 하네스의 유일한 존재 이유가 사라진다.
- `skipped`를 관측과 동일 취급하도록 완화하지 마라. 이유: 프로파일을 제공하지 않은 서버가 "차이 0"으로 통과한다.
- 실측과 다른 내용을 명세에 남기지 마라(형식 정합만 정리). 이유: 명세는 실측 스냅샷이며, 여기서 손대면 앞 step들의 red 실증 근거가 무의미해진다.
- 커버리지를 채우려고 라우트의 `expect` 태그를 삭제하지 마라. 이유: 커버리지 게이트가 자기 기준을 낮추는 것은 게이트가 아니다 — 도달 불가능한 태그였다면 **왜 도달 불가능한지**를 README 미검증 목록에 적고 태그를 내리되, 그 사실을 요약과 forward_notes에 남긴다.
- 리포 안에 리포트 산출물을 남기지 마라. 이유: 세션·경로 정보가 섞일 수 있고 커밋 오염이 된다(`.gitignore` 추가로 해결하지 말고 애초에 임시 경로에 써라).
- `npm test`/`test/**`/`server/**`/`src/**`를 손대지 마라. 이유: 이 phase의 계약 불변 조건이며, 무회귀 증명(1327 그대로)이 마감 판정의 일부다.
- `phases/index.json`의 다른 phase 항목을 수정하지 마라. 이유: 이력 문서이며, 67 항목 외 변경은 범위 위반이다.
