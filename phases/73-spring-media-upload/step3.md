# Step 3: upload-service

## 읽어야 할 파일

- `phases/73-spring-media-upload/index.json` — decisions **(2)**(multipart 아님) · **(5)**(extname·로케일 실측 표) · (16)(사유 3종은 전역 표에 넣지 않는다) · (19)(DB 비파괴) · (22)②③⑤.
- Node 정본: `server/index.js` **1011~1043행 전문** + 312~320행(`UPLOAD_EXT_ALLOWLIST` 14종 · `UPLOAD_MAX_BYTES = 5*1024*1024`).
- 계약(읽기만): `contract/cases/default/media-upload.contract.js` 35~45행(허용 확장자·경로 정규식) · 195~306행(성공·거부 케이스).
- 명세(읽기만): `docs/api-contract/openapi.yaml`의 `/api/upload` 절 · `UploadRequest`/`UploadResponse` 스키마 · `docs/api-contract/reason-tokens.md` 표 2 #3·#4.
- Spring 선례: `service/NodeString.java`(로케일·공백 판정의 형태) · `web/JsonHttp.java`의 `text(...)`(문자열 필드만 꺼내는 규약) · `service/DistributionTargetService.java`(검증 순서를 서비스가 소유하는 형태).
- step1·step2 산출물: `service/NodeBase64.java` · `service/UploadStore.java`.

## 배경 (동결된 사실)

- **업로드는 base64 JSON이다.** 본문은 `{filename, contentBase64}`이며 **multipart가 아니다**.
- Node 게이트 순서(정본 그대로):
  1. 세션(라우트 밖 — Spring은 `PathPolicyFilter`가 만든다)
  2. `typeof filename !== 'string' || typeof contentBase64 !== 'string'` → **400 `invalid-file`**
  3. `ext = path.extname(filename).slice(1).toLowerCase()`; `!ext || !ALLOWLIST.has(ext)` → **400 `invalid-file`**
  4. `buf = Buffer.from(contentBase64,'base64')`; `buf.length > 5,242,880` → **400 `too-large`**
  5. `mkdirSync(uploadDir,{recursive:true})` → 무작위 hex 이름 발급 → `writeFileSync(..., {flag:'wx'})`
  6. `{ok:true, path:'/uploads/<hex>.<ext>', filename}` — **`filename`은 요청값 원문**(대소문자 보존).
- **거부 경로(2·3·4)에서는 디스크에 아무것도 쓰지 않는다**(mkdir조차 하지 않는다).
- 확장자 판정 실측(계획 단계, Node win32 — **직접 재현하라**): `a.PNG`→`png` · `noextension`→거부 · `.png`→거부 · `a.`·`a.png.`→거부 · `a.tar.gz`→`gz` · `dir/a.png`·`dir\a.png`→`png` · `/uploads/../secret.png`→`png`(판정에만 쓰이고 저장명에 반영되지 않는다) · `a.png\u0000.txt`→`txt` · `a.png `(끝 공백)→`"png "`→화이트리스트 밖→거부 · `한글.png`→`png` · `a.PNG\u3000`→`"png\u3000"`→거부.
- **소문자화는 `Locale.ROOT`**로 한다(기본 로케일이 터키어면 `I`가 `ı`가 되어 판정이 갈린다).
- 사유 토큰 `invalid-file`·`too-large`는 **라우트 직접 400**이고 `ReasonStatus` 전역 표에 넣지 않는다(Node도 넣지 않는다).
- 계약이 관측하지 **않는** 축(이 step의 테스트가 유일 방어선): 5MB 정확 경계 · extname 경계 12종 · 로케일 · 거부 시 디스크 무기록 · 잘못된 base64.

## 작업

1. **테스트 먼저**: `service/UploadNamesTest.java`(또는 `UploadServiceTest` 안의 중첩 클래스).
   - 위 extname 실측 표 전건을 단언한다. 표는 **직접 Node로 재현**해 뽑아라(리포 밖 스크립트).
   - 화이트리스트가 **정확히 14종**이고 그 집합이 계약 파일 36행의 목록과 같은지 단언한다.
   - `Locale.setDefault(new Locale("tr"))` 상태에서도 판정이 같은지 단언한다(테스트 후 원복 — `@BeforeEach`/`@AfterEach`).
2. **테스트 먼저**: `service/UploadServiceTest.java`. `@TempDir`만 쓴다.
   - 게이트 순서 전건: 비-문자열 `filename`/`contentBase64` → `invalid-file` · 확장자 없음/화이트리스트 밖 → `invalid-file` · 디코드 5,242,880 **초과** → `too-large`.
   - **경계**: 정확히 5,242,880바이트는 **성공**, 5,242,881바이트는 `too-large`(엄격 부등호).
   - **거부 경로에서 디스크 무기록**: 각 거부 케이스마다 `@TempDir` 아래 파일 수가 **0**이고 uploads 디렉토리 자체가 **생기지 않았음**을 단언한다.
   - **잘못된 base64가 200이다**: `contentBase64:"!!!"` → 성공 · 저장 파일 길이 **0바이트** · 응답 `path`가 정규식에 맞는다(step1 `NodeBase64`가 살아 있다는 통합 증거).
   - 응답 `filename`이 요청 원문 그대로(`contract-upload.PNG`)이고 `path`의 확장자는 소문자(`png`)다.
   - 14종 전수 성공(내용은 전부 같은 png 바이트 — 서버가 내용을 검사하지 않는다는 사실 자체가 계약이다).
   - 응답 값 어디에도 **드라이브 문자로 시작하는 절대경로·경로 구분자·사용자 파일명 조각**이 없다.
