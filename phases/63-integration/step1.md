# Step 1: exe-branding

## 읽어야 할 파일

- `CLAUDE.md` — TDD·아키텍처 규칙
- `docs/ADR.md` — **ADR-010**(빌드 도구는 런타임 의존성이 아니다 — 정확 버전 고정 규율)·**ADR-011**(패키저 없이 직접 조립). 이 step은 ADR을 **수정하지 않는다**(step3 소유)
- `phases/63-integration/index.json` — decisions **(5)(6)(7)(8)(9)**, open_questions (a)(b)(c)
- `phases/62-client-exe/index.json` — open_questions **(a)**(리소스 메타가 Electron 기본값으로 남는다는 기록), decisions (5)
- `scripts/dist-client.mjs` — 조립 파이프라인 전체. 특히 5절 exe rename(90~97행, 한글 실패 시 ASCII 폴백 `article-client.exe`), 6절 `resources/app` 화이트리스트(99~108행), 8절 금지 패턴 재귀 스캔(120~124행), 9절 요약 출력(126~148행)
- `scripts/sea-build.mjs` — 선택 항목 D를 수행할 때만. node.exe 복사(121~123행) → SEA blob → postject 주입(130~137행) → 한글 rename 순서
- `scripts/verify-server-exe.mjs` — 읽기만. 선택 항목 D의 게이트(full·portable 두 모드)
- `client/package.json` — `productName: '기사작성기'`, `version`(현재 0.0.0 — `app.getVersion()`·정보 대화상자의 출처)
- `package.json` — `version`(현재 0.0.0), devDependencies(정확 버전 고정 관행: electron `43.4.0`·esbuild `0.25.12`)
- `test/client-shell-core.test.js` — 순수 모듈 테스트 스타일(node:test)

## 배경

phase 62는 패키저 없이 직접 조립을 택했고(ADR-011), 그 대가로 **exe의 리소스 메타가 Electron 기본값**으로 남았다(실측: ProductName/FileDescription=`Electron`, CompanyName=`GitHub, Inc.`, FileVersion=`43.4.0`). 사용자 확정(2026-08-13)에 따라 **기존 직접 조립 파이프라인을 유지한 채** 아이콘과 버전·제품명 메타만 최소 추가한다.

계획 단계에서 실측한 사실(추측이 아니다 — 그대로 신뢰하고 시작해도 된다):

