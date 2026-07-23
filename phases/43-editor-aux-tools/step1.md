# Step 1: company-code-engine

기업코드 변환의 **순수 엔진**을 만든다: 번들 정적 종목표(`companyCodeTable.js`) + 변환 모듈(`companyCodeConvert.js`). 형식은 `종목명 → 종목명(코드)`. **재실행 멱등성**(이미 `종목명(코드)`면 다시 감싸지 않음)이 이 step의 핵심이다. 이 step은 순수 계산만 — WriterPage/DOM 결선은 하지 않는다.

## 읽어야 할 파일

- `/docs/news.md` L178(우클릭 "기업코드변환 Ctrl+B"), L194-195(환경설정 "기업코드: 수동/자동 기업코드 변환 — 주식종목기업코드이다").
- `/docs/ADR.md` — 순수 모듈·의존성 0 규칙.
- `web/src/view/simpTradTable.js` — 번들 정적 데이터 파일 형식/주석 선례.
- `web/src/view/simpTradConvert.js` — **엔진 형태의 직접적 선례**. `convertSimpTrad(text, direction)` + `convertSimpTradInBlocks(blocks, direction)` → `{ blocks, changed }`. 텍스트 블록만 변환, 임베드·"(끝)" 불변, 입력 mutate 금지. `companyCodeConvert.js`는 이 구조를 그대로 따르되 **문자단위 map 치환이 아니라 최장일치 다중문자 스캔 + 멱등 lookahead**를 쓴다.
- `web/src/view/editorContent.js` — `textBlock`, `isTextBlock`, `normalizeBlocks`, `END_MARKER`.
- `web/src/view/abbrevConvert.js` — 최장일치·좌→우 단일 스캔·재확장 금지(anti-cascade: `out += long; i = j;`) 로직 참고. 이 step의 스캐너는 이 패턴을 확장한다.

## 작업

### 1. `web/src/view/companyCodeTable.js` (신규, 번들 정적 데이터)

- DOM/window/React/localStorage/transport 비의존. 상단 주석: 번들 정적·오프라인·미등록 종목은 미변환(안전측 pass-through), 종목명은 최장일치 우선.
- `export const COMPANY_CODES = Object.freeze([ ... ])` — KOSPI/KOSDAQ 주요 상장사 **100개 이상**(가능하면 100~200). 각 원소는 `{ name, code }`. `code`는 6자리 숫자 문자열(예: `'005930'`). `name`은 종목명 문자열.
- **AC 고정 쌍(반드시 포함, 테스트가 검증)**: 삼성전자=`005930`, SK하이닉스=`000660`, NAVER=`035420`, 카카오=`035720`, 현대차=`005380`, LG에너지솔루션=`373220`, 셀트리온=`068270`, 삼성바이오로직스=`207940`.
- 중복 `name`은 넣지 않는다(같은 종목명 1개). 종목명이 다른 종목명의 접두인 경우(예: 삼성전자 vs 삼성전자우)가 있으면 둘 다 넣어도 된다 — 엔진이 최장일치로 처리한다.

### 2. `web/src/view/companyCodeConvert.js` (신규, 순수 엔진)

- 모듈 로드 시 1회 `name → code` Map을 만든다(매 호출 재구성 금지). 종목명 최장일치를 위해 스캔에서 후보를 `name.length` 내림차순으로 시도한다.
- `export function convertCompanyCode(text)` — 문자열을 좌→우로 한 번 스캔하며 종목명을 만나면 `종목명(코드)`로 치환한 새 문자열을 반환. 시그니처 수준 규칙:
  - **최장일치 우선**: 현재 위치에서 매칭되는 종목명 중 가장 긴 것을 택한다.
  - **멱등 lookahead (핵심)**: 위치 `i`에서 종목명 `name`이 매칭됐을 때, **바로 뒤가 이미 `(` + 그 종목의 `code` + `)` 이면 치환하지 않는다** — `name`을 그대로 출력하고 `i`를 `name.length`만큼만 전진시킨다. 이유: 재실행(자동 모드가 이미 변환된 본문을 다시 변환) 시 `삼성전자(005930)` → `삼성전자(005930)(005930)`로 이중 감싸지는 것을 막는다.
  - **anti-cascade**: 치환 시 `out += name + '(' + code + ')'` 후 `i += name.length`만(주입한 `(코드)`는 재스캔하지 않는다 — SRC를 스캔하므로 원문 뒷부분에서 이어간다).
  - **미등록/미매칭**: 종목명이 없으면 그 문자를 그대로 출력하고 1 전진(pass-through). 미등록 종목은 변환하지 않는다(안전측).
  - 단어경계 요건은 두지 않는다(뉴스 관용상 조사 등이 붙어도 종목 언급을 태깅한다). 단, 위 lookahead·최장일치·anti-cascade는 반드시 지킨다.
