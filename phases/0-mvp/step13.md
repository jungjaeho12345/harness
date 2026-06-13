# Step 13: seed-and-e2e

## 읽어야 할 파일

- `/schema.md` — User 테이블, bcrypt
- `/news.md` — 사용자 권한(R/D/Z), 로그인 워크플로우
- `/CLAUDE.md` — DB 비파괴(절대 삭제 금지), 명령어
- `server/index.js`(step8), `src/db/schema.js`(step1), `src/services/userService.js`(step4)

## 작업

샘플 사용자 시드와 끝-끝 스모크를 추가해 MVP를 마감한다. **멱등 — 기존 DB 행을 삭제/덮어쓰지 않는다.**

1. `src/db/seed.js`(또는 `scripts/seed.js`) — `export function seedUsers(db)`:
   - 샘플 사용자 R(기자)/D(데스크)/Z(관리자)를 **없을 때만 insert**(존재하면 skip). 비밀번호는 bcrypt 해시. `active='Y'`, 부서/부서코드 포함.
   - `package.json`에 `"seed": "node --env-file-if-exists=.env scripts/seed.js"`(또는 해당 경로) 추가. 직접 실행 시 루트 `news.db` 열고 `createSchema` 후 `seedUsers`.
2. 통합 스모크 테스트(`test/integration.smoke.test.js`, node:test):
   - in-memory(또는 임시) db로 createApp 구동, `GET /api/health` ok, 시드 사용자로 `POST /api/login` 성공 → sessionId 발급 → `GET /api/session` 복원 → 기사 create→query 1건 왕복 확인.
3. 전체 빌드/테스트 green 확인 및 `README.md`에 실행법(`npm install` → `npm run seed` → `npm run server` + `npm run dev`) 간단 정리.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 4개 AC를 모두 실행한다(백엔드 + 웹 테스트 동시 green).
2. 체크리스트: seed가 멱등인가(2회 실행 시 중복/삭제 없음)? 스모크가 로그인→세션→기사 왕복을 통과하는가? README에 실행법이 있는가?
3. `phases/0-mvp/index.json`의 step 13 업데이트(completed + summary: seed/스모크/README, 전체 그린 여부).

## 금지사항

- 기존 DB 행을 삭제하거나 덮어쓰지 마라(멱등 insert만). 이유: CLAUDE.md/ADR DB 비파괴 — 절대 규칙.
- 운영 `news.db`를 테스트에서 변형하지 마라(임시/in-memory 사용). 이유: 데이터 보호.
- 새 기능을 추가하지 마라(이 step은 시드+스모크+문서 마감). 기존 테스트를 깨뜨리지 마라.
