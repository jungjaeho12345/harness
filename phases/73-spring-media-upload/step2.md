# Step 2: upload-store

## 읽어야 할 파일

- `phases/73-spring-media-upload/index.json` — decisions **(6)**(ADR-008 예외 2→4 확장 · 완화책 3종) · (7)(업로드 경로 단일 출처) · (8)(경로 탈출 방어) · (19)⑥⑦(미덮어쓰기·lazy mkdir).
- `phases/72-spring-distribution/index.json` — `forward_notes` **(6)(7)**(예외 목록 규율 · 정적 게이트가 못 덮는 벡터와 실질 그물).
- `docs/ADR.md` — **전문 훑기 필수**. 특히 **ADR-008**(1)(3)(6)(egress 금지의 축이 무엇인지) · **ADR-005**(제목이 'SSE 단방향 무효화 스트림'임을 **직접 확인하라** — 이 phase 초안이 여기를 '서버 프록시'로 오인용했고 ②가 반려했다) · **ADR-007**(ADR-005의 예외를 어떻게 별도 ADR로 세웠는지 — `ADR-014` 작성의 형식 선례) · **ADR-013**.
- Node의 **오인용 원본**(고치지 마라 · 기록 대상): `src/services/mediaSearch.js` 1행 · `src/services/translate.js` 2행의 'ADR-005 서버 프록시' 주석.
- Spring 게이트: `server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java` **전문**(특히 `NETWORK_CLIENT_FILE`·`SPOOL_WRITER_FILE` 상수, `FILE_WRITE` 패턴 목록, `theExceptionListIsExactlyTwoFiles`, `theExemptionAppliesOnlyToItsOwnFileAndItsOwnGroup`, 심어 둔 위반 상수들).
- Spring 선례(예외 파일이 어떻게 쓰였는지): `server-spring/src/main/java/harness/news/service/SpoolWriter.java`와 `service/SpoolWriterTest.java`(특히 `SpoolFs` seam과 `theAtomicPublishSequence...` 테스트) · `service/HttpApiSourceFetcher.java`의 클래스 javadoc(예외 파일의 자기 규율 서술 형식).
- Node 정본: `server/index.js` 1011~1043행 · 250~262행(`resolveRuntimePaths`의 `uploadDir`) · 465~475행(`createApp`의 `uploadDir` 파라미터).
- Spring 설정: `server-spring/src/main/java/harness/news/config/AppProperties.java` · `config/AppConfig.java`.
- step0·step1 산출물: `model/PhotoRepository.java` · `service/NodeBase64.java`.

## 배경 (동결된 사실)

- **[② 검토 반영] 이 게이트의 그물은 이미 성숙하다.** '업로드가 이 서버의 첫 파일 쓰기 도메인'이라는 전제는 틀렸다 — 72의 ④ 테스팅 게이트가 `File.delete()`/`deleteOnExit()`·`AsynchronousFileChannel` 같은 우회 구멍을 이미 폐색했다(`Adr008DisciplineTest.java` 188~190행). 따라서 이 step의 과제는 '그물을 새로 짜는 것'이 아니라 **성숙한 그물에 구멍 2개를 정당하게 뚫고, 뚫은 뒤에도 나머지가 촘촘한지 실증하는 것**이다. 비공허성 실증 절차(아래 검증 절차)는 **그대로 유지한다**.
- `Adr008DisciplineTest`의 예외는 **`src/main/java` 기준 상대 경로**로 매칭되고, '그 이름의 파일이 정확히 1개'까지 단언한다. 스캔은 **파일이 없으면 아무 일도 하지 않으므로** 자리를 미리 잡아 두는 것은 무해하다(71a가 `SpoolWriter.java`에 대해 실제로 그렇게 했다).
- 예외를 넓히는 것은 **그 자체가 아키텍처 결정**이다. 근거는 index.json decisions (6)에 있고 이 step은 그것을 실행할 뿐이다. **근거 없이 항목을 더 늘리지 마라.**
- Node 업로드 저장 경로: `uploadDir = <dataDir>/uploads`. `createApp`의 기본값 `'uploads'`(cwd 상대)는 **테스트 잔재이며 이식 대상이 아니다**.
- 저장 파일명 = `crypto.randomBytes(16).toString('hex')`(32자 소문자) + `.` + 검증된 소문자 확장자. `fs.writeFileSync(..., {flag:'wx'})` — **기존 파일을 덮지 않는다**. 충돌하면 Node는 예외를 던져 500이 된다.
- `fs.mkdirSync(uploadDir, {recursive:true})`는 **쓰기 직전 lazy 호출**이다(부팅 시 만들지 않는다).

