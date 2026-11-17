#Requires -Version 5.1
<#
.SYNOPSIS
    Remove the F2A panel, the f2a-aep handler and the CEP switch this package set.

.DESCRIPTION
    Only what install-f2a.ps1 created is undone: the install folder (when it still
    carries the F2A CEP manifest), the f2a-aep URI handler and the developer-mode
    values recorded in install-state.json. Other extensions, the Adobe registry
    tree and other MCP servers are left alone.

.PARAMETER InstallDirectory
    Folder that holds the installed package. Must match the folder used to install.

.PARAMETER KeepFiles
    Delete the registry entries but keep the files on disk.

.EXAMPLE
    .\uninstall-f2a.ps1
#>
param(
    [string]$InstallDirectory = (Join-Path $env:APPDATA 'Adobe\CEP\extensions\F2A'),
    [switch]$KeepFiles
)

$ErrorActionPreference = 'Stop'

function Stop-F2aProcess {
    param([string]$Directory)
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

$f2aTarget = [System.IO.Path]::GetFullPath($InstallDirectory)
$f2aManifest = Join-Path $f2aTarget 'CSXS\manifest.xml'
if (-not (Test-Path -LiteralPath $f2aManifest)) {
    throw ('Not an F2A install folder: ' + $f2aManifest + ' is missing.')
}
# The folder name alone is not enough: refuse to delete a foreign extension.
$f2aXml = [IO.File]::ReadAllText($f2aManifest)
if ($f2aXml -notmatch 'ExtensionBundleId="F2A"') {
    throw 'The folder does not carry the F2A extension manifest. Nothing was removed.'
}

Stop-F2aProcess -Directory $f2aTarget

# Restore the CEP developer-mode values the installer changed.
$f2aStateFile = Join-Path $f2aTarget 'install-state.json'
if (Test-Path -LiteralPath $f2aStateFile) {
    try { $f2aState = Get-Content -LiteralPath $f2aStateFile -Raw | ConvertFrom-Json } catch { $f2aState = $null }
    if ($f2aState -and $f2aState.playerDebugMode) {
        foreach ($f2aProperty in $f2aState.playerDebugMode.PSObject.Properties) {
            $f2aKey = 'HKCU:\Software\Adobe\' + $f2aProperty.Name
            if (-not (Test-Path -LiteralPath $f2aKey)) { continue }
            $f2aCurrent = (Get-ItemProperty -Path $f2aKey -Name PlayerDebugMode -ErrorAction SilentlyContinue).PlayerDebugMode
            if ($f2aCurrent -ne '1') { continue }   # Someone else owns this value now.
            if ($null -eq $f2aProperty.Value) {
                Remove-ItemProperty -Path $f2aKey -Name PlayerDebugMode -ErrorAction SilentlyContinue
            } else {
                New-ItemProperty -Path $f2aKey -Name PlayerDebugMode -Value ([string]$f2aProperty.Value) -PropertyType String -Force | Out-Null
            }
        }
    }
}

# Remove the URI handler only when it still points at this install folder.
$f2aProtocolPath = 'Registry::HKEY_CURRENT_USER\Software\Classes\f2a-aep'
if (Test-Path -LiteralPath $f2aProtocolPath) {
    $f2aCommand = (Get-ItemProperty -Path (Join-Path $f2aProtocolPath 'shell\open\command') -Name '' -ErrorAction SilentlyContinue).''
    if (-not $f2aCommand -or $f2aCommand.IndexOf($f2aTarget, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Remove-Item -LiteralPath $f2aProtocolPath -Recurse -Force
    }
}

# Drop the Codex registration; DSH Desktop entries are removed by the client.
$f2aCodex = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue
if ($f2aCodex) {
    & $f2aCodex.Source mcp remove f2a 2>$null | Out-Null
}

if (-not $KeepFiles) {
    Remove-Item -LiteralPath $f2aTarget -Recurse -Force
    Write-Output ('Removed: ' + $f2aTarget)
} else {
    Write-Output ('Kept files: ' + $f2aTarget)
}
Write-Output 'F2A uninstalled. Restart After Effects if it is running.'
