// Micro-benchmark: old vs new fast transcendentals, to find the regression.
// Build: cl /O2 /EHsc bench_math.cpp /Fe:bench_math.exe

#include <cmath>
#include <cstdio>
#include <ctime>

static float sink = 0.0f;

// ---------- old (v1.0) ----------
static inline float oldLog2(float x)
{
    union
    {
        float f;
        unsigned u;
    } v;
    v.f = x;
    const float e = static_cast<float>(static_cast<int>((v.u >> 23) & 0xFFu) - 127);
    v.u = (v.u & 0x007FFFFFu) | 0x3F800000u;
    const float m = v.f;
    const float t = (m - 1.0f) / (m + 1.0f);
    const float t2 = t * t;
    const float p = t * (2.0f + t2 * (0.6666667f + t2 * (0.4f + t2 * 0.2857143f)));
    return e + p * 1.4426950f;
}

static inline float oldExp2(float x)
{
    const float n = std::floor(x);
    const float f = x - n;
    const float p =
        1.0f +
        f * (0.6931472f + f * (0.2402265f + f * (0.0555041f + f * (0.0096181f + f * (0.0013334f + f * 0.0001540f)))));
    union
    {
        float f;
        unsigned u;
    } s;
    s.u = static_cast<unsigned>(static_cast<int>(n) + 127) << 23;
    return p * s.f;
}

static inline float oldPow(float x, float p)
{
    return oldExp2(oldLog2(x) * p);
}

// ---------- new (v1.1) ----------
static inline float newLog2Mantissa(float c)
{
    float p = -8.7640052124e-03f;
    p = p * c + 4.9654495614e-02f;
    p = p * c + -1.3317839423e-01f;
    p = p * c + 2.3772988292e-01f;
    p = p * c + -3.4507774617e-01f;
    p = p * c + 4.7801339839e-01f;
    p = p * c + -7.2106056112e-01f;
    p = p * c + 1.4426827040e+00f;
    p = p * c + 1.3128347331e-07f;
    return p;
}

static inline float newLog2(float x)
{
    union
    {
        float f;
        unsigned u;
    } v;
    v.f = x;
    const float e = static_cast<float>(static_cast<int>((v.u >> 23) & 0xFFu) - 127);
    v.u = (v.u & 0x007FFFFFu) | 0x3F800000u;
    return e + newLog2Mantissa(v.f - 1.0f);
}

static inline float newFloor(float x)
{
    const float t = static_cast<float>(static_cast<int>(x));
    return (t > x) ? (t - 1.0f) : t;
}

static inline float newExp2(float x)
{
    const float n = newFloor(x);
    const float f = x - n;
    const float p =
        1.0f +
        f * (0.6931472f + f * (0.2402265f + f * (0.0555041f + f * (0.0096181f + f * (0.0013334f + f * 0.0001540f)))));
    union
    {
        float f;
        unsigned u;
    } s;
    s.u = static_cast<unsigned>(static_cast<int>(n) + 127) << 23;
    return p * s.f;
}

static inline float newPow(float x, float p)
{
    return newExp2(newLog2(x) * p);
}

template <typename Fn>
static void bench(const char* label, Fn fn, int count)
{
    const clock_t t0 = std::clock();
    for (int i = 0; i < count; ++i)
    {
        const float t = static_cast<float>(i % 251) * (1.0f / 251.0f);
        sink += fn(0.05f + 0.9f * t);
    }
    const clock_t t1 = std::clock();
    const double s = static_cast<double>(t1 - t0) / CLOCKS_PER_SEC;
    std::printf("%-10s %8.1f Mops/s  (%.1f ns/op)\n", label, count / s / 1e6, s / count * 1e9);
}

int main()
{
    const int n = 20000000;
    bench("oldLog2", [](float x) { return oldLog2(x); }, n);
    bench("newLog2", [](float x) { return newLog2(x); }, n);
    bench("oldExp2", [](float x) { return oldExp2(x * 1.5f - 0.5f); }, n);
    bench("newExp2", [](float x) { return newExp2(x * 1.5f - 0.5f); }, n);
    bench("oldPow", [](float x) { return oldPow(x, 0.4545f); }, n);
    bench("newPow", [](float x) { return newPow(x, 0.4545f); }, n);
    std::printf("sink %.3f\n", sink);
    return 0;
}