## 작업

### A0. `ADR-014` 신설 — **A의 선행 조건이다. 이것 없이 예외 목록을 넓히지 마라.**

**왜 먼저인가**: A는 `Adr008DisciplineTest`와 `HttpExternalProxyClient`의 javadoc에 '왜 이 예외가 정당한가'를 **적으라**고 지시한다. 근거 ADR이 없으면 **게이트가 거짓 문장을 주장하게 된다**(이 계획서가 스스로 금지한 실패 모드). 71a는 같은 자리를 `rcv.md`라는 실재 스펙으로 정당화했다.

0. `docs/ADR.md` 말미(ADR-013 다음)에 **`ADR-014`를 추가**한다. **기존 ADR 본문·문장은 한 글자도 고치지 마라 — 순수 추가다.** 기존 ADR과 같은 3절 형식(**결정 / 이유 / 트레이드오프**)을 지키고 제목은 다음 요지로 한다.

   > **ADR-014: 미디어 검색·번역은 서버 보유 키 프록시 — ADR-008 egress 금지의 축은 배부(자동 송출)이며, 사용자 트리거 동기 조회는 그 축이 아니다**

   포함할 내용(문안은 재량이나 **이 명제들은 반드시 담아라**):
   - **결정**: `GET /api/media/search`(Google CSE·YouTube)와 `POST /api/articles/:id/translate`(Google Translate v2)의 외부 호출은 **서버가 보유한 키로 서버가 대신** 수행한다 — 키를 클라이언트에 내리지 않는다. 키는 **주입된 env에서만** 읽고 소스에 하드코딩하지 않는다. **키가 없으면 외부 호출을 아예 하지 않고** graceful degrade한다(미디어 = 결정적 데모 폴백 + `error:false` · 번역 = **200** + `ok:false` + `reason:'no-key'` + 원문). 호출은 **1회 시도**이고 재시도·백오프·큐·타이머·워커풀이 없으며 실패는 예외가 아니라 값으로 접는다. Spring 이식에서 이 egress는 **파일 단위 예외 1개**(`harness/news/service/HttpExternalProxyClient.java`)로 격리하고 `Adr008DisciplineTest`가 그 목록의 크기·구성·자리를 잠근다.
   - **이유**: ADR-008이 금지하는 egress는 **배부 축의 자동 송출**이다 — 앱이 스스로 시점을 정해 내보내는 행위이고, 금지의 목적은 앱에 타이머·재시도·타임아웃 복잡성이 생기지 않게 하고 오프라인 테스트를 결정적으로 만드는 것이다. 미디어·번역은 (i) **사용자 요청에 동기적으로 1회** 나가고 (ii) 앱이 시점을 정하지 않으며 (iii) 상태를 남기지 않으므로 그 목적과 충돌하지 않는다. 반대로 키를 클라이언트에 내리면 브라우저 번들·네트워크 로그에 키가 노출된다(신뢰 경계는 서버 — ADR-004). 수집 pull(`rcv.md`)이 같은 이유로 이미 예외이며 이 결정은 그 선례의 확장이다. **[② 재검토 low] ADR-007과도 반드시 정합시켜라(ADR-007 본문은 무수정 — 관계 서술을 `ADR-014` 안에서 한다).** "앱에 타이머/외부 egress 없음"이라는 문장의 **최초 출처는 ADR-007의 트레이드오프**이고 ADR-008의 이유가 그것을 인용한다. 그 원칙의 대상은 **pull/push 시점을 앱이 정하는 경우**다(로그 다이제스트의 매일 6시 전달을 앱 타이머가 아니라 운영 pull로 돌린 것 · 배부 tick을 외부 cron이 당기는 것) — **사용자 요청에 동기적으로 1회 나가는 조회는 그 대상이 아니다**. 이 문장을 빠뜨리면 `ADR-014`가 해소했다고 주장하는 모순이 **ADR-007 문장에 그대로 남는다**.
   - **트레이드오프**: 앱이 외부 API의 가용성·지연에 노출된다(단일 요청 상한만 두고 **재시도는 없다** — 본문을 천천히 흘리는 상대는 Tomcat 워커를 계속 점유한다: 71a가 실측해 기록한 잔여 위험과 동일하다). **키가 설정된 경로는 계약이 동결하지 못한다**(계약 하네스가 API 키 4종을 자식 env에서 지운다) → 그 축의 유일한 방어선은 Java 단위 테스트다. ADR-008 정적 게이트의 예외 파일이 늘어 그만큼 스캔 사각이 커진다(군 교차 누출 단언과 마감 시점 교차 변이로 보완한다). **Node 주석(`src/services/mediaSearch.js`·`src/services/translate.js`)이 이 결정을 'ADR-005 서버 프록시'로 오인용하고 있으나 ADR-005는 SSE 결정이다** — Node 무수정 원칙상 고치지 않고 이 문장으로 기록만 한다.

   작성 후 **`docs/ADR.md`의 diff가 '순수 추가'인지** 확인하라(`git diff -- docs/ADR.md`에 `-` 줄이 없어야 한다).

