# Step 0: spool-writer

## 목표

배부 스풀 파일의 **포맷(무엇을 쓰는가)과 쓰기(어디에 어떻게 쓰는가)** 를 단일 모듈
`src/services/spoolWriter.js`로 만든다. 이 모듈은 **주입된 fs만** 사용하며(실디스크·네트워크·타이머 접촉 0),
도메인 지식(대상 선택·DB·이력)은 전혀 갖지 않는다 — 그건 step1의 책임이다.

배경(자기완결 — 이전 대화를 참조하지 마라):

- 배부 아키텍처의 **단일 출처는 ADR-008**이다. 요지: 앱은 배부 스풀 디렉토리(수신처별 하위 폴더)에
  **기사 파일(JSON, markupVersion 포함)을 쓰기만** 하고, 실제 발송은 외부 전송기가 한다.
  **앱에는 네트워크 egress도, 내부 타이머도 없다.** 시점 배부는 phase 48의 tick pull 엔드포인트가 담당한다.
- phase 46(완료)이 **DistributionTarget 테이블 + 대상 관리 CRUD + `sanitizeSpoolDir` 슬러그 검증기**를 이미 만들었다.
  이번 phase 47은 그 대상에게 **즉시 배부(송고 후처리)** 를 실행한다. step0은 그중 "파일을 쓰는 손"만 만든다.
- 스풀 루트 디렉토리는 수집(inbound)의 `RCV_SPOOL_DIR` 관례와 **대칭**으로 `DIST_SPOOL_DIR` env로 주입한다.
  **미설정이면 배부는 "비활성"** 이다(에러가 아니다) — 수집 watcher가 `RCV_SPOOL_DIR` 미설정 시
  기동하지 않는 선례(`server/index.js` L849~869)와 동형. env를 실제로 읽는 곳은 step2의 부트스트랩이며,
  **이 step의 모듈은 env를 읽지 않는다**(rootDir를 인자로 받는다).

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 반드시 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-008 전문(L45~48)**. 특히 (1) 파일 스풀 outbound, (3) 앱 내 타이머 금지,
  트레이드오프 문단의 "스풀 기록 시각 = distributedAt = 발송 완료가 아니라 **배부 지시 완료**".
  함께: ADR-006(얇은 transport·계층·주입, L35~38), ADR-002(직접 SQL·zero-dep 철학).
- `docs/ARCHITECTURE.md` — 디렉토리 구조(L9~30), "백엔드 MVC + 계층 분리"(L33), "보안 경계"(L54~57).
- `docs/SCHEMA.md` — `## Article Table`(L34~40 — 본문은 `markupVersion` 블록 JSON 문자열),
  `## Contents Table`(L42~51 — 컬럼 의미·`distributedAt`), `## DistributionTarget Table`(L76~87).
- `CLAUDE.md` — DB 비파괴·TDD·UTF-8·커밋 형식.
- **phase 46 산출물(이번 step의 입력)**:
  - `src/services/spoolDir.js` **전체(29줄)** — `sanitizeSpoolDir(value)`는 유효하면 원문, 아니면 `''`(throw 없음).
    타입 게이트 → 화이트리스트 `/^[a-z0-9][a-z0-9_-]{0,63}$/` → Windows 예약 장치명 거부. **규칙의 단일 출처다.**
  - `src/models/distributionTargetModel.js` **전체(50줄)** — 행 shape `{ id, name, kind, spoolDir, active, createdAt, updatedAt }`.
  - `phases/46-distribution-targets/index.json` — step0~3 summary(무엇이 이미 있는지). 특히 step1 summary의
    "spoolDir 유일성은 **앱 계층에서만** 보장"이라는 사실.
- `server/ftpWatcher.js` **전체(48줄)** — **주입형 fs 선례**(`watch`/`readFile`를 인자로 받고 테스트는 가짜 주입).
  이 step의 writer는 그 대칭(outbound)이다.
