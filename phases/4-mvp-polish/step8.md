# Step 8: seed-and-docs

데모용 admin 기사 시드 스크립트를 추가하고(개인별 수정 메뉴 데모), 문서를 정리한다 — README 계정 표의 **시드 비밀번호 표기 제거**, `ADR.md`·`ARCHITECTURE.md` 개요 문단 **포맷 정리(본문 내용 무변경)**. 이 step은 **운영 유틸 스크립트(`scripts/seed-admin-personal.js`) + 문서 3종**만 다룬다(앱 코드·컨트롤러·Model·서버·스키마 무변경).

## 읽어야 할 파일

먼저 아래 파일들을 읽고 시드/필터 규칙과 비파괴 원칙을 파악하라:

- `/scripts/seed-admin-personal.js` — **이 step에서 신설할 파일.** 핵심 이해 포인트:
  - 멱등·비파괴 INSERT-only 러너. `node:sqlite`의 `DatabaseSync('news.db')`에 `createSchema(db)`(멱등 마이그레이션만)·`createArticleModel(db)`·`createArticleService({articleModel, db})`를 조립한다.
  - 상수: `TARGET=10`, `AUTHOR='관리자'`(admin.name — 개인별 수정 필터가 이름으로 매칭), `DEPT='운영부'`, `DEPT_CODE='ADM'`.
  - `markup(title, body)` — yh-editor `version:1` 블록 JSON 생성(텍스트 블록 3개: 제목·본문·`'(끝)'` 마커 — 송고도 가능한 현실적 데모).
  - `countPersonal()` — `SELECT COUNT(*) FROM Contents WHERE author=? AND status IN ('RDS','RRK')`로 현재 개인별 기사 수를 센다.
  - `need = max(0, TARGET - have)` 만큼만 `service.create({ title, markupVersion, author, modifier, department, departmentCode })`로 INSERT — 부족분만 채운다.
- `/src/services/articleService.js` — `create(dto)`(읽기만). 신규 행은 **새 articleId·status `RDS`** 로 Article+Contents 트랜잭션 저장(클라가 보낸 status/articleId 무시·강제). `ARTICLE_FIELDS`(title·markupVersion·modifier) pick 규칙 확인.
- `/src/db/schema.js` — `createSchema(db)` 멱등·비파괴 마이그레이션(읽기만).
- `/web/src/controller/useViewController.js` — `buildMenuFilter`의 **개인별 수정** 분기(line 31): `{ author: 로그인 이름, status: ['RDS','RRK'] }`. 시드가 왜 status RDS로 만들면 메뉴에 노출되는지 근거(읽기만).
- `/eslint.config.js` — `ignores`에 `'scripts/**'`가 있어 시드 스크립트가 lint 대상이 아님을 확인.
- `/.gitignore` — `news.db`·`news.db-journal`·`news.db-wal`가 무시됨(런타임 DB 미커밋, 스크립트만 커밋).
- `/README.md` — 시드 계정 표(아이디/비밀번호/권한/부서). **비밀번호 칼럼을 비운다.**
- `/docs/ADR.md` — `## 철학` 문단. **포맷만 정리**(줄 분리·볼드 다듬기, 본문 내용 무변경).
- `/docs/ARCHITECTURE.md` — `## 개요` 문단. **포맷만 정리**(줄 분리, 본문 내용 무변경).

이전에 만들어진 시드 패턴(`scripts/seed.js`, `scripts/seed-articles.js`)과 비파괴 원칙을 이해한 뒤 작업하라.

## 작업

핵심 결정(반드시 따른다):
- **DB 비파괴(CLAUDE.md/ADR-002).** 시드는 **INSERT만** 한다 — 기존 행을 삭제/수정하지 않는다. `createSchema`는 멱등 마이그레이션만 호출. `need=max(0, TARGET-have)`로 **부족분만** 채우는 멱등 러너라 여러 번 실행해도 안전하다.
- 시드는 **`articleService.create`만** 사용한다(상태 전이·`applyAction` 미사용). create가 새 articleId·status `RDS`를 강제하므로 개인별 수정 필터(author=로그인 이름 AND status∈{RDS,RRK})에 그대로 노출된다 — 시드에서 status를 직접 쓰지 않는다.
- 문서 변경은 **순수 정리**다. ADR/ARCHITECTURE 개요는 **본문 내용을 바꾸지 않고** 줄 단위로 분리하고 볼드 표기만 다듬는다. README는 비밀번호 노출만 제거(아이디/권한/부서는 유지).

