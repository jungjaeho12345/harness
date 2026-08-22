# Step 5: receiver-config-http

수신 설정 3 라우트(HTTP)를 붙여 **`contract/cases/default/receiver-config.contract.js`가 Spring 대상에서 green**이 되게 한다. 이 step에서 scope 표에 그 파일을 올린다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — 전체(특히 decisions **(1)(3)(5)(6)(7)(8)(10)(11)(13)** · order (c)(d))
- `phases/69-spring-articles/index.json` decisions **(22)(23)** · forward_notes **(8)** — 와이어 포맷·작업 A(리포트가 판정) · 인코딩 divergence 누적
- `contract/cases/default/receiver-config.contract.js` — **완료 판정 계약**. 3 라우트·SAFE 10키·삭제 멱등·NaN id·시크릿 미반향
- `docs/api-contract/endpoints.json` — `receiver-config-list`·`-create`·`-delete` 행(auth·expect)
- `server/index.js` 686~705행 — Node 라우트 3개(`readSessionToken`·`Number(req.params.id)`·`fail`)
- `server-spring/src/main/java/harness/news/controller/UsersController.java` — **가장 가까운 이식 선례**(게이트 `denied()` · `SessionTokens` 쿠키 우선/헤더 폴백 · `JsonHttp`만으로 기록 · 쿼리 원문 배열)
- `server-spring/src/main/java/harness/news/web/RoutePolicy.java` · `PathPolicyFilter.java` — 경로 정책(3 라우트는 이미 39행 표에 있다 — 표를 고칠 일 없다)
- `server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java` · `PathPolicyWireTest.java` — 인벤토리 동기화·스텁 금지 프로브
- `scripts/spring-contract.mjs` — SCOPE 표(default 프로파일 files에 알파벳 순서로 추가)
- **step1·3에서 만든 파일**: `model/ReceiverConfigRepository.java` · `service/ReceiverConfigService.java` · `Authorization`(manageReceiverConfig)

## 작업 (작업 A 먼저, 그다음 테스트, 그다음 구현)

1. **작업 A(기준값은 리포트 실측에서)** — 먼저 Node 대조 리포트를 뽑아 3 라우트의 status·bodyKeys·values·헤더를 확인한다:
   ```
   node scripts/contract-run.mjs --profile default --files contract/cases/default/receiver-config.contract.js --out /tmp/rc-node.json
   ```
   특히 **NaN id 삭제**(`DELETE /api/receiver-config/abc`)가 200 `changes:0`인지 다른 값인지 실측 확정(decisions (7) · open_questions (b)).
2. **테스트 먼저** — `ReceiverConfigWireTest` 신설(전 기동 RANDOM_PORT + 원시 HTTP + 전용 임시 DB, `UsersListWireTest` 패턴): Z 성공(list 10키·create `{ok,id}`·delete `changes:1`·재삭제 멱등·NaN id) · 미인증 401 · 비-Z 403 · **응답 JSON 전문에 `"password"`·`"apiKey"`·시크릿 원문·세션 토큰 부재**. `HandlerInventoryTest`에 3 라우트를 추가하는 단언(20→23)도 이 단계에서 갱신(테스트 먼저 red).
3. 구현 전 red 서명 관측·기록(69 forward_notes (2) 형식 — 예: 인증된 `GET /api/receiver-config`가 매핑 부재로 405 + Boot `/error`).
4. `controller/ReceiverConfigController.java` 구현:
   - `@GetMapping("/api/receiver-config")` — 게이트(Z) → 쿼리 파라미터를 **원문 배열**로 화이트리스트 필터 맵 조립(콤마 분해 금지 · 화이트리스트 밖 무시) → `service.query` → `{ok:true, items}`.
   - `@PostMapping("/api/receiver-config")` — 게이트 통과 후에만 본문 읽기 → `service.create` → `{ok:true, id}`.
   - `@DeleteMapping("/api/receiver-config/{id}")` — 게이트 → `id`를 `Number()` 동형으로 숫자화(NaN 처리는 작업 A 실측에 맞춤) → `service.remove` → `{ok:true, changes}`.
   - 토큰은 `SessionTokens` 쿠키 우선·`x-session-id` 폴백. 응답은 `JsonHttp`(→`RawContentType`)만. 거부는 `ReasonStatus.of(reason)` + `JsonHttp.fail(reason)`.