- `test/ftpWatcher.test.js` **전체(102줄)** — 가짜 fs를 주입해 실디스크 없이 검증하는 **테스트 하네스 청사진**.
- `src/services/logService.js` L27(`createLogService({ now = () => Date.now(), ... })`) — **주입 시계 선례**.
- `src/services/fileRef.js` — 순수 sanitize 헬퍼의 계약(유효하면 원문, 아니면 `''`)과 주석 스타일.

## 변경할 파일

**신규**
- `src/services/spoolWriter.js`
- `test/spoolWriter.test.js`

**수정**
- 없음. (이 step은 기존 파일을 한 글자도 고치지 않는다 — 결선은 step2다.)

## 상세 설계

### 1) 모듈 시그니처

```js
// src/services/spoolWriter.js
import { sanitizeSpoolDir } from './spoolDir.js';
import { join } from 'node:path';   // 순수 경로 합성만 — IO 아님

// 배부 스풀 파일 포맷의 단일 출처(순수 함수 — fs·시계·DB 접촉 없음).
export function buildDistributionPayload({ article, contents, target, audience, distributedAt });
// -> 스풀 파일에 직렬화될 plain object (아래 §2 스키마)

export function createSpoolWriter({
  rootDir,        // 배부 스풀 루트 경로 문자열. 빈 값/비문자열이면 비활성.
  fs,             // { mkdirSync(dir, { recursive: true }), writeFileSync(path, data, encoding) } — 주입 필수
}) {
  // enabled: boolean — rootDir가 유효 문자열이고 fs가 주입됐을 때만 true
  // write({ target, payload })
  //   -> { ok: true, path }
  //   |  { ok: false, reason: 'disabled' | 'invalid-spool-dir' | 'invalid-article-id' | 'invalid-timestamp' | 'write-failed', message? }
  return { enabled, write };
}
```

**`write`의 인자는 `{ target, payload }` 둘뿐이다.** 파일명 재료(`articleId`·`distributedAt`)는 **payload에서 파생**한다
(`payload?.article?.articleId`, `payload?.distributedAt`). 이유: 파일명 재료를 별도 인자로 받으면 호출자가
`payload`와 다른 값을 넘겼을 때 **파일명과 파일 내용이 모순**되는 버그 클래스가 생긴다(예: 파일명은 09:00인데 내용은 08:59).
payload 포맷을 정의하는 모듈이 곧 이 모듈이므로, 같은 모듈 안에서 파생시켜 그 가능성을 구조적으로 없앤다.

- **`fs`는 기본값을 두지 마라**(`node:fs` import 금지). 이유: 기본값이 있으면 주입을 잊은 호출이 실제 디스크를 건드려
  테스트가 비결정적이 된다. 실 fs 공급은 합성 루트(step2의 `src/controllers/index.js`) 책임이다.
- **`write`는 어떤 경우에도 throw하지 않는다.** 실패는 전부 `{ ok: false, reason }`으로 돌려준다.
  이유: 상위(step2)에서 스풀 실패가 송고를 롤백/실패시키면 안 된다(ADR-008 — 배부는 송고의 후처리다).
- **동기 API만 쓴다**(`mkdirSync`/`writeFileSync`, `write`는 Promise를 반환하지 않는다).
  이유: 호출자 체인(`articleService.applyAction` → HTTP 라우트)이 전부 동기이고 DB도 `node:sqlite` DatabaseSync다.
  비동기로 만들면 step2에서 `applyAction`이 Promise를 반환하게 되어 **기존 백엔드 테스트 다수가 깨진다**.

### 2) 파일 포맷 — 확정 스키마 (이 값들이 계약이다)

`buildDistributionPayload`가 만드는 객체:

