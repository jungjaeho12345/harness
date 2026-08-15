# Step 3: script-guards

## 읽어야 할 파일

- `CLAUDE.md` — 커밋 규칙
- `phases/65-instance-lock/index.json` — scope (B-1)(B-2), decisions **(13)(15)(16)(17)**
- `phases/64-exe-backlog/index.json` — decisions **(2)(3)(9)**(공유 `flagValue` 모듈의 존재 이유 · 값 판정 3분류 · 서버/CDP 포트 범위 분리)과 step0·step2 요약
- `scripts/lib/cliArgs.mjs` — `flagValue(argv, index, flag)` 계약(`missing`/`empty`/`flag-like`)
- `scripts/make-icon.mjs` 전체(64줄) — 특히 `parseArgs`(28~40행)와 헤더 주석의 "`scripts/**`는 eslint ignore 대상 — 인자 가드가 유일한 정적 안전망"
- `scripts/verify-server-exe.mjs` 39~55행 — 나머지 6개 CLI가 쓰는 `takeValue` 결선 패턴의 실물(이 step이 그대로 따라 쓴다)
- `scripts/verify-integration.mjs` 36~82행(USAGE·`parseArgs`)과 **396~418행**(서버 포트 선택 호출부: base 20000 · span 15000 / CDP 포트 선택 호출부: base 35000 · span 10000 — 두 호출의 실제 리터럴은 그 파일에서 직접 확인하라. 이 계획 문서는 함수 호출 형태를 그대로 옮겨 적지 않는다)
- `test/verify-integration-portrange.test.js` 전체 — 이 step이 케이스를 추가할 텍스트 잠금(정규식이 **숫자 리터럴**을 요구한다는 사실이 중요하다)
- `test/cli-args.test.js` — `flagValue` 단위 테스트(이미 존재 — 이 step은 여기에 케이스를 더하지 않는다)

## 배경 (실코드 확인)

- **B-1**: `scripts/make-icon.mjs`는 phase 64가 결선한 6개 CLI에 빠진 **7번째** CLI다. 현행 `parseArgs`는 `opts.out = argv[++i]` 후 빈 값만 본다 → `--out --check`처럼 값 자리에 플래그가 오면 **그대로 통과**해 `--check`라는 이름의 파일에 아이콘을 쓰고, 원래 의도했던 `--check`(드리프트 검사)는 실행되지 않는다(두 축이 동시에 틀어지는 사고 — `flagValue`의 `flag-like` 판정이 존재하는 이유 그 자체다).
- **B-2**: `scripts/verify-integration.mjs`의 `--cdp-port` 가드는 `1024~65535`만 본다. phase 64가 서버 20000~34999 / CDP 35000~44999로 **범위를 분리**했는데, 운영자가 `--cdp-port 25000`을 명시하면 그 분리가 무력화된다(서버 자식 spawn 직후 CDP 포트를 고르는 구조라 같은 번호 경합이 성립한다 — phase 64 step2가 고친 결함 클래스와 같다).
- `test/verify-integration-portrange.test.js`의 정규식 `pickFreePort\(\s*[^,)]+,\s*(\d+)\s*,\s*(\d+)\s*\)`는 **호출부의 숫자 리터럴**을 전제한다 → 범위를 상수·모듈로 승격하면 그 잠금 3케이스가 통째로 무력화된다(그래서 이번 가드는 리터럴을 그대로 쓰고 드리프트만 테스트로 잠근다 — decisions (13)).

## 작업

### A. `scripts/make-icon.mjs` — `flagValue` 결선 (B-1)

1. `import { flagValue } from './lib/cliArgs.mjs';`를 추가한다.
2. `parseArgs` 안에 나머지 6개 CLI와 **같은 모양**의 로컬 헬퍼를 둔다:

```js
const takeValue = (i, flag) => {
  const v = flagValue(argv, i, flag);
  if (!v.ok) die(v.message);
  return v.value;
};
```

3. `--out` 분기를 `{ opts.out = takeValue(i, '--out'); i += 1; }`로 바꾸고, `flagValue`가 대체하는 기존 빈 값 가드(`if (!opts.out) die('--out 값이 비어 있다.')`)만 제거한다.
4. 종료 규약은 **현행 유지**(`die` = stderr + USAGE + `exit(1)`). `--check`·기본 동작·출력 문구·sha256 로직은 한 글자도 바꾸지 마라.

### B. `scripts/verify-integration.mjs` — `--cdp-port` 범위 겹침 가드 (B-2)

기존 `1024~65535` 가드(72~74행) **바로 뒤**에 아래 형태로 추가한다. **정규식 잠금이 이 형태를 찾는다 — 표현식 모양을 바꾸지 마라.**

