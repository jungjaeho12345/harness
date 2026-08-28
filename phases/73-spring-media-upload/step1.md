# Step 1: node-base64

## 읽어야 할 파일

- `phases/73-spring-media-upload/index.json` — decisions **(4)**(base64 관대성 · 실측 표) · (21)(기준값은 실측에서) · (22)①.
- Node 정본: `server/index.js` 1011~1043행(`POST /api/upload` — `Buffer.from(contentBase64,'base64')` 한 줄이 이 step의 전부다).
- Spring 선례(**형태를 그대로 따르라**): `server-spring/src/main/java/harness/news/service/NodeString.java` · `server-spring/src/main/java/harness/news/web/NodeNumber.java`와 각각의 테스트 `service/NodeStringTest.java` · `web/NodeNumberTest.java`.
- step0에서 생성/수정된 파일: `server-spring/src/main/java/harness/news/model/PhotoRepository.java` · `db/RequiredSchema.java`(이 step은 건드리지 않는다 — 존재만 인지하라).

## 배경 (동결된 사실)

- Node `Buffer.from(s, 'base64')`는 **관대하고 절대 던지지 않는다**. Java `java.util.Base64.getDecoder().decode(s)`는 **엄격해서 던진다**. 그 차이는 그대로 **200 대 500**의 차이다: `POST /api/upload {filename:'a.png', contentBase64:'!!!'}`는 Node에서 **0바이트 파일을 쓰고 200**인데, 엄격 디코더는 `IllegalArgumentException` → 전역 핸들러 → **500 `internal-error`**가 된다.
- **계약은 이 축을 하나도 관측하지 않는다**(케이스는 `content-missing`·`content-not-string`뿐). 이 step의 테스트가 **유일 방어선**이다.
- 계획 단계 Node 실측(Node v24, Windows, 리포 밖 스크래치패드). **그대로 믿지 말고 직접 재현해 표를 다시 뽑아라**(리포 밖 경로에 스크립트를 두고 실행할 것):

| 입력 | 디코드 길이 | 선두 바이트(hex) |
|---|---|---|
| `""` | 0 | |
| `"!!!"` | 0 | |
| `"a"` | 0 | |
| `"ab"` | 1 | `69` |
| `"abc"` | 2 | `69b7` |
| `"abcd"` | 3 | `69b71d` |
| `"iVBORw0KGgo"` | 8 | `89504e470d0a1a0a` |
| `"QUFB"` | 3 | `414141` |
| `"QUF"` | 2 | `4141` |
| `"QU"` | 1 | `41` |
| `"Q"` | 0 | |
| `"QUFB="` / `"QUFB=="` | 3 | `414141` |
| `"QU$$FB"` / `"QU FB"` / `"QU\nFB"` | 3 | `414141` |
| `"-_"` | 1 | `fb` |
| `"++//"` | 3 | `fbefff` |
| `"**"` | 0 | |
| `"QUFB!QUFB"` / `"QUFB\u0000QUFB"` / `"QUFB\r\nQUFB"` | 6 | `414141414141` |
| `"\u00C1\u00C1"`(비-ASCII) / `"한글"` | 0 | |
| `"   QUFB   "` | 3 | `414141` |
| `"QU=FB"` | 1 | `41` |
| `"QQ==QQ=="` | 1 | `41` |
| `"=QUFB"` | 0 | |
| `"data:image/png;base64,QUFB"` | 17 | `75ab5a8a66a07bfa6781b6ac7bae1050` |

  읽는 법: **알파벳 밖 문자는 건너뛴다** · `-`/`_`는 base64url로 읽는다 · **`=`를 만나면 디코드를 끝낸다** · 남은 4자 미만 그룹은 가능한 만큼만 채우고 1자만 남으면 버린다 · 비-ASCII는 알파벳 밖이므로 건너뛴다(그래서 `data:` prefix가 붙은 입력은 **거부가 아니라 쓰레기 바이트**가 된다 — 정본 주석의 '데이터 URI prefix 없음 가정'이 그 뜻이다).
- `Base64.getMimeDecoder()`는 알파벳 밖 문자를 건너뛰지만 **`-`/`_`를 base64url로 읽지 않고** 패딩 처리도 다르다 — 갈음 금지. 표로 직접 대조해 그 사실을 테스트에 남겨라.

## 작업

