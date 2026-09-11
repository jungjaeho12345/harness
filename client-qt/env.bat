@echo off
rem phase 77 (P4) - Qt runtime environment shared by build.bat and run.bat.
rem Qt is linked dynamically, so every launcher needs the Qt bin directory on PATH.
rem Path value copied verbatim from spikes/p0-qt-editor/build.bat (the P0-verified recipe).
rem ASCII only in this file: cmd parses batch files as cp949 while repo files are UTF-8.
set "QTDIR=D:\agents\tools\Qt\6.8.3\msvc2022_64"
set "PATH=%QTDIR%\bin;%PATH%"