### A. ADR-008 예외 목록 확장 (이 step에서 한 번에 · 이후 step은 이 파일을 0줄 고친다)

1. **테스트 먼저**: `Adr008DisciplineTest`를 다음과 같이 고친다.
   - 네트워크 군 예외에 **`harness/news/service/HttpExternalProxyClient.java`** 추가(**예약 자리** — 파일은 step5가 만든다).
   - 파일 쓰기 군 예외에 **`harness/news/service/UploadStore.java`** 추가(이 step이 만든다).
   - `theExceptionListIsExactlyTwoFiles` → **`theExceptionListIsExactlyFourFiles`**로 이름·메시지·단언을 함께 고친다. 순서는 **군 순서 유지 · 군 안에서는 도입 순서**: `HttpApiSourceFetcher, HttpExternalProxyClient, SpoolWriter, UploadStore`(index.json open_questions (6) 기본 결정).
   - `PERIODIC_EXECUTION.exemptPaths()`·`ASYNC_AND_RETRY.exemptPaths()`가 **여전히 빈 목록**임을 단언하는 기존 두 줄은 그대로 둔다.
   - `theExemptionAppliesOnlyToItsOwnFileAndItsOwnGroup`에 **신설 2파일에 대한 4가지 경계**를 추가한다:
     (i) `UploadStore.java`의 `Files.write(...)`는 허용 (ii) 비-예외 파일(`ArticleWriteService.java`)의 같은 코드는 위반
     (iii) `UploadStore.java`의 `HttpClient` 사용은 **네트워크 군 위반**(파일 쓰기 예외가 새지 않는다)
     (iv) `HttpExternalProxyClient.java`의 `Files.write(...)`는 **파일 쓰기 군 위반** · `@Scheduled`는 **주기 실행 군 위반**.
   - 클래스 javadoc에 **군별 정당화**를 적어라: 네트워크 2개 = 수집 pull(**`rcv.md`가 정의한 능동 수집** · ADR-008이 금지하는 egress는 배부 축이다) + **`ADR-014`가 결정한 서버 보유 키 프록시**(미디어·번역은 사용자 트리거 **동기 1회** 조회이며, 키를 클라이언트에 내리지 않기 위해 서버가 대신 나가는 것이 기능 그 자체다). **인용은 A0에서 방금 만든 `ADR-014`만 쓴다 — `ADR-005`를 인용하지 마라(그 ADR은 SSE 결정이다).** 파일 쓰기 2개 = 배부 스풀 게시 + **업로드 저장**. 그리고 **이 확대가 방어를 얼마나 약화시키는지**(예외 면적 2배 · `UploadStore`는 경로를 인자로 받는 파일 쓰기를 갖게 된다)와 그에 대한 완화책 3종을 그대로 적어라.

### B. `UploadStore` (파일 쓰기 예외 파일 #2)

