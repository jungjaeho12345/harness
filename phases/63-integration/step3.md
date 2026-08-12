# Step 3: release-docs

## 읽어야 할 파일

- `CLAUDE.md`
- `phases/63-integration/index.json` — scope·decisions **(1)(4)(8)(14)(15)(16)**·open_questions·forward_notes
- `phases/63-integration/step0.md`·`step1.md`·`step2.md`와 **각 step의 `summary`**(index.json) — 이 문서에 적을 수치·동작은 전부 여기서 인용한다(추측 금지)
- `packaging/server/README-배포.md` — 12절 구성(구성/요구사항/시작·중지/**4절 최초 설치: 사용자 계정 준비**/환경변수/배부 운영/수집 운영/백업·복구/업그레이드/서비스 등록/문제 해결/로그)
- `packaging/client/README-배포-클라이언트.md` — 10절 구성(구성/설치/최초 실행/주소 변경/새로고침·확대/연결 실패/**7절 알려진 제약**/업데이트/문제 해결/문의)
- `docs/ADR.md` — **ADR-011 전문**(61~64행). 특히 트레이드오프 문단의 다음 문장들이 이 phase로 **거짓이 되거나 확정된다**:
  - "평문 HTTP LAN 접속은 secure context가 아니라 `navigator.clipboard`가 비활성된다 … secure-origin 스위치 적용은 사용자 확정 대기"
  - "exe 리소스 메타(제품명·아이콘)가 Electron 기본값으로 남는다(리소스 편집은 범위 밖 — 필요 시 @electron/packager 전환 판단 대기)"
  - "맞춤법 밑줄이 표시되지 않는다 … 이 예외의 최종 유지 여부는 사용자 확정 대기다"
- `docs/ARCHITECTURE.md` — 배포 산출물 절(서버·클라이언트)
- `README.md` — EXE 배포 관련 절과 커맨드 목록
- `docs/news.md` — **읽기만 한다(무접촉 파일)**. 174행 `spellcheck=true`가 클라이언트 예외가 되는 근거 확인용

## 배경

이 step은 실행 코드를 0줄 쓴다. phase 60~63으로 완성된 **서버 exe + 클라이언트 exe** 배포를 운영자 한 사람이 처음부터 끝까지 따라갈 수 있는 문서 1장으로 묶고, 자동 검증이 원리상 판정할 수 없는 항목을 사용자 육안 체크리스트로 넘긴다. 그리고 이 phase가 확정한 사실로 ADR-011의 "확정 대기" 문장들을 정리한다.

## 작업

### 1. `packaging/README-배포-통합.md` (신규 — 통합 1장)

순서는 운영자의 실제 작업 순서다. 각 절은 기존 문서를 **대체하지 않고** 요약 + 링크한다(중복 서술 금지 — 상세는 서버/클라이언트 가이드가 단일 출처).

