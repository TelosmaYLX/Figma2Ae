"""Move the plug-in's pixel maths to the shared FigmaImageGradeKernel.h.

Deletes the duplicated helper block from FigmaImageGrade.cpp, includes the kernel
header instead and lifts its names into the anonymous namespace.
"""

PATH = "sdk/AfterEffectsSDK_27.0_win/Examples/Template/FigmaImageGrade/FigmaImageGrade.cpp"

src = open(PATH, encoding="utf-8").read()

start_anchor = "    inline float clampf(float v, float lo, float hi)"
end_anchor = "    PF_Err renderGrade(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output)"

i0 = src.index(start_anchor)
i1 = src.index(end_anchor)
removed = i1 - i0
src = src[:i0] + src[i1:]

src = src.replace(
    '#include "AEFX_SuiteHandlerTemplate.h"\n\nnamespace\n{\n',
    '#include "AEFX_SuiteHandlerTemplate.h"\n\n#include "FigmaImageGradeKernel.h"\n\nnamespace\n{\n\n'
    '    using namespace fgb_grade;\n',
    1,
)

open(PATH, "w", encoding="utf-8", newline="\n").write(src)
print("removed", removed, "bytes of duplicated maths; has include:", "FigmaImageGradeKernel.h" in src)
