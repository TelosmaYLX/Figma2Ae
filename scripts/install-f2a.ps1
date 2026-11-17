#Requires -Version 5.1
<#
.SYNOPSIS
    Install the portable F2A package for the current user.

.DESCRIPTION
    Copies the package into the per-user CEP extensions folder, switches on the
    developer mode the unsigned panel needs, records the Node runtime the panel
    has to start, registers the f2a-aep handler used to launch the AEP export
    service, prepares the AEP Python environment and registers the F2A MCP server
    in every supported agent client it finds.

    Node.js 20 or newer must already be installed. Python 3.10 or newer (64-bit,
    with tkinter) is needed for the AEP export; its two dependencies are installed
    into <install>\.venv-aep, which needs network access the first time only.

    Nothing is written outside the current user profile and HKCU. No admin
    rights and no logon task.

.PARAMETER InstallDirectory
    Target folder. Defaults to the per-user CEP extensions folder, which is where
    After Effects looks for panels.

.PARAMETER SkipMcp
    Leave agent MCP configuration untouched.

.PARAMETER SkipAepSetup
    Do not create the AEP Python environment. The panel and the Figma import keep
    working; "Export AEP" stays unavailable until the environment exists.

.EXAMPLE
    .\install-f2a.ps1

.EXAMPLE
    .\install-f2a.ps1 -SkipAepSetup -SkipMcp
#>
param(
    [string]$InstallDirectory = (Join-Path $env:APPDATA 'Adobe\CEP\extensions\F2A'),
    [switch]$SkipMcp,
    [switch]$SkipAepSetup
)

$ErrorActionPreference = 'Stop'

function Stop-F2aProcess {
    param([string]$Directory)
    # Only executables inside the install folder are stopped; a relay started by
    # another copy of F2A keeps running.
    $prefix = $Directory.TrimEnd('\') + '\'
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'python.exe' OR Name = 'pythonw.exe'" |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object {
            $running = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if ($running) {
                Stop-Process -InputObject $running -Force
                [void]$running.WaitForExit(10000)
            }
        }
}

function Set-F2aRegistryString {
    param([string]$Path, [string]$Name, [string]$Value)
    [void](New-Item -Path $Path -Force)
    if ($Name) { New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType String -Force | Out-Null }
}

function Find-F2aCommand {
    param([string[]]$Names)
    foreach ($name in $Names) {
        $found = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { return $found.Source }
    }
    return $null
}

$f2aSource = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$f2aTarget = [System.IO.Path]::GetFullPath($InstallDirectory)
$f2aManifest = Join-Path $f2aSource 'CSXS\manifest.xml'
if (-not (Test-Path -LiteralPath $f2aManifest)) {
    throw 'Not an F2A package: CSXS\manifest.xml is missing next to scripts\.'
}
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }

$f2aStateFile = Join-Path $f2aTarget 'install-state.json'
$f2aWindowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$f2aState = @{
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    playerDebugMode = @{}
    protocolCreated = -not (Test-Path -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\Classes\f2a-aep')
}

# Node runs the MCP relay and the AEP export service; CEP's own runtime is too old
# for both, so the package cannot ship without one.
$f2aNode = Find-F2aCommand @('node')
if (-not $f2aNode) { throw 'Node.js 20 or newer is required: install it from https://nodejs.org and run this again.' }
& $f2aNode -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if ($LASTEXITCODE -ne 0) { throw ('Node.js 20 or newer is required; found ' + (& $f2aNode --version) + '.') }

# 1) Copy the package. The panel, the MCP relay and the service must stay in one
#    folder: launcher.cjs resolves its Node from next to the extension.
if ($f2aTarget -ne $f2aSource) {
    Stop-F2aProcess -Directory $f2aTarget
    [void](New-Item -ItemType Directory -Path $f2aTarget -Force)
    $f2aRobocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
    & $f2aRobocopy $f2aSource $f2aTarget /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
    # robocopy reports success through bits 0-3; 8 and above is a real failure.
    if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy exit code $LASTEXITCODE)." }
    Write-Output ('Installed files: ' + $f2aTarget)
}

# 2) CEP refuses unsigned extensions unless the developer mode is on for the CEP
#    version the host ships. AE 2019-2026 use CSXS 9-13; earlier versions do not
#    meet the manifest requirement.
foreach ($f2aCep in 9..13) {
    $f2aKey = "HKCU:\Software\Adobe\CSXS.$f2aCep"
    $f2aPrevious = if (Test-Path -LiteralPath $f2aKey) {
        (Get-ItemProperty -Path $f2aKey -Name PlayerDebugMode -ErrorAction SilentlyContinue).PlayerDebugMode
    }
    $f2aState.playerDebugMode["CSXS.$f2aCep"] = $f2aPrevious
    if ($f2aPrevious -ne '1') {
        Set-F2aRegistryString -Path $f2aKey -Name 'PlayerDebugMode' -Value '1'
    }
}

# 3) The panel starts the relay itself, outside CEP's Node. Record which Node that is.
$f2aRuntime = @{ node = $f2aNode } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $f2aTarget 'mcp\runtime.json'), $f2aRuntime, (New-Object System.Text.UTF8Encoding $false))