1. **테스트 먼저**: `server-spring/src/test/java/harness/news/service/NodeBase64Test.java`를 위 표 전건 + 직접 재측정으로 채운다.
   - 표의 각 행을 `@ParameterizedTest`(또는 동등)로 **길이와 선두 바이트**까지 단언한다.
   - **어떤 입력에도 예외를 던지지 않는다**는 성질을 별도 테스트로 단언한다(무작위 바이트/제어문자/서러게이트 포함).
   - **동어반복 방지 대조군**: 같은 입력 집합에서 `Base64.getDecoder()`가 던지는 케이스와 `Base64.getMimeDecoder()`가 다른 결과를 내는 케이스를 각각 **최소 1건씩 명시적으로 단언**하라. 표준 디코더로 갈음할 수 없다는 사실 자체가 이 클래스의 존재 이유이므로 그것을 테스트가 증명해야 한다.
2. `harness.news.service.NodeBase64`를 만든다. 시그니처 수준 지시:
   - `public static byte[] decode(String raw)` — **절대 던지지 않는다**. `null`이면 길이 0 배열(호출자가 부재를 이미 판정한다).
   - 구현 방침(재량이나 이 성질은 지켜라): 문자를 순회하며 base64 알파벳(`A-Za-z0-9+/`)과 base64url 별칭(`-`→62, `_`→63)만 6비트로 누적하고, `=`를 만나면 즉시 종료하며, 그 밖의 코드포인트는 건너뛴다. 마지막 그룹의 잔여 비트는 **바이트 경계까지만** 취한다(잔여 6비트 = 0바이트).
   - **문자 단위로 순회하라**(코드포인트/서러게이트가 섞여도 알파벳 밖이므로 건너뛰면 된다).
3. 클래스 javadoc에 `NodeString`·`NodeNumber`와 같은 형식으로 **왜 표준 디코더를 못 쓰는지**를 실측 사례(`'!!!'` → 200 vs 500)와 함께 적어라.

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
# → BUILD SUCCESS · Tests run: N (N > step0 수치) · Failures: 0 · Errors: 0
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
# → exit 0 · profiles=5 · diffs=0 · 265관측 (불변 — 이 step은 와이어를 건드리지 않는다)
cd d:/agents/harness && npm test
# → 1328 pass / 0 fail (불변)
```

**AC 마지막 항목(필수)**: 아래 '검증 절차'의 변이 **전건**에 대해 `변이 | 심은 곳 | 기대 | 실제(red/green) | 원복 확인(git diff 공백)` 표를 **step 요약에 기록**하라. **미기록이면 이 step은 미완이다** — 빌드 green과 관측 수 불변만으로 만족되는 AC는 공허하다(index.json decisions (23)).

## 검증 절차 (변이 포함)

1. **변이 A**: `NodeBase64.decode`를 `Base64.getDecoder().decode(raw)` 위임으로 바꾼다 → `'!!!'`·`'QU FB'`·`'-_'` 케이스가 **red**인지 확인 → 원복.
2. **변이 B**: `-`/`_` 별칭 처리를 지운다 → `'-_'` 케이스만 red인지 확인(다른 케이스는 green이어야 한다 — 테스트가 축을 분리하고 있다는 증거) → 원복.
3. **변이 C**: `=` 조기 종료를 지우고 끝까지 읽게 한다 → `"QU=FB"`·`"QQ==QQ=="` 케이스가 red인지 확인 → 원복.
4. **변이 D(공허성 점검)**: `decode`가 항상 길이 0 배열을 돌려주게 한다 → **최소 10건 이상**이 red인지 확인 → 원복. red가 3건 이하면 표가 빈약하다는 뜻이니 채워라.
5. 리포 밖 스크래치패드에서 뽑은 Node 실측 표와 Java 테스트 표가 **행 단위로 일치**하는지 눈으로 대조하고, 불일치가 있으면 **Node 쪽을 정본으로** 삼아 Java를 고쳐라.

## 금지사항

- **`decode`가 예외를 던지게 하지 마라.** 이유: Node는 던지지 않으므로 400이어야 할 요청이 500이 된다.
- **`Base64.getDecoder()`·`getMimeDecoder()`·`getUrlDecoder()`로 갈음하지 마라.** 이유: 셋 다 위 표의 최소 한 행에서 Node와 다르다(그 사실을 테스트가 단언한다).
- **정규식으로 입력을 사전 검증해 거부하지 마라.** 이유: Node는 어떤 문자열도 받아 뭔가를 돌려준다 — 거부를 추가하면 200이 400이 된다.
- **이 클래스를 upload 서비스 안에 인라인으로 넣지 마라.** 이유: Node 의미론은 **단일 출처**여야 하고(`NodeNumber`·`NodeString` 선례), 로컬 재구현이 phase 70에서 실제 데이터 손상을 낳았다.
- **다른 레이어를 건드리지 마라**(컨트롤러·리포지토리·설정). 이유: 이 step은 순수 헬퍼 1개만 소유한다.
