# Step 0: meta-taxonomy — 지역/내용/속성 택소노미 데이터 모듈 + 토큰 헬퍼

## 배경 / 요구사항

phase 32는 공통정보의 **지역·내용·속성**을 자유 입력에서 **팝업 선택**으로 바꾼다(news.md L63~65). 이 step은 그 팝업이 보여줄 **택소노미 데이터**와 값(콤마 문자열) **파싱/조인 헬퍼**를 담은 순수 클라이언트 모듈 `web/src/view/metaTaxonomy.js`를 신설한다.

- **순수 데이터 + 순수 함수만.** 컴포넌트/JSX/model/fetch/window/document 없음. `simpTradTable.js`(번들 정적 데이터, 의존성 0)와 동일한 위상이다.
- 이 step에는 **UI도 결선도 없다.** 데이터 구조와 헬퍼를 자기완결 TDD로 고정한다. 팝업(MetaSelectDialog)은 step 2, CommonInfo 결선은 step 3이 소비한다.
- **데이터 출처는 `docs/Meta.md` 원문이다.** 항목 표기를 **그대로 옮긴다**(전사/transcription). 오타처럼 보여도 임의로 고치지 마라(아래 '핵심 규칙 4' 참조).

### 배경 지식 — 왜 '내용' 필드가 새로 필요한가
Meta.md의 '내용'은 본문(에디터 좌측)이 아니라 **분류 택소노미**다(정치/경제 → 하위그룹 → 항목). 기존 코드/주석(예: WriterPage.jsx L1230 "본문(내용)은 좌측 에디터가 담당")은 구스펙 해석이다. 이 phase에서 '내용'은 지역/속성과 동급의 **분류 선택 필드**이며, 그 필드 키는 **`category`**로 확정돼 있다(dto/DB의 기존 `content`는 본문 컬럼이라 재사용 불가 — step 1/3에서 다룸). 이 step은 데이터만 만들므로 키 이름과 무관하지만, 배경으로 알아 둔다.

## 읽어야 할 파일

- `/CLAUDE.md`(UTF-8·TDD·DB 비파괴), `/docs/ARCHITECTURE.md`(프론트 MVC — view 순수성), `/docs/ADR.md`(ADR-003).
- `/docs/Meta.md` — **전사 원본**. 지역(국내/세계/북한 3분류 → 하위그룹 → 항목), 내용(정치/경제 → 하위그룹 → 항목), 속성(플랫 목록). **이 파일의 모든 항목이 정확히 한 번씩 선택 가능한 leaf로 데이터에 들어가야 한다.**
- `/docs/news.md` — L63~65(공통정보 팝업: 지역·내용 5개 이내, 속성 3개), L49(공통정보 입력 항목에 '내용' 포함).
- `web/src/view/simpTradTable.js` — **모듈 위상/컨벤션 템플릿**. 상단 주석으로 데이터 출처·불완전성·전사 원칙을 명시하고 `export const ...`로 배열을 내보내는 패턴. 이 파일을 그대로 흉내 낸다(순수 데이터 + 파생 헬퍼는 소비 측이 아니라 여기서 export).
- `web/src/view/simpTradConvert.js`(있으면 참고) — simpTradTable 배열을 Map 등으로 가공하는 순수 헬퍼 패턴(이 step의 파싱/조인 헬퍼와 동형).

## 작업

TDD로 진행한다(vitest). **헬퍼(파싱/조인) → 상수 → 데이터 무결성** 순으로 각 단위마다 테스트를 먼저 쓴다. 새 파일 `web/src/view/metaTaxonomy.js` + `web/src/view/metaTaxonomy.test.js`.

### (1) 토큰 파싱/조인 헬퍼 (순수 함수)

기존 지역/속성 필드는 자유 입력 콤마 문자열이었다. 팝업은 그 문자열을 토큰 배열로 풀고 다시 조립해야 한다. 관대한 파싱(기존 자유입력 호환):

- `export function parseTokens(value)` — 콤마로 split, 각 토큰 trim, 빈 문자열 제거 → `string[]`. `value`가 `''`/`null`/`undefined`면 `[]`. **중복은 제거하지 않는다**(원본 보존 — 중복 처리는 소비 측 책임). 예: `'서울, 대전 ,'` → `['서울','대전']`.
- `export function joinTokens(tokens)` — `tokens.join(', ')`(구분자 `', '`). 빈 배열 → `''`.
- `parseTokens`/`joinTokens`는 **역이 아니어도 된다**(공백 정규화가 일어남) — 라운드트립 시 토큰 값이 보존되면 충분하다.

