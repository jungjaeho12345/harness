# Step 0: test-path-portability

## 목표

Windows에서 실패하는 백엔드 테스트 4건을 **크로스 플랫폼**으로 고친다. 원인은 테스트가 `'/spool/out/kbs'` 같은 **POSIX 경로 문자열을 하드코딩**해 기대값으로 쓰는데, 프로덕션(`src/services/spoolWriter.js`)은 `node:path`의 `join()`으로 경로를 합성하므로 Windows에서는 `'\spool\out\kbs'`가 나오기 때문이다.

**프로덕션 코드는 한 줄도 바꾸지 않는다.** `join()`이 OS 규약대로 동작하는 것이 옳고, 잘못된 쪽은 기대값이다. 이 step은 `test/` 하위만 수정한다.

이 step이 끝나면 백엔드 합격 기준이 **"616 pass / 4 fail"에서 "620 pass / 0 fail"로 상향**된다. 이후 모든 step은 백엔드 전량 green을 기준선으로 쓴다.

> **실행 패스**: 이 phase는 **backend 패스(step0~2) → web 패스(step3~8)** 두 묶음으로 실행한다. 패스 안에서는 순서를 지키고(step0의 기준선 상향이 step1·2의 AC 전제), 패스 사이에는 파일 중복이 없다. 이 step은 backend 패스의 첫 step이다.

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 반드시 심볼/문자열로 재확인하라(다른 step이 먼저 실행돼 줄이 밀렸을 수 있다).

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-008: 배부는 파일 스풀 outbound — 앱은 스풀 폴더에 쓰기만 한다).
- `src/services/spoolWriter.js` — **전체(읽기 전용, 수정 금지)**. `import { join } from 'node:path'`(L12), `const targetDir = join(rootDir, dir)`(L68), `const finalPath = join(targetDir, name)`(L70), `const tmpPath = join(targetDir, '.'+name+'.tmp')`(L73). 파일명 규칙은 `${articleId}_${compactStamp(stamp)}.json`.
- `test/spoolWriter.test.js` — **전체**. `make()`가 `rootDir: '/spool/out'`(L26)로 writer를 만든다. 수정 대상 단언: L69(`fs.calls.mkdir[0][0]`), L80(`assert.match(tmpPath, /^\/spool\/out\/kbs\//)`), L89(rename 최종 경로), L94 근처의 두 번째 writer(`rootDir: '/spool/out'`).
- `test/distributionService.test.js` — L285(`rootDir: '/spool/out'`), **L302**(`assert.equal(String(call[1]).startsWith('/spool/out/kbs'), true, ...)`). L27의 가짜 writer가 돌려주는 `file: '/spool/...'` 문자열은 **가짜 값이라 플랫폼 무관** — 건드리지 마라.
- `test/controllers.test.js` — L320(`DIST_SPOOL_DIR: '/spool/out'`), **L331**(`assert.equal(spoolFs.calls.mkdir[0][0], '/spool/out/kbs')`), **L333**(`assert.match(spoolFs.calls.rename[0][1], /^\/spool\/out\/kbs\/AKR\d{8}\d{9}_.*\.json$/)`).
- `test/distribution-tick-api.test.js` — **참고만**. `SPOOL_ROOT = '/spool/tickout'`이지만 단언은 `raw.includes('tickout')`/`includes(TARGET_DIR)` 같은 **부분 문자열**이라 구분자와 무관하다(현재 green). 수정하지 마라.

## 배경 (자기완결)

현재 `npm test` 결과는 **620 tests / 616 pass / 4 fail**이며, 실패 4건은 전부 아래 형태다.

```
+ actual   - expected
+ '\\spool\\out\\kbs'
- '/spool/out/kbs'
```

`join('/spool/out', 'kbs')`는 POSIX에서 `/spool/out/kbs`, Windows에서 `\spool\out\kbs`를 만든다. 입력값(`rootDir`, `spoolDir`)은 그대로 두고 **기대값만** 프로덕션과 동일한 API(`join`)로 계산하면 두 OS 모두에서 통과한다.

주의: `test/spoolWriter.test.js`의 실패는 L69에서 먼저 throw되므로 **L80(정규식)의 실패는 아직 드러나지 않았다**. L69만 고치면 다음 실행에서 L80이 새로 빨개진다 — 파일 안의 POSIX 가정을 **전수 조사**해서 한 번에 고쳐라(`/spool` 문자열 검색).

같은 함정이 `test/controllers.test.js`에도 있다: L331(mkdir 인자)에서 먼저 throw되므로 **L333(rename 정규식)의 실패는 아직 가려져 있다**. L331만 고치면 다음 실행에서 L333이 새로 빨개진다 — 두 줄을 한 번에 고쳐라. (`test/distributionService.test.js`는 L302 한 곳뿐이다.)

즉 "보고된 4건"을 고치면 **가려져 있던 2건이 새로 드러난다** — 최종 목표는 실패 목록이 아니라 `npm test`의 **fail 0**이다.

## 작업

### 공통 규칙