3. `harness.news.service.UploadService`를 만든다. 시그니처 수준 지시:
   - 생성자 주입으로 `UploadStore`를 받는다. **서블릿 타입을 import하지 마라.**
   - `Map<String,Object> upload(Object filename, Object contentBase64)` 형태(또는 동등한 결과 타입) — 성공은 `{ok:true, path, filename}` **키 순서 그대로**, 실패는 `{ok:false, reason}`.
     반환을 record가 아니라 순서 있는 맵 투영으로 두어라(record면 `reason:null` 같은 키가 새어 나간다 — 72 forward_notes (11)③).
   - 문자열 판정은 `instanceof String`으로 한다(Node `typeof x === 'string'` 동형 — 숫자 `12345`는 문자열이 아니다).
   - 확장자 도출은 **win32 `path.extname` 알고리즘**을 구현한 헬퍼로 하고 `toLowerCase(Locale.ROOT)`를 쓴다.
   - 디코드는 **`NodeBase64.decode`**만 쓴다(로컬 재구현 금지).
   - 상한은 `5 * 1024 * 1024` 상수로 두고 **초과(`>`)일 때만** 거부한다.
   - 검증을 전부 통과한 뒤에만 `UploadStore.save(bytes, ext)`를 부른다.
   - **예외를 잡아 사유로 바꾸지 마라** — 저장 실패는 그대로 올라가 전역 핸들러가 500을 만든다(Node 동형).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
# → BUILD SUCCESS · Tests run: N (N > step2 수치) · Failures: 0 · Errors: 0
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
# → exit 0 · profiles=5 · diffs=0 · 265관측 (불변)
cd d:/agents/harness && npm test    # → 1328 pass / 0 fail (불변)
```

리포 `uploads/` 32항목 / 6,068,792 B 무변을 확인하라.

**AC 마지막 항목(필수)**: 아래 '검증 절차'의 변이 **전건**에 대해 `변이 | 심은 곳 | 기대 | 실제(red/green) | 원복 확인(git diff 공백)` 표를 **step 요약에 기록**하라. **미기록이면 이 step은 미완이다** — 빌드 green과 관측 수 불변만으로 만족되는 AC는 공허하다(index.json decisions (23)).

## 검증 절차 (변이 포함)

1. **변이 A(경계 부등호)**: `>`를 `>=`로 바꾼다 → 5,242,880 성공 케이스가 red → 원복.
2. **변이 B(로케일)**: `toLowerCase(Locale.ROOT)`를 `toLowerCase()`로 바꾼다 → 터키어 로케일 테스트가 red → 원복. **red가 안 나면 그 테스트가 로케일을 실제로 바꾸지 않고 있는 것이다.**
3. **변이 C(게이트 순서)**: 크기 검사를 확장자 검사보다 **앞으로** 옮긴다 → `malware.exe` + 6MB 본문이 `too-large`가 되어 `invalid-file` 단언이 red → 원복. (이 조합 케이스를 테스트에 반드시 넣어라.)
4. **변이 D(거부 시 기록)**: 거부 경로 앞으로 `UploadStore.save` 호출을 옮긴다(또는 mkdir을 먼저 하게 한다) → '디스크 무기록' 단언이 red → 원복.
5. **변이 E(엄격 디코더)**: `NodeBase64.decode` 대신 `Base64.getDecoder().decode`를 쓴다 → `"!!!"` 케이스가 red(예외) → 원복.
6. **변이 F(extname)**: 선행 점 파일(`.png`)을 확장자 있음으로 판정하게 한다 → 해당 케이스 red → 원복.

## 금지사항

- **`MultipartResolver`·`spring.servlet.multipart.*`·`MultipartFile`·`@RequestPart`를 도입하지 마라.** 이유: 이 라우트는 base64 JSON이고, multipart를 켜면 존재하지 않는 계약을 구현하는 동시에 Content-Type 협상 표면이 새로 생긴다.
- **`ReasonStatus`에 `invalid-file`·`too-large`를 추가하지 마라.** 이유: Node도 전역 표에 넣지 않고 라우트가 직접 400을 쓴다. 검증되지 않은 표 확대는 phase 69 decisions (19) 위반이다.
- **base64를 로컬에서 다시 디코드하지 마라.** 이유: Node 의미론 단일 출처(`NodeBase64`) 규율이며, 로컬 재구현이 phase 70에서 실제 데이터 손상을 낳았다.
- **파일 쓰기 API를 이 파일에서 쓰지 마라**(`Files.*`·`FileOutputStream` 등). 이유: `UploadService`는 ADR-008 예외 파일이 **아니다** — 정적 게이트가 즉시 red를 낸다. 쓰기는 `UploadStore`에만 있다.
- **저장 실패를 사유 토큰으로 접지 마라.** 이유: Node는 예외로 500이 된다 — 400으로 접으면 계약이 갈린다.
- **`Set.of(...).contains(null)`을 부르지 마라 — NPE이고 그 순간 400이 500이 된다.** 이유: 불변 집합(`Set.of`·`Map.of`)은 `contains(null)`에 `NullPointerException`을 던진다. phase 68·69·70에서 **반복 발생**한 함정이다. 이 step의 위험 지점은 **확장자 화이트리스트 조회**다 — 확장자 도출이 어떤 경로에서든 `null`을 낼 수 있게 바뀌면 `invalid-file` 400이어야 할 요청이 `internal-error` 500이 된다. 처분: 조회 전에 null을 빈 문자열로 접거나 null 허용 컬렉션을 쓰고, **`filename`/`contentBase64`/확장자가 각각 null인 입력이 400이고 500이 아니다**를 단언하는 테스트를 두어라(index.json decisions (24)).
- **컨트롤러를 만들지 마라.** 이유: 이 step은 서비스 레이어 하나만 소유한다(결선은 step9).
