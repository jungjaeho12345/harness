# Step 0: cli-args

## 읽어야 할 파일

- `CLAUDE.md` — TDD·아키텍처·커밋 규칙
- `phases/64-exe-backlog/index.json` — scope의 (A-2), decisions **(2)(3)(16)(17)**, order(파일 소유 경계)
- `scripts/lib/exeMeta.mjs` — `scripts/lib/**` 순수 모듈의 스타일(부작용 0, export만)
- `test/exe-branding.test.js` — `scripts/lib/**`를 `test/`에서 node:test로 잠그는 전례(1~20행)
- 결선 대상 6개 CLI의 `parseArgs` 함수 **그 부분만** 읽으면 된다:
  - `scripts/sea-build.mjs` 208~225행 (`--out` `--name`)
  - `scripts/dist-server.mjs` 105~122행 (`--out`)
  - `scripts/dist-client.mjs` 203~224행 (`--out` `--name`)
  - `scripts/verify-server-exe.mjs` 38~68행 (`--exe` `--script` `--spa` `--port`)
  - `scripts/verify-client.mjs` 42~64행 (`--exe` `--scenario` `--server` `--timeout`)
  - `scripts/verify-integration.mjs` 50~76행 (`--scenario` `--server-exe` `--client-exe` `--cdp-port` `--timeout`)

## 배경

6개 CLI 전부가 `opts.x = argv[++i]` 형태로 값을 읽는다. 플래그가 **마지막 인자**로 오면 `argv[++i]`가 `undefined`가 되고, 뒤따르는 가드는 하나같이 `if (opts.x !== undefined && !opts.x)` 꼴이라 `undefined`를 통과시킨다 → 구조 분해 기본값(예: `outDir = 'dist/server-exe'`)이 조용히 적용된다. 실코드에서 확인한 무음 통과 지점:

- `scripts/sea-build.mjs` 220행 · `scripts/dist-server.mjs` 117행 · `scripts/dist-client.mjs` 215·219행 — `--out`/`--name` 누락 시 기본 경로로 빌드가 그냥 돈다.
- `scripts/verify-server-exe.mjs` 55·59행 — `--script`/`--spa` 누락 시 그 옵션이 없었던 것처럼 진행한다(폴백 모드가 SEA 모드로 둔갑).
- `scripts/verify-client.mjs` 49행 — `--server` 누락 시 스크립트가 자기 서버를 띄우는 다른 경로로 간다.
- `scripts/verify-integration.mjs` 68~74행 — `--server-exe`/`--client-exe` 누락 시 기본 dist 경로 자동 해석으로 간다(검증 대상이 조용히 바뀐다).

`--port`/`--timeout`/`--cdp-port`는 `Number(undefined) = NaN` → 범위 가드가 잡으므로 현행도 죽지만, 값 파싱 단계에서 잡는 편이 메시지가 정확하다.

`scripts/**`는 eslint ignore 대상이라 이 계열 실수는 정적 검사에 걸리지 않는다(각 스크립트 헤더가 그렇게 적어 뒀다). 그래서 **순수 모듈 + node:test**가 유일한 안전망이다.

## 작업

### A. 테스트 먼저 (red)

`test/cli-args.test.js`를 신설하고 아래 계약을 red로 작성한다.

### B. `scripts/lib/cliArgs.mjs` 신설 (순수 모듈)

```js
// argv: 인자 배열 / index: 플래그 자체의 인덱스 / flag: '--out' 같은 플래그 이름
// → { ok: true, value }
// → { ok: false, reason: 'missing' | 'empty' | 'flag-like', message }
export function flagValue(argv, index, flag)
```

