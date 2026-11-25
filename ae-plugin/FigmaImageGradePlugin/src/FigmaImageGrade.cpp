/*******************************************************************/
/*  FigmaImageGrade.cpp                                            */
/*                                                                 */
/*  After Effects reproduction of Figma's image-fill colour grade.  */
/*                                                                 */
/*  Seven sliders (exposure, contrast, saturation, temperature,     */
/*  tint, highlights, shadows) run Figma's own canvas shader on the */
/*  input pixels, so the result matches Figma's PNG export to within*/
/*  one 8-bit code value (99.9967% of all RGB channel values are    */
/*  reproduced exactly, see tests/image-filter-study.md).          */
/*                                                                 */
/*  Ordering (from the reverse-engineered shader):                  */
/*    1. decode sRGB to linear with RGB^2.2                         */
/*    2. per-pixel exposure compensation from the ORIGINAL luminance*/
/*       (highlights above 0.5^2.2, shadows below, the -0.999 scale)*/
/*    3. Lab-space white balance (b*), tint (a*) and contrast (L*)  */
/*    4. exposure curve that also mixes the colour toward grey      */
/*    5. saturation, then encode with RGB^(1/2.2)                   */
/*                                                                 */
/*  Alpha: the grade is applied to straight colour and the result is*/
/*  premultiplied again, exactly like Figma premultiplies after the */
/*  fill opacity. 8/16/32 bpc, multi-frame rendering.               */
/*******************************************************************/

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include "FigmaImageGrade.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "AEFX_SuiteHandlerTemplate.h"

#include "FigmaImageGradeKernel.h"

namespace
{

    using namespace fgb_grade;

    // After Effects hands an effect the layer's own pixel representation:
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

