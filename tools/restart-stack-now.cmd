@echo off
rem ============================================================
rem  restart-stack-now -- the "restart EVERYTHING, right now" button.
rem
rem  Why it exists (owner, 2026-09-25): "the full start/restart is something
rem  you (the sessions) should be able to do yourselves". Sessions now fire
rem  one HTTP request at the control plane (port 3101, action restart-stack);
rem  THIS file is the human fallback for when that path is unusable (control
rem  plane down, token gone, nobody to send the request).
rem
rem  What it runs:  tools\control.ps1 restart-stack -Force
rem    * -Force ignores the on-disk single-flight marker (you asked by hand,
rem      so your click always wins over a marker left by an earlier attempt).
rem    * the real worker is the repo-root launcher cmd (its Chinese file name is written
rem      in the owner's language; spelled here in ASCII on purpose -- see the note below): it
rem      cleans up (stop-all.ps1) and then
rem      starts the three services fresh -- exactly what double-clicking that
rem      file and picking [1] does. There is no second start path here.
rem
rem  It prints a receipt and returns at once: the restart itself runs in a
rem  detached process, so this window may be closed right away.
rem
rem  ASCII only on purpose (cmd parses .cmd with the OEM code page).
rem ============================================================
chcp 65001 >nul
setlocal
rem Tell the boot ledger WHO is knocking (2026-09-25): the launcher records this tag in
rem qq-bridge\state\_tmp\launcher-boot.jsonl, so "who started the stack at 20:29" is ONE line.
rem control.ps1 does NOT overwrite a tag that is already set -- this one knows best.
set DSH_LAUNCHER_CALLER=owner-dblclick
echo Restarting the whole stack: DSH Web + qq-bridge + SnowLuma ...
echo (clean up first, then start all three -- takes a minute or two)
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0control.ps1" restart-stack -Force
echo.
echo exit code: %errorlevel%   (0 = accepted, restart continues in the background)
pause
