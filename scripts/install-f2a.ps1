#Requires -Version 5.1
param(
    [string]$InstallDirectory = (Join-Path $env:APPDATA 'Adobe\CEP\extensions\F2A'),
    [switch]$Update
)

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
$f2aBackups = Join-Path $f2aSource '.rollback'
$f2aReplaced = @()
try {
    if (-not $f2aInstalledDeps) {
        & $f2aVenv -m pip install --disable-pip-version-check -r $f2aRequirements
        if ($LASTEXITCODE -ne 0) { throw 'Cannot install AEP dependencies. Check the network and try again.' }
        & $f2aVenv -c 'import py_aep,tkinter,uharfbuzz'
        if ($LASTEXITCODE -ne 0) { throw 'The AEP Python dependencies are incomplete.' }
    }
    if ($f2aSource -ne $f2aTarget) {
        $f2aFiles = @($f2aManifest.files | ForEach-Object { $_.path }) + 'package-manifest.json'
        foreach ($f2aRelative in $f2aFiles) {
            $f2aDestination = [IO.Path]::GetFullPath((Join-Path $f2aTarget $f2aRelative))
            if (-not $f2aDestination.StartsWith($f2aTarget.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Invalid file path in the F2A package manifest.'
            }
            $f2aHadFile = Test-Path -LiteralPath $f2aDestination
            if ($Update -and $f2aHadFile) {
                $f2aBackup = Join-Path $f2aBackups $f2aRelative
                [void](New-Item -ItemType Directory -Path (Split-Path -Parent $f2aBackup) -Force)
                Copy-Item -LiteralPath $f2aDestination -Destination $f2aBackup
            }
            [void](New-Item -ItemType Directory -Path (Split-Path -Parent $f2aDestination) -Force)
            $f2aInput = Join-Path $f2aSource $f2aRelative
            if ($Update) {
                $f2aNext = $f2aDestination + '.update-' + [guid]::NewGuid().ToString('N')
                try {
                    Copy-Item -LiteralPath $f2aInput -Destination $f2aNext
                    if ($f2aHadFile) { [IO.File]::Replace($f2aNext, $f2aDestination, [NullString]::Value) }
                    else { [IO.File]::Move($f2aNext, $f2aDestination) }
                } finally { [IO.File]::Delete($f2aNext) }
                $f2aReplaced += @{path = $f2aDestination; relative = $f2aRelative; existed = $f2aHadFile}
            } else {
                Copy-Item -LiteralPath $f2aInput -Destination $f2aDestination -Force
            }
        }
    }
} catch {
    foreach ($f2aFile in $f2aReplaced) {
        if ($f2aFile.existed) {
            Copy-Item -LiteralPath (Join-Path $f2aBackups $f2aFile.relative) -Destination $f2aFile.path -Force
        } else {
            Remove-Item -LiteralPath $f2aFile.path -Force
        }
    }
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
