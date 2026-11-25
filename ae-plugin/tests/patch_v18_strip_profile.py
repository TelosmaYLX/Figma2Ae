"""Strip the temporary profiling instrumentation from the plug-in source."""

PATH = "sdk/AfterEffectsSDK_27.0_win/Examples/Template/FigmaBackgroundBlur/FigmaBackgroundBlur.cpp"

src = open(PATH, encoding="utf-8").read()

# 1) remove the FgbProfile helper struct
start = src.index("    // TEMPORARY PROFILING (remove before release): per-render stage timings,")
end = src.index("    struct AlphaBounds", start)
src = src[:start] + src[end:]

# 2) drop every mark/log statement
src = src.replace("        FgbProfile prof;\n", "")
src = src.replace("        prof.mark();\n\n", "")
src = src.replace("        prof.mark();\n", "")

# 3) remove the profiling log block
log_start = src.index('        if (const char* log_path = std::getenv("FGB_PROFILE_LOG"))')
log_end = src.index("        return err;", log_start)
src = src[:log_start] + src[log_end:]

# 4) drop the includes that were only needed for the profiling logger
src = src.replace("#include <cstdio>\n#include <cstdlib>\n", "")

open(PATH, "w", encoding="utf-8", newline="\n").write(src)
print("profiling removed:", "FgbProfile" not in src, "prof.mark" not in src, "FGB_PROFILE_LOG" not in src)
