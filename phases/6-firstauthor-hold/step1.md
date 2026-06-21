# Step 1: frontend-pass-action — 신규 저장 시 의도 action 전송

## 배경 / 요구사항

`docs/news.md` "기사 생애주기"에 추가된 규칙:

> 권한 Z 사용자가 최초 작성시에 보류는 RDS가 아닌 DDH가 된다. (news.md:208)

**Step 0(완료 전제)**에서 백엔드는 이미 처리됐다: `POST /api/articles`가 **세션 role + body의 `action`**으로 초기 상태를 계산한다(`Z + hold → DDH`, 그 외 → RDS). 순수 함수 `initialStatus(role, action)`(`src/services/lifecycle.js`)와 `create(dto, { role, action })`(`src/services/articleService.js`)가 그 계약이다.

**문제(이 step에서 해결)**: 현재 프론트엔드는 **신규 기사 저장 시 `action`을 서버로 보내지 않는다.** 신규 작성 화면의 송고/보류 버튼은 둘 다 `POST /api/articles`(create)만 호출하고, 누른 버튼이 송고인지 보류인지 서버에 전달되지 않는다. 그래서 Step 0의 백엔드가 있어도 항상 `action`이 `undefined`로 들어와 RDS가 된다.

**목표**: 신규 저장(create, POST) 시 사용자가 누른 의도 `action`('send' | 'hold')을 요청 본문에 포함시킨다. 그러면 Z가 보류를 누른 신규 기사가 DDH로 저장된다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` — CRITICAL 규칙(TDD)
- `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — ADR-003(view/controller에서 직접 fetch 금지 — 반드시 model 경유), ADR-004(role은 클라가 전송하지 않음 — 서버 세션 도출)
- `src/services/lifecycle.js` — Step 0에서 추가된 `initialStatus(role, action)` 계약 확인(서버가 기대하는 action 값은 `'hold'`. 그 외/누락은 RDS).
- `server/index.js` — `POST /api/articles`가 `req.body?.action`을 읽는 부분(Step 0 결과). 클라가 보내야 할 body 키 이름(`action`)과 값(`'send'`/`'hold'`)을 확인하라.
- `web/src/controller/useWriteController.js` — **핵심**. `submit(action)`(약 296~313줄)의 신규 경로 분기 `if (!tab.articleId)`(약 300줄). 여기서 `model.saveArticle(toSaveDto(tab), ...)`만 호출하고 `action`을 무시하며 곧바로 return한다. `toSaveDto(tab)`(약 58~63줄, dto에 articleId 유무로 POST/PUT 분기), 편집 경로(applyAction 호출)와의 대비를 이해하라.
- `web/src/model/httpModel.js` — `createHttpModel`의 `saveArticle(dto, clientId)`(약 125~130줄). `dto.articleId` 유무로 `POST /api/articles`(create) vs `PUT /api/articles/:id`(update)를 가른다. `applyAction(articleId, action)`(약 116~121줄)도 참고(편집 전용, 이 step에서 변경 금지).
- `web/src/controller/useWriteController.test.jsx` — 신규(followUp) 탭 `submit('send')`이 saveArticle만 호출하고 dto에 articleId가 없음을 검증하는 테스트(약 388~402줄), 편집 탭 `submit('hold')`이 applyAction을 호출하는 테스트(약 261~265줄). 회귀 기준이자 새 단언을 추가할 위치.
- `web/src/model/httpModel.test.js`(있으면) — saveArticle의 POST/PUT 분기와 요청 body를 검증하는 기존 패턴.
- `web/src/view/writerButtons.js` — 신규 화면 버튼 표시 규칙(송고·보류 표시, KILL 숨김). 참고용(이 step에서 변경 불필요).

이전 코드를 정독하고 **"view/controller는 fetch를 직접 하지 않고 반드시 `model`을 경유한다(ADR-003), role은 클라가 보내지 않는다(ADR-004)"** 불변식을 이해한 뒤 작업하라.

## 작업

TDD로 진행한다. 테스트를 먼저 쓰고 통과시키는 최소 구현을 작성하라.

### 1. 신규 경로에서 action 전달 (`web/src/controller/useWriteController.js`)