2. **테스트 먼저**: `server-spring/src/test/java/harness/news/service/UploadStoreTest.java`. `@TempDir`만 쓴다.
   - uploads 루트가 없으면 **쓰기 직전에** 만들어진다(lazy — 생성자에서 만들지 않는다는 것을 별도로 단언하라: 인스턴스만 만들고 아무 쓰기도 하지 않은 상태에서 디렉토리가 없어야 한다).
   - 저장 결과 경로 문자열이 `^/uploads/[0-9a-f]{32}\.[a-z]+$`에 맞고, 같은 확장자가 보존된다.
   - **같은 이름이 이미 있으면 덮지 않는다** — 이름 발급 seam을 고정값으로 주입해 충돌을 강제하고, 기존 파일의 내용이 **그대로 남아 있으며** 저장이 실패(예외)한다는 것을 단언한다.
   - 32-hex 이름이 호출마다 다르다(같은 값이 반복되지 않는다 — 최소 100회).
   - **디렉토리 밖으로 나가지 않는다**: 확장자 인자에 `../`·절대경로·NUL·`/`·`\`가 들어오면 **파일을 만들지 않고 거부**한다(호출자가 검증한다는 가정에 기대지 마라 — 심화 방어).
   - 쓴 바이트가 입력 바이트와 **정확히 일치**한다(0바이트 입력 포함).
3. `harness.news.service.UploadStore`를 만든다. 시그니처 수준 지시:
   - 생성자는 `AppProperties`(또는 그로부터 도출된 `Path`)와 이름 발급 seam을 받는다. **uploads 루트는 `AppProperties.dataDirPath().resolve("uploads")` 한 지점에서만 도출한다** — cwd 상대 경로·기본값 추정 금지.
   - `String save(byte[] bytes, String extension)` 형태 — 반환은 **응답에 그대로 실리는 상대 경로**(`/uploads/<32hex>.<ext>`)다. 서버 파일시스템 절대경로를 반환하지 마라.
   - 이름 발급은 `SecureRandom` 16바이트 → 32자 **소문자** hex. 테스트가 충돌을 강제할 수 있도록 seam(인터페이스 또는 `Supplier<String>`)으로 분리하되, **프로덕션 배선은 기본 생성자**로 고정한다(`HttpApiSourceFetcher`의 테스트 전용 생성자 선례).
   - 쓰기는 `Files.write(path, bytes, StandardOpenOption.CREATE_NEW)`. **`CREATE`/`TRUNCATE_EXISTING`로 바꾸지 마라.**
   - 디렉토리 생성은 `Files.createDirectories(uploadsRoot)`를 **쓰기 직전에** 한다.
   - **호출자가 준 문자열을 경로에 이어 붙이는 API를 노출하지 마라**(decisions (6) 완화책 ②). 파일명은 언제나 자기가 발급한 hex + 검증된 확장자다. 확장자는 `^[a-z0-9]{1,10}$` 같은 좁은 형태로 **자기도 다시 검증**한다.
   - **예외를 삼키지 마라** — 쓰기 실패는 던져서 전역 핸들러가 500으로 만든다(Node 동형). 재시도하지 마라(ADR-008 (6)).
   - 로그에 경로·파일명·바이트를 남기지 마라(로그 링 버퍼는 `GET /api/logs/digest`로 밖으로 나간다 — ADR-007).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
# → BUILD SUCCESS · Tests run: N (N > step1 수치) · Failures: 0 · Errors: 0
# → Adr008DisciplineTest 가 전건 green (예외 4파일 · 주기/비동기 예외 0)
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
# → exit 0 · profiles=5 · diffs=0 · 265관측 (불변)
cd d:/agents/harness && npm test    # → 1328 pass / 0 fail (불변)
cd d:/agents/harness && git diff -U0 -- docs/ADR.md | grep -c '^-[^-]'
# → **0** (ADR-014는 순수 추가다: 삭제된 줄이 0건이어야 한다. grep -c 는 개수를 찍는다 — exit code를 찍지 마라)
```

리포 `uploads/`가 **32항목 / 6,068,792 B로 무변**임을 확인하고 수치를 step 요약에 적어라.
**`docs/ADR.md`에 `ADR-014`가 실제로 존재하는지**(`grep -n '^### ADR-014' docs/ADR.md`)를 AC로 확인하라 — A0 없이 A를 실행한 상태로 step을 끝내면 게이트가 근거 없는 문장을 주장하게 된다.

**AC 마지막 항목(필수)**: 아래 '검증 절차'의 변이 **전건**에 대해 `변이 | 심은 곳 | 기대 | 실제(red/green) | 원복 확인(git diff 공백)` 표를 **step 요약에 기록**하라. **미기록이면 이 step은 미완이다** — 빌드 green과 관측 수 불변만으로 만족되는 AC는 공허하다(index.json decisions (23)).

## 검증 절차 (변이 포함 — 이 step의 핵심)

