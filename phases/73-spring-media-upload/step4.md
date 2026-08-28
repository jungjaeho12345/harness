# Step 4: photo-service

## 읽어야 할 파일

- `phases/73-spring-media-upload/index.json` — decisions **(11)**(리포지토리 규율) · **(12)**(append-only · `registeredBy` 세션 stamp · `FileRef` 재사용) · (14)(반복 쿼리 키) · (18)(Clock) · (19)(DB 비파괴) · (22)⑧.
- Node 정본: `src/services/photoService.js` 전문 · `src/models/photoModel.js` 전문 · `server/index.js` 1048~1065행(두 라우트) · `src/services/fileRef.js` 전문.
- Spring 현행: `service/FileRef.java` **전문**(이미 이식돼 있다 — 재구현 금지) · `service/Iso8601.java` · `config/AppConfig.java`(Clock 빈).
- Spring 선례: `service/ReceiverConfigService.java`(서비스가 검증·투영을 소유하는 형태) · `service/FileRefTest.java`.
- 계약(읽기만): `contract/cases/default/media-upload.contract.js` 308~437행.
- 명세(읽기만): `docs/api-contract/openapi.yaml`의 `/api/photos`·`/api/photos/search` 절 · `reason-tokens.md` 표 2 #5·표 3 #12.
- step0 산출물: `model/PhotoRepository.java`.

## 배경 (동결된 사실)

- 등록 흐름(정본): `src = sanitizeFileRef(dto.src ?? '')` → 빈 문자열이면 `{ok:false, reason:'invalid-src'}` → 아니면
  `photoModel.insert({src, caption: dto.caption ?? '', sourceArticleId: dto.sourceArticleId ?? '', registeredBy: userId ?? null, createdAt: nowISO()})` → `{ok:true, id}`.
- **`registeredBy`는 인자 `userId`(검증된 세션에서 도출)로만 채운다. `dto.registeredBy`가 있어도 무시한다**(ADR-004).
  라우트는 body에서 `{src, caption, sourceArticleId}`만 구조분해해 넘긴다 — **서비스에 넘기지도 않는다**.
- `caption`·`sourceArticleId` 생략은 **빈 문자열**(null 아님). 계약이 `sourceArticleId === ''`를 단언한다.
- 검색은 얇은 위임이다: `photoModel.searchByCaption(q)` — `LIKE '%q%'` · `ORDER BY id DESC` · 원소는 6컬럼 그대로.
- 라우트는 `req.query.q ?? ''`로 정규화한다 → **`q` 생략과 빈 문자열이 같다**. 키가 반복되면 배열이 되어 `'a,b'`로 결합된다(계약 밖 → 이 step의 테스트가 유일 방어선).
- 거부(`invalid-src`)는 **라우트 직접 400**이고 행이 생기지 않는다. 계약이 되읽기로 `items: []`를 확인한다.
- 시각은 **주입된 `Clock`**에서만 온다(`ClockDisciplineTest`가 정적으로 강제한다 · 예외는 `AppConfig.java` 하나).

## 작업

1. **테스트 먼저**: `service/PhotoServiceTest.java`. `@TempDir` 임시 DB + 고정 `Clock`(`testsupport/MutableClock`)만 쓴다.
   - 허용 `src` 2종(`/uploads/xxx.png` 상대경로 · `https://example.test/p.png`)은 등록되고 정수 id가 돌아온다.
   - 거부 `src` 4종(`javascript:alert(1)` · `data:image/png;base64,AAA` · `http://...` · `/uploads/../secret.png`)은 `invalid-src`이고 **행 수가 변하지 않는다**(등록 전후 `searchByCaption("")` 크기 비교).
   - **추가 거부 축**(계약 밖 — `FileRef` 재사용의 증거): 프로토콜 상대(`//host/p.png`) · 백슬래시 포함 · 제어문자/공백 포함 · 빈 문자열.
   - `caption`/`sourceArticleId` 미지정 시 저장값이 **빈 문자열**이고 `null`이 아니다.
   - `registeredBy`는 **인자 userId**로만 채워진다 — dto에 `registeredBy:'someone-else'`를 넣어도 무시된다.
   - `createdAt`이 주입된 시계 값과 **바이트 동형**이다(`Iso8601.format` — 소수 3자리 고정).
   - 검색이 **id DESC**이고, 빈 질의(`""`)와 `null`이 같은 결과이며, `"%"`가 전체와 일치한다.
   - **반복 쿼리 키**: 값이 `List.of("a","b")`로 들어오면 `'a,b'`로 결합되어 `LIKE '%a,b%'`가 된다(첫 값으로 접지 마라).
