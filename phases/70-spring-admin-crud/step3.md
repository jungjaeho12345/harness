# Step 3: receiver-config-service

수신 설정 서비스(게이트 위임·SAFE_FIELDS 투영)를 이식한다. HTTP 비의존. 라우트를 늘리지 않으므로 계약 scope는 그대로 — 판정은 Java 단위 테스트 + 무회귀다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — 전체(특히 decisions **(4)(5)(6)(8)(10)** · excluded (d))
- `src/services/receiverConfigService.js` — 이식 정본(query·create·remove · SAFE_FIELDS 10키 · sanitize allowlist)
- `src/services/authorization.js` — `manageReceiverConfig` 게이트(Z 전용 · 미인증 401 · 비-Z 403)
- `server-spring/src/main/java/harness/news/service/Authorization.java` — 확장 대상(CAPABILITIES에 행 추가) + `UserService`의 SAFE_FIELDS 투영 재사용 패턴
- `server-spring/src/main/java/harness/news/service/UserService.java` — 같은 계열 서비스(게이트→모델→allowlist 투영)의 이식 선례
- **step1에서 만든 파일**: `server-spring/src/main/java/harness/news/model/ReceiverConfigRepository.java`

## 작업 (테스트 먼저)

1. **테스트 먼저** — `ReceiverConfigServiceTest` 신설. 덮을 계약(Node 대조 — **작업 A로 실측**):
   - **인가**(모든 op): 미인증 → `{ok:false, reason:'unauthenticated'}` · 비-Z(R/D) → `{ok:false, reason:'forbidden'}` · Z → 통과.
   - `query`: Z면 모델 전건을 SAFE_FIELDS 10키(`id,sourceId,type,name,host,port,apiEndpoint,active,createdAt,username`)로 sanitize한 `items`. **`password`·`apiKey`는 어떤 원소에도 없다**(allowlist — 빼기 방식 금지). 미지정 컬럼도 키를 남기고 `null`.
   - `create`: Z면 `{ok:true, id:<정수>}`. **입력 검증 없음**(type/sourceId 미검증 — 게이트 통과 시 항상 성공). 시크릿 미반향. **createdAt을 stamp하지 않는다**(decisions (6) — 입력에 없으면 저장 후 null).
   - `remove`: Z면 `{ok:true, changes:<정수>}`(리포지토리 remove 위임). 없는 id·NaN → `changes:0`.
   - **결함 후보 #3 재현**(excluded (d)): 필터 화이트리스트가 `password`·`apiKey`를 포함해 `?password=값` 필터가 값을 되묻는 Node 동형 — 이 phase는 **고치지 않는다**. 필터 통과 정책이 Node와 같은지(모델 `FILTERABLE`) 관측만 하고, 계약이 이 축을 관측하는지는 작업 A로 확인해 forward_notes에 반영.
2. 구현 전 red(서비스 클래스 부재) 관측·기록.
3. `Authorization.CAPABILITIES`에 `MANAGE_RECEIVER_CONFIG = "manageReceiverConfig" → [Z]` 행 추가(상수·javadoc — 도달하는 capability만). `service/ReceiverConfigService.java` 구현(생성자 주입 · SAFE_FIELDS 10키 단일 상수 allowlist · 게이트는 `Authorization.authorize(token, MANAGE_RECEIVER_CONFIG)` 재사용). green 확인.

## Acceptance Criteria

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B verify
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B -q package -DskipTests
cd /home/user/harness && node scripts/spring-contract.mjs --parity
cd /home/user/harness && npm test
```

- 1번: failures/errors 0. 테스트 수 증가(ReceiverConfigServiceTest).
- 3번: exit 0 · 전 프로파일 `diffs=0`.
- 4번: **1328/1328**.

## 검증 절차

1. **작업 A(Node 대조)**: `src/services/receiverConfigService.js` + `authorization.js`를 직접 관측 — 게이트 사유·SAFE_FIELDS 10키·createdAt 미stamp·remove changes 실측. Java 1:1.
2. **변이 실증**(원복): SAFE_FIELDS를 빼기 방식(전체 − `password`/`apiKey`)으로 바꾸고 임시로 시크릿이 아닌 새 컬럼을 모델에 더하면 그 컬럼이 노출되는지 — allowlist(담기 방식)가 진짜 방어선임을 증명(69 UsersController PUBLIC_FIELDS 선례).
3. **시크릿 미노출 단위 확인**: sanitize 결과 맵에 `password`·`apiKey` 키가 없음을 단언.
4. `Authorization`에 도달하지 않는 capability를 미리 넣지 않았는지 확인(distribution-target은 step4 몫 — 이 step에서 넣지 마라).

## 금지사항

- SAFE_FIELDS를 '빼기' 방식으로 만들지 마라. 이유: 시크릿 컬럼이 추가되는 순간 조용히 노출된다 — allowlist는 언제나 '담을 것'의 목록이다.
- receiver-config create에서 createdAt을 stamp하지 마라. 이유: Node는 stamp하지 않아 저장 후 null이고, 계약이 `createdAtNull:true`를 단언한다(decisions (6)).
- 입력 검증(type/sourceId/role)을 추가하지 마라. 이유: 현행 계약의 재현이다 — 4xx를 만들면 계약이 red가 되고 '이식 결함'과 '의도된 변경'이 뒤섞인다.
- `Authorization`에 `manageDistributionTarget` 행을 지금 넣지 마라. 이유: 도달하지 않는 인가 표는 '이미 맞다'는 착시를 준다 — step4가 자기 라우트와 함께 넣는다(69 Authorization 규율).
- 서블릿 타입을 import하지 마라. 이유: 서비스는 HTTP 비의존이다(ADR-006).
