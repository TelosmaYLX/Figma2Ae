"""Restore the helper functions that the profiling-strip script removed by
mistake, taking them verbatim from the v1.7 source snapshot in the deliverable."""

V17 = r"../deliverables/FigmaBackgroundBlurPlugin/src/FigmaBackgroundBlur.cpp"
CUR = r"sdk/AfterEffectsSDK_27.0_win/Examples/Template/FigmaBackgroundBlur/FigmaBackgroundBlur.cpp"

old = open(V17, encoding="utf-8").read()
cur = open(CUR, encoding="utf-8").read()

# block: from LineBuffers up to (not including) struct AlphaBounds (includes the
# namespace closings/reopenings and the section comment)
b0 = old.index("    struct LineBuffers")
b1 = old.index("    struct AlphaBounds")
block = old[b0:b1]

anchor = """    inline float clampf(float v, float lo, float hi)
    {
        return v < lo ? lo : (v > hi ? hi : v);
    }
"""

if "struct LineBuffers" in cur:
    raise SystemExit("current file already has LineBuffers; aborting")

i = cur.index(anchor) + len(anchor)
cur = cur[:i] + "\n" + block + cur[i:]
open(CUR, "w", encoding="utf-8", newline="\n").write(cur)
print("restored", len(block), "bytes; has:",
      all(k in cur for k in ("struct LineBuffers", "processLineVar", "readWorldPixel", "formatKind")))
