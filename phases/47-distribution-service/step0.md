# Step 0: spool-writer

배부 3부작(46 대상관리 → **47 즉시배부** → 48 tick) 중 두 번째 phase의 첫 step이다.
ADR-008 (1)의 **파일 스풀 outbound** 전송 수단을 구현한다: 앱은 배부 스풀 루트 아래 **수신처별 하위 폴더**에
기사 파일(JSON, `markupVersion` 포함)을 **쓰기만** 한다. 실제 발송은 외부 전송기가 담당하며 **앱은 네트워크 egress가 없다**.

이 step은 **파일 쓰기 원시 함수 한 개**만 만든다. 대상 선정·이력 기록·`distributedAt`·상태 전이는 step1/step2다.

## 읽어야 할 파일

- `docs/ADR.md` — ADR-008 (특히 (1) 파일 스풀 outbound, 트레이드오프 "스풀 기록 시각=distributedAt"), ADR-002/006.
- `docs/ARCHITECTURE.md` — 디렉토리 구조, 계층 분리.
- `src/services/spoolDir.js` — phase 46에서 만든 `sanitizeSpoolDir` 슬러그 검증기(규칙의 단일 출처). **재구현 금지, 재사용한다.**
- `server/ftpWatcher.js` — 수집(inbound) 쪽 대칭 구현. **`watch`/`readFile`를 주입받아 테스트가 실제 FS를 쓰지 않는 패턴**을 그대로 따른다.
- `src/services/fileRef.js` — "유효하면 원문, 아니면 ''(throw 없음)" 계약 스타일 참고.
- `test/collection*.test.js` / `test/ftpWatcher.test.js`(있으면) — 주입형 FS 테스트 작성 관례.

## 작업

**TDD: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) `test/spoolWriter.test.js` (신규, node:test)

실제 파일시스템을 쓰지 않는다 — `mkdir`/`writeFile`/`rename`을 가짜로 주입해 호출 인자를 단언한다.
최소 커버리지:

- 정상 쓰기: `<root>/<spoolDir>/` 를 `{ recursive: true }`로 mkdir하고, 임시 파일에 쓴 뒤 최종 파일명으로 rename한다.
- 파일명 규칙: `<articleId>_<compactTimestamp>.json` (동일 기사 재배부 시 기존 파일을 덮어쓰지 않는다).
- 페이로드: DB 행(`article`/`contents`)을 그대로 넘겨도 JSON.parse 결과에 `articleId`·`title`·`markupVersion`·엠바고 시각 등 **허용 필드만** 있고,
  `internalComment`(내부코멘트)·`lockYN`/`lockerUserId`/`lockerSessionId`/`lockerClientId`/`lockedAt`(편집 잠금)은 **없다**.
  행에 섞여 들어온 미지 키(예: `secretColumn`)도 결과 JSON에 나타나지 않는다.
- `contents`가 없거나(`undefined`) 본문(`markupVersion`)이 비어 있어도 쓰기는 진행되며, 없는 필드는 페이로드에서 생략된다.
- `spoolDir`가 슬러그 규칙 위반(절대경로·`..`·`/`·대문자·빈문자열·비문자열)이면 파일을 쓰지 않고 `{ ok:false, reason:'invalid-spool-dir' }`.
- `articleId`가 `[A-Za-z0-9_-]+` 위반(경로 구분자·`..`·비문자열·빈값)이면 파일을 쓰지 않고 `{ ok:false, reason:'invalid-article-id' }`.
- FS 오류(mkdir/writeFile/rename가 reject)면 throw하지 않고 `{ ok:false, reason:'spool-write-failed' }`.
- UTF-8: 한글 본문이 그대로 직렬화된다(`JSON.stringify` 기본).

### 2) `src/services/spoolWriter.js` (신규)

시그니처(구현 세부는 재량):

```js
export function createSpoolWriter({
  rootDir,                      // 배부 스풀 루트(필수)
  mkdir = fsMkdir,              // node:fs/promises
  writeFile = fsWriteFile,
  rename = fsRename,
  now = () => new Date().toISOString(),
}) {
  // article/contents는 articleModel.getById(articleId)가 돌려준 **DB 행 그대로**를 받는다.
  // 외부로 나가는 파일 shape(allowlist 필터링 포함)은 이 모듈이 단일 출처다 — 호출자가 payload를 조립하지 않는다.
  // 반환: Promise<{ ok:true, file } | { ok:false, reason }>
  async function write({ spoolDir, articleId, article, contents }) { /* ... */ }
  return { write };
}
```