```json
{
  "schema": "yh-dist-article",
  "version": 1,
  "distributedAt": "2026-07-27T09:00:00.000Z",
  "audience": "all",
  "target": { "id": 3, "name": "연합TV", "kind": "press", "spoolDir": "yonhap-tv" },
  "article": {
    "articleId": "AKR20260727123456789",
    "title": "제목",
    "markupVersion": "{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[...]}",
    "author": "김기자",
    "coAuthor": null,
    "department": "사회부",
    "departmentCode": "10",
    "category": null,
    "region": null,
    "attribute": null,
    "keyword": null,
    "externalComment": null,
    "embargoAt": null,
    "secondEmbargoAt": "2026-07-28T00:00:00.000Z",
    "createdAt": "2026-07-27T08:00:00.000Z",
    "sentAt": "2026-07-27T09:00:00.000Z",
    "status": "EPS"
  }
}
```

확정 규칙:

| 항목 | 규칙 |
|------|------|
| `schema`/`version` | 리터럴 `'yh-dist-article'` / `1` 고정. 외부 전송기가 포맷을 식별하는 값 — 임의로 바꾸지 마라. |
| `distributedAt` | **이 파일의 배부 지시 시각**(호출자가 넘긴 값 그대로). `Contents.distributedAt`(최초 배부 시각)과 **다를 수 있다**(재배부 시). |
| `audience` | `'press'` \| `'all'` — 이번 배부의 대상군. |
| `target` | 대상 행에서 `id·name·kind·spoolDir` **4키만** 복사(그 외 컬럼 금지 — `active`/타임스탬프는 수신처에 무의미). |
| `article.markupVersion` | `Article.markupVersion` **문자열 원문 그대로**. 파싱·재직렬화·평문 변환 금지(정보 손실·이스케이프 사고 방지). |
| `article.title` | `contents.title ?? article.title ?? null` (Contents가 목록의 정본이고, 레거시 행 보호용 폴백). |
| 나머지 `article.*` | 아래 allowlist를 **정확히 이 순서로** Contents에서 복사. 값이 `undefined`면 `null`로 정규화한다(키는 항상 존재 — 수신처 파서가 키 유무로 분기하지 않게). |

**null-tolerant 요구(필수)**: `buildDistributionPayload`는 `article`·`contents`·`target`이 `undefined`/`null`이어도
**throw하지 않고** 키 집합이 동일한 객체를 만든다(없는 값은 `null`). 이유: `articleModel.getById`는
Article·Contents 중 **하나만 있어도 행을 반환한다**(`src/models/articleModel.js` L47~52 — 둘 다 없을 때만 `null`).
Article 행이 없는 손상 데이터에서 `article.markupVersion` 접근이 throw하면 상위 catch-all에 삼켜져
원인 불명 실패가 된다. 옵셔널 체이닝(`article?.markupVersion ?? null`)으로 방어하라.
(그런 손상 행을 **실제로 배부할지**는 이 모듈이 정하지 않는다 — step1이 거부한다.)

`ARTICLE_FIELDS` allowlist(Contents 출처, 순서 고정):
`author, coAuthor, department, departmentCode, category, region, attribute, keyword, externalComment, embargoAt, secondEmbargoAt, createdAt, sentAt, status`

**의도적으로 제외하는 필드와 이유**(주석으로 파일에 남겨라 — 뒤 phase가 되살리지 않게):

| 제외 | 이유 |
|------|------|
| `internalComment` | 내부코멘트 — 사내 전용 메모다. 외부 수신처로 나가면 정보 유출이다. |
| `modifier`, `sender` | 내부 사용자 식별자(userId). 배부에 불필요 — 최소 노출 원칙. |
| `lockYN`,`lockerUserId`,`lockerSessionId`,`lockerClientId`,`lockedAt` | 편집 잠금은 운영 내부 상태이며 세션 식별자를 포함한다. |
| `content` | 현재 미사용 평문 컬럼(SCHEMA.md L40·L51) — 본문의 정본은 `markupVersion`이다. |
| `editedAt` | 내부 편집 시각. 수신처 판단에 쓰이지 않는다. |
| `attachmentFile`, `referenceFile` | **첨부/자료 바이너리 동반 배부는 이번 phase 범위 밖**이다(파일 복사·전송 설계가 없다). 필요해지면 후속 phase에서 바이너리 동반 규칙과 함께 additive로 추가한다(키 추가는 하위호환). 참고: 본문 `markupVersion` 안의 `/uploads/...` 임베드 참조는 본문 원문이므로 그대로 나간다 — 즉 "내부 경로가 새면 안 되니까"가 제외 근거가 **아니다**(그 근거로 오해하면 뒤 phase가 잘못된 판단을 한다). |

