param([string]$Server = (Join-Path $PSScriptRoot '..\scripts\aep-server.cjs'))

$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class F2AFolderTest {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$testShell = New-Object -ComObject Shell.Application
$originalHandles = @($testShell.Windows() | ForEach-Object { $_.HWND })
$testRoot = Join-Path $PSScriptRoot ('..\artifacts\aep-open-directory-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
# Build Unicode without depending on the Windows PowerShell source encoding.
$testName = ([string][char]0x4E2D + [char]0x6587) + " O'Brien [folder]"
$testDirectory = (New-Item -ItemType Directory -Path (Join-Path $testRoot $testName)).FullName
$targetWindow = $null
function Open-TestDirectory {
    & node -e 'require(process.argv[1]).openDirectory(process.argv[2]).catch(e=>{console.error(e);process.exitCode=1})' $Server $testDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Open-directory helper failed.' }
}
function Assert-WindowVisible {
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        $visible = [F2AFolderTest]::IsWindowVisible($testHandle) -and -not [F2AFolderTest]::IsIconic($testHandle)
        $foreground = [F2AFolderTest]::GetForegroundWindow() -eq $testHandle
        if ($visible -and $foreground) { return }
        Start-Sleep -Milliseconds 100
    } until ([DateTime]::UtcNow -ge $deadline)
    throw "Folder window was not visible in the foreground (visible=$visible, foreground=$foreground)."
}
try {
    Open-TestDirectory
    $targetWindow = $testShell.Windows() | Where-Object { $_.LocationURL -and $_.Document.Folder.Self.Path -eq $testDirectory } | Select-Object -First 1
    if (-not $targetWindow) { throw 'The Unicode folder did not open.' }
    $testHandle = [IntPtr]$targetWindow.HWND
    Assert-WindowVisible
    [void][F2AFolderTest]::ShowWindowAsync($testHandle, 6)
    Start-Sleep -Milliseconds 300
    if (-not [F2AFolderTest]::IsIconic($testHandle)) { throw 'Test window did not minimize.' }
    Open-TestDirectory
    Assert-WindowVisible
    $matches = @($testShell.Windows() | Where-Object { $_.LocationURL -and $_.Document.Folder.Self.Path -eq $testDirectory })
    if ($matches.Count -ne 1) { throw 'Opening the same folder created another window.' }
    Write-Output 'PASS: actual Explorer opens in foreground, restores its minimized window, reuses the folder and preserves Unicode/special characters.'
} finally {
    if ($targetWindow -and $targetWindow.HWND -notin $originalHandles) { $targetWindow.Quit() }
}
