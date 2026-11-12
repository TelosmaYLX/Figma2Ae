# Register a click-to-launch URI for the current user. This adds no logon task.
$ErrorActionPreference = 'Stop'
$aepLauncher = Join-Path $PSScriptRoot 'start-aep-export.ps1'
$aepPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$aepRoot = Split-Path -Parent $PSScriptRoot
$aepNode = Join-Path $aepRoot 'runtime\node\node.exe'
$aepPython = Join-Path $aepRoot 'runtime\python\python.exe'
if (-not (Test-Path -LiteralPath $aepNode)) { $aepNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source }
if (-not (Test-Path -LiteralPath $aepPython)) { $aepPython = (Get-Command python -CommandType Application | Select-Object -First 1).Source }
# The URI is intentionally not passed through: the only action is starting this service.
$aepCommand = '"' + $aepPowerShell + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $aepLauncher + '" -Background -NodePath "' + $aepNode + '" -PythonPath "' + $aepPython + '"'
$aepKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\f2a-aep')
try {
    $aepKey.SetValue('', 'URL:F2A AEP Export')
    $aepKey.SetValue('URL Protocol', '')
    $aepOpenCommand = $aepKey.CreateSubKey('shell\open\command')
    try { $aepOpenCommand.SetValue('', $aepCommand) } finally { $aepOpenCommand.Dispose() }
} finally { $aepKey.Dispose() }
Write-Output 'Installed F2A AEP click-to-launch handler.'
