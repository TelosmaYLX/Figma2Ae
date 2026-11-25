import re

BASE = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\ae-plugin\sdk\AfterEffectsSDK_27.0_win\Examples\Template\FigmaBackgroundBlur"


def load(name):
    return open(BASE + "\\" + name, encoding="utf-8").read()


def save(name, text):
    open(BASE + "\\" + name, "w", encoding="utf-8", newline="\n").write(text)


# ---------------------------------------------------------------- header
h = load("FigmaBackgroundBlur.h")
h = h.replace("#define MINOR_VERSION 4", "#define MINOR_VERSION 5")
h = re.sub(
    r"enum\n\{\n    FGB_INPUT = 0,.*?\n\};",
    """enum
{
    FGB_INPUT = 0,
    FGB_MODE,
    FGB_RADIUS,
    FGB_START_RADIUS,
    FGB_END_RADIUS,
    FGB_GRAD_START,
    FGB_GRAD_END,
    FGB_AA_EDGE,
    FGB_MASK_LAYER,
    FGB_NUM_PARAMS
};""",
    h,
    count=1,
    flags=re.S,
)
h = re.sub(
    r"enum\n\{\n    FGB_RADIUS_DISK_ID = 1,.*?\n\};",
    """enum
{
    FGB_MODE_DISK_ID = 1,
    FGB_RADIUS_DISK_ID,
    FGB_START_RADIUS_DISK_ID,
    FGB_END_RADIUS_DISK_ID,
    FGB_GRAD_START_DISK_ID,
    FGB_GRAD_END_DISK_ID,
    FGB_AA_EDGE_DISK_ID,
    FGB_MASK_LAYER_DISK_ID
};""",
    h,
    count=1,
    flags=re.S,
)
save("FigmaBackgroundBlur.h", h)
print("header patched")

# ---------------------------------------------------------------- strings.h
sh = load("FigmaBackgroundBlur_Strings.h")
sh = re.sub(
    r"typedef enum\n\{.*?\n\} StrIDType;",
    """typedef enum
{
    StrID_NONE,
    StrID_Name,
    StrID_Description,
    StrID_Mode_Param_Name,
    StrID_Mode_Choices,
    StrID_Radius_Param_Name,
    StrID_StartRadius_Param_Name,
    StrID_EndRadius_Param_Name,
    StrID_GradStart_Param_Name,
    StrID_GradEnd_Param_Name,
    StrID_AAEdge_Param_Name,
    StrID_MaskLayer_Param_Name,
    StrID_NUMTYPES
} StrIDType;""",
    sh,
    count=1,
    flags=re.S,
)
save("FigmaBackgroundBlur_Strings.h", sh)
print("strings.h patched")

# ---------------------------------------------------------------- strings.cpp
strings = r'''/*******************************************************************/
/*  FigmaBackgroundBlur_Strings.cpp                                */
/*                                                                 */
/*  All UI strings are UTF-8 byte sequences (the plug-in sets       */
/*  PF_OutFlag2_STRINGS_ARE_UTF8 in global setup). The source is    */
/*  pure ASCII: Chinese text is written as \xNN UTF-8 escapes so    */
/*  the build does not depend on the compiler code page.            */
/*******************************************************************/

#include "FigmaBackgroundBlur.h"

typedef struct
{
    A_u_long index;
    A_char str[256];
} TableString;

TableString g_strs[StrID_NUMTYPES] = {
    StrID_NONE,
    "",
    StrID_Name,
    /* "Figma 背景模糊" */
    "Figma \xe8\x83\x8c\xe6\x99\xaf\xe6\xa8\xa1\xe7\xb3\x8a",
    StrID_Description,
    /* "...v1.5" */
    "\xe6\x8c\x89 Alpha\xe6\xba\x90\xe5\x9b\xbe\xe5\xb1\x82 Alpha \xe5\xa4\x8d\xe7\x8e\xb0 Figma "
    "\xe8\x83\x8c\xe6\x99\xaf\xe6\xa8\xa1\xe7\xb3\x8a\xef\xbc\x88\xe5\x9d\x87\xe5\x8c\x80/\xe6\xb8\x90\xe5\x8f\x98\xef\xbc\x89"
    "\xef\xbc\x9a\xe5\x8f\xaf\xe5\x88\x86\xe7\xa6\xbb\xe4\xb8\x89\xe8\xa7\x92\xe6\xa0\xb8 + "
    "\xe5\xbd\xa2\xe7\x8a\xb6\xe8\xbe\xb9\xe7\x95\x8c clamp\xef\xbc\x9b"
    "\xe6\xb8\x90\xe5\x8f\x98\xe6\xa8\xa1\xe5\xbc\x8f\xe6\xb2\xbf\xe4\xb8\x80\xe6\x9d\xa1\xe7\xba\xbf"
    "\xe5\x9c\xa8\xe5\xbc\x80\xe5\xa7\x8b\xe5\x8d\x8a\xe5\xbe\x84\xe4\xb8\x8e\xe7\xbb\x93\xe6\x9d\x9f"
    "\xe5\x8d\x8a\xe5\xbe\x84\xe4\xb9\x8b\xe9\x97\xb4\xe9\x80\x90\xe5\x83\x8f\xe7\xb4\xa0\xe6\x8f\x92"
    "\xe5\x80\xbc\xe3\x80\x82v1.5",
    StrID_Mode_Param_Name,
    /* "模式" */
    "\xe6\xa8\xa1\xe5\xbc\x8f",
    StrID_Mode_Choices,
    /* "均匀|渐变" */
    "\xe5\x9d\x87\xe5\x8c\x80|\xe6\xb8\x90\xe5\x8f\x98",
    StrID_Radius_Param_Name,
    /* "背景模糊半径 (px)" */
    "\xe8\x83\x8c\xe6\x99\xaf\xe6\xa8\xa1\xe7\xb3\x8a\xe5\x8d\x8a\xe5\xbe\x84 (px)",
    StrID_StartRadius_Param_Name,
    /* "开始半径 (px)" */
    "\xe5\xbc\x80\xe5\xa7\x8b\xe5\x8d\x8a\xe5\xbe\x84 (px)",
    StrID_EndRadius_Param_Name,
    /* "结束半径 (px)" */
    "\xe7\xbb\x93\xe6\x9d\x9f\xe5\x8d\x8a\xe5\xbe\x84 (px)",
    StrID_GradStart_Param_Name,
    /* "渐变起点 (0-1)" */
    "\xe6\xb8\x90\xe5\x8f\x98\xe8\xb5\xb7\xe7\x82\xb9 (0-1)",
    StrID_GradEnd_Param_Name,
    /* "渐变终点 (0-1)" */
    "\xe6\xb8\x90\xe5\x8f\x98\xe7\xbb\x88\xe7\x82\xb9 (0-1)",
    StrID_AAEdge_Param_Name,
    /* "柔化边缘 (AA)" */
    "\xe6\x9f\x94\xe5\x8c\x96\xe8\xbe\xb9\xe7\xbc\x98 (AA)",
    StrID_MaskLayer_Param_Name,
    /* "Alpha源" */
    "Alpha\xe6\xba\x90",
};

char* GetStringPtr(int strNum)
{
    return g_strs[strNum].str;
}
'''
save("FigmaBackgroundBlur_Strings.cpp", strings)
print("strings.cpp patched")

# ---------------------------------------------------------------- PiPL version
r = load("FigmaBackgroundBlurPiPL.r")
r = r.replace("655361 /* 1.4 */", "688129 /* 1.5 */")
save("FigmaBackgroundBlurPiPL.r", r)
print("PiPL patched")
