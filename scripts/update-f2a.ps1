#Requires -Version 5.1
param(
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][string]$Sha256,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$InstallDirectory,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
$target = [IO.Path]::GetFullPath($InstallDirectory)
$installedFile = Join-Path $target 'package-manifest.json'
$installed = Get-Content -LiteralPath $installedFile -Raw | ConvertFrom-Json
if ($installed.name -ne 'F2A-Windows-x64' -or [version]$installed.version -ge [version]$Version) {
    throw 'The installed F2A version has already changed. Reopen the panel.'
}
$algorithm = [Security.Cryptography.SHA256]::Create()
$stream = [IO.File]::OpenRead($Archive)
try {
    $actualHash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '')
    if ($actualHash -ne $Sha256) { throw 'F2A update archive checksum does not match.' }
} finally {
    $stream.Dispose()
    $algorithm.Dispose()
}

$probe = Join-Path $target ('.f2a-write-' + [guid]::NewGuid().ToString('N'))
try {
    [IO.File]::WriteAllText($probe, '')
    [IO.File]::Delete($probe)
} catch [UnauthorizedAccessException] {
    if ($Elevated) { throw }
    $powershell = Join-Path $PSHOME 'powershell.exe'
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath +
        '" -Archive "' + $Archive + '" -Sha256 "' + $Sha256 + '" -Version "' + $Version +
        '" -InstallDirectory "' + $target + '" -Elevated'
    $child = Start-Process -FilePath $powershell -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($child.ExitCode -ne 0) { throw 'F2A update failed in the administrator installer.' }
    return
}

$stagingParent = [IO.Path]::GetFullPath((Split-Path -Parent $Archive))
$stage = Join-Path $stagingParent ('stage-' + [guid]::NewGuid().ToString('N'))
$signal = Join-Path $target '.f2a-update-aep'
$launcherLock = New-Object System.Threading.Mutex($false, 'Local\F2A-AEP-Start')
$hasLock = $false
$signalled = $false
$restart = $false
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $stage)
    $source = Join-Path $stage 'F2A-Windows-x64'
    $incoming = Get-Content -LiteralPath (Join-Path $source 'package-manifest.json') -Raw | ConvertFrom-Json
    if ($incoming.name -ne $installed.name -or $incoming.version -ne $Version) {
        throw 'F2A package version does not match the release.'
    }
    $hasLock = $launcherLock.WaitOne(60000)
    if (-not $hasLock) { throw 'F2A export service is starting. Try the update again.' }
    $current = Get-Content -LiteralPath $installedFile -Raw | ConvertFrom-Json
    if ([version]$current.version -ge [version]$Version) { return }
    $serverPath = Join-Path $target 'scripts\aep-server.cjs'
    $serverArgument = '(?:^|[\s"])' + [regex]::Escape($serverPath) + '(?:[\s"]|$)'
    $services = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.CommandLine -match $serverArgument
    } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
    if ($services.Count) {
        [IO.File]::WriteAllText($signal, [guid]::NewGuid().ToString('N'))
        $signalled = $true
        foreach ($service in $services) {
            if (-not $service.WaitForExit(60000)) { throw 'Finish the AEP export and retry the update.' }
        }
        $restart = $true
    }
    & (Join-Path $source 'scripts\install-f2a.ps1') -InstallDirectory $target -Update
} finally {
    if ($signalled) { [IO.File]::Delete($signal) }
    if ($hasLock) { $launcherLock.ReleaseMutex() }
    $launcherLock.Dispose()
    if ((Split-Path -Parent $stage) -eq $stagingParent -and (Test-Path -LiteralPath $stage)) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
    if ($restart) {
        try { & (Join-Path $target 'scripts\start-aep-export.ps1') -Background }
        catch { Write-Warning 'Reopen F2A to start the AEP export service.' }
    }
}
