/*******************************************************************/
/*  FigmaImageGradeKernel.h                                        */
/*                                                                 */
/*  The pixel maths, shared by the After Effects plug-in and by the */
/*  offline validation / benchmark tool (tests/grade_cli.cpp).      */
/*                                                                 */
/*  Input:  linear-light RGB (Figma's shader input is sRGB ^ 2.2).  */
/*  Output: straight, gamma-encoded RGB in [0, 1].                  */
/*                                                                 */
/*  Reverse-engineered from Figma 126.8.16; validated against its   */
/*  PNG export in tests/image-filter-study.md.                      */
/*                                                                 */
/*  v1.1 performance work:                                          */
/*   - 8-bit decode is a 256-entry table (same closed form, so the   */
/*     values are identical to the scalar path);                     */
/*   - the whole grade runs 4 pixels at a time on SSE2, with vector  */
/*     log2/exp2/cbrt/reciprocal that use exactly the same formulas  */
/*     and operation order as the scalar code, so the output is      */
/*     bit-identical;                                                */
/*   - scalar fallbacks stay available for 16/32 bpc and for hosts   */
/*     where the vector path is not compiled in.                     */
/*******************************************************************/

#pragma once

#ifndef FIGMA_IMAGE_GRADE_KERNEL_H
#define FIGMA_IMAGE_GRADE_KERNEL_H

#include <algorithm>
#include <array>
#include <cmath>

#if defined(_MSC_VER) && defined(_M_X64)
#define FGB_GRADE_SSE2 1
#include <emmintrin.h>
#include <xmmintrin.h>
#endif

namespace fgb_grade
{

