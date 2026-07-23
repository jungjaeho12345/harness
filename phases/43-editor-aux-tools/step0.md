# Step 0: common-abbrevs

공용약어(언론 관용 약어) 번들 정적 목록을 정의하고, 도구>약어변환(수동)이 **사용자 약어 + 공용약어**를 병합해 확장하도록 결선한다. 환경설정 `edit.noCommonAbbr=true`면 공용약어를 제외한다.

## 읽어야 할 파일

먼저 아래를 읽고 기존 약어 엔진·병합 지점·설정 소비 관례를 파악하라:

- `/docs/news.md` L177(도구 메뉴 약어변환·약어관리), L189-195(환경설정 편집 탭 "공용약어 사용안함")
- `/docs/ARCHITECTURE.md`, `/docs/ADR.md` (프론트 Model←Controller←View, 순수 모듈 규칙)
- `web/src/view/abbrevConvert.js` — `expandAbbrev(text, pairs)` / `expandAbbrevInBlocks(blocks, pairs)`. 단어경계(`\p{L}\p{N}_`)·최장일치·단일 좌→우 스캔·재확장 금지·임베드/"(끝)" 불변. **이 엔진은 손대지 마라** — 공용약어는 pairs 배열을 concat해 넘기기만 한다.
- `web/src/view/simpTradTable.js` — 번들 정적 데이터 파일의 형식·주석 스타일 선례(참고용, 형식만).
- `web/src/view/WriterPage.jsx`:
  - `const [abbrevs, setAbbrevs] = useState(() => loadAbbrevs());` (~181행) — 사용자 약어 세션 state.
  - `convertAbbrev` (~510행): `const r = expandAbbrevInBlocks(blocks, abbrevs); if (!r.changed) return; commitBody(serialize(r.blocks));` — 도구>약어변환 핸들러. **여기만 바꾼다.**
  - `insertDate` (~478행): `const fmt = loadEditorPrefs().dateFormat;` — 액션 시점에 `loadEditorPrefs()`를 읽는 관례(동형으로 `noCommonAbbr`를 읽는다).
- `web/src/view/editorPrefs.js` — `loadEditorPrefs().edit.noCommonAbbr`(기본 `false`)는 이미 존재·영속됨. **prefs 모듈은 손대지 마라.**
- `web/src/view/abbrevStore.js` — 사용자 약어 정규화 형식(`{ short, long }[]`) 참고.

## 작업

### 1. `web/src/view/commonAbbrevs.js` (신규, 순수 데이터 + 순수 병합 헬퍼)

- DOM/window/React/localStorage/transport 비의존. 파일 상단 주석에 데이터 성격(번들 정적·오프라인·미등록은 미확장)을 남긴다.
- `export const COMMON_ABBREVS = Object.freeze([ ... ])` — 언론 관용 약어(정부부처·기관·국제기구 등) **최소 30개 이상**. 각 원소는 `{ short, long }`(둘 다 비어 있지 않은 문자열). 예시(그대로 포함, 확장 가능):
  - `{ short: '기재부', long: '기획재정부' }`, `{ short: '국토부', long: '국토교통부' }`, `{ short: '외교부', long: '외교부' }`는 넣지 말 것(축약 아님) — short와 long이 실제로 다른 항목만 넣는다.
  - `{ short: '한전', long: '한국전력공사' }`, `{ short: '전경련', long: '전국경제인연합회' }`, `{ short: 'IMF', long: '국제통화기금' }`, `{ short: 'WHO', long: '세계보건기구' }`, `{ short: 'WTO', long: '세계무역기구' }`.
  - **AC 고정 쌍(반드시 포함, 테스트가 이 값을 검증한다)**: `{ short: '기재부', long: '기획재정부' }`, `{ short: '한전', long: '한국전력공사' }`, `{ short: 'WHO', long: '세계보건기구' }`.
- `export function mergeAbbrevs(userAbbrevs, { includeCommon = true } = {})` — 순수 함수. 반환 규칙:
  - `includeCommon === false`이면 사용자 약어만 정규화해 반환(공용약어 미포함).
  - `includeCommon === true`이면 **사용자 약어를 먼저**, 그 뒤에 공용약어 중 **사용자에 이미 있는 short를 제외**한 것을 붙여 반환(같은 short는 사용자 우선 — dedupe는 short 기준, 사용자 승리).
  - 입력 mutate 금지(새 배열/새 객체). `userAbbrevs`가 배열 아님/빈 값이어도 죽지 않는다(방어). 각 원소는 `{ short: String, long: String }`로 정규화.

