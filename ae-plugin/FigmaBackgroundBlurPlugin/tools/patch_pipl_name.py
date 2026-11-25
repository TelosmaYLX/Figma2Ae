"""Patch the compiled .aex PiPL 'Name' and 'Category' strings to Chinese (GBK / CP936).

After Effects on a Chinese Windows installation decodes PiPL strings using the
system ANSI code page (CP936). The SDK PiPL toolchain (cl /EP -> PiPLtool -> rc.exe)
does not preserve non-ASCII PiPL strings reliably, so the PiPL source uses fixed-
length ASCII placeholders (see FigmaBackgroundBlurPiPL.r) and this post-build step
rewrites the two Pascal strings as CP936. The placeholder lengths are chosen so the
patched strings occupy exactly the same number of bytes (16 / 12), keeping the PiPL
binary layout unchanged.

Usage: python patch_pipl_name.py [path-to.aex]
"""
import sys

AEX = sys.argv[1] if len(sys.argv) > 1 else \
    r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\ae-plugin\build\FigmaBackgroundBlur.aex"

NAME_TEXT = "Figma 背景模糊"
CATEGORY_TEXT = "F2A 插件"

# 4-byte little-endian data length + ASCII placeholder (must match FigmaBackgroundBlurPiPL.r)
NAME_ANCHOR = b"\x10\x00\x00\x00" + b"\x0fFigmaBgBlurPadd"
CATEGORY_ANCHOR = b"\x0c\x00\x00\x00" + b"\x0aF2A PlugZz"


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
    patch_pascal(data, NAME_ANCHOR, 16, NAME_TEXT)
    patch_pascal(data, CATEGORY_ANCHOR, 12, CATEGORY_TEXT)
    open(AEX, "wb").write(data)
    print("written", AEX, len(data), "bytes")


if __name__ == "__main__":
    main()
