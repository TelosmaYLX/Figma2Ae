#Requires -Version 5.1
# Copy the packaged effect into supported After Effects installations.
param(
    [Parameter(Mandatory = $true)][string]$AexPath,
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
    if (-not (Test-Path -LiteralPath $AexPath -PathType Leaf)) {
        throw "找不到插件文件：$AexPath"
    }
    $source = (Resolve-Path -LiteralPath $AexPath).Path
    $fileName = [IO.Path]::GetFileName($source)
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
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
            Write-Info "未找到兼容的 After Effects 安装，跳过 ${fileName}。"
            return
        }
    }

    $copied = New-Object System.Collections.Generic.List[string]
    $fresh = New-Object System.Collections.Generic.List[string]
    $failed = New-Object System.Collections.Generic.List[string]
    foreach ($plugins in $targets) {
        $folder = Join-Path $plugins 'F2A'
        $destination = Join-Path $folder $fileName
        try {
            if (Test-Path -LiteralPath $destination -PathType Leaf) {
                $current = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
                if ($current -eq $sourceHash) { $fresh.Add($destination); continue }
            }
            [void](New-Item -ItemType Directory -Path $folder -Force)
            Copy-Item -LiteralPath $source -Destination $destination -Force
            $copied.Add($destination)
        } catch {
            $failed.Add(($folder + '：' + $_.Exception.Message))
        }
    }

    if ($copied.Count -gt 0) {
        Write-Info "$fileName 已复制到 $($copied.Count) 个 After Effects 安装（重启 AE 后生效）："
        foreach ($file in $copied) { Write-Info "  $file" }
    }
    if ($fresh.Count -gt 0) {
        Write-Info "$fileName 已是最新（$($fresh.Count) 个 AE 安装）"
    }
    foreach ($issue in $failed) {
        Write-Warning ($fileName + ' 复制失败：' + $issue)
    }
} catch {
    Write-Warning ('AE 插件安装失败：' + $_.Exception.Message)
}