1. **전체 그림** — 서버 1대(exe + data/ + web/) + 기자 PC N대(포터블 폴더). 화면 변경은 서버 재배포만으로 전파되고, 셸 변경은 각 PC 폴더 교체가 필요하다는 구분(phase 62 forward_notes (b)).
2. **빌드** — `npm run dist:server` / `npm run dist:client` 산출물과 위치·크기(step1·2 실측 수치 인용).
3. **서버 설치** — 폴더 배치, 시작/중지, `DATA_DIR`·`HOST`·`PORT`, **초기 계정 = 시드한 `news.db`를 `data/`에 복사**하는 현행 절차(decisions (15) — 새 절차를 만들지 마라), 배부 tick의 외부 cron(ADR-008: 앱 내 타이머 없음), 수집 토큰(`COLLECTION_TOKEN` — 비-loopback 바인딩이면 없을 때 수집 라우트가 503으로 닫힌다).
4. **클라이언트 배포** — 폴더 복사, 최초 실행 시 서버 주소 입력, `%APPDATA%\기사작성기\config.json`(사용자별 — 폴더를 복사해도 설정은 따라가지 않는다), 대량 배포 시 config.json 사전 배치.
5. **클립보드(중요)** — 평문 HTTP + LAN IP에서도 클라이언트 EXE는 복사·붙여넣기가 동작한다(그 출처 하나만 secure context로 취급). 다만 **적용 시점**을 반드시 이렇게 적어라:
   - **최초 설정 직후에도 재시작 1회가 필요하다.** 설정 화면에서 LAN 주소를 처음 저장한 그 실행에서는 아직 완화가 적용돼 있지 않다(스위치는 프로그램이 켜질 때 저장된 주소를 보고 1회만 붙는다 — `requiresRestartForOrigin(null, LAN) = true`). 즉 **신규 배포 PC는 예외 없이 한 번 껐다 켜야** 복사·붙여넣기가 된다. 이건 예외 상황이 아니라 **기본 설치 절차의 한 단계**이므로 4절 설치 순서에도 "주소 입력 → 저장 → 프로그램 종료 후 재실행"으로 넣어라.
   - **서버 주소를 바꿀 때도 같은 이유로 재시작이 필요하다.**
   - **config.json 사전 배치를 하면 이 재시작 단계가 사라진다**(첫 실행 시점에 이미 주소가 있어 부팅과 동시에 적용된다) — 4절의 대량 배포 항목과 상호 참조로 연결하고, 그것이 권장 경로임을 명시하라.
   - 브라우저로 접속하면 같은 조건에서 여전히 막힌다(브라우저에는 이 완화가 없다). 근본 해결은 서버 HTTPS 종단.
6. **알려진 제약** — 코드 서명 없음(SmartScreen), 자동 업데이트 없음, 맞춤법 밑줄 없음(`spellcheck:false` **확정 예외** — 맞춤법은 SPA 자체 메뉴), 새로고침은 메뉴 또는 Ctrl+R(**F5는 동작하지 않는다**), 폴더 크기.
7. **운영** — 백업(`data/` 폴더 복사, DB 삭제 금지), 업그레이드(서버 폴더 교체 시 `data/` 보존 / 클라이언트 폴더 교체), 롤백.
8. **문제 해결** — 표 형식. 최소 6행: 클라이언트가 서버를 못 찾음 / 로그인 후 실시간 표시가 '연결 끊김' / 복사·붙여넣기 안 됨(주소 변경 후 재시작) / 기사가 편집 잠금 상태로 남음(데스크 강제 해제 — **DB 직접 수정 금지**) / SmartScreen 경고 / 방화벽으로 LAN 접속 불가.
9. **검증 커맨드** — `node scripts/verify-integration.mjs --scenario all`(설치 후 회귀 확인)과 그때 무엇이 확인되는지.
10. **관련 문서** — 서버·클라이언트 가이드, 육안 체크리스트 링크.

### 2. `packaging/체크리스트-육안확인.md` (신규 — 사용자 전달용)

자동 검증이 **원리상** 판정할 수 없는 항목만 담는다. 각 항목은 `절차 / 기대 결과 / 결과 기록란(정상·제약 있음·미확인)` 3요소를 갖춘 표 또는 체크박스 목록으로 쓴다. 각 항목에는 **왜 자동으로 못 하는지**를 한 줄로 적는다.

필수 항목:

