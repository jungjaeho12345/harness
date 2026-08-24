# Step 9: spool-writer

배부 스풀 writer를 만든다 — `SpoolWriter`(= `src/services/spoolWriter.js` 이식). **이 파일이 이 서버에서 파일을 쓰는 유일한 자리**이며 step1 정적 게이트의 **예외 2개 중 나머지 하나**다. ADR-008 (1)의 "앱은 스풀에 쓰기만 하고 발송은 외부 전송기가 한다"가 여기서 실현된다.

이 step은 **어댑터 한 클래스 + 스풀 루트 설정**만 만든다. 계약은 아직 green이 될 수 없다.

## 읽어야 할 파일

- `phases/71-spring-distribution/index.json` — decisions **(2)(3)(10)(11)(26)**
- `src/services/spoolWriter.js` — **이식 원본 전문**: `CONTENTS_FIELDS`(18) · `ARTICLE_FIELDS`(1) · `pick` · `compactStamp` · `write`
- `src/services/spoolDir.js` — 슬러그 규칙(**phase 70이 이미 `SpoolDir.java`로 이식했다 — 복제 금지, 재사용**)
- `docs/ADR.md` ADR-008 (1) — 파일 스풀 outbound
- `contract/cases/default/distribution-tick.contract.js`의 `assertNoSpoolPath` — **응답에 경로가 새면 안 된다**는 계약(이 step은 그 값을 만들지 않는 쪽이지만, `write`의 반환 `file`이 상위로 새지 않도록 하는 규율의 출발점이다)
- `server-spring/src/main/java/harness/news/service/SpoolDir.java` — phase 70 산출물(`sanitizeSpoolDir`)
- `server-spring/src/main/java/harness/news/model/ContentsRow.java` — `column(String)` 접근자(전 컬럼 맵은 이 패키지 밖으로 나오지 않는다)
- `server-spring/src/main/java/harness/news/model/ArticleAggregate.java` — `article`(맵) + `contents`(ContentsRow)
- `server-spring/src/main/java/harness/news/service/Iso8601.java` · `config/AppConfig.java`(Clock 빈)
- `server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java` — 파일 쓰기 예외 목록

## 배경 (동결된 사실)

### 필드 allowlist (decisions (10))

Contents **18키**(이 순서 그대로): `articleId, title, author, coAuthor, department, departmentCode, category, region, attribute, keyword, externalComment, attachmentFile, referenceFile, createdAt, sentAt, embargoAt, secondEmbargoAt, status`
Article **1키**: `markupVersion`
서버 주입: `distributedAt`

**제외가 의도**다: `internalComment`(내부코멘트) · 편집 잠금 5컬럼(`lockYN`·`lockerUserId`·`lockerSessionId`·`lockerClientId`·`lockedAt`) · `content`(평문 미사용) · `modifier`·`sender`·`editedAt`. 블랙리스트가 아니라 **allowlist**이므로 새 컬럼이 생겨도 기본값은 미노출이다.

**`pick` 의미론**: `값 != null`일 때만 담는다 = **SQL NULL 컬럼은 키 자체가 빠진다**. API 투영의 'NULL 키 보존'과 **정반대**다 — 두 규칙을 섞지 마라.

**조립 순서**(`LinkedHashMap`으로 재현): Contents 18키 순서 → `markupVersion` → `articleId` 덮어쓰기(위치는 첫 등장 자리 유지) → `title`이 없고 `article.title`이 있으면 `title` 추가 → `distributedAt`. 외부 전송기가 읽는 파일이라 **키 순서도 산출물**이다.

### 경로·게시 규율 (decisions (11))

1. `rootDir` 없음 → `{ok:false, reason:'spool-disabled'}`.
2. `SpoolDir.sanitizeSpoolDir(spoolDir)` **재검증** → `''`이면 `invalid-spool-dir`. **DB에 저장된 값이라도 신뢰하지 않는다** — 경로 합성 직전이 마지막 방어 지점이다.
3. `articleId`가 문자열이고 `^[A-Za-z0-9_-]{1,64}$`가 아니면 `invalid-article-id`.
4. `stamp = now()`(주입 `Clock` → `Iso8601`) · 파일명 `<articleId>_<compactStamp(stamp)>.json` — `compactStamp`는 `-`·`:`·`.` **제거**(`2026-07-28T01:02:03.456Z` → `20260728T010203456Z`).
5. 같은 디렉토리 안 임시 파일 `.<name>.tmp`에 쓰고 **`Files.move(tmp, final, ATOMIC_MOVE)`**. 원자 이동이 실패하면 **일반 move로 폴백하지 마라** — `spool-write-failed`로 보고한다(폴백은 원자성 보장을 조용히 잃고, 외부 전송기가 부분 파일을 집어간다).
6. 디렉토리는 `createDirectories`(멱등).
7. 내용은 **UTF-8**로 쓴다(`StandardCharsets.UTF_8` 명시 — 플랫폼 기본 인코딩 금지. Windows 기본은 UTF-8이 아니다).
8. **throw하지 않는다**: 모든 실패는 `{ok:false, reason}`. 한 수신처의 실패가 다른 수신처나 송고를 막으면 안 된다.
9. 성공 반환은 `{ok:true, file:<절대경로>}` — **이 값은 호출자가 로그·응답으로 흘리지 않는다**(step10·13의 투영 규율).

