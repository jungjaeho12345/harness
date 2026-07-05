// 로그 레벨 배지 매핑(순수) — statusBadge.js 컨벤션을 응용. UI_GUIDE 상태 배지 팔레트 재사용,
// 절제된 색만(글로우/그라데이션 금지): ERROR=레드 / WARN=앰버 / INFO=회색 / DEBUG=옅은 회색.
// 알 수 없는 레벨은 회색(INFO) 폴백. yonhap.css의 .yh-log-badge--* 토큰과 1:1.

export const LOG_LEVELS = Object.freeze(['ERROR', 'WARN', 'INFO', 'DEBUG']);

export function logLevelClass(level) {
  switch (level) {
    case 'ERROR': return 'yh-log-badge--error';
    case 'WARN': return 'yh-log-badge--warn';
    case 'DEBUG': return 'yh-log-badge--debug';
    case 'INFO':
    default:
      return 'yh-log-badge--info';
  }
}