- `missing`: `argv[index + 1]`이 `undefined`(플래그가 마지막 인자).
- `empty`: 문자열이지만 `trim()` 결과가 빈 문자열.
- `flag-like`: 값이 `--`로 시작(예: `--out --skip-web` — 다음 플래그가 값으로 먹혀 두 축이 동시에 틀어진다).
- `message`는 한국어 한 줄이며 **플래그 이름을 포함**한다(어떤 인자가 문제인지 출력만 보고 알 수 있어야 한다).
- **순수**: `process.exit`·`process.stderr`·`console`·파일시스템·전역 상태 접근이 한 줄도 없다. 판정만 돌려준다.
- `-`(한 글자) 접두는 flag-like가 아니다 — 음수 등 정당한 값을 막지 않는다.

### C. 6개 CLI 결선 (parseArgs 함수 안만)

각 CLI에서 값을 받는 모든 플래그를 `flagValue`로 바꾸고, 실패는 **그 CLI의 현행 종료 규약 그대로** 처리한다.

- `verify-server-exe.mjs`·`verify-client.mjs`·`verify-integration.mjs` → 기존 `die(v.message)`.
- `sea-build.mjs`·`dist-server.mjs`·`dist-client.mjs` → 기존 `process.stderr.write(...)` + `process.exit(1)`(사용법 문자열 출력 관행 유지).
- 루프 인덱스 전진은 `argv[++i]` 대신 분기 안에서 `i += 1`로 명시한다.
- 숫자 플래그(`--port`·`--timeout`·`--cdp-port`)는 **`Number()` 변환 전에** `flagValue`를 통과시킨다.
- `flagValue`가 대체하는 기존 빈값 가드(`if (opts.outDir !== undefined && !opts.outDir)` 류)는 제거해도 된다. 단 의미가 다른 가드(`--exe`는 필수·`--dev`와 `--exe` 배타·경로 존재 확인·범위 확인)는 **전부 그대로 둔다**.
- `scripts/lib/**`는 부작용 0 순수 모듈이라 CLI가 import해도 안전하다. CLI끼리(`verify-*.mjs` 상호) import는 여전히 금지다 — import 즉시 `main()`이 도는 파일이다.

### D. 테스트 계약 (test/cli-args.test.js)

최소한 다음을 잠근다: 정상 값 통과 / 플래그가 마지막(`missing`) / 빈 문자열·공백만(`empty`) / `--`로 시작하는 값(`flag-like`) / `-1` 같은 한 글자 하이픈 값은 통과 / `message`에 플래그 이름 포함 / 반환 객체가 입력 배열을 변형하지 않음(순수성).

## Acceptance Criteria

```bash
node --test test/cli-args.test.js
npm test
npm run lint

# [1] 값 누락 — 전부 non-zero로 죽어야 한다(무음 기본값 진행 금지)
node scripts/sea-build.mjs --out;                                echo "exit=$? (must be non-zero)"
node scripts/sea-build.mjs --name;                               echo "exit=$? (must be non-zero)"
node scripts/dist-server.mjs --out;                              echo "exit=$? (must be non-zero)"
node scripts/dist-client.mjs --name;                             echo "exit=$? (must be non-zero)"
node scripts/verify-server-exe.mjs --exe;                        echo "exit=$? (must be non-zero)"
node scripts/verify-server-exe.mjs --exe package.json --script;  echo "exit=$? (must be non-zero)"
node scripts/verify-server-exe.mjs --exe package.json --spa;     echo "exit=$? (must be non-zero)"
node scripts/verify-client.mjs --exe package.json --scenario;    echo "exit=$? (must be non-zero)"
node scripts/verify-client.mjs --exe package.json --server;      echo "exit=$? (must be non-zero)"
node scripts/verify-integration.mjs --scenario;                  echo "exit=$? (must be non-zero)"
node scripts/verify-integration.mjs --server-exe;                echo "exit=$? (must be non-zero)"
node scripts/verify-integration.mjs --client-exe;                echo "exit=$? (must be non-zero)"
node scripts/verify-integration.mjs --cdp-port;                  echo "exit=$? (must be non-zero)"

# [2] 플래그형 값 — 다음 플래그가 값으로 먹히지 않는다
node scripts/dist-server.mjs --out --skip-web;                   echo "exit=$? (must be non-zero)"
node scripts/verify-integration.mjs --scenario --show;           echo "exit=$? (must be non-zero)"

# [3] 정상 파싱 회귀 — 값이 그대로 전달돼 "다음" 가드에서 걸려야 한다
#     (기대 출력: outDir가 dist/ 하위가 아니라는 가드 메시지. 인자 가드 메시지가 아니다)
node scripts/dist-server.mjs --out C:/tmp/not-under-dist;        echo "exit=$? (must be non-zero)"
node scripts/verify-server-exe.mjs --exe C:/tmp/no-such-file;    echo "exit=$? (must be non-zero)"

# [4] diff scope — 시작 시점 스냅샷 대비 증분만 있어야 한다
git status --porcelain
```

