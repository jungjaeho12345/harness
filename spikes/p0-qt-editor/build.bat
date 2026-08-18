@echo off
rem VsDevCmd is broken on this machine (SDK wiring) - set MSVC+WinSDK env explicitly (qt-smoke verified recipe).
rem ASCII only in this file: cmd parses batch as cp949 while repo files are UTF-8.
set "MSVC=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.50.35717"
set "SDK=C:\Program Files (x86)\Windows Kits\10"
set "SDKVER=10.0.26100.0"
set "PATH=%MSVC%\bin\HostX64\x64;%SDK%\bin\%SDKVER%\x64;D:\agents\tools\Qt\6.8.3\msvc2022_64\bin;%PATH%"
set "INCLUDE=%MSVC%\include;%SDK%\Include\%SDKVER%\ucrt;%SDK%\Include\%SDKVER%\um;%SDK%\Include\%SDKVER%\shared;%SDK%\Include\%SDKVER%\winrt"
set "LIB=%MSVC%\lib\x64;%SDK%\Lib\%SDKVER%\ucrt\x64;%SDK%\Lib\%SDKVER%\um\x64"
cd /d "%~dp0"
qmake.exe spike.pro || exit /b 1
nmake /nologo || exit /b 1
release\spike.exe --selftest
