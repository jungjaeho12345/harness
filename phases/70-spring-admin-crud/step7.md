# Step 7: parity-closeout

관리자 CRUD 7 라우트가 전부 붙은 상태에서 **전 프로파일 패리티·자기 결정성**을 마감 검증하고, 문서를 갱신하며, 이 phase가 default 프로파일에 배부 대상 계약 파일을 편입하면서 생길 수 있는 **송고 훅 상호작용**이 실제로 diff 0임을 실증한다. 새 도메인 코드는 만들지 않는다 — 이 step은 게이트·문서·증거다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — scope · baseline · decisions **(2)(3)(5)(16)** · open_questions (c)(d) · forward_notes (1)(2)(5)
- phase 69 `phases/69-spring-articles/index.json` decisions (2)(3)·forward_notes (3) — 송고 훅 부재의 결정성 전제(default 프로파일 DistributionTarget 0건 전제가 이 phase로 깨지는 지점)
- `contract/cases/default/distribution-targets.contract.js` 27~29행 — 활성 대상을 남기지 않고 deactivate로 회수한다는 계약 파일 자체의 규율
- `scripts/contract-run.mjs` 54~57행(프로파일 spool 프리셋)·371행(`--test-concurrency=1` 순차 실행) — 송고 훅 전제의 기계 근거
- `server-spring/README.md` — 구현 라우트 표(20 → 27)·미구현 목록(19 → 12) 갱신 대상
- `docs/ADR.md` ADR-013 ④ — 실측 문장 1개 추가 대상(결정 본문·68·69 문장 무수정)
- `server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java` — 최종 27행 확인

## 배경 (이 step이 닫는 위험)

- **송고 훅 상호작용(open_questions (d)·forward_notes (2)).** phase 69는 default 프로파일에 DistributionTarget 행이 0건이라 Node의 송고 훅(spool:true)이 관측 가능한 부수효과가 없다는 전제로 패리티를 유지했다. 이 phase가 `distribution-targets.contract.js`를 default에 넣으면 그 파일이 대상 행을 만든다. 안전성의 근거 3중:
  1. 러너가 `--test-concurrency=1`로 파일을 **순차** 실행한다.
  2. 알파벳 순서상 `distribution-targets.contract.js`는 송고를 하는 `articles-write.contract.js`보다 **뒤에** 온다 → articles-write의 모든 송고가 끝난 뒤에야 대상이 생긴다.
  3. 그 파일은 자기 `after`에서 대상을 **deactivate로 회수**한다(활성인 채로 남기지 않는다).
  → **활성 대상이 송고와 공존하는 창이 없다.** 이 step이 default 프로파일에 두 파일이 함께 든 상태로 `--parity` diff 0을 실측해 이 근거를 기계로 확정한다.

## 작업

### A. 전 게이트 실행 (마감 판정 — 연속 2회로 flake 0 확인)

