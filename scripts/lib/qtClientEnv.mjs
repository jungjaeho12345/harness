// Qt 네이티브 클라(client-qt/release/news-client.exe) 자식 env 조립 (phase 77 step6).
// 자기검사: scripts/lib/qtClientDiag.self-test.mjs 의 「qtClientEnv」 절(드라이버가 시작 시 돌린다).
//
// 왜 integrationMode.mjs 의 osEnvAllowlist/springServerEnv 를 그대로 쓰지 않는가 — 두 자식의 요구가 반대다:
//   · java 자식: win32 에서 PATH 를 **넘기지 않는다**(java -jar 는 자기 홈으로 뜬다 — 시스템 java 폴백 금지의 env 판).
//   · Qt 자식: Qt 는 동적 링크라 PATH 에 Qt bin 이 없으면 0xC0000135(STATUS_DLL_NOT_FOUND)로 **모달 없이 즉사**한다
//     (step0 M0-3 실측). 그래서 PATH 는 필수다 — 단 **부모 PATH 를 상속하지 않고** 조립한다. 부모 PATH 를 통째로
//     물려주면 다른 Qt 설치(다른 버전의 Qt6Core.dll)가 끼어들어 결과가 머신마다 흔들리고, --qt-bin 을 틀리게 줘도
//     우연히 뜨는 **무음 green** 이 열린다(M6-4).
//   integrationMode.mjs 는 verify-integration.mjs 의 결선이 걸린 무수정 모듈이라 이 차이를 거기에 넣지 않는다 —
//   OS 기본 키 목록만 import 해 재사용한다.
// 하네스 3키(CLIENT_USER_DATA·CLIENT_DIAG_FILE·CLIENT_SELFTEST)는 Electron 셸에서 이름 그대로 승계했다
// (client-qt/src/shell/appidentity.h). 부모의 같은 키·QT_*·NODE_OPTIONS 는 허용목록 밖이라 실리지 않는다.

import { osEnvAllowlist } from './integrationMode.mjs';

export function qtClientEnv({ parentEnv = {}, platform, qtBinDir, userDataDir, diagFile } = {}) {
  const required = { qtBinDir, userDataDir, diagFile };
  for (const [key, v] of Object.entries(required)) {
    if (v === undefined || v === null || String(v).trim() === '') {
      throw new Error(`Qt 자식 env 조립 거부: ${key} 미지정 — 조용한 기본값 폴백은 없다(실사용자 폴더로 새는 길).`);
    }
  }
  const env = {};
  for (const key of osEnvAllowlist(platform)) {
    if (key.toUpperCase() !== 'PATH' && parentEnv[key] !== undefined) env[key] = parentEnv[key];
  }
  // win32: Qt bin 을 맨 앞에, 그 뒤로 시스템 폴더만(부모 PATH 무상속). 시스템 폴더에는 Qt DLL 이 없다(step0 `where Qt6Core.dll` 0건).
  const systemRoot = platform === 'win32' ? parentEnv.SystemRoot : undefined;
  const pathParts = [String(qtBinDir)];
  if (systemRoot) pathParts.push(`${systemRoot}\\System32`, systemRoot);
  env.PATH = pathParts.join(platform === 'win32' ? ';' : ':');
  env.CLIENT_USER_DATA = String(userDataDir);
  env.CLIENT_DIAG_FILE = String(diagFile);
  env.CLIENT_SELFTEST = '1'; // 창을 띄우지 않는다(검증이 데스크톱을 점유하지 않는다) — 보안 경계가 아닌 사고 방지 장치(ADR-018).
  return env;
}
