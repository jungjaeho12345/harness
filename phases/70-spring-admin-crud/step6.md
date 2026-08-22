# Step 6: distribution-targets-http

배부 수신처 4 라우트(HTTP)를 붙여 **`contract/cases/default/distribution-targets.contract.js`가 Spring 대상에서 green**이 되게 한다. 이 step에서 scope 표에 그 파일을 올린다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — 전체(특히 decisions **(1)(3)(5)(6)(7)(8)(10)(11)(13)** · excluded (a))
- `contract/cases/default/distribution-targets.contract.js` — **완료 판정 계약**. 4 라우트·SAFE 7키(spoolDir 포함)·검증 5종·soft delete 2진입점·**DELETE 라우트 부재(프레임워크 404)**·NaN/absent id 404
- `docs/api-contract/endpoints.json` — `distribution-targets-list`·`-create`·`-update`·`-deactivate` 행
- `server/index.js` 707~738행 — Node 라우트 4개(삭제 라우트 없음 · `Number(req.params.id)`)
- `server-spring/src/main/java/harness/news/web/ReasonStatus.java` — 검증 사유는 **폴백 400**(새 행 추가 금지 · decisions (3)) · `not-found` 404 기존
- `server-spring/src/main/java/harness/news/controller/ReceiverConfigController.java` — **step5 선례**(게이트·쿼리 원문 배열·JsonHttp)
- `server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java` — 23→27 갱신(**DELETE는 넣지 않는다**)
- `scripts/spring-contract.mjs` — SCOPE default files에 알파벳 순서로 추가
- **step2·4에서 만든 파일**: `model/DistributionTargetRepository.java` · `service/DistributionTargetService.java` · `Authorization`(manageDistributionTarget)

## 작업 (작업 A → 테스트 → 구현)

1. **작업 A** — Node 대조 리포트:
   ```
   node scripts/contract-run.mjs --profile default --files contract/cases/default/distribution-targets.contract.js --out /tmp/dt-node.json
   ```
   확정할 축: 검증 5종 status/reason(전부 400) · `absent-id`(999999999)와 `nan-id`('abc')가 update·deactivate에서 **404 not-found**(500 아님) · `DELETE /api/distribution-targets/:id`가 프레임워크 기본 404(JSON 계약 아님) · list SAFE 7키(spoolDir 노출).
2. **테스트 먼저** — `DistributionTargetsWireTest` 신설: create 성공/검증 5종(400) · list 7키 · update 성공/검증(400)/not-found(absent·nan) · deactivate 성공/not-found · **PUT `{active:'N'}` soft delete 두 번째 진입점** · **`DELETE /api/distribution-targets/:id` → 404이고 행 생존**(라우트 미등록 실증) · 미인증 401 · R·D 403. `HandlerInventoryTest` 23→27 갱신 단언(DELETE 제외).
3. 구현 전 red 서명 관측·기록.
4. `controller/DistributionTargetsController.java` 구현:
   - `@GetMapping("/api/distribution-targets")` — 게이트(Z) → 쿼리 원문 배열 화이트리스트 필터 → `service.query` → `{ok:true, items}`(7키).
   - `@PostMapping("/api/distribution-targets")` — 게이트 → 본문 → `service.create` → 성공 `{ok:true,id}` / 검증 실패 → `ReasonStatus.of(reason)`(폴백 400) + `fail`.
   - `@PutMapping("/api/distribution-targets/{id}")` — 게이트 → `Number(id)` 동형 → `service.update` → 성공 `{ok:true,changes}` / `not-found` 404 / 검증 400.
   - `@PostMapping("/api/distribution-targets/{id}/deactivate")` — 게이트 → `service.deactivate` → 성공/404.
   - **`DELETE /api/distribution-targets/{id}` 매핑을 만들지 않는다**(프레임워크 404가 계약).
   - 토큰·응답·거부 shape은 step5 컨트롤러 동형.
5. `HandlerInventoryTest.IMPLEMENTED_ROUTES`에 4행 추가(list·create·update·deactivate — **DELETE 제외**) + 메서드명·메시지·javadoc 23→**27** 갱신. `scripts/spring-contract.mjs` default files에 `contract/cases/default/distribution-targets.contract.js` 추가(알파벳 순서). green 확인.
6. **스텁 금지 프로브 확인**: `PathPolicyWireTest` 프로브가 이 phase 라우트를 가리키지 않는지(현재 media-search — 그대로 유효). 이 4 라우트를 미구현으로 전제한 단언 grep 조정.

## Acceptance Criteria

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B verify
cd /home/user/harness && node scripts/spring-contract.mjs --profile default --files contract/cases/default/distribution-targets.contract.js
cd /home/user/harness && node scripts/spring-contract.mjs --parity
cd /home/user/harness && node scripts/spring-contract.mjs --dual-run
cd /home/user/harness && npm test
cd /home/user/harness && git diff --stat
```

- 2번: exit 0 · `distribution-targets.contract.js` 전건 green(4 라우트 + `x-distribution-targets-delete` 관측).
- 3번: exit 0 · default 관측 증가 · **전 프로파일 diffs=0**.
- 4번: exit 0 · 자기 결정성 diffs=0.
- 1번: failures/errors 0 · 테스트 수 증가.
- 5번: **1328/1328**.
- 6번: 변경이 `server-spring/**`·`scripts/spring-contract.mjs`에만.

## 검증 절차

1. AC 연속 2회(flake 0).
2. **검증 순서·NaN/absent id·DELETE 부재**가 Node 리포트와 1:1(작업 A).
3. **행 삭제 경계**: `DistributionTargetsController`에 DELETE 매핑이 없고, deactivate가 행을 지우지 않고 `active='N'`으로 두는지 확인(계약 `stillListed`).
4. **스텁 금지**: `HandlerInventoryTest`가 정확히 27 라우트(+`/error`)이고 `DELETE /api/distribution-targets/{id}`가 목록에 **없는지** 확인(계약이 부재를 단언). 메서드명·메시지 표기 27 일치.
5. **투영 누출**: 리포트·응답 전문에 세션 토큰 0건 · SAFE 밖 키 0.
6. **DB 안전**: 리포 `news.db`·`uploads/` 무변 · 잔존 java 0 · OS 임시 잔존 0.

## 금지사항

- `DELETE /api/distribution-targets/{id}` 매핑을 만들지 마라. 이유: 라우트 미등록(프레임워크 404)이 계약이다 — 만들면 `x-distribution-targets-delete` 케이스가 red다(행 삭제 경로 없음 · ADR-008).
- 검증 사유를 `ReasonStatus`에 새 행으로 추가하지 마라. 이유: `invalid-*`·`duplicate-*`는 폴백 400을 타고, `not-found`는 이미 404다 — 도달하지 않는 매핑을 미리 적으면 '이미 맞다'는 착시를 준다(decisions (3)·69 decisions (19)).
- NaN/absent id를 500으로 흘리지 마라. 이유: 계약은 update·deactivate의 없는 id를 **404 not-found**로 동결했다(작업 A로 확정).
- `@RequestParam List<String>` 콤마 분해·인가 전 본문 파싱 금지(step5 동일 이유).
- `docs/api-contract/**`·`contract/**`·정본 러너를 고치지 마라.
