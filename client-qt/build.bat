@echo off
setlocal
rem phase 77 (P4) - build both client-qt targets and run the test binary.
rem Exits non-zero if the build fails, if the tests fail, or if no totals line was printed.
rem
rem VsDevCmd is broken on this machine (SDK wiring), so MSVC + Windows SDK env is set
rem explicitly. The four env values below are copied verbatim from the P0-verified recipe
rem in spikes/p0-qt-editor/build.bat - do not reinvent them.
rem ASCII only in this file: cmd parses batch files as cp949 while repo files are UTF-8.
call "%~dp0env.bat" || exit /b 1
set "MSVC=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.50.35717"
set "SDK=C:\Program Files (x86)\Windows Kits\10"
set "SDKVER=10.0.26100.0"
set "PATH=%MSVC%\bin\HostX64\x64;%SDK%\bin\%SDKVER%\x64;%PATH%"
set "INCLUDE=%MSVC%\include;%SDK%\Include\%SDKVER%\ucrt;%SDK%\Include\%SDKVER%\um;%SDK%\Include\%SDKVER%\shared;%SDK%\Include\%SDKVER%\winrt"
set "LIB=%MSVC%\lib\x64;%SDK%\Lib\%SDKVER%\ucrt\x64;%SDK%\Lib\%SDKVER%\um\x64"
cd /d "%~dp0"

set "TESTLOG=%TEMP%\client-qt-tests.log"
if exist "%TESTLOG%" del /q "%TESTLOG%"

qmake.exe client-qt.pro || exit /b 1
nmake /nologo || exit /b 1

if not exist "release\news-client.exe" (
  echo BUILD FAILED: release\news-client.exe missing
  exit /b 1
)
if not exist "tests\release\client-qt-tests.exe" (
  echo BUILD FAILED: tests\release\client-qt-tests.exe missing
  exit /b 1
)

tests\release\client-qt-tests.exe > "%TESTLOG%" 2>&1
set "TESTRC=%ERRORLEVEL%"
type "%TESTLOG%"
if not "%TESTRC%"=="0" (
  echo BUILD FAILED: test runner exited %TESTRC%
  exit /b 1
)

rem Vacuity guard (mutation M0-1): a green has to be backed by a printed totals line with
rem at least one passed test and zero failures. Without this check, deleting the line that
rem runs the test binary would leave build.bat exiting 0 with no test evidence at all.
findstr /r /c:"Totals: [1-9][0-9]* passed, 0 failed (classes: [1-9]" "%TESTLOG%" >nul || (
  echo BUILD FAILED: no green totals line in test output
  exit /b 1
)

echo BUILD OK
exit /b 0
