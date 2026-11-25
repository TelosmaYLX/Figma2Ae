import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

path = "sdk/AfterEffectsSDK_27.0_win/Examples/Template/FigmaBackgroundBlur/FigmaBackgroundBlur_Strings.cpp"
src = open(path, encoding="ascii").read()
lits = re.findall(r'"(?:[^"\\]|\\.)*"', src)


def decode(lit):
    body = lit[1:-1]
    out = bytearray()
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == "\\":
            nxt = body[i + 1]
            if nxt == "x":
                out.append(int(body[i + 2 : i + 4], 16))
                i += 4
                continue
            if nxt == '"':
                out.append(34)
                i += 2
                continue
            if nxt == "\\":
                out.append(92)
                i += 2
                continue
            raise SystemExit("bad escape at %d" % i)
        out.append(ord(ch))
        i += 1
    return out.decode("utf-8")


for lit in lits:
    print(repr(decode(lit)))
