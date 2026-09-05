# Step 0: spool-canon

## 읽어야 할 파일

먼저 아래를 읽고 배부 스풀의 실제 파일 shape·파일명 규칙·볼러타일 지점을 파악하라:

- `docs/ADR.md` — **ADR-008**(배부 = 파일 스풀 outbound + tick pull · 앱 내 타이머/egress 금지)
- `src/services/spoolWriter.js` — Node 스풀 writer. 필드 allowlist·`distributedAt=now()`·파일명 `${articleId}_${compactStamp(stamp)}.json`·`compactStamp`(ISO에서 `[-:.]` 제거) 규칙의 **단일 출처**.
- `server-spring/src/main/java/harness/news/service/SpoolWriter.java` — Spring 스풀 writer(위와 1:1 · 필드 allowlist 20키 · 원자적 게시).
- `scripts/lib/cliArgs.mjs` — 기존 순수 CLI 유틸(패턴 참고).
- `scripts/lib/mysqlHarness.mjs` + `scripts/lib/mysqlHarness.test.mjs` — 주입 가능한 순수 판정부 + `node --test`로 도는 단위 테스트의 **기존 관행**(같은 형태로 만든다).

## 작업

배부 스풀 트리를 **정규화**해 두 서버의 산출물을 바이트 대조할 수 있게 하는 **순수 모듈**과 그 단위 테스트를 만든다. 이 step은 대조 로직만 만들고, 서버를 띄우거나 비교를 실행하지 않는다.

새 파일 `scripts/lib/spoolCanon.mjs`. 아래 시그니처를 제공하되 구현은 재량:

```js
export const STAMP = '<STAMP>';

// 파일명의 타임스탬프 부분만 STAMP로 치환한다. compactStamp는 ISO에서 [-:.]를 지운 형태
// (예: 20260728T010203456Z). 예: "AKR20260728123456789_20260728T010203456Z.json"
//   → "AKR20260728123456789_<STAMP>.json"
// 타임스탬프 패턴에 맞지 않으면 입력을 그대로 돌려준다(정규화 실패를 조용히 삼키지 마라 — 그건 diff로 드러나야 한다).
export function canonicalizeSpoolName(name) { /* ... */ }

// 스풀 파일 원문에서 "distributedAt":"...ISO..." 의 **값만** STAMP로 치환한다.
// CRITICAL: 그 외에는 원문을 한 글자도 바꾸지 마라 — 키 순서/JSON 이스케이프/숫자 표기/공백을
//   보존해야 두 서버의 직렬화 divergence를 대조가 잡는다. JSON.parse 후 재직렬화 금지(키 순서가 뭉개진다).
export function canonicalizeSpoolContent(rawText) { /* ... */ }

// rootDir 아래를 재귀로 훑어 { key, canonName, canonContent }[] 를 key 오름차순으로 돌려준다.
//   key = "<수신처 하위폴더 slug>/<articleId>"  (파일명의 타임스탬프를 뺀 안정 키)
// fs는 주입 의존성(readdir/readFile) — 테스트가 실제 FS를 쓰지 않는다.
export function readSpoolManifest(rootDir, { readdir, readFile } = {}) { /* ... */ }

// 두 매니페스트를 비교해 diff 목록을 돌려준다: 한쪽에만 있는 key, canonName 불일치, canonContent 불일치.
//   반환 shape 예: { diffs: [{ key, kind: 'only-in-a'|'only-in-b'|'name'|'content', ... }], equal: boolean }
// CRITICAL: content 불일치를 보고할 때 스풀 값 원문을 그대로 싣지 마라(기사 본문·개인정보) — 길이/해시 등
//   비복원 지표만 싣는다(리포트·로그 위생).
export function diffManifests(a, b) { /* ... */ }
```

**TDD — 테스트를 먼저 작성한다.** 새 파일 `scripts/lib/spoolCanon.test.mjs`(`node --test`로 도는 형태 · `mysqlHarness.test.mjs`와 동형). 최소 케이스:

1. `canonicalizeSpoolContent`가 `distributedAt` 값만 `<STAMP>`로 바꾸고 다른 필드·키 순서를 보존한다.
2. **키 순서가 다른** 두 원문은 `diffManifests`가 `content` diff로 잡는다(정렬로 삼키지 않음).
3. `canonicalizeSpoolName`이 compactStamp 부분만 정규화하고, 형태가 다르면 원문을 유지한다.
4. `readSpoolManifest`가 주입 fs로 다중 수신처·다중 기사 트리를 key 오름차순으로 평탄화한다.
5. 동일 트리 → `equal: true, diffs: []`. 파일 하나 누락 → `only-in-*` diff.
6. content diff 리포트에 **스풀 값 원문이 실리지 않는다**(길이/해시만).

## Acceptance Criteria

```bash
node --test scripts/lib/spoolCanon.test.mjs   # 새 단위 테스트 통과
npm run lint                                   # ESLint 통과(scripts/**는 ignore지만 lint 자체는 통과해야 한다)
npm test                                        # 기존 1328 무회귀(새 파일이 test/** 스캔을 깨지 않는다)
```

## 검증 절차

1. 위 AC 커맨드를 실행한다(전부 컨테이너에서 그대로 돈다 — MySQL·JDK 불요).
2. 아키텍처 체크리스트:
   - ADR-008 대상 파일(스풀 writer)을 **읽기**만 했는가? 이 step은 앱 코드를 고치지 않는다.
   - 순수 모듈인가(전역·FS 직접 접근 없이 주입 의존성만)?
   - 리포트에 스풀 값 원문이 실리지 않는가(위생)?
3. 결과에 따라 `phases/76-server-cutover-ops/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(생성 파일 경로·핵심 시그니처 포함)"`
   - 3회 시도 후 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"`

## 금지사항

- `JSON.parse` 후 재직렬화로 content를 비교하지 마라. 이유: 키 순서·이스케이프·숫자 표기가 뭉개져 두 서버의 직렬화 divergence(계약 패리티가 못 보던 축)를 대조가 조용히 삼킨다.
- 스풀 값 원문을 diff 리포트·stdout에 싣지 마라. 이유: 기사 본문·작성자 등 신뢰 경계 밖으로 나가면 안 되는 데이터가 로그로 샌다.
- 앱 코드(`src/**`·`server/**`·`server-spring/**`)를 고치지 마라. 이유: 이 step은 대조 도구만 만든다.
- 기존 테스트를 깨뜨리지 마라.