구현(시그니처는 재량, 기존 `scripts/seed*.js` 패턴 참고):
- `scripts/seed-admin-personal.js` 신설: 위 "읽어야 할 파일" 항목의 시그니처/상수/`countPersonal`/`create` 루프 구성대로. 실행은 `node scripts/seed-admin-personal.js`.
- `README.md`: 계정 표에서 `reporter123`/`desk123`/`admin123` 비밀번호 셀을 **빈 값**으로 교체. 멱등 시드 설명 문단은 무변경.
- `docs/ADR.md`: `## 철학` 문단에서 "신뢰 경계는 서버에 둔다 …"·"DB의 데이터는 절대 삭제하지 않는다 …"를 각각 **별 줄**로 분리하고 인라인 볼드를 정리(내용 동일).
- `docs/ARCHITECTURE.md`: `## 개요`에서 "두 프로세스로 분리된다" 이후를 별 줄로 분리(내용 동일).

테스트:
- **단위 테스트 추가 없음.** `scripts/`는 eslint-ignored 운영 유틸(앱 코드 아님)이고, 나머지는 문서/포맷 변경이라 테스트 대상이 없다. 기존 backend/web 테스트는 무회귀여야 한다(앱 코드 미변경).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다. 앱 코드 미변경이므로 기존 backend/web 테스트가 모두 통과해야 한다(무회귀). `scripts/**`는 eslint ignore라 lint 무영향.
2. 아키텍처 체크리스트:
   - 시드가 **INSERT만** 하는가(기존 행 삭제/수정 없음)? `createSchema`는 멱등 마이그레이션만 호출하는가? (DB 비파괴·ADR-002)
   - 시드가 `articleService.create`만 쓰고 status를 직접 쓰지 않는가(create가 RDS 강제)? 개인별 수정 필터(`buildMenuFilter`)와 status `RDS`/`RRK`·author 매칭이 정합하는가?
   - 런타임 `news.db`가 `.gitignore`라 커밋에서 제외되고 **스크립트만** 들어갔는가?
   - README에서 시드 비밀번호가 더 이상 노출되지 않는가(아이디/권한/부서는 유지)?
   - ADR/ARCHITECTURE 개요가 **본문 내용 변경 없이** 포맷만 정리됐는가(ARCHITECTURE.md 디렉토리 구조·ADR 기술스택·ADR-003/004/006 서술 무변경)?
3. `phases/4-mvp-polish/index.json`의 step 8을 업데이트(completed + summary: 시드 스크립트 신설(INSERT-only·멱등·create로 RDS)·README 비밀번호 제거·ADR/ARCHITECTURE 포맷 정리·단위 테스트 추가 없음). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 시드에서 기존 행을 삭제하거나 UPDATE 하지 마라. 이유: DB 비파괴(CLAUDE.md/ADR-002) — 시드는 부족분만 채우는 멱등 INSERT-only 러너다.
- 시드에서 status를 직접 지정하거나 `applyAction`/상태 전이를 호출하지 마라. 이유: `articleService.create`가 새 articleId·status `RDS`를 강제하며, 개인별 수정 필터가 RDS/RRK를 매칭한다 — 우회는 설계와 어긋난다.
- 런타임 `news.db` 데이터 파일을 커밋하지 마라. 이유: `.gitignore` 대상이며 환경별 데이터를 리포에 넣지 않는다 — 스크립트만 커밋한다.
- ADR/ARCHITECTURE의 **본문 내용**(결정·기술스택·디렉토리 구조)을 바꾸지 마라. 이유: 이 step은 개요 문단의 줄 분리·볼드 다듬기뿐인 순수 포맷 정리다.
- 앱 코드(컨트롤러/Model/서버/스키마)를 수정하지 마라. 이유: 이 step은 데모 시드 + 문서뿐이다 — 무관한 회귀를 막는다.
- 기존 테스트/기능을 깨뜨리지 마라.