### 2. `web/src/view/WriterPage.jsx` — `convertAbbrev` 결선(이 함수 본문만 변경)

- 액션 시점에 `loadEditorPrefs().edit.noCommonAbbr`를 읽어 `includeCommon`을 결정하고, `mergeAbbrevs(abbrevs, { includeCommon: !noCommonAbbr })`의 결과를 `expandAbbrevInBlocks(blocks, mergedPairs)`에 넘긴다. 나머지(`if (!r.changed) return; commitBody(serialize(r.blocks));`)는 그대로 유지.
- `commonAbbrevs.js`의 `mergeAbbrevs`(및 필요 시 `COMMON_ABBREVS`)만 import 추가한다.

## 반드시 지킬 핵심 규칙

- **엔진 불변**: `expandAbbrev`/`expandAbbrevInBlocks`의 단어경계·최장일치·재확장 금지 의미론을 바꾸지 마라. 이유: 다른 소비처(있다면)와 기존 1753개 web 테스트가 이 계약에 의존한다. 공용약어는 순수하게 pairs 병합으로만 주입한다.
- **약어관리 다이얼로그 불변**: 약어관리(도구>약어관리) 다이얼로그는 **사용자 약어 전용**이다. 공용약어를 그 목록에 노출하지 마라. 이유: 사용자 결정 1 — 공용약어는 변환에만 병합 적용하고 관리 UI에는 표시하지 않는다.
- **자동 키인터셉트 없음**: 타이핑 중 공용약어를 자동 확장하지 마라. 이유: 약어변환은 명시적 수동 액션(도구>약어변환)이다.
- **설정은 액션 시점 읽기**: `noCommonAbbr` 소비에 `useState`+마운트 effect(3점 게이트)를 만들지 마라. 이유: 이 설정은 지속 시각 효과가 없고 변환 액션 순간에만 필요하다 — `insertDate`가 `dateFormat`을 액션 시점에 읽는 것과 동형. 게이트는 죽은 코드이며 stale 위험만 늘린다.

## Acceptance Criteria

```bash
npm run lint          # ESLint 통과
npm run build         # 빌드 에러 없음
npm run test:web      # vitest 통과(기존 1753 + 신규). 회귀 0.
```
- 백엔드는 web-only 변경이라 무영향 — 참고로 `npm run test`(백엔드 427)도 그대로 초록이어야 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 신규 테스트(작성): `web/src/view/commonAbbrevs.test.js`
   - `COMMON_ABBREVS`가 30개 이상이고 모든 원소가 비어 있지 않은 `{short,long}`이다.
   - AC 고정 쌍(기재부→기획재정부, 한전→한국전력공사, WHO→세계보건기구)이 존재한다.
   - `mergeAbbrevs([], {})`가 공용약어를 포함한다; `mergeAbbrevs([], {includeCommon:false})`는 빈 배열.
   - dedupe: 사용자에 `{short:'한전', long:'우리회사'}`가 있으면 병합 결과에서 short '한전'은 사용자 값('우리회사')만 남고 공용값('한국전력공사')은 제외된다(사용자 우선).
   - `expandAbbrevInBlocks([textBlock('WHO 발표')], mergeAbbrevs([], {}))`가 '세계보건기구 발표'로 확장된다(엔진 통합 확인).
3. WriterPage 통합(기존 약어 테스트 파일에 보강 또는 신규): `noCommonAbbr=true`로 설정 후 도구>약어변환 실행 시 공용약어는 확장되지 않고, 사용자 약어만 확장된다.
4. 아키텍처 체크: 순수 모듈(commonAbbrevs.js)에 DOM/React/localStorage 의존 없음. WriterPage 변경은 `convertAbbrev` 본문·import에 국한.
5. 결과에 따라 `phases/43-editor-aux-tools/index.json`의 step 0을 갱신한다(completed+summary / error / blocked).

## 금지사항

- `abbrevConvert.js`(엔진)를 수정하지 마라. 이유: 계약 변경은 회귀 위험이며 이번 scope는 데이터 병합뿐이다.
- 공용약어를 약어관리 다이얼로그·약어 store(localStorage)에 쓰지 마라. 이유: 공용약어는 번들 정적이며 사용자 약어와 저장소를 섞으면 CRUD가 오염된다.
- `noCommonAbbr` 소비에 마운트 effect/구독을 추가하지 마라. 이유: 액션 시점 읽기로 충분하며 게이트는 죽은 코드다.
- 기존 테스트를 깨뜨리지 마라(web 1753 기준).
