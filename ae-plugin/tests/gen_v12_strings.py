def c_literal(s: str) -> str:
    out = []
    for b in s.encode('utf-8'):
        if b < 0x20:
            out.append('\\x%02x' % b)
        elif b < 0x7f and b not in (0x22, 0x5c):
            out.append(chr(b))
        elif b == 0x22:
            out.append('\\"')
        elif b == 0x5c:
            out.append('\\\\')
        else:
            out.append('\\x%02x' % b)
    return ''.join(out)


strings = {
    'Name': 'Figma 背景模糊',
    'Description': '按图层 Alpha 复现 Figma 背景模糊：可分离三角核 + 形状边界归一化 clamp；放在调整层上，用遮罩或轨道遮罩定义模糊区域。v1.2',
    'Radius': '背景模糊半径 (px)',
    'AAEdge': '柔化边缘 (AA)',
    'MaskDebug': '显示遮罩 (调试)',
}
for k, v in strings.items():
    print(f'// {k}: {len(v.encode("utf-8"))} bytes')
    print(f'"{c_literal(v)}"')