1. **비공허성 실증 ①(예외가 실제로 좁은가)**: `harness/news/service/ArticleWriteService.java`에 `Files.write(target, bytes);` 한 줄을 심는다 → `Adr008DisciplineTest`의 파일 쓰기 스캔이 **파일명과 정규식을 짚어 red** → 원복 후 원본과 byte-identical인지 확인(`git diff --stat`가 비어야 한다).
2. **비공허성 실증 ②(군 교차 누출)**: `UploadStore.java`에 `HttpClient http = HttpClient.newHttpClient();`를 심는다 → 네트워크 군에서 red → 원복.
3. **비공허성 실증 ③(주기 실행)**: `UploadStore.java`에 `@Scheduled(fixedDelay = 1000) void flush() { }`를 심는다 → 주기 실행 군에서 red → 원복.
4. **비공허성 실증 ④(예약 자리)**: 임시로 `harness/news/service/HttpExternalProxyClient.java`를 만들어 `Files.write(...)`를 넣는다 → 파일 쓰기 군에서 red(네트워크 예외가 파일 쓰기까지 새지 않는다) → **파일을 지운다**(step5가 만든다).
5. **변이 ⑤(미덮어쓰기)**: `CREATE_NEW`를 `CREATE`로 바꾼다 → 충돌 테스트가 red → 원복.
6. **변이 ⑥(lazy mkdir)**: 생성자에서 `Files.createDirectories`를 호출하게 한다 → lazy 단언이 red → 원복.
7. **변이 ⑦(경로 도출)**: uploads 루트를 `Path.of("uploads")`(cwd 상대)로 바꾼다 → `@TempDir` 기반 테스트가 red인지 확인. **red가 안 나면 그 테스트는 리포를 오염시킬 수 있는 변이를 못 잡는 것이다** — 절대경로 단언을 추가하라. 확인 후 원복하고 **리포 루트에 `uploads/` 하위 새 파일이 생기지 않았는지** 반드시 점검하라.

## 금지사항

- **`ADR-014`(작업 A0)를 쓰기 전에 예외 목록을 넓히지 마라.** 이유: 근거 ADR이 없는 상태에서 게이트 javadoc에 정당화를 적으면 **게이트가 거짓 문장을 주장한다** — ②가 반려한 바로 그 항목이다(초안은 ADR-005를 인용했는데 그 ADR은 SSE 결정이다).
- **`docs/ADR.md`의 기존 ADR 본문·문장을 고치지 마라.** 이유: 각 문장은 해당 phase의 결정·실측 기록이며 소급 수정은 이력을 오염시킨다. `ADR-014`는 **순수 추가**이고, ADR-013 ④의 실측 1문장은 **step10 소유**다(이 step에서 건드리지 마라).
- **Node의 'ADR-005 서버 프록시' 주석을 고치지 마라.** 이유: `src/**`는 무수정 목록이다 — 오인용은 step10 forward_notes에 **부채로 기록**만 한다.
- **`Adr008DisciplineTest`에 이 step이 정당화한 2파일 외의 항목을 더하지 마라.** 이유: 예외 항목 하나가 곧 우회 경로이고, 목록 확대는 리뷰 대상 결정이다.
- **`theExceptionListIsExactly...`의 수치를 이름·메시지·단언 중 한 곳만 고치지 마라.** 이유: 수치가 목록과 어긋나면 그 테스트가 주장하는 문장이 거짓이 된다.
- **`UploadStore`에 재시도·백오프·타이머·비동기를 넣지 마라.** 이유: ADR-008 (3)(6)이고, 예외는 **파일 쓰기 군에만** 열려 있어 정적 게이트가 즉시 red를 낸다.
- **`UploadStore`가 절대경로를 반환·로그·예외 메시지에 싣게 하지 마라.** 이유: 그 값이 응답이나 `logs/digest`로 나가면 서버 파일시스템 구조가 유출된다(72 tick 규율과 동형).
- **`AppProperties`에 필드를 추가하지 마라.** 이유: record 생성자 호출부가 테스트 9곳(`config/AppPropertiesTest` 8 · `web/AllowedOriginsTest` 1)에 있어 무관한 파일이 함께 움직인다. 필요하면 `CollectionProperties`·`SpoolProperties` 선례대로 **별도 `@ConfigurationProperties`**를 만들되, 이 phase는 새 설정 키가 필요 없다(uploads 루트는 `app.data-dir` 파생이다).
- **확장자 검증·크기 상한·base64 디코드를 여기서 하지 마라.** 이유: 그것은 step3(서비스)의 책임이다. 이 step은 '바이트를 안전하게 저장하는 어댑터' 하나만 소유한다.
