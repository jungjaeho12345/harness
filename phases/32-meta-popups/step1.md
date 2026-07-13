# Step 1: backend-category — 내용(category) 컬럼 additive 풀스택 백엔드

## 배경 / 요구사항

phase 32는 공통정보에 **내용(분류)** 필드를 신설한다. 그 필드의 서버 영속 키는 **`category`**다. 이 step은 백엔드 3면(스키마·모델 컬럼 화이트리스트·서비스 필드 화이트리스트)에 `category`를 **비파괴 additive**로 추가하고, 파생(후속/계속) 복사 목록에도 넣는다. 프론트/팝업은 건드리지 않는다(step 2·3).

### ⚠️ 필드 키 = `category` (content 아님)
dto/DB의 기존 `content`는 **본문 컬럼**이다(`articleModel.js` L6~8 `ARTICLE_COLS`/`CONTENTS_COLS`, `schema.js` L24·L31). 내용(분류) 필드에 `content`/`contentType`를 쓰면 본문과 충돌한다. **반드시 `category`**를 쓴다. 수집(자동기사) 기사는 category를 설정하지 않으므로(아래) nullable이라 무영향이다.

### 왜 additive-only인가
- CLAUDE.md·ADR-006·news.md L290: 스키마 변경은 **행 삭제 없이 컬럼 추가(멱등 마이그레이션)만**. `schema.js`의 `createSchema`는 이미 `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 후 누락 컬럼만 `ALTER TABLE ... ADD COLUMN`한다. `SCHEMA.Contents` 목록에 `['category','VARCHAR']` 한 줄을 더하면 기존 DB는 자동으로 컬럼만 추가된다(기존 행/데이터 보존).
- 수집(자동기사) 경로(`src/services/collectionService.js`)는 `attribute: '자동기사'`만 설정하고 category는 넣지 않는다 → 기존/자동 기사는 category가 NULL. 이는 정상이다(선택 필드).

## 읽어야 할 파일

- `/CLAUDE.md`(DB 비파괴), `/docs/ARCHITECTURE.md`(계층 분리·보안 경계), `/docs/ADR.md`(ADR-002 직접 SQL·additive 마이그레이션, ADR-006 계층형), `/docs/news.md` L286~293(DB 명세·additive), L49(공통정보 '내용').
- `src/db/schema.js` — `SCHEMA.Contents` 배열(L28~57, 형식 `['컬럼명','정의']`), 멱등 마이그레이션(`createSchema` L86~103, `PRAGMA table_info` → 누락분만 `ADD COLUMN`). **추가 지점**: Contents 목록에 `['category', 'VARCHAR']` 한 줄(위치는 `coAuthor`/`region` 인근 공통정보 블록 권장 — L49~54).
- `src/models/articleModel.js` — `CONTENTS_COLS`(L7~14, 이 목록이 INSERT/UPDATE에 쓰이는 컬럼 화이트리스트). **추가 지점**: 공통정보 블록(L12~13, `'coAuthor','region','attribute','keyword'` 인근)에 `'category'`.
- `src/services/articleService.js` — `CONTENTS_FIELDS`(L14~19, dto→Contents 저장 필드 화이트리스트). **추가 지점**: L17(`'coAuthor','region','attribute','keyword'`) 인근에 `'category'`. 그리고 `deriveArticle`의 복사 pick 목록(L205~208)에도 `'category'`(후속/계속 시 원본 분류 승계 — region/attribute와 동형).
- `src/controllers/index.js` — L70~71(`create`/`update`가 dto/fields를 그대로 서비스에 위임 — **중간 화이트리스트 없음**, 확인만; 수정 불필요).
- `test/schema.test.js` — `Contents 컬럼` 테스트(L66~79, `expected` 배열에 컬럼 나열). **여기 `category` 추가**. 멱등/대소문자 보정 테스트(L172~, L242~)는 category에도 자동 적용되나 필요 시 스팟 단언.
- `test/articleService.test.js` — 공통정보 create 라운드트립(L57~70, `region`/`attribute`/`keyword` 저장·조회), update 부분갱신(L72~82), 파일참조 미전달 보존(L323~330). **여기에 category 라운드트립 단언 추가**.
- `test/deriveArticle.test.js` — 후속/계속 복사 테스트. region/attribute 승계를 단언하는 케이스가 있으면 **category도 동형 단언 추가**.

## 작업

TDD로 진행한다(`node --test`). **스키마 → 모델/서비스 화이트리스트 → deriveArticle** 순으로 테스트를 먼저 쓴다.

### (1) 스키마 (schema.js) + 테스트

- `test/schema.test.js`의 Contents `expected` 컬럼 배열에 `'category'` 추가(레드).
- `SCHEMA.Contents`에 `['category', 'VARCHAR']` 한 줄 추가(그린). 멱등 마이그레이션 코드는 손대지 않는다(기존 루프가 처리).
- (선택 보강) 옛 DB(category 없는 Contents)에서 `createSchema` 후 `category` 컬럼이 추가되고 기존 행이 보존되는지 스팟 단언(기존 L172~ 패턴 재사용).

### (2) 모델·서비스 화이트리스트 (articleModel.js / articleService.js) + 테스트

- `test/articleService.test.js`에 create 라운드트립 단언 추가: `service.create({ ..., category: '정치일반' })` 후 `articleModel.getById(id).contents.category === '정치일반'`(레드).
- `CONTENTS_COLS`(articleModel)와 `CONTENTS_FIELDS`(articleService)에 각각 `'category'` 추가(그린).
- update 부분갱신 단언 추가: `service.update(id, { category: '경제일반' })` 후 조회값 일치, **미전달 시 기존값 보존**(present-only SET 회귀 — 기존 L323~330 파일참조 보존과 동형으로 category에도 확인).

### (3) 파생 승계 (deriveArticle) + 테스트

- `deriveArticle`의 복사 pick 목록(L205~208)에 `'category'` 추가.
- `test/deriveArticle.test.js`에 원본 category가 후속/계속 신규 기사로 복사되는지 단언(region/attribute 케이스가 있으면 그 옆에 추가).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **키는 `category`**: 스키마 컬럼·모델 화이트리스트·서비스 화이트리스트·파생 pick 전부 `category`. `content`/`contentType` 금지. 이유: `content`는 본문 컬럼 — 충돌 시 본문 유실.
2. **additive-only·비파괴**: `SCHEMA.Contents`에 컬럼 한 줄 가산만. `createSchema` 마이그레이션 로직·기존 컬럼·`DROP`/`DELETE`/`UPDATE ... SET`(데이터 이동) 금지. 이유: DB 비파괴(ADR-002·news.md L290) — 기존 행 보존.
3. **present-only 유지**: category도 dto에 없으면 절대 기록/변경하지 않는다(모델의 present-only SET, 서비스 pick). 이유: 미전달 필드 보존 — 부분 수정이 다른 필드를 지우면 안 된다(기존 파일참조 보존 계약과 동형).
4. **계층 경계 유지**: 컨트롤러/서버 라우트에 category 전용 분기를 추가하지 마라(이미 dto 통째 위임 — L70~71). 이유: 얇은 transport(ADR-006) — 화이트리스트는 서비스/모델 단일 지점.
5. **프론트 미접촉**: 이 step은 `src/`(백엔드)와 `test/`만 만진다. `web/` 아래(httpModel·useWriteController·WriterPage·articleDetail)를 건드리지 마라. 이유: Scope 최소화 — 클라 결선은 step 3·4.

## Acceptance Criteria

```bash
npm run test -- schema             # Contents category 컬럼 + 멱등/보존 통과(node --test 필터)
npm run test -- articleService     # category create/update 라운드트립 + 미전달 보존 통과
npm run test -- deriveArticle      # category 승계 통과
npm run test                       # 백엔드 전체 회귀 통과
npm run build
npm run lint
```

> `npm run test`의 파일 필터 문법이 다르면(node --test) `node --test test/schema.test.js` 등 직접 실행으로 대체하되, 최종엔 **백엔드 전체**(`npm run test`)가 그린이어야 한다.

추가 단언:
- 스키마: `columns(db,'Contents')`에 `'category'` 포함; 옛 DB(category 없음) 마이그레이션 후 컬럼 추가 + 기존 행 보존.
- 서비스: create/update 라운드트립 일치, category 미전달 시 기존 category 보존.
- 파생: 원본 category → 신규 기사 category 복사.

## 검증 절차

1. 위 AC 커맨드 실행.
2. 아키텍처 체크리스트:
   - `category`가 schema.Contents·articleModel.CONTENTS_COLS·articleService.CONTENTS_FIELDS·deriveArticle pick **4곳 모두**에 존재(`grep category src/` 확인).
   - `DROP`/`DELETE`/파괴적 마이그레이션 없음.
   - `web/` 무변경(`git status`로 확인).
3. 결과에 따라 `phases/32-meta-popups/index.json`의 step 1을 갱신.

## 금지사항

- category에 `content`/`contentType` 키를 쓰지 마라. 이유: 본문 컬럼 충돌 — 본문 유실.
- `createSchema`의 마이그레이션 로직을 바꾸거나 `DROP`/`DELETE`/데이터 이동 SQL을 쓰지 마라. 이유: DB 비파괴(ADR-002).
- category를 always-write(빈 문자열 강제 기록 등)로 만들지 마라 — dto에 present일 때만 기록. 이유: 미전달 보존 계약 파괴 방지.
- 컨트롤러/서버 라우트에 category 전용 매핑을 추가하지 마라. 이유: 얇은 transport(ADR-006).
- `web/` 아래 파일이나 팝업/CommonInfo를 건드리지 마라. 이유: Scope 최소화 — 이 step은 백엔드 additive만.
