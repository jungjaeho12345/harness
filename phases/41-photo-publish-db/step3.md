# Step 3: search-source — 이미지 검색 패널에 '사진DB' 소스 추가 + 재임베드

## 배경 / 요구사항

step0(백엔드 검색 API)·step1(계약 `searchPhotos`)·step2(등록)로 사진이 사진DB에 쌓인다. 이 step은 풀 루프를 닫는다 — **이미지 검색 패널에 내부 '사진DB' 소스를 추가**해 등록된 사진을 캡션으로 검색하고, 결과를 **다른 기사에 재임베드**한다(기존 검색→임베드 경로 재사용).

**이 step은 검색 소스(재임베드) 경로만** 다룬다.

### 확정된 설계 결정 (그대로 구현)

- **재임베드는 기존 이미지 임베드 경로를 그대로 재사용한다.** 검색된 사진 → `insertEmbed(makeImageEmbed(photo.src, { alt: photo.caption }))`. 이는 표준 image 임베드 블록을 만들며, **InlineEmbed/articleDetail 렌더·Editor.jsx를 전혀 바꾸지 않는다**(캡션은 이미지 alt가 되어 기존 렌더가 `isAllowedImageSrc`+`escapeHtml`로 안전 처리). 새 임베드 타입을 만들지 않는다.
- **'사진DB' 소스는 이미지 탭 내부의 additive 토글**이다(기존 이미지 탭 UX 무변경). 이미지 탭에 소스 선택 UI(Google | 사진DB)를 추가하고, 선택에 따라 검색 대상(`model.searchImages` vs `model.searchPhotos`)·결과 목록·픽 동작만 바뀐다. **5번째 메타 탭을 만들지 않는다**(스펙은 4개 탭 — 공통정보/이미지/영상/글기사).
- **`SearchPanel`(공용 프레젠테이션 컴포넌트)은 바꾸지 않는다.** 이미지 브랜치가 이미 `item.src ?? item.link`로 썸네일을 렌더하므로, 사진 결과(`{ src, caption, ... }`)도 그대로 렌더된다. 소스별로 `results`/`onSearch`/`onPick` props만 다르게 주입한다.
- **재임베드는 매핑 모드에서도 동작한다**(기존 이미지/영상/글기사 검색 픽이 이미 매핑에서 `insertEmbed`로 삽입되는 것과 동형 — 임베드 삽입은 매핑 허용). 별도 가드를 두지 않는다.
- **소스 토글 상태는 탭-로컬이 아니다**(검색 UI 선호 — 검색 결과 자체가 컨트롤러 레벨이라 탭 전환에 이월돼도 무해). 탭 전환 조정 블록에 넣지 않는다.

## 읽어야 할 파일

먼저 아래를 읽고 검색 컨트롤러·검색 패널·재임베드 안전 경로를 파악하라:

- `/docs/ADR.md` — ADR-003(주입형 Model·View←Controller←Model), ADR-005(검색은 서버 프록시).
- `/docs/news.md` L50~53(이미지/영상/글기사 탭 — 이미지=Google 검색), L165(검색 결과를 본문 커서 위치에 임베딩·엠베딩 후 결과 유지), L47(메타 탭 4개 — 5번째를 만들지 않는 근거).
- **step1 산출물**: `web/src/model/contract.js`·`httpModel.js`·`fakeModel.js`의 `searchPhotos`(응답 `{ ok, items }`, 각 item `{ id, src, caption, sourceArticleId, registeredBy, createdAt }`).
- `web/src/controller/useSearchController.js` — **결선 지점**: `searchImages`/`searchVideos`/`searchArticles`(각 `model.search*` 호출 후 `set*Results` — L13~32)와 반환 객체(L34). 여기에 `photoResults`+`searchPhotos`를 형제로 추가한다.
- `web/src/controller/useSearchController.test.jsx` — 컨트롤러 테스트 컨벤션(fakeModel 주입·검색 후 결과 상태 단언).
- `web/src/view/WriterPage.jsx` — **결선 지점**:
  - 이미지 메타 패널(L1428~1435): `metaTab === 'image'` 분기에서 `<SearchPanel kind="image" results={search.imageResults} onSearch={search.searchImages} onPick={(item) => insertEmbed(makeImageEmbed(item.src ?? item.link ?? item.url ?? '', { alt: item.title ?? '' }))} />`. 여기에 소스 토글 + 소스별 props 분기를 추가한다.
  - `insertEmbed`(L1090) — `insertEmbed(embed)`는 마지막 에디터 캐럿 줄(lastCaretRef)에 안전 삽입한다(검색패널 픽 공용 경로). 재임베드는 이걸 그대로 쓴다.
  - `makeImageEmbed`(import 이미 있음 — L1433에서 사용). `makeImageEmbed(src, { alt })`.
  - `SearchPanel` 정의(L1744~1798) — 공용 프레젠테이션(`kind`/`results`/`onSearch`/`onPick`). 이미지 브랜치는 `item.src ?? item.link`로 썸네일 렌더(L1780). **바꾸지 않는다**.
  - `useSearchController` 사용(L124, `const search = useSearchController();`).