- `resedit@3.0.2` 설치 = 2패키지(`resedit` + `pe-library`), 네이티브 바이너리 0, 순수 JS.
- `node_modules/electron/dist/electron.exe`(225,533,440B)와 `node.exe`(92,279,112B) 둘 다 `NtExecutable.from(buf, { ignoreCert: true })` 파싱 성공. **아이콘 그룹 id=1, lang=1033**, VersionInfo 존재.
- node.exe 사본에 `VersionInfo.setFileVersion/setProductVersion/setStringValues` → `outputToResourceEntries` → `res.outputResource(exe)` → `fs.writeFileSync(Buffer.from(exe.generate()))` 한 결과가 **정상 실행**됐다(`--version` → v24.16.0). PowerShell `(Get-Item ...).VersionInfo`로 ProductName·FileDescription·FileVersion `1.0.0.0` 확인.
- 부작용: Authenticode 서명이 제거된다(크기 15,688B 감소). 이 프로젝트는 코드 서명을 하지 않으므로 손실이 없다.
- 순수 Node로 만든 .ico(16/32/48/64/128/256, 32bpp DIB, 370,070B)를 `Data.IconFile.from()`이 6항목으로 파싱했다. **256 항목은 ICO 디렉토리 규약상 폭·높이가 0으로 기록된다**(정상).
- **PowerShell은 이 세션 Bash의 PATH에 없다**(ENOENT). 쓰려면 절대 경로 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`.
- **한글 경로·인자를 Bash 인라인으로 넘기면 깨진다.** 한글 경로가 필요한 실행은 ASCII 경로의 node 러너 파일(스크래치패드)에 담아 `node <ascii-path>`로 실행하라(phase 62 step3 전례).

## 작업

A → B → C → D 순서를 지켜라. 각 단계는 앞 단계가 green일 때만 시작한다.

### A. 아이콘 — 순수 생성기 + 커밋된 산출물

1. **테스트 먼저** `test/exe-branding.test.js`에 아이콘 케이스를 red로 작성한다.
2. `scripts/lib/icoBuilder.mjs`(신규, **fs 비의존 순수 모듈**):
   ```js
   export const DEFAULT_ICON_SIZES = [16, 32, 48, 64, 128, 256];
   export function buildIcoBuffer({ sizes = DEFAULT_ICON_SIZES } = {}) // → Buffer (ICO 바이트열)
   ```
   - 각 항목은 32bpp DIB: `BITMAPINFOHEADER`(40B, `biHeight = size*2`, `biPlanes=1`, `biBitCount=32`, `biCompression=0`) + BGRA 픽셀(bottom-up) + AND 마스크(1bpp, 행 4바이트 정렬).
   - 디렉토리 항목 16B: width/height는 256이면 0, `planes=1`, `bitCount=32`, `bytesInRes`, `imageOffset`.
   - 그림은 **단순 도형**이다(전용 디자인 파일이 없다 — 임시 아이콘). 예: 배경 라운드/사각 블록 + 기사 줄을 뜻하는 가로 막대 3~4개. 폰트 렌더링·외부 이미지·네트워크 사용 금지(순수 픽셀 계산만).
   - **결정론**: 같은 입력 → 바이트 동일. 난수·타임스탬프·`Date` 금지.
3. `scripts/make-icon.mjs`(신규 CLI): `node scripts/make-icon.mjs [--out <path>] [--check]`
   - 기본 출력 `packaging/icon/app.ico`. `--check`는 **쓰지 않고** 재생성 결과와 기존 파일의 sha256을 비교해 다르면 exit 1(결정론·드리프트 잠금).
   - 인자 가드 필수(알 수 없는 인자·빈 값 → 사용법 출력 후 exit 1). 이유: `scripts/**`는 eslint 밖이다.
4. 생성한 `packaging/icon/app.ico`를 **커밋**한다. 빌드는 이 파일만 읽는다(빌드 시점 생성 의존 0). `packaging/client/` 밖에 두는 이유는 decisions (7) — `dist-client.mjs`가 `packaging/client/**`를 배포 폴더 루트로 통째 복사하기 때문이다.

### B. 버전·문자열 메타 — 순수 모듈 + 단일 출처

1. `package.json`의 `version`을 `0.0.0` → `1.0.0`으로, `client/package.json`의 `version`도 `1.0.0`으로 올린다(두 파일에서 **version 필드 1줄씩만** 건드린다).
2. `scripts/lib/exeMeta.mjs`(신규, 순수):
   ```js
   export function toVersionQuad(version)      // '1.0.0' → [1,0,0,0]; 형식 위반은 throw
   export function buildClientVersionStrings({ version, exeName }) // → { ProductName, FileDescription, CompanyName, FileVersion, ProductVersion, OriginalFilename, ... }
   export function buildServerVersionStrings({ version, exeName }) // 선택 항목 D용
   ```
   - ProductName은 `기사작성기`(client/package.json의 `productName`과 같은 값), FileDescription은 클라이언트/서버를 구분하는 한국어 한 줄.
   - **CompanyName은 `기사작성기`로 둔다**(사명 미확정 — open_questions (a)). Electron 기본값 `GitHub, Inc.`가 남는 것만은 반드시 피한다. 추측한 회사명을 넣지 마라.
   - FileVersion/ProductVersion 문자열은 `1.0.0.0` 형식이다.
3. 테스트에 **버전 동일성 잠금**을 넣는다: 루트 `package.json.version === client/package.json.version`(둘이 갈라지면 정보 대화상자와 exe 메타가 어긋난다).

### C. 클라이언트 exe에 적용 — `scripts/dist-client.mjs` 결선

1. devDependency 추가: **`npm install --save-dev --save-exact resedit@3.0.2`** (정확 고정 — ADR-010 규율, `^`·`~` 금지. `package.json`을 손으로 고치고 install하는 방식도 결과가 같다면 무방하지만, 버전 범위 기호가 붙으면 실패다). 런타임 `dependencies` 5개는 불변이다.
   - **lock 증분 가드**: `git diff package-lock.json`의 증분이 `resedit`·`pe-library` 두 패키지(및 그 최소 메타)뿐인지 확인하라. 다른 패키지 버전이 함께 움직였으면 **되돌리고 실패로 판정**한다(설치 부수효과로 electron·vite·esbuild 등이 조용히 올라가면 이 phase의 기준선 실측이 통째로 무의미해진다).
2. `package.json` scripts에 `"make:icon": "node scripts/make-icon.mjs"` 한 줄 추가.
3. `dist-client.mjs`의 **5절 exe rename 직후**(= 최종 exe 경로가 확정된 시점)에 메타 적용 단계를 넣는다:
   - `packaging/icon/app.ico`를 읽어 `Data.IconFile.from()` → `Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons.map(i => i.data))`
   - `Resource.VersionInfo.fromEntries(res.entries)[0]`에 `setFileVersion`·`setProductVersion`(quad, lang 1033)·`setStringValues({ lang: 1033, codepage: 1200 }, buildClientVersionStrings(...))` → `outputToResourceEntries` → `res.outputResource(exe)` → 파일 재기록.
   - 버전 값은 `client/package.json`을 읽어 쓴다(문자열 하드코딩 금지 — 단일 출처).
   - **적용 직후 read-back 검증**: 같은 exe를 다시 파싱해 (i) 아이콘 그룹 항목 수 = 생성한 아이콘 수, (ii) FileVersion 문자열이 기대값과 일치, (iii) ProductName이 기대값과 일치임을 확인하고, 하나라도 어긋나면 **빌드를 실패시킨다**.
   - 요약(stdout 한 줄 + JSON)에 `metaApplied`·`fileVersion`·`iconEntries`를 추가한다. 기존 요약 키(`outDir`·`exeName`·`electronVersion`·`appEntries`·`fileCount`·`bytes`)는 **제거·개명하지 마라**(phase 62 AC와 후속 검증이 읽는다).
   - **서명 관련 주의**: resedit은 `ignoreCert: true`로 읽어 재생성하므로 **Authenticode 서명 디렉토리가 함께 제거된다**(계획 단계 실측: node.exe 92,279,112B → 92,263,424B, 실행 정상). 따라서 별도의 `signtool remove` 단계를 넣을 필요가 없고, `signtool`이 없거나 "remove failed" 류 메시지가 보여도 **정상**이다(이 프로젝트는 미서명 배포 — ADR-011). 서명 유지를 위해 리소스 편집을 건너뛰는 분기를 만들지 마라.
   - 실패는 **fail-fast**다(경고 후 계속 금지 — 조용히 Electron 기본 메타로 배포되는 것이 최악이다). 다만 `--no-meta` 플래그로 명시 우회는 허용한다(디버깅용).
4. `기사작성기.exe` rename이 실패해 ASCII 폴백(`article-client.exe`)으로 간 경우에도 **같은 경로로 메타를 적용**한다(OriginalFilename만 실제 파일명으로).

### D. 서버 SEA exe에도 적용 (선택 — 게이트가 판단한다)

1. `scripts/sea-build.mjs`에서 **node.exe 복사 직후 · postject 주입 전**에 B의 `buildServerVersionStrings`로 같은 절차를 수행한다(주입 후 리소스 재작성은 SEA blob 손상 위험 — decisions (9)).
2. 게이트: `node scripts/dist-server.mjs` → `node scripts/verify-server-exe.mjs --exe <path>`(full) → 배포 폴더 **사본**에 대해 `--portable`. 셋 다 통과해야 채택한다.
3. 하나라도 실패하면 `sea-build.mjs` 변경을 **되돌리고**(git 되돌림 범위는 그 파일 하나) 클라이언트만 브랜딩한 채로 마무리한 뒤, 실패 현상과 판단을 요약에 사실로 남긴다. 억지로 통과시키지 마라.

## Acceptance Criteria

```bash
# [1] data snapshot: run BEFORE any build/verify below (size+mtime of news.db, uploads entry count)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" save

node --test test/exe-branding.test.js
npm test
npm run lint
npm run test:web
npm run build

# [2] icon determinism: committed .ico must equal a fresh regeneration (exit 1 on drift)
node scripts/make-icon.mjs --check

# [3] arg guards: both must exit non-zero
node scripts/make-icon.mjs --nope;        echo "exit=$? (must be non-zero)"
node scripts/make-icon.mjs --out;         echo "exit=$? (must be non-zero)"

# [4] client dist: summary line must print metaApplied=true and fileVersion=1.0.0.0
node scripts/dist-client.mjs
node scripts/dist-client.mjs            # second run must also succeed (idempotent)

# [5] informational only (no pass/fail exit code): print the lockfile increment so you can apply the rule in
#     the C.1 prose gate - if any package other than resedit / pe-library moved, revert and fail the step.
git diff --stat package-lock.json
git diff package-lock.json | grep -E "^[+-] +\"(node_modules|packages)" | head -40

# [6] only when optional task D was performed
node scripts/dist-server.mjs

# [7] data snapshot compare: SAME command as [1] with the last arg changed to "compare" (exit 1 = real data touched)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" compare

# [8] source diff scope (NOT a data gate: news.db/uploads are gitignored and never appear here)
git status --porcelain
```

**[1]/[7] 게이트의 의미**: `news.db`·`uploads/`는 `.gitignore` 대상이라 `git status`로는 어떤 변경도 드러나지 않는다(무효 게이트). 실 데이터 무접촉은 크기·mtime·항목 수 비교로만 증명된다.

**한글 경로가 필요한 검증**(브랜딩 후에도 exe가 정상 기동하는지 — 이 step에서 가장 중요한 게이트)은 ASCII 경로의 node 러너로 실행한다. 스크래치패드에 아래 형태의 파일을 만들고 `node <scratchpad>/run-verify-dist.mjs`로 돌려라.

```js
// run-verify-dist.mjs (스크래치패드 — 리포에 커밋하지 않는다)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const exe = ['dist/기사작성기/기사작성기.exe', 'dist/기사작성기/article-client.exe'].find((p) => fs.existsSync(p));
const r = spawnSync(process.execPath, ['scripts/verify-client.mjs', '--exe', exe, '--scenario', 'all'],
  { cwd: 'D:/agents/harness', stdio: 'inherit' });
process.exit(r.status ?? 1);
```

`npm run test:web` 비고정 실패 규약: 1건이 비고정으로 실패하면 최대 2회 재실행 + 단독 실행으로 판정한다.

## 검증 절차

1. 위 AC를 전부 실행한다. 브랜딩 후 `verify-client --exe ... --scenario all`이 **성공**해야 한다(exe가 여전히 뜨고, `resources/app` 배치가 살아 있다는 증거).
2. **독립 도구로 메타 재확인**(read-back 자체 검증에 더해): 절대 경로 PowerShell로 `(Get-Item <exe>).VersionInfo`의 ProductName·FileDescription·FileVersion을 출력해 요약에 **그대로** 붙인다. 한글 경로가 인자에 들어가므로 node 러너 안에서 `execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [...])`로 호출하라.
3. 아이콘 육안 확인: 배포 폴더를 탐색기에서 열어 exe 아이콘이 바뀌었는지 본다. **탐색기 아이콘 캐시** 때문에 옛 아이콘이 보일 수 있으므로, 확인은 **새 경로로 복사한 사본**으로 한다. 결과를 "정상 / 캐시 의심 / 미확인" 중 하나로 기록한다.
4. **변이 검증 3종**(각각 red 확인 후 원복): (a) `buildIcoBuffer`의 디렉토리 항목 offset 계산을 1바이트 어긋나게 → red, (b) `toVersionQuad('1.0')`가 throw하지 않게 → red, (c) 루트/클라이언트 version 동일성 단언 제거 후 한쪽만 바꿔 → red.
5. 실측 기록: `.ico` 바이트 수·항목 수 / 메타 적용 소요(ms)·재조립 총 소요 / 브랜딩 후 exe 크기와 파일 수(phase 62 기준 90파일 347.4MB 대비 증분) / 선택 항목 D의 채택 여부와 근거.
6. `git status --porcelain` 증분이 소유 파일 목록(`scripts/lib/icoBuilder.mjs`·`scripts/lib/exeMeta.mjs`·`scripts/make-icon.mjs`·`packaging/icon/app.ico`·`scripts/dist-client.mjs`·`test/exe-branding.test.js`·`package.json`·`package-lock.json`·`client/package.json`, D 수행 시 `scripts/sea-build.mjs`)뿐인지 확인한다.
7. 아키텍처 체크리스트: 런타임 `dependencies` 5개 불변 / `client/**`(package.json version 1줄 제외)·`web/**`·`server/**`·`src/**`·`docs/**` 무수정 / `scripts/verify-client.mjs`·`verify-server-exe.mjs`·`dist-server.mjs` 무수정 / DB 무접촉 / 배포물 위생 게이트(금지 패턴 스캔·화이트리스트 집합 비교) 그대로 통과.
8. `phases/63-integration/index.json`의 step1 status를 갱신한다. 중간 실패 시 산출물을 지우지 말고 진행 지점을 error_message에 남겨라.

## 금지사항

- `@electron/packager`·`electron-builder`로 전환하지 마라. 이유: phase 62 decisions (5)와 ADR-011이 "패키저 없이 직접 조립"으로 확정했고, 이 phase의 사용자 지시도 "기존 파이프라인 유지 + 최소 추가"다. 패키저 전환은 배포물 레이아웃·검증 게이트·문서를 전부 다시 쓰게 만든다.
- 런타임 `dependencies`에 무엇도 추가하지 마라(resedit는 `devDependencies`). 이유: ADR-010의 런타임 의존성 5개 불변 원칙이며, 배포물에 들어가는 축과 빌드 도구 축은 구분한다.
- 아이콘 파일을 `packaging/client/`에 두지 마라. 이유: `dist-client.mjs` 7절이 그 디렉토리를 배포 폴더 **루트로 통째 복사**해서 기자 PC마다 정체불명의 .ico가 놓인다.
- 버전 문자열을 스크립트에 하드코딩하지 마라. 이유: `package.json`이 단일 출처여야 다음 릴리스에서 값이 갈라지지 않는다.
- postject 주입 **후에** 서버 exe 리소스를 재작성하는 것을 기본 경로로 삼지 마라. 이유: SEA blob이 PE 리소스로 들어 있어 리소스 디렉토리 재작성이 blob을 손상시킬 수 있고, 그 실패는 "exe가 조용히 종료"로 나타난다(phase 61에서 겪은 실패 양상과 동형).
- 메타 적용 실패를 경고로 넘기지 마라(`--no-meta` 명시 지정 제외). 이유: 조용히 Electron 기본 메타로 배포되면 아무도 눈치채지 못한 채 "GitHub, Inc." 서명 없는 정체불명 exe가 기자 PC에 깔린다.
- `scripts/verify-client.mjs`·`scripts/verify-server-exe.mjs`·`scripts/dist-server.mjs`를 수정하지 마라. 이유: phase 61·62가 확정한 검증 게이트다(선택 항목 D는 `sea-build.mjs`만 건드린다).
- `client/main.js`·`client/lib/**`를 수정하지 마라(step0 소유). 이유: 소유 경계가 겹치면 두 step의 실패 원인을 분리할 수 없다.
- 배포 폴더(`dist/**`)를 리포에 커밋하지 마라. 이유: `.gitignore`가 이미 막고 있으며, 수백 MB 바이너리는 저장소를 파괴한다.
