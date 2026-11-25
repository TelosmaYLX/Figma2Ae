import re

p = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\ae-plugin\sdk\AfterEffectsSDK_27.0_win\Examples\Template\FigmaBackgroundBlur\FigmaBackgroundBlurPiPL.r"
data = open(p, encoding="utf-8").read()
data = data.replace('"Figma 背景模糊"', '"Figma \u80cc\u666f\u6a21\u7cca"')
data = data.replace('"F2A 插件"', '"F2A \u63d2\u4ef6"')
with open(p, "wb") as f:
    f.write(data.encode("gbk"))
print("written as GBK")
print("name GBK bytes:", "Figma \u80cc\u666f\u6a21\u7cca".encode("gbk").hex())