2. `harness.news.service.PhotoService`를 만든다. 시그니처 수준 지시:
   - 생성자 주입: `PhotoRepository`, `java.time.Clock`. **서블릿 타입 import 0.**
   - `Map<String,Object> register(Object src, Object caption, Object sourceArticleId, String userId)` 형태.
     신원은 **마지막 인자로만** 들어온다 — dto 맵째로 받아 안에서 `registeredBy`를 꺼내는 형태를 만들지 마라(그 순간 위조 경로가 생긴다).
     반환은 `{ok:true, id}` 또는 `{ok:false, reason:"invalid-src"}` — 순서 있는 맵 투영.
   - `List<Map<String,Object>> search(Object q)` — `q`가 `null`이면 `""`, `List`면 콤마 결합(Node `String(array)` 동형).
   - `src` 검증은 **`FileRef.sanitize`만** 쓴다(재구현·추가 규칙 금지). Node가 `String(value)`를 먼저 부르므로 비-문자열도 문자열이 된 뒤 규칙을 탄다 — `FileRef.sanitize(Object)`가 이미 그렇게 돼 있다.
   - `caption`·`sourceArticleId`의 `?? ''`는 **null 병합**이다(빈 문자열·`false`·`0`은 그대로 간다 — `||`가 아니다).
3. `AppConfig`(또는 해당 합성 루트)에 `PhotoRepository`·`PhotoService` 빈 배선을 추가한다. **생성자 주입만.**

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
# → BUILD SUCCESS · Tests run: N (N > step3 수치) · Failures: 0 · Errors: 0
# → ClockDisciplineTest green (인자 없는 시각 API 0 · 예외는 AppConfig.java 하나)
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
# → exit 0 · profiles=5 · diffs=0 · 265관측 (불변)
cd d:/agents/harness && npm test    # → 1328 pass / 0 fail (불변)
```

**AC 마지막 항목(필수)**: 아래 '검증 절차'의 변이 **전건**에 대해 `변이 | 심은 곳 | 기대 | 실제(red/green) | 원복 확인(git diff 공백)` 표를 **step 요약에 기록**하라. **미기록이면 이 step은 미완이다** — 빌드 green과 관측 수 불변만으로 만족되는 AC는 공허하다(index.json decisions (23)).

## 검증 절차 (변이 포함)

1. **변이 A(신원 위조)**: `register`가 dto 맵에서 `registeredBy`를 읽어 우선 사용하게 한다 → 위조 무시 테스트가 red → 원복.
2. **변이 B(`??` → `||`)**: `caption ?? ''`를 `||` 의미(빈 문자열도 기본값으로 접기)로 바꾼다 → 결과가 같아 red가 안 날 수 있다. **red를 내는 케이스를 만들어라**: `sourceArticleId`에 값이 있는 등록과 없는 등록을 나란히 두고 저장값을 대조하라. red가 나지 않으면 그 사실을 요약에 적고 divergence 후보로 남겨라.
3. **변이 C(정렬)**: `ORDER BY id DESC`를 `ASC`로 바꾼다 → 최신 우선 단언이 red → 원복.
4. **변이 D(검증 우회)**: `FileRef.sanitize` 호출을 지우고 `src`를 그대로 저장하게 한다 → 거부 4+4종이 red → 원복.
5. **변이 E(반복 키)**: `List` 입력에서 첫 값만 쓰게 한다 → 반복 키 테스트가 red → 원복.
6. **변이 F(시계)**: `createdAt`을 `Instant.now()`로 바꾼다 → `ClockDisciplineTest`가 **정적으로** red(이것이 그 게이트의 존재 이유다) → 원복.

## 금지사항

- **`src` 검증 규칙을 재구현하거나 넓히지 마라.** 이유: 첨부/자료 파일과 사진 src는 **규칙의 단일 출처**(`fileRef.js` → `FileRef.java`)이고, 한쪽만 넓어지면 발행 HTML에 재임베드되는 참조에서 방어가 갈린다.
- **`registeredBy`를 dto 경로로 받지 마라.** 이유: ADR-004 — 신원은 검증된 세션에서만 도출한다. 계약이 되읽기로 이 사실을 관측한다.
- **`Photo`에 UPDATE/DELETE를 만들지 마라.** 이유: append-only이고 DB 비파괴는 절대 규칙이다(step0이 정적 스캔으로 잠갔다).
- **`registeredBy` 노출을 '고치지' 마라.** 이유: `SELECT` 6컬럼 무투영이 현행 계약이다(openapi '결함 후보 #5') — 고치면 계약이 red다. 옳다고 승인된 것은 아니며 별도 판단 사안이다.
- **`Instant.now()`·`System.currentTimeMillis()`를 쓰지 마라.** 이유: `ClockDisciplineTest`가 main 소스 전체를 정적으로 잠그고, 시각 비결정성은 `--dual-run` diff로만 뒤늦게 드러난다.
- **컨트롤러를 만들지 마라.** 이유: 이 step은 서비스 레이어 하나만 소유한다.
