// Offline validation + benchmark tool for the Figma image-grade pixel maths.
//
// Modes
//   pipe  (default): stdin lines "<r> <g> <b> [a]" - PREMULTIPLIED 8-bit values as
//         After Effects hands them to the effect (a defaults to 255); prints the
//         final graded values (0..1 scale * 255).
//   --straight   : same, but the input is straight (un-premultiplied)
//   --bench MPIX : grade MPIX megapixels with the scalar path, report MPix/s
//   --bench8 MPIX: same with the plug-in's actual 8-bit path (decode table +
//                  4-pixel SSE2 block + byte store)
//   --check-simd N: compare the SSE2 block against the scalar 8-bit path bit for bit
//
// args: exposure contrast saturation temperature tint highlights shadows
//       (Figma UI units, -100..100)
//
// Build:  cl /O2 /EHsc /IFigmaImageGrade grade_cli.cpp /Fe:grade_cli.exe

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

#include "FigmaImageGradeKernel.h"

static fgb_grade::GradeParams paramsFromArgs(char** argv)
{
    fgb_grade::GradeParams p;
    p.exposure = static_cast<float>(std::atof(argv[1])) * 0.01f;
    p.contrast = static_cast<float>(std::atof(argv[2])) * 0.01f;
    p.saturation = static_cast<float>(std::atof(argv[3])) * 0.01f;
    p.temperature = static_cast<float>(std::atof(argv[4])) * 0.01f;
    p.tint = static_cast<float>(std::atof(argv[5])) * 0.01f;
    p.highlights = static_cast<float>(std::atof(argv[6])) * 0.01f;
    p.shadows = static_cast<float>(std::atof(argv[7])) * 0.01f;
    return p;
}

static int benchScalar(const fgb_grade::GradeParams& p, double megapixels)
{
    const int count = static_cast<int>(megapixels * 1000000.0);
    float sink = 0.0f;
    const clock_t t0 = std::clock();
    for (int i = 0; i < count; ++i)
    {
        const float t = static_cast<float>(i % 997) * (1.0f / 997.0f);
        float r, g, b;
        fgb_grade::gradeStraight8(static_cast<unsigned char>(255.0f * (0.05f + 0.9f * t)),
                                  static_cast<unsigned char>(255.0f * (0.9f - 0.8f * t)),
                                  static_cast<unsigned char>(255.0f * (0.3f + 0.4f * t)),
                                  1.0f,
                                  p,
                                  r,
                                  g,
                                  b);
        sink += r + g + b;
    }
    const clock_t t1 = std::clock();
    const double s = static_cast<double>(t1 - t0) / CLOCKS_PER_SEC;
    const double mpix = count / 1000000.0;
    std::printf("%.3f MPix in %.3f s = %.2f MPix/s  (1200x800 => %.1f ms/frame)  [sink %.2f]\n", mpix, s, mpix / s,
                0.96 / (mpix / s) * 1000.0, sink);
    return 0;
}

static int bench16Scalar(const fgb_grade::GradeParams& p, double megapixels)
{
    const int pixels = static_cast<int>(megapixels * 1000000.0);
    float sink = 0.0f;
    const clock_t t0 = std::clock();
    for (int i = 0; i < pixels; ++i)
    {
        const float t = static_cast<float>(i % 997) * (1.0f / 997.0f);
        float r, g, b;
        fgb_grade::gradePixelStraight(0.05f + 0.9f * t, 0.9f - 0.8f * t, 0.3f + 0.4f * t, 1.0f, p, r, g, b);
        sink += r + g + b;
    }
    const clock_t t1 = std::clock();
    const double s = static_cast<double>(t1 - t0) / CLOCKS_PER_SEC;
    const double mpix = static_cast<double>(pixels) / 1000000.0;
    std::printf("scalar path: %.3f MPix in %.3f s = %.2f MPix/s  (1200x800 => %.1f ms/frame)  [sink %.2f]\n", mpix, s,
                mpix / s, 0.96 / (mpix / s) * 1000.0, static_cast<double>(sink));
    return 0;
}

