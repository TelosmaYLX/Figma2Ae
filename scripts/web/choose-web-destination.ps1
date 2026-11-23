param(
    [string]$InitialName = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class F2ADialogTopMost {
    private delegate bool EnumThreadProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool EnumThreadWindows(uint threadId, EnumThreadProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr SetActiveWindow(IntPtr hWnd);

    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const int SW_SHOWNORMAL = 1;
    private const int SW_RESTORE = 9;

    private static volatile bool _stop = false;

    public static void Reset() { _stop = false; }
    public static void Stop() { _stop = true; }

    public static IntPtr FindDialogWindow(uint uiThreadId, string expectedTitle) {
        IntPtr exact = IntPtr.Zero;
        IntPtr fallback = IntPtr.Zero;
        EnumThreadWindows(uiThreadId, (hWnd, lParam) => {
            var cls = new StringBuilder(64);
            GetClassName(hWnd, cls, cls.Capacity);
            var title = new StringBuilder(256);
            GetWindowText(hWnd, title, title.Capacity);
            string clsName = cls.ToString();
            string titleText = title.ToString();
            if (!string.IsNullOrEmpty(expectedTitle) && titleText == expectedTitle) {
                exact = hWnd;
                return false;
            }
            if (clsName == "#32770") {
                RECT r;
                if (GetWindowRect(hWnd, out r) && (r.Right - r.Left) >= 200 && (r.Bottom - r.Top) >= 120) {
                    exact = hWnd;
                    return false;
                }
            }
            if (fallback == IntPtr.Zero && IsWindowVisible(hWnd)) {
                RECT r;
                if (GetWindowRect(hWnd, out r) && (r.Right - r.Left) >= 200 && (r.Bottom - r.Top) >= 120) {
                    fallback = hWnd;
                }
            }
            return true;
        }, IntPtr.Zero);
        return exact != IntPtr.Zero ? exact : fallback;
    }

    public static bool Promote(IntPtr hWnd, uint uiThreadId) {
        if (hWnd == IntPtr.Zero) return false;
        uint dummy;
        IntPtr fg = GetForegroundWindow();
        uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out dummy) : 0;
        uint curThread = GetCurrentThreadId();
        bool attachedFg = fgThread != 0 && fgThread != curThread && AttachThreadInput(curThread, fgThread, true);
        bool attachedUi = uiThreadId != 0 && uiThreadId != curThread && AttachThreadInput(curThread, uiThreadId, true);
        try {
            ShowWindow(hWnd, IsIconic(hWnd) ? SW_RESTORE : SW_SHOWNORMAL);
            SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
            SetActiveWindow(hWnd);
        } finally {
            if (attachedUi) AttachThreadInput(curThread, uiThreadId, false);
            if (attachedFg) AttachThreadInput(curThread, fgThread, false);
        }
        return true;
    }

    public static Thread StartPromote(uint uiThreadId, string expectedTitle) {
        _stop = false;
        var t = new Thread(() => {
            for (int i = 0; i < 100 && !_stop; i++) {
                IntPtr hWnd = FindDialogWindow(uiThreadId, expectedTitle);
                if (hWnd != IntPtr.Zero) {
                    Promote(hWnd, uiThreadId);
                    Thread.Sleep(150);
                    if (!_stop) Promote(hWnd, uiThreadId);
                    Thread.Sleep(300);
                    if (!_stop) Promote(hWnd, uiThreadId);
                    return;
                }
                Thread.Sleep(40);
            }
        });
        t.IsBackground = true;
        t.Start();
        return t;
    }
}
'@

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

$uiThreadId = [F2ADialogTopMost]::GetCurrentThreadId()

try {
    if ($DryRun) {
        Write-Output (ConvertTo-AsciiJson @{
            directory = $dialog.FileName
            title = $dialog.Title
            filter = $dialog.Filter
            cancelled = $null
            topmostReady = ($uiThreadId -gt 0)
        })
        return
    }
    $null = [F2ADialogTopMost]::StartPromote($uiThreadId, $dialogTitle)
    $result = $dialog.ShowDialog()
    if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.FileName) {
        Write-Output (ConvertTo-AsciiJson @{ directory = $dialog.FileName })
    } else {
        Write-Output (ConvertTo-AsciiJson @{ directory = $null })
    }
} finally {
    [F2ADialogTopMost]::Stop()
    $dialog.Dispose()
}
