param(
    [switch]$Background,
    [string]$NodePath = 'node',
    [string]$PythonPath = 'python'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
function Test-AepService {
    try {
        $info = Invoke-RestMethod -Uri 'http://127.0.0.1:7868/health' -TimeoutSec 1
        return $info.service -eq 'f2a-aep' -and $info.version -eq 3
    } catch { return $false }
}

if (Test-AepService) { Write-Output 'AEP export service is running.'; return }
# Several plugin windows can request the same local service at once.
$aepStartLock = New-Object System.Threading.Mutex($false, 'Local\F2A-AEP-Start')
$aepHasLock = $false
try {
    $aepHasLock = $aepStartLock.WaitOne(60000)
    if (-not $aepHasLock) { throw 'AEP service startup timed out' }
    if (Test-AepService) { Write-Output 'AEP export service is running.'; return }
    $aepPython = Join-Path $projectRoot 'runtime\python\python.exe'
    if (Test-Path -LiteralPath $aepPython) {
        & $aepPython -c 'import py_aep, tkinter'
        if ($LASTEXITCODE -ne 0) { throw 'Bundled AEP runtime is incomplete. Reinstall the component.' }
    } else {
        $aepPython = Join-Path $projectRoot '.venv-aep\Scripts\python.exe'
        if (-not (Test-Path -LiteralPath $aepPython)) {
            & $PythonPath -m venv (Join-Path $projectRoot '.venv-aep')
            if ($LASTEXITCODE -ne 0) { throw '创建 Python 环境失败' }
        }
        & $aepPython -c "import importlib.util, importlib.metadata, sys; sys.exit(0 if importlib.util.find_spec('py_aep') and importlib.metadata.version('py-aep').lstrip('v') == '0.19.0' else 1)"
        if ($LASTEXITCODE -ne 0) {
            & $aepPython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'aep\requirements.txt')
            if ($LASTEXITCODE -ne 0) { throw '安装 AEP 依赖失败' }
        }
    }
    $aepServer = Join-Path $PSScriptRoot 'aep-server.cjs'
    if ($Background) {
        $aepLogRoot = Join-Path $projectRoot 'artifacts\aep-service'
        [void](New-Item -ItemType Directory -Path $aepLogRoot -Force)
        $aepRunName = 'service-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
        $aepProcess = Start-Process -FilePath $NodePath -ArgumentList ('"' + $aepServer + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $aepLogRoot ($aepRunName + '.out.log')) -RedirectStandardError (Join-Path $aepLogRoot ($aepRunName + '.err.log')) -PassThru
        for ($aepAttempt = 0; $aepAttempt -lt 30; $aepAttempt++) {
            if (Test-AepService) { Write-Output 'AEP export service started.'; return }
            if ($aepProcess.HasExited) { throw 'AEP service exited. See artifacts/aep-service for details.' }
            Start-Sleep -Milliseconds 250
        }
        throw 'AEP service startup timed out. See artifacts/aep-service for details.'
    }
} finally {
    if ($aepHasLock) { $aepStartLock.ReleaseMutex() }
    $aepStartLock.Dispose()
}
& $NodePath $aepServer