- `web/src/view/clipboardEmbed.js` — `makeImageEmbed`(L77~88, `{ embedType:'image', src, alt, ... }`).
- `web/src/view/WriterPage.test.jsx` — 이미지 검색/픽 테스트 컨벤션(검색어 입력→검색→결과 클릭→본문에 image 임베드 삽입 단언, 예: L920·5980 근처 image 임베드 단언).

이전 step(step1)의 `searchPhotos` 계약과 이 파일들의 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD로 진행한다(`vitest`). **테스트를 먼저** 작성하고 통과하는 구현을 만든다.

### 1. 검색 컨트롤러 — `web/src/controller/useSearchController.js`
- `photoResults` 상태 추가: `const [photoResults, setPhotoResults] = useState([]);`
- `searchPhotos` 콜백 추가(`searchImages` 형제 — L13~18 패턴):
  ```js
  const searchPhotos = useCallback(async (q) => {
    const r = await model.searchPhotos(q);
    const items = (r && r.items) || [];
    setPhotoResults(items);
    return items;
  }, [model]);
  ```
- 반환 객체에 `photoResults`·`searchPhotos`를 추가한다.

### 2. 이미지 탭 소스 토글 + 재임베드 — `web/src/view/WriterPage.jsx`
- 이미지 소스 상태 추가(컴포넌트 상단 상태 선언부, `metaTab` 근처): `const [imageSource, setImageSource] = useState('google');` // 'google' | 'photoDb'
- 이미지 메타 패널(L1428~1435)을 소스 토글 + 소스별 SearchPanel로 확장한다:
  ```jsx
  {metaTab === 'image' && (
    <>
      {/* 이미지 검색 소스 토글 — Google(외부 프록시) / 사진DB(내부 등록 사진). 이미지 탭 내부 additive UI. */}
      <div className="yh-search-source" role="group" aria-label="이미지 검색 소스">
        <button type="button"
          className={`yh-tab ${imageSource === 'google' ? 'yh-tab--active' : ''}`}
          onClick={() => setImageSource('google')}>Google</button>
        <button type="button"
          className={`yh-tab ${imageSource === 'photoDb' ? 'yh-tab--active' : ''}`}
          onClick={() => setImageSource('photoDb')}>사진DB</button>
      </div>
      {imageSource === 'google' ? (
        <SearchPanel
          kind="image"
          results={search.imageResults}
          onSearch={search.searchImages}
          onPick={(item) => insertEmbed(makeImageEmbed(item.src ?? item.link ?? item.url ?? '', { alt: item.title ?? '' }))}
        />
      ) : (
        <SearchPanel
          kind="image"
          results={search.photoResults}
          onSearch={search.searchPhotos}
          onPick={(item) => insertEmbed(makeImageEmbed(item.src ?? '', { alt: item.caption ?? '' }))}
        />
      )}
    </>
  )}
  ```
  - Google 브랜치는 **기존 동작 그대로**(회귀 없음). 사진DB 브랜치만 새로 추가.
  - 사진DB 픽: `item.src`(등록된 사진 경로/URL) + `item.caption`(→ alt). `insertEmbed`→`makeImageEmbed`로 표준 image 임베드 삽입(기존 안전 경로).
  - `kind="image"`를 유지해 SearchPanel의 이미지 썸네일 렌더를 재사용한다(사진 item에 `src`가 있어 썸네일 렌더됨).
- `SearchPanel`·`InlineEmbed`·`articleDetail.js`·`Editor.jsx`는 **바꾸지 않는다**(재임베드는 표준 image 임베드라 기존 렌더가 처리).
- (선택) `web/src/styles/yonhap.css`에 `.yh-search-source` 최소 레이아웃(가로 배치·간격)을 추가할 수 있다(디자인 토큰 사용 — UI_GUIDE.md). 기능에 필수는 아니다.