- `export function convertCompanyCodeInBlocks(blocks)` — `convertSimpTradInBlocks`와 동형: `normalizeBlocks` 후 텍스트 블록(단, `trim() === END_MARKER` 제외)에만 `convertCompanyCode`를 적용, 바뀐 블록만 새 `textBlock`으로 교체, `{ blocks, changed }` 반환. 임베드·"(끝)" 불변, 입력 mutate 금지.

## 반드시 지킬 핵심 규칙

- **멱등성**: `convertCompanyCode(convertCompanyCode(x)) === convertCompanyCode(x)`. 두 번째 `convertCompanyCodeInBlocks` 실행은 `changed:false`여야 한다. 이유: 자동 모드가 저장·송고마다 변환하는데, 이미 태깅된 본문을 재변환하면 코드가 중복 삽입돼 본문이 파손된다. 이건 TDD 필수 테스트다.
- **anti-cascade**: 주입한 `(코드)`를 같은 패스에서 재스캔하지 마라. 이유: 무한/중복 확장 방지.
- **의존성 0·순수**: DOM/window/React/localStorage/transport/fetch 금지. 이유: simpTradConvert와 동일한 오프라인 순수 엔진 계약.
- **미등록 pass-through**: 표에 없는 종목명은 절대 임의 변환하지 마라. 이유: 오변환이 미변환보다 위험(안전측).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 신규 테스트(작성): `web/src/view/companyCodeTable.test.js`, `web/src/view/companyCodeConvert.test.js`
   - 표: `COMPANY_CODES` 100개 이상, 모든 `code`가 `/^\d{6}$/`, AC 고정 쌍 존재, `name` 중복 없음.
   - 변환: `convertCompanyCode('삼성전자가 발표했다')` === `'삼성전자(005930)가 발표했다'`.
   - **멱등(필수)**: `convertCompanyCode('삼성전자(005930)')` === `'삼성전자(005930)'`(이중 감쌈 없음). `convertCompanyCode(convertCompanyCode('삼성전자와 카카오'))` === `convertCompanyCode('삼성전자와 카카오')`.
   - `convertCompanyCodeInBlocks`를 두 번 적용 시 2회차 `changed:false`, 블록 동일.
   - 임베드·"(끝)" 블록 불변, 미등록 종목명 pass-through.
   - 최장일치: 접두 관계 종목이 있으면 더 긴 이름이 우선 매칭됨(표에 해당 쌍이 있을 때).
3. 아키텍처 체크: 순수 모듈, 의존성 0.
4. `phases/43-editor-aux-tools/index.json`의 step 1을 갱신한다.

## 금지사항

- `expandAbbrev`를 그대로 재사용해 기업코드를 변환하지 마라. 이유: abbrev 엔진에는 멱등 lookahead가 없어 `삼성전자(005930)`의 우측 `(`(비단어문자)로 재확장돼 이중 감싸진다 — 전용 모듈에 lookahead 가드를 둬야 한다.
- WriterPage/DOM/ctx/키보드 결선을 이 step에서 하지 마라. 이유: 이 step은 순수 엔진 전용(결선은 step 2·3).
- DB/서버/네트워크 접근을 넣지 마라. 이유: 오프라인 번들 데이터 계약.
- 기존 테스트를 깨뜨리지 마라(web 1753 기준).
