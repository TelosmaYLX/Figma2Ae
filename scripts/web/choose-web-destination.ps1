param(
    [string]$InitialName = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

if (-not $InitialName) { $InitialName = $env:F2A_WEB_INITIAL_NAME }
if (-not $InitialName) { $InitialName = 'Figma' }

$dialogTitle = if ($env:F2A_WEB_DIALOG_TITLE) {
    $env:F2A_WEB_DIALOG_TITLE
} else {
    [System.Text.RegularExpressions.Regex]::Unescape('\u4fdd\u5b58 HTML \u524d\u7aef\u9875\u9762\u6587\u4ef6\u5939')
}

$dialogFilter = if ($env:F2A_WEB_DIALOG_FILTER) {
    $env:F2A_WEB_DIALOG_FILTER
} else {
    [System.Text.RegularExpressions.Regex]::Unescape('HTML \u9875\u9762\u6587\u4ef6\u5939|*')
}

function ConvertTo-AsciiJson($Payload) {
    $json = $Payload | ConvertTo-Json -Compress
    return [System.Text.RegularExpressions.Regex]::Replace($json, '[^\x00-\x7F]', {
        param($match)
        '\u' + ([int][char]$match.Value).ToString('x4')
    })
}

$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = $dialogTitle
$dialog.FileName = $InitialName
$dialog.Filter = $dialogFilter
$dialog.OverwritePrompt = $false
$dialog.AddExtension = $false

$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.Opacity = 0
$owner.StartPosition = 'Manual'
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.ShowInTaskbar = $false

try {
    if ($DryRun) {
        Write-Output (ConvertTo-AsciiJson @{
            directory = $dialog.FileName
            title = $dialog.Title
            filter = $dialog.Filter
            cancelled = $null
        })
        return
    }
    $owner.Show()
    $owner.Activate()
    $result = $dialog.ShowDialog($owner)
    if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.FileName) {
        Write-Output (ConvertTo-AsciiJson @{ directory = $dialog.FileName })
    } else {
        Write-Output (ConvertTo-AsciiJson @{ directory = $null })
    }
} finally {
    $dialog.Dispose()
    if (-not $DryRun) { $owner.Close() }
    $owner.Dispose()
}
