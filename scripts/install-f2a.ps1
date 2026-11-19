#Requires -Version 5.1
param(
    [string]$InstallDirectory = (Join-Path $env:APPDATA 'Adobe\CEP\extensions\F2A'),
    [string]$SkillDirectory,
    [switch]$Update
)

$ErrorActionPreference = 'Stop'
$f2aTarget = [IO.Path]::GetFullPath($InstallDirectory)
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
$f2aNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$f2aPython = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $f2aNode -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 && process.arch === 'x64' ? 0 : 1)"
if ($LASTEXITCODE -ne 0) { throw 'Install Node.js 20+ (x64), then run install.cmd again.' }
& $f2aPython -c "import sys,struct,tkinter,venv; sys.exit(0 if sys.version_info >= (3,11) and struct.calcsize('P') == 8 else 1)"
if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.11+ (x64) with pip and Tcl/Tk, then run install.cmd again.' }

$f2aLock = New-Object System.Threading.Mutex($false, 'Local\F2A-AEP-Start')
$f2aHasLock = $false
try {
    try { $f2aHasLock = $f2aLock.WaitOne(60000) }
    catch [System.Threading.AbandonedMutexException] { $f2aHasLock = $true }
    if (-not $f2aHasLock) { throw 'F2A is already installing or starting. Try again.' }
    if (Test-Path -LiteralPath (Join-Path $f2aTarget '.git')) { throw 'Choose a CEP install directory for the F2A package.' }

    $f2aVenv = Join-Path $f2aTarget '.venv-aep\Scripts\python.exe'
    [void](New-Item -ItemType Directory -Path $f2aTarget -Force)
    if (-not (Test-Path -LiteralPath $f2aVenv)) {
        & $f2aPython -m venv (Join-Path $f2aTarget '.venv-aep')
        if ($LASTEXITCODE -ne 0) { throw 'Cannot create the F2A Python environment.' }
    }

    $f2aRequirements = Join-Path $PSScriptRoot 'aep\requirements.txt'
    $f2aOldRequirements = Join-Path $f2aTarget 'scripts\aep\requirements.txt'
    $f2aInstalledDeps = $false
    $f2aUnchangedDeps = $Update -and (Test-Path -LiteralPath $f2aOldRequirements) -and
        ([IO.File]::ReadAllText($f2aRequirements) -ceq [IO.File]::ReadAllText($f2aOldRequirements))
    if ($f2aUnchangedDeps) {
        & $f2aVenv -c 'import py_aep,tkinter,uharfbuzz'
        $f2aInstalledDeps = $LASTEXITCODE -eq 0
    }
    try {
        if (-not $f2aInstalledDeps) {
            & $f2aVenv -m pip install --disable-pip-version-check -r $f2aRequirements
            if ($LASTEXITCODE -ne 0) { throw 'Cannot install AEP dependencies. Check the network and try again.' }
            & $f2aVenv -c 'import py_aep,tkinter,uharfbuzz'
            if ($LASTEXITCODE -ne 0) { throw 'The AEP Python dependencies are incomplete.' }
        }
        $f2aArgs = @((Join-Path $PSScriptRoot 'install-files.cjs'), $f2aTarget)
        if ($SkillDirectory) { $f2aArgs += $SkillDirectory }
        & $f2aNode @f2aArgs
        if ($LASTEXITCODE -ne 0) { throw 'Cannot synchronize F2A files.' }
    } catch {
        if ($Update -and -not $f2aUnchangedDeps -and (Test-Path -LiteralPath $f2aOldRequirements)) {
            & $f2aVenv -m pip install --disable-pip-version-check -r $f2aOldRequirements
        }
        throw
    }

    if (-not $Update) {
        foreach ($f2aVersion in 9..12) {
            $f2aKey = 'HKCU:\Software\Adobe\CSXS.' + $f2aVersion
            [void](New-Item -Path $f2aKey -Force)
            New-ItemProperty -Path $f2aKey -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
        }
        & (Join-Path $f2aTarget 'scripts\install-aep-launcher.ps1')
    }
    Write-Output ('Installed: ' + $f2aTarget)
    Write-Output ('Figma plugin: ' + (Join-Path $f2aTarget 'figma-plugin\manifest.json'))
    Write-Output 'Restart After Effects and Figma, then open the F2A panel.'
} finally {
    if ($f2aHasLock) { $f2aLock.ReleaseMutex() }
    $f2aLock.Dispose()
}
