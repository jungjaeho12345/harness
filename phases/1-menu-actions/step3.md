# Step 3: derive-article-service

우클릭 메뉴의 **후속기사작성(followUp)**·**계속기사작성(continue)**을 위한 도메인 로직을 구현한다. 두 기능 모두 "기존 기사를 바탕으로 **새 기사**를 작성"한다 — 새 articleId를 발급하고, 일부 필드를 복사/초기화하며, **원본은 절대 변경하지 않는다**(DB 비파괴). 이 step은 백엔드 도메인 레이어(service)만 다룬다.

**중요 — 명세 근거:** news.md는 "후속기사작성"/"계속기사작성"을 우클릭 메뉴 항목(85행)으로만 언급하고, 두 기능의 필드 복사 규칙을 명시하지 않는다. 아래는 기존 동작(편집 진입 시 매핑 규칙, news.md 199~201행)과 "새 기사 작성=새 articleId·status RDS"(news.md 206행) 원칙에서 **도출한 합리적 정의**다. 이 정의를 그대로 구현하되, 불명확한 부분은 주석으로 근거를 남겨라.

## 읽어야 할 파일

- `/docs/ADR.md` — ADR-002(DB 비파괴), ADR-006(services 도메인 로직·의존성 주입).
- `/docs/news.md` — 85행(후속/계속기사작성 메뉴), 199~201행(편집 진입 매핑: 제목/본문/작성자/엠바고는 입력란, 기사아이디/수정자/송고자/부서/시간은 별도 취급), 206행(최초 작성 status RDS), 148~150행(articleId 'AKR'+YYYYMMDD+난수9).
- `/docs/SCHEMA.md` — Article/Contents 컬럼, 1:1 매핑, 트랜잭션.
- 현재 구현(반드시 정독):
  - `src/services/articleService.js` — `create(dto)`(L58-69, generateArticleId·status RDS·Article+Contents 트랜잭션 저장)·`getById`. `create`를 재사용한다.
  - `src/db/articleId.js` — `generateArticleId(db)`(새 id 발급).
  - `src/models/articleModel.js` — `getById`(원본 읽기), `insert`(트랜잭션).
  - 테스트 패턴: `test/articleService.test.js`(in-memory db로 create/getById 왕복).

이전 코드를 정독하고, `create`가 어떤 dto 필드를 Article/Contents에 분배하는지(`ARTICLE_FIELDS`/`CONTENTS_FIELDS`) 추적한 뒤 작업하라.

## 작업

### 도출한 파생 규칙(구현 대상)

원본 기사 `src/models articleModel.getById(sourceArticleId)` → `{ article, contents }`에서 새 기사를 만든다. **새 기사는 항상 `articleService.create`를 통해 발급**(새 articleId·status RDS·트랜잭션·작성시간 새로 기록). 모드별 복사/초기화:

| 필드 | followUp(후속) | continue(계속) | 근거 |
|------|----------------|----------------|------|
| `markupVersion`(본문) | **빈 본문**(새로 작성) | 원본 본문 **복사** | 후속=주제 이어받되 새로 작성 / 계속=원문에서 이어쓰기 |
| `title`(제목) | 원본 제목 복사(작성자가 수정) | 원본 제목 복사 | 둘 다 출발점 제공 |
| `author` | **빈 값**(현재 작성자가 채움 — HTTP가 세션 사용자 stamp) | 빈 값 | 새 기사의 작성자는 파생을 실행한 사람 |
| 공통정보(`region`·`attribute`·`keyword`·`coAuthor` 등) | 복사 | 복사 | 메타 출발점 |
| `embargoAt`/`secondEmbargoAt` | **초기화(빈 값)** | 초기화 | 새 기사의 엠바고는 새로 설정 |
| `status` | RDS(create가 강제) | RDS | 신규 작성 |
| `sender`·`sentAt`·`editedAt`·`distributedAt` | 미복사(create가 미설정) | 미복사 | 송고/배부 이력은 새 기사에 없음 |
| 잠금 컬럼(`lockYN` 등) | 미복사 | 미복사 | 새 기사는 미잠금 |
| `articleId` | **새로 발급** | 새로 발급 | 원본 비파괴, 별개 기사 |

> 위 표가 유일하게 확정적인 명세가 아님을 인지하라. news.md에 직접 근거가 없는 항목(특히 followUp의 본문 빈값 vs 복사)은 위 정의를 채택하되 주석으로 "news.md 명세 부재 — 합리적 도출"이라 남겨라. plan-reviewer/code-reviewer가 이 결정을 검토한다.