## 작업

### A. Node 실측 대조

`node -e`로 원본 `createSpoolWriter`를 주입 fs(가짜)로 불러 다음을 확인해 요약에 적는다: payload의 **키 순서와 키 집합**(NULL 컬럼이 빠지는지) · 파일명 형태 · `title` 폴백이 실제로 언제 걸리는지 · `spoolDir`이 잘못됐을 때 mkdir이 **호출되지 않는지**.

### B. 스풀 루트 설정

- `application.properties`에 `app.dist-spool-dir=${DIST_SPOOL_DIR:}`(주석: 미설정 = 배부 전면 비활성, **기본값 하드코딩 금지**).
- `AppProperties`에 필드 추가. **빈 문자열·공백이면 '없음'**이다. 경로를 추정하지 마라(cwd·DATA_DIR 하위 등).
- 루트 유무 판정은 **단 한 곳**(decisions (3)) — 예: `SpoolRoot`(또는 `AppProperties.distSpoolPath()`)가 `Optional<Path>`를 돌려주고, 그 값이 없으면 `SpoolWriter` 빈이 만들어지지 않거나 `enabled()`가 false다. tick·retry가 그 하나만 본다.

### C. `SpoolWriter` (`harness.news.service`)

- 시그니처(구현 재량): `WriteResult write(String spoolDir, String articleId, Map<String,Object> article, ContentsRow contents)` → `record WriteResult(boolean ok, String reason, String file)`.
- 생성자 주입: 스풀 루트(`Path`) · `Clock`.
- `contents`에서 18키를 `column(String)`으로 읽는다(전 컬럼 맵을 얻으려 하지 마라 — 패키지 경계가 막는다).
- `article`은 평범한 맵이므로 `markupVersion`·`title`을 그대로 읽는다.
- JSON 직렬화는 기존 Jackson 경로를 쓴다(`LinkedHashMap` 순서 보존 확인).

### D. step1 게이트의 예외 목록 확인

- 파일 쓰기 예외 목록이 `SpoolWriter.java` **하나**인지, `theExceptionListIsExactlyTwoFiles`가 여전히 green인지 확인한다.

### E. 테스트 (먼저 쓴다 — `SpoolWriterTest`, `@TempDir`)