> ⚠️ 속성 항목에는 공백이 들어간 토큰이 있다(`PR Newswire`, `N.K Photo`, `Web Service`, `연합뉴스영상` 등). 지역에도 공백 토큰이 있다(`봉화 상주` 등). 그래서 파싱은 **콤마 기준이며 공백으로 쪼개지 않는다** — 공백은 토큰 내부 문자다. 이 불변식을 테스트로 고정하라.

### (2) 한도 상수

```js
export const REGION_MAX = 5;    // 지역 5개 이내(news.md L65)
export const CATEGORY_MAX = 5;  // 내용 5개 이내(news.md L65)
export const ATTRIBUTE_MAX = 3; // 속성 3개(news.md L65)
```

### (3) 택소노미 데이터 (Meta.md 전사)

세 상수를 export한다. **그룹 구조**는 `{ label: string, items: string[] }[]`(그룹 헤더 + 선택 대상 leaf들):

- `export const REGION_GROUPS` — Meta.md '지역'. 각 하위그룹(괄호로 묶인 것)이 한 그룹이 된다. 예: `{ label: '광역시', items: ['광주','대구','대전','부산','울산','인천'] }`, `{ label: '아시아', items: ['아시아','네팔', ... '동북아'] }`, `{ label: '평양직할시', items: ['평양'] }`.
  - 괄호 없는 낱개 항목(국내지역의 `전국종합`)은 자기 자신을 라벨/유일 항목으로 갖는 그룹으로 둔다: `{ label: '전국종합', items: ['전국종합'] }`.
  - 3분류(국내/세계/북한)를 섹션으로 노출할지는 **구현 재량**이다(선택적 `section` 필드를 그룹에 추가해도 되고, 그룹 라벨만으로 충분하면 생략). **필수 불변식은 하나**: Meta.md의 모든 지역 항목이 정확히 한 번씩 leaf로 존재하고 표기가 원문과 일치한다.
- `export const CATEGORY_GROUPS` — Meta.md '내용'. 정치(하위그룹: 정치일반/청와대/국회/정당/선거) + 경제(하위그룹: 경제일반). 예: `{ label: '국회', items: ['국회일반','상임이ㅜ','국감','청문회','국정조사','입법','개헌','특검'] }`. (정치/경제 상위 분류의 섹션 노출도 위와 동일하게 구현 재량.)
- `export const ATTRIBUTES` — Meta.md '속성'의 **플랫 문자열 배열**(그룹 없음). `게시판`부터 `포털제외`까지 순서대로 전부.

### (4) 필드 설정 헬퍼 (팝업이 소비할 단일 진입점)

팝업(step 2)과 결선(step 3)이 필드 키만으로 제목/그룹/한도를 얻도록:

```js
// field ∈ 'region' | 'category' | 'attribute'
export function metaFieldConfig(field) // → { title, groups, limit } | null(미지원 키)
```

- `'region'` → `{ title: '지역', groups: REGION_GROUPS, limit: REGION_MAX }`
- `'category'` → `{ title: '내용', groups: CATEGORY_GROUPS, limit: CATEGORY_MAX }`
- `'attribute'` → `{ title: '속성', groups: [{ label: '속성', items: ATTRIBUTES }], limit: ATTRIBUTE_MAX }`
  - **속성은 플랫이지만 그룹 인터페이스로 감싸 반환한다**(단일 그룹). 팝업이 지역/내용/속성을 한 가지 렌더 경로로 다루게 하기 위함이다.
- 그 외 키 → `null`.

### (5) 데이터 무결성 테스트 (전사 회귀 잠금)

전사 실수를 잡는 테스트를 쓴다(값 하나하나를 다 단언할 필요는 없지만 아래 구조 불변식은 고정):

