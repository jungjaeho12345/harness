// P0-b Qt 에디터 스파이크 — 모드: --selftest(JSON 한 줄 + exit 코드) / --screenshot <png> / (없음) 대화형 창.
#include "editorwidget.h"
#include "selftest.h"
#include <QApplication>
#include <QFont>
#include <QPixmap>
#include <cstdio>
#include <cstring>

static bool hasArg(int argc, char **argv, const char *name) {
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], name) == 0) return true;
  }
  return false;
}

int main(int argc, char **argv) {
  // selftest는 오프스크린 강제(러너가 환경 없이 실행해도 결정적) — 외부 지정이 있으면 존중.
  if (hasArg(argc, argv, "--selftest") && !qEnvironmentVariableIsSet("QT_QPA_PLATFORM"))
    qputenv("QT_QPA_PLATFORM", "offscreen");
  QApplication app(argc, argv);
  if (hasArg(argc, argv, "--selftest")) return runSelftest();

  // 시각 증거/대화형 — 한글 렌더는 시스템 맑은 고딕.
  EditorWidget w;
  w.setFont(QFont(QStringLiteral("Malgun Gothic"), 11));
  w.resize(680, 420);
  w.loadSample(QStringLiteral(
      "제목: Qt 에디터 코어 스파이크 (P0-b)\n"
      "부제1: 줄 역할 색상 — 제목 파랑(#0a4da6)\n"
      "부제2: 부제 빨강(#c8102e), \"(끝)\" 골드\n"
      "부제3: 한글 IME 조합 무개입 검증\n"
      "부제4: 마커 뒤 입력 차단 검증\n"
      "본문 첫 줄입니다. 한글 렌더링 확인용 문장.\n"
      "본문 둘째 줄 — 색상은 잉크(#1a1a1a)다.\n"
      "(끝)"));
  for (int i = 1; i < argc - 1; ++i) {
    if (std::strcmp(argv[i], "--screenshot") == 0) {
      const bool ok = w.grab().save(QString::fromLocal8Bit(argv[i + 1]));
      std::printf("{\"screenshot\":%s}\n", ok ? "true" : "false");
      return ok ? 0 : 1;
    }
  }
  w.setWindowTitle(QStringLiteral("P0-b Qt 에디터 스파이크"));
  w.show();
  return app.exec();
}