1. 성공: 파일이 `<root>/<spoolDir>/<articleId>_<stamp>.json`에 생기고 **`.tmp` 파일이 남지 않는다**.
2. **payload 키 집합·키 순서**를 단언(19키 + `distributedAt`). `internalComment`·잠금 5컬럼·`content`·`sender`·`modifier`·`editedAt`이 **없다**.
3. **NULL 컬럼은 키가 빠진다**(예: `sentAt`이 NULL이면 payload에 `sentAt` 키가 없다).
4. `distributedAt`은 **주입 시계 값**이고, Contents에 저장돼 있던 `distributedAt`을 그대로 쓰지 않는다.
5. `title` 폴백: Contents의 `title`이 NULL이고 Article에 `title`이 있으면 그 값이 실린다.
6. 잘못된 `spoolDir`(대문자·`..`·`/`·`con`·빈 문자열·null) → `invalid-spool-dir`이고 **디렉토리가 생기지 않는다**(파일시스템 무접촉을 실제 파일 목록으로 단언).
7. 잘못된 `articleId`(공백 포함·`../x`·65자·빈 문자열·null) → `invalid-article-id`, 파일 0개.
8. 루트 미설정 → `spool-disabled`, 파일 0개.
9. **쓰기 실패**(예: 대상 경로에 같은 이름의 **디렉토리**를 미리 만들어 둔다 / 읽기 전용 루트) → `spool-write-failed`이고 **예외가 밖으로 나가지 않는다**.
10. **한글 본문·제목**이 UTF-8로 기록되고 다시 읽어 같은 문자열인지(플랫폼 기본 인코딩이면 red가 되도록 바이트로 비교).
11. 같은 기사·같은 수신처에 두 번 쓰면 **파일이 2개**다(스탬프가 다르다 — 덮어쓰기가 아니다). 시계를 고정하면 같은 이름이 되어 덮어쓰는데, 그 동작도 실측으로 확인해 주석에 남긴다.
12. **파일 개수 단언**으로 '어디에도 안 썼다'를 증명한다(정적 스캔이 못 보는 축 — phase 70 gap_found 교훈).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가 · `Adr008DisciplineTest` green(예외 2파일 고정) · `ClockDisciplineTest` green(주입 시계 사용).
- 2번: exit 0 · 5 프로파일 diffs 0 · 관측 수 불변(HTTP 없음). **`--parity`는 default 프로파일 Spring 인스턴스에 `DIST_SPOOL_DIR`을 이미 주고 있다**(step0) — 그래도 아직 아무도 쓰지 않으므로 스풀 디렉토리는 비어 있어야 한다.
- 3번 증분 = `.../service/SpoolWriter.java` · `.../config/AppProperties.java` · `src/main/resources/application.properties` · (스풀 루트 헬퍼) · 대응 테스트 · `.../config/Adr008DisciplineTest.java`(예외 확인) · `phases/71-spring-distribution/index.json`.

## 검증 절차

1. **red 먼저**: `SpoolWriterTest`를 구현 전에 돌려 실패 실측.
2. **변이 (a) 원복**: allowlist에 `internalComment`를 추가해 2번 red 확인 → 원복. (**내부코멘트 외부 유출**이 이 테스트의 방어 대상이다.)
3. **변이 (b) 원복**: `pick`을 "값이 null이어도 키를 남긴다"로 바꿔 3번 red 확인 → 원복.
4. **변이 (c) 원복**: `sanitizeSpoolDir` 재검증을 빼고 6번(`../x`) 테스트에서 **루트 밖에 파일이 생기는지** 확인 → 원복. (이 변이가 경로 조작의 실체다.)
5. **변이 (d) 원복**: `.tmp` → rename을 없애고 최종 경로에 직접 쓰도록 바꿔 1번의 '`.tmp` 잔존 없음'과 원자성 주석의 근거가 흔들리는지 확인 → 원복. (원자성 자체는 단위 테스트로 증명할 수 없다 — 대신 **구현 형태**를 테스트가 관찰한다: 쓰기 도중 최종 경로가 존재하지 않아야 한다는 단언을 주입 가능한 seam으로 만들 수 있으면 만든다.)
6. **변이 (e) 원복**: 인코딩을 플랫폼 기본으로 바꿔 10번 red 확인 → 원복.
7. AC 실행. 리포 `news.db`·`uploads/` 무변 · **리포 안에 스풀 파일이 하나도 생기지 않았는지** 확인(`git status --porcelain`에 미추적 파일 0).
8. index.json step9 상태 갱신.

## 금지사항

- `SpoolDir` 슬러그 규칙을 복제·완화하지 마라. 이유: 규칙이 두 벌이 되면 한쪽이 경로 조작을 통과시킨다(phase 70이 만든 순수 헬퍼를 그대로 쓴다).
- 원자 이동 실패 시 일반 move·copy로 폴백하지 마라. 이유: 외부 전송기가 부분 기록 파일을 집어간다 — 실패는 실패로 보고한다.
- 예외를 밖으로 던지지 마라. 이유: 한 수신처의 실패가 다른 수신처와 송고를 막으면 복구 수단이 없다.
- 스풀 루트 기본값을 하드코딩하거나 `DATA_DIR` 하위로 추정하지 마라. 이유: 미설정 환경에서 의도치 않은 파일 쓰기가 생긴다(ADR-008 · decisions (3)).
- 파일명·경로를 로그·반환 사유에 담아 상위로 흘리지 마라. 이유: tick 응답의 경로 유출 차단이 계약이다(`assertNoSpoolPath`).
- 파일 삭제·정리(retention)·오래된 스풀 청소를 넣지 마라. 이유: 스풀 소비는 외부 전송기의 책임이고, 앱이 지우면 미발송 파일이 사라진다.
- `internalComment`·잠금 컬럼을 payload에 담지 마라. 이유: 내부 코멘트와 세션 토큰이 외부 수신처로 나간다.