    inline float clampf(float v, float lo, float hi)
    {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    // Rec.709 luminance - the weights Figma's shader uses everywhere.
    inline float luma(float r, float g, float b)
    {
        return 0.2126f * r + 0.7152f * g + 0.0722f * b;
    }

    const float kGamma = 2.2f;
    const float kInvGamma = 1.0f / 2.2f;
    // 0.5^2.2: the luminance where Figma switches from shadows to highlights.
    const float kThreshold = 0.217637640824031f;

    /* ------------------------------------------------------------------ */
    /*  Fast transcendentals (scalar)                                     */
    /*                                                                    */
    /*  The shader needs RGB^2.2, RGB^(1/2.2), three cube roots and       */
    /*  10^(2*ev) per pixel - these are ~1e-7 accurate, far better than   */
    /*  8-bit output needs, and much faster than the CRT's pow/cbrt.      */
    /* ------------------------------------------------------------------ */

    inline float fastLog2(float x)
    {
        union
        {
            float f;
            unsigned u;
        } v;
        v.f = x;
        const float e = static_cast<float>(static_cast<int>((v.u >> 23) & 0xFFu) - 127);
        v.u = (v.u & 0x007FFFFFu) | 0x3F800000u;
        const float m = v.f; // [1, 2)
        const float t = (m - 1.0f) / (m + 1.0f);
        const float t2 = t * t;
        const float p = t * (2.0f + t2 * (0.6666667f + t2 * (0.4f + t2 * 0.2857143f)));
        return e + p * 1.4426950f;
    }

    inline float fastExp2(float x)
    {
        const float n = std::floor(x);
        const float f = x - n;
        const float p =
            1.0f + f * (0.6931472f +
                        f * (0.2402265f +
                             f * (0.0555041f + f * (0.0096181f + f * (0.0013334f + f * 0.0001540f)))));
        union
        {
            float f;
            unsigned u;
        } s;
        s.u = static_cast<unsigned>(static_cast<int>(n) + 127) << 23;
        return p * s.f;
    }

    inline float fastPow(float x, float p)
    {
        if (!(x > 0.0f))
        {
            return 0.0f;
        }
        return fastExp2(fastLog2(x) * p);
    }

    inline float fastCbrt(float x)
    {
        if (!(x > 0.0f))
        {
            return 0.0f;
        }
        return fastExp2(fastLog2(x) * (1.0f / 3.0f));
    }

    // 10^x (the exposure curve needs 10^(2*ev))
    inline float fastExp10(float x)
    {
        return fastExp2(x * 3.321928095f);
    }

    // sRGB byte -> linear light; filled with the same closed form the generic
    // path uses, so 8-bit results are identical to it.
    inline const std::array<float, 256>& decodeTable8()
    {
        static const std::array<float, 256> table = [] {
            std::array<float, 256> t{};
            for (int i = 0; i < 256; ++i)
            {
                t[i] = fastPow(static_cast<float>(i) * (1.0f / 255.0f), kGamma);
            }
            return t;
        }();
        return table;
    }

    struct GradeParams
    {
        float exposure;
        float contrast;
        float saturation;
        float temperature;
        float tint;
        float highlights;
        float shadows;

        bool identity() const
        {
            return exposure == 0.0f && contrast == 0.0f && saturation == 0.0f && temperature == 0.0f &&
                   tint == 0.0f && highlights == 0.0f && shadows == 0.0f;
        }
        // Figma's shader skips the Lab round trip when these three are zero.
        bool needsLab() const { return contrast != 0.0f || temperature != 0.0f || tint != 0.0f; }
        bool needsExposure() const { return exposure != 0.0f || highlights != 0.0f || shadows != 0.0f; }
    };

    // linear-light RGB in [0, 1] -> straight, gamma-encoded RGB in [0, 1]
    inline void gradeLinearToEncoded(const GradeParams& p, float& r, float& g, float& b)
    {
        float y = luma(r, g, b);

        // 1. per-pixel exposure compensation from the ORIGINAL luminance
        const float d = y - kThreshold;
        const float amount = (d > 0.0f) ? p.highlights : (-0.999f * p.shadows);
        const float ev = p.exposure + 0.75f * d / std::sqrt(1.0f + 4.0f * d * d) * amount;

        // 2. Lab-space white balance (b*), tint (a*) and contrast (L*)
        if (p.needsLab())
        {
            const float fx = fastCbrt((0.4124564f * r + 0.3575761f * g + 0.1804375f * b) * (1.0f / 0.95047f));
            const float fy = fastCbrt(0.2126729f * r + 0.7151522f * g + 0.0721750f * b);
            const float fz = fastCbrt((0.0193339f * r + 0.1191920f * g + 0.9503041f * b) * (1.0f / 1.08883f));

            const float light = 116.0f * fy - 16.0f;
            float shift;
            if (p.contrast < 0.0f)
            {
                const float target = (light - 50.0f) * 0.2f + 50.0f;
                shift = 0.3f * (-p.contrast) * (target - light) / 116.0f;
            }
            else
            {
                const float t = clampf((light - 20.0f) / 60.0f, 0.0f, 1.0f);
                const float target = 100.0f * t * t * t * (6.0f * t * t - 15.0f * t + 10.0f);
                shift = 0.3f * p.contrast * (target - light) / 116.0f;
            }

            const float ax = fx + shift + 0.06f * p.tint;
            const float ay = fy + shift;
            const float az = fz + shift - 0.15f * p.temperature;
            const float X = 0.95047f * ax * ax * ax;
            const float Y = ay * ay * ay;
            const float Z = 1.08883f * az * az * az;

            r = clampf(3.2404542f * X - 1.5371385f * Y - 0.4985314f * Z, 0.0f, 1.0f);
            g = clampf(-0.9692660f * X + 1.8760108f * Y + 0.0415560f * Z, 0.0f, 1.0f);
            b = clampf(0.0556434f * X - 0.2040259f * Y + 1.0572252f * Z, 0.0f, 1.0f);
            y = luma(r, g, b);
        }

        // 3. exposure curve; it also mixes the colour 75% toward its luminance
        if (p.needsExposure() && ev != 0.0f)
        {
            const float negative = (ev < 0.0f) ? ev : 0.0f;
            const float scale = 1.0f + negative * 0.0625f; // 1 + negative/16
            const float gain = fastExp10(2.0f * ev);
            const float chroma = 3.0f * (1.0f + y * y * negative / (0.2f - negative));
            const float k = gain - 1.0f;

            const float sy = scale * y;
            const float base = sy * gain / (1.0f + sy * k);
            const float sr = scale * (0.25f * r + 0.75f * y);
            const float sg = scale * (0.25f * g + 0.75f * y);
            const float sb = scale * (0.25f * b + 0.75f * y);
            const float kr = sr * gain / (1.0f + sr * k);
            const float kg = sg * gain / (1.0f + sg * k);
            const float kb = sb * gain / (1.0f + sb * k);

            r = clampf(kr + (kr - base) * chroma, 0.0f, 1.0f);
            g = clampf(kg + (kg - base) * chroma, 0.0f, 1.0f);
            b = clampf(kb + (kb - base) * chroma, 0.0f, 1.0f);
            y = luma(r, g, b);
        }

        // 4. saturation: negative mixes toward grey, positive boosts chroma
        //    but is limited by the RGB cube boundary (and capped at 2x)
        float sat = 1.0f + p.saturation;
        if (p.saturation > 0.0f)
        {
            const float mn = std::min(r, std::min(g, b));
            const float mx = std::max(r, std::max(g, b));
            const float low = y / (y - mn + 1.0e-6f);
            const float high = (1.0f - y) / (mx - y + 1.0e-6f);
            const float limit = (low < high) ? low : high;
            sat = 1.0f + p.saturation * (limit - 1.0f);
            if (sat > 2.0f)
            {
                sat = 2.0f;
            }
        }

        // 5. encode
        r = fastPow(clampf(y + (r - y) * sat, 0.0f, 1.0f), kInvGamma);
        g = fastPow(clampf(y + (g - y) * sat, 0.0f, 1.0f), kInvGamma);
        b = fastPow(clampf(y + (b - y) * sat, 0.0f, 1.0f), kInvGamma);
    }

    // premultiplied, gamma-encoded pixel -> graded premultiplied, encoded pixel
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

        const float invA = (alpha >= 1.0f) ? 1.0f : (1.0f / alpha);
        float r = fastPow(pr * invA, kGamma);
        float g = fastPow(pg * invA, kGamma);
        float b = fastPow(pb * invA, kGamma);

        gradeLinearToEncoded(p, r, g, b);

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

    /* ------------------------------------------------------------------ */
    /*  8-bit entry points (decode via the table)                         */
    /* ------------------------------------------------------------------ */

    inline void gradeStraight8(unsigned char r8, unsigned char g8, unsigned char b8, float alpha,
                               const GradeParams& p, float& outR, float& outG, float& outB)
    {
        if (!(alpha > 0.0f))
        {
            outR = 0.0f;
            outG = 0.0f;
            outB = 0.0f;
            return;
        }
        const std::array<float, 256>& t = decodeTable8();
        float r = t[r8];
        float g = t[g8];
        float b = t[b8];
        gradeLinearToEncoded(p, r, g, b);
        outR = r;
        outG = g;
        outB = b;
    }

    inline void gradePremul8(unsigned char r8, unsigned char g8, unsigned char b8, float alpha,
                             const GradeParams& p, float& outR, float& outG, float& outB)
    {
        if (!(alpha > 0.0f))
        {
            outR = 0.0f;
            outG = 0.0f;
            outB = 0.0f;
            return;
        }
        const std::array<float, 256>& t = decodeTable8();
        float r, g, b;
        if (alpha >= 1.0f)
        {
            r = t[r8];
            g = t[g8];
            b = t[b8];
        }
        else
        {
            const float invA = 1.0f / alpha;
            r = fastPow(static_cast<float>(r8) * (1.0f / 255.0f) * invA, kGamma);
            g = fastPow(static_cast<float>(g8) * (1.0f / 255.0f) * invA, kGamma);
            b = fastPow(static_cast<float>(b8) * (1.0f / 255.0f) * invA, kGamma);
        }
        gradeLinearToEncoded(p, r, g, b);
        outR = r * alpha;
        outG = g * alpha;
        outB = b * alpha;
    }

    /* ------------------------------------------------------------------ */
    /*  SSE2 path: four pixels at a time, same formulas and operation     */
    /*  order as the scalar code, so the results are bit-identical.       */
    /* ------------------------------------------------------------------ */

#if defined(FGB_GRADE_SSE2)

    namespace simd
    {
        inline __m128 one() { return _mm_set1_ps(1.0f); }
        inline __m128 zero() { return _mm_setzero_ps(); }

        inline __m128 select(__m128 mask, __m128 a, __m128 b)
        {
            return _mm_or_ps(_mm_and_ps(mask, a), _mm_andnot_ps(mask, b));
        }

        // same as fastLog2
        inline __m128 log2_ps(__m128 x)
        {
            const __m128i bits = _mm_castps_si128(x);
            const __m128 e = _mm_cvtepi32_ps(_mm_sub_epi32(_mm_srli_epi32(bits, 23), _mm_set1_epi32(127)));
            const __m128 m = _mm_castsi128_ps(
                _mm_or_si128(_mm_and_si128(bits, _mm_set1_epi32(0x007FFFFF)), _mm_set1_epi32(0x3F800000)));
            const __m128 t = _mm_div_ps(_mm_sub_ps(m, one()), _mm_add_ps(m, one()));
            const __m128 t2 = _mm_mul_ps(t, t);
            __m128 q = _mm_add_ps(_mm_set1_ps(0.4f), _mm_mul_ps(t2, _mm_set1_ps(0.2857143f)));
            q = _mm_add_ps(_mm_set1_ps(0.6666667f), _mm_mul_ps(t2, q));
            q = _mm_add_ps(_mm_set1_ps(2.0f), _mm_mul_ps(t2, q));
            return _mm_add_ps(e, _mm_mul_ps(_mm_mul_ps(t, q), _mm_set1_ps(1.4426950f)));
        }

        // same as fastExp2
        inline __m128 exp2_ps(__m128 x)
        {
            __m128i n = _mm_cvttps_epi32(x);
            __m128 nf = _mm_cvtepi32_ps(n);
            const __m128 negFrac = _mm_cmplt_ps(_mm_sub_ps(x, nf), zero());
            n = _mm_sub_epi32(n, _mm_and_si128(_mm_castps_si128(negFrac), _mm_set1_epi32(1)));
            nf = _mm_sub_ps(nf, _mm_and_ps(negFrac, one()));
            const __m128 f = _mm_sub_ps(x, nf);
            __m128 p = _mm_add_ps(_mm_set1_ps(0.0013334f), _mm_mul_ps(f, _mm_set1_ps(0.0001540f)));
            p = _mm_add_ps(_mm_set1_ps(0.0096181f), _mm_mul_ps(f, p));
            p = _mm_add_ps(_mm_set1_ps(0.0555041f), _mm_mul_ps(f, p));
            p = _mm_add_ps(_mm_set1_ps(0.2402265f), _mm_mul_ps(f, p));
            p = _mm_add_ps(_mm_set1_ps(0.6931472f), _mm_mul_ps(f, p));
            p = _mm_add_ps(one(), _mm_mul_ps(f, p));
            const __m128i bits = _mm_slli_epi32(_mm_add_epi32(n, _mm_set1_epi32(127)), 23);
            return _mm_mul_ps(p, _mm_castsi128_ps(bits));
        }

        inline __m128 pow_ps(__m128 x, float exponent)
        {
            const __m128 safe = _mm_max_ps(x, _mm_set1_ps(1.0e-30f));
            const __m128 r = exp2_ps(_mm_mul_ps(log2_ps(safe), _mm_set1_ps(exponent)));
            return _mm_and_ps(r, _mm_cmpgt_ps(x, zero()));
        }

        inline __m128 cbrt_ps(__m128 x)
        {
            // same as fastCbrt
            const __m128 safe = _mm_max_ps(x, _mm_set1_ps(1.0e-30f));
            const __m128 r = exp2_ps(_mm_mul_ps(log2_ps(safe), _mm_set1_ps(1.0f / 3.0f)));
            return _mm_and_ps(r, _mm_cmpgt_ps(x, zero()));
        }

        inline __m128 exp10_ps(__m128 x)
        {
            return exp2_ps(_mm_mul_ps(x, _mm_set1_ps(3.321928095f)));
        }

        inline __m128 clamp_ps(__m128 v, __m128 lo, __m128 hi)
        {
            return _mm_min_ps(_mm_max_ps(v, lo), hi);
        }

        inline __m128 luma_ps(__m128 r, __m128 g, __m128 b)
        {
            return _mm_add_ps(_mm_add_ps(_mm_mul_ps(r, _mm_set1_ps(0.2126f)), _mm_mul_ps(g, _mm_set1_ps(0.7152f))),
                              _mm_mul_ps(b, _mm_set1_ps(0.0722f)));
        }

        // linear-light RGB (4 pixels) -> straight, gamma-encoded RGB
        __forceinline void gradeLinearToEncoded_ps(const GradeParams& p, __m128& r, __m128& g, __m128& b)
        {
            __m128 y = luma_ps(r, g, b);

            // 1. exposure compensation from the original luminance
            const __m128 d = _mm_sub_ps(y, _mm_set1_ps(kThreshold));
            const __m128 hiMask = _mm_cmpgt_ps(d, zero());
            const __m128 amount = select(hiMask, _mm_set1_ps(p.highlights), _mm_set1_ps(-0.999f * p.shadows));
            __m128 ev = _mm_add_ps(_mm_set1_ps(p.exposure),
                                   _mm_mul_ps(_mm_div_ps(_mm_mul_ps(_mm_set1_ps(0.75f), d),
                                                         _mm_sqrt_ps(_mm_add_ps(
                                                             one(), _mm_mul_ps(_mm_mul_ps(_mm_set1_ps(4.0f), d), d)))),
                                              amount));

            // 2. Lab-space white balance / tint / contrast
            if (p.needsLab())
            {
                const __m128 fx = cbrt_ps(_mm_mul_ps(
                    _mm_add_ps(_mm_add_ps(_mm_mul_ps(r, _mm_set1_ps(0.4124564f)),
                                          _mm_mul_ps(g, _mm_set1_ps(0.3575761f))),
                               _mm_mul_ps(b, _mm_set1_ps(0.1804375f))),
                    _mm_set1_ps(1.0f / 0.95047f)));
                const __m128 fy = cbrt_ps(_mm_add_ps(_mm_add_ps(_mm_mul_ps(r, _mm_set1_ps(0.2126729f)),
                                                                 _mm_mul_ps(g, _mm_set1_ps(0.7151522f))),
                                                    _mm_mul_ps(b, _mm_set1_ps(0.0721750f))));
                const __m128 fz = cbrt_ps(_mm_mul_ps(
                    _mm_add_ps(_mm_add_ps(_mm_mul_ps(r, _mm_set1_ps(0.0193339f)),
                                          _mm_mul_ps(g, _mm_set1_ps(0.1191920f))),
                               _mm_mul_ps(b, _mm_set1_ps(0.9503041f))),
                    _mm_set1_ps(1.0f / 1.08883f)));

                const __m128 light = _mm_sub_ps(_mm_mul_ps(_mm_set1_ps(116.0f), fy), _mm_set1_ps(16.0f));
                __m128 shift;
                if (p.contrast < 0.0f)
                {
                    const __m128 target = _mm_add_ps(_mm_mul_ps(_mm_sub_ps(light, _mm_set1_ps(50.0f)),
                                                                _mm_set1_ps(0.2f)),
                                                     _mm_set1_ps(50.0f));
                    shift = _mm_div_ps(_mm_mul_ps(_mm_set1_ps(0.3f * (-p.contrast)),
                                                  _mm_sub_ps(target, light)),
                                       _mm_set1_ps(116.0f));
                }
                else
                {
                    const __m128 t = clamp_ps(
                        _mm_div_ps(_mm_sub_ps(light, _mm_set1_ps(20.0f)), _mm_set1_ps(60.0f)), zero(), one());
                    const __m128 t3 = _mm_mul_ps(_mm_mul_ps(_mm_mul_ps(_mm_set1_ps(100.0f), t), t), t);
                    const __m128 shape = _mm_add_ps(
                        _mm_sub_ps(_mm_mul_ps(_mm_mul_ps(_mm_set1_ps(6.0f), t), t),
                                   _mm_mul_ps(_mm_set1_ps(15.0f), t)),
                        _mm_set1_ps(10.0f));
                    const __m128 target = _mm_mul_ps(t3, shape);
                    shift = _mm_div_ps(_mm_mul_ps(_mm_set1_ps(0.3f * p.contrast),
                                                  _mm_sub_ps(target, light)),
                                       _mm_set1_ps(116.0f));
                }

                const __m128 ax = _mm_add_ps(_mm_add_ps(fx, shift), _mm_set1_ps(0.06f * p.tint));
                const __m128 ay = _mm_add_ps(fy, shift);
                const __m128 az = _mm_sub_ps(_mm_add_ps(fz, shift), _mm_set1_ps(0.15f * p.temperature));

                const __m128 X = _mm_mul_ps(_mm_mul_ps(_mm_mul_ps(_mm_set1_ps(0.95047f), ax), ax), ax);
                const __m128 Y = _mm_mul_ps(_mm_mul_ps(ay, ay), ay);
                const __m128 Z = _mm_mul_ps(_mm_mul_ps(_mm_mul_ps(_mm_set1_ps(1.08883f), az), az), az);

                // rows of XYZ_TO_RGB; the negative coefficients are folded into the
                // multiplies so every row is a chain of adds (same value as the
                // scalar form, which subtracts the positive coefficients)
                __m128 row = _mm_mul_ps(X, _mm_set1_ps(3.2404542f));
                row = _mm_add_ps(row, _mm_mul_ps(Y, _mm_set1_ps(-1.5371385f)));
                row = _mm_add_ps(row, _mm_mul_ps(Z, _mm_set1_ps(-0.4985314f)));
                const __m128 rr = clamp_ps(row, zero(), one());

                row = _mm_mul_ps(X, _mm_set1_ps(-0.9692660f));
                row = _mm_add_ps(row, _mm_mul_ps(Y, _mm_set1_ps(1.8760108f)));
                row = _mm_add_ps(row, _mm_mul_ps(Z, _mm_set1_ps(0.0415560f)));
                const __m128 gg = clamp_ps(row, zero(), one());

                row = _mm_mul_ps(X, _mm_set1_ps(0.0556434f));
                row = _mm_add_ps(row, _mm_mul_ps(Y, _mm_set1_ps(-0.2040259f)));
                row = _mm_add_ps(row, _mm_mul_ps(Z, _mm_set1_ps(1.0572252f)));
                const __m128 bb = clamp_ps(row, zero(), one());

                r = rr;
                g = gg;
                b = bb;
                y = luma_ps(r, g, b);
            }

            // 3. exposure curve (per-pixel: skipped where ev == 0, like the scalar path)
            if (p.needsExposure())
            {
                const __m128 negative = _mm_min_ps(ev, zero());
                const __m128 scale = _mm_add_ps(one(), _mm_mul_ps(negative, _mm_set1_ps(0.0625f)));
                const __m128 gain = exp10_ps(_mm_mul_ps(_mm_set1_ps(2.0f), ev));
                const __m128 chroma = _mm_mul_ps(
                    _mm_set1_ps(3.0f),
                    _mm_add_ps(one(),
                               _mm_div_ps(_mm_mul_ps(_mm_mul_ps(y, y), negative),
                                          _mm_sub_ps(_mm_set1_ps(0.2f), negative))));
                const __m128 k = _mm_sub_ps(gain, one());

                const __m128 sy = _mm_mul_ps(scale, y);
                const __m128 base = _mm_div_ps(_mm_mul_ps(sy, gain), _mm_add_ps(one(), _mm_mul_ps(sy, k)));
                const __m128 sr = _mm_mul_ps(scale,
                                             _mm_add_ps(_mm_mul_ps(_mm_set1_ps(0.25f), r),
                                                        _mm_mul_ps(_mm_set1_ps(0.75f), y)));
                const __m128 sg = _mm_mul_ps(scale,
                                             _mm_add_ps(_mm_mul_ps(_mm_set1_ps(0.25f), g),
                                                        _mm_mul_ps(_mm_set1_ps(0.75f), y)));
                const __m128 sb = _mm_mul_ps(scale,
                                             _mm_add_ps(_mm_mul_ps(_mm_set1_ps(0.25f), b),
                                                        _mm_mul_ps(_mm_set1_ps(0.75f), y)));
                const __m128 kr = _mm_div_ps(_mm_mul_ps(sr, gain), _mm_add_ps(one(), _mm_mul_ps(sr, k)));
                const __m128 kg = _mm_div_ps(_mm_mul_ps(sg, gain), _mm_add_ps(one(), _mm_mul_ps(sg, k)));
                const __m128 kb = _mm_div_ps(_mm_mul_ps(sb, gain), _mm_add_ps(one(), _mm_mul_ps(sb, k)));

                const __m128 nr = clamp_ps(_mm_add_ps(kr, _mm_mul_ps(_mm_sub_ps(kr, base), chroma)), zero(), one());
                const __m128 ng = clamp_ps(_mm_add_ps(kg, _mm_mul_ps(_mm_sub_ps(kg, base), chroma)), zero(), one());
                const __m128 nb = clamp_ps(_mm_add_ps(kb, _mm_mul_ps(_mm_sub_ps(kb, base), chroma)), zero(), one());

                const __m128 use = _mm_cmpneq_ps(ev, zero());
                r = select(use, nr, r);
                g = select(use, ng, g);
                b = select(use, nb, b);
                const __m128 newY = luma_ps(r, g, b);
                y = select(use, newY, y);
            }

            // 4. saturation
            __m128 sat = _mm_add_ps(one(), _mm_set1_ps(p.saturation));
            if (p.saturation > 0.0f)
            {
                const __m128 mn = _mm_min_ps(r, _mm_min_ps(g, b));
                const __m128 mx = _mm_max_ps(r, _mm_max_ps(g, b));
                const __m128 low = _mm_div_ps(y, _mm_add_ps(_mm_sub_ps(y, mn), _mm_set1_ps(1.0e-6f)));
                const __m128 high = _mm_div_ps(_mm_sub_ps(one(), y),
                                               _mm_add_ps(_mm_sub_ps(mx, y), _mm_set1_ps(1.0e-6f)));
                const __m128 limit = _mm_min_ps(low, high);
                sat = _mm_add_ps(one(), _mm_mul_ps(_mm_set1_ps(p.saturation), _mm_sub_ps(limit, one())));
                sat = _mm_min_ps(sat, _mm_set1_ps(2.0f));
            }

            // 5. encode
            r = pow_ps(clamp_ps(_mm_add_ps(y, _mm_mul_ps(_mm_sub_ps(r, y), sat)), zero(), one()), kInvGamma);
            g = pow_ps(clamp_ps(_mm_add_ps(y, _mm_mul_ps(_mm_sub_ps(g, y), sat)), zero(), one()), kInvGamma);
            b = pow_ps(clamp_ps(_mm_add_ps(y, _mm_mul_ps(_mm_sub_ps(b, y), sat)), zero(), one()), kInvGamma);
        }

        // Straight (un-premultiplied) encoded RGB in, graded encoded RGB out.
        // Avoids the caller touching the scalar path, so 16/32 bpc stay vectorised.
        inline void gradeStraight4(const GradeParams& p, __m128& r, __m128& g, __m128& b)
        {
            r = pow_ps(r, kGamma);
            g = pow_ps(g, kGamma);
            b = pow_ps(b, kGamma);
            gradeLinearToEncoded_ps(p, r, g, b);
        }

        // Premultiplied encoded RGB in, graded premultiplied encoded RGB out.
        inline void gradePremul4(const GradeParams& p, __m128& r, __m128& g, __m128& b, __m128 alpha)
        {
            const __m128 opaque = _mm_cmpge_ps(alpha, one());
            const __m128 invA = select(opaque, one(), _mm_div_ps(one(), alpha));
            r = pow_ps(_mm_mul_ps(r, invA), kGamma);
            g = pow_ps(_mm_mul_ps(g, invA), kGamma);
            b = pow_ps(_mm_mul_ps(b, invA), kGamma);
            gradeLinearToEncoded_ps(p, r, g, b);
            const __m128 visible = _mm_cmpgt_ps(alpha, zero());
            r = _mm_and_ps(_mm_mul_ps(r, alpha), visible);
            g = _mm_and_ps(_mm_mul_ps(g, alpha), visible);
            b = _mm_and_ps(_mm_mul_ps(b, alpha), visible);
        }
    } // namespace simd

#endif // FGB_GRADE_SSE2

} // namespace fgb_grade

#endif // FIGMA_IMAGE_GRADE_KERNEL_H