static int bench16(const fgb_grade::GradeParams& p, double megapixels, int bits)
{
#if defined(FGB_GRADE_SSE2)
    const int pixels = static_cast<int>(megapixels * 1000000.0);
    const int blocks = pixels / 4;
    const float scale = (bits == 16) ? (1.0f / 32768.0f) : 1.0f;
    const float invScale = (bits == 16) ? 32768.0f : 1.0f;
    float src[4][3];
    for (int i = 0; i < 4; ++i)
    {
        for (int c = 0; c < 3; ++c)
        {
            src[i][c] = static_cast<float>(37 + 53 * i + 17 * c) * scale;
        }
    }
    double sink = 0.0;
    const clock_t t0 = std::clock();
    for (int i = 0; i < blocks; ++i)
    {
        __m128 r = _mm_set_ps(src[3][0], src[2][0], src[1][0], src[0][0]);
        __m128 g = _mm_set_ps(src[3][1], src[2][1], src[1][1], src[0][1]);
        __m128 b = _mm_set_ps(src[3][2], src[2][2], src[1][2], src[0][2]);
        const __m128 a = _mm_set1_ps(1.0f);
        fgb_grade::simd::gradePremul4(p, r, g, b, a);
        float fr[4];
        _mm_storeu_ps(fr, r);
        for (int k = 0; k < 4; ++k)
        {
            sink += static_cast<double>(static_cast<int>(fgb_grade::clampf(fr[k] * invScale + 0.5f, 0.0f, invScale)));
        }
    }
    const clock_t t1 = std::clock();
    const double s = static_cast<double>(t1 - t0) / CLOCKS_PER_SEC;
    const double mpix = static_cast<double>(pixels) / 1000000.0;
    std::printf("%d-bit path: %.3f MPix in %.3f s = %.2f MPix/s  (1200x800 => %.1f ms/frame)  [sink %.0f]\n", bits, mpix,
                s, mpix / s, 0.96 / (mpix / s) * 1000.0, sink);
    return 0;
#else
    std::printf("SSE2 path not compiled\n");
    return 2;
#endif
}

static int bench8(const fgb_grade::GradeParams& p, double megapixels)
{
#if defined(FGB_GRADE_SSE2)
    const int pixels = static_cast<int>(megapixels * 1000000.0);
    const int blocks = pixels / 4;
    const float* lut = fgb_grade::decodeTable8().data();
    unsigned char src[4 * 4], dst[4 * 4];
    for (int i = 0; i < 16; ++i)
    {
        src[i] = static_cast<unsigned char>((i * 37 + 11) & 0xFF);
    }
    long long sink = 0;
    const clock_t t0 = std::clock();
    for (int i = 0; i < blocks; ++i)
    {
        const unsigned char* s = src;
        __m128 r = _mm_set_ps(lut[s[12]], lut[s[8]], lut[s[4]], lut[s[0]]);
        __m128 g = _mm_set_ps(lut[s[13]], lut[s[9]], lut[s[5]], lut[s[1]]);
        __m128 b = _mm_set_ps(lut[s[14]], lut[s[10]], lut[s[6]], lut[s[2]]);
        fgb_grade::simd::gradeLinearToEncoded_ps(p, r, g, b);
        float fr[4], fg[4], fb[4];
        _mm_storeu_ps(fr, r);
        _mm_storeu_ps(fg, g);
        _mm_storeu_ps(fb, b);
        for (int k = 0; k < 4; ++k)
        {
            dst[k * 4 + 0] = static_cast<unsigned char>(fgb_grade::clampf(fr[k] * 255.0f + 0.5f, 0.0f, 255.0f));
            dst[k * 4 + 1] = static_cast<unsigned char>(fgb_grade::clampf(fg[k] * 255.0f + 0.5f, 0.0f, 255.0f));
            dst[k * 4 + 2] = static_cast<unsigned char>(fgb_grade::clampf(fb[k] * 255.0f + 0.5f, 0.0f, 255.0f));
            sink += dst[k * 4];
        }
    }
    const clock_t t1 = std::clock();
    const double s = static_cast<double>(t1 - t0) / CLOCKS_PER_SEC;
    const double mpix = static_cast<double>(pixels) / 1000000.0;
    std::printf("8-bit path: %.3f MPix in %.3f s = %.2f MPix/s  (1200x800 => %.1f ms/frame)  [sink %lld]\n", mpix, s,
                mpix / s, 0.96 / (mpix / s) * 1000.0, sink);
    return 0;
#else
    std::printf("SSE2 path not compiled\n");
    return 0;
#endif
}