- 각 그룹의 `items`는 비어 있지 않고 모두 문자열이며 trim된 비공백이다.
- `REGION_GROUPS`/`CATEGORY_GROUPS`의 전체 leaf 개수와 몇몇 대표 항목(예: 지역 `전국종합`·`서울`·`평양`·`봉화 상주`, 내용 `대통령`·`경제일반`, 속성 `게시판`·`포털제외`·`PR Newswire`)이 포함되는지 단언(스팟 체크).
- `metaFieldConfig('attribute').groups[0].items.length === ATTRIBUTES.length`, `metaFieldConfig('zzz') === null`.
- 콤마 누락 의심 토큰(아래)이 **공백 포함 단일 토큰**으로 보존되는지 단언(예: `REGION_GROUPS`에서 `'봉화 상주'`를 leaf로 찾을 수 있고, `'봉화'`·`'상주'`는 별도 leaf가 아니다).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수 모듈**: `metaTaxonomy.js`는 데이터 + 순수 함수만. import는 없어야 정상(다른 view 파일·model·React 미참조). 이유: 번들 정적 데이터(ADR-003 view 순수성) — simpTradTable와 동일 위상.
2. **콤마 기준 파싱**: `parseTokens`는 콤마로만 쪼갠다. 공백으로 쪼개지 마라. 이유: 속성/지역에 공백 포함 토큰(`PR Newswire`, `봉화 상주`)이 있어 공백 split은 데이터를 파손한다.
3. **전 항목 1회 등장**: Meta.md의 모든 지역·내용·속성 항목이 정확히 한 번씩 leaf로 존재한다. 누락·중복 금지. 이유: 팝업 선택지가 스펙과 1:1이어야 한다.
4. **원문 표기 보존(정정 금지)**: `상임이ㅜ`(내용>국회), `항남`(북한>함경남도), `봉화 상주`·`영양 영주`·`칠곡 포항`(경북), `라오스 마카오`(아시아), `이집트 잠비아`(아프리카) 등 오타/콤마누락처럼 보이는 토큰도 **Meta.md 원문 그대로** 옮긴다. 임의 교정·분리 금지. 이유: 원문이 진실 공급원이며, 추측 교정은 스펙과 어긋난 데이터를 만든다(교정이 필요하면 별도 스펙 변경 절차로).
5. **한도 상수 단일 출처**: `REGION_MAX=5`/`CATEGORY_MAX=5`/`ATTRIBUTE_MAX=3`은 여기서만 정의하고 소비 측(step 2/3)이 import한다. 매직넘버 복붙 금지. 이유: news.md L65 한도의 단일 출처.

## Acceptance Criteria

```bash
npm run test:web -- metaTaxonomy    # 신규 데이터/헬퍼 테스트 통과(vitest 파일 필터)
npm run test:web                    # web 전체 회귀 통과(기존 테스트 무영향)
npm run build
npm run lint
```

추가 단언(vitest, `metaTaxonomy.test.js`):
- `parseTokens('서울, 대전 ,')` → `['서울','대전']`; `parseTokens('')`/`parseTokens(null)` → `[]`; `parseTokens('PR Newswire, 게시판')` → `['PR Newswire','게시판']`(공백 토큰 보존).
- `joinTokens(['서울','대전'])` → `'서울, 대전'`; `joinTokens([])` → `''`.
- `metaFieldConfig('region').limit === 5`, `.title === '지역'`; `metaFieldConfig('category').title === '내용'`; `metaFieldConfig('attribute').limit === 3` 이고 `.groups.length === 1`; `metaFieldConfig('bad') === null`.
- 무결성/스팟 체크(위 (5)).

## 검증 절차

1. 위 AC 커맨드 실행(한글 깨지면 UTF-8 로케일 확인).
2. 아키텍처 체크리스트:
   - `metaTaxonomy.js`가 React/model/fetch/window/document를 import/참조하지 않음(`grep` 확인).
   - Meta.md 하위그룹 개수와 데이터 그룹 개수 대조(지역·내용), 속성 개수 대조.
   - 콤마 누락 의심 토큰이 단일 토큰으로 존재.
3. 결과에 따라 `phases/32-meta-popups/index.json`의 step 0을 갱신(completed+summary / error / blocked).

## 금지사항

- 컴포넌트/JSX/model/fetch/window/document를 이 모듈에 넣지 마라. 이유: 순수 데이터 모듈(ADR-003) — UI는 step 2.
- Meta.md 항목을 임의로 교정/분리/병합/누락하지 마라(특히 '핵심 규칙 4'의 의심 토큰). 이유: 원문이 진실 공급원 — 추측 교정은 데이터 오염.
- 공백으로 토큰을 쪼개지 마라. 이유: 공백 포함 토큰 파손.
- MetaSelectDialog/CommonInfo/WriterPage/스키마/서버를 이 step에서 건드리지 마라. 이유: Scope 최소화 — 결선은 step 2·3, 백엔드는 step 1.
- 한도(5/5/3)를 소비 측에 하드코딩하지 마라. 이유: 단일 출처 위반.