### 3) 파일명·경로 규칙 (결정적 — 랜덤/시퀀스 금지)

- 디렉토리: `join(rootDir, sanitizeSpoolDir(target.spoolDir))`
- 파일명: `` `${articleId}__${compactTs}.json` ``
  - `articleId = payload?.article?.articleId`, `distributedAt = payload?.distributedAt` (payload 파생 — §1)
  - `compactTs = distributedAt.replace(/[-:.]/g, '')` → `2026-07-27T09:00:00.000Z` → `20260727T090000000Z`
  - 예: `AKR20260727123456789__20260727T090000000Z.json`
- **결정성 요구**: 같은 `(articleId, distributedAt, target.spoolDir)`이면 항상 같은 경로가 나와야 한다.
  `Date.now()`·`Math.random()`·카운터를 쓰지 마라(테스트 불가능해지고, 재시도가 파일을 무한 증식시킨다).
- **충돌 처리**: 같은 키로 두 번 쓰면 **덮어쓴다**(별도 회피 접미사 없음). 근거: 파일명 키가 같다는 것은
  같은 기사·같은 배부 지시 시각·같은 대상이라는 뜻이고, **정상 경로에서는** 그때 payload가 바이트 단위로 동일하다 → 덮어쓰기가 멱등이다.
  (밀리초가 다른 재배부는 파일명이 달라 공존한다 — 정정본 배부 이력이 보존된다.)
  - **유보(알려진 한계, 주석으로 남겨라)**: "동일 키 = 동일 내용"은 **같은 밀리초에 본문이 서로 다른 두 배부가 일어나지 않는다**는
    전제 위에서만 성립한다. 주입 시계가 밀리초 미만 해상도를 갖거나 고정 시계로 서로 다른 본문을 연속 배부하면
    앞 파일이 유실된다(외부 전송기가 이미 가져갔다면 무해, 아니면 정정본만 남는다). 이번 phase는 이를 허용 가능한 한계로 본다
    — 회피 접미사를 도입하면 결정성이 깨지고 재시도가 파일을 증식시킨다(더 나쁜 트레이드오프).

### 4) `write()` 절차 (순서가 곧 계약)

1. `enabled`가 false → `{ ok: false, reason: 'disabled' }`. **fs를 호출하지 않는다.**
2. `const dir = sanitizeSpoolDir(target?.spoolDir)` → `''`면 `{ ok: false, reason: 'invalid-spool-dir' }`. **fs 호출 없음.**
   - **재검증을 반드시 여기서 한다.** phase 46 검증기를 통과했다는 가정에 기대지 마라: 대상 행은 DB 직접 수정·
     레거시 데이터·향후 규칙 변경으로 오염될 수 있고, 이 값은 **실제 파일 경로에 합성**된다.
   - **검증기를 재구현하지 마라.** `sanitizeSpoolDir` 그대로 호출한다(규칙의 단일 출처 — 발산하면 우회 벡터).
3. `articleId` 방어 검증: **`typeof articleId !== 'string'`이면 즉시 거부**, 그 다음 `/^[A-Za-z0-9_-]{1,64}$/`
   불일치면 `{ ok: false, reason: 'invalid-article-id' }`.
   이유: articleId도 파일명에 합성된다(서버 생성값이지만 파일명 조립 지점에서 한 번 더 막는다 — 심층 방어).
