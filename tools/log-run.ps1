# ASCII-only wrapper: run a command, echo its output to this console, and also
# append it to a UTF-8 log file. Used for launching DSH, whose startup line
# carries the launch token that qq-bridge auto-discovers from
# ~/.dsh/guard/logs/server-*.out.log.
#
# Why this file is ASCII-only and takes plain arguments: it is invoked from a
# cmd pipe (`... | powershell -File log-run.ps1 <log> <cmd> <args...>`), and
# Windows PowerShell 5.1 parses .ps1 files as UTF-8 only when they carry a BOM.
#
# IMPORTANT: do not switch this to Tee-Object. PS 5.1's Tee-Object writes
# UTF-16LE by default, which qq-bridge reads as garbage (NUL-interleaved text)
# and can never match a token in. Out-File -Encoding utf8 is required.

# NOTE: no param() block on purpose. A mandatory parameter would make PowerShell
# try to bind the piped stdin object to it, so arguments are read from $args.

$LogPath = $args[0]
$Cmd = $args[1]
$CmdArgs = if ($args.Count -gt 2) { $args[2..($args.Count - 1)] } else { @() }
if (-not $LogPath) { Write-Host 'usage: ... | powershell -File log-run.ps1 <logPath> <cmd> [args...]'; exit 2 }

$resolved = [System.IO.Path]::GetFullPath($LogPath)
$dir = [System.IO.Path]::GetDirectoryName($resolved)
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

# Streaming write, verified by experiment (compare of four variants):
#   `$input | Out-File -Encoding utf8`  -> grows live, UTF-8 (EF BB BF), no NUL, readable while running
#   `$input | Tee-Object -Encoding utf8`-> in a cmd pipe this produced NO file at all
#   `[Console]::In.ReadToEnd()` + write -> correct encoding but only written after the child exits,
#                                          so qq-bridge cannot see the token while DSH runs
# So: keep Out-File with an explicit -Encoding utf8. Never drop the -Encoding (PS 5.1 defaults
# to UTF-16LE) and never switch to Tee-Object here.
"# log-run: $Cmd $($CmdArgs -join ' ') @ $(Get-Date -Format s)" |
    Out-File -FilePath $resolved -Encoding utf8

$input | Out-File -FilePath $resolved -Encoding utf8 -Append