5. `HandlerInventoryTest.IMPLEMENTED_ROUTES`에 3행 추가(`GET /api/receiver-config`·`POST /api/receiver-config`·`DELETE /api/receiver-config/{id}`) + **메서드명·실패 메시지·javadoc 라우트 수 20→23** 갱신. `scripts/spring-contract.mjs` default 프로파일 files에 `contract/cases/default/receiver-config.contract.js` 추가(알파벳 순서 — `distribution-targets`는 step6). green 확인.
6. **스텁 금지 프로브 확인**: `PathPolicyWireTest`의 미구현 프로브가 이 phase가 구현한 라우트를 가리키지 않는지 확인(현재 `GET /api/media/search` — 그대로 유효). 이 3 라우트를 미구현으로 전제한 다른 Java 단언이 있으면(grep) 조정한다.

## Acceptance Criteria

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B verify
cd /home/user/harness && node scripts/spring-contract.mjs --profile default --files contract/cases/default/receiver-config.contract.js
cd /home/user/harness && node scripts/spring-contract.mjs --parity
cd /home/user/harness && node scripts/spring-contract.mjs --dual-run
cd /home/user/harness && npm test
cd /home/user/harness && git diff --stat
```

- 2번: exit 0 · `receiver-config.contract.js` 전건 green(3 라우트 관측).
- 3번: exit 0 · **default 프로파일 관측이 늘고 diffs=0** · 나머지 프로파일 무회귀.
- 4번: exit 0 · 자기 결정성 diffs=0(프로파일마다 두 패스 pid·port·dataDir 상이).
- 1번: failures/errors 0 · 테스트 수 증가.
- 5번: **1328/1328**.
- 6번: 변경이 `server-spring/**`·`scripts/spring-contract.mjs`에만(무접촉 목록 0줄 — 특히 `contract/**`·`docs/api-contract/**` 무변).

## 검증 절차

1. AC 연속 2회(flake 0).
2. **NaN id 삭제**가 Node 리포트와 같은 status/values인지 대조(작업 A).
3. **투영 누출 최종 확인**: 계약 리포트·와이어 테스트 응답 전문에 `password`·`apiKey`·시크릿·세션 토큰(64-hex) 0건.
4. **스텁 금지**: `HandlerInventoryTest`가 정확히 23 라우트(+`/error`)이고 메서드명·메시지 표기가 23으로 일치하는지, `PathPolicyWireTest` 프로브가 여전히 미구현 라우트를 가리키는지 확인.
5. **행 삭제 경계**: `ReceiverConfigController`의 DELETE가 `ReceiverConfig` 설정 행만 지우고(수집 기사 불변) 다른 테이블 삭제 0임을 확인(decisions (1)).
6. **DB 안전**: 리포 `news.db`·`uploads/` 무변 · 실행 후 잔존 java 프로세스 0 · OS 임시 `spring-contract-*` 잔존 0.

## 금지사항

- `@RequestParam List<String>`로 필터를 받지 마라. 이유: Spring MVC가 콤마를 기본 분해해 `?sourceId=a,b`가 계약과 갈린다 — 요청 파라미터 값 배열(원문)만 쓴다.
- 인가 전에 본문을 읽지 마라. 이유: 거부될 요청의 페이로드를 파싱하지 않는 편이 경계로서 옳다(UsersController 동형).
- `RoutePolicy` 표를 고치지 마라. 이유: 이 3 라우트는 이미 39행 표에 있다 — 경로를 문자열로 직접 비교하지 말고 필요하면 `RoutePolicy`에 물어라(69 forward_notes (8)).
- `docs/api-contract/**`·`contract/**`·`scripts/contract-run.mjs`를 고치지 마라. 이유: 계약 정본은 무수정이며 계약과 다르면 Spring을 고친다.
- 인코딩·매트릭스 파라미터 divergence를 새 결함으로 보고하지 마라. 이유: 69 forward_notes (8) 원장에 누적하는 알려진 축이다(라우트를 늘리면 반복 발생).
