# Step 2: collection-parser

수집(자동기사) 파이프라인의 **순수 판정 부분**을 이식한다 — 수신 payload에서 제목·본문을 뽑는 파서(`src/parsers/defaultParser.js`)와 그 결과를 에디터 본문 블록 JSON으로 만드는 조립기(`collectionService.toMarkup`).

이 step은 **순수 모듈만** 만든다: DB·HTTP·파일시스템·시계 의존 0. 계약은 아직 green이 될 수 없다 — 판정은 Java 단위 테스트 + 이미 green인 scope 무회귀다.

## 읽어야 할 파일

- `phases/71-spring-distribution/index.json` — decisions **(19)(21)**
- `src/parsers/defaultParser.js` — **이식 원본 전문**(29행, `str`·`splitFirstLine`·`parse`)
- `src/parsers/parser.js` — 진입점(현재 기본 포맷 하나로 위임)
- `src/services/collectionService.js` 12~26행 — `AUTO_ATTRIBUTE`·`decodeBody`·`toMarkup`(**`toMarkup`은 이 step, 나머지는 step3**)
- `contract/cases/default/collection.contract.js` — 파서 규칙을 관측하는 케이스: `receive-text-payload`(첫 줄=제목, 블록 2개) · `receive-object-payload`(`{title,content}` 직접 취함) · `receive-missing-payload`(빈 제목·블록 1개) · `readBodyBlockTexts`(단건 조회로 `{format:'yh-editor',version:1,blocks:[…]}` 확인)
- `contract/cases/minimal/collection-open.contract.js` — 같은 규칙을 토큰 없는 서버에서 관측
- `server-spring/src/main/java/harness/news/service/NodeString.java` — 공백·문자열 파생의 **단일 출처**(로컬 재구현 금지)
- `server-spring/src/main/java/harness/news/service/MarkupJson.java` — 본문 마크업 JSON을 다루는 기존 지점(재사용 가능 여부를 먼저 확인하고, 새 조립기가 필요하면 그 이유를 주석에 남긴다)

## 배경 (동결된 계약 사실)

Node 파서의 의미론을 **문자 그대로** 옮긴다. 아래가 곧 테스트 목록이다.

- `str(v)`: `v == null`(null·undefined)이면 `''`, 아니면 **`String(v)`**. 숫자·불리언은 문자열화되고 객체는 `[object Object]`가 된다 — **강제변환을 빼거나 더하지 마라**.
- `splitFirstLine(text)`: `str(text)` → `\r\n` → `\n` 정규화 → **선행 개행 제거**(`^\n+`) → 첫 `\n` 없으면 `{title: trim(전체), content: ''}` · 있으면 `{title: trim(첫 줄), content: 나머지(그대로 — trim 없음)}`.
  - **제목만 trim한다. 본문은 trim하지 않는다.**
  - `trim`은 **`NodeString.trim`**을 쓴다(JS 공백 정의 — NBSP·BOM·U+2028·U+3000 포함. `String.trim()`은 NBSP를 놓친다 — phase 70 이월 결함과 같은 계열).
- `parse(payload)`:
  - `payload`가 **객체**(JS `typeof payload === 'object'`이고 null 아님 — **배열도 객체다**)이면: `title = trim(str(payload.title))` · `content = str(payload.content ?? payload.body)`. **`title`이 비어 있고 `content`가 비어 있지 않으면** `splitFirstLine(content)`로 승격, 아니면 `{title, content}` 그대로.
    - `??`는 **null 병합**이다: `content`가 `null`/`undefined`일 때만 `body`를 본다(`''`이면 `''`가 이긴다).
    - Jackson이 JSON 배열을 `List`로 준 경우 `payload.title`은 없다 → `{title:'', content:''}`가 되어야 한다.
  - 객체가 아니면(문자열·숫자·불리언·null) `splitFirstLine(payload)`.
- `toMarkup(title, content)`: `[title, content]`에서 `undefined`·`null`·`''`를 **버린 뒤** `'\n'`으로 join → 그 문자열을 `'\n'`으로 split → 각 조각을 `{type:'text', text:<조각>}` 블록으로 → `{format:'yh-editor', version:1, blocks}`를 JSON 문자열로.
  - 둘 다 비면 body는 `''` → split 결과가 `['']` → **블록 1개(text:'')**. 계약 `receive-missing-payload`가 그 사실을 단언한다.
  - 제목만 있으면 블록 1개, 제목+본문이면 최소 2개.

## 작업

### A. Node 실측 대조(decisions (25))

`node -e`로 원본 파서를 직접 호출해 경계 입력의 실제 반환을 뽑아 요약에 적는다(최소): `''` · `'제목'` · `'제목\n'` · `'\n\n제목\n본문'` · `'제목\r\n본문\r\n둘'` · `'  제목  \n본문'` · `null` · `undefined` · `123` · `true` · `{}` · `{title:'  T  '}` · `{content:'C1\nC2'}` · `{body:'B'}` · `{title:'', content:'첫\n둘'}` · `{content:null, body:'B'}` · `{content:'', body:'B'}` · `[]` · `[{title:'x'}]`. 그리고 `toMarkup` 결과 JSON 문자열도 같은 방식으로.

