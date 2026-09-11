#ifndef CLIENT_QT_UI_THEME_H
#define CLIENT_QT_UI_THEME_H

// Visual constants (phase 77 step5) - docs/UI_GUIDE.md, deliberately NOT a finished token set.
// P4 fixes four colours and the spacing scale and nothing else; the screens of step10/11 use
// these, and the full design system is not this phase's job.
//
// Tone (UI_GUIDE): a tool, newspaper density, blue leads the chrome, red is a point colour only.
// No gradients, no glow, no blur, radius 2/4/6 px only.

namespace ui {
namespace theme {

inline constexpr char kBlue[] = "#0a4da6";  // --yh-blue: header rule, primary button, labels
inline constexpr char kRed[] = "#c8102e";   // --yh-red: alerts only (errors, the stand-in notice)
inline constexpr char kInk[] = "#1a1a1a";   // --yh-ink: main text
inline constexpr char kLine[] = "#dddddd";  // --yh-gray-line: 1 px separators

// --yh-sp-* in rem at the 14 px base, rounded to whole pixels.
inline constexpr int kSpaceXs = 4;   // 0.25 rem
inline constexpr int kSpaceSm = 7;   // 0.5 rem
inline constexpr int kSpaceMd = 11;  // 0.75 rem
inline constexpr int kSpaceLg = 14;  // 1 rem
inline constexpr int kSpaceXl = 21;  // 1.5 rem

inline constexpr int kTopBarHeight = 48;  // .yh-topbar

} // namespace theme
} // namespace ui

#endif // CLIENT_QT_UI_THEME_H