4. `distributedAt` 검증 — **순서 고정**:
   1. **타입 게이트: `typeof distributedAt !== 'string'`이면 즉시 `{ ok:false, reason:'invalid-timestamp' }`.**
      **`String(distributedAt)` 강제변환을 절대 쓰지 마라.** 이유: `String(null)==='null'`,
      `String(undefined)==='undefined'`, `String(1753612800000)==='1753612800000'`는 느슨한 영숫자 패턴을
      **전부 통과**해 `AKR…__null.json` 같은 파일을 만든다. 이것은 `src/services/spoolDir.js` L20~22가
      명시적으로 금지한 안티패턴과 **동형**이며, 이 step이 내건 심층 방어를 스스로 무력화한다.
   2. `compactTs = distributedAt.replace(/[-:.]/g, '')`
   3. **형태 검증: `/^\d{8}T\d{9}Z$/`** 불일치면 `{ ok:false, reason:'invalid-timestamp' }`
      (`'2026-07-27T09:00:00.000Z'` → `'20260727T090000000Z'` 통과 / `'2026-07-27'`·`'now'`·`''`·epoch 숫자문자열은 거부).
      느슨한 `/^[0-9A-Za-z]{1,32}$/` 같은 패턴을 쓰지 마라 — 그 패턴은 `'null'`·`'undefined'`를 통과시킨다.
5. `fs.mkdirSync(dir, { recursive: true })` — **항상 호출한다(mkdir -p 동형)**.
   이유: spoolDir 유일성은 앱 계층에서만 보장되고 폴더는 외부 운영자가 미리 만들어 둘 수도 있다.
   **이미 존재하는 폴더에서 실패하면 안 된다**(phase 46 인수인계 ①). 존재 확인(`existsSync`) 분기를 두지 마라 — 경합(TOCTOU)만 늘어난다.
6. `fs.writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8')`
   - 들여쓰기 2 + 끝 개행 고정(사람이 읽고 diff 가능 — 결정적 바이트).
   - 인코딩은 **명시적으로 `'utf8'`**(CLAUDE.md: 모든 텍스트 UTF-8).
7. 성공 → `{ ok: true, path }`.
8. 3~6의 어떤 throw(권한 오류·디스크 오류·직렬화 실패)도 `try/catch`로 잡아
   `{ ok: false, reason: 'write-failed', message: String(err?.message ?? err) }`로 변환한다.

### 5) 이 모듈이 하지 않는 것 (명시적 비-책임)

- 대상 선택(active/kind 필터), `Contents.distributedAt` 갱신, `ArticleHistory` 기록 → **step1**.
- 송고 후처리 결선, env 판독, 실 fs 공급 → **step2**.
- 파일 삭제·정리·이동, 기존 스풀 폴더 마이그레이션 → **하지 않는다**(§금지사항 참조).

## TDD 테스트 목록 (red → green 순서)

`test/spoolWriter.test.js` 신규. 하네스: 가짜 fs를 in-memory로 만든다(`test/ftpWatcher.test.js` 스타일).

```js
function fakeFs() {
  const files = new Map();   // path -> content
  const dirs = [];           // mkdirSync 호출 인자 기록
  return {
    files, dirs,
    fs: {
      mkdirSync: (dir, opts) => { dirs.push({ dir, opts }); },
      writeFileSync: (p, data, enc) => { files.set(p, { data, enc }); },
    },
  };
}
```

**A. `buildDistributionPayload` (순수 — fs 없음)**

1. envelope 상위 키가 정확히 `['schema','version','distributedAt','audience','target','article']`이고
   `schema==='yh-dist-article'`, `version===1`이다.
2. `article` 키 집합이 §2 확정 목록과 **정확히 일치**한다(`articleId`,`title`,`markupVersion` + allowlist 14개).
3. `markupVersion`이 원문 문자열 그대로다(블록 JSON을 파싱/재직렬화하지 않는다 — 입력 문자열과 `===`).
4. **제외 필드가 새지 않는다**: contents에 `internalComment`·`sender`·`modifier`·`lockerSessionId`·
   `attachmentFile`·`referenceFile`·`editedAt`·`content`를 채워 넣어도 직렬화 결과 문자열에 그 값들이 **포함되지 않는다**
   (`JSON.stringify(payload)`에 `assert.ok(!s.includes('내부메모'))` 식으로 잠근다). **이 테스트가 이 step의 보안 계약이다.**
