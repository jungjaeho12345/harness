# Step 9: docs-notes

## 목표

**실행 코드 변경 0줄**인 문서·주석 위생 4건을 처리해 감사 백로그를 마감한다.

1. `docs/ARCHITECTURE.md` "보안 경계" 절에 **빠져 있는 불변식 2줄**을 추가한다(응답 투영 / SSE push 재검증).
2. 같은 절의 **CORS allowlist 서술을 step2의 실제 동작에 맞춘다**(프로덕션은 `ALLOWED_ORIGINS` 등록 출처만) + **운영 환경변수 조합 주의**를 1줄 남긴다(`NODE_ENV=production` + `FORCE_HTTPS=false`).
3. `web/src/view/editorEditOps.js`의 `sameBlocks`에 "align을 비교하지 않아도 안전한 이유" 주석 1줄.
4. `web/src/view/editorNewline.js`의 임베드 보존 규칙 문구를 **실제 동작(병합 결과 뒤, 상대 순서 보존)** 으로 정확히 하고, `web/src/test/fakeModel.js`에 **저장/잠금 인가 축소 모사** 경고 주석을 남긴다.

> `docs/news.md`는 **이 step의 대상이 아니다**(사용자 소유 스펙 문서 + 다른 세션이 편집 중 — `index.json`의 excluded 참조). 엠바고 송고 상태 문구(EPS→DES) 정정은 사용자 확인 후 별도 작업으로 남긴다.

> **선행**: 이 phase의 마지막 step(step0~8 완료 후). 실행 코드가 바뀌지 않으므로 `npm test`/`npm run test:web`의 **개수는 step8 종료 시점과 정확히 동일**해야 한다(실패 0).

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 문구로 재확인하라.

- `docs/ARCHITECTURE.md` — "보안 경계" 절(현재 4개 항목: 신뢰 경계=서버·매 요청 User 재조회 / helmet·CORS allowlist(`localhost:5173`)·레이트리밋·bcrypt·전역 에러 핸들러 / CSRF Origin·Referer 검증 / DB 비파괴). 데이터 흐름·디렉토리 구조 절도 읽어 톤을 맞춰라.
- `src/services/contentsProjection.js` — 응답 투영 단일 지점(`PRIVATE_CONTENTS_COLS`, `toPublicContents`). 읽기만.
- `server/index.js` — `allowedOrigins`(step2에서 프로덕션 기본값 제외로 바뀐 상태), `sessionCookieOptions`(프로덕션이면 `secure:true`·`sameSite:'none'`), `createApp`의 `const secure = cookieSecure ?? isProd;`, 부트스트랩의 `const forceHttps = process.env.FORCE_HTTPS === 'true' || (process.env.FORCE_HTTPS !== 'false' && process.env.NODE_ENV === 'production');`, `/api/stream`·`/api/logs/stream`의 push 직전 재검증(`controllers.auth.peek`). 읽기만.
- `web/src/view/editorEditOps.js` — `sameBlocks(a, b)`(텍스트만 비교), `sortDocument`(안정 정렬 + 마커 align 승계, `changed: !sameBlocks(ordered, list)`), `sortParagraph`(자체 쌍 비교라 무관).
- `web/src/view/editorNewline.js` — `insertTextIntoBlocks` 주석의 "임베드는 위치를 보존한다", `replaceRangeInBlocks` 헤더의 "규칙 4(임베드 보존)", 본문의 `const keptEmbeds = list.slice(startArr, endArr + 1).filter(isEmbedBlock);` → `next.splice(startArr, endArr - startArr + 1, ...newBlocks, ...keptEmbeds);`(= **병합 블록들 뒤**에 상대 순서대로 남는다).
- `web/src/test/fakeModel.js` — `saveArticle(dto, clientId)`가 `locked.lockerClientId`와 `clientId`만 비교하고, `lockArticle`/`unlockArticle`도 `lockerClientId`만 본다(서버는 세션에서 도출한 `userId` ↔ `Contents.lockerUserId`도 대조한다).

## 배경 (자기완결)

