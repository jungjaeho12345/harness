// 순수 로직 — 웹 web/src/view/editorColoring.js·editorNewline.js와 동형(추후 1:1 이식 검증 대상).
// 위젯(Qt GUI) 비의존: QString/QColor만 사용해 위젯 없이 단위 판정이 가능하게 분리한다(웹 순수 모듈과 동형 구조).
#pragma once
#include <QColor>
#include <QString>
#include <QStringList>
#include <QVector>

namespace editorlogic {

// "(끝)" — 본문 종료 마커(웹 editorContent.js END_MARKER와 동일 리터럴).
extern const QString END_MARKER;

enum class Role { Title, Subtitle, Body, End };

// 라인 배열 → 라인별 역할(editorColoring.classifyLines와 동형).
//  - trim == "(끝)" 줄은 End. 첫 줄(인덱스 0)은 Title.
//  - 부제 구간(인덱스 1~4 = slice(1,5))에 빈 줄이 있으면 부제 없이 인덱스 1부터 전부 Body.
//  - 그 외 인덱스 1~4는 Subtitle, 5부터 Body.
QVector<Role> classifyLines(const QStringList &lines);

// 역할 → 색(제목 #0a4da6 / 부제 #c8102e / 본문 #1a1a1a / "(끝)" #d4af37) — editorColoring.COLORS 기본값과 동일.
QColor colorForRole(Role role);

// 캐럿 위치 삽입 차단 판정 — 마지막 "(끝)"(lastIndexOf) 시작 오프셋 "이상"이면 차단.
// 삭제/이동/선택 차단에는 쓰지 않는다(editorNewline.isInputBlocked와 동형 — UTF-16 코드유닛 오프셋).
bool isInputBlocked(const QString &text, int caretOffset);

} // namespace editorlogic
