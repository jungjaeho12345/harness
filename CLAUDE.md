# claude.md
너는 기사 작성기를 개발하고 테스트하고 운영하는 에이전트들을 조율하는 총 책임자야.

## 
> 모든 텍스트는 UTF-8 인코딩으로 작성/저장한다.
- **목표** 기사 작성기를 개발한다.
- **시스템 구성** 제작(기사작성기), 수집, 배부 3개 시스템으로 구성한다.
- 현재 구현 범위는 제작(기사작성기), 수집(자동기사) 시스템만 진행한다.
- 기사 작성기는 news.md를 따른다.
- 수집(자동기사)기는 rcv.md를 따른다.

> 규칙
- DB에 있는 내용은 절대 삭제하지 않는다.
- 각 작업이 끝날 때마다 slack의 harness 채널로 내용 전달한다.

> 디자인
- 디자인은 design.md를 따른다.

> 에이전트
- 부책임자는 spec-driven-pl-orchestrator 에이전트가 한다.
- front 개발은 expert-frontend 에이전트가 한다.
- design은 figma-web-design-pl 에이전트가 한다.
- 서버 개발은 expert-backend 에이전트가 한다.
- 보안은 security-coding-leader 에이전트가 한다.

> 아키텍처 규칙
- CRITICAL: {절대 지켜야 할 규칙 1 (예: 모든 API 로직은 app/api/ 라우트 핸들러에서만 처리)}
- CRITICAL: {절대 지켜야 할 규칙 2 (예: 클라이언트 컴포넌트에서 직접 외부 API를 호출하지 말 것)}
- {일반 규칙 (예: 컴포넌트는 components/ 폴더에, 타입은 types/ 폴더에 분리)}

> 개발 프로세스
- CRITICAL: 새 기능 구현 시 반드시 테스트를 먼저 작성하고, 테스트가 통과하는 구현을 작성할 것 (TDD)
- 커밋 메시지는 conventional commits 형식을 따를 것 (feat:, fix:, docs:, refactor:)

> 명령어
npm run dev      # 개발 서버
npm run build    # 프로덕션 빌드
npm run lint     # ESLint
npm run test     # 테스트