param([string]$InitialName = 'Figma')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Windows.Forms;
public class F2ATopWindow : IWin32Window {
    public IntPtr Handle { get; private set; }
    public F2ATopWindow(IntPtr handle) { Handle = handle; }
}
'@

$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = 'Manual'
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.ShowInTaskbar = $false
$owner.Show()

try {
    $dialog = New-Object System.Windows.Forms.SaveFileDialog
    $dialog.Title = '保存 HTML 前端页面文件夹'
    $dialog.FileName = $InitialName
    $dialog.Filter = 'HTML 页面文件夹|*'
    $dialog.OverwritePrompt = $false
    $dialog.AddExtension = $false
    $result = $dialog.ShowDialog($owner)
    if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.FileName) {
        @{ directory = $dialog.FileName } | ConvertTo-Json -Compress
    } else {
        @{ directory = $null } | ConvertTo-Json -Compress
    }
} finally {
    $owner.Close()
    $owner.Dispose()
}
