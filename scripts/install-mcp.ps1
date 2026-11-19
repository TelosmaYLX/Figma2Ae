param(
    [ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$Name = 'f2a',
    [ValidateSet('Codex', 'DshDesktop')][string]$Client = 'Codex'
)
$ErrorActionPreference = 'Stop'
if ($Name -eq 'figma') { throw 'Use f2a for F2A. The existing figma MCP must be kept separate.' }
$mcpRoot = Split-Path -Parent $PSScriptRoot
$mcpNode = Join-Path $mcpRoot 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $mcpNode)) { $mcpNode = (Get-Command node -ErrorAction Stop).Source }
$mcpEntry = Join-Path $mcpRoot 'mcp\server.cjs'
if (-not (Test-Path -LiteralPath $mcpEntry)) { throw 'F2A MCP bundle is missing. Run npm ci and npm run build in mcp first.' }
if ($Client -eq 'DshDesktop') {
    & $mcpNode (Join-Path $PSScriptRoot 'install-mcp-dsh.cjs') $Name $mcpNode
    if ($LASTEXITCODE -ne 0) { throw 'Cannot register F2A MCP in DSH Desktop.' }
    return
}
$mcpCodex = (Get-Command codex -ErrorAction Stop).Source
$mcpConfigRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$mcpConfig = Join-Path $mcpConfigRoot 'config.toml'
if (Test-Path -LiteralPath $mcpConfig) {
    $mcpBackupRoot = Join-Path $mcpConfigRoot 'backups\f2a'
    [void](New-Item -ItemType Directory -Path $mcpBackupRoot -Force)
    Copy-Item -LiteralPath $mcpConfig -Destination (Join-Path $mcpBackupRoot ('config-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.toml'))
}
& $mcpCodex mcp add $Name -- $mcpNode $mcpEntry
if ($LASTEXITCODE -ne 0) { throw 'Cannot register F2A MCP in Codex.' }
# Keep enough time for operations that report progress while Figma renders.
$mcpText = [IO.File]::ReadAllText($mcpConfig)
$mcpHeader = '(?m)^\[mcp_servers\.' + [regex]::Escape($Name) + '\]\r?$'
$mcpText = [regex]::Replace($mcpText, $mcpHeader, ('$0' + "`nstartup_timeout_sec = 60`ntool_timeout_sec = 120"))
[IO.File]::WriteAllText($mcpConfig, $mcpText, (New-Object System.Text.UTF8Encoding $false))
Write-Output 'F2A MCP configured. Reconnect MCP to use the Figma tools and ae_status for After Effects.'