- **인쇄 대화상자**(phase 62 D-3 미검증): 에디터 파일 > 인쇄 → Windows 인쇄 대화상자가 뜨는가. 안 뜨면 폴백은 메뉴에서 `webContents.print()`(별도 phase).
- **인쇄 미리보기**(D-2): 새 창에 내용이 그려지는가.
- **Alt 조합 단축키**(D-8 미검증): `Alt+Y`((끝) 삽입)·`Alt+V`(원본 붙여넣기)·`Alt+O`(약물입력)가 메뉴바 활성화에 삼켜지지 않고 동작하는가.
- **Ctrl+R / F5**: Ctrl+R는 새로고침되고 **F5는 반응하지 않는 것이 현재 사양**임을 확인.
- **한글 IME**: 조합 중 입력·백스페이스·엔터가 정상인가. 맞춤법 밑줄이 **없는 것이 정상**(확정 예외).
- **클립보드 실사용**(LAN 주소 접속 상태): 목록 우클릭 > 본문복사 → 메모장 붙여넣기 / 에디터 우클릭 > 붙여넣기 / 이미지 붙여넣기.
- **최초 설정 직후 재시작 1회**(가장 흔한 경로): 설정 없는 상태에서 LAN 주소를 처음 저장 → 재시작 안내가 뜨는가 / 재시작 **전**에는 복사·붙여넣기가 막히고 / 껐다 켠 **후**에는 되는가. (config.json을 미리 배치한 PC에서는 재시작 없이 바로 되는지도 함께 확인.)
- **주소 변경 후 재시작 안내**: 메뉴 > 서버 주소 변경으로 다른 LAN 주소를 저장했을 때 재시작 안내가 뜨고, 재시작 전에는 클립보드가 막히며 재시작 후 풀리는가.
- **작업표시줄·탐색기 아이콘과 제목**(step1 산출): 새 아이콘이 보이는가(탐색기 아이콘 캐시 주의 — 사본으로 확인), 창 제목·정보 대화상자의 버전이 1.0.0인가.
- **상세보기 팝업 육안**: 목록 행 클릭 → 720×800 창, 본문·이미지·유튜브 임베드 표시.
- **외부 링크**: 상세보기의 외부 링크 클릭이 기본 브라우저로 열리는가(앱 창에 남으면 정책 오류).
- **창 배치 저장**: 크기·최대화 상태로 종료 후 재실행 시 복원되는가.
- **두 번째 실행**: 이미 떠 있는 상태에서 다시 실행하면 기존 창이 앞으로 나오는가(최소화 상태 포함).
- **SmartScreen**: 다른 PC로 처음 복사해 실행할 때 경고가 뜨는지와 진행 방법.

말미에 **"이상 발견 시 DB를 직접 고치지 말고 담당자에게 보고"** 문장을 넣는다.

### 3. 기존 문서 정정·상호 링크

- `packaging/client/README-배포-클라이언트.md`: 7절 '알려진 제약'의 **클립보드 제약 서술을 이 phase의 사실로 정정**(클라이언트 EXE는 동작 / 브라우저 접속은 여전히 제약 / 주소 변경 후 재시작 필요), `spellcheck` 밑줄 없음을 '확정 예외'로 정정, 버전·아이콘 관련 한 줄 추가, 통합 가이드 링크. 그 외 절은 건드리지 마라.
- `packaging/server/README-배포.md`: 통합 가이드 링크 1~2줄만 추가(다른 문장 무수정).
- `README.md`: 통합 가이드 링크와 `verify:integration` 커맨드 추가.
- `docs/ARCHITECTURE.md`: 배포 산출물 절에 통합 검증 진입점과 브랜딩(아이콘·버전) 사실을 **추가**(삭제 3줄 이내).

### 4. `docs/ADR.md` — ADR-011 정정(이 파일에서 유일하게 허용된 변경)

- **결정** 문단: secure-origin 스위치 채택(조건·범위·부팅 1회)과 exe 리소스 메타 부여를 각각 1문장씩 추가.
- **트레이드오프** 문단: 위 '읽어야 할 파일'에 인용한 세 문장을 사실에 맞게 정정하고, **보안 트레이드오프 1문장**을 반드시 넣어라 — 요지: *설정된 그 출처 하나에 한해 브라우저의 secure-context 제약이 완화되므로 그 서버가 침해되면 secure context 전용 API 표면이 그 출처에 열린다. 완화 범위는 출처 1개이고 값은 저장된 설정에서만 나오며, 근본 해결은 서버 HTTPS 종단이다(그때 스위치는 조건상 자동 비적용된다).* 재시작 필요 제약도 1문장.
- **ADR-001~010 본문과 다른 문장은 수정하지 마라.** 새 ADR을 만들지 마라(아키텍처 결정 축이 바뀌지 않았다 — 기존 결정의 확정·정정이다).
- 정정으로 삭제되는 줄은 **6줄 이하**여야 한다(추가 위주 — phase 61·62의 ADR-ADDITIVE 규율).

