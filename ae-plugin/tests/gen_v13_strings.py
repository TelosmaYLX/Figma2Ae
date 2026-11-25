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
    "MaskLayer": "形状图层（Alpha）",
    "Description": "按形状图层 Alpha 复现 Figma 背景模糊：放在调整层上，选择形状图层，遮罩/轨道遮罩/形状动画直接控制模糊区域，可分离三角核 + 形状边界 clamp。v1.3",
}
for k, v in items.items():
    print("//", k, len(v.encode("utf-8")), "bytes")
    print('"' + esc(v) + '"')