    PF_Err renderGrade(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output)
    {
        PF_Err err = PF_Err_NONE;

        PF_EffectWorld* src = &params[GRADE_INPUT]->u.ld;
        PF_EffectWorld* dst = output;

        if (!src->data || !dst->data || src->width <= 0 || src->height <= 0)
        {
            return PF_Err_NONE;
        }

        // Figma UI values (-100..100) -> shader values (-1..1)
        GradeParams p;
        p.exposure = static_cast<float>(params[GRADE_EXPOSURE]->u.fs_d.value) * 0.01f;
        p.contrast = static_cast<float>(params[GRADE_CONTRAST]->u.fs_d.value) * 0.01f;
        p.saturation = static_cast<float>(params[GRADE_SATURATION]->u.fs_d.value) * 0.01f;
        p.temperature = static_cast<float>(params[GRADE_TEMPERATURE]->u.fs_d.value) * 0.01f;
        p.tint = static_cast<float>(params[GRADE_TINT]->u.fs_d.value) * 0.01f;
        p.highlights = static_cast<float>(params[GRADE_HIGHLIGHTS]->u.fs_d.value) * 0.01f;
        p.shadows = static_cast<float>(params[GRADE_SHADOWS]->u.fs_d.value) * 0.01f;

        const long width = src->width;
        const long height = src->height;

        AEFX_SuiteScoper<PF_WorldSuite2> worldSuite(in_data, kPFWorldSuite, kPFWorldSuiteVersion2, out_data);

        PF_PixelFormat format = PF_PixelFormat_INVALID;
        ERR(worldSuite->PF_GetPixelFormat(src, &format));

        bool premultiplied = true;
        switch (format)
        {
            case PF_PixelFormat_ARGB32:
                premultiplied = worldIsPremultiplied<PF_Pixel8>(src, 1);
                break;
            case PF_PixelFormat_ARGB64:
                premultiplied = worldIsPremultiplied<PF_Pixel16>(src, 256);
                break;
            case PF_PixelFormat_ARGB128:
                premultiplied = worldIsPremultiplied<PF_PixelFloat>(src, 0.004f);
                break;
            default:
                break;
        }

        // Nothing to do: pass the layer through untouched.
        if (p.identity())
        {
            const size_t bytes = static_cast<size_t>(width) * 4u;
            for (long y = 0; y < height; ++y)
            {
                const char* s = reinterpret_cast<const char*>(src->data) + static_cast<size_t>(y) * src->rowbytes;
                char* d = reinterpret_cast<char*>(dst->data) + static_cast<size_t>(y) * dst->rowbytes;
                std::memcpy(d, s, bytes);
            }
            return err;
        }

        switch (format)
        {
            case PF_PixelFormat_ARGB32:
            {
                for (long y = 0; y < height; ++y)
                {
                    const PF_Pixel8* s = reinterpret_cast<const PF_Pixel8*>(
                        reinterpret_cast<const char*>(src->data) + static_cast<size_t>(y) * src->rowbytes);
                    PF_Pixel8* d = reinterpret_cast<PF_Pixel8*>(reinterpret_cast<char*>(dst->data) +
                                                                static_cast<size_t>(y) * dst->rowbytes);
                    long x = 0;
#if defined(FGB_GRADE_SSE2)
                    if (!premultiplied)
                    {
                        // 4 pixels at a time; straight colour, so alpha only masks
                        // fully transparent pixels (the same result as the scalar path)
                        const float* lut = decodeTable8().data();
                        for (; x + 4 <= width; x += 4)
                        {
                            __m128 r = _mm_set_ps(lut[s[x + 3].red], lut[s[x + 2].red], lut[s[x + 1].red],
                                                  lut[s[x + 0].red]);
                            __m128 g = _mm_set_ps(lut[s[x + 3].green], lut[s[x + 2].green], lut[s[x + 1].green],
                                                  lut[s[x + 0].green]);
                            __m128 b = _mm_set_ps(lut[s[x + 3].blue], lut[s[x + 2].blue], lut[s[x + 1].blue],
                                                  lut[s[x + 0].blue]);

                            fgb_grade::simd::gradeLinearToEncoded_ps(p, r, g, b);

                            const __m128 alpha = _mm_set_ps(static_cast<float>(s[x + 3].alpha) * (1.0f / 255.0f),
                                                            static_cast<float>(s[x + 2].alpha) * (1.0f / 255.0f),
                                                            static_cast<float>(s[x + 1].alpha) * (1.0f / 255.0f),
                                                            static_cast<float>(s[x + 0].alpha) * (1.0f / 255.0f));
                            const __m128 visible = _mm_cmpgt_ps(alpha, fgb_grade::simd::zero());
                            const __m128 outR = _mm_and_ps(r, visible);
                            const __m128 outG = _mm_and_ps(g, visible);
                            const __m128 outB = _mm_and_ps(b, visible);

                            float fr[4], fg[4], fb[4];
                            _mm_storeu_ps(fr, outR);
                            _mm_storeu_ps(fg, outG);
                            _mm_storeu_ps(fb, outB);
                            for (int k = 0; k < 4; ++k)
                            {
                                d[x + k].alpha = s[x + k].alpha;
                                d[x + k].red = static_cast<A_u_char>(clampf(fr[k] * 255.0f + 0.5f, 0.0f, 255.0f));
                                d[x + k].green = static_cast<A_u_char>(clampf(fg[k] * 255.0f + 0.5f, 0.0f, 255.0f));
                                d[x + k].blue = static_cast<A_u_char>(clampf(fb[k] * 255.0f + 0.5f, 0.0f, 255.0f));
                            }
                        }
                    }
#endif
                    for (; x < width; ++x)
                    {
                        const float alpha = static_cast<float>(s[x].alpha) * (1.0f / 255.0f);
                        float r, g, b;
                        if (premultiplied)
                        {
                            gradePremul8(s[x].red, s[x].green, s[x].blue, alpha, p, r, g, b);
                        }
                        else
                        {
                            gradeStraight8(s[x].red, s[x].green, s[x].blue, alpha, p, r, g, b);
                        }
                        d[x].alpha = s[x].alpha;
                        d[x].red = static_cast<A_u_char>(clampf(r * 255.0f + 0.5f, 0.0f, 255.0f));
                        d[x].green = static_cast<A_u_char>(clampf(g * 255.0f + 0.5f, 0.0f, 255.0f));
                        d[x].blue = static_cast<A_u_char>(clampf(b * 255.0f + 0.5f, 0.0f, 255.0f));
                    }
                }
                break;
            }
            case PF_PixelFormat_ARGB64:
            {
                for (long y = 0; y < height; ++y)
                {
                    const PF_Pixel16* s = reinterpret_cast<const PF_Pixel16*>(
                        reinterpret_cast<const char*>(src->data) + static_cast<size_t>(y) * src->rowbytes);
                    PF_Pixel16* d = reinterpret_cast<PF_Pixel16*>(reinterpret_cast<char*>(dst->data) +
                                                                  static_cast<size_t>(y) * dst->rowbytes);
                    long x = 0;
#if defined(FGB_GRADE_SSE2)
                    for (; x + 4 <= width; x += 4)
                    {
                        constexpr float k = 1.0f / 32768.0f;
                        __m128 r = _mm_mul_ps(_mm_set_ps(static_cast<float>(s[x + 3].red),
                                                         static_cast<float>(s[x + 2].red),
                                                         static_cast<float>(s[x + 1].red),
                                                         static_cast<float>(s[x + 0].red)),
                                              _mm_set1_ps(k));
                        __m128 g = _mm_mul_ps(_mm_set_ps(static_cast<float>(s[x + 3].green),
                                                         static_cast<float>(s[x + 2].green),
                                                         static_cast<float>(s[x + 1].green),
                                                         static_cast<float>(s[x + 0].green)),
                                              _mm_set1_ps(k));
                        __m128 b = _mm_mul_ps(_mm_set_ps(static_cast<float>(s[x + 3].blue),
                                                         static_cast<float>(s[x + 2].blue),
                                                         static_cast<float>(s[x + 1].blue),
                                                         static_cast<float>(s[x + 0].blue)),
                                              _mm_set1_ps(k));
                        const __m128 alpha = _mm_mul_ps(_mm_set_ps(static_cast<float>(s[x + 3].alpha),
                                                                   static_cast<float>(s[x + 2].alpha),
                                                                   static_cast<float>(s[x + 1].alpha),
                                                                   static_cast<float>(s[x + 0].alpha)),
                                                        _mm_set1_ps(k));

                        if (premultiplied)
                        {
                            fgb_grade::simd::gradePremul4(p, r, g, b, alpha);
                        }
                        else
                        {
                            fgb_grade::simd::gradeStraight4(p, r, g, b);
                            const __m128 visible = _mm_cmpgt_ps(alpha, fgb_grade::simd::zero());
                            r = _mm_and_ps(r, visible);
                            g = _mm_and_ps(g, visible);
                            b = _mm_and_ps(b, visible);
                        }

                        float fr[4], fg[4], fb[4];
                        _mm_storeu_ps(fr, r);
                        _mm_storeu_ps(fg, g);
                        _mm_storeu_ps(fb, b);
                        for (int j = 0; j < 4; ++j)
                        {
                            d[x + j].alpha = s[x + j].alpha;
                            d[x + j].red = static_cast<A_u_short>(clampf(fr[j] * 32768.0f + 0.5f, 0.0f, 32768.0f));
                            d[x + j].green = static_cast<A_u_short>(clampf(fg[j] * 32768.0f + 0.5f, 0.0f, 32768.0f));
                            d[x + j].blue = static_cast<A_u_short>(clampf(fb[j] * 32768.0f + 0.5f, 0.0f, 32768.0f));
                        }
                    }
#endif
                    for (; x < width; ++x)
                    {
                        const float alpha = static_cast<float>(s[x].alpha) * (1.0f / 32768.0f);
                        float r, g, b;
                        if (premultiplied)
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
                        }
                        d[x].alpha = s[x].alpha;
                        d[x].red = static_cast<A_u_short>(clampf(r * 32768.0f + 0.5f, 0.0f, 32768.0f));
                        d[x].green = static_cast<A_u_short>(clampf(g * 32768.0f + 0.5f, 0.0f, 32768.0f));
                        d[x].blue = static_cast<A_u_short>(clampf(b * 32768.0f + 0.5f, 0.0f, 32768.0f));
                    }
                }
                break;
            }
            case PF_PixelFormat_ARGB128:
            {
                for (long y = 0; y < height; ++y)
                {
                    const PF_PixelFloat* s = reinterpret_cast<const PF_PixelFloat*>(
                        reinterpret_cast<const char*>(src->data) + static_cast<size_t>(y) * src->rowbytes);
                    PF_PixelFloat* d = reinterpret_cast<PF_PixelFloat*>(reinterpret_cast<char*>(dst->data) +
                                                                        static_cast<size_t>(y) * dst->rowbytes);
                    long x = 0;
#if defined(FGB_GRADE_SSE2)
                    for (; x + 4 <= width; x += 4)
                    {
                        __m128 r = _mm_set_ps(s[x + 3].red, s[x + 2].red, s[x + 1].red, s[x + 0].red);
                        __m128 g = _mm_set_ps(s[x + 3].green, s[x + 2].green, s[x + 1].green, s[x + 0].green);
                        __m128 b = _mm_set_ps(s[x + 3].blue, s[x + 2].blue, s[x + 1].blue, s[x + 0].blue);
                        const __m128 alpha =
                            _mm_set_ps(s[x + 3].alpha, s[x + 2].alpha, s[x + 1].alpha, s[x + 0].alpha);

                        if (premultiplied)
                        {
                            fgb_grade::simd::gradePremul4(p, r, g, b, alpha);
                        }
                        else
                        {
                            fgb_grade::simd::gradeStraight4(p, r, g, b);
                            const __m128 visible = _mm_cmpgt_ps(alpha, fgb_grade::simd::zero());
                            r = _mm_and_ps(r, visible);
                            g = _mm_and_ps(g, visible);
                            b = _mm_and_ps(b, visible);
                        }

                        float fr[4], fg[4], fb[4];
                        _mm_storeu_ps(fr, r);
                        _mm_storeu_ps(fg, g);
                        _mm_storeu_ps(fb, b);
                        for (int j = 0; j < 4; ++j)
                        {
                            d[x + j].alpha = s[x + j].alpha;
                            d[x + j].red = fr[j];
                            d[x + j].green = fg[j];
                            d[x + j].blue = fb[j];
                        }
                    }
#endif
                    for (; x < width; ++x)
                    {
                        float r, g, b;
                        if (premultiplied)
                        {
                            gradePixelPremul(s[x].red, s[x].green, s[x].blue, s[x].alpha, p, r, g, b);
                        }
                        else
                        {
                            gradePixelStraight(s[x].red, s[x].green, s[x].blue, s[x].alpha, p, r, g, b);
                        }
                        d[x].alpha = s[x].alpha;
                        d[x].red = r;
                        d[x].green = g;
                        d[x].blue = b;
                    }
                }
                break;
            }
            default:
                break;
        }