1. 각 테스트 파일 상단에 `import { join } from 'node:path';`(필요하면 `sep`도)를 추가한다.
2. 스풀 루트는 상수로 뽑아 쓴다(예: `const SPOOL_ROOT = '/spool/out';`). **입력값은 그대로 POSIX 문자열로 둔다** — 프로덕션이 그 입력을 어떻게 합성하는지가 검증 대상이다.
3. 기대값은 `join(SPOOL_ROOT, 'kbs')`, `join(SPOOL_ROOT, 'kbs', `${articleId}_20260728T010203456Z.json`)`처럼 **join으로 만든다**.
4. 정규식 단언은 둘 중 하나로 바꾼다:
   - (권장) 정규식을 없애고 `assert.equal(...)`/`assert.equal(String(p).startsWith(join(SPOOL_ROOT,'kbs')), true)` + 파일명 패턴은 `assert.match(basename(p), /^AKR\d{8}\d{9}_.*\.json$/)`처럼 **디렉토리와 파일명을 분리**해 단언한다.
   - 또는 실제값을 `String(p).split(sep).join('/')`로 정규화한 뒤 기존 POSIX 정규식을 유지한다.
5. **단언을 약화시키지 마라.** 임시 파일 → rename(원자적 게시), `tmpPath !== finalPath`, 파일명 `<articleId>_<timestamp>.json`, 재배부 시 다른 파일명 — 이 계약들은 그대로 검증돼야 한다.

### 파일별 수정 목록

- `test/spoolWriter.test.js`
  - mkdir 인자 단언 → `join(SPOOL_ROOT, 'kbs')`.
  - tmpPath 정규식 → tmpPath가 `join(SPOOL_ROOT,'kbs')` 하위인지 + 임시 파일명 규칙(`.`으로 시작, `.tmp`로 끝남) 단언으로 분리.
  - rename 최종 경로 단언 → `join(SPOOL_ROOT, 'kbs', `${ARTICLE.articleId}_20260728T010203456Z.json`)`.
- `test/distributionService.test.js`
  - `startsWith('/spool/out/kbs')` → `startsWith(join(SPOOL_ROOT, 'kbs'))`. 실패 메시지(`JSON.stringify(call)`)는 유지.
- `test/controllers.test.js`
  - mkdir 인자 단언 → `join('/spool/out', 'kbs')`.
  - rename 정규식 → 디렉토리는 `startsWith(join(...))`, 파일명은 `AKR\d{8}\d{9}_.*\.json` 패턴으로 분리 단언.

## TDD

이 step은 **기존 실패 테스트를 통과시키는 것**이 목표라 red가 이미 존재한다.

1. 먼저 `node --test test/spoolWriter.test.js test/distributionService.test.js test/controllers.test.js`를 실행해 **현재 실패 목록을 기록**한다(4건 + spoolWriter L80이 가려져 있음을 확인).
2. 기대값을 join 기반으로 고친다.
3. 같은 명령으로 전부 green을 확인한 뒤 `npm test` 전체를 돌린다.

## Acceptance Criteria

```bash
node --test test/spoolWriter.test.js test/distributionService.test.js test/controllers.test.js
npm test        # tests 620 / pass 620 / fail 0  (기준선 616 pass·4 fail → 4건 전부 해소)
npm run lint
```

`npm run test:web`은 이 step과 무관하다(웹 파일 무접촉). 다만 `git diff --stat`이 `test/` 하위 3개 파일만 보여야 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다. `npm test`의 요약이 **fail 0**이어야 한다.
2. `git diff --name-only`로 **`src/`·`server/`·`web/`에 변경이 없음**을 확인한다(프로덕션 무변경 증명).
3. 아키텍처 체크리스트:
   - ARCHITECTURE.md 디렉토리 구조를 따르는가?(테스트는 `test/`에만)
   - ADR-008을 벗어나지 않았는가?(실제 파일시스템 미사용 — mkdir/writeFile/rename 주입 유지)
   - CLAUDE.md 규칙(DB 비파괴·TDD)을 위반하지 않았는가?
4. 결과에 따라 `phases/49-mini-backlog-cleanup/index.json`의 step0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(백엔드 기준선이 620/620 green으로 상향됐음을 반드시 포함)"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 중단

## 금지사항

- `src/services/spoolWriter.js`를 수정하지 마라(특히 `join`을 문자열 연결이나 POSIX `path.posix.join`으로 바꾸지 마라). 이유: 스풀 경로는 실제 OS 파일시스템 경로다 — POSIX로 고정하면 Windows 운영에서 진짜 경로가 깨진다. 잘못된 것은 테스트 기대값이다.
- 실패 단언을 삭제하거나 `test.skip`/`describe.skip`으로 우회하지 마라. 이유: 스풀 경로 합성은 경로 조작 방어(`sanitizeSpoolDir`)와 원자적 게시의 회귀 가드다 — 없애면 보안·무결성 회귀가 무음으로 통과한다.
- 기대값을 `'\\spool\\out\\kbs'`처럼 Windows 구분자로 하드코딩하지 마라. 이유: POSIX 환경(CI·리눅스 서버)에서 즉시 깨진다 — 양쪽에서 통과해야 한다.
- `test/distribution-tick-api.test.js`·`test/distributionTickService.test.js`의 경로 문자열을 건드리지 마라. 이유: 그 단언들은 "응답에 경로가 유출되지 않는다"를 부분 문자열로 검사하는 보안 테스트이며 현재 green이다 — 구분자 무관하게 이미 옳다.
- 기존 테스트를 깨뜨리지 마라(기준: 백엔드 620/620 green, lint clean).
