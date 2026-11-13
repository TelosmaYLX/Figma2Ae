"""Name an AEP export folder using the native Save As dialog."""
import json
import sys
import tkinter as tk
from tkinter import filedialog


def main():
    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    try:
        directory = filedialog.asksaveasfilename(
            parent=root, title='保存 AEP 工程文件夹', initialfile=sys.argv[1],
            filetypes=[('AEP 工程文件夹', '*')], confirmoverwrite=False)
        print(json.dumps({'directory': directory or None}, ensure_ascii=False))
    finally:
        root.destroy()


if __name__ == '__main__':
    main()
