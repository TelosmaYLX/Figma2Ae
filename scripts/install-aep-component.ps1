param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'F2A\AEP'))

$ErrorActionPreference = 'Stop'
$aepSource = Split-Path -Parent $PSScriptRoot
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
if (-not (Test-Path -LiteralPath (Join-Path $aepSource 'runtime\python\python.exe'))) { throw 'Use the Windows x64 distribution package.' }
$aepTarget = [System.IO.Path]::GetFullPath($InstallDirectory)
[void](New-Item -ItemType Directory -Path $aepTarget -Force)
if ($aepSource -ne $aepTarget) {
    # Updating a component may replace its runtime; stop only executables installed here.
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'python.exe' OR Name = 'pythonw.exe'" | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($aepTarget + '\', [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object {
        $aepProcess = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($aepProcess) {
            Stop-Process -InputObject $aepProcess -Force
            if (-not $aepProcess.WaitForExit(10000)) { throw 'Cannot stop the previous AEP export component.' }
        }
    }
    foreach ($aepPart in @('runtime', 'scripts', 'host', 'figma-plugin', 'cep-extension', 'mcp', 'runtime-manifest.json', 'README.txt')) {
        Copy-Item -LiteralPath (Join-Path $aepSource $aepPart) -Destination $aepTarget -Recurse -Force
    }
}
& (Join-Path $aepTarget 'scripts\install-aep-launcher.ps1')
Write-Output ('Installed: ' + $aepTarget)
Write-Output ('Figma plugin: ' + (Join-Path $aepTarget 'figma-plugin\manifest.json'))
