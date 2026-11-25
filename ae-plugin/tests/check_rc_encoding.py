import os

base = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\ae-plugin\sdk\AfterEffectsSDK_27.0_win\Examples\Template\FigmaBackgroundBlur\Win"
for name in ["FigmaBackgroundBlurPiPL.rc"]:
    p = os.path.join(base, name)
    data = open(p, "rb").read()
    i = data.find(b"Figma")
    print(name, "size", len(data), "first Figma at", i)
    print("  hex:", data[i - 6:i + 26].hex())
    print("  repr:", data[i - 6:i + 26])
