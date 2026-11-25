def esc(s: str) -> str:
    out = []
    for b in s.encode("utf-8"):
        if b < 0x20:
            out.append("\\x%02x" % b)
        elif b < 0x7F and b not in (0x22, 0x5C):
            out.append(chr(b))
        elif b == 0x22:
            out.append('\\"')
        elif b == 0x5C:
            out.append("\\\\")
        else:
            out.append("\\x%02x" % b)
    return "".join(out)


items = {
    "Mode": "模式",
    "ModeChoices": "均匀|渐变",
    "StartRadius": "开始半径 (px)",
    "EndRadius": "结束半径 (px)",
    "GradStart": "渐变起点 (0-1)",
    "GradEnd": "渐变终点 (0-1)",
    "Description": "按 Alpha源图层 Alpha 复现 Figma 背景模糊（均匀/渐变）：可分离三角核 + 形状边界 clamp；渐变模式沿一条线在开始半径与结束半径之间逐像素插值。v1.5",
}
for k, v in items.items():
    print("//", k, len(v.encode("utf-8")), "bytes")
    print('"' + esc(v) + '"')
