# Step 4: detail-category — 상세보기 '내용'(category) 행 + 회귀

## 배경 / 요구사항

상세보기(새 창)는 공통정보를 가로로 나열한다(news.md L108~111). '내용'이 그 목록에 포함된다(L109). 현재 `articleDetail.js`의 `DETAIL_COMMON_FIELDS`는 '내용' 라벨을 **구스펙 키 `content`(본문 컬럼)** 에 매핑한다(L20). 이 step은 그 행이 **신설 분류 필드 `category`** 를 읽도록 바꾸고 회귀를 잠근다.

- 상세보기는 편집 로드와 같은 조회 경로(`getById` → `SELECT * FROM Contents`)로 채워지므로, step 1에서 `category` 컬럼을 추가하면 조회 응답에 `category`가 **자동 포함**된다(상세용 별도 로드 작업 불필요). 이 step은 **표시 매핑 한 줄 교체 + 테스트**만.
- 이 step은 `articleDetail.js`(상세/발행 렌더)만 만진다. 팝업/CommonInfo/백엔드는 접촉 금지(step 1~3 담당).

### 왜 `content` → `category` 교체가 안전한가
`content`(Contents.content)는 **미사용 컬럼**이다 — 본문은 `markupVersion`에 저장하고, 수집 서비스도 "평문 content 컬럼 미사용"을 명시한다(`collectionService.js` L18). 상세보기 하단은 이미 `markupVersion` 블록으로 본문을 보여준다(L65·L199~206). 따라서 상단 '내용' 행이 `content`를 읽어 봐야 항상 비어('—') 있거나 본문과 중복이다. 신스펙에서 '내용'은 **분류(category)** 이므로 이 행을 `category`로 돌리는 것이 정확하다(값 손실 없음 — content는 실데이터가 아니다).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/news.md` L108~112(상세보기: 공통정보 가로 나열·빈 필드 '—'·HTML 이스케이프), L109('내용' 포함), L49(공통정보 '내용').
- `web/src/view/articleDetail.js`:
  - `DETAIL_COMMON_FIELDS`(L17~30) — **교체 지점**. 현재 L20 `{ key: 'content', label: '내용' }`. 순서상 `coAuthor`(공동작성)와 `region`(지역) 사이 = news.md L109 순서와 일치 → **키만 `category`로 바꾼다**(라벨 `내용` 유지, 위치 유지).
  - `buildDetail`(L56~68) — `DETAIL_COMMON_FIELDS`를 순회하며 `article[key]`를 `fieldValue`(빈 값 '—', L41~43)로 매핑. category도 이 경로를 그대로 탄다(추가 로직 불필요).
  - `renderDetailHtml`(L185~217) — common을 이스케이프해 `<dl>`로 렌더(L188~197). category 값도 `escapeHtml`로 이스케이프됨(자동).
- `web/src/view/articleDetail.test.js` — 데이터 구성/이스케이프/길이 단언(L7~27). **길이 단언 L14** `common.toHaveLength(DETAIL_COMMON_FIELDS.length)`는 키 교체로 안 깨진다(개수 동일). '내용'=category 표시 단언을 여기 추가.
- `web/src/view/ListPage.jsx` L32~44 — 상세보기 호출부(`renderDetailHtml(full, ...)`, `full`=조회로 채운 전체 기사). 참고만(변경 없음).

## 작업

TDD로 진행한다(vitest). `articleDetail.test.js`에 단언을 먼저 추가(레드) 후 매핑 교체(그린).

### (1) 테스트 (articleDetail.test.js)

- `buildDetail({ category: '정치일반' })`의 `common`에서 `key==='category'` 항목을 찾아 `label==='내용'`, `value==='정치일반'` 단언.
- `buildDetail({})`(category 없음) → 해당 행 `value==='—'`(EMPTY_FIELD).
- `renderDetailHtml({ category: '<script>alert(1)</script>' })` → 원본 `<script>` 미포함, `&lt;script&gt;` 포함(이스케이프 회귀 — 기존 컨벤션 L34~46).
- 더 이상 `content` 키가 '내용' 행이 아님을 (원한다면) 단언: `common.find(f=>f.key==='content')`가 없음.

### (2) 매핑 교체 (articleDetail.js)

- `DETAIL_COMMON_FIELDS` L20을 `{ key: 'category', label: '내용' }`로 교체(위치·라벨 유지, 키만 변경). 다른 항목·순서·`buildDetail`/`renderDetailHtml` 로직은 불변.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **키만 교체**: L20의 `content` → `category`. 라벨 `내용`·목록 위치(공동작성과 지역 사이)·나머지 항목 순서 유지. 이유: news.md L109 가로 나열 순서 보존 + 신스펙 분류 필드 표시.
2. **이스케이프 유지**: category 값도 `escapeHtml` 경로로만 렌더(기존 `renderDetailHtml`이 처리 — 별도 작업 없음, 회귀 단언으로 잠금). 이유: 상세/발행 HTML은 XSS 싱크(news.md L112) — 모든 사용자 값 이스케이프.
3. **범위 최소**: `articleDetail.js` + 그 테스트만. 백엔드·팝업·CommonInfo·본문 렌더 분기(`embedHtml`) 미접촉. 이유: Scope 최소화 — 다른 계층은 step 1~3.

## Acceptance Criteria

```bash
npm run test:web -- articleDetail   # 상세 '내용'=category 표시 + 이스케이프 회귀 통과
npm run test:web                    # web 전체 회귀 통과(길이 단언 등 무영향)
npm run build
npm run lint
```

추가 단언(vitest, `articleDetail.test.js`):
- `buildDetail({ category:'정치일반' })` → `key==='category'` 행 `label==='내용'`·`value==='정치일반'`.
- category 미제공 → 해당 행 `value==='—'`.
- `renderDetailHtml({ category:'<script>alert(1)</script>' })` → 원본 `<script>` 미포함, `&lt;script&gt;` 포함.

## 검증 절차

1. 위 AC 커맨드 실행(한글 깨지면 UTF-8 로케일 확인).
2. 아키텍처 체크리스트:
   - `DETAIL_COMMON_FIELDS`에 `{ key:'category', label:'내용' }` 존재, `content`→'내용' 매핑 제거.
   - 이스케이프 회귀 green.
   - 백엔드/팝업/CommonInfo/본문 렌더 분기 무변경(`git status` 확인).
3. 결과에 따라 `phases/32-meta-popups/index.json`의 step 4를 갱신.

## 금지사항

- '내용' 행 라벨을 바꾸거나 목록 위치·다른 항목 순서를 바꾸지 마라. 이유: news.md L109 나열 순서/명칭 보존.
- category 값을 이스케이프 없이 HTML에 넣지 마라. 이유: 상세/발행 XSS 싱크.
- `content` 행을 category 행과 **함께** 남겨 '내용'을 중복 표시하지 마라. 이유: content는 미사용/본문 중복 — 단일 '내용'=category 행만.
- 백엔드·팝업·CommonInfo·`embedHtml`(임베드 렌더)을 이 step에서 건드리지 마라. 이유: Scope 최소화.