        return err;
    }
} // namespace

/* ------------------------------------------------------------------ */
/*  Effect callbacks                                                  */
/* ------------------------------------------------------------------ */

static PF_Err About(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output)
{
    AEGP_SuiteHandler suites(in_data->pica_basicP);
    suites.ANSICallbacksSuite1()->sprintf(out_data->return_msg,
                                          "%s v%d.%d\r%s",
                                          STR(StrID_Name),
                                          MAJOR_VERSION,
                                          MINOR_VERSION,
                                          STR(StrID_Description));
    return PF_Err_NONE;
}

static PF_Err GlobalSetup(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output)
{
    out_data->my_version = PF_VERSION(MAJOR_VERSION, MINOR_VERSION, BUG_VERSION, STAGE_VERSION, BUILD_VERSION);
    out_data->out_flags |= PF_OutFlag_DEEP_COLOR_AWARE;
    out_data->out_flags2 |= PF_OutFlag2_SUPPORTS_THREADED_RENDERING;
    out_data->out_flags2 |= PF_OutFlag2_STRINGS_ARE_UTF8;
    return PF_Err_NONE;
}

static PF_Err ParamsSetup(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output)
{
    PF_Err err = PF_Err_NONE;
    PF_ParamDef def;

    // The seven Figma image-fill controls, in Figma's own panel order.
    struct SliderDef
    {
        int name;
        A_long disk_id;
    };
    const SliderDef sliders[] = {
        {StrID_Exposure_Param_Name, GRADE_EXPOSURE_DISK_ID},
        {StrID_Contrast_Param_Name, GRADE_CONTRAST_DISK_ID},
        {StrID_Saturation_Param_Name, GRADE_SATURATION_DISK_ID},
        {StrID_Temperature_Param_Name, GRADE_TEMPERATURE_DISK_ID},
        {StrID_Tint_Param_Name, GRADE_TINT_DISK_ID},
        {StrID_Highlights_Param_Name, GRADE_HIGHLIGHTS_DISK_ID},
        {StrID_Shadows_Param_Name, GRADE_SHADOWS_DISK_ID},
    };

    for (size_t i = 0; i < sizeof(sliders) / sizeof(sliders[0]); ++i)
    {
        AEFX_CLR_STRUCT(def);
        PF_ADD_FLOAT_SLIDERX(STR(sliders[i].name),
                             GRADE_VALUE_MIN,
                             GRADE_VALUE_MAX,
                             GRADE_VALUE_MIN,
                             GRADE_VALUE_MAX,
                             GRADE_VALUE_DFLT,
                             PF_Precision_TENTHS,
                             0,
                             0,
                             sliders[i].disk_id);
    }

    out_data->num_params = GRADE_NUM_PARAMS;
    return err;
}

