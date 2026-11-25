p = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\deliverables\FigmaBackgroundBlurPlugin\README.md"
text = open(p, encoding="utf-8").read()

subs = [
    ("# Figma 背景模糊 — After Effects 效果插件（v1.3）",
     "# Figma 背景模糊 — After Effects 效果插件（v1.4）"),
    ("| 参数 | 背景模糊半径 (px)、柔化边缘 (AA)、**形状图层（Alpha）**、显示遮罩 (调试) |",
     "| 参数 | 背景模糊半径 (px)、柔化边缘 (AA)、**Alpha源** |"),
    ("| 版本 | 1.3.0 |", "| 版本 | 1.4.0 |"),
    ("SHA256 `1fa824543d7545353a403af9e80f7108adb44fd0e9de7fd7e96e58ab55d9ac0d`",
     "SHA256 `3a6fdbce09b9a9ee3c8e1b4e8a6493f46599516efd1971ab3484767bf6b61413`"),
    ("- 在参数 **形状图层（Alpha）** 里选择承载形状的图层",
     "- 在参数 **Alpha源** 里选择承载形状的图层"),
    ("3. 把 **形状图层（Alpha）** 设置成你的卡片层/形状层",
     "3. 把 **Alpha源** 设置成你的卡片层/形状层"),
    ("- 参数 **`形状图层（Alpha）`** 选你的卡片层/形状层",
     "- 参数 **`Alpha源`** 选你的卡片层/形状层"),
    ("- 参数 **`形状图层（Alpha）`**", "- 参数 **`Alpha源`**"),
]

for old, new in subs:
    if old in text:
        text = text.replace(old, new)
    else:
        print("not found (ok):", old[:50])

# ensure no leftover debug param mentions
text = text.replace("、显示遮罩 (调试)", "")
open(p, "w", encoding="utf-8", newline="\n").write(text)
print("README updated")
print([line for line in text.splitlines() if "Alpha源" in line or "1.4.0" in line or "3a6fdbce" in line][:8])
