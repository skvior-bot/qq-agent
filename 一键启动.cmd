@echo off
rem ============================================================
rem  One-click launcher AND closer: DSH Web + SnowLuma + qq-bridge
rem  (2026-09-23: the separate "close everything" .cmd is merged into this
rem   file -- use `close` for that job now)
rem
rem  All logic lives in the PowerShell scripts under tools\ ; this file stays
rem  ASCII-only on purpose: cmd parses .cmd with the OEM code page and would
rem  mangle CJK text.
rem
rem  Usage:
rem    * double-click            -> 4s menu, default = start everything.
rem                                 STARTING ALWAYS CLEANS UP FIRST: whatever is
rem                                 still running (DSH / SnowLuma / qq-bridge /
rem                                 panels) is closed by tools\stop-all.ps1, then
rem                                 the three services come up fresh.
rem    * <this file> close       -> CLOSE EVERYTHING (tools\stop-all.ps1).
rem                                 Extra args are passed through, so
rem                                 `close -DryRun` (= only list) and
rem                                 `close -KeepPanels` (= keep the browser
rem                                 window) work too. `stop` is an alias.
rem    * <this file> login       -> only log in to the SnowLuma admin page
rem                                 (no restart, safe while DSH is running;
rem                                  = tools\control.ps1 login qq: fresh token
rem                                  + the page, opened by the single opener)
rem    * <this file> -NoClean    -> skip the cleanup, only restart DSH
rem                                 (keeps SnowLuma + qq-bridge running)
rem    * <this file> -NoRestart  -> no cleanup and no restart: just start
rem                                 whatever is missing
rem    * <this file> -NoOpen     -> do not open any page in the browser
rem    * <this file> -Open       -> open the three pages (NOT the default any more)
rem                                 (DSH + console + SnowLuma) open as new TABS
rem                                 in the browser window you are already using
rem                                 -- no extra window. Only DSH: run
rem                                 tools\panels.ps1 open -DshOnly
rem    * <this file> -NoPanels   -> old name of -NoOpen, still accepted
rem
rem  This window closes itself when the launcher finishes, so the only
rem  windows left are the ones that must stay: the DSH-Web, SnowLuma and
rem  qq-bridge windows (opened normally, then minimized together once
rem  everything is up).
rem
rem  The DSH-Web window doubles as the master switch: when DSH stops, type
rem  `exit` there to close EVERYTHING, or just press Enter to restart DSH
rem  alone (that prompt lives in tools\dsh-window.cmd).
rem ============================================================
chcp 65001 >nul
setlocal

rem --- explicit arguments: script-friendly, no menu -------------------------
if "%~1"=="" goto :menu
if /i "%~1"=="close" goto :close
if /i "%~1"=="stop" goto :close
if /i "%~1"=="shutdown" goto :close
if /i "%~1"=="login" goto :snowluma
if /i "%~1"=="snowluma" goto :snowluma
goto :startall

rem --- double-clicked: tiny menu, auto-continues with "start everything" ----
:menu
choice /c 123 /n /t 4 /d 1 /m "[1] Start everything (cleans up first, default in 4s)  [2] SnowLuma login only  [3] CLOSE everything: "
rem choice returns 255 when there is no console (called by a script) -> default
rem NOTE: "if errorlevel N" means ">= N", so test from the highest number down.
if errorlevel 255 goto :startall
if errorlevel 3 goto :close
if errorlevel 2 goto :snowluma
goto :startall


:startall
rem Announce cleanup only when it will really happen: start-all.ps1 skips it for -DryRun / -NoClean / -NoRestart.
echo %* | findstr /i /c:"-DryRun" /c:"-NoClean" /c:"-NoRestart" >nul || echo Cleaning up what is still running, then starting DSH Web + SnowLuma + qq-bridge ...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-all.ps1" %*
exit /b %errorlevel%

:close
echo Closing DSH Web + SnowLuma + qq-bridge ...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-all.ps1" %2 %3 %4 %5
if errorlevel 1 pause
exit /b %errorlevel%

:snowluma
echo Logging in to the SnowLuma admin page ...
rem 2026-09-24: goes through the ONE action source (tools\control.ps1 login qq),
rem which gets a fresh token AND opens the page via tools\panels.ps1 -- the login
rem script itself no longer starts a browser (two openers = duplicate tabs).
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\control.ps1" login qq
if errorlevel 1 pause
exit /b %errorlevel%
