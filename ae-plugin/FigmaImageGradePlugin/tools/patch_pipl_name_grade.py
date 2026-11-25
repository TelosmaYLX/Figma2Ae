"""Patch the compiled FigmaImageGrade.aex PiPL 'Name' and 'Category' strings to
Chinese (GBK / CP936), the code page AE uses for PiPL names on a Chinese Windows.

The PiPL source carries fixed-length ASCII placeholders so the patched Pascal
strings occupy exactly the same bytes (12 / 10) and the PiPL layout stays intact.

Usage: python patch_pipl_name_grade.py [path-to.aex]
"""
import sys

AEX = sys.argv[1] if len(sys.argv) > 1 else \
    r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\ae-plugin\build\FigmaImageGrade.aex"

NAME_TEXT = "Figma 调色"
CATEGORY_TEXT = "F2A 插件"

# 4-byte little-endian data length + ASCII placeholder (must match FigmaImageGradePiPL.r).
# Both Pascal fields are padded to a 4-byte boundary, so the data lengths are 12 / 12.
NAME_ANCHOR = b"\x0c\x00\x00\x00" + b"\x0aFigmaGrade"
CATEGORY_ANCHOR = b"\x0c\x00\x00\x00" + b"\x08F2APlugZ"


def pascal_gbk(text: str, field_len: int) -> bytes:
    data = text.encode("gbk")
    if len(data) + 1 > field_len:
        raise ValueError(f"{text!r} ({len(data)} GBK bytes) does not fit in {field_len} bytes")
    out = bytes([len(data)]) + data
    out += b"\x00" * (field_len - len(out))
    assert len(out) == field_len
    return out


def patch_pascal(data: bytearray, anchor: bytes, field_len: int, text: str) -> None:
    idx = data.find(anchor)
    if idx < 0:
        raise SystemExit(f"anchor not found: {anchor.hex()}")
    start = idx + 4  # skip the 4-byte data length
    data[start:start + field_len] = pascal_gbk(text, field_len)
    print(f"patched {text!r}: field at {start}, {field_len} bytes (anchor at {idx})")


def main():
    data = bytearray(open(AEX, "rb").read())
    patch_pascal(data, NAME_ANCHOR, 12, NAME_TEXT)
    patch_pascal(data, CATEGORY_ANCHOR, 12, CATEGORY_TEXT)
    open(AEX, "wb").write(data)
    print("written", AEX, len(data), "bytes")


if __name__ == "__main__":
    main()
