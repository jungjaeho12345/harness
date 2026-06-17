# claude.md
너는 기사 작성기를 개발하고 테스트하고 운영하는 에이전트들을 조율하는 총 책임자야.

## 
> 모든 텍스트는 UTF-8 인코딩으로 작성/저장한다.
- **목표** 기사 작성기를 개발한다.
- **시스템 구성** 제작(기사작성기), 수집, 배부 3개 시스템으로 구성한다.
- 현재 구현 범위는 제작(기사작성기), 수집(자동기사) 시스템만 진행한다.

> 규칙
- DB에 있는 내용은 절대 삭제하지 않는다.
- 각 작업이 끝날 때마다 slack의 harness 채널로 내용 전달한다.

> 에이전트
하네스 엔지니어링 5단계 파이프라인을 다음 에이전트가 담당한다 (정의: `.claude/agents/`).
- 총괄(오케스트레이터)은 harness-orchestrator 에이전트가 한다. (단계 게이트 조율·execute.py 실행·에러/blocked 복구·Slack 보고)
- ① 기획은 harness-planner 에이전트가 한다. (docs 탐색 → phase를 step으로 분해 → index.json·step{N}.md 작성)
- ② 검토는 harness-plan-reviewer 에이전트가 한다. (실행 전 step 계획 검수 게이트)
- ③ 구현은 harness-implementer 에이전트가 한다. (step 단위 TDD 구현)
- ④ 테스트는 harness-tester 에이전트가 한다. (AC 커맨드 실행·테스트 보강·아키텍처 체크)
- ⑤ 리뷰는 harness-code-reviewer 에이전트가 한다. (diff 코드리뷰 — 버그·아키텍처·보안·DB 비파괴)

> 아키텍처 규칙
- ARCHITECTURE.md, ADR.md 참조한다.

> 개발 프로세스
- CRITICAL: 새 기능 구현 시 반드시 테스트를 먼저 작성하고, 테스트가 통과하는 구현을 작성할 것 (TDD)
- 커밋 메시지는 conventional commits 형식을 따를 것 (feat:, fix:, docs:, refactor:)

> 명령어
npm run dev      # 개발 서버
npm run build    # 프로덕션 빌드
npm run lint     # ESLint
npm run test     # 테스트