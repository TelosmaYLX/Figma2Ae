param([Parameter(Mandatory=$true)][string]$Directory)

$ErrorActionPreference = 'Stop'
$targetDirectory = (Get-Item -LiteralPath $Directory).FullName.TrimEnd('\')
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class F2AFolderWindow {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
}
'@

$folderShell = New-Object -ComObject Shell.Application
function Find-DirectoryWindow {
    foreach ($folderWindow in $folderShell.Windows()) {
        # Explorer can register a window before its folder document is ready.
        try {
            if ($folderWindow.Document.Folder.Self.Path.TrimEnd('\') -eq $targetDirectory) { return $folderWindow }
        } catch {}
    }
}

$targetWindow = Find-DirectoryWindow
if (-not $targetWindow) {
    $folderShell.Open($Directory)
    $windowDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 100
        $targetWindow = Find-DirectoryWindow
    } until ($targetWindow -or [DateTime]::UtcNow -ge $windowDeadline)
}
if (-not $targetWindow) { throw 'Explorer did not open the export folder.' }

$windowHandle = [IntPtr]$targetWindow.HWND
$showCommand = if ([F2AFolderWindow]::IsIconic($windowHandle)) { 9 } else { 5 }
[void][F2AFolderWindow]::ShowWindowAsync($windowHandle, $showCommand)
[void][F2AFolderWindow]::SetForegroundWindow($windowHandle)
