// P0-b 자동 검증 — 4축: T1 색상 / T2 마커 게이트 / T3 IME 조합 / T4 캐럿 복원.
// 결과는 JSON 한 줄(stdout, 실패명은 ASCII만 — cp949 콘솔 오염 방지)·exit 코드(0=go)로 낸다.
// 프로덕션 DB·서버에 바인딩하지 않는다 — 위젯 인스턴스 in-memory 검증만.
#include "selftest.h"
#include "editorlogic.h"
#include "editorwidget.h"
#include <QApplication>
#include <QClipboard>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QKeyEvent>
#include <QTest>
#include <QTextBlock>
#include <cstdio>

using editorlogic::Role;

namespace {

struct Checks {
  int pass = 0;
  QJsonArray failed;
  void add(const char *name, bool ok) {
    if (ok) ++pass;
    else failed.append(QString::fromLatin1(name));
  }
};

// 7줄 샘플 — 웹 classifyLines 기준: 0=제목, 1~4=부제, 5=본문, 6="(끝)".
// (5줄 샘플이면 4번째 줄이 인덱스 3 = 부제 구간이라 body 케이스가 생기지 않는다 — 웹 계약 그대로 따른다.)
QString sample7() {
  return QStringLiteral("제목 줄\n부제1\n부제2\n부제3\n부제4\n본문 첫 줄입니다.\n(끝)");
}

// 부제 구간 빈 줄 케이스 — 인덱스 2가 빈 줄 → 인덱스 1부터 전부 본문(마커 제외).
QString sampleBlank() {
  return QStringLiteral("제목 줄\n부제1\n\n셋째 줄\n(끝)");
}

// 하이라이터가 실제로 칠한 블록 전경색(charFormat) — 내부 캐시가 아니라 QTextLayout 포맷을 읽는다.
QColor appliedColor(const QTextBlock &b) {
  const auto ranges = b.layout()->formats();
  for (const auto &r : ranges) {
    if (r.start == 0 && r.length > 0 && r.format.hasProperty(QTextFormat::ForegroundBrush))
      return r.format.foreground().color();
  }
  return QColor();
}

bool blockHasColor(const EditorWidget &w, int blockNumber, const char *hex) {
  const QTextBlock b = w.document()->findBlockByNumber(blockNumber);
  return b.isValid() && appliedColor(b) == QColor(QString::fromLatin1(hex));
}

void caretTo(EditorWidget &w, int pos) {
  QTextCursor c = w.textCursor();
  c.setPosition(pos);
  w.setTextCursor(c);
}

// T1 — 줄 역할 색상: 순수 분류(웹 동형) + 위젯 charFormat 실측.
Checks t1() {
  Checks c;
  {
    const auto roles = editorlogic::classifyLines(sample7().split(QLatin1Char('\n')));
    c.add("t1.classify.count", roles.size() == 7);
    c.add("t1.classify.roles", roles.size() == 7 && roles[0] == Role::Title && roles[1] == Role::Subtitle
          && roles[4] == Role::Subtitle && roles[5] == Role::Body && roles[6] == Role::End);
    const auto blank = editorlogic::classifyLines(sampleBlank().split(QLatin1Char('\n')));
    c.add("t1.classify.blankRule", blank.size() == 5 && blank[1] == Role::Body
          && blank[3] == Role::Body && blank[4] == Role::End);
  }
  {
    EditorWidget w;
    w.loadSample(sample7());
    c.add("t1.color.title", blockHasColor(w, 0, "#0a4da6"));
    c.add("t1.color.subtitle", blockHasColor(w, 1, "#c8102e") && blockHasColor(w, 4, "#c8102e"));
    c.add("t1.color.body", blockHasColor(w, 5, "#1a1a1a"));
    c.add("t1.color.end", blockHasColor(w, 6, "#d4af37"));
    w.loadSample(sampleBlank());
    c.add("t1.color.blankRule", blockHasColor(w, 1, "#1a1a1a") && blockHasColor(w, 3, "#1a1a1a")
          && blockHasColor(w, 4, "#d4af37"));
  }
  return c;
}

// T2 — "(끝)" 마커 게이트: 마커 시작 오프셋 이상 삽입 차단, 삭제·마커 앞 삽입 허용.
Checks t2() {
  Checks c;
  {
    // 순수 경계 — "AB\n(끝)" 마커 시작 = 3 (lastIndexOf).
    const QString t = QStringLiteral("AB\n(끝)");
    c.add("t2.pure.beforeMarker", !editorlogic::isInputBlocked(t, 2));
    c.add("t2.pure.atMarkerStart", editorlogic::isInputBlocked(t, 3));
    c.add("t2.pure.afterMarker", editorlogic::isInputBlocked(t, int(t.size())));
    c.add("t2.pure.noMarker", !editorlogic::isInputBlocked(QStringLiteral("AB"), 2));
  }
  const QString base = sample7();
  {
    EditorWidget w; w.loadSample(base);
    caretTo(w, int(base.size())); // 문서 끝(마커 뒤)
    QTest::keyClicks(&w, QStringLiteral("abc"));
    c.add("t2.typeBlocked", w.toPlainText() == base);
    QTest::keyClick(&w, Qt::Key_Return);
    c.add("t2.enterBlocked", w.toPlainText() == base);
  }
  {
    EditorWidget w; w.loadSample(base);
    caretTo(w, int(base.lastIndexOf(editorlogic::END_MARKER))); // 마커 시작 오프셋(경계값)
    QTest::keyClicks(&w, QStringLiteral("x"));
    c.add("t2.typeAtMarkerStartBlocked", w.toPlainText() == base);
  }
  {
    EditorWidget w; w.loadSample(base);
    w.focusLineStart(0);
    QTest::keyClicks(&w, QStringLiteral("X"));
    c.add("t2.typeAllowedBefore", w.toPlainText() == QStringLiteral("X") + base);
  }
  {
    EditorWidget w; w.loadSample(base);
    const int before = w.document()->blockCount();
    const QTextBlock body = w.document()->findBlockByNumber(5);
    caretTo(w, body.position() + int(body.text().size())); // 본문 줄 끝(마커 '\n' 직전 — 허용 구간)
    QTest::keyClick(&w, Qt::Key_Return);
    c.add("t2.enterAllowedBefore", w.document()->blockCount() == before + 1);
  }
  {
    EditorWidget w; w.loadSample(base);
    caretTo(w, int(base.size())); // 마커 줄 끝 — 삭제는 허용 계약
    QTest::keyClick(&w, Qt::Key_Backspace);
    c.add("t2.backspaceAllowed", w.toPlainText() == base.left(base.size() - 1));
  }
  {
    EditorWidget w; w.loadSample(base);
    QApplication::clipboard()->setText(QStringLiteral("PASTE"));
    caretTo(w, int(base.size()));
    w.paste();
    c.add("t2.pasteBlocked", w.toPlainText() == base);
    w.focusLineStart(0);
    w.paste();
    c.add("t2.pasteAllowed", w.toPlainText().startsWith(QStringLiteral("PASTE")));
  }
  return c;
}

// T3 — IME 조합: preedit "ㅎ"→"하"→"한" → commit "한" 시퀀스 주입.
// 허용 구간: "한" 정확 1회 삽입·캐럿 정확·조합 중 재분류 0·종료 시 1회. 차단 구간: 문서 불변.
Checks t3() {
  Checks c;
  const QString base = sample7();
  {
    EditorWidget w; w.loadSample(base);
    const QTextBlock body = w.document()->findBlockByNumber(5);
    const int insertPos = body.position() + 2; // 본문 줄 중간
    caretTo(w, insertPos);
    const int recolorBefore = w.reclassifyCount();
    const auto hanBefore = base.count(QStringLiteral("한"));

    const QString steps[] = { QStringLiteral("ㅎ"), QStringLiteral("하"), QStringLiteral("한") };
    bool composingOk = true, docUntouched = true, noRecolor = true, caretStable = true;
    for (const QString &pre : steps) {
      QInputMethodEvent ev(pre, {});
      QApplication::sendEvent(&w, &ev);
      composingOk = composingOk && w.isComposing();
      docUntouched = docUntouched && (w.toPlainText() == base);
      noRecolor = noRecolor && (w.reclassifyCount() == recolorBefore);
      caretStable = caretStable && (w.textCursor().position() == insertPos); // 조합 중 캐럿 튐 0
    }
    c.add("t3.composingFlag", composingOk);
    c.add("t3.preeditNotInDoc", docUntouched);
    c.add("t3.noRecolorDuringComposition", noRecolor);
    c.add("t3.caretStableDuringComposition", caretStable);

    QInputMethodEvent commit(QString(), {});
    commit.setCommitString(QStringLiteral("한"));
    QApplication::sendEvent(&w, &commit);

    const QString now = w.toPlainText();
    c.add("t3.commitOnce", now.size() == base.size() + 1 && now.mid(insertPos, 1) == QStringLiteral("한")
          && now.count(QStringLiteral("한")) == hanBefore + 1);
    c.add("t3.caretAfterCommit", w.textCursor().position() == insertPos + 1);
    c.add("t3.composingCleared", !w.isComposing());
    c.add("t3.oneRecolorAtEnd", w.reclassifyCount() == recolorBefore + 1);
  }
  {
    EditorWidget w; w.loadSample(base);
    caretTo(w, int(base.size())); // 차단 구간(마커 뒤)
    c.add("t3.imeDisabledQuery", w.inputMethodQuery(Qt::ImEnabled).toBool() == false);
    QInputMethodEvent p1(QStringLiteral("ㅎ"), {});
    QApplication::sendEvent(&w, &p1);
    c.add("t3.blockedNoComposing", !w.isComposing());
    QInputMethodEvent p2(QStringLiteral("하"), {});
    QApplication::sendEvent(&w, &p2);
    QInputMethodEvent commit(QString(), {});
    commit.setCommitString(QStringLiteral("한"));
    QApplication::sendEvent(&w, &commit);
    c.add("t3.blockedDocUnchanged", w.toPlainText() == base);
    w.focusLineStart(0);
    c.add("t3.imeEnabledQuery", w.inputMethodQuery(Qt::ImEnabled).toBool() == true);
  }
  return c;
}

// T4 — 프로그램적 캐럿 복원: focusLineStart(2) 정확 이동 + 재로드(remount 상당) 후 복원.
Checks t4() {
  Checks c;
  const QString base = sample7();
  EditorWidget w; w.loadSample(base);
  const int line2 = w.document()->findBlockByNumber(2).position();
  w.focusLineStart(2);
  c.add("t4.focusLine2", w.textCursor().position() == line2);
  w.loadSample(base); // 재로드 — 캐럿 초기화(복원이 필요한 상황 재현)
  c.add("t4.caretResetOnReload", w.textCursor().position() == 0);
  w.focusLineStart(2);
  c.add("t4.restoreAfterReload", w.textCursor().position() == line2);
  w.focusLineStart(99); // 범위 밖 — no-op(크래시 없음·캐럿 유지)
  c.add("t4.outOfRangeNoop", w.textCursor().position() == line2);
  return c;
}

} // namespace

int runSelftest() {
  const Checks r1 = t1();
  const Checks r2 = t2();
  const Checks r3 = t3();
  const Checks r4 = t4();
  const auto obj = [](const Checks &c) {
    QJsonObject o;
    o.insert(QStringLiteral("pass"), c.pass);
    o.insert(QStringLiteral("fail"), int(c.failed.size()));
    if (!c.failed.isEmpty()) o.insert(QStringLiteral("failed"), c.failed);
    return o;
  };
  const bool go = r1.failed.isEmpty() && r2.failed.isEmpty() && r3.failed.isEmpty() && r4.failed.isEmpty();
  QJsonObject root;
  root.insert(QStringLiteral("qt"), QString::fromLatin1(qVersion()));
  root.insert(QStringLiteral("t1"), obj(r1));
  root.insert(QStringLiteral("t2"), obj(r2));
  root.insert(QStringLiteral("t3"), obj(r3));
  root.insert(QStringLiteral("t4"), obj(r4));
  root.insert(QStringLiteral("go"), go);
  std::printf("%s\n", QJsonDocument(root).toJson(QJsonDocument::Compact).constData());
  return go ? 0 : 1;
}