- **응답 투영 불변식**: phase 51이 `lockerSessionId`(활성 세션 토큰)·`lockerClientId`를 응답에서 제거했고, 제거 지점은 `toPublicContents` **한 곳뿐**이라는 것이 이 방어의 핵심이다. ARCHITECTURE.md에는 이 불변식이 없어서, 새 읽기 라우트를 만드는 사람이 규칙을 모른 채 모델 행을 그대로 내보낼 수 있다.
- **SSE push 재검증**: phase 52가 `/api/stream`·`/api/logs/stream`에 "push 직전 비연장 재검증(실패 시 종료 이벤트 1회 후 종료)"을 넣었다. 문서에는 접속 시점 인증만 서술돼 있다.
- **CORS/운영 조합**: step2 이후 프로덕션 allowlist는 `ALLOWED_ORIGINS`가 전부다. 또한 `NODE_ENV=production`은 **쿠키를 `Secure`+`SameSite=None`으로 만들지만**, `FORCE_HTTPS=false`로 HTTPS 강제만 끄면 평문 HTTP로 뜬 서버에서 브라우저가 그 쿠키를 저장·전송하지 않아 **로그인이 조용히 실패한다**. 두 스위치가 서로 다른 축이라는 사실이 어디에도 적혀 있지 않다.
- **sameBlocks**: `sortDocument`는 `{text, align}` 쌍을 텍스트 기준 **안정 정렬**한 뒤 되쓰는데 `changed` 판정은 텍스트만 비교한다 — "align만 이동한 변화를 놓치는 것 아닌가"로 읽힌다. 실제로는 안전하다: 안정 정렬에서 출력 텍스트 시퀀스가 입력과 같다면 정렬은 항등 순열이므로 align 쌍도 이동하지 않는다. 근거가 코드에 없어 같은 의심이 반복된다.
- **임베드 위치 문구**: 리뷰가 지적한 대로 "제자리 보존"은 부정확하다. 실제 계약은 "삭제 범위 안의 임베드는 **삭제되지 않고**, 병합된 텍스트 블록들 **뒤**에 원래 상대 순서로 남는다"이다.
- **fakeModel 드리프트**: 이 더블은 `clientId`만으로 저장/잠금을 판정한다. 서버는 phase 51·52 이후 세션 `userId` ↔ `lockerUserId`까지 대조하므로, **더블에서 통과한 시나리오가 서버에서 통과한다는 보장이 없다**. 더블 자체를 고치는 것은 이번 범위 밖(테스트 전반에 신원 주입이 필요)이라 경고를 남겨 오해를 막는다.

## 작업

1. `docs/ARCHITECTURE.md` "보안 경계" 절:
   - 응답 투영 1줄 추가 — Contents 행의 `lockerSessionId`·`lockerClientId`는 응답에 싣지 않으며 제거는 `toPublicContents`(services) **단일 지점**에서만 한다는 사실.
   - SSE 1줄 추가 — `/api/stream`·`/api/logs/stream`은 접속 시점뿐 아니라 **push 직전에 비연장 재검증**하고 실패하면 종료 이벤트 1회 후 연결을 닫는다는 사실.
   - CORS 항목 수정 — `CORS allowlist(localhost:5173)` 서술을 "비프로덕션 기본값은 `localhost:5173`·`127.0.0.1:5173`, **프로덕션은 `ALLOWED_ORIGINS`에 등록한 출처만**(미설정 시 자기 출처 외 쓰기 403)"으로 고친다. CSRF 항목의 allowlist 서술과 모순이 없게 맞춰라.
   - 운영 주의 1줄 추가 — `NODE_ENV=production`은 세션 쿠키를 `Secure`+`SameSite=None`으로 만들므로 `FORCE_HTTPS=false`로 평문 운영하면 브라우저가 쿠키를 싣지 않아 로그인이 실패한다(HTTPS 종단은 외부 프록시 책임).
   - 표현은 기존 항목들의 톤(한 줄 요약 + 근거 참조)을 따르고, 절 구조를 재편하지 마라.
2. `web/src/view/editorEditOps.js` `sameBlocks` 주석에 **한 줄 추가**: align을 비교하지 않는 것은 의도이며, 안정 정렬 하에서 텍스트 시퀀스가 그대로면 정렬은 항등 순열이라 align 쌍도 이동하지 않는다는 근거. 함수 본문·시그니처·호출부는 무변경.
3. `web/src/view/editorNewline.js` — `replaceRangeInBlocks` 헤더의 "규칙 4(임베드 보존)"과 `insertTextIntoBlocks`의 "임베드는 위치를 보존한다" 문장을 실제 계약(삭제하지 않는다 + 병합 결과 **뒤**에 원래 상대 순서로 남는다)으로 **문구만** 정확히 한다. 코드는 한 글자도 바꾸지 마라.
4. `web/src/test/fakeModel.js` — `saveArticle`/`lockArticle` 주변 주석에 경고 한두 줄: 이 더블은 `clientId`만 보는 축소 모사이고 서버는 세션 `userId` ↔ `Contents.lockerUserId`까지 대조하므로, 인가 계약의 진실은 백엔드 테스트(`test/editLock.test.js`·`test/server.test.js`)라는 사실. 더블의 **동작은 바꾸지 마라**.