```js
// 서버 포트 범위와 겹치는 값은 거부한다 — 아래 서버 포트 선택 호출부(base 20000 · span 15000)와 같은 구간이다.
// 드리프트는 test/verify-integration-portrange.test.js가 잠근다(가드 숫자 == 서버 호출부 [base, base+span)).
if (opts.cdpPort !== undefined && opts.cdpPort >= 20000 && opts.cdpPort < 35000) {
  die(`--cdp-port 값이 서버 포트 범위(20000~34999)와 겹친다: ${opts.cdpPort} — 35000~44999에서 고르라.`);
}
```

**CRITICAL(주석 함정 — 실증됨)**: 이 주석에 `pickFreePort` **+ 괄호 인자 목록(호스트, base 숫자, span 숫자) 형태**를 쓰지 마라(예시조차 여기 적지 않는다 — 복붙 사고 방지). 기존 텍스트 잠금은 파일 전체에서 `pickFreePort(` + 숫자 2개 패턴을 세므로 주석 속 리터럴이 **3번째 호출부로 카운트되어** "정확히 2건" 케이스와 서로소 케이스가 즉시 red가 된다(이 계획 초안이 실제로 그 함정에 빠져 리뷰에서 잡혔다). 위 예시처럼 인자 목록 없이 산문으로 지칭하라.

USAGE의 `--cdp-port` 줄에도 "20000~34999는 서버 범위라 거부"를 덧붙인다. `pickFreePort` 호출부 2곳의 숫자 리터럴은 **절대 상수로 바꾸지 마라**.

### C. `test/verify-integration-portrange.test.js` — 드리프트 잠금 케이스 추가

기존 3케이스는 그대로 두고 아래를 더한다.

- 스크립트 텍스트에서 정규식 `/opts\.cdpPort\s*>=\s*(\d+)\s*&&\s*opts\.cdpPort\s*<\s*(\d+)/g`로 가드를 찾는다 → **매치 정확히 1건**.
- 호출부 파싱을 첫 인자까지 확장해(`pickFreePort\(\s*([^,)]+),\s*(\d+)\s*,\s*(\d+)\s*\)`) 첫 인자가 `host`인 호출을 **서버 범위**, 나머지를 **CDP 범위**로 식별한다.
- 단언: 가드의 `[lo, hi)`가 서버 범위 `[base, base+span)`와 **정확히 일치**한다. 그리고 가드 범위와 CDP 범위가 서로소다.
- 실패 메시지에 기대 형태(위 B의 표현식)와 발견된 값을 함께 출력해, 표현식 모양을 바꾼 사람이 이유를 즉시 알게 하라.
- 이 테스트는 **파일 읽기 전용**이다(DB·네트워크·프로세스 부수효과 0 — 기존 헤더 규율 유지).

### D. CLI 프로브 (테스트가 아니라 실행 증거 — 요약에 exit code와 함께 기록)

**전부 임시 cwd에서 실행하라**(리포에 `--check`라는 이름의 파일이 생기면 안 된다). 결선 **전/후** 두 번 돌려 red→green을 증명한다.

| 프로브 | 결선 전(기대) | 결선 후(기대) |
|---|---|---|
| `node <repo>/scripts/make-icon.mjs --out --check` | exit 0 + cwd에 `--check` 파일 생성(결함) | exit 1 + flag-like 메시지, 파일 미생성 |
| `node <repo>/scripts/make-icon.mjs --out` | exit 1(빈 값 메시지) | exit 1(값 없음 메시지) |
| `node <repo>/scripts/make-icon.mjs --check`(cwd=repo) | exit 0 `check ok sha256=…` | 동일(무회귀 — 커밋본 무변경) |
| `node <repo>/scripts/make-icon.mjs --out <tmp>/app.ico` | 생성 | 동일(생성 후 임시 파일 삭제) |
| `node <repo>/scripts/verify-integration.mjs --cdp-port 25000` | 통과해 exe 해석으로 진행 | exit 1 + 겹침 메시지 |
| `node <repo>/scripts/verify-integration.mjs --cdp-port 34999` | 〃 | exit 1(경계) |
| `node <repo>/scripts/verify-integration.mjs --cdp-port 35000 --server-exe <없는 경로>` | exit 1(경로 부재) | exit 1(경로 부재 — 값이 살아서 다음 가드까지 갔다는 양성 증거) |

`--cdp-port` 프로브는 인자 검증 단계에서 끝나야 한다(exe·자식 프로세스 기동 없음). 통합 검증 본체(`--scenario all`) 재실행은 **step4 소유**다.

## Acceptance Criteria