static PF_Err Render(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output)
{
    return renderGrade(in_data, out_data, params, output);
}

extern "C" DllExport PF_Err PluginDataEntryFunction2(PF_PluginDataPtr inPtr,
                                                     PF_PluginDataCB2 inPluginDataCallBackPtr,
                                                     SPBasicSuite* inSPBasicSuitePtr,
                                                     const char* inHostName,
                                                     const char* inHostVersion)
{
    PF_Err result = PF_Err_INVALID_CALLBACK;

    result = PF_REGISTER_EFFECT_EXT2(inPtr,
                                     inPluginDataCallBackPtr,
                                     /* "Figma 调色" (UTF-8) */
                                     "Figma \xe8\xb0\x83\xe8\x89\xb2",
                                     "F2A Figma Image Grade",
                                     /* "F2A 插件" (UTF-8) */
                                     "F2A \xe6\x8f\x92\xe4\xbb\xb6",
                                     AE_RESERVED_INFO,
                                     "EffectMain",
                                     "https://www.figma.com");

    return result;
}

PF_Err EffectMain(
    PF_Cmd cmd, PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output, void* extra)
{
    PF_Err err = PF_Err_NONE;

    try
    {
        switch (cmd)
        {
            case PF_Cmd_ABOUT:
                err = About(in_data, out_data, params, output);
                break;
            case PF_Cmd_GLOBAL_SETUP:
                err = GlobalSetup(in_data, out_data, params, output);
                break;
            case PF_Cmd_PARAMS_SETUP:
                err = ParamsSetup(in_data, out_data, params, output);
                break;
            case PF_Cmd_RENDER:
                err = Render(in_data, out_data, params, output);
                break;
            default:
                break;
        }
    }
    catch (PF_Err& thrown_err)
    {
        err = thrown_err;
    }
    return err;
}
