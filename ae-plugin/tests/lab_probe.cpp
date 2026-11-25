// Compare the scalar and SSE2 Lab blocks step by step for one pixel.
// Build: cl /O2 /EHsc /IFigmaImageGrade lab_probe.cpp /Fe:lab_probe.exe
#include <cstdio>
#include <cmath>

#include "FigmaImageGradeKernel.h"

static fgb_grade::GradeParams P;

static void dumpScalar(float r, float g, float b)
{
    const float fx = fgb_grade::fastCbrt((0.4124564f * r + 0.3575761f * g + 0.1804375f * b) * (1.0f / 0.95047f));
    const float fy = fgb_grade::fastCbrt(0.2126729f * r + 0.7151522f * g + 0.0721750f * b);
    const float fz = fgb_grade::fastCbrt((0.0193339f * r + 0.1191920f * g + 0.9503041f * b) * (1.0f / 1.08883f));
    const float light = 116.0f * fy - 16.0f;
    float shift;
    if (P.contrast < 0.0f)
    {
        const float target = (light - 50.0f) * 0.2f + 50.0f;
        shift = 0.3f * (-P.contrast) * (target - light) / 116.0f;
    }
    else
    {
        const float t = fgb_grade::clampf((light - 20.0f) / 60.0f, 0.0f, 1.0f);
        const float target = 100.0f * t * t * t * (6.0f * t * t - 15.0f * t + 10.0f);
        shift = 0.3f * P.contrast * (target - light) / 116.0f;
    }
    const float ax = fx + shift + 0.06f * P.tint;
    const float ay = fy + shift;
    const float az = fz + shift - 0.15f * P.temperature;
    const float X = 0.95047f * ax * ax * ax;
    const float Y = ay * ay * ay;
    const float Z = 1.08883f * az * az * az;
    const float rr = 3.2404542f * X - 1.5371385f * Y - 0.4985314f * Z;
    const float gg = -0.9692660f * X + 1.8760108f * Y + 0.0415560f * Z;
    const float bb = 0.0556434f * X - 0.2040259f * Y + 1.0572252f * Z;
    std::printf("scalar: fx=%.9f fy=%.9f fz=%.9f light=%.9f shift=%.9f\n", fx, fy, fz, light, shift);
    std::printf("        ax=%.9f ay=%.9f az=%.9f\n", ax, ay, az);
    std::printf("        X=%.9f Y=%.9f Z=%.9f  r=%.9f g=%.9f b=%.9f\n", X, Y, Z, rr, gg, bb);
}

