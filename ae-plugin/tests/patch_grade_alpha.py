"""Split gradePixel into the straight-alpha and premultiplied variants and remove
the temporary host probe from the plug-in.

After Effects hands an effect the layer's own pixel representation: straight-alpha
footage arrives un-premultiplied (and AE premultiplies the effect's output when
compositing), while premultiplied footage and the composite under an adjustment
layer arrive premultiplied. The plug-in therefore detects the representation and
grades accordingly - which also matches Figma, whose shader grades straight colour
and only then premultiplies by the fill opacity.
"""

KERNEL = "sdk/AfterEffectsSDK_27.0_win/Examples/Template/FigmaImageGrade/FigmaImageGradeKernel.h"
CPP = "sdk/AfterEffectsSDK_27.0_win/Examples/Template/FigmaImageGrade/FigmaImageGrade.cpp"

# ---------------------------------------------------------------- kernel ------
k = open(KERNEL, encoding="utf-8").read()

old_start = "    // premultiplied, gamma-encoded pixel -> graded premultiplied, encoded pixel"
old_end = "} // namespace fgb_grade"
i0 = k.index(old_start)
i1 = k.index(old_end)

new_kernel_tail = '''    // premultiplied, gamma-encoded pixel -> graded premultiplied, encoded pixel
    inline void gradePixelPremul(float pr, float pg, float pb, float alpha, const GradeParams& p, float& outR,
                                 float& outG, float& outB)
    {
        if (!(alpha > 0.0f))
        {
            outR = 0.0f;
            outG = 0.0f;
            outB = 0.0f;
            return;
        }

        // straight (un-premultiplied) encoded colour
        const float invA = (alpha >= 1.0f) ? 1.0f : (1.0f / alpha);
        float r = fastPow(pr * invA, kGamma);
        float g = fastPow(pg * invA, kGamma);
        float b = fastPow(pb * invA, kGamma);

        gradeLinearToEncoded(p, r, g, b);

        // premultiply again, like Figma does after applying the fill opacity
        outR = r * alpha;
        outG = g * alpha;
        outB = b * alpha;
    }

    // straight (un-premultiplied) encoded pixel -> graded straight encoded pixel
    inline void gradePixelStraight(float sr, float sg, float sb, float alpha, const GradeParams& p, float& outR,
                                   float& outG, float& outB)
    {
        if (!(alpha > 0.0f))
        {
            outR = 0.0f;
            outG = 0.0f;
            outB = 0.0f;
            return;
        }

        float r = fastPow(sr, kGamma);
        float g = fastPow(sg, kGamma);
        float b = fastPow(sb, kGamma);
        gradeLinearToEncoded(p, r, g, b);
        outR = r;
        outG = g;
        outB = b;
    }

'''
k = k[:i0] + new_kernel_tail + k[i1:]
open(KERNEL, "w", encoding="utf-8", newline="\n").write(k)
print("kernel updated:", "gradePixelStraight" in k and "gradePixelPremul" in k)

# ------------------------------------------------------------------- cpp ------
c = open(CPP, encoding="utf-8").read()

# 1) drop the temporary probe block
probe_start = "        // TEMPORARY PROBE (env FGB_GRADE_PROBE):"
probe_end = "        switch (format)"
j0 = c.index(probe_start)
j1 = c.index(probe_end)
c = c[:j0] + c[j1:]
c = c.replace("#include <cstring>\n#include <cstdlib>", "#include <cstring>")

# 2) alpha-representation detection helper, placed before renderGrade
anchor = "    PF_Err renderGrade(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output)"
detect = '''    // After Effects hands an effect the layer's own pixel representation:
    // straight-alpha footage arrives un-premultiplied (AE premultiplies the
    // effect's output when compositing), while premultiplied footage and the
    // composite below an adjustment layer arrive premultiplied. A colour value
    // above the alpha value can only exist in straight data, so a coarse scan
    // tells the two apart.
    template <typename PIXEL, typename SAMPLE>
    bool worldIsPremultiplied(const PF_EffectWorld* w, SAMPLE tolerance)
    {
        const long wpx = w->width;
        const long hpx = w->height;
        if (wpx <= 0 || hpx <= 0)
        {
            return true;
        }

        const long total = wpx * hpx;
        const long step = (total > 262144) ? 7 : 1; // coarse scan on big images
        for (long y = 0; y < hpx; y += step)
        {
            const PIXEL* row = reinterpret_cast<const PIXEL*>(reinterpret_cast<const char*>(w->data) +
                                                              static_cast<size_t>(y) * w->rowbytes);
            for (long x = 0; x < wpx; x += step)
            {
                const SAMPLE a = static_cast<SAMPLE>(row[x].alpha);
                if (row[x].red > a + tolerance || row[x].green > a + tolerance || row[x].blue > a + tolerance)
                {
                    return false; // straight (un-premultiplied) data
                }
            }
        }
        return true;
    }

'''
c = c.replace(anchor, detect + anchor, 1)

