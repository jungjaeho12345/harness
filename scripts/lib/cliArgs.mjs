// CLI 값 플래그 판정 (phase 64 step0) — fs·전역·process 비의존 순수 모듈. 판정 결과만 돌려주고
// 종료 규약(die vs stderr+exit(1))은 각 CLI가 자기 스타일대로 처리한다(여기서 결정하면 6개
// 스크립트의 출력이 제각각 바뀐다). scripts/**는 eslint ignore 대상이라 이 모듈과
// test/cli-args.test.js가 "값 누락 무음 통과" 결함 클래스의 유일한 안전망이다.
//
// 값 판정 3분류(phase 64 decisions (3)):
//  - missing:   argv[index + 1]이 undefined(플래그가 마지막 인자) — 기본값 무음 진행 금지.
//  - empty:     trim 결과가 빈 문자열.
//  - flag-like: 값이 '--'로 시작(다음 플래그가 값으로 먹혀 두 축이 동시에 틀어지는 사고).
//    '-' 한 글자 접두는 막지 않는다 — 음수 등 정당한 값은 값 파싱이 아니라 범위 가드의 몫이다.

// argv: 인자 배열 / index: 플래그 자체의 인덱스 / flag: '--out' 같은 플래그 이름.
// → { ok: true, value } | { ok: false, reason: 'missing' | 'empty' | 'flag-like', message }
export function flagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined) {
    return { ok: false, reason: 'missing', message: `${flag} 값이 없다(플래그가 마지막 인자다).` };
  }
  if (typeof value === 'string' && value.startsWith('--')) {
    return { ok: false, reason: 'flag-like', message: `${flag} 값 자리에 다른 플래그가 왔다: ${value}` };
  }
  if (String(value).trim() === '') {
    return { ok: false, reason: 'empty', message: `${flag} 값이 비어 있다.` };
  }
  return { ok: true, value };
}
