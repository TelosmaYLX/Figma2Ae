param(
  [Parameter(Mandatory = $true)][string]$TitlePrefix,
  [Parameter(Mandatory = $true)][string]$IconPath,
  [int]$WaitMs = 10000,
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $IconPath)) {
  exit 0
}

$code = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class F2AWindowIconKeeper {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  private static extern int GetSystemMetrics(int nIndex);

  [DllImport("user32.dll")]
  private static extern int GetSystemMetricsForDpi(int nIndex, uint dpi);

  [DllImport("user32.dll")]
  private static extern uint GetDpiForWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr LoadImage(IntPtr hInst, string name, uint type, int cx, int cy, uint fuLoad);

  [DllImport("user32.dll")]
  private static extern bool DestroyIcon(IntPtr hIcon);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam,
    uint fuFlags, uint uTimeout, out IntPtr lpdwResult
  );

  private const uint IMAGE_ICON = 1;
  private const uint LR_LOADFROMFILE = 0x0010;
  private const uint WM_GETICON = 0x007F;
  private const uint WM_SETICON = 0x0080;
  private const uint SMTO_ABORTIFHUNG = 0x0002;
  private const int SM_CXICON = 11;
  private const int SM_CXSMICON = 49;
  private static readonly IntPtr ICON_SMALL = new IntPtr(0);
  private static readonly IntPtr ICON_BIG = new IntPtr(1);
  private static readonly IntPtr ICON_SMALL2 = new IntPtr(2);
  private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

  private static bool IsAllowedBrowser(uint pid) {
    try {
      string name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
      return name == "msedge" || name == "chrome" || name == "chromium" || name == "brave";
    } catch {
      return false;
    }
  }

  private static bool IsParentAlive(int parentPid) {
    if (parentPid <= 0) return true;
    try {
      Process p = Process.GetProcessById(parentPid);
      return !p.HasExited;
    } catch {
      return false;
    }
  }

  private static IntPtr FindWindowByPrefix(string prefix) {
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

  private static uint SafeGetDpi(IntPtr hWnd) {
    try {
      uint dpi = GetDpiForWindow(hWnd);
      if (dpi >= 96) return dpi;
    } catch {}
    return 96;
  }

  private static int SafeMetric(int index, uint dpi) {
    try {
      int v = GetSystemMetricsForDpi(index, dpi);
      if (v > 0) return v;
    } catch {}
    int fallback = GetSystemMetrics(index);
    return fallback > 0 ? fallback : (index == SM_CXICON ? 48 : 24);
  }

  private static IntPtr SafeSend(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam) {
    IntPtr res;
    IntPtr ok = SendMessageTimeout(hWnd, msg, wParam, lParam, SMTO_ABORTIFHUNG, 500, out res);
    return ok != IntPtr.Zero ? res : IntPtr.Zero;
  }

  private static void ApplyIcons(IntPtr hWnd, IntPtr hBig, IntPtr hSmall) {
    // WM_SETICON only supports ICON_SMALL (0) and ICON_BIG (1); sending ICON_SMALL2 (2)
    // is treated by DefWindowProc as wParam != ICON_SMALL and overwrites ICON_BIG with hSmall!
    if (hBig != IntPtr.Zero) SafeSend(hWnd, WM_SETICON, ICON_BIG, hBig);
    if (hSmall != IntPtr.Zero) SafeSend(hWnd, WM_SETICON, ICON_SMALL, hSmall);
  }

  public static void Run(string prefix, string iconPath, int waitMs, int parentPid) {
    try { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); } catch {}

    DateTime deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(0, waitMs));
    IntPtr hWnd = IntPtr.Zero;
    while (true) {
      if (!IsParentAlive(parentPid)) return;
      hWnd = FindWindowByPrefix(prefix);
      if (hWnd != IntPtr.Zero) break;
      if (DateTime.UtcNow >= deadline) return;
      Thread.Sleep(80);
    }

    uint currentDpi = SafeGetDpi(hWnd);
    int bigSize = Math.Max(48, SafeMetric(SM_CXICON, currentDpi));
    int smallSize = Math.Max(16, SafeMetric(SM_CXSMICON, currentDpi));
    IntPtr hBig = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, bigSize, bigSize, LR_LOADFROMFILE);
    IntPtr hSmall = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, smallSize, smallSize, LR_LOADFROMFILE);
    if (hBig == IntPtr.Zero && hSmall == IntPtr.Zero) return;

    try {
      ApplyIcons(hWnd, hBig, hSmall);
      int ticks = 0;
      while (IsWindow(hWnd) && IsParentAlive(parentPid)) {
        Thread.Sleep(ticks < 25 ? 300 : 1200);
        ticks++;
        if (!IsWindow(hWnd) || !IsParentAlive(parentPid)) break;

        uint nextDpi = SafeGetDpi(hWnd);
        if (nextDpi != currentDpi) {
          currentDpi = nextDpi;
          int nextBig = Math.Max(48, SafeMetric(SM_CXICON, currentDpi));
          int nextSmall = Math.Max(16, SafeMetric(SM_CXSMICON, currentDpi));
          IntPtr newBig = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, nextBig, nextBig, LR_LOADFROMFILE);
          IntPtr newSmall = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, nextSmall, nextSmall, LR_LOADFROMFILE);
          if (newBig != IntPtr.Zero || newSmall != IntPtr.Zero) {
            IntPtr oldBig = hBig;
            IntPtr oldSmall = hSmall;
            if (newBig != IntPtr.Zero) hBig = newBig;
            if (newSmall != IntPtr.Zero) hSmall = newSmall;
            ApplyIcons(hWnd, hBig, hSmall);
            if (oldBig != IntPtr.Zero && oldBig != hBig) DestroyIcon(oldBig);
            if (oldSmall != IntPtr.Zero && oldSmall != hSmall) DestroyIcon(oldSmall);
            continue;
          }
        }

        IntPtr curBig = SafeSend(hWnd, WM_GETICON, ICON_BIG, IntPtr.Zero);
        IntPtr curSmall = SafeSend(hWnd, WM_GETICON, ICON_SMALL, IntPtr.Zero);
        if ((hBig != IntPtr.Zero && curBig != hBig) || (hSmall != IntPtr.Zero && curSmall != hSmall)) {
          ApplyIcons(hWnd, hBig, hSmall);
        }
      }
    } finally {
      if (hBig != IntPtr.Zero) DestroyIcon(hBig);
      if (hSmall != IntPtr.Zero) DestroyIcon(hSmall);
    }
  }
}
'@

Add-Type -TypeDefinition $code -Language CSharp
[F2AWindowIconKeeper]::Run($TitlePrefix, $IconPath, $WaitMs, $ParentPid)
