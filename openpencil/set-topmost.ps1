param(
  [Parameter(Mandatory = $true)][string]$TitlePrefix,
  [int]$Topmost = 1,
  [int]$WaitMs = 0,
  [int]$BringToFront = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false

$code = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class F2AWindowHelper {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  private const uint SWP_NOSIZE = 0x0001;
  private const uint SWP_NOMOVE = 0x0002;
  private const uint SWP_NOACTIVATE = 0x0010;
  private const int SW_RESTORE = 9;

  private static bool IsAllowedBrowser(uint pid) {
    try {
      string name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
      return name == "msedge" || name == "chrome" || name == "chromium" || name == "brave";
    } catch {
      return false;
    }
  }

  public static IntPtr FindWindowByPrefix(string prefix) {
    IntPtr match = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      int len = GetWindowTextLength(hWnd);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      if (!title.StartsWith(prefix, StringComparison.Ordinal)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (!IsAllowedBrowser(pid)) return true;
      match = hWnd;
      return false;
    }, IntPtr.Zero);
    return match;
  }

  public static bool Apply(string prefix, bool topmost, bool bringToFront) {
    IntPtr hWnd = FindWindowByPrefix(prefix);
    if (hWnd == IntPtr.Zero) return false;
    if (bringToFront) {
      if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
      SetForegroundWindow(hWnd);
    }
    if (topmost || !bringToFront) {
      SetWindowPos(
        hWnd,
        topmost ? HWND_TOPMOST : HWND_NOTOPMOST,
        0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | (bringToFront ? 0u : SWP_NOACTIVATE)
      );
    }
    return true;
  }
}
'@

Add-Type -TypeDefinition $code -Language CSharp

$wantTopmost = $Topmost -ne 0
$wantFront = $BringToFront -ne 0
$deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(0, $WaitMs))
$found = $false

do {
  $found = [F2AWindowHelper]::Apply($TitlePrefix, $wantTopmost, $wantFront)
  if ($found) { break }
  if ([DateTime]::UtcNow -ge $deadline) { break }
  Start-Sleep -Milliseconds 60
} while ($true)

$json = @{ ok = $true; found = $found; topmost = $wantTopmost } | ConvertTo-Json -Compress
Write-Output $json