프레시 체크아웃이면 먼저: `cd /home/user/harness && npm ci`

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./mvnw -B verify
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./mvnw -B -q package -DskipTests
cd /home/user/harness && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 node scripts/spring-contract.mjs --parity
cd /home/user/harness && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 node scripts/spring-contract.mjs --dual-run
cd /home/user/harness && npm test
cd /home/user/harness && npm run lint
cd /home/user/harness && npm run build
cd /home/user/harness && node scripts/contract-inventory-check.mjs --require-spec-paths
cd /home/user/harness && npm run test:contract -- --require-full-coverage
cd /home/user/harness && git status --porcelain
```

### B. 송고 훅 상호작용 실증 (배경의 3중 근거 확정)

- `--parity`의 **default 프로파일** 리포트에서 `distributedAt`·distribute 이력·DES→EPS 승격이 Node/Spring 어느 쪽에도 추가로 나타나지 않는지 확인한다(diff 0이면 자동 충족이나, 리포트에서 `distributedAt`이 나오는 자리가 phase 69와 같은 자리(create 신뢰 경계 케이스의 `clientDistributedAtIgnored`)뿐임을 육안 확인해 요약에 1줄).
- 만약 diff가 생기면 그것은 '배부가 켜진 송고 계약'이며 **이 phase가 아니라 배부 실행 phase의 소유**다 — 임의로 Spring에 배부를 구현하지 말고 폐색·기록하고 orchestrator에 보고한다.

### C. 문서 갱신 (open_questions (c))

- `server-spring/README.md`: 구현 라우트 표 20 → **27**(receiver-config 3 + distribution-targets 4 추가) · 미구현 19 → **12** · **유일한 행 삭제 라우트**(`DELETE /api/receiver-config/:id`)의 예외 경계 근거(설정 행만 삭제, 수집 기사 불변) · distribution-target soft delete.
- `docs/ADR.md` ADR-013 ④: phase 70 실측 1문장 추가(구현 라우트 27·계약 파일 수·테스트 수 등). **결정 본문·이유·트레이드오프·68·69 문장은 무수정.**

### D. 데이터 안전·스텁 금지 대조

- 리포 `news.db` size·mtime 무변 · `uploads/` 무변 · 전 실행 후 java 프로세스 0 · OS 임시 `spring-contract-*`·`contract-*` 잔존 0.
- 리포트·로그에 64-hex 세션 토큰 0건 · 시드 비밀번호 0건 · `password`·`apiKey` 시크릿 원문 0건.
- `HandlerInventoryTest.IMPLEMENTED_ROUTES` **27행**이고 계약 리포트 routeId 합집합과 일치('구현했는데 계약이 관측하지 않는 라우트' 0개) · 메서드명·실패 메시지 표기도 27로 일치.
- `PathPolicyWireTest`의 스텁 금지 프로브가 여전히 미구현 라우트(media-search)를 가리키고 유효(삭제·약화 0).
- `NoSchemaSqlInMainSourcesTest`: `DELETE FROM ReceiverConfig`만 허용되고 다른 6테이블 삭제는 여전히 red 대상임을 재확인.

## Acceptance Criteria

- `mvnw verify`: exit 0 · failures/errors 0 · 테스트 수 기준선 **584 이상**(이 phase 전 step 누적 증가분 반영). 실측치를 요약에.
- `--parity`: exit 0 · 4 프로파일 전부 diffs 0 · default 관측 수가 기준선 106보다 **receiver-config + distribution-targets 케이스만큼 늘어난** 채. 총 관측 수 실측 기록.
- `--dual-run`: exit 0 · 4 프로파일 diffs 0 · 프로파일마다 두 패스가 서로 다른 pid·port·DATA_DIR로 떴음을 실측(요약에 예 1건).
- `npm test`: **1328/1328**(불변). `npm run lint`·`npm run build`: 성공.
- `contract-inventory-check --require-spec-paths`: exit 0(routes=39 spec-paths=39/39 — Node·명세 무수정 증거).
- **Node 대상** `test:contract --require-full-coverage`: exit 0(profiles=5 cases=274 covered=39/39 — 이 phase가 Node 서버·계약 스위트를 한 줄도 안 고쳤다는 최종 증거).
- **주의**: `--require-full-coverage`는 **Node 대상**(`npm run test:contract`)에만 쓴다 — **Spring 대상**(`scripts/spring-contract.mjs`)에는 쓰지 마라(구현 27/미구현 12라 영구 red이고 그 red가 정상, excluded (f)).
- `git status --porcelain` 증분 = `server-spring/README.md` · `docs/ADR.md` · (필요 시 최종 인벤토리 테스트 조정) · `phases/70-spring-admin-crud/index.json`.

## 검증 절차

1. A의 전 커맨드를 **연속 2회** 돌려 flake 0을 확인한다(수치가 두 번 같아야 한다).
2. B의 송고 훅 실증 결과를 요약에 명시(default diff 0 · distributedAt 자리 확인).
3. D의 데이터 안전·스텁 금지 대조 전 항목을 요약에 실측으로 남긴다.
4. index.json step7 status·summary + forward_notes(다음 묶음 = collection 2 → distribution 실행 3 → media·upload·photos 4 → SSE 2 → translate 1)를 갱신하고, 이 phase의 마감 실측 수치(구현 27·미구현 12·테스트 수·관측 수·jar 크기)를 phase 71+ 기준선으로 남긴다.

## 금지사항

- 배부 실행·스풀 쓰기·송고 훅·타이머를 만들지 마라. 이유: default 프로파일에서 diff가 생기면 그것은 배부 실행 phase의 소유다(ADR-008) — 이 phase에서 Spring에 배부를 구현하면 검증되지 않은 표면이 늘고 계약 소유 경계가 무너진다.
- `--require-full-coverage`를 Spring 대상에 쓰지 마라. 이유: 미구현 12라 영구 red이며 그 red가 정상이다.
- Node 서버(`server/**`·`src/**`)·계약 스위트(`contract/**`)·명세(`docs/api-contract/**`)·러너(`contract-run.mjs`·`contract-diff.mjs`)·`package.json`·`test/**`를 고치지 마라. 이유: 무수정이 이 phase의 성립 조건이고 `--require-spec-paths`·`test:contract` 전건이 그 증거다.
- ADR-013의 결정 본문이나 phase 68·69 문장을 고치지 마라. 이유: 실측 1문장만 추가한다.
- `git add -A`를 쓰지 마라. 이유: 사용자 미커밋 파일을 쓸어담는다 — 명시 경로만 add.
