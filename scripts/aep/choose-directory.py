"""Select the parent directory for a direct AEP export using the native dialog."""
import json
import tkinter as tk
from tkinter import filedialog


def main():
    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    try:
        directory = filedialog.askdirectory(parent=root, title='选择 AEP 导出位置', mustexist=True)
        print(json.dumps({'directory': directory or None}, ensure_ascii=False))
    finally:
        root.destroy()


if __name__ == '__main__':
    main()
