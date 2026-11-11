$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$aepPython = Join-Path $projectRoot '.venv-aep\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $aepPython)) {
    & python -m venv (Join-Path $projectRoot '.venv-aep')
    if ($LASTEXITCODE -ne 0) { throw '创建 Python 环境失败' }
}
& $aepPython -c "import importlib.util, importlib.metadata, sys; sys.exit(0 if importlib.util.find_spec('py_aep') and importlib.metadata.version('py-aep').lstrip('v') == '0.19.0' else 1)"
if ($LASTEXITCODE -ne 0) {
    & $aepPython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'aep\requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw '安装 AEP 依赖失败' }
}
& node (Join-Path $PSScriptRoot 'aep-server.cjs')
