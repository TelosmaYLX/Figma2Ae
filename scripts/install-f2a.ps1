#Requires -Version 5.1
param(
    [string]$InstallDirectory = (Join-Path $env:APPDATA 'Adobe\CEP\extensions\F2A'),
    [string]$SkillDirectory,
    [switch]$Update,
    [switch]$PromptForMcp
)

$ErrorActionPreference = 'Stop'
$f2aTarget = [IO.Path]::GetFullPath($InstallDirectory)
if (-not $Update) { Write-Host '正在安装 F2A…' }
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

    # Pulling an update already installs the native Figma 调色 effect into every AE CC 2019+
    # install. The panel retries later if this copy had no permission.
    $f2aGradePlugin = Join-Path (Split-Path -Parent $PSScriptRoot) 'ae-plugins\FigmaImageGrade.aex'
    if (Test-Path -LiteralPath $f2aGradePlugin) {
        try { & (Join-Path $PSScriptRoot 'install-ae-plugins.ps1') -AexPath $f2aGradePlugin }
        catch { Write-Warning ('Figma 调色插件安装失败：' + $_.Exception.Message) }
    }
    $f2aBlurPlugin = Join-Path (Split-Path -Parent $PSScriptRoot) 'ae-plugins\FigmaBackgroundBlur.aex'
    if (Test-Path -LiteralPath $f2aBlurPlugin) {
        & (Join-Path $PSScriptRoot 'install-ae-plugins.ps1') -AexPath $f2aBlurPlugin -MinVersion 24
    }

    if (-not $Update) {
        foreach ($f2aVersion in 9..12) {
            $f2aKey = 'HKCU:\Software\Adobe\CSXS.' + $f2aVersion
            [void](New-Item -Path $f2aKey -Force)
            New-ItemProperty -Path $f2aKey -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
        }
        & (Join-Path $f2aTarget 'scripts\install-aep-launcher.ps1') | Out-Null
    }
} finally {
    if ($f2aHasLock) { $f2aLock.ReleaseMutex() }
    $f2aLock.Dispose()
}

if ($Update) { return }

$f2aManifest = Get-Content -LiteralPath (Join-Path $f2aTarget 'package-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ''
Write-Host ("F2A v$($f2aManifest.version) 安装成功")
Write-Host 'AE 扩展已安装'
Write-Host "  $f2aTarget"
Write-Host 'AEP 导出已就绪'
if ($f2aManifest.skillDirectories.Count) {
    Write-Host ("Skill 已同步到 $($f2aManifest.skillDirectories.Count) 个目录")
    foreach ($directory in $f2aManifest.skillDirectories) { Write-Host "  $directory" }
} else {
    Write-Host 'Skill 同步目录 0 个，可用 -SkillDirectory 指定目录。'
}
Write-Host ''
Write-Host '重启 AE，从「窗口 → 扩展 → F2A」打开面板。'
Write-Host '首次使用时，在 Figma 中导入以下 manifest。'
Write-Host ('  ' + (Join-Path $f2aTarget 'figma-plugin\manifest.json'))

if (-not $PromptForMcp) { return }

$f2aClients = [ordered]@{}
if (Get-Command codex -ErrorAction SilentlyContinue) { $f2aClients['Codex'] = 'Codex' }
$f2aDshHome = if ($env:DSH_HOME) { $env:DSH_HOME -replace '^~(?=$|[\\/])', $env:USERPROFILE } else { Join-Path $env:USERPROFILE '.dsh' }
$f2aDshProfile = Join-Path $f2aDshHome 'profiles\desktop'
$f2aDshEditor = Join-Path $f2aDshProfile 'node_modules\dsh-skill-mcp-panel\lib\patch-editor.js'
if ((Test-Path -LiteralPath $f2aDshEditor -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $f2aDshProfile 'cordis.patch.yml') -PathType Leaf)) {
    $f2aClients['DshDesktop'] = 'DSH Desktop'
}

Write-Host ''
Write-Host 'MCP 配置（可选）'
$f2aMcpClient = 'Manual'
if ($f2aClients.Count) {
    $f2aClients['Manual'] = '手动配置'
    $f2aOptions = @($f2aClients.Keys)
    for ($index = 0; $index -lt $f2aOptions.Count; $index++) {
        Write-Host ('  [{0}] {1}' -f ($index + 1), $f2aClients[$f2aOptions[$index]])
    }
    do {
        Write-Host '输入编号，回车跳过 ' -NoNewline
        $answer = [Console]::ReadLine()
        if ([string]::IsNullOrWhiteSpace($answer)) {
            Write-Host 'MCP 已跳过，可稍后按 INSTALL.md 配置。'
            return
        }
        $number = 0
        $valid = [int]::TryParse($answer, [ref]$number) -and $number -ge 1 -and $number -le $f2aOptions.Count
        if (-not $valid) { Write-Host '请输入列表中的编号。' }
    } until ($valid)
    $f2aMcpClient = $f2aOptions[$number - 1]
}

if ($f2aMcpClient -ne 'Manual') {
    try {
        & (Join-Path $f2aTarget 'scripts\install-mcp.ps1') -Client $f2aMcpClient | Out-Null
        Write-Host ("MCP 已配置到 $($f2aClients[$f2aMcpClient])。重启客户端后使用 f2a。")
        return
    } catch {
        Write-Warning ('MCP 配置失败。' + $_.Exception.Message)
    }
}

Write-Host '在客户端添加 stdio 服务'
Write-Host '  名称      f2a'
Write-Host "  command   $f2aNode"
Write-Host ('  args      ' + (Join-Path $f2aTarget 'mcp\server.cjs'))
