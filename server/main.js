// SEA/번들 전용 엔트리 (phase 61) — 패키지 배치임을 명시 주입한다.
// CRITICAL: packaged: true는 여기서만 넘긴다(런타임 탐지 금지 — 순수 함수 테스트로 잠글 수 있고
//   번들러/Node 버전에 따라 조용히 뒤집히지 않는다). 경로 해석은 execDir 기본값
//   (process.execPath의 디렉토리)으로 exe 옆 data/·web/을 본다 — cwd 비의존.
// 이 파일은 dev에서 쓰이지 않는다 — `npm run server`는 계속 server/index.js를 직접 실행한다.
//   (CJS 번들에서 index.js 하단 argv 가드는 항상 false라, 이 명시 호출이 없으면 exe는
//    아무것도 하지 않고 종료한다 — phase 61 실측.)
import { bootstrap } from './index.js';

bootstrap({ packaged: true });