static int probePixel(const fgb_grade::GradeParams& p, int r8, int g8, int b8)
{
    float sr, sg, sb;
    fgb_grade::gradeStraight8(static_cast<unsigned char>(r8), static_cast<unsigned char>(g8),
                              static_cast<unsigned char>(b8), 1.0f, p, sr, sg, sb);
    std::printf("scalar: %.9f %.9f %.9f\n", static_cast<double>(sr), static_cast<double>(sg), static_cast<double>(sb));
#if defined(FGB_GRADE_SSE2)
    const float* lut = fgb_grade::decodeTable8().data();
    const float vr = lut[r8], vg = lut[g8], vb = lut[b8];
    __m128 r = _mm_set1_ps(vr);
    __m128 g = _mm_set1_ps(vg);
    __m128 b = _mm_set1_ps(vb);
    fgb_grade::simd::gradeLinearToEncoded_ps(p, r, g, b);
    float fr[4], fg4[4], fb[4];
    _mm_storeu_ps(fr, r);
    _mm_storeu_ps(fg4, g);
    _mm_storeu_ps(fb, b);
    std::printf("simd  : %.9f %.9f %.9f\n", static_cast<double>(fr[0]), static_cast<double>(fg4[0]),
                static_cast<double>(fb[0]));
#endif
    return 0;
}

static int checkSimdWide(const fgb_grade::GradeParams& p, int iterations, int bits)
{
#if defined(FGB_GRADE_SSE2)
    unsigned seed = 424242u;
    int mismatches = 0;
    int total = 0;
    float worst = 0.0f;
    const float scale = (bits == 16) ? (1.0f / 32768.0f) : 1.0f;
    const float invScale = (bits == 16) ? 32768.0f : 1.0f;
    const unsigned maxValue = (bits == 16) ? 32768u : 1000u;
    for (int it = 0; it < iterations; ++it)
    {
        float in[4][3];
        float alpha[4];
        for (int k = 0; k < 4; ++k)
        {
            for (int c = 0; c < 3; ++c)
            {
                seed = seed * 1664525u + 1013904223u;
                in[k][c] = static_cast<float>(seed % maxValue) * scale;
            }
            seed = seed * 1664525u + 1013904223u;
            alpha[k] = static_cast<float>(seed % maxValue) * scale;
        }

        __m128 r = _mm_set_ps(in[3][0], in[2][0], in[1][0], in[0][0]);
        __m128 g = _mm_set_ps(in[3][1], in[2][1], in[1][1], in[0][1]);
        __m128 b = _mm_set_ps(in[3][2], in[2][2], in[1][2], in[0][2]);
        const __m128 a4 = _mm_set_ps(alpha[3], alpha[2], alpha[1], alpha[0]);
        fgb_grade::simd::gradePremul4(p, r, g, b, a4);
        float fr[4], fg[4], fb[4];
        _mm_storeu_ps(fr, r);
        _mm_storeu_ps(fg, g);
        _mm_storeu_ps(fb, b);

        for (int k = 0; k < 4; ++k)
        {
            float sr, sg, sb;
            fgb_grade::gradePixelPremul(in[k][0], in[k][1], in[k][2], alpha[k], p, sr, sg, sb);
            const float d = std::max(std::max(std::fabs(fr[k] - sr), std::fabs(fg[k] - sg)),
                                     std::fabs(fb[k] - sb));
            if (d > 0.0f)
            {
                ++mismatches;
                worst = std::max(worst, d * invScale);
            }
            ++total;
        }
    }
    std::printf("%d-bit premul SIMD vs scalar: %d/%d pixels differ, worst %.6f code values\n", bits, mismatches,
                total, static_cast<double>(worst));
    return mismatches == 0 ? 0 : 1;
#else
    std::printf("SSE2 path not compiled\n");
    return 2;
#endif
}

