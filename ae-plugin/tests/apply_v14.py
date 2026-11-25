import re

BASE = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\ae-plugin\sdk\AfterEffectsSDK_27.0_win\Examples\Template\FigmaBackgroundBlur"


def edit(path, subs):
    p = BASE + "\\" + path
    text = open(p, encoding="utf-8", errors="replace").read()
    for old, new in subs:
        if old not in text:
            raise SystemExit(f"pattern not found in {path}: {old[:60]!r}")
        text = text.replace(old, new)
    open(p, "w", encoding="utf-8", newline="\n").write(text)
    print("patched", path)


# ---------- header ----------
edit("FigmaBackgroundBlur.h", [
    ("#define MINOR_VERSION 3", "#define MINOR_VERSION 4"),
    ("    FGB_MASK_LAYER,\n    FGB_MASK_DEBUG,\n    FGB_NUM_PARAMS",
     "    FGB_MASK_LAYER,\n    FGB_NUM_PARAMS"),
    ("    FGB_MASK_LAYER_DISK_ID,\n    FGB_MASK_DEBUG_DISK_ID\n};",
     "    FGB_MASK_LAYER_DISK_ID\n};"),
])

# ---------- cpp: drop the debug parameter ----------
edit("FigmaBackgroundBlur.cpp", [
    ("        const bool debugMask = params[FGB_MASK_DEBUG]->u.bd.value != 0;\n", ""),
    ("""                if (debugMask)
                {
                    outR = outG = outB = cover;
                }
                else if (cover > 0.0f)""",
     "                if (cover > 0.0f)"),
    ("""    AEFX_CLR_STRUCT(def);
    PF_ADD_CHECKBOXX(STR(StrID_MaskDebug_Param_Name), FALSE, 0, FGB_MASK_DEBUG_DISK_ID);

""", ""),
])

# ---------- strings ----------
edit("FigmaBackgroundBlur_Strings.h", [
    ("    StrID_MaskLayer_Param_Name,\n    StrID_MaskDebug_Param_Name,",
     "    StrID_MaskLayer_Param_Name,"),
])

edit("FigmaBackgroundBlur_Strings.cpp", [
    ('''    StrID_MaskLayer_Param_Name,
    /* "形状图层（Alpha）" */
    "\\xe5\\xbd\\xa2\\xe7\\x8a\\xb6\\xe5\\x9b\\xbe\\xe5\\xb1\\x82\\xef\\xbc\\x88" "Alpha" "\\xef\\xbc\\x89",
    StrID_MaskDebug_Param_Name,
    /* "显示遮罩 (调试)" */
    "\\xe6\\x98\\xbe\\xe7\\xa4\\xba\\xe9\\x81\\xae\\xe7\\xa9\\xb9 (\\xe8\\xb0\\x83\\xe8\\xaf\\x95)",''',
     '''    StrID_MaskLayer_Param_Name,
    /* "Alpha源" */
    "Alpha\\xe6\\xba\\x90",'''),
])

# ---------- PiPL version ----------
edit("FigmaBackgroundBlurPiPL.r", [
    ("622593 /* 1.3 */", "655361 /* 1.4 */"),
])