5. `title`은 `contents.title` 우선, 없으면 `article.title`, 둘 다 없으면 `null`.
6. `undefined` 필드는 `null`로 정규화되고 키는 남는다.
7. `target`은 `id·name·kind·spoolDir` 4키만 갖는다(대상 행에 `active`/`createdAt`이 있어도 새지 않는다).
8. **null-tolerant**: `article`이 `undefined`여도 **throw하지 않고** 키 집합이 동일하며 `markupVersion===null`이다.
   `contents`가 `undefined`인 경우, `target`이 `undefined`인 경우도 각각 throw 없이 키 집합이 유지된다
   (근거: `articleModel.getById`는 Article·Contents 중 하나만 있어도 행을 반환한다 — §2 null-tolerant 요구).

**B. `createSpoolWriter().write` — 정상 경로** (인자는 `{ target, payload }` 둘뿐)

9. `enabled === true`(rootDir 유효 + fs 주입)이고, `write`가 `{ ok: true, path }`를 반환한다.
   `path`가 `join(root, spoolDir, 'AKR..__20260727T090000000Z.json')`와 일치한다.
   **기대 경로는 반드시 `join`으로 만들어 비교하라** — Windows에서 `join('/spool','kbs')`는 `\spool\kbs`다(문자열 하드코딩 금지).
10. `mkdirSync`가 `(join(root, spoolDir), { recursive: true })`로 **호출된다**.
11. 기록된 내용이 `JSON.stringify(payload, null, 2) + '\n'`이고 인코딩 인자가 `'utf8'`이며,
    `JSON.parse` 왕복이 원본 payload와 `deepEqual`이다.
12. **파일명이 payload에서 파생된다**: `payload.distributedAt`을 바꾸면 파일명이 따라 바뀌고,
    `payload.article.articleId`를 바꾸면 파일명이 따라 바뀐다(별도 인자로 어긋날 여지가 없다 — §1 계약).
13. **결정성/멱등**: 같은 인자로 두 번 호출하면 같은 경로에 쓰고 파일 수가 1개다(내용 동일).
14. 서로 다른 `distributedAt`(ms 다름)이면 파일이 2개 공존한다.
15. 한글 제목/본문이 UTF-8로 왕복된다(모지바케 없음).

**C. 거부/실패 경로 — 어떤 경우에도 throw하지 않는다**

16. `rootDir` 미설정/빈 문자열/공백/비문자열 → `enabled === false`, `write` → `{ ok:false, reason:'disabled' }`,
    **`mkdirSync`/`writeFileSync` 호출 0회**.
17. 오염된 `spoolDir`(`'../etc'`, `'a/b'`, `'/abs'`, `'C:\\x'`, `'kbs\u0000'`, `'con'`, `null`, `123`, 키 누락) →
    각각 `{ ok:false, reason:'invalid-spool-dir' }`이고 **fs 호출 0회**(경로 조작이 파일시스템에 도달하지 않는다).
18. 오염된 `articleId`(`'../x'`, `'a/b'`, `''`, `null`, `undefined`(키 누락), 숫자, 65자 이상) →
    `{ ok:false, reason:'invalid-article-id' }`, fs 호출 0회.
19. **오염된 `distributedAt` — 강제변환 결함 잠금(필수)**: `null`, `undefined`(키 누락), 숫자 `1753612800000`,
    `true`, `{}`, `'null'`, `'undefined'`, `'2026-07-27'`, `'now'`, `''` → 각각 `{ ok:false, reason:'invalid-timestamp' }`이고
    **fs 호출 0회**. 특히 `null`/`undefined`/숫자가 통과해 `AKR…__null.json`이 만들어지면 **이 테스트가 실패해야 한다**
    (구현이 `String(...)` 강제변환을 쓴 것이다 — 테스트를 완화하지 말고 구현을 고쳐라).