### 3. 컨트롤러 테스트 — `web/src/controller/useSearchController.test.jsx`
- `searchPhotos(q)`가 `model.searchPhotos`를 부르고 결과를 `photoResults`에 세팅함을 단언(searchImages 테스트 형제 — fakeModel `photos` 시드 또는 `publishPhoto` 후 검색).

### 4. WriterPage 결선 테스트 — `web/src/view/WriterPage.test.jsx`
- 이미지 탭에 **소스 토글(Google | 사진DB)** 이 있음을 단언.
- '사진DB' 소스 선택 + 검색어 입력 + 검색 → `model.searchPhotos`가 호출되고 결과 썸네일이 렌더됨(fakeModel `photos` 시드 또는 step1 fake 등록 후).
- 사진 결과를 클릭(픽)하면 본문에 **image 임베드가 삽입**되고 그 `src`=사진 src·`alt`=사진 caption임을 단언(`blocks`에 `{ embedType:'image', src, alt }` 추가).
- Google 소스는 **기존 동작 그대로**(회귀 — 기존 이미지 검색/픽 테스트가 그대로 통과).
- (선택) 매핑 탭에서도 사진DB 픽이 임베드를 삽입함(기존 이미지 픽이 매핑에서 동작하는 것과 동형).

## Acceptance Criteria

```bash
npm run lint          # ESLint 클린
npm run build         # vite 빌드
npm run test:web      # 웹 테스트 — 신규 useSearchController/WriterPage 검색소스 결선 전부 통과
npm test              # 백엔드(node --test) — 이 step은 백엔드 미변경이라 그대로 통과
```

기대 단언(요약):
- `useSearchController`가 `photoResults`+`searchPhotos`를 노출하고 검색 결과를 상태에 세팅한다.
- 이미지 탭에 Google/사진DB 소스 토글이 있고, 사진DB 검색이 `model.searchPhotos`를 부른다.
- 사진 결과 픽이 표준 image 임베드(src=사진 src·alt=caption)를 본문에 삽입한다(기존 insertEmbed 경로).
- Google 이미지 검색 동작이 그대로다(회귀 없음).
- 기존 웹·백엔드 테스트가 **모두 통과**한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 재임베드는 기존 `insertEmbed`→`makeImageEmbed` 안전 경로 재사용(새 임베드 타입/렌더 변경 없음).
   - `SearchPanel`/`InlineEmbed`/`articleDetail`/`Editor.jsx` 미변경.
   - 소스 토글은 이미지 탭 내부 additive(5번째 탭 신설 없음)·Google 브랜치 무변경.
   - View←Controller←Model 계층 준수(검색은 useSearchController→model).
3. 결과에 따라 `phases/41-photo-publish-db/index.json`의 step 3을 갱신(completed+summary / error / blocked).

## 금지사항

- 상위 `phases/index.json`(top-level 트래커)을 수정하지 마라. 이유: 오케스트레이터/execute.py 관리 파일 — step은 `phases/41-photo-publish-db/index.json`(로컬)만 갱신한다.
- 새 임베드 타입이나 `InlineEmbed.jsx`/`articleDetail.js`의 렌더를 추가/변경하지 마라. 이유: 재임베드는 표준 image 임베드라 기존 렌더(`isAllowedImageSrc`+`escapeHtml`)가 이미 안전 처리한다 — 렌더를 건드리면 발행 HTML XSS 표면이 늘고 회귀 위험이 생긴다.
- 재임베드를 `insertEmbed`(→`insertEmbedAtLine`) 안전 경로가 아닌 다른 방법(본문 문자열 직접 조작 등)으로 하지 마라. 이유: 캐럿/마커 무결성·매핑 정합은 그 단일 경로가 보장한다.
- 5번째 메타 탭을 만들지 마라. 이유: 스펙은 4개 탭(공통정보/이미지/영상/글기사) — 사진DB는 이미지 탭 내부 소스다.
- `SearchPanel` 공용 컴포넌트를 사진DB 전용으로 분기 개조하지 마라. 이유: 이미지 브랜치가 이미 `item.src`로 렌더한다 — props(results/onSearch/onPick)만 다르게 주입하면 된다(프레젠테이션 순수성 유지).
- Google 이미지 소스의 기존 `onPick`/`onSearch`/`results` 배선을 바꾸지 마라. 이유: 기존 이미지 검색 회귀 금지.
- `Editor.jsx`를 건드리지 마라. 이유: 임베드 삽입은 WriterPage 경로만(phase 30/33/39/40 결선 불변).
- 기존 테스트를 깨뜨리지 마라.
