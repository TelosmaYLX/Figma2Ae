"""Exercise the real Windows Save As filename field and cancellation."""
import contextlib
import ctypes
from ctypes import wintypes
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import threading
import time

script = Path(__file__).resolve().parents[1] / 'scripts/aep/choose-destination.py'
spec = importlib.util.spec_from_file_location('destination', script)
destination = importlib.util.module_from_spec(spec)
spec.loader.exec_module(destination)
user32 = ctypes.windll.user32
callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]


def text(hwnd):
    result = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, result, len(result))
    return result.value


def run(cancel):
    errors = []

    def interact():
        try:
            for _ in range(50):
                dialogs = []

                @callback
                def find(hwnd, _):
                    pid = wintypes.DWORD()
                    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                    if pid.value == os.getpid() and text(hwnd) == '保存 AEP 工程文件夹':
                        dialogs.append(hwnd)
                    return True

                user32.EnumWindows(find, 0)
                if dialogs:
                    hwnd = dialogs[0]
                    if cancel:
                        user32.PostMessageW(hwnd, 0x111, 2, 0)
                        return
                    edits = []

                    @callback
                    def find_edit(child, _):
                        name = ctypes.create_unicode_buffer(256)
                        user32.GetClassNameW(child, name, len(name))
                        if name.value == 'Edit' and text(child) == 'Original Selection':
                            edits.append(child)
                        return True

                    user32.EnumChildWindows(hwnd, find_edit, 0)
                    if edits:
                        value = ctypes.c_wchar_p('自定义 工程')
                        user32.SendMessageW(edits[0], 0xC, 0, ctypes.cast(value, ctypes.c_void_p).value)
                        user32.PostMessageW(hwnd, 0x111, 1, 0)
                        return
                time.sleep(.2)
            raise AssertionError('Native Save As filename field not found')
        except Exception as error:
            errors.append(str(error))
            for hwnd in dialogs:
                user32.PostMessageW(hwnd, 0x111, 2, 0)

    worker = threading.Thread(target=interact, daemon=True)
    sys.argv = [str(script), 'Original Selection']
    output = io.StringIO()
    worker.start()
    with contextlib.redirect_stdout(output):
        destination.main()
    worker.join(12)
    assert not worker.is_alive()
    assert not errors, errors
    result = json.loads(output.getvalue())['directory']
    if cancel:
        assert result is None, result
    else:
        assert Path(result).name == '自定义 工程', result


run(False)
run(True)
print('PASS: real Windows Save As accepts a custom Unicode filename; cancel returns null')