20. `mkdirSync`가 throw → `{ ok:false, reason:'write-failed' }`(throw 전파 없음), `writeFileSync` 미호출.
21. `writeFileSync`가 throw(예: `EACCES`) → `{ ok:false, reason:'write-failed', message }`(throw 전파 없음).
22. 직렬화 불가 payload(순환 참조) → `{ ok:false, reason:'write-failed' }`(throw 없음).

**D. 아키텍처 가드**

23. 모듈 소스에 `node:fs`·`fetch`·`setTimeout`·`setInterval`이 **없다**.
    (`readFileSync(new URL('../src/services/spoolWriter.js', import.meta.url), 'utf8')`로 소스를 읽어 문자열 단언 —
    `test/` 안에서 실 fs를 쓰는 것은 소스 검사 목적이므로 허용된다.)

순서: **A(순수 빌더) → B → C → D**. A가 green이 되기 전에 B를 시작하지 마라(포맷이 흔들리면 B/C 테스트를 전부 다시 쓴다).

## Acceptance Criteria

```bash
npm test
npm run lint
```

- **먼저 변경 전 기준선을 기록하라**: 이 계획 작성 시점 실측은 `npm test` → `pass 489 / fail 0`이다.
  step 시작 시 한 번 실행해 실제 기준선을 확인하고(브랜치 tip에 따라 484~489 범위일 수 있다), 그 값을 summary에 적어라.
- `npm test`: **fail 0**, pass = 기준선 + 신규 테스트 수(감소하면 회귀 — 절대 허용 안 됨).
- `npm run lint`: clean(경고 0).
- `npm run test:web` / `npm run build`는 이 step의 AC가 **아니다**(web 무접촉).

## 검증 절차

1. `test/spoolWriter.test.js`를 먼저 작성하고 **red**를 확인한다(`ERR_MODULE_NOT_FOUND`).
2. A → B → C → D 순으로 green을 만든다.
3. `grep -n "node:fs\|require('fs')\|setInterval\|setTimeout\|fetch(" src/services/spoolWriter.js` → **0건**
   (`node:path`의 `join`만 허용).
4. `grep -rn "existsSync\|readFileSync\|rmSync\|unlinkSync\|rename" src/services/spoolWriter.js` → **0건**
   (읽기·삭제·이동 없음 — 쓰기 전용 모듈).
5. `grep -n "SLUG\|\\^\\[a-z0-9\\]" src/services/spoolWriter.js` → **0건**(검증 정규식 재구현 금지, `sanitizeSpoolDir` 호출만).
6. `grep -rn "DELETE FROM\|DROP\|TRUNCATE" src/services/spoolWriter.js` → **0건**.
7. `grep -n "String(" src/services/spoolWriter.js` → **파일명 재료(`articleId`·`distributedAt`) 검증 경로에 0건**
   (허용되는 유일한 용례는 catch 절의 `String(err?.message ?? err)`뿐이다. 검증 입력에 강제변환이 있으면
   `spoolDir.js` L20~22가 금지한 결함을 재현한 것이므로 되돌려라).
8. `git diff --stat`에 위 2개 파일 외 다른 파일이 **없어야** 한다(특히 `web/**`·`server/**`·`src/controllers/**` 무접촉).
9. 보안 체크리스트 — 테스트로 증명되어야 한다:
   - [ ] 오염된 `spoolDir`/`articleId`/`distributedAt`이 fs에 **도달하지 않는다**(호출 0회로 단언)
   - [ ] `null`/`undefined`/숫자 `distributedAt`이 `__null.json` 파일명을 만들지 **않는다**
   - [ ] `internalComment`·잠금 컬럼·`sender`/`modifier`가 스풀 파일에 **없다**
   - [ ] `write`는 어떤 입력에도 throw하지 않는다

## 커밋 계획

- **feat**: `feat(47-distribution-service): step0 — 배부 스풀 writer(주입형 fs) + 스풀 파일 포맷 확정`
  — `src/services/spoolWriter.js`, `test/spoolWriter.test.js`.
- **chore**: `chore(47-distribution-service): step0 status — completed` — `phases/47-distribution-service/index.json`만. 코드와 분리 커밋.

