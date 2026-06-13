# Step 0: project-setup

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ARCHITECTURE.md` — 디렉토리 구조, 두 프로세스(웹 SPA + Express) 구성
- `/docs/ADR.md` — 기술 결정 (Vite+React SPA, node:sqlite, MVC, 주입형 Model)
- `/docs/PRD.md` — 제품 범위
- `/CLAUDE.md` — 프로젝트 규칙 (UTF-8, DB 비파괴, TDD, conventional commits)
- `/schema.md` — DB 개요(이 step에서는 디렉토리만, 구현은 step1)

## 작업

이 phase 전체가 빌드/테스트 가능하도록 **부트스트랩 스켈레톤**을 만든다. 비즈니스 로직은 만들지 않는다.

1. 루트 `package.json` 생성:
   - `"type": "module"`, `"engines": { "node": ">=22.5.0" }`, `"private": true`
   - `scripts`:
     - `"dev": "vite web"`
     - `"build": "vite build web"`
     - `"server": "node --env-file-if-exists=.env server/index.js"`
     - `"test": "node --test test/"` (백엔드 — node:sqlite 사용. 만약 이 Node 런타임이 `node:sqlite` import에 플래그를 요구하면 `node --experimental-sqlite --test test/`로 바꿔라. **실제로 `import { DatabaseSync } from 'node:sqlite'`가 동작하는지 확인하고 결정**하라.)
     - `"test:web": "vitest run --root web"`
     - `"lint": "eslint ."`
   - `dependencies`: `express`, `cors`, `helmet`, `express-rate-limit`, `bcryptjs`
   - `devDependencies`: `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `eslint`, `@eslint/js`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, `globals`
2. 디렉토리 스켈레톤 생성 (빈 디렉토리는 `.gitkeep`):
   - `src/db/`, `src/models/`, `src/services/`, `src/parsers/`, `src/controllers/`
   - `server/`
   - `test/`
   - `web/src/app/`, `web/src/model/`, `web/src/view/`, `web/src/controller/`, `web/src/styles/`, `web/src/test/`
3. `web/index.html`: `<html lang="ko">`, `<title>기사 작성기</title>`, `<div id="root">`, `<script type="module" src="/src/main.jsx">`.
4. `web/vite.config.js`: `@vitejs/plugin-react`, root는 `web`.
5. `web/vitest.config.js`: environment `jsdom`, `setupFiles: ['src/test/setup.js']`, globals true.
6. `web/src/test/setup.js`: `@testing-library/jest-dom` import.
7. `web/src/main.jsx`: 최소 placeholder — `createRoot(document.getElementById('root')).render(...)`로 "기사 작성기" 텍스트만 렌더 (이후 step에서 교체). **이 파일이 `vite build web`를 통과시키는 목적**이다.
8. `eslint.config.js`: flat config (js + react + react-hooks), Node + browser globals.
9. `test/smoke.test.js`: `node:test` + `node:assert`로 `assert.equal(1+1, 2)` 같은 통과 테스트 1개.
10. `.env.example`: `PORT=3001`, `VITE_API_BASE=http://127.0.0.1:3001`, 미디어 검색 API 키 placeholder.
11. `npm install` 실행.

## Acceptance Criteria

```bash
npm install
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 커맨드를 모두 실행한다.
2. 아키텍처 체크리스트:
   - ARCHITECTURE.md 디렉토리 구조(server/, src/, web/src/{app,model,view,controller,styles})를 따르는가?
   - ADR 기술 스택(Vite+React, Express, node:sqlite)을 벗어나지 않았는가?
   - `package.json`의 의존성이 위 목록을 벗어나지 않는가?
3. `phases/0-mvp/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 생성한 핵심 파일(package.json scripts, web 스켈레톤, test 명령)과 node:sqlite 플래그 결정 결과를 한 줄로 요약
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요(예: npm 레지스트리 접근 불가) → `"status": "blocked"`, `"blocked_reason"`

## 금지사항

- 비즈니스 로직(기사/사용자/생애주기/라우트)을 구현하지 마라. 이유: 이 step은 셋업 전용이며, 각 도메인은 후속 step이 자기완결적으로 다룬다.
- 위에 명시되지 않은 외부 의존성을 추가하지 마라. 이유: ADR 철학 — 외부 의존성 최소화.
- TypeScript를 도입하지 마라. 이유: ADR — 표준 JS + Vite, 타입 도구 미사용.
- 기존 테스트를 깨뜨리지 마라.
