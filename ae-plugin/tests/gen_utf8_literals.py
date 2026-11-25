def c_literal(s: str) -> str:
    """Encode a unicode string as a C UTF-8 byte literal using \\x escapes for non-ASCII."""
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
    # avoid a following hex digit gluing to an escape
    res = ''.join(out)
    return res


strings = {
    'StrID_Name': 'Figma 背景模糊',
    'StrID_Description': '实时复现 Figma 背景模糊算法：可分离三角核 + 形状边界归一化 clamp，放置在调整层上使用，模糊只作用于形状内的背景。v1.1：多帧渲染优化。',
    'StrID_Radius_Param_Name': '背景模糊半径 (px)',
    'StrID_CenterX_Param_Name': '中心 X',
    'StrID_CenterY_Param_Name': '中心 Y',
    'StrID_Width_Param_Name': '形状宽度',
    'StrID_Height_Param_Name': '形状高度',
    'StrID_Corner_Param_Name': '圆角半径',
    'StrID_AAEdge_Param_Name': '柔化边缘 (AA)',
}

for k, v in strings.items():
    print(f'{k}: "{c_literal(v)}"')
    print(f'   bytes: {len(v.encode("utf-8"))}, text: {v}')