### B. `CollectionParser` (순수, `harness.news.service`)

시그니처(구현 재량):

- `public static Parsed parse(Object payload)` — 반환은 `record Parsed(String title, String content)`(둘 다 non-null 문자열).
- private helper: `str(Object)` · `splitFirstLine(Object)`.
- 입력 타입은 Jackson이 만든 값이다: `String`·`Number`·`Boolean`·`Map<String,Object>`·`List<?>`·`null`. **`Map`이 아니어도 `List`는 객체 취급**(JS `typeof`와 맞춘다).
- `String.valueOf`를 그대로 쓰면 `null` → `"null"`이 되어 갈린다 — `str`은 **null/undefined 먼저 걸러** `''`를 돌려준다.

### C. `CollectionMarkup` (순수)

- `public static String toMarkup(String title, String content)` — 위 규칙대로 JSON 문자열을 만든다. 직렬화는 기존 Jackson 경로를 재사용하되 **키 순서 `format`·`version`·`blocks`**를 유지하고 `version`은 **정수 1**이다(문자열·실수 금지 — 계약이 `doc.version === 1`을 단언한다).
- 블록은 `{type:'text', text:<문자열>}` 2키.

### D. 테스트 (먼저 쓴다 — `CollectionParserTest`·`CollectionMarkupTest`)

A에서 뽑은 실측 표를 그대로 테이블 테스트로 옮긴다. 반드시 포함:

1. CRLF 정규화 · 선행 빈 줄 제거 · 개행 없는 입력.
2. **제목만 trim, 본문은 trim 안 함**(앞뒤 공백이 살아 있는 본문).
3. **NBSP(U+00A0)로 둘러싼 제목**이 trim되는지(= `NodeString.trim` 사용 실증. `String.trim()`이면 red).
4. `null`·`undefined`(= Java `null`)·숫자·불리언 입력.
5. 객체: `title` 승격 규칙(`title` 빈 + `content` 있음 → 첫 줄 승격) · `content ?? body`의 **null 병합**(`content:''`이면 `body`를 보지 않는다) · 배열 입력.
6. `toMarkup`: 빈 제목·빈 본문 → 블록 1개(`text:''`) · 제목만 → 1개 · 제목+2줄 본문 → 3개 · 본문에 연속 개행이 있을 때 빈 블록이 그대로 생기는지.
7. JSON 문자열의 `format`·`version`(정수)·`blocks[].type` 고정.

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가(실측치 기록).
- 2번: exit 0 · 5 프로파일 diffs 0 · 관측 수 215 불변(HTTP 없음).
- 3번 증분 = `server-spring/src/main/java/harness/news/service/CollectionParser.java` · `.../CollectionMarkup.java` · 대응 테스트 2개 · `phases/71-spring-distribution/index.json`.

## 검증 절차

1. **red 먼저**: 단위 테스트를 구현 전에 돌려 실패 실측.
2. **변이 (a) 원복**: `NodeString.trim` → `String.trim()` → NBSP 테스트 red 확인 → 원복.
3. **변이 (b) 원복**: `str`을 `String.valueOf`로 바꿔 `null` 입력 테스트 red 확인 → 원복.
4. **변이 (c) 원복**: `content ?? body`를 `content != null && !content.isEmpty() ? content : body`(빈 문자열도 폴백)로 바꿔 5번 테스트 red 확인 → 원복.
5. **변이 (d) 원복**: `toMarkup`의 빈 값 필터를 제거해 6번(블록 1개) 테스트 red 확인 → 원복.
6. AC 실행.
7. index.json step2 상태 갱신.

## 금지사항

- 파서에 입력 검증·거부를 추가하지 마라. 이유: `payload` 누락도 **200 + 빈 기사**가 계약이다(`receive-missing-payload`) — 400을 만들면 그 자리에서 계약이 red다.
- 제목/본문을 정규화·정제(HTML 이스케이프·개행 축약·공백 압축)하지 마라. 이유: 계약이 원문 왕복을 단언한다(`row.title === title`).
- `String.trim()`·`Double.parseDouble` 같은 로컬 재구현을 쓰지 마라. 이유: Node 의미론 파생은 `NodeString`·`NodeNumber` 단일 출처다(phase 70 review_gate high-1).
- DB·HTTP·시계·파일시스템을 건드리지 마라. 이유: 이 step은 순수 모듈 전용이며, 그래야 다음 step의 실패 원인이 격리된다.
- 포맷 분기(XML·CSV 등)를 추가하지 마라. 이유: Node `parser.js`는 기본 포맷 하나로만 위임한다 — 검증되지 않은 표면을 만들지 않는다.