### 5. phase 마감

- `phases/63-integration/index.json`의 step3 status 갱신 + 각 step 요약 정합성 확인.
- `phases/index.json`에 `63-integration` 항목을 `completed`로 갱신하고(이 phase 계획 시 `pending`으로 추가되어 있다) `completed_at`과 note(스코프 4개·실측 수치·잔여 백로그·사용자 확정 반영 사항)를 채운다.
- **사용자에게 전달할 것**을 요약 말미에 명시: (i) `packaging/체크리스트-육안확인.md` 경로와 확인 요청, (ii) 미확정 1건(회사명 문자열 — open_questions (a)), (iii) 이월 백로그(302 origin 승격 / 초기 관리자 계정 / 서버 HTTPS 종단).

## Acceptance Criteria

```bash
# [1] data snapshot: run BEFORE the dist/verify commands below (this step boots the exes 3 times via [3]/[4])
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" save

npm run lint
npm test
npm run test:web
npm run build

# [2] client dist must still bundle the client guide only (integration guide/checklist must NOT be shipped)
node scripts/dist-client.mjs

# [3] doc link/existence/bundling check (Korean paths live INSIDE the runner file, not on the command line)
node C:/Users/JUNGJA~1/AppData/Local/Temp/claude/<session>/scratchpad/check-docs.mjs

# [4] regression: integration smoke still passes after the doc work
node scripts/verify-integration.mjs --scenario all
npm run verify:integration

# [5] JSON validity of both phase index files
node -e "JSON.parse(require('fs').readFileSync('phases/index.json','utf8'));JSON.parse(require('fs').readFileSync('phases/63-integration/index.json','utf8'));console.log('JSON-OK')"

# [6] source diff scope: only this step's owned files
git status --porcelain

# [7] data snapshot compare: SAME command as [1] with the last arg changed to "compare" (exit 1 = real data touched)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" compare
```

**[1]/[7] 게이트의 의미**: `news.db`·`uploads/`는 `.gitignore` 대상이라 `git status`로는 어떤 변경도 드러나지 않는다(무효 게이트). 이 step은 [2]/[4]에서 exe를 여러 번 기동하므로 스냅샷 비교가 유일한 데이터 안전 증거다.

**[3]의 러너 파일**은 아래 스켈레톤을 그대로 쓴다(경로에 한글이 있어 Bash 인라인이 깨지므로 **파일 안에** 둔다). 위치는 **스크래치패드(세션 임시 디렉토리) 절대 경로가 1순위**이고, `[3]`의 `<session>` 부분을 이번 세션의 실제 디렉토리로 바꿔 기록하라. 부득이 리포 안에 둘 경우에는 AC 실행 직후 **반드시 삭제**한다(커밋 금지 — 남으면 diff scope 위반이며, step0 금지사항의 "검증 스크립트를 리포에 커밋하지 마라"와 같은 규율이다).

