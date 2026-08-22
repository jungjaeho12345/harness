# Step 6: distribution-target-http

배부 대상 컨트롤러를 만든다 — `DistributionTargetsController`(4 라우트: `GET /api/distribution-targets` · `POST /api/distribution-targets` · `PUT /api/distribution-targets/:id` · `POST /api/distribution-targets/:id/deactivate`). 이 step에서 **`contract/cases/default/distribution-targets.contract.js`가 통째로 green**이 된다.

distribution-targets 도메인의 4 라우트가 전부 붙는 첫 지점이다. 계약 파일이 자기 도메인 라우트 4개를 픽스처로 쓰므로(create가 list·update·deactivate의 픽스처), **여기가 이 파일의 유일한 green 지점**이다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — decisions **(5)(6)(7)(10)(11)(14)(15)(18)** · order (f) · forward_notes (2)
- `contract/cases/default/distribution-targets.contract.js` — **이 step의 합격 정의**. 특히 (a) create 200 `{ok:true,id}`·검증 거부 5토큰 400 (b) list 원소 SAFE_FIELDS 정확 7키·spoolDir 실림 (c) update 200 `{ok:true,changes:1}`+updatedAt 갱신·없는 id 404·비수치 id 404(500 아님) (d) deactivate 200 changes:1·되읽으면 active='N'이고 **행은 목록에 남음** (e) `DELETE /api/distribution-targets/:id`는 핸들러 미등록 → 404(JSON 계약 아님, 커버리지 제외 채널로만 관측) (f) 회수는 deactivate뿐(활성인 채 남기지 않는다)
- `docs/api-contract/endpoints.json` — 4 라우트(auth `admin`, create/update의 `validation` 태그)
- `docs/api-contract/openapi.yaml` — 해당 오퍼레이션
- `server/index.js` distribution-targets 라우트 — **이식 원본**. 읽기 전용 참조
- `server-spring/src/main/java/harness/news/controller/ReceiverConfigController.java` — step3이 세운 같은 도메인 형태의 컨트롤러(게이트·shape·`JsonHttp` 패턴 재사용)
- `server-spring/src/main/java/harness/news/service/DistributionTargetService.java` — step5가 만든 서비스
- `server-spring/src/main/java/harness/news/web/ReasonStatus.java` — 사유→상태(forbidden 403·not-found 404 있음, 검증 5토큰은 폴백 400 — 추가 금지)
- `server-spring/src/main/java/harness/news/web/RoutePolicy.java` 139~143행 — 4 라우트 이미 `AuthClass.ADMIN` 등재(수정 금지)
- `server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java` — 구현 라우트 목록(이 step에서 +4 → 27) · 메서드명·라우트 수 표기
- `scripts/spring-contract.mjs` scope 표 `default` 행(이 step에서 파일 1개 추가)

## 배경 (동결된 계약 사실)

- 인증 클래스 `admin`: 필터가 미인증 401을 끊고, 컨트롤러/서비스가 비-Z 403.
- 검증 거부 5토큰(invalid-name·invalid-kind·invalid-spool-dir·duplicate-spool-dir·invalid-active)은 서비스가 낸다 → 컨트롤러가 `ReasonStatus.of(reason)`(폴백 400)으로 매핑.
- update/deactivate: 없는 id·비수치 id → 404 not-found(**500 아님** — 서비스가 NaN 수렴). deactivate 후 행은 목록에 남는다(active='N').
- **`DELETE /api/distribution-targets/:id`는 구현하지 않는다** — 핸들러 미등록으로 404가 나는 것이 계약이다. 이 라우트를 만들지 마라(삭제 경로 없음).
- `ReasonStatus`는 이미 forbidden 403·not-found 404를 갖고 검증 5토큰은 폴백 400 — **매핑 추가 금지**(decisions (7)).

## 작업

### A. Node 대조 리포트 실측 (구현 전, decisions (17))

```bash
cd /home/user/harness && OUT="$(mktemp -d)" && node scripts/contract-run.mjs --profile default --files contract/cases/default/distribution-targets.contract.js --out "$OUT/node-dt.json" && ls -l "$OUT"
```

각 라우트의 status·bodyKeys·values(특히 update의 changes·updatedAt 갱신, 검증 거부의 reason·400, 비수치 id의 404)·헤더를 확인하고 요약에 1~2줄.

### B. `controller` 계층 — `DistributionTargetsController`

- `@GetMapping` list · `@PostMapping` create · `@PutMapping("/api/distribution-targets/{id}")` update · `@PostMapping("/api/distribution-targets/{id}/deactivate")` deactivate.
- 각 핸들러: 토큰 읽기(`SessionTokens`) → 서비스 op → `{ok:false,reason}`이면 `ReasonStatus.of(reason)` + `JsonHttp.fail(reason)`, 성공이면 200 + shape.
- create/update/deactivate 본문은 **인가 통과 뒤에만** 읽는다(거부될 요청 페이로드 파싱 금지 — users 컨트롤러 규율).
- create `{ok:true,id}` · update/deactivate `{ok:true,changes}` · list `{ok:true,items}`.
- id·createdAt·updatedAt·active 기본값은 서비스가 정한다 — 컨트롤러는 클라 role/id/타임스탬프를 신뢰하지 않는다(ADR-004).