### TDD 순서: 먼저 실패 테스트를 쓴다

`test/deriveArticle.test.js`(node --test, in-memory `:memory:` db + `createSchema`) 시나리오:

1. 원본 기사를 `create`로 만든 뒤 `deriveArticle(sourceId, 'continue', { author })`가 **새 articleId**(원본과 다름)를 반환하고, 새 기사의 본문이 원본 본문과 같다(continue=복사).
2. `deriveArticle(sourceId, 'followUp', { author })`는 새 기사의 본문이 **빈 값**이다(followUp=새로 작성), 제목·공통정보는 복사된다.
3. 두 모드 모두 새 기사 `status==='RDS'`, `sender`/`sentAt` 없음, 잠금 없음.
4. **원본 기사가 변경되지 않는다**(파생 전후 `getById(sourceId)`가 동일 — 비파괴).
5. 원본이 없으면 `{ ok:false, reason:'not-found' }`.
6. 알 수 없는 모드는 `{ ok:false, reason:'unknown-mode' }`.

### 구현: `articleService`에 `deriveArticle` 추가

`src/services/articleService.js`의 `createArticleService` 안에 함수를 추가하고 반환 객체(L165-168)에 노출하라:

```
function deriveArticle(sourceArticleId, mode, overrides = {})
  // mode ∈ 'followUp' | 'continue'
  // 1) const src = articleModel.getById(sourceArticleId); 없으면 { ok:false, reason:'not-found' }
  // 2) mode 검증 — 아니면 { ok:false, reason:'unknown-mode' }
  // 3) 위 표대로 dto를 구성(원본 contents/article에서 복사·초기화)
  //    - followUp: markupVersion='' / continue: markupVersion=src.article.markupVersion
  //    - title 복사, embargo 초기화, author는 overrides.author(HTTP가 세션 stamp)
  //    - 공통정보(coAuthor/region/attribute/keyword/internalComment/externalComment/attachmentFile/referenceFile) 복사
  // 4) return create(dto);  // 새 articleId·RDS·트랜잭션 (원본 미변경)
```

- **원본을 절대 update/delete 하지 마라.** `create`만 호출한다(새 행 추가).
- `create`를 재사용하라 — articleId 발급·status RDS·트랜잭션 로직을 재구현하지 마라(ADR-006 DRY).
- `overrides`로 받은 `author`만 신뢰 가능 값으로 취급(HTTP 계층이 세션 사용자로 채운다 — step4). 클라이언트가 보낸 status/sender/articleId는 무시한다.

### 결선(controllers)

`src/controllers/index.js`의 `article` 객체에 `derive: (sourceId, mode, overrides) => articleService.deriveArticle(sourceId, mode, overrides)`를 추가하라(위임만). **HTTP 라우트는 step4 소관 — server/index.js는 건드리지 마라.**

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

기존 테스트를 단 1개도 깨뜨리지 마라.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - 새 기사가 `create`(새 articleId·RDS·트랜잭션)로만 만들어지는가? 로직 재구현이 없는가? (ADR-006)
   - **원본 기사가 파생 전후로 불변인가?** (DB 비파괴 — 가장 중요)
   - followUp/continue 본문 규칙이 표대로이고, 명세 부재 항목에 근거 주석이 있는가?
   - status가 RDS이고 sender/sentAt/잠금이 복사되지 않는가?
3. 결과에 따라 `phases/1-menu-actions/index.json`의 step 3을 업데이트한다(완료/error/blocked 양식 동일).

## 금지사항

- 원본 기사를 `update`/`delete` 하지 마라. 이유: 후속/계속은 새 기사를 만드는 것이지 원본을 바꾸는 게 아니다(DB 비파괴, CLAUDE.md CRITICAL).
- `sender`·`sentAt`·`distributedAt`·잠금 컬럼·`status`(RDS 외)를 새 기사에 복사하지 마라. 이유: 새 기사는 아직 송고/배부/잠금 이력이 없는 신규 RDS 기사다.
- articleId 발급·트랜잭션·RDS 설정을 직접 재구현하지 마라. 이유: `create`가 이미 한다 — 재구현은 ADR-006 위반이며 두 경로가 어긋날 위험이 있다.
- 클라이언트가 보낸 author/status/sender를 무검증으로 신뢰하지 마라(author는 step4에서 세션 stamp). 이유: ADR-004.
- `server/index.js`/프론트엔드를 이 step에서 수정하지 마라. 이유: 레이어 분리 — HTTP는 step4, 프론트는 step7·9.
- 기존 테스트를 깨뜨리지 마라.
