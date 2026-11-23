"""Name an AEP export folder using the native Save As dialog."""
import json
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog


def _start_windows_topmost_promoter(title, start_thread=True):
    """Promote the native Save As dialog to HWND_TOPMOST and foreground on Windows."""
    if sys.platform != 'win32':
        return None
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL('user32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    EnumThreadProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    kernel32.GetCurrentThreadId.argtypes = []
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD
    user32.EnumThreadWindows.argtypes = [wintypes.DWORD, EnumThreadProc, wintypes.LPARAM]
    user32.EnumThreadWindows.restype = wintypes.BOOL
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.GetForegroundWindow.argtypes = []
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.AttachThreadInput.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wintypes.BOOL
    user32.SetWindowPos.argtypes = [
        wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT
    ]
    user32.SetWindowPos.restype = wintypes.BOOL
    user32.BringWindowToTop.argtypes = [wintypes.HWND]
    user32.BringWindowToTop.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.SetActiveWindow.argtypes = [wintypes.HWND]
    user32.SetActiveWindow.restype = wintypes.HWND

    ui_thread_id = kernel32.GetCurrentThreadId()
    stop_event = threading.Event()
    if not start_thread:
        return stop_event

    HWND_TOPMOST = ctypes.c_void_p(-1)
    SWP_NOSIZE = 0x0001
    SWP_NOMOVE = 0x0002
    SWP_SHOWWINDOW = 0x0040
    SW_SHOWNORMAL = 1
    SW_RESTORE = 9

    def find_dialog():
        found = [None]
        fallback = [None]

        def callback(hwnd, _lparam):
            cls_buf = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, cls_buf, len(cls_buf))
            title_buf = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, title_buf, len(title_buf))
            if title and title_buf.value == title:
                found[0] = hwnd
                return False
            rect = wintypes.RECT()
            has_size = bool(user32.GetWindowRect(hwnd, ctypes.byref(rect))) and (
                (rect.right - rect.left) >= 200 and (rect.bottom - rect.top) >= 120
            )
            if cls_buf.value == '#32770' and has_size:
                found[0] = hwnd
                return False
            if fallback[0] is None and user32.IsWindowVisible(hwnd) and has_size:
                fallback[0] = hwnd
            return True

        user32.EnumThreadWindows(ui_thread_id, EnumThreadProc(callback), 0)
        return found[0] or fallback[0]

    def promote(hwnd):
        fg = user32.GetForegroundWindow()
        dummy = wintypes.DWORD(0)
        fg_thread = user32.GetWindowThreadProcessId(fg, ctypes.byref(dummy)) if fg else 0
        cur_thread = kernel32.GetCurrentThreadId()
        attached_fg = bool(fg_thread and fg_thread != cur_thread and user32.AttachThreadInput(cur_thread, fg_thread, True))
        attached_ui = bool(ui_thread_id and ui_thread_id != cur_thread and user32.AttachThreadInput(cur_thread, ui_thread_id, True))
        try:
            cmd = SW_RESTORE if user32.IsIconic(hwnd) else SW_SHOWNORMAL
            user32.ShowWindow(hwnd, cmd)
            user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
            user32.SetActiveWindow(hwnd)
        finally:
            if attached_ui:
                user32.AttachThreadInput(cur_thread, ui_thread_id, False)
            if attached_fg:
                user32.AttachThreadInput(cur_thread, fg_thread, False)

    def worker():
        for _ in range(100):
            if stop_event.is_set():
                return
            hwnd = find_dialog()
            if hwnd:
                promote(hwnd)
                if not stop_event.wait(0.15):
                    promote(hwnd)
                if not stop_event.wait(0.30):
                    promote(hwnd)
                return
            time.sleep(0.04)

    threading.Thread(target=worker, daemon=True).start()
    return stop_event


def main():
    title = '保存 AEP 工程文件夹'
    if '--dry-run' in sys.argv[1:]:
        ready = _start_windows_topmost_promoter(title, start_thread=False) is not None or sys.platform != 'win32'
        name = next((arg for arg in sys.argv[1:] if arg != '--dry-run'), None)
        print(json.dumps({'directory': name, 'title': title, 'topmostReady': ready}, ensure_ascii=False))
        return
    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    stop_event = _start_windows_topmost_promoter(title)
    try:
        directory = filedialog.asksaveasfilename(
            parent=root, title=title, initialfile=sys.argv[1],
            filetypes=[('AEP 工程文件夹', '*')], confirmoverwrite=False)
        print(json.dumps({'directory': directory or None}, ensure_ascii=False))
    finally:
        if stop_event is not None:
            stop_event.set()
        root.destroy()


if __name__ == '__main__':
    main()