이 step에서는 테스트 파일을 추가·수정하지 않는다.

## Acceptance Criteria

```bash
npm run lint      # 통과
npm run build     # 통과
npm run test:web  # 실패 0 — 개수는 step8 종료 시점과 **정확히 동일**
npm test          # 실패 0 — 개수는 step8 종료 시점과 **정확히 동일**
```

`git diff --name-only`는 `docs/ARCHITECTURE.md`, `web/src/view/editorEditOps.js`, `web/src/view/editorNewline.js`, `web/src/test/fakeModel.js` **4개뿐**이어야 한다. `docs/news.md`가 목록에 나타나면 범위를 벗어난 것이다 — 되돌려라.

## 검증 절차

1. 위 AC 커맨드를 실행하고 **테스트 개수가 직전과 동일**한지 확인한다(문서·주석만 바뀌었다는 증거).
2. `git diff -- web/src`에 `+`/`-` 라인 중 **실행 코드가 0줄**인지(주석·공백만) 확인한다.
3. `git status --short docs/`에 `docs/ARCHITECTURE.md` 외의 문서가 이 step 때문에 바뀌지 않았는지 확인한다(다른 세션이 편집 중인 `docs/news.md`·`docs/ADR.md`의 기존 `M` 표시는 건드리지 말고 그대로 둔다).
4. 문서 사실 확인(코드 대조): ARCHITECTURE.md에 새로 적은 3가지(투영 단일 지점·SSE push 재검증·프로덕션 allowlist)가 각각 `src/services/contentsProjection.js`, `server/index.js`의 SSE 라우트, step2 이후의 `allowedOrigins` 구현과 **실제로 일치**하는지 한 번 더 대조하라. 어긋나면 문서를 코드에 맞춰라(코드를 고치지 마라 — 이 step은 문서·주석 전용이다).
5. `phases/54-audit-closeout/index.json`의 step9를 `completed` + `summary`로 갱신하고, **phase 54 전 step(0~9) 완결**과 "감사 백로그 소진"을 summary에 명시하라. phase 50 디렉터리 처리 제안(status를 `superseded`로 바꾸라는 권고)은 index.json의 `coordination`에 이미 적혀 있으니 실행하지 말고 그대로 둔다.

## 금지사항

- `docs/news.md`를 **한 글자도** 수정하지 마라(엠바고 EPS→DES 정정 포함). 이유: 사용자 소유 스펙 문서이며 다른 세션이 편집 중이다 — 같은 파일을 이 phase가 커밋하면 남의 편집분이 섞인다. 정정은 사용자 확인 후 별도 작업이다(index.json excluded 근거).
- `docs/ADR.md`를 수정하지 마라. 이유: 다른 세션이 편집 중인 파일이다(이 phase는 ADR 본문을 바꾸지 않고 ARCHITECTURE.md에만 기술한다).
- `docs/SCHEMA.md`·`docs/PRD.md`·`docs/RCV.md`·`docs/UI_GUIDE.md`를 갱신하지 마라. 이유: 이번 변경과 무관하고 이미 정확하다.
- 실행 코드(주석 외 라인)를 한 줄도 바꾸지 마라. 이유: "실행 코드 무변경"이 이 step의 검증 가능성 그 자체다 — 테스트 개수·결과가 그대로라는 것이 유일한 증거다.
- `sameBlocks`에 align 비교를 추가하지 마라. 이유: 판정을 넓히면 정렬 결과가 같은데도 `changed=true`가 되어 불필요한 dirty·저장이 발생한다(phase 49가 남긴 설계 결정).
- `fakeModel`의 인가 판정을 실제로 고치지 마라(userId 대조 추가 금지). 이유: 더블을 쓰는 테스트 전반에 신원 주입이 필요해 프로덕션 이득 0에 테스트 회귀 표면만 커진다 — 이 phase는 경고 주석까지만 한다(index.json excluded 근거).
- `replaceRangeInBlocks`의 임베드 처리 코드를 "제자리"로 바꾸지 마라. 이유: 현재 동작(병합 뒤 보존)이 phase 53에서 테스트로 잠긴 계약이며, 이 step은 **문구를 코드에 맞추는** 작업이다.
- `.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하거나 커밋에 포함하지 마라.
- 기존 테스트를 깨뜨리지 마라.
