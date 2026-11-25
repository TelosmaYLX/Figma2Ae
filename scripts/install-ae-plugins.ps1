#Requires -Version 5.1
# Best-effort copy of the bundled F2A AE effects (Figma 调色 + Figma 背景模糊) into every
# supported After Effects install. The F2A installers run this on install and update so
# pulling a new version already installs the plug-ins; failures are warnings only, because
# export can still fall back (LUT grade for Figma 调色, rasterising for Figma 背景模糊) and
# the panel retries the copy on first use.
param(
    [string[]]$AexPath,
    [double]$MinVersion = 16,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# When the installers capture this output (updates run with a redirected console) emit
# UTF-8 so logs keep the Chinese messages readable.
if ([Console]::IsOutputRedirected) {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
}

function Write-Info([string]$Text) {
    if (-not $Quiet) { Write-Host $Text }
}

try {
    # -AexPath wins (one path or an array). Without it, install every .aex packaged beside
    # the scripts: <package>\ae-plugins\*.aex, so a normal install/update ships all bundled
    # effects without naming them here.
    $sources = New-Object System.Collections.Generic.List[object]
    $inputs = @()
    if ($AexPath) { $inputs = @($AexPath) }
    if ($inputs.Count -eq 0) {
        $packaged = Join-Path (Split-Path -Parent $PSScriptRoot) 'ae-plugins'
        if (Test-Path -LiteralPath $packaged -PathType Container) {
            $inputs = @(Get-ChildItem -LiteralPath $packaged -Filter '*.aex' -File -ErrorAction SilentlyContinue |
                Sort-Object Name | ForEach-Object { $_.FullName })
        }
    }
    foreach ($input in $inputs) {
        if ([string]::IsNullOrWhiteSpace([string]$input)) { continue }
        if (-not (Test-Path -LiteralPath $input -PathType Leaf)) {
            Write-Warning ('找不到插件文件，将在首次导出时重试：' + $input)
            continue
        }
        $source = (Resolve-Path -LiteralPath $input).Path
        $sources.Add([pscustomobject]@{
            Path = $source
            Name = [IO.Path]::GetFileName($source)
            Hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
        })
    }
    if ($sources.Count -eq 0) {
        throw '找不到插件文件'
    }

    $targets = New-Object System.Collections.Generic.List[string]
    $override = $env:F2A_AE_PLUGINS
    if (-not [string]::IsNullOrWhiteSpace($override)) {
        # An explicit override is authoritative; tests and custom installs use it.
        foreach ($entry in ($override -split ';')) {
            $trimmed = $entry.Trim()
            if ($trimmed.Length -eq 0) { continue }
            $targets.Add([IO.Path]::GetFullPath($trimmed.TrimEnd([char[]]('\', '/'))))
        }
    } else {
        $roots = @(
            'HKLM:\SOFTWARE\Adobe\After Effects',
            'HKLM:\SOFTWARE\WOW6432Node\Adobe\After Effects',
            'HKCU:\SOFTWARE\Adobe\After Effects'
        )
        $seen = @{}
        foreach ($root in $roots) {
            if (-not (Test-Path -LiteralPath $root)) { continue }
            foreach ($key in (Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
                $version = 0.0
                if (-not [double]::TryParse($key.PSChildName, [ref]$version)) { continue }
                if ($version -lt $MinVersion) { continue }
                $install = $null
                try {
                    $install = (Get-ItemProperty -LiteralPath $key.PSPath -Name InstallPath -ErrorAction Stop).InstallPath
                } catch { continue }
                if ([string]::IsNullOrWhiteSpace($install)) { continue }
                $plugins = [IO.Path]::GetFullPath((Join-Path $install 'Plug-ins'))
                $lower = $plugins.ToLowerInvariant()
                if (-not $seen.ContainsKey($lower)) {
                    $seen[$lower] = $true
                    $targets.Add($plugins)
                }
            }
        }
        if ($targets.Count -eq 0) {
            Write-Info '未找到 After Effects CC 2019 及以上的安装，跳过 F2A AE 插件安装。'
            return
        }
    }

    $copied = New-Object System.Collections.Generic.List[string]
    $fresh = New-Object System.Collections.Generic.List[string]
    $failed = New-Object System.Collections.Generic.List[string]
    $copiedInstalls = @{}
    $freshInstalls = @{}
    foreach ($plugins in $targets) {
        $folder = Join-Path $plugins 'F2A'
        foreach ($plugin in $sources) {
            $destination = Join-Path $folder $plugin.Name
            try {
                if (Test-Path -LiteralPath $destination -PathType Leaf) {
                    $current = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
                    if ($current -eq $plugin.Hash) {
                        $fresh.Add($destination)
                        $freshInstalls[$folder.ToLowerInvariant()] = $folder
                        continue
                    }
                }
                [void](New-Item -ItemType Directory -Path $folder -Force)
                Copy-Item -LiteralPath $plugin.Path -Destination $destination -Force
                $copied.Add($destination)
                $copiedInstalls[$folder.ToLowerInvariant()] = $folder
            } catch {
                $failed.Add(($destination + '：' + $_.Exception.Message))
            }
        }
    }

    if ($copied.Count -gt 0) {
        Write-Info ('F2A AE 插件已复制到 {0} 个 After Effects 安装（重启 AE 后生效）：' -f $copiedInstalls.Count)
        foreach ($file in $copied) { Write-Info "  $file" }
    }
    if ($fresh.Count -gt 0) {
        Write-Info ('F2A AE 插件已是最新：{0} 个 After Effects 安装' -f $freshInstalls.Count)
    }
    foreach ($issue in $failed) {
        Write-Warning ('F2A AE 插件复制失败，将在首次导出时重试：' + $issue)
    }
} catch {
    Write-Warning ('F2A AE 插件安装失败，将在首次导出时重试：' + $_.Exception.Message)
}
