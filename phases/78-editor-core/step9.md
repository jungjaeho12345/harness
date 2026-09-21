# Step 9: writer-state-machine

편집 상태 기계를 세운다. 목록에서 기사 열기 → 편집 표면 생성(표면당 `EditClientId` 1개) → **잠금 획득 실기 왕복(P5의 첫 서버 왕복)** → undo/자동저장 결선 → `PUT` 저장 → 해제. 로드맵 P5 완료 게이트의 절단점.

## 읽어야 할 파일
- `phases/78-editor-core/index.json` — decisions (3)(6)(7) · open_questions (3).
- `phases/77-qt-client-skeleton/index.json` `forward_notes` (3) — 편집 표면 clientId 결선 지점(코드 좌표) · 「잠금 획득은 P5의 첫 실기 축」.
- `client-qt/src/net/editclientid.h`/`.cpp` — `net::issueEditClientId()`(`c-<uuid-v4>`) · `class EditClientId`(복사·이동 삭제 값 보관소). **읽고 인스턴스를 생성·전달하되 파일은 고치지 마라(P4 net 회귀).**
- `client-qt/src/net/newsmodel.h`(`INewsModel` 35 메서드 — `lockArticle`·`unlockArticle`·`saveArticle`·`getArticle`·`queryArticles`) · `httpnewsmodel.*` · `fakenewsmodel.*` · `routetable.cpp`(`sendsEditClient` 3행). **읽되 고치지 마라.**
- `client-qt/src/ui/listcontroller.*` — 목록에서 기사 여는 진입점(회귀 — 편집 경로만 추가).
- `web/src/controller/useWriteController.js` — WriterPage 상태 기계 정본(clientId 발급 42~51행 · 잠금 획득 283행 · blankTab clientId=null 116행). **명세서로 읽는다.**
- `scripts/verify-qt-client.mjs` 머리 주석 + `scripts/lib/qtClientDiag.mjs` — 시나리오 추가 방법(새 드라이버 신설 금지 · 자기검사 결선).
- step0~8 산출물(에디터 순수 층 + 위젯).

## 작업
1. `client-qt/src/ui/editcontroller.*`(제안) 신설. **위젯 타입 0**(`INewsModel&`만 안다 — decisions (7)). `FakeNewsModel`로 서버 없이 테스트.
2. **편집 표면 수명 = `EditClientId` 1개**(decisions (3)): 표면(편집 탭) 생성 시 `net::issueEditClientId()`로 1개 발급, 소멸 시 폐기. **프로세스당·세션당·창당 금지**. 전달: 표면 → `HttpNewsModel`의 `editClientId` 인자(`lockArticle`/`unlockArticle`/`saveArticle`) → 전송 계층이 `routetable`의 `sendsEditClient` 3행에서만 헤더로 싣는다(기존 계약 — 고치지 않는다).
3. **잠금 획득 실기 왕복**: 목록에서 기사 열기 → `getArticle` → `lockArticle`(200 = 획득 / 401·409·423 = 실패 → 읽기전용/안내). 편집 → undo/자동저장(step6/7) 결선 → `saveArticle`(=`PUT /api/articles/:id` + `x-edit-client`) → `unlockArticle`.
4. **신원 캐시 금지**(decisions (3)): 로그인 시점 role/active를 굳히지 마라 — 서버 401/403을 그대로 따른다. `lockerSessionId`/`lockerClientId`를 읽는 코드 0(어떤 응답에도 없다).
5. **드라이버 시나리오 `--scenario edit` 추가**(decisions (6) · 새 드라이버 신설 금지): reporter가 기사 1건 생성(드라이버) → desk 클라가 열어 lock(200) → 편집 → save(200) → unlock → 드라이버가 `GET /api/articles/:id`로 저장 본문·잠금 상태 확인. diag(`editor-open`·`lock-acquired`·`net-request{articles-lock,200}`·`net-request{articles-update,200}`·`editor-saved`) ↔ 서버 측 사실 교차. **exe|spring 두 모드 exit 0**. diag에 기사 제목·기사아이디·본문·토큰 0.
6. QtTest: `useWriteController.js` 케이스를 `FakeNewsModel` 위에 옮긴다(표면 수명·clientId 전달·읽기전용 분기).

## Acceptance Criteria
- `cmd.exe /c "client-qt\build.bat"` → exit 0 · 0 failed.
- `node scripts/verify-qt-client.mjs --scenario edit --server exe` → **exit 0**.
- `node scripts/verify-qt-client.mjs --scenario edit --server spring --java-home <JDK25>` → **exit 0**.
- `node scripts/verify-qt-client.mjs --scenario boot|login|list --server exe` → 각 exit 0(P4 회귀 무변).
- `git status --porcelain` 이 가변 목록 밖 무변 — 특히 `client-qt/src/net`·`client-qt/src/shell` 무변.

## 검증 절차
1. 라우트 원장: `x-edit-client`가 정확히 3 라우트(lock·unlock·update)에만 · 계약 39 밖 호출 0 · 금지 2 라우트 0.
2. 우회 변이 최소 3종: (a) `EditClientId` 프로세스당 공유 → 두 표면이 같은 잠금 (b) 잠금 없이 PUT (c) 신원 캐시로 401 무시. 각 red 실증 후 원복(소스 diff).
3. diag·stdout·stderr에 비밀번호·기사 제목·기사아이디 0건 확인.
4. 리포 `news.db` md5 무변 · 임시 `DATA_DIR`에서만 실행.

## 금지사항
- `EditClientId`를 프로세스·세션·창당 1개로 만들지 마라. 이유: 같은 기사를 연 두 표면이 「같은 탭 재획득」으로 판정돼 둘 다 잠금을 갖고 둘 다 PUT 한다(비관적 잠금 붕괴).
- `req.body`/응답의 role·잠금 필드를 신뢰하거나 `lockerSessionId`/`lockerClientId`를 읽지 마라. 이유: 신뢰 경계는 서버이며 그 두 필드는 권한 상승 취약점 수정으로 어떤 응답에도 없다.
- 새 드라이버 파일을 만들지 마라. 이유: `verify-qt-client.mjs`에 시나리오를 덧붙이는 것이 계약이다(판정부는 `qtClientDiag.mjs`).
- `client-qt/src/net`·`editclientid.h`·`routetable`을 고치지 마라. 이유: P4 net 계층은 회귀 기준이다 — 인스턴스를 생성·전달만 한다.
- 자산이 없을 때 skip으로 green을 내지 마라. 이유: 자산 없으면 exit 1(phase 77 규율) — 「없어서 통과」 금지.
