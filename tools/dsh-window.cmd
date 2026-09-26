@echo off
rem ============================================================
rem  dsh-window.cmd -- the program that runs inside the DSH-Web window.
rem
rem  Called by tools\start-all.ps1 as:
rem    cmd /k "title DSH-Web & doskey exit=... & doskey e=... & call tools\dsh-window.cmd <node> <dsh-bin.js> <log>"
rem
rem  What it does (5th revision, 2026-09-23 -- "background DSH + foreground input"):
rem    * DSH runs as a BACKGROUND process of this same window, started by
rem      tools\dsh-prompt.ps1 -Mode run:
rem        cmd /c "node <bin.js> web --no-open 2>&1 | powershell -File log-run.ps1 <log>"
rem      The guard log must keep being written by log-run.ps1: qq-bridge discovers
rem      the DSH launch token from exactly that file.
rem    * the FOREGROUND is an input watcher, so you can type at any time -- also
rem      while DSH is running:  e / exit = close EVERYTHING,  r = restart DSH
rem      (kills it; the loop below starts a fresh one with a new log).
rem    * why not the `dsh` npm shim: it is a nested batch (so Ctrl+C asks
rem      "Terminate batch job (Y/N)?" for the inner batch), and it runs
rem      `title %COMSPEC%` -- which is what used to rename this window to
rem      C:\Windows\system32\cmd.exe so stop-all.ps1 could not find it by title.
rem    * all wording is CHINESE and lives in tools\dsh-prompt.ps1: this file must
rem      stay pure ASCII, because cmd parses .cmd with the OEM code page and
rem      would mangle CJK text.
rem
rem  Exit codes of the helper (the only thing this file looks at):
rem    0 = close everything, 1 = restart DSH, 2 = stdin exhausted (no console)
rem    = close everything, 9 = helper error = close everything,
rem    -1073741510 = Ctrl+C took the helper down too -> ask once, never spin.
rem
rem  Arguments: %1 = node.exe, %2 = ...\dsh\lib\bin.js, %3 = log file.
rem    %1/%2 empty -> legacy FOREGROUND mode (DSH in front, ask when it stops)
rem    helper gone -> legacy pure-batch English prompt (this window is the
rem                   master switch, so it must stay usable without the helper)
rem ============================================================
setlocal EnableExtensions
title DSH-Web
chcp 65001 >nul
set "TOOLS=%~dp0"
set "ROOT=%~dp0.."
set "LOG=%~3"
set "ASK=%TOOLS%dsh-prompt.ps1"
set "NODE=%~1"
set "BIN=%~2"
set "RUN=dsh"
if not "%NODE%"=="" if not "%BIN%"=="" set "RUN="%NODE%" "%BIN%""
if "%LOG%"=="" call :newlog
cd /d "%ROOT%"

:loop
if not exist "%ASK%" goto :legacy
if "%NODE%"=="" goto :foreground
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ASK%" -Mode run -Node "%NODE%" -Bin "%BIN%" -Tools "%TOOLS%." -Log "%LOG%"
call :decide %ERRORLEVEL%
if "%DECISION%"=="restart" goto :restart
if "%DECISION%"=="ask" goto :askcn
goto :shutdown

:foreground
rem ---- no node/bin path: DSH keeps the foreground, we ask after it stops ------
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ASK%" -Mode start -Log "%LOG%"
%RUN% web --no-open 2>&1 | powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%TOOLS%log-run.ps1" "%LOG%"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ASK%" -Mode prompt -Log "%LOG%"
call :decide %ERRORLEVEL%
if "%DECISION%"=="restart" goto :restart
if "%DECISION%"=="ask" goto :askcn
goto :shutdown

:askcn
rem ---- Ctrl+C killed the watcher too: ask once in Chinese, then decide --------
echo.
echo   [warn] Ctrl+C stopped the watcher as well - asking one more time
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ASK%" -Mode prompt -Log "%LOG%"
call :decide %ERRORLEVEL%
if "%DECISION%"=="restart" goto :restart
goto :shutdown

:legacy
rem ---- tools\dsh-prompt.ps1 is missing: pure-batch English fallback ----------
echo.
echo   ------------------------------------------------------------
echo    DSH starting ...   (log: %LOG%)
echo   ------------------------------------------------------------
%RUN% web --no-open 2>&1 | powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%TOOLS%log-run.ps1" "%LOG%"
echo.
echo   ============================================================
echo    DSH stopped.  tools\dsh-prompt.ps1 is missing - English fallback
echo      type  e  or  exit       =  close EVERYTHING
echo                                  DSH + SnowLuma + qq-bridge
echo      just press Enter or r   =  start DSH again only
echo   ============================================================
set "ANS=__EOF__"
set /p "ANS=DSH> "
if /i "%ANS%"=="e" goto :shutdown
if /i "%ANS%"=="exit" goto :shutdown
if /i "%ANS%"=="close" goto :shutdown
if /i "%ANS%"=="quit" goto :shutdown
if /i "%ANS%"=="q" goto :shutdown
if /i "%ANS%"=="__EOF__" goto :shutdown
goto :restart

:restart
call :newlog
goto :loop

:shutdown
echo.
echo   Closing everything (DSH + SnowLuma + qq-bridge) ...
if defined DSH_WINDOW_STOPALL (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%DSH_WINDOW_STOPALL%"
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%TOOLS%stop-all.ps1"
)
echo   Done - this window closes too.
exit

rem ---- %1 = helper exit code -> DECISION = restart | ask | shutdown -----------
:decide
set "DECISION=shutdown"
if "%~1"=="1" set "DECISION=restart"
if "%~1"=="-1073741510" set "DECISION=ask"
exit /b 0

:newlog
for /f "delims=" %%t in ('powershell.exe -NoLogo -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%t"
set "LOGDIR=%USERPROFILE%\.dsh\guard\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOG=%LOGDIR%\server-%STAMP%.out.log"
exit /b 0
