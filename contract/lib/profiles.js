// 프로파일 식별 — 러너가 CONTRACT_PROFILE로 넘긴 실행 중 프로파일 이름(프로파일 표는 러너가 소유).

export const PROFILE = process.env.CONTRACT_PROFILE;

// 케이스 오배치 방지 — 파일 상단에서 호출해 다른 프로파일로 잘못 실행되면 로드 시점에 즉시 실패시킨다.
// (예: auth-negative 소유의 레이트리밋 케이스가 default에서 돌면 로그인 예산이 무너진다 — decisions (8).)
export function requireProfile(name) {
  if (PROFILE !== name) {
    throw new Error(
      `이 케이스는 프로파일 '${name}' 전용이다(현재: '${PROFILE ?? '(미설정)'}') — contract/cases/${name}/ 아래에서 러너로 실행하라.`,
    );
  }
}
