import re

p = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\ae-plugin\sdk\AfterEffectsSDK_27.0_win\Examples\Template\FigmaBackgroundBlur\FigmaBackgroundBlur_Strings.cpp"
text = open(p, encoding="utf-8").read()

pattern = re.compile(
    r'    StrID_MaskLayer_Param_Name,\r?\n'
    r'    /\*.*?\*/\r?\n'
    r'    "(?:\\x[0-9a-fA-F]{2}|[^"\\]|\\.)*"(?:\s*"(?:\\x[0-9a-fA-F]{2}|[^"\\]|\\.)*")*,\r?\n'
    r'    StrID_MaskDebug_Param_Name,\r?\n'
    r'    /\*.*?\*/\r?\n'
    r'    "(?:\\x[0-9a-fA-F]{2}|[^"\\]|\\.)*",\r?\n',
    re.S,
)

new_block = (
    '    StrID_MaskLayer_Param_Name,\n'
    '    /* "Alpha源" */\n'
    '    "Alpha\\xe6\\xba\\x90",\n'
)

text2, n = pattern.subn(new_block, text)
if n != 1:
    raise SystemExit(f"expected 1 replacement, got {n}")
open(p, "w", encoding="utf-8", newline="\n").write(text2)
print("patched strings.cpp")
print(text2.split("StrID_Radius_Param_Name")[0][-400:])