```bash
node --test test/verify-integration-portrange.test.js
node --test test/cli-args.test.js test/exe-branding.test.js
npm test
npm run lint
git status --porcelain
```

`packaging/icon/app.ico`가 바뀌지 않았는지(sha256 드리프트 잠금):

```bash
node scripts/make-icon.mjs --check
```

## 검증 절차

1. AC를 전부 실행한다. `test/exe-branding.test.js`(아이콘 동일성 잠금)가 green인지 반드시 확인한다. 가드·주석을 넣은 **직후** `node --test test/verify-integration-portrange.test.js`를 먼저 돌려 기존 3케이스(숫자 범위 호출 정확히 2건 포함)가 그대로 green인지 확인하라 — 주석 함정에 빠졌는지 여기서 즉시 드러난다.
2. D의 프로브 표를 결선 전/후로 돌려 실제 exit code와 메시지 요지를 요약에 기록한다(추측 금지 — 관측값만).
3. **변이 검증 3종**(각각 red 확인 후 원복):
   - (a) `--cdp-port` 가드를 제거 → 새 케이스 red(매치 0건).
   - (b) 가드 상한을 `35000` → `30000`으로 → 불일치 red.
   - (c) `make-icon`의 `takeValue` 결선을 `argv[++i]`로 원복 → 프로브 1행이 다시 파일을 만든다(테스트가 아니라 프로브로 잡히는 항목임을 요약에 명시하라).
4. `git status --porcelain` 증분이 소유 파일(`scripts/make-icon.mjs`·`scripts/verify-integration.mjs`·`test/verify-integration-portrange.test.js`·`phases/65-instance-lock/index.json`)뿐인지 **시작 시점 스냅샷 대비**로 확인한다. 임시 cwd에 만든 프로브 산출물이 리포에 남지 않았는지도 확인하라.
5. 아키텍처 체크리스트: `server/**`·`src/**`·`web/**`·`client/**`·`docs/**`·`packaging/**` 무수정 · dependencies 불변 · 스키마 무변경 · DB 접속 0 · 새 파일 0(신규 모듈을 만들지 않는다).
6. `phases/65-instance-lock/index.json`의 step3 status를 갱신한다.

## 금지사항

- `pickFreePort` 호출부의 숫자 리터럴을 상수·공유 모듈로 승격하지 마라. 이유: `test/verify-integration-portrange.test.js`의 정규식이 숫자 리터럴을 전제해서, 승격하는 순간 기존 잠금 3케이스가 조용히 무력화된다(값어치보다 회귀 위험이 크다 — decisions (13)).
- `pickFreePort(` 뒤에 숫자 인자 2개가 오는 형태를 **주석·문자열에도 새로 쓰지 마라**. 이유: 그 텍스트 잠금은 코드·주석을 구분하지 않고 세기 때문에 설명용 리터럴 하나가 "숫자 범위 호출은 정확히 2건" 케이스를 즉시 red로 만든다(`sea-import-meta-lock`과 같은 엄격성 규율이다).
- 위 red가 났을 때 **기존 정규식·케이스를 고쳐서 풀지 마라**(주석 쪽을 고쳐라). 이유: 스캔을 느슨하게 만드는 것은 잠금 자체를 약화시키는 방향이며, 그 잠금이 막고 있는 것은 phase 64가 실측으로 고친 포트 경합 회귀다.
- 가드 표현식의 모양(`opts.cdpPort >= 20000 && opts.cdpPort < 35000`)을 바꾸지 마라. 이유: 드리프트 잠금이 그 형태를 정규식으로 찾는다 — 모양이 바뀌면 매치 0건으로 red다.
- `verify-integration.mjs`의 시나리오 본체·CDP 로직·데이터 무변 단언을 건드리지 마라. 이유: 이 step의 스코프는 `parseArgs`와 USAGE 두 곳뿐이고, 통합 검증은 phase 63~64가 실측으로 잠근 게이트다.
- `make-icon.mjs`의 아이콘 생성 로직·출력 문구·기본 경로를 바꾸지 마라. 이유: `packaging/icon/app.ico`가 sha256으로 커밋본과 잠겨 있고(`test/exe-branding.test.js`) 바이트가 바뀌면 배포 브랜딩 게이트가 실패한다.
- 리포 cwd에서 `node scripts/make-icon.mjs --out --check` 같은 결함 프로브를 돌리지 마라. 이유: 리포 루트에 `--check`라는 이름의 파일이 생겨 diff scope가 오염되고, Windows에서 그 이름은 지우기 번거롭다.
- `scripts/**` 전반의 eslint 편입·새 플래그 추가로 스코프를 넓히지 마라. 이유: phase 64에서 제외 확정된 정책이다.