static int checkMath(int iterations)
{
#if defined(FGB_GRADE_SSE2)
    unsigned seed = 1234567u;
    int badLog = 0, badExp = 0, badCbrt = 0, badPow = 0;
    float worstLog = 0.0f, worstExp = 0.0f, worstCbrt = 0.0f, worstPow = 0.0f;
    for (int i = 0; i < iterations; ++i)
    {
        float xs[4];
        for (int k = 0; k < 4; ++k)
        {
            seed = seed * 1664525u + 1013904223u;
            xs[k] = 0.001f + 0.999f * static_cast<float>(seed >> 12) / static_cast<float>(1u << 20);
        }
        const __m128 v = _mm_set_ps(xs[3], xs[2], xs[1], xs[0]);
        float lf[4], ef[4], cf[4], pf[4];
        _mm_storeu_ps(lf, fgb_grade::simd::log2_ps(v));
        _mm_storeu_ps(ef, fgb_grade::simd::exp2_ps(_mm_mul_ps(v, _mm_set1_ps(3.7f))));
        _mm_storeu_ps(cf, fgb_grade::simd::cbrt_ps(v));
        _mm_storeu_ps(pf, fgb_grade::simd::pow_ps(v, 0.4545f));
        for (int k = 0; k < 4; ++k)
        {
            const float ls = fgb_grade::fastLog2(xs[k]);
            const float es = fgb_grade::fastExp2(xs[k] * 3.7f);
            const float cs = fgb_grade::fastCbrt(xs[k]);
            const float ps = fgb_grade::fastPow(xs[k], 0.4545f);
            if (ls != lf[k]) { ++badLog; worstLog = std::max(worstLog, std::fabs(ls - lf[k])); }
            if (es != ef[k]) { ++badExp; worstExp = std::max(worstExp, std::fabs(es - ef[k])); }
            if (cs != cf[k]) { ++badCbrt; worstCbrt = std::max(worstCbrt, std::fabs(cs - cf[k])); }
            if (ps != pf[k]) { ++badPow; worstPow = std::max(worstPow, std::fabs(ps - pf[k])); }
        }
    }
    std::printf("log2 %d/%d (worst %.6g)  exp2 %d (%.6g)  cbrt %d (%.6g)  pow %d (%.6g)\n", badLog, iterations * 4,
                static_cast<double>(worstLog), badExp, static_cast<double>(worstExp), badCbrt,
                static_cast<double>(worstCbrt), badPow, static_cast<double>(worstPow));
    return 0;
#else
    std::printf("SSE2 path not compiled\n");
    return 2;
#endif
}

static int checkSimd(const fgb_grade::GradeParams& p, int iterations)
{
#if defined(FGB_GRADE_SSE2)
    const float* lut = fgb_grade::decodeTable8().data();
    int mismatches = 0;
    int total = 0;
    float worst = 0.0f;
    unsigned seed = 987654321u;
    for (int it = 0; it < iterations; ++it)
    {
        unsigned char r8[4], g8[4], b8[4];
        for (int k = 0; k < 4; ++k)
        {
            seed = seed * 1664525u + 1013904223u;
            r8[k] = static_cast<unsigned char>(seed >> 23);
            seed = seed * 1664525u + 1013904223u;
            g8[k] = static_cast<unsigned char>(seed >> 23);
            seed = seed * 1664525u + 1013904223u;
            b8[k] = static_cast<unsigned char>(seed >> 23);
        }
        __m128 r = _mm_set_ps(lut[r8[3]], lut[r8[2]], lut[r8[1]], lut[r8[0]]);
        __m128 g = _mm_set_ps(lut[g8[3]], lut[g8[2]], lut[g8[1]], lut[g8[0]]);
        __m128 b = _mm_set_ps(lut[b8[3]], lut[b8[2]], lut[b8[1]], lut[b8[0]]);
        fgb_grade::simd::gradeLinearToEncoded_ps(p, r, g, b);
        float fr[4], fg[4], fb[4];
        _mm_storeu_ps(fr, r);
        _mm_storeu_ps(fg, g);
        _mm_storeu_ps(fb, b);
        for (int k = 0; k < 4; ++k)
        {
            float sr, sg, sb;
            fgb_grade::gradeStraight8(r8[k], g8[k], b8[k], 1.0f, p, sr, sg, sb);
            const float d = std::max(std::max(std::fabs(fr[k] - sr), std::fabs(fg[k] - sg)),
                                     std::fabs(fb[k] - sb));
            if (d > 0.0f)
            {
                ++mismatches;
                worst = std::max(worst, d);
            }
            ++total;
        }
    }
    std::printf("SIMD vs scalar: %d/%d pixels differ, worst channel delta %.6f\n", mismatches, total, worst);
    return mismatches == 0 ? 0 : 1;
#else
    std::printf("SSE2 path not compiled\n");
    return 2;
#endif
}