# 4) AEP export: a private environment inside the install folder, so the user's
#    own Python stays untouched and the pinned py-aep version is guaranteed.
$f2aAepReady = $false
if (-not $SkipAepSetup) {
    $f2aPython = Find-F2aCommand @('python', 'python3')
    if ($f2aPython) {
        & $f2aPython -c "import sys, platform, tkinter; sys.exit(0 if platform.machine() == 'AMD64' else 1)"
        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'The Python found on PATH is not a 64-bit build with tkinter; skipping the AEP export environment.'
            $f2aPython = $null
        }
    } else {
        Write-Warning 'Python 3.10 or newer was not found on PATH; skipping the AEP export environment.'
    }
    if ($f2aPython) {
        $f2aEnvironment = Join-Path $f2aTarget '.venv-aep'
        $f2aEnvironmentPython = Join-Path $f2aEnvironment 'Scripts\python.exe'
        if (-not (Test-Path -LiteralPath $f2aEnvironmentPython)) {
            Write-Output 'Creating the AEP Python environment...'
            & $f2aPython -m venv $f2aEnvironment
        }
        if (Test-Path -LiteralPath $f2aEnvironmentPython) {
            & $f2aEnvironmentPython -c "import py_aep, tkinter"
            if ($LASTEXITCODE -ne 0) {
                Write-Output 'Installing the AEP dependencies (network needed once)...'
                & $f2aEnvironmentPython -m pip install --disable-pip-version-check --quiet -r (Join-Path $f2aTarget 'scripts\aep\requirements.txt')
                & $f2aEnvironmentPython -c "import py_aep, tkinter"
            }
            $f2aAepReady = $LASTEXITCODE -eq 0
        }
        if (-not $f2aAepReady) { Write-Warning 'The AEP Python environment is incomplete; "Export AEP" will ask for it again.' }
    }
}

# 5) The AE panel starts the AEP export service through this URI handler. The URI
#    itself carries no data; the handler only starts the service.
$f2aVenvPython = Join-Path $f2aTarget '.venv-aep\Scripts\python.exe'
$f2aProtocolPython = if (Test-Path -LiteralPath $f2aVenvPython) { $f2aVenvPython } else { if ($f2aPython) { $f2aPython } else { 'python' } }
$f2aLaunchScript = Join-Path $f2aTarget 'scripts\start-aep-export.ps1'
$f2aCommand = '"' + $f2aWindowsPowerShell + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
    $f2aLaunchScript + '" -Background -NodePath "' + $f2aNode + '" -PythonPath "' + $f2aProtocolPython + '"'
$f2aProtocol = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\f2a-aep')
try {
    $f2aProtocol.SetValue('', 'URL:F2A AEP Export')
    $f2aProtocol.SetValue('URL Protocol', '')
    $f2aOpen = $f2aProtocol.CreateSubKey('shell\open\command')
    try { $f2aOpen.SetValue('', $f2aCommand) } finally { $f2aOpen.Dispose() }
} finally { $f2aProtocol.Dispose() }

# 6) Register the MCP server for the agent clients this machine actually has.
if (-not (Test-Path -LiteralPath (Join-Path $f2aTarget 'mcp\server.cjs'))) {
    throw 'mcp\server.cjs is missing from the package.'
}
$f2aMcp = @()
if (-not $SkipMcp) {
    $f2aMcpScript = Join-Path $f2aTarget 'scripts\install-mcp.ps1'
    if (Get-Command codex -CommandType Application -ErrorAction SilentlyContinue) {
        & $f2aWindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $f2aMcpScript
        if ($LASTEXITCODE -eq 0) { $f2aMcp += 'Codex' }
        else { Write-Warning 'Codex MCP registration failed. Run scripts\install-mcp.ps1 manually.' }
    }
    $f2aDshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    if (Test-Path -LiteralPath (Join-Path $f2aDshHome 'profiles\desktop')) {
        & $f2aWindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $f2aMcpScript -Client DshDesktop
        if ($LASTEXITCODE -eq 0) { $f2aMcp += 'DSH Desktop' }
        else { Write-Warning 'DSH Desktop MCP registration failed. Run scripts\install-mcp.ps1 -Client DshDesktop manually.' }
    }
}

[IO.File]::WriteAllText($f2aStateFile, ($f2aState | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))

Write-Output ''
Write-Output 'F2A installed.'
Write-Output ('  folder : ' + $f2aTarget)
Write-Output ('  node   : ' + $f2aNode)
Write-Output ('  aep    : ' + $(if ($f2aAepReady) { $f2aVenvPython } else { 'not ready (see the warning above)' }))
Write-Output '  panel  : After Effects > Window > Extensions > F2A'
Write-Output ('  figma  : ' + (Join-Path $f2aTarget 'figma-plugin\manifest.json'))
Write-Output ('  mcp    : ' + $(if ($f2aMcp.Count) { $f2aMcp -join ', ' } else { 'not registered' }))
Write-Output ''
Write-Output 'Restart After Effects, then open the F2A panel.'