## 금지사항

- `node:fs`를 import하거나 `fs` 인자에 기본값을 주지 마라. 이유: 주입을 잊은 호출이 실디스크를 건드려 테스트가
  비결정적이 되고, CI가 개발자 머신 상태에 의존하게 된다. 실 fs 공급은 합성 루트(step2)의 책임이다.
- `write`를 `async`로 만들거나 `fs/promises`를 쓰지 마라. 이유: 호출 체인(`applyAction` → HTTP 라우트)이 전부 동기다.
  Promise를 반환하면 step2에서 `applyAction`의 반환 shape이 바뀌어 기존 백엔드 테스트가 대량으로 깨진다.
- `write`에서 throw하지 마라(에러를 밖으로 흘리지 마라). 이유: 상위에서 스풀 실패가 송고를 롤백/실패시키면 안 된다(ADR-008).
- 파일명 재료(`articleId`·`distributedAt`)에 `String(value)` 강제변환을 쓰지 마라. 이유: `String(null)==='null'`, `String(undefined)==='undefined'`, `String(1753612800000)`은 느슨한 패턴을 통과해 `AKR…__null.json` 같은 파일을 만든다 — `src/services/spoolDir.js` L20~22가 이미 명시적으로 금지한 안티패턴이며, 강제변환은 이 step이 내건 심층 방어를 스스로 무력화한다. `typeof` 게이트로 선차단하라.
- `buildDistributionPayload`에서 `article`/`contents`/`target` 부재에 대해 throw하지 마라. 이유: `articleModel.getById`는 Article·Contents 중 하나만 있어도 행을 반환한다 — 손상 데이터에서 나는 TypeError가 상위 catch-all에 삼켜져 원인 불명 실패가 된다.
- `sanitizeSpoolDir`의 규칙(정규식·예약어)을 이 파일에 재구현하지 마라. 이유: 규칙이 두 곳에 있으면 발산해 우회 벡터가 된다 — `spoolDir.js`가 유일한 출처다.
- `sanitizeSpoolDir` 재검증을 생략하지 마라("phase 46이 이미 검증했으니 안전"). 이유: DB 직접 수정·레거시 행·향후 규칙 변경으로 오염될 수 있고, 이 값은 실제 경로에 합성된다 — 쓰기 직전이 마지막 방어선이다.
- 파일명에 `Date.now()`·`Math.random()`·증가 카운터를 쓰지 마라. 이유: 결정성이 깨져 테스트가 불가능해지고, 재시도가 같은 기사 파일을 무한 증식시킨다.
- 기존 스풀 파일을 읽거나(`readFileSync`) 지우거나(`unlinkSync`/`rmSync`) 옮기지 마라. 이유: 스풀에 놓인 파일은 그 순간부터 외부 전송기의 소유다(ADR-008) — 앱이 손대면 전송 중인 파일을 파괴할 수 있다.
- `existsSync`로 디렉토리 존재를 확인한 뒤 조건부 `mkdir`을 하지 마라. 이유: TOCTOU 경합만 만들고, `recursive: true`가 이미 멱등이다(phase 46 인수인계 ① — 기존/중복 폴더를 견뎌야 한다).
- `Contents.distributedAt`·`ArticleHistory`·대상 조회(active/kind 필터)를 이 모듈에 넣지 마라. 이유: step1의 책임이다 — 섞으면 실패 원인 격리와 리뷰 게이트가 무력화된다.
- `setInterval`/`setTimeout`/`fetch`/네트워크 전송을 넣지 마라. 이유: ADR-008 — 앱 내 타이머·egress 금지. 시점 배부는 phase 48의 tick pull이다.
- `process.env`를 읽지 마라. 이유: 이 모듈은 `rootDir`를 인자로 받는다 — env 판독은 부트스트랩(step2) 한 곳에서만 한다.
- `web/**`·`server/**`·`src/controllers/**`·`src/services/articleService.js`를 수정하지 마라. 이유: 레이어 혼입 금지 — 결선은 step2다.