```js
// check-docs.mjs — 스크래치패드에 두고 절대 경로로 실행(리포에 두면 실행 후 삭제).
// 게이트: 문서 존재 · 상호 링크 · 배포물 동봉 범위 · ADR 보존 · 무접촉 파일 증분 0.
// 전제: step3 시작 직후에 아래 커맨드로 시작 시점 porcelain을 파일로 저장해 둘 것(증분 판정의 기준선).
//   git -C D:/agents/harness status --porcelain > <스크래치패드>/porcelain-before.txt
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = 'D:/agents/harness';
const BEFORE = 'C:/Users/JUNGJA~1/AppData/Local/Temp/claude/<session>/scratchpad/porcelain-before.txt'; // 세션 경로로 교체
const INTEG = `${ROOT}/packaging/README-배포-통합.md`;
const CHECK = `${ROOT}/packaging/체크리스트-육안확인.md`;
const SERVER = `${ROOT}/packaging/server/README-배포.md`;
const CLIENT = `${ROOT}/packaging/client/README-배포-클라이언트.md`;
const ADR = `${ROOT}/docs/ADR.md`;
const DIST = `${ROOT}/dist/기사작성기`; // dist-client 산출물(있을 때만 동봉 검사)
const fails = [];
const has = (p) => fs.existsSync(p) || fails.push(`missing: ${p}`);
[INTEG, CHECK, SERVER, CLIENT, ADR].forEach(has);

// 필수 파일이 없으면 여기서 끝낸다 — 아래 readFileSync가 스택 트레이스로 죽으면 원인이 가려진다.
if (fails.length) {
  console.log(`DOC-GATE-FAIL\n  ${fails.join('\n  ')}`);
  process.exit(1);
}

const integ = fs.readFileSync(INTEG, 'utf8');
// 통합 가이드가 세 문서를 링크하고, 링크 대상 파일이 실제로 존재하는가
for (const [label, file] of [['서버 가이드', SERVER], ['클라이언트 가이드', CLIENT], ['체크리스트', CHECK]]) {
  const name = file.split('/').pop();
  if (!integ.includes(name)) fails.push(`통합 가이드에 ${label}(${name}) 링크 없음`);
}
// 서버·클라이언트 가이드에서 통합 가이드로 되돌아오는 링크
for (const file of [SERVER, CLIENT]) {
  if (!fs.readFileSync(file, 'utf8').includes('README-배포-통합.md')) fails.push(`${file}에 통합 가이드 링크 없음`);
}
// 배포물 동봉 범위 — 클라이언트 폴더에는 클라이언트 가이드만 들어간다.
if (fs.existsSync(DIST)) {
  if (fs.existsSync(`${DIST}/README-배포-통합.md`)) fails.push('배포 폴더에 통합 가이드가 동봉됐다(packaging/client 밖에 두어야 한다)');
  if (!fs.existsSync(`${DIST}/README-배포-클라이언트.md`)) fails.push('배포 폴더에 클라이언트 가이드가 없다(동봉 회귀)');
}
// ADR: 011은 1개, 001~010 제목 줄 보존
const adr = fs.readFileSync(ADR, 'utf8');
if ((adr.match(/### ADR-011:/g) || []).length !== 1) fails.push('ADR-011 제목이 1개가 아니다');
for (let i = 1; i <= 10; i += 1) {
  if (!adr.includes(`### ADR-0${String(i).padStart(2, '0')}:`)) fails.push(`ADR-0${i} 제목 줄이 사라졌다`);
}
// 무접촉 파일 — "변경 0"이 아니라 "시작 스냅샷 대비 증분 0"이 기준이다
// (.claude/skills/**·phases/49 step0.md·phases/50/** 는 시작 시점부터 사용자 소유로 이미 M/?? 상태다).
const UNTOUCHED = ['docs/news.md', '.claude/skills', 'phases/49-mini-backlog-cleanup/step0.md', 'phases/50-hygiene-cleanup'];
const linesOf = (text) => new Set(text.split('\n').map((l) => l.trimEnd()).filter(Boolean));
const before = linesOf(fs.readFileSync(BEFORE, 'utf8'));
const after = linesOf(execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }));
for (const line of after) {
  if (before.has(line)) continue; // 시작 시점부터 있던 상태 — 증분이 아니다
  const p = line.slice(3).trim().replace(/^"|"$/g, '');
  if (UNTOUCHED.some((u) => p === u || p.startsWith(`${u}/`))) fails.push(`무접촉 파일 증분: ${line}`);
}
console.log(fails.length ? `DOC-GATE-FAIL\n  ${fails.join('\n  ')}` : 'DOC-GATE-OK');
process.exit(fails.length ? 1 : 0);
```

주의: `.claude/skills/**`와 `phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`는 **시작 시점부터 사용자 소유로 이미 수정/미추적 상태**다 — "변경 0"이 아니라 **시작 스냅샷 대비 증분 0**이 판정 기준이다. 그래서 이 step을 **시작하자마자** `git -C D:/agents/harness status --porcelain > <스크래치패드>/porcelain-before.txt`로 기준선을 파일에 남겨야 위 스켈레톤이 동작한다(기준선을 안 남기면 게이트가 무의미하다).

## 검증 절차

1. 위 AC를 전부 실행한다.
2. **문서 사실성 대조**(문서 리뷰의 핵심): 통합 가이드와 체크리스트에 적은 모든 수치·경로·동작을 step0~2의 요약 또는 실제 산출물과 1:1 대조한다. 확인되지 않은 항목은 **"확인 미완"으로 정직하게 적어라**(phase 62 step4가 D-3·D-8을 그렇게 처리한 전례). 추측으로 "정상 동작한다"고 쓰지 마라.
3. `git diff --stat docs/ADR.md`로 삭제 줄 수가 6 이하인지 확인하고, ADR-001~010 본문이 무변경인지 `git diff`로 눈으로 확인한다.
4. `git status --porcelain` 증분이 이 step 소유 파일(신규 2개 + 기존 문서 4개 + phases/**)뿐인지 확인한다.
5. 아키텍처 체크리스트: 실행 코드 0줄(`client/**`·`scripts/**`·`web/**`·`server/**`·`src/**`·`test/**`·`package.json` 무수정) / DB 무접촉 / 배포물 위생 게이트 통과 유지.
6. phase 마감 처리를 완료하고, 사용자 전달 항목(체크리스트 경로·미확정 1건·이월 백로그)을 요약에 남긴다.

## 금지사항

- `docs/news.md`를 수정하지 마라(무접촉 파일). 이유: 스펙 원문은 이 프로젝트의 요구사항 단일 출처이며, 구현 예외는 ADR에 적는다(`spellcheck` 예외가 정확히 그 방식이다).
- ADR-011 외의 ADR 문장을 고치거나 새 ADR을 만들지 마라. 이유: 이 phase는 기존 결정의 확정·정정이지 새 아키텍처 결정이 아니다 — ADR 신설 기준(흐름·계층·외부 계약 변경)에 미달한다.
- 기존 서버·클라이언트 가이드의 내용을 통합 가이드로 **옮기지** 마라(요약 + 링크만). 이유: 같은 사실이 두 곳에 적히면 다음 변경 때 한쪽이 조용히 거짓이 된다.
- 통합 가이드·체크리스트를 `packaging/client/`나 `packaging/server/`에 두지 마라. 이유: 그 두 디렉토리는 각각 클라이언트·서버 배포 폴더로 **통째 복사**된다 — 기자 PC에 서버 운영 문서가, 서버에 육안 체크리스트가 딸려 간다.
- 실행 코드를 건드리지 마라(`client/**`·`scripts/**`·`package.json` 포함). 이유: 문서 step에서 코드가 섞이면 리뷰 게이트가 무력화되고, 문서 오류와 코드 회귀가 한 커밋에 뭉친다. 코드 결함을 발견하면 고치지 말고 보고하라.
- 확인하지 않은 동작을 "정상"으로 적지 마라. 이유: 배포 문서의 거짓 서술은 운영 장애 시 오진을 만든다 — 미확인은 미확인으로 적고 체크리스트로 넘긴다.
- DB를 고치라는 절차를 문서에 적지 마라(잠금 해제는 UI의 데스크 강제 해제로). 이유: 이 프로젝트의 최우선 금지 사항은 DB 데이터 삭제·직접 조작이다.