int main(int argc, char** argv)
{
    if (argc < 8)
    {
        std::fprintf(stderr,
                     "usage: grade_cli exposure contrast saturation temperature tint highlights shadows "
                     "[--straight|--bench MPIX|--bench8 MPIX|--check-simd N] < rgb[a]\n");
        return 2;
    }

    const fgb_grade::GradeParams p = paramsFromArgs(argv);
    bool straight = false;
    double benchMpix = 0.0;
    int checkIterations = 0;
    int checkBits = 0;
    int wideBits = 0;
    bool checkMathOnly = false;
    bool use8 = false;
    for (int i = 8; i < argc; ++i)
    {
        if (std::strcmp(argv[i], "--straight") == 0)
        {
            straight = true;
        }
        else if (std::strcmp(argv[i], "--bench") == 0 && i + 1 < argc)
        {
            benchMpix = std::atof(argv[++i]);
        }
        else if (std::strcmp(argv[i], "--bench8") == 0 && i + 1 < argc)
        {
            use8 = true;
            benchMpix = std::atof(argv[++i]);
        }
        else if (std::strcmp(argv[i], "--probe") == 0 && i + 3 < argc)
        {
            return probePixel(p, std::atoi(argv[i + 1]), std::atoi(argv[i + 2]), std::atoi(argv[i + 3]));
        }
        else if (std::strcmp(argv[i], "--check-math") == 0 && i + 1 < argc)
        {
            checkIterations = std::atoi(argv[++i]);
            checkMathOnly = true;
        }
        else if (std::strcmp(argv[i], "--bench16") == 0 && i + 1 < argc)
        {
            use8 = false;
            wideBits = 16;
            benchMpix = std::atof(argv[++i]);
        }
        else if (std::strcmp(argv[i], "--bench16s") == 0 && i + 1 < argc)
        {
            wideBits = -1;
            benchMpix = std::atof(argv[++i]);
        }
        else if (std::strcmp(argv[i], "--bench32") == 0 && i + 1 < argc)
        {
            use8 = false;
            wideBits = 32;
            benchMpix = std::atof(argv[++i]);
        }
        else if (std::strcmp(argv[i], "--check-simd") == 0 && i + 1 < argc)
        {
            checkIterations = std::atoi(argv[++i]);
        }
        else if (std::strcmp(argv[i], "--check-simd16") == 0 && i + 1 < argc)
        {
            checkIterations = std::atoi(argv[++i]);
            checkBits = 16;
        }
        else if (std::strcmp(argv[i], "--check-simd32") == 0 && i + 1 < argc)
        {
            checkIterations = std::atoi(argv[++i]);
            checkBits = 32;
        }
    }
    if (checkIterations > 0)
    {
        if (checkMathOnly)
        {
            return checkMath(checkIterations);
        }
        if (checkBits == 16 || checkBits == 32)
        {
            return checkSimdWide(p, checkIterations, checkBits);
        }
        return checkSimd(p, checkIterations);
    }
    if (benchMpix > 0.0)
    {
        if (wideBits == -1)
        {
            return bench16Scalar(p, benchMpix);
        }
        if (wideBits == 16 || wideBits == 32)
        {
            return bench16(p, benchMpix, wideBits);
        }
        return use8 ? bench8(p, benchMpix) : benchScalar(p, benchMpix);
    }

    char line[512];
    while (std::fgets(line, sizeof(line), stdin))
    {
        double r8, g8, b8, a8 = 255.0;
        const int got = std::sscanf(line, "%lf %lf %lf %lf", &r8, &g8, &b8, &a8);
        if (got < 3)
        {
            continue;
        }
        if (got < 4)
        {
            a8 = 255.0;
        }

        const float alpha = static_cast<float>(a8) * (1.0f / 255.0f);
        float r, g, b;
        if (straight)
        {
            fgb_grade::gradePixelStraight(static_cast<float>(r8) * (1.0f / 255.0f),
                                          static_cast<float>(g8) * (1.0f / 255.0f),
                                          static_cast<float>(b8) * (1.0f / 255.0f),
                                          alpha,
                                          p,
                                          r,
                                          g,
                                          b);
        }
        else
        {
            fgb_grade::gradePixelPremul(static_cast<float>(r8) * (1.0f / 255.0f),
                                        static_cast<float>(g8) * (1.0f / 255.0f),
                                        static_cast<float>(b8) * (1.0f / 255.0f),
                                        alpha,
                                        p,
                                        r,
                                        g,
                                        b);
        }

        std::printf("%.3f %.3f %.3f\n", r * 255.0f, g * 255.0f, b * 255.0f);
    }
    return 0;
}