핵심 규칙(벗어나지 마라):

- **경로 합성 전 재검증**: `sanitizeSpoolDir(spoolDir)`가 ''이면 즉시 거부. DB에 저장된 값이라도 신뢰하지 않는다(경로 조작 방어의 마지막 지점).
- **articleId 화이트리스트**: `/^[A-Za-z0-9_-]{1,64}$/` 통과값만 파일명에 합성한다.
- **원자적 게시**: 같은 디렉토리 안 임시 파일(`.tmp` 접미사 등)에 쓴 뒤 `rename`으로 최종 이름을 만든다.
  이유: 외부 전송기가 부분 기록된 파일을 집어가면 깨진 기사가 발송된다(수집 watcher가 부분 파일을 읽는 문제의 대칭).
- **필드 allowlist는 이 모듈이 소유한다**(블랙리스트 금지). 상수 배열로 고정하고, 주어진 행에서 그 필드만 뽑아 페이로드를 조립한다:
  - Contents에서: `articleId, title, author, coAuthor, department, departmentCode, category, region, attribute, keyword, externalComment, attachmentFile, referenceFile, createdAt, sentAt, embargoAt, secondEmbargoAt, status`
  - Article에서: `markupVersion` (본문 — ADR-008이 요구하는 필수 항목), `title`(Contents.title이 비어 있을 때의 폴백)
  - 서버가 stamp하는 값: `distributedAt`(= `now()`, 스풀 기록 시각)
  **`internalComment`(내부코멘트)와 편집 잠금 컬럼(`lockYN`/`locker*`/`lockedAt`)은 절대 싣지 않는다** — 외부 수신처로 나가는 파일이다.
  호출자가 임의 필드를 끼워 넣을 수 없어야 한다(행에 없는 키는 무시).
- **throw 금지**: 모든 실패는 `{ ok:false, reason }`으로 반환한다(한 수신처 실패가 다른 수신처·송고를 막지 않게 하려는 step1의 전제).
- **타이머·네트워크·DB 접촉 0**: `setInterval`/`setTimeout`/`fetch`/`EventSource`/SQL 금지(ADR-008).

## Acceptance Criteria

```bash
npm test && npm run lint
```

- 신규 테스트 전부 green, 기존 백엔드 테스트 무회귀(기준선 484 pass / 0 fail).
- `npm run lint` 경고 0.

## 검증 절차

1. 테스트를 먼저 작성해 red 확인(`ERR_MODULE_NOT_FOUND` 또는 단언 실패)을 로그로 남긴다.
2. 구현 후 `npm test`로 green 확인, pass 수치를 기준선과 비교한다.
3. `grep -n "setInterval\|setTimeout\|fetch(\|EventSource" src/services/spoolWriter.js` → 0건.
4. `git diff --stat`이 `src/services/spoolWriter.js`, `test/spoolWriter.test.js` 2개 파일뿐인지 확인한다.

## 금지사항

- 실제 디렉토리/파일을 만드는 테스트를 쓰지 마라. 이유: 테스트가 환경 의존적이 되고 CI에서 쓰레기 파일이 남는다(수집 watcher 테스트 관례와도 어긋난다).
- `sanitizeSpoolDir` 규칙을 여기서 다시 구현하지 마라. 이유: 규칙이 두 곳으로 갈라지면 한쪽만 강화돼 우회 경로가 생긴다.
- 대상(DistributionTarget) 조회·`Contents.distributedAt` 갱신·`ArticleHistory` 기록을 하지 마라. 이유: step1의 책임이며, 섞으면 실패 격리와 롤백 단위가 사라진다.
- 네트워크로 직접 전송하는 코드를 쓰지 마라. 이유: ADR-008은 앱 egress를 금지한다(발송은 외부 전송기).
- 스풀 루트(`rootDir`) 바깥으로 나갈 수 있는 경로 합성(`..`, 절대경로 join)을 허용하지 마라. 이유: 임의 파일 쓰기 취약점이 된다.