- `submit(action)`의 신규 분기(`if (!tab.articleId)`)에서 `model.saveArticle(...)` 호출에 사용자가 누른 `action`('send'/'hold')을 함께 넘긴다.
- 편집 경로(`tab.articleId` 있음 → PUT 후 `applyAction`)는 **건드리지 마라**. 그 경로의 동작/호출 순서는 불변.

### 2. saveArticle가 create(POST)에서만 action을 body에 포함 (`web/src/model/httpModel.js`)

- `saveArticle(dto, clientId, action)`로 시그니처를 확장하되(또는 프로젝트의 기존 인자 전달 관례에 맞춰), **`dto.articleId`가 없을 때(POST/create)만** 요청 body에 `action`을 추가한다.
- **PUT(편집) 경로에는 `action`을 넣지 마라.** 이유: 편집 저장은 본문 수정일 뿐이고 상태 전이는 별도 `applyAction`이 담당한다.
- `action`이 전달되지 않은 호출(예: 다른 곳의 saveArticle 사용처)에서는 기존과 동일하게 body에 `action` 키가 없어야 한다(하위호환).
- **role은 절대 body에 넣지 마라**(ADR-004 — 서버 세션 도출).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **회귀 금지**: 신규 송고는 여전히 RDS로 저장돼야 한다(서버가 `action:'send'` → RDS). 신규 저장의 기존 흐름(저장 성공 시 `resetTabToBlank` 등)은 그대로 유지하라.
2. **편집 경로 불변**: `applyAction`, PUT 저장, 잠금 해제(unlock) 호출과 순서를 바꾸지 마라.
3. **ADR-003**: view/controller에서 직접 `fetch`하지 마라. 반드시 `model.saveArticle` 경유.
4. **ADR-004**: `role`을 클라이언트에서 전송하지 마라. 보내는 것은 의도 `action`('send'/'hold')뿐이다.
5. 서버가 인식하는 action 값은 정확히 `'send'`/`'hold'` 문자열이어야 한다(Step 0 `initialStatus`가 `action === 'hold'`로 비교).

## Acceptance Criteria

```bash
npm run test:web    # web 테스트 전체 통과 (신규 action 전송 단언 포함)
npm run build       # 프로덕션 빌드 성공 (vite build web)
npm run lint        # ESLint 0 에러
```

추가로, 아래 단언이 테스트에 포함돼야 한다:

- 신규(articleId 없음) 탭에서 `submit('hold')` → `saveArticle` 호출이 create로 가고, 전송 body에 `action: 'hold'`가 포함된다.
- 신규 탭에서 `submit('send')` → 전송 body에 `action: 'send'`가 포함된다.
- 편집(articleId 있음) 탭 저장(PUT)에는 body에 `action`이 **없다**(또는 PUT 경로가 action을 싣지 않음). 편집의 `applyAction` 호출은 기존과 동일.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - ARCHITECTURE.md 디렉토리 구조를 따르는가? (controller/model 경계)
   - ADR 기술 스택을 벗어나지 않았는가? (ADR-003 model 경유, ADR-004 role 미전송)
   - CLAUDE.md CRITICAL 규칙(TDD)을 위반하지 않았는가?
3. 결과에 따라 `phases/6-firstauthor-hold/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- 편집 경로(PUT 저장 + `applyAction` + unlock)의 호출/순서를 변경하지 마라. 이유: 기존 기사 송고/보류/KILL 회귀를 유발한다.
- `action`을 PUT(편집 저장) body에 넣지 마라. 이유: 편집은 본문 수정이고 상태 전이는 `applyAction` 담당 — 의미가 섞이면 서버가 편집 저장을 상태 변경으로 오해할 수 있다.
- view/controller에서 직접 `fetch`하지 마라(ADR-003). 이유: 모델 경유 계약을 깨고 테스트·일관성을 무너뜨린다.
- `role`을 클라이언트 요청에 포함하지 마라(ADR-004). 이유: 신뢰 경계 위반.
- 백엔드(`src/`, `server/`)를 이 step에서 수정하지 마라. 이유: 서버 계약은 Step 0에서 확정됐다 — 여기서 바꾸면 두 step의 책임이 섞인다.
- 기존 테스트를 깨뜨리지 마라.
