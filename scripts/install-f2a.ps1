#Requires -Version 5.1
param([string]$InstallDirectory = (Join-Path $env:APPDATA 'Adobe\CEP\extensions\F2A'))

$ErrorActionPreference = 'Stop'
$f2aSource = Split-Path -Parent $PSScriptRoot
$f2aTarget = [IO.Path]::GetFullPath($InstallDirectory)
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
$f2aNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$f2aPython = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $f2aNode -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 && process.arch === 'x64' ? 0 : 1)"
if ($LASTEXITCODE -ne 0) { throw 'Install Node.js 20+ (x64), then run install.cmd again.' }
& $f2aPython -c "import sys,struct,tkinter,venv; sys.exit(0 if sys.version_info >= (3,11) and struct.calcsize('P') == 8 else 1)"
if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.11+ (x64) with pip and Tcl/Tk, then run install.cmd again.' }

$f2aManifest = Get-Content -LiteralPath (Join-Path $f2aSource 'package-manifest.json') -Raw | ConvertFrom-Json
if ($f2aSource -ne $f2aTarget) {
    foreach ($f2aEntry in $f2aManifest.files) {
        $f2aDestination = Join-Path $f2aTarget $f2aEntry.path
        [void](New-Item -ItemType Directory -Path (Split-Path -Parent $f2aDestination) -Force)
        Copy-Item -LiteralPath (Join-Path $f2aSource $f2aEntry.path) -Destination $f2aDestination -Force
    }
    Copy-Item -LiteralPath (Join-Path $f2aSource 'package-manifest.json') -Destination $f2aTarget -Force
}
$f2aVenv = Join-Path $f2aTarget '.venv-aep\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $f2aVenv)) {
    & $f2aPython -m venv (Join-Path $f2aTarget '.venv-aep')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create the F2A Python environment.' }
}
& $f2aVenv -m pip install --disable-pip-version-check -r (Join-Path $f2aTarget 'scripts\aep\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Cannot install AEP dependencies. Check the network and run install.cmd again.' }
& $f2aVenv -c 'import py_aep,tkinter,uharfbuzz'
if ($LASTEXITCODE -ne 0) { throw 'The AEP Python dependencies are incomplete.' }

foreach ($f2aVersion in 9..12) {
    $f2aKey = 'HKCU:\Software\Adobe\CSXS.' + $f2aVersion
    [void](New-Item -Path $f2aKey -Force)
    New-ItemProperty -Path $f2aKey -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
}
& (Join-Path $f2aTarget 'scripts\install-aep-launcher.ps1')
Write-Output ('Installed: ' + $f2aTarget)
Write-Output ('Figma plugin: ' + (Join-Path $f2aTarget 'figma-plugin\manifest.json'))
Write-Output 'Restart After Effects and Figma, then open the F2A panel.'
