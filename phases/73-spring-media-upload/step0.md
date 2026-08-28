# Step 0: photo-repository

## 읽어야 할 파일

- `phases/73-spring-media-upload/index.json` — **scope · baseline · decisions 전문**. 특히 baseline의 재측정 수치와 decisions (10)(11)(19)(21).
- `phases/72-spring-distribution/index.json` — `forward_notes` (1)(9)(12) (마감 실측·누적 이월·환경 함정).
- Node 정본: `src/db/schema.js` 103~110행(`Photo` 6컬럼) · `src/models/photoModel.js` 전문.
- Spring 현행: `server-spring/src/main/java/harness/news/db/RequiredSchema.java` · `db/SchemaGuard.java` · `model/ArticleHistoryRepository.java`(특히 `insert` — `GeneratedKeyHolder` 사용 형태) · `model/ReceiverConfigRepository.java`(대조군: `last_insert_rowid()`를 별도 문장으로 부르는 형태 — **따라 하지 마라**).
- Spring 테스트: `server-spring/src/test/java/harness/news/db/SchemaGuardTest.java` · `db/DbBootGuardTest.java` · `model/ArticleHistoryRepositoryTest.java` · `testsupport/TempNewsDb.java`.
- `docs/api-contract/openapi.yaml`의 `/api/photos/search` 절(응답 원소 6키 · id DESC · LIKE).

## 배경 (동결된 사실 — 재확인은 하되 전제로 삼아라)

