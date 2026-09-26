param([Parameter(Mandatory=$true)][string]$Path)
# Parse-check helper (ASCII only, no BOM needed): used to prove a .ps1 still parses
# under Windows PowerShell 5.1 -- a missing UTF-8 BOM makes PS 5.1 read the file as
# ANSI/GBK and explode with dozens of "Unexpected token" errors.
$e = $null
[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $Path).Path, [ref]$null, [ref]$e)
if ($e.Count -eq 0) {
    Write-Host ('parse errors = 0  (' + $Path + ')')
} else {
    Write-Host ('parse errors = ' + $e.Count + '  (' + $Path + ')')
    $e | Select-Object -First 6 | ForEach-Object {
        Write-Host ('  L' + $_.Extent.StartLineNumber + ': ' + $_.Message)
    }
    exit 1
}