`node --test test/cli-args.test.js`가 red → green 순서를 거쳤음을 요약에 남긴다(구현 먼저 금지).

## 검증 절차

1. 위 AC를 전부 실행한다. `[1]`·`[2]`는 **exit code와 메시지**를 함께 확인한다(메시지에 문제 플래그 이름이 들어 있어야 한다).
2. `[3]`의 두 커맨드가 인자 가드가 아니라 **그 다음 단계 가드**에서 죽는지 확인한다 — 정상 값이 소실되지 않았다는 증거다.
3. **변이 검증 3종**(각각 red 확인 후 원복): (a) `missing` 판정 제거 → 해당 케이스 red, (b) `empty` 판정 제거 → red, (c) `flag-like` 판정 제거 → red.
4. `git status --porcelain` 증분이 소유 파일(`scripts/lib/cliArgs.mjs`·`test/cli-args.test.js`·6개 CLI·`phases/64-exe-backlog/index.json`)뿐인지 확인한다.
5. 아키텍처 체크리스트: `package.json` dependencies/devDependencies 불변 · `web/**`·`src/**`·`server/**`·`client/**`·`docs/**`·`packaging/**` 무수정 · 각 CLI에서 parseArgs **밖** 코드 무수정(`git diff`로 확인) · DB 무접촉(이 step은 DB·exe·빌드를 실행하지 않는다).
6. `phases/64-exe-backlog/index.json`의 step0 status를 갱신한다. 중간 실패 시 산출물을 지우지 말고 진행 지점을 error_message에 남겨라.

## 금지사항

- `scripts/lib/cliArgs.mjs`에 `process.exit`·`console`·stderr 출력을 넣지 마라. 이유: 순수해야 node:test로 잠글 수 있고, CLI마다 종료 규약(die vs stderr+exit)이 달라 헬퍼가 그것을 대신 결정하면 6개 스크립트의 출력이 제각각 바뀐다.
- `verify-*.mjs`끼리 서로 import하지 마라. 이유: 두 파일 모두 import 즉시 `main()`이 실행되는 CLI다(phase 63 forward_notes (e)).
- parseArgs 밖의 로직(빌드 절차·프로브·정리·요약 출력)을 이 step에서 건드리지 마라. 이유: 그 파일들은 step1·step2가 다른 항목으로 소유한다 — 겹치면 실패 원인을 분리할 수 없다.
- 새 플래그를 추가하거나 기본값·USAGE 문구를 재작성하지 마라. 이유: 이번 변경은 "값 누락을 조용히 넘기지 않는다" 하나이며, 사용법이 바뀌면 phase 61~63의 AC 커맨드가 전부 재검증 대상이 된다.
- `-`(한 글자) 접두 값을 전부 거부하지 마라. 이유: 음수·상대 표기 같은 정당한 값을 막아 새로운 오거부를 만든다.
- eslint 설정(`eslint.config.js`)을 고쳐 `scripts/**`를 검사 대상에 넣지 마라. 이유: 6개 스크립트가 동시에 흔들리고, 이 phase의 실패 격리가 무너진다(excluded (f)).