static void dumpSimd(float r, float g, float b)
{
    using namespace fgb_grade::simd;
    const __m128 vr = _mm_set1_ps(r);
    const __m128 vg = _mm_set1_ps(g);
    const __m128 vb = _mm_set1_ps(b);
    const __m128 fx = cbrt_ps(_mm_mul_ps(_mm_add_ps(_mm_add_ps(_mm_mul_ps(vr, _mm_set1_ps(0.4124564f)),
                                                           _mm_mul_ps(vg, _mm_set1_ps(0.3575761f))),
                                                _mm_mul_ps(vb, _mm_set1_ps(0.1804375f))),
                                     _mm_set1_ps(1.0f / 0.95047f)));
    const __m128 fy = cbrt_ps(_mm_add_ps(_mm_add_ps(_mm_mul_ps(vr, _mm_set1_ps(0.2126729f)),
                                                    _mm_mul_ps(vg, _mm_set1_ps(0.7151522f))),
                                         _mm_mul_ps(vb, _mm_set1_ps(0.0721750f))));
    const __m128 fz = cbrt_ps(_mm_mul_ps(_mm_add_ps(_mm_add_ps(_mm_mul_ps(vr, _mm_set1_ps(0.0193339f)),
                                                           _mm_mul_ps(vg, _mm_set1_ps(0.1191920f))),
                                                _mm_mul_ps(vb, _mm_set1_ps(0.9503041f))),
                                     _mm_set1_ps(1.0f / 1.08883f)));
    const __m128 light = _mm_sub_ps(_mm_mul_ps(_mm_set1_ps(116.0f), fy), _mm_set1_ps(16.0f));
    __m128 shift;
    if (P.contrast < 0.0f)
    {
        const __m128 target = _mm_add_ps(_mm_mul_ps(_mm_sub_ps(light, _mm_set1_ps(50.0f)), _mm_set1_ps(0.2f)),
                                         _mm_set1_ps(50.0f));
        shift = _mm_div_ps(_mm_mul_ps(_mm_set1_ps(0.3f * (-P.contrast)), _mm_sub_ps(target, light)),
                           _mm_set1_ps(116.0f));
    }
    else
    {
        const __m128 t = clamp_ps(_mm_div_ps(_mm_sub_ps(light, _mm_set1_ps(20.0f)), _mm_set1_ps(60.0f)), zero(), one());
        const __m128 t3 = _mm_mul_ps(_mm_mul_ps(_mm_mul_ps(_mm_set1_ps(100.0f), t), t), t);
        const __m128 shape = _mm_add_ps(_mm_sub_ps(_mm_mul_ps(_mm_mul_ps(_mm_set1_ps(6.0f), t), t),
                                                   _mm_mul_ps(_mm_set1_ps(15.0f), t)),
                                        _mm_set1_ps(10.0f));
        const __m128 target = _mm_mul_ps(t3, shape);
        shift = _mm_div_ps(_mm_mul_ps(_mm_set1_ps(0.3f * P.contrast), _mm_sub_ps(target, light)),
                           _mm_set1_ps(116.0f));
    }
    const __m128 ax = _mm_add_ps(_mm_add_ps(fx, shift), _mm_set1_ps(0.06f * P.tint));
    const __m128 ay = _mm_add_ps(fy, shift);
    const __m128 az = _mm_sub_ps(_mm_add_ps(fz, shift), _mm_set1_ps(0.15f * P.temperature));
    const __m128 X = _mm_mul_ps(_mm_mul_ps(_mm_mul_ps(_mm_set1_ps(0.95047f), ax), ax), ax);
    const __m128 Y = _mm_mul_ps(_mm_mul_ps(ay, ay), ay);
    const __m128 Z = _mm_mul_ps(_mm_mul_ps(_mm_mul_ps(_mm_set1_ps(1.08883f), az), az), az);
    float f[4];
    _mm_storeu_ps(f, fx); std::printf("simd  : fx=%.9f ", f[0]);
    _mm_storeu_ps(f, fy); std::printf("fy=%.9f ", f[0]);
    _mm_storeu_ps(f, fz); std::printf("fz=%.9f ", f[0]);
    _mm_storeu_ps(f, light); std::printf("light=%.9f ", f[0]);
    _mm_storeu_ps(f, shift); std::printf("shift=%.9f\n", f[0]);
    _mm_storeu_ps(f, ax); std::printf("        ax=%.9f ", f[0]);
    _mm_storeu_ps(f, ay); std::printf("ay=%.9f ", f[0]);
    _mm_storeu_ps(f, az); std::printf("az=%.9f\n", f[0]);
    _mm_storeu_ps(f, X); std::printf("        X=%.9f ", f[0]);
    _mm_storeu_ps(f, Y); std::printf("Y=%.9f ", f[0]);
    _mm_storeu_ps(f, Z); std::printf("Z=%.9f\n", f[0]);
}

int main()
{
    // same numbers the CLI probe used
    P.exposure = 0.0f;
    P.contrast = 0.05f;
    P.saturation = 0.0f;
    P.temperature = 0.0f;
    P.tint = 0.0f;
    P.highlights = 0.0f;
    P.shadows = 0.0f;

    const float* lut = fgb_grade::decodeTable8().data();
    dumpScalar(lut[200], lut[100], lut[50]);
    dumpSimd(lut[200], lut[100], lut[50]);

    __m128 vr = _mm_set1_ps(lut[200]);
    __m128 vg = _mm_set1_ps(lut[100]);
    __m128 vb = _mm_set1_ps(lut[50]);
    fgb_grade::simd::gradeLinearToEncoded_ps(P, vr, vg, vb);
    float f[4];
    _mm_storeu_ps(f, vr);
    std::printf("function out r=%.9f ", f[0]);
    _mm_storeu_ps(f, vg);
    std::printf("g=%.9f ", f[0]);
    _mm_storeu_ps(f, vb);
    std::printf("b=%.9f\n", f[0]);
    return 0;
}