# 3) detection call after the pixel format is known, and route the three loops
c = c.replace(
    "        PF_PixelFormat format = PF_PixelFormat_INVALID;\n        ERR(worldSuite->PF_GetPixelFormat(src, &format));\n",
    "        PF_PixelFormat format = PF_PixelFormat_INVALID;\n        ERR(worldSuite->PF_GetPixelFormat(src, &format));\n\n"
    "        bool premultiplied = true;\n"
    "        switch (format)\n"
    "        {\n"
    "            case PF_PixelFormat_ARGB32:\n"
    "                premultiplied = worldIsPremultiplied<PF_Pixel8>(src, 1);\n"
    "                break;\n"
    "            case PF_PixelFormat_ARGB64:\n"
    "                premultiplied = worldIsPremultiplied<PF_Pixel16>(src, 256);\n"
    "                break;\n"
    "            case PF_PixelFormat_ARGB128:\n"
    "                premultiplied = worldIsPremultiplied<PF_PixelFloat>(src, 0.004f);\n"
    "                break;\n"
    "            default:\n"
    "                break;\n"
    "        }\n",
    1,
)

# 8 bpc / 16 bpc / 32 bpc call sites
c = c.replace(
    """                        gradePixel(static_cast<float>(s[x].red) * (1.0f / 255.0f),
                                   static_cast<float>(s[x].green) * (1.0f / 255.0f),
                                   static_cast<float>(s[x].blue) * (1.0f / 255.0f),
                                   alpha,
                                   p,
                                   r,
                                   g,
                                   b);""",
    """                        if (premultiplied)
                        {
                            gradePixelPremul(static_cast<float>(s[x].red) * (1.0f / 255.0f),
                                             static_cast<float>(s[x].green) * (1.0f / 255.0f),
                                             static_cast<float>(s[x].blue) * (1.0f / 255.0f),
                                             alpha,
                                             p,
                                             r,
                                             g,
                                             b);
                        }
                        else
                        {
                            gradePixelStraight(static_cast<float>(s[x].red) * (1.0f / 255.0f),
                                               static_cast<float>(s[x].green) * (1.0f / 255.0f),
                                               static_cast<float>(s[x].blue) * (1.0f / 255.0f),
                                               alpha,
                                               p,
                                               r,
                                               g,
                                               b);
                        }""",
    1,
)
c = c.replace(
    """                        gradePixel(static_cast<float>(s[x].red) * (1.0f / 32768.0f),
                                   static_cast<float>(s[x].green) * (1.0f / 32768.0f),
                                   static_cast<float>(s[x].blue) * (1.0f / 32768.0f),
                                   alpha,
                                   p,
                                   r,
                                   g,
                                   b);""",
    """                        if (premultiplied)
                        {
                            gradePixelPremul(static_cast<float>(s[x].red) * (1.0f / 32768.0f),
                                             static_cast<float>(s[x].green) * (1.0f / 32768.0f),
                                             static_cast<float>(s[x].blue) * (1.0f / 32768.0f),
                                             alpha,
                                             p,
                                             r,
                                             g,
                                             b);
                        }
                        else
                        {
                            gradePixelStraight(static_cast<float>(s[x].red) * (1.0f / 32768.0f),
                                               static_cast<float>(s[x].green) * (1.0f / 32768.0f),
                                               static_cast<float>(s[x].blue) * (1.0f / 32768.0f),
                                               alpha,
                                               p,
                                               r,
                                               g,
                                               b);
                        }""",
    1,
)
c = c.replace(
    "                        gradePixel(s[x].red, s[x].green, s[x].blue, s[x].alpha, p, r, g, b);",
    """                        if (premultiplied)
                        {
                            gradePixelPremul(s[x].red, s[x].green, s[x].blue, s[x].alpha, p, r, g, b);
                        }
                        else
                        {
                            gradePixelStraight(s[x].red, s[x].green, s[x].blue, s[x].alpha, p, r, g, b);
                        }""",
    1,
)

open(CPP, "w", encoding="utf-8", newline="\n").write(c)
print("cpp updated:", "worldIsPremultiplied" in c, "gradePixelStraight" in c, "FGB_GRADE_PROBE" not in c)
