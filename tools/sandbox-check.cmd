@echo off
rem ============================================================================
rem  sandbox-check.cmd -- Double-click THIS to run the clean-machine check.
rem
rem  Why a .cmd wrapper: the Windows Sandbox CANNOT be started from inside the
rem  DSH agent session (its file sandbox denies writes outside the workspace,
rem  so the sandbox client dies with "0x80070005 Access is denied"). A normal
rem  double-click from the desktop has no such limit, so this wrapper exists to
rem  be launched by the human, not by the agent.
rem
rem  What it does: runs tools\sandbox-clean-install.ps1 -Yes, which packs the
rem  delivery bundle, maps ONLY that temp folder into a fresh Windows Sandbox,
rem  runs tools\setup-all.ps1 inside it, writes a transcript back, and then
rem  shuts the sandbox down by itself.
rem
rem  NOTE: this file must stay PURE ASCII (cmd.exe parses .cmd in the OEM code
rem  page; non-ASCII characters break it). Keep all Chinese text in the .ps1.
rem ============================================================================
setlocal
cd /d "%~dp0.."
echo ============================================================
echo  DSH clean-machine check  (Windows Sandbox)
echo  Repo root: %CD%
echo ============================================================
echo.
echo  WARNING - this run WILL disturb this PC for a few minutes:
echo    * Windows Sandbox creates a virtual network adapter and uses
echo      several GB of RAM, so the DSH session, the bridge and SnowLuma
echo      lose their connections.
echo    * The QQ bot will be OFFLINE while the sandbox runs.
echo    * The sandbox shuts itself down when done; things recover after that.
echo    * Do NOT run this when you need the bot online.
echo.
echo  A sandbox window will open ONCE and shut itself down.
echo  Result: the full transcript is printed here when it finishes.
echo.
pause
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sandbox-clean-install.ps1" -Yes %*
set RC=%ERRORLEVEL%
echo.
echo ------------------------------------------------------------
echo  Exit code: %RC%   (0 = all four checks passed, 2 = preflight refused,
echo                     3 = packaging/safety gate, 4 = sandbox did not finish)
echo ------------------------------------------------------------
echo.
pause
endlocal