### C. 인벤토리·scope 표 갱신 (같은 step에서 — 스텁 금지 게이트)

- `HandlerInventoryTest.IMPLEMENTED_ROUTES`에 4행 추가(list·create·update·deactivate → 총 27). **같은 step에서** 메서드명·실패 메시지·javadoc의 라우트 수(23 → 27)도 갱신.
- `DELETE /api/distribution-targets/:id`는 **추가하지 마라**(미구현이 계약).
- `scripts/spring-contract.mjs` scope 표 `default` 행에 `contract/cases/default/distribution-targets.contract.js` 추가. **알파벳 정렬 위치**: `crosscutting.contract.js`와 `health.contract.js` 사이.
- `server-spring/src/test/**`에 이 4 경로를 '미구현'으로 전제한 단언이 있는지 검색(계획 시점: 없음 — 재확인 1줄).

### D. 와이어 테스트 (먼저 쓴다 — 전 기동 RANDOM_PORT + 원시 HTTP, MockMvc 금지)

1. Z create → 200 `{ok:true,id}` · 검증 거부 5종 각각 400 + 정확한 reason.
2. Z list → 200, 원소 정확 7키, spoolDir 실림, 시크릿/미허용 키 없음. **비ASCII(한글) name 왕복 확인**(forward_notes (3)②).
3. update(자기 id) → 200 changes:1, 되읽으면 updatedAt 갱신 · 없는 id 404 · 비수치 id('abc') 404(500 아님).
4. deactivate(자기 id) → 200 changes:1, 되읽으면 active='N'이고 **목록에 남음** · `PUT {active:'N'}`도 같은 결과(두 진입점 수렴).
5. 미인증 401 · R 403(4 라우트 동형).
6. **투영 누출 없음**: 응답 JSON 전문에 미허용 키 없음.

## Acceptance Criteria

프레시 체크아웃이면 먼저: `cd /home/user/harness && npm ci`

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./mvnw -B verify
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./mvnw -B -q package -DskipTests
cd /home/user/harness && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 node scripts/spring-contract.mjs --parity
cd /home/user/harness && npm test
cd /home/user/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가. 실측치를 요약에 적는다.
- 3번: exit 0이고 **default 프로파일에 distribution-targets 케이스가 실행돼 관측 수가 늘어난 채** 4 프로파일 전부 `diffs=0`. observations가 step3 이후 값보다 커졌는지 확인.
- 4번: **1328/1328**(불변).
- 5번 증분 = `.../controller/DistributionTargetsController.java` · `server-spring/src/test/java/harness/news/**` · `.../web/HandlerInventoryTest.java` · `scripts/spring-contract.mjs` · `phases/70-spring-admin-crud/index.json`.

## 검증 절차

1. **red 먼저**: D의 와이어 테스트를 구현 전에 돌려 실패 실측(인증 요청 404 — 실제 관측값).
2. AC 실행. `--parity` default 관측 수 증가 확인.
3. **soft delete 변이 실증(원복)**: deactivate를 실제 행 삭제로 바꾸면 계약 red인가(4번: 목록에 남아야 하는데 사라짐 · 그리고 `NoSchemaSqlInMainSourcesTest`가 DistributionTarget DELETE FROM으로 red) — 확인 후 원복.
4. **DB 비파괴**: 하네스가 리포 `news.db`·`uploads/` 무변 단언. **distribution-targets.contract.js가 만든 대상이 전부 active='N'로 회수됐는지**(그 파일의 `after`가 deactivate하며, 활성 대상이 남으면 forward_notes (2)의 송고 훅 전제가 흔들린다 — step7이 최종 확인).
5. `git status --porcelain` 증분 확인 → index.json step6 갱신(관측 수·green 확인 포함).

## 금지사항

- `DELETE /api/distribution-targets/:id` 핸들러를 만들지 마라. 이유: 미구현 404가 계약이다(제거는 deactivate뿐).
- update/deactivate에서 비수치 id에 500을 내지 마라. 이유: 계약은 404 not-found를 동결했다(서비스의 NaN 수렴).
- `ReasonStatus`에 검증 5토큰을 추가하지 마라. 이유: fail fallback 400이 계약이다.
- 응답을 Spring MVC 메시지 컨버터로 만들지 마라. 이유: Content-Type 바이트가 어긋난다 — `JsonHttp` 한 지점.
- `RoutePolicy`·계약 파일·명세를 고치지 마라. 이유: 4 라우트가 이미 등재됐고, 계약과 다르면 Spring을 고친다.
- 송고 훅·배부 실행·스풀 쓰기를 만들지 마라. 이유: 배부 실행 phase 소유다(ADR-008).