- 이 phase는 `feat-0-mvp`의 `dc2d5a8`(PR #116 머지)에서 분기한 **`feat-73-spring-media-upload`** 위에서 진행한다.
- 기준선(2026-08-28 실측): Java **1031 tests / 0 fail** · `--parity` **265관측 diffs 0**(default 198 · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3) · `npm test` **1328/1328** · 구현 라우트 **32/39** · 리포 `uploads/` **32항목 6,068,792 B**.
- 이 서버는 **DDL을 한 줄도 실행하지 않는다**. `RequiredSchema`는 '부팅 시 읽기로만 존재를 확인하는 요구 목록'이다.
- `Photo` 테이블 정본 컬럼(순서 포함): `id`(INTEGER PRIMARY KEY) · `src` · `caption` · `sourceArticleId` · `registeredBy` · `createdAt`.
- `photoModel.insert`는 **present-only INSERT**(`record[c] !== undefined`인 컬럼만)이고 `searchByCaption`은
  `SELECT * FROM Photo WHERE caption LIKE ? ORDER BY id DESC`에 `%q%`를 바인딩한다. **ESCAPE 절이 없다.**

## 작업

1. **기준선을 직접 재측정하고 기록한다**(추정 금지 · **이 step의 첫 작업이다**). ②가 실행 시간 때문에 재확인하지 못한 값이 **둘**이다 — Java **1031**과 `npm test` **1328**. 아래를 돌려 수치를 step 요약에 남기고, **하나라도 불일치하면 그 자리에서 `index.json`의 baseline과 전 step AC의 기대치(테스트 수 N·관측 수)를 갱신한 뒤 진행하라**(그 갱신 자체를 step 요약에 적어라). 나머지 값(5 라우트·31관측·265관측·Node base64/extname 실측·정적 서빙 헤더)은 ②가 실측 확인했으므로 재측정은 선택이다.
   - `cd server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B clean verify` → `Tests run: N`
   - `cd <리포 루트> && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity` → `profiles=5 diffs=0`, 프로파일별 `observations=`
   - `npm test` → `pass/fail`
   - 리포 `uploads/` 항목 수·총 바이트를 적어라(무접촉 단언의 기준값).
2. **테스트 먼저**: `RequiredSchema`에 `Photo`가 요구 테이블로 들어갔을 때의 기대를 `SchemaGuardTest`에 추가한다.
   - `Photo` 테이블이 없는 DB에서는 `SchemaGuard.verify()`가 `테이블 없음 = Photo`를 지목하며 실패한다.
   - `Photo`는 있는데 `registeredBy` 컬럼이 없으면 그 컬럼을 지목하며 실패한다.
   - 정본 스키마로 시드한 DB에서는 통과한다.
3. `RequiredSchema`에 `PHOTO_TABLE`·`PHOTO_COLUMNS`(6, 스키마 순서 그대로)를 추가하고 `TABLES` 맵을 6 → **7** 항목으로 넓힌다.
   `TABLES`가 `Map.of(...)`라면 항목 수 상한(10)을 넘지 않는지 확인하라.
4. **정본 픽스처를 같은 step에서 확장한다** — `RequiredSchema.TABLES`를 넓히면 그것을 쓰는 기존 테스트/부트 가드가 함께 움직인다.
   `SchemaGuardTest`·`DbBootGuardTest`·`TempNewsDb`(및 그 밖에 요구 테이블 집합을 열거하는 곳)를 **전수 조사**해 갱신하라.
   (phase 70이 4→6으로 넓힐 때와 같은 절차다. 한 곳만 고치면 부트가 뜨지 않는다.)
5. **테스트 먼저**: `PhotoRepositoryTest`를 쓴다. `@TempDir` 임시 DB만 쓴다.
   - `insert`가 새 행의 id를 돌려주고, **연속 삽입에서 id가 오배정되지 않는다**(동시 삽입 시나리오 포함 — `ArticleHistoryRepositoryTest`의 동시성 잠금 테스트 형태를 참고하라).
   - present-only: 값이 없는 컬럼은 INSERT 문에서 빠진다(= SQL NULL 유지). 넣을 컬럼이 하나도 없으면 예외.
   - `searchByCaption("")`은 전체를 **id DESC**로 돌려준다.
   - `searchByCaption("%")`는 **전체와 일치한다**(Node는 `%`를 이스케이프하지 않는다). ← 이 단언이 `ESCAPE` 추가를 막는 잠금이다.
   - 반환 행의 키가 정확히 6종이고 순서가 `id,src,caption,sourceArticleId,registeredBy,createdAt`이다.
6. `harness.news.model.PhotoRepository`를 만든다. 시그니처 수준 지시(구현은 재량):
   - `long insert(Map<String,Object> record)` 또는 동등한 값 객체 — **`GeneratedKeyHolder`로 삽입과 id 회수를 한 문장에서** 처리한다. `last_insert_rowid()`를 별도 문장으로 부르지 마라(이유: phase 70에서 동시 삽입 id 오배정이 실측 재현됐고, 사진 id는 응답으로 나가 클라이언트가 행을 지목하는 식별자다).
   - `List<Map<String,Object>> searchByCaption(String q)` — `SELECT`는 **6컬럼을 명시 나열**한다(`SELECT *` 금지. 이유: Node 스키마에 컬럼이 추가되면 Node는 노출하고 Spring은 안 하는 안전측 divergence로 수렴시키기 위함이며, 그 사실을 step10 forward_notes에 남긴다). `LIKE ?`에 `"%" + q + "%"`를 바인딩하고 **`ESCAPE`를 붙이지 마라**.
   - 반환 맵은 키 순서가 재현되도록 `LinkedHashMap`을 쓴다.
7. **정적 잠금 추가**: main 소스에 `UPDATE Photo` / `DELETE ... Photo`가 0건임을 확인하는 단언을 `NoSchemaSqlInMainSourcesTest`의 원장 스캔과 **같은 형태로** 추가한다(`Photo`도 append-only다). 테이블 이름을 상수로 참조하는 우회까지 보도록 기존 `TABLE_CONSTANTS` 치환 스캐너를 재사용하라.

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B clean verify
# → BUILD SUCCESS · Tests run: N (N > 1031) · Failures: 0 · Errors: 0 · Skipped: 0
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
# → exit 0 · profiles=5 · diffs=0 · 관측 198/55/4/5/3 = 265 (불변)
cd d:/agents/harness && npm test
# → tests 1328 / pass 1328 / fail 0 (불변)
cd d:/agents/harness && git status --porcelain
# → 미추적은 .vscode/ 뿐, 변경은 server-spring/** 와 phases/73-spring-media-upload/** 뿐
```

`--parity` 전에 반드시 `cd server-spring && JAVA_HOME=... ./mvnw -B -q package -DskipTests`로 jar를 갱신하라
(하네스는 jar를 스스로 빌드하지 않는다 — 안 하면 이전 jar를 측정한다).

**AC 마지막 항목(필수)**: 아래 '검증 절차'의 변이 **전건**에 대해 `변이 | 심은 곳 | 기대 | 실제(red/green) | 원복 확인(git diff 공백)` 표를 **step 요약에 기록**하라. **미기록이면 이 step은 미완이다** — 빌드 green과 관측 수 불변만으로 만족되는 AC는 공허하다(index.json decisions (23)).

## 검증 절차 (변이 포함)

1. **변이 A(스캐너 비공허성)**: `RequiredSchema.PHOTO_COLUMNS`에서 `registeredBy`를 뺀다 → 새 `SchemaGuardTest` 케이스가 red인지 확인 → 원복.
2. **변이 B(id 오배정)**: `PhotoRepository.insert`를 `GeneratedKeyHolder` 대신 `SELECT last_insert_rowid()` 별도 문장으로 바꾼다 → 동시 삽입 테스트가 red인지 확인 → 원복. **red가 나지 않으면 그 테스트는 공허하다 — 동시성 시나리오를 강화하라.**
3. **변이 C(LIKE 이스케이프)**: `searchByCaption`에 `ESCAPE '\\'`와 `%`·`_` 이스케이프를 추가한다 → `searchByCaption("%")` 케이스가 red인지 확인 → 원복.
4. **변이 D(투영 확대)**: `SELECT` 목록을 `SELECT *`로 되돌린다 → 6컬럼/순서 단언이 여전히 green이면(오늘 결과가 같으므로 green일 것이다) 그 사실을 step 요약에 적어라 — 이 변이는 **red가 나지 않는 것이 정상**이며, 명시 나열의 근거는 회귀 방지가 아니라 미래의 컬럼 추가에 대한 안전측 선택임을 기록으로 남긴다.
5. 리포 `news.db`·`uploads/`의 크기·항목 수가 step 시작 시점과 같은지 확인한다.

## 금지사항

- **DDL을 실행하지 마라**(`CREATE`/`ALTER`/`DROP` 문자열 포함). 이유: `NoSchemaSqlInMainSourcesTest`가 주석까지 스캔하고, 스키마 소유자는 P2까지 Node다.
- **`DELETE FROM`·`UPDATE Photo`를 추가하지 마라.** 이유: 사진DB는 append-only이며 DB 비파괴가 이 프로젝트의 절대 규칙이다.
- **`last_insert_rowid()`를 별도 문장으로 부르지 마라.** 이유: 동시 삽입에서 남의 id를 돌려주는 것이 phase 70에서 실측 재현됐다.
- **`LIKE`에 `ESCAPE`를 붙이지 마라.** 이유: Node가 이스케이프하지 않으므로 같은 질의에 두 서버가 다른 행 집합을 준다(계약이 관측하지 않는 축이다).
- **리포 `news.db`를 열지 마라.** 이유: 테스트는 `@TempDir`만 쓴다. `app.data-dir` 미설정 시 기동 거부가 1차 방어선이고 그것을 우회하지 마라.
- **`scripts/**`·`contract/**`·`docs/api-contract/**`·`server/**`·`src/**`를 고치지 마라.** 이유: 이 포팅에서 정본은 무수정이고 다르면 Spring을 고친다.
- **컨트롤러·서비스를 만들지 마라.** 이유: 이 step은 db/model 레이어 하나만 소유한다(scope 최소화).
