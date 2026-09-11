@echo off
setlocal
rem phase 77 (P4) - start news-client.exe with the Qt runtime on PATH, forwarding all args.
rem
rem Qt is linked dynamically: launching release\news-client.exe from a bare shell dies on a
rem missing Qt DLL. Every place where a human starts the app goes through this file. The
rem only exception is the step6 verification driver, which spawns the exe directly and sets
rem the very same PATH itself (env.bat is the single source of the Qt path).
rem ASCII only in this file: cmd parses batch files as cp949 while repo files are UTF-8.
call "%~dp0env.bat" || exit /b 1

if not exist "%~dp0release\news-client.exe" (
  echo run.bat: release\news-client.exe not found - run build.bat first
  exit /b 1
)

"%~dp0release\news-client.exe" %*
exit /b %ERRORLEVEL%
