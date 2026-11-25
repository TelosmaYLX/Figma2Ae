/*******************************************************************/
/*  FigmaBackgroundBlur.cpp                                        */
/*                                                                 */
/*  After Effects reproduction of Figma's background-blur.          */
/*                                                                 */
/*  v1.3 - THE BLUR REGION COMES FROM A LAYER'S ALPHA CHANNEL.      */
/*                                                                 */
/*  Put the effect on an (unmasked) adjustment layer and pick the   */
/*  shape layer in the "??????" parameter. The shape layer's      */
/*  alpha channel is the blur region: its silhouette decides where  */
/*  the blurred backdrop is composited and its bounding box is the  */
/*  clamp rectangle (Figma clamps the blur to the node bounds).     */
/*                                                                 */
/*  Animated masks, track mattes, shape-layer transforms and        */
/*  animated alpha on that shape layer all drive the blur region    */
/*  directly - there are no fixed rectangle parameters any more.    */
/*                                                                 */
/*  Algorithm (reverse-engineered from Figma 126.8.16):             */
/*    - separable triangular (Bartlett) kernel, w(k)=max(0,R-|k|)   */
/*    - clamp to the shape bounds, weights renormalized             */
/*    - composite only inside the shape's alpha (hard Figma discard */
/*      or a soft coverage blend)                                   */
/*                                                                 */
/*  Also: Multi-Frame Rendering support, O(1)/pixel prefix-sum      */
/*  blur, UTF-8 Chinese UI strings.                                 */
/*******************************************************************/

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include "FigmaBackgroundBlur.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

#include "AEFX_SuiteHandlerTemplate.h"

namespace
{

    inline float clampf(float v, float lo, float hi)
    {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    struct LineBuffers
    {
        std::vector<float> pR, pG, pB;
        std::vector<float> ipR, ipG, ipB;
        std::vector<float> inR, inG, inB;
        std::vector<float> oR, oG, oB;

        void resize(int n)
        {
            pR.resize(n + 1); pG.resize(n + 1); pB.resize(n + 1);
            ipR.resize(n + 1); ipG.resize(n + 1); ipB.resize(n + 1);
            inR.resize(n); inG.resize(n); inB.resize(n);
            oR.resize(n); oG.resize(n); oB.resize(n);
        }
    };

    inline void buildPrefix(const float* v, int n, float* pref, float* ipref)
    {
        pref[0] = 0.0f;
        ipref[0] = 0.0f;
        for (int i = 0; i < n; ++i)
        {
            pref[i + 1] = pref[i] + v[i];
            ipref[i + 1] = ipref[i] + static_cast<float>(i) * v[i];
        }
    }

    // Exact separable triangular blur with clamp renormalization, O(1) per pixel.
    void processLine(const float* inR,
                     const float* inG,
                     const float* inB,
                     float* outR,
                     float* outG,
                     float* outB,
                     int n,
                     float C,
                     int K,
                     LineBuffers& lb)
    {
        buildPrefix(inR, n, lb.pR.data(), lb.ipR.data());
        buildPrefix(inG, n, lb.pG.data(), lb.ipG.data());
        buildPrefix(inB, n, lb.pB.data(), lb.ipB.data());

        for (int x = 0; x < n; ++x)
        {
            float nR = C * inR[x];
            float nG = C * inG[x];
            float nB = C * inB[x];
            float d = C;

            const int a = (x - K > 0) ? (x - K) : 0;
            if (x > 0)
            {
                const int cnt = x - a;
                const float sumI = static_cast<float>(a + x - 1) * 0.5f * static_cast<float>(cnt);
                const float cMinusX = C - static_cast<float>(x);
                nR += cMinusX * (lb.pR[x] - lb.pR[a]) + (lb.ipR[x] - lb.ipR[a]);
                nG += cMinusX * (lb.pG[x] - lb.pG[a]) + (lb.ipG[x] - lb.ipG[a]);
                nB += cMinusX * (lb.pB[x] - lb.pB[a]) + (lb.ipB[x] - lb.ipB[a]);
                d += C * static_cast<float>(cnt) - static_cast<float>(x) * static_cast<float>(cnt) + sumI;
            }

            const int b = (x + K < n - 1) ? (x + K) : (n - 1);
            if (x < n - 1)
            {
                const int cnt = b - x;
                const float sumI = static_cast<float>(x + 1 + b) * 0.5f * static_cast<float>(cnt);
                const float cPlusX = C + static_cast<float>(x);
                nR += cPlusX * (lb.pR[b + 1] - lb.pR[x + 1]) - (lb.ipR[b + 1] - lb.ipR[x + 1]);
                nG += cPlusX * (lb.pG[b + 1] - lb.pG[x + 1]) - (lb.ipG[b + 1] - lb.ipG[x + 1]);
                nB += cPlusX * (lb.pB[b + 1] - lb.pB[x + 1]) - (lb.ipB[b + 1] - lb.ipB[x + 1]);
                d += C * static_cast<float>(cnt) - (sumI - static_cast<float>(x) * static_cast<float>(cnt));
            }

            if (d > 1.0e-9f)
            {
                const float inv = 1.0f / d;
                outR[x] = nR * inv;
                outG[x] = nG * inv;
                outB[x] = nB * inv;
            }
            else
            {
                outR[x] = inR[x];
                outG[x] = inG[x];
                outB[x] = inB[x];
            }
        }
    }

    // Triangulaer blur with a PER-PIXEL count (Figma progressive blur).
    // cin[x*cstride] is the kernel count for the output pixel x; the prefix-sum
    // evaluation is still O(1)/pixel, only the per-pixel support range changes.
    void processLineVar(const float* inR,
                        const float* inG,
                        const float* inB,
                        float* outR,
                        float* outG,
                        float* outB,
                        int n,
                        const float* cin,
                        int cstride,
                        int Kmax,
                        LineBuffers& lb)
    {
        buildPrefix(inR, n, lb.pR.data(), lb.ipR.data());
        buildPrefix(inG, n, lb.pG.data(), lb.ipG.data());
        buildPrefix(inB, n, lb.pB.data(), lb.ipB.data());

        for (int x = 0; x < n; ++x)
        {
            float C = cin[x * cstride];
            if (C < 0.001f)
            {
                C = 0.001f;
            }
            int a = static_cast<int>(std::ceil(static_cast<double>(C))) - 1;
            if (a < 0) a = 0;
            if (a > Kmax) a = Kmax;

            float nR = C * inR[x];
            float nG = C * inG[x];
            float nB = C * inB[x];
            float d = C;

            const int aL = (x < a) ? x : a;
            if (aL > 0)
            {
                const float sumI = (static_cast<float>(x - aL) + static_cast<float>(x - 1)) * 0.5f * static_cast<float>(aL);
                const float K0 = C - static_cast<float>(x);
                nR += K0 * (lb.pR[x] - lb.pR[x - aL]) + (lb.ipR[x] - lb.ipR[x - aL]);
                nG += K0 * (lb.pG[x] - lb.pG[x - aL]) + (lb.ipG[x] - lb.ipG[x - aL]);
                nB += K0 * (lb.pB[x] - lb.pB[x - aL]) + (lb.ipB[x] - lb.ipB[x - aL]);
                d += C * static_cast<float>(aL) - static_cast<float>(x) * static_cast<float>(aL) + sumI;
            }

            int aR = (n - 1 - x < a) ? (n - 1 - x) : a;
            if (aR > 0)
            {
                const float sumI = (static_cast<float>(x + 1) + static_cast<float>(x + aR)) * 0.5f * static_cast<float>(aR);
                const float K1 = C + static_cast<float>(x);
                nR += K1 * (lb.pR[x + 1 + aR] - lb.pR[x + 1]) - (lb.ipR[x + 1 + aR] - lb.ipR[x + 1]);
                nG += K1 * (lb.pG[x + 1 + aR] - lb.pG[x + 1]) - (lb.ipG[x + 1 + aR] - lb.ipG[x + 1]);
                nB += K1 * (lb.pB[x + 1 + aR] - lb.pB[x + 1]) - (lb.ipB[x + 1 + aR] - lb.ipB[x + 1]);
                d += C * static_cast<float>(aR) - (sumI - static_cast<float>(x) * static_cast<float>(aR));
            }

            if (d > 1.0e-9f)
            {
                const float inv = 1.0f / d;
                outR[x] = nR * inv;
                outG[x] = nG * inv;
                outB[x] = nB * inv;
            }
            else
            {
                outR[x] = inR[x];
                outG[x] = inG[x];
                outB[x] = inB[x];
            }
        }
    }

} // namespace

/* ------------------------------------------------------------------ */
/*  Pixel access                                                      */
/* ------------------------------------------------------------------ */

namespace
{

    inline void readPixel8(const PF_Pixel8& p, float& r, float& g, float& b, float& a)
    {
        r = static_cast<float>(p.red) / 255.0f;
        g = static_cast<float>(p.green) / 255.0f;
        b = static_cast<float>(p.blue) / 255.0f;
        a = static_cast<float>(p.alpha) / 255.0f;
    }

    inline void readPixel16(const PF_Pixel16& p, float& r, float& g, float& b, float& a)
    {
        r = static_cast<float>(p.red) / 32768.0f;
        g = static_cast<float>(p.green) / 32768.0f;
        b = static_cast<float>(p.blue) / 32768.0f;
        a = static_cast<float>(p.alpha) / 32768.0f;
    }

    inline void readPixelF(const PF_PixelFloat& p, float& r, float& g, float& b, float& a)
    {
        r = p.red;
        g = p.green;
        b = p.blue;
        a = p.alpha;
    }

    // Get a row pointer of a world in the requested bit depth.
    inline const void* rowPtr(const PF_EffectWorld* w, long y)
    {
        return reinterpret_cast<const char*>(w->data) + static_cast<size_t>(y) * static_cast<size_t>(w->rowbytes);
    }

    // Reads a pixel at (x,y) from a world with the given format.
    inline void readWorldPixel(const PF_EffectWorld* w, int kind, long x, long y, float& r, float& g, float& b, float& a)
    {
        switch (kind)
        {
            case 0:
            {
                const PF_Pixel8* row = reinterpret_cast<const PF_Pixel8*>(rowPtr(w, y));
                readPixel8(row[x], r, g, b, a);
                break;
            }
            case 1:
            {
                const PF_Pixel16* row = reinterpret_cast<const PF_Pixel16*>(rowPtr(w, y));
                readPixel16(row[x], r, g, b, a);
                break;
            }
            default:
            {
                const PF_PixelFloat* row = reinterpret_cast<const PF_PixelFloat*>(rowPtr(w, y));
                readPixelF(row[x], r, g, b, a);
                break;
            }
        }
    }

    int formatKind(PF_PixelFormat fmt)
    {
        switch (fmt)
        {
            case PF_PixelFormat_ARGB32: return 0;
            case PF_PixelFormat_ARGB64: return 1;
            case PF_PixelFormat_ARGB128: return 2;
            default: return -1;
        }
    }

} // namespace

/* ------------------------------------------------------------------ */
/*  Blur bounds / ramp helpers                                        */
/* ------------------------------------------------------------------ */

namespace
{


    struct AlphaBounds
    {
        long x0, y0, x1, y1;
        bool valid() const { return x1 >= x0 && y1 >= y0; }
    };

    // Bounding box of the non-zero alpha pixels of a world.
    AlphaBounds scanAlphaBounds(const PF_EffectWorld* w, int kind, long maxW, long maxH)
    {
        AlphaBounds b;
        b.x0 = maxW;
        b.y0 = maxH;
        b.x1 = -1;
        b.y1 = -1;

        if (w == nullptr || w->data == nullptr)
        {
            return b;
        }

        const long sw = (w->width < maxW) ? static_cast<long>(w->width) : maxW;
        const long sh = (w->height < maxH) ? static_cast<long>(w->height) : maxH;
        for (long y = 0; y < sh; ++y)
        {
            for (long x = 0; x < sw; ++x)
            {
                float r, g, bb, a;
                readWorldPixel(w, kind, x, y, r, g, bb, a);
                if (a > 0.0f)
                {
                    if (x < b.x0) b.x0 = x;
                    if (x > b.x1) b.x1 = x;
                    if (y < b.y0) b.y0 = y;
                    if (y > b.y1) b.y1 = y;
                }
            }
        }
        return b;
    }

    // Host-mask mode (Alpha源 = 无): the blur region is the adjustment layer's
    // own masks. AE clips the effect output with the layer alpha, so the plug-in
    // only needs the mask bounds for Figma's clamp. PF_InData.extent_hint is
    // always the whole frame (verified), so the bounds are queried through AEGP
    // - AEGP_GetEffectLayer is documented as callable from PF_Cmd_RENDER. They
    // come back in layer space; the layer-to-world matrix maps them to comp
    // space (AEGP matrices are row-vector style: comp = [x,y,0,1] * M).
    bool hostMaskedBoundsCompSpace(PF_InData* in_data,
                                   long cw,
                                   long ch,
                                   float& x0,
                                   float& y0,
                                   float& x1,
                                   float& y1)
    {
        x0 = 0.0f;
        y0 = 0.0f;
        x1 = static_cast<float>(cw);
        y1 = static_cast<float>(ch);

        AEGP_SuiteHandler suites(in_data->pica_basicP);
        if (suites.PFInterfaceSuite1() == nullptr || suites.LayerSuite9() == nullptr)
        {
            return false;
        }

        AEGP_LayerH layerH = nullptr;
        if (suites.PFInterfaceSuite1()->AEGP_GetEffectLayer(in_data->effect_ref, &layerH) != A_Err_NONE ||
            layerH == nullptr)
        {
            return false;
        }

        A_Time layerTime;
        layerTime.value = in_data->current_time;
        layerTime.scale = in_data->time_scale;

        A_Time compTime;
        std::memset(&compTime, 0, sizeof(compTime));
        if (suites.LayerSuite9()->AEGP_ConvertLayerToCompTime(layerH, &layerTime, &compTime) != A_Err_NONE)
        {
            return false;
        }

        A_FloatRect bounds;
        std::memset(&bounds, 0, sizeof(bounds));
        if (suites.LayerSuite9()->AEGP_GetLayerMaskedBounds(layerH, AEGP_LTimeMode_CompTime, &compTime, &bounds) !=
            A_Err_NONE)
        {
            return false;
        }

        A_Matrix4 xform;
        std::memset(&xform, 0, sizeof(xform));
        if (suites.LayerSuite9()->AEGP_GetLayerToWorldXform(layerH, &compTime, &xform) != A_Err_NONE)
        {
            return false;
        }

        const double cornerX[4] = {bounds.left, bounds.right, bounds.right, bounds.left};
        const double cornerY[4] = {bounds.top, bounds.top, bounds.bottom, bounds.bottom};
        double minX = 1.0e30;
        double minY = 1.0e30;
        double maxX = -1.0e30;
        double maxY = -1.0e30;
        for (int i = 0; i < 4; ++i)
        {
            const double px = cornerX[i] * xform.mat[0][0] + cornerY[i] * xform.mat[1][0] + xform.mat[3][0];
            const double py = cornerX[i] * xform.mat[0][1] + cornerY[i] * xform.mat[1][1] + xform.mat[3][1];
            minX = std::min(minX, px);
            maxX = std::max(maxX, px);
            minY = std::min(minY, py);
            maxY = std::max(maxY, py);
        }

        x0 = static_cast<float>(std::max(0.0, minX));
        y0 = static_cast<float>(std::max(0.0, minY));
        x1 = static_cast<float>(std::min(static_cast<double>(cw), maxX));
        y1 = static_cast<float>(std::min(static_cast<double>(ch), maxY));
        if (x1 <= x0 || y1 <= y0)
        {
            x0 = 0.0f;
            y0 = 0.0f;
            x1 = static_cast<float>(cw);
            y1 = static_cast<float>(ch);
            return false;
        }
        return true;
    }

} // namespace

/* ------------------------------------------------------------------ */
/*  Main render                                                       */
/* ------------------------------------------------------------------ */

namespace
{

    PF_Err renderBlur(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output)
    {
        PF_Err err = PF_Err_NONE;

        PF_EffectWorld* src = &params[FGB_INPUT]->u.ld;
        PF_EffectWorld* dst = output;

        if (!src->data || !dst->data || src->width <= 0 || src->height <= 0)
        {
            return PF_Err_NONE;
        }

        const float radius = static_cast<float>(params[FGB_RADIUS]->u.fs_d.value);
        const bool aaEdge = params[FGB_AA_EDGE]->u.bd.value != 0;
        const int mode = static_cast<int>(params[FGB_MODE]->u.pd.value); // 1 = uniform, 2 = progressive
        const float startRadius = static_cast<float>(params[FGB_START_RADIUS]->u.fs_d.value);
        const float endRadius = static_cast<float>(params[FGB_END_RADIUS]->u.fs_d.value);
        // The ramp is defined in PERCENT of the blur bounds, which makes it
        // follow the region (and with it the mask / shape layer) automatically,
        // exactly like Figma's node-normalised blurStartOffset/blurEndOffset.
        const float rampStartPctX = static_cast<float>(params[FGB_GRAD_SX]->u.fs_d.value);
        const float rampStartPctY = static_cast<float>(params[FGB_GRAD_SY]->u.fs_d.value);
        const float rampEndPctX = static_cast<float>(params[FGB_GRAD_EX]->u.fs_d.value);
        const float rampEndPctY = static_cast<float>(params[FGB_GRAD_EY]->u.fs_d.value);
        const bool progressive = (mode == 2);

        const long cw = src->width;
        const long ch = src->height;

        AEFX_SuiteScoper<PF_WorldSuite2> worldSuite(in_data, kPFWorldSuite, kPFWorldSuiteVersion2, out_data);
        PF_PixelFormat pixelFormat = PF_PixelFormat_INVALID;
        ERR(worldSuite->PF_GetPixelFormat(src, &pixelFormat));
        const int kind = formatKind(pixelFormat);
        if (kind < 0)
        {
            return PF_Err_NONE;
        }

        const int bpp = (kind == 0) ? static_cast<int>(sizeof(PF_Pixel8))
                        : (kind == 1) ? static_cast<int>(sizeof(PF_Pixel16))
                                      : static_cast<int>(sizeof(PF_PixelFloat));

        // Start with a copy of the backdrop.
        {
            const int rows = std::min(src->height, dst->height);
            const int cols = std::min(src->width, dst->width);
            const size_t bytes = static_cast<size_t>(cols) * static_cast<size_t>(bpp);
            for (int y = 0; y < rows; ++y)
            {
                const char* s = reinterpret_cast<const char*>(src->data) + static_cast<size_t>(y) * static_cast<size_t>(src->rowbytes);
                char* d = reinterpret_cast<char*>(dst->data) + static_cast<size_t>(y) * static_cast<size_t>(dst->rowbytes);
                std::memcpy(d, s, bytes);
            }
        }
        // ---- blur region ---------------------------------------------------
        // Alpha源 LOOKS UP A LAYER: its alpha silhouette is the region and its
        // alpha bounding box is Figma's clamp rectangle.
        // Alpha源 = 无: the region is the adjustment layer's OWN masks - AE
        // clips the effect output with the layer alpha, so the plug-in only
        // needs the mask bounds for the clamp, and the whole setup follows the
        // layer (and its parent) automatically.
        PF_ParamDef shapeDef;
        AEFX_CLR_STRUCT(shapeDef);
        bool haveShape = false;
        bool shapeCheckedOut = false;
        const PF_EffectWorld* shapeWorld = nullptr;

        long bx0 = 0;
        long by0 = 0;
        long bx1 = cw - 1;
        long by1 = ch - 1;

        const PF_ParamDef* shapeParam = params[FGB_MASK_LAYER];
        if (shapeParam != nullptr && shapeParam->param_type == PF_Param_LAYER)
        {
            if (PF_CHECKOUT_PARAM(in_data,
                                  FGB_MASK_LAYER,
                                  in_data->current_time,
                                  in_data->time_step,
                                  in_data->time_scale,
                                  &shapeDef) == PF_Err_NONE)
            {
                shapeCheckedOut = true;
                if (shapeDef.u.ld.data)
                {
                    shapeWorld = &shapeDef.u.ld;
                    haveShape = true;
                }
            }
        }

        int shapeKind = kind;
        PF_PixelFormat shapeFmt = pixelFormat;
        if (haveShape)
        {
            if (worldSuite->PF_GetPixelFormat(shapeWorld, &shapeFmt) == PF_Err_NONE)
            {
                const int k = formatKind(shapeFmt);
                if (k >= 0)
                {
                    shapeKind = k;
                }
            }
            const AlphaBounds b = scanAlphaBounds(shapeWorld, shapeKind, cw, ch);
            if (b.valid())
            {
                bx0 = b.x0;
                by0 = b.y0;
                bx1 = b.x1;
                by1 = b.y1;
            }
            else
            {
                // fully transparent source layer: nothing to blur
                bx0 = 0;
                by0 = 0;
                bx1 = cw - 1;
                by1 = ch - 1;
                haveShape = false;
            }
        }
        else
        {
            float mx0 = 0.0f;
            float my0 = 0.0f;
            float mx1 = static_cast<float>(cw);
            float my1 = static_cast<float>(ch);
            hostMaskedBoundsCompSpace(in_data, cw, ch, mx0, my0, mx1, my1);
            bx0 = static_cast<long>(std::floor(static_cast<double>(mx0)));
            by0 = static_cast<long>(std::floor(static_cast<double>(my0)));
            bx1 = static_cast<long>(std::ceil(static_cast<double>(mx1))) - 1;
            by1 = static_cast<long>(std::ceil(static_cast<double>(my1))) - 1;
            bx0 = std::max(0L, std::min(cw - 1, bx0));
            by0 = std::max(0L, std::min(ch - 1, by0));
            bx1 = std::max(0L, std::min(cw - 1, bx1));
            by1 = std::max(0L, std::min(ch - 1, by1));
        }

        const int rw = static_cast<int>(bx1 - bx0 + 1);
        const int rh = static_cast<int>(by1 - by0 + 1);
        // Effect input downsampling (draft previews).
        const float dsx = in_data->downsample_x.den != 0
                              ? static_cast<float>(in_data->downsample_x.num) / static_cast<float>(in_data->downsample_x.den)
                              : 1.0f;
        const float dsy = in_data->downsample_y.den != 0
                              ? static_cast<float>(in_data->downsample_y.num) / static_cast<float>(in_data->downsample_y.den)
                              : 1.0f;
        const float ds = 0.5f * (dsx + dsy);
        const float dsScale = (std::fabs(ds - 1.0f) > 0.01f) ? ds : 1.0f;
        const float maxRadius = progressive ? std::max(startRadius, endRadius) : radius;
        const float CMax = std::max(0.0f, maxRadius) * dsScale;
        const int Kmax = static_cast<int>(std::ceil(static_cast<double>(CMax)));

        const size_t area = static_cast<size_t>(rw) * static_cast<size_t>(rh);
        std::vector<float> R(area), G(area), B(area);
        std::vector<float> hR(area), hG(area), hB(area);
        std::vector<float> Cgrid; // progressive mode only

        // ---- ramp geometry (percent of the blur bounds) --------------------
        const float rampSx = static_cast<float>(bx0) + rampStartPctX * 0.01f * static_cast<float>(rw);
        const float rampSy = static_cast<float>(by0) + rampStartPctY * 0.01f * static_cast<float>(rh);
        const float rampEx = static_cast<float>(bx0) + rampEndPctX * 0.01f * static_cast<float>(rw);
        const float rampEy = static_cast<float>(by0) + rampEndPctY * 0.01f * static_cast<float>(rh);
        const float rampDx = rampEx - rampSx;
        const float rampDy = rampEy - rampSy;
        const float rampLen2 = rampDx * rampDx + rampDy * rampDy;
        const float rampInvLen2 = (rampLen2 > 1.0e-9f) ? (1.0f / rampLen2) : 0.0f;
        const float radiusStart = startRadius * dsScale;
        const float radiusDelta = (endRadius - startRadius) * dsScale;
        const float countCap = 64.0f * dsScale; // Figma caps the progressive count at 64
        const float uniformCount = std::max(0.0f, radius) * dsScale;

        if (progressive)
        {
            Cgrid.resize(area);
            for (int ry = 0; ry < rh; ++ry)
            {
                const float py = static_cast<float>(by0 + ry) + 0.5f;
                const size_t rowOff = static_cast<size_t>(ry) * rw;
                for (int rx = 0; rx < rw; ++rx)
                {
                    const float px = static_cast<float>(bx0 + rx) + 0.5f;
                    float t = 0.0f;
                    if (rampInvLen2 > 0.0f)
                    {
                        t = clampf(((px - rampSx) * rampDx + (py - rampSy) * rampDy) * rampInvLen2, 0.0f, 1.0f);
                    }
                    float c = radiusStart + radiusDelta * t;
                    if (c < 0.0f) c = 0.0f;
                    if (c > countCap) c = countCap;
                    Cgrid[rowOff + rx] = c;
                }
            }
        }
        // ---- load the backdrop (R,G,B only: the result is always opaque) ----
        for (int ry = 0; ry < rh; ++ry)
        {
            const long y = by0 + ry;
            const size_t rowOff = static_cast<size_t>(ry) * rw;
            for (int rx = 0; rx < rw; ++rx)
            {
                float r, g, b, a;
                readWorldPixel(src, kind, bx0 + rx, y, r, g, b, a);
                R[rowOff + rx] = r;
                G[rowOff + rx] = g;
                B[rowOff + rx] = b;
            }
        }
        // ---- horizontal pass ----------------------------------------------
        {
            LineBuffers lb;
            lb.resize(std::max(rw, rh));
            for (int ry = 0; ry < rh; ++ry)
            {
                const size_t off = static_cast<size_t>(ry) * rw;
                if (progressive)
                {
                    processLineVar(
                        &R[off], &G[off], &B[off], &hR[off], &hG[off], &hB[off], rw, &Cgrid[off], 1, Kmax, lb);
                }
                else
                {
                    // stride 0: the same per-pixel count everywhere
                    processLineVar(
                        &R[off], &G[off], &B[off], &hR[off], &hG[off], &hB[off], rw, &uniformCount, 0, Kmax, lb);
                }
            }
        }
        // ---- vertical pass + composite, in column blocks -------------------
        // A column block keeps every read/write contiguous (a block row is
        // kColumnBlock adjacent floats), which removes the cache misses of the
        // strided column walk, and the Figma blend/composite is fused into the
        // write-back so no extra full-frame pass or intermediate planes are
        // needed.
        {
            const int kColumnBlock = 16;
            const size_t blockPixels = static_cast<size_t>(kColumnBlock) * static_cast<size_t>(rh);
            std::vector<float> inR(blockPixels), inG(blockPixels), inB(blockPixels);
            std::vector<float> outR(blockPixels), outG(blockPixels), outB(blockPixels);
            std::vector<float> counts(blockPixels, 0.0f);
            LineBuffers lb;
            lb.resize(std::max(rh, rw));

            for (int xBase = 0; xBase < rw; xBase += kColumnBlock)
            {
                const int cols = std::min(kColumnBlock, rw - xBase);

                // gather this block's columns (+ kernel counts), contiguous per row
                for (int ry = 0; ry < rh; ++ry)
                {
                    const size_t rowOff = static_cast<size_t>(ry) * rw + static_cast<size_t>(xBase);
                    for (int c = 0; c < cols; ++c)
                    {
                        const size_t bi = static_cast<size_t>(c) * rh + static_cast<size_t>(ry);
                        inR[bi] = hR[rowOff + c];
                        inG[bi] = hG[rowOff + c];
                        inB[bi] = hB[rowOff + c];
                        if (progressive)
                        {
                            counts[bi] = Cgrid[rowOff + c];
                        }
                    }
                }

                // blur every column of the block (memory-sequential)
                for (int c = 0; c < cols; ++c)
                {
                    const size_t cb = static_cast<size_t>(c) * rh;
                    if (progressive)
                    {
                        processLineVar(&inR[cb],
                                       &inG[cb],
                                       &inB[cb],
                                       &outR[cb],
                                       &outG[cb],
                                       &outB[cb],
                                       rh,
                                       &counts[cb],
                                       1,
                                       Kmax,
                                       lb);
                    }
                    else
                    {
                        processLineVar(&inR[cb],
                                       &inG[cb],
                                       &inB[cb],
                                       &outR[cb],
                                       &outG[cb],
                                       &outB[cb],
                                       rh,
                                       &uniformCount,
                                       0,
                                       Kmax,
                                       lb);
                    }
                }

                // fused blend + composite + store, row by row (contiguous writes)
                for (int ry = 0; ry < rh; ++ry)
                {
                    const long y = by0 + ry;
                    const size_t rowOff = static_cast<size_t>(ry) * rw + static_cast<size_t>(xBase);
                    for (int c = 0; c < cols; ++c)
                    {
                        const long x = bx0 + xBase + c;
                        const size_t bi = static_cast<size_t>(c) * rh + static_cast<size_t>(ry);
                        const size_t o = rowOff + c;

                        // blurred colour; progressive blends towards the sharp
                        // source at the low-radius end with Figma's weights
                        float blurR = outR[bi];
                        float blurG = outG[bi];
                        float blurB = outB[bi];
                        if (progressive)
                        {
                            const float b = counts[bi];
                            if (b < 1.0f)
                            {
                                blurR = R[o];
                                blurG = G[o];
                                blurB = B[o];
                            }
                            else
                            {
                                const float wb = 4.0f * (b * b - 1.0f);
                                const float wBlur = wb * wb;
                                const float wSharp = b * b;
                                const float inv = 1.0f / (wBlur + wSharp);
                                blurR = (wBlur * blurR + wSharp * R[o]) * inv;
                                blurG = (wBlur * blurG + wSharp * G[o]) * inv;
                                blurB = (wBlur * blurB + wSharp * B[o]) * inv;
                            }
                        }

                        float cover = 1.0f;
                        if (haveShape)
                        {
                            float sr, sg, sb, sa;
                            readWorldPixel(shapeWorld, shapeKind, x, y, sr, sg, sb, sa);
                            cover = clampf(sa, 0.0f, 1.0f);
                        }

                        float resR = R[o];
                        float resG = G[o];
                        float resB = B[o];
                        if (cover > 0.0f)
                        {
                            if (aaEdge)
                            {
                                resR += (blurR - resR) * cover;
                                resG += (blurG - resG) * cover;
                                resB += (blurB - resB) * cover;
                            }
                            else
                            {
                                resR = blurR;
                                resG = blurG;
                                resB = blurB;
                            }
                        }

                        switch (kind)
                        {
                            case 0:
                            {
                                PF_Pixel8* p = reinterpret_cast<PF_Pixel8*>(
                                                   reinterpret_cast<char*>(dst->data) +
                                                   static_cast<size_t>(y) * static_cast<size_t>(dst->rowbytes)) +
                                               x;
                                p->red = static_cast<A_u_char>(clampf(resR * 255.0f + 0.5f, 0.0f, 255.0f));
                                p->green = static_cast<A_u_char>(clampf(resG * 255.0f + 0.5f, 0.0f, 255.0f));
                                p->blue = static_cast<A_u_char>(clampf(resB * 255.0f + 0.5f, 0.0f, 255.0f));
                                p->alpha = 255;
                                break;
                            }
                            case 1:
                            {
                                PF_Pixel16* p = reinterpret_cast<PF_Pixel16*>(
                                                    reinterpret_cast<char*>(dst->data) +
                                                    static_cast<size_t>(y) * static_cast<size_t>(dst->rowbytes)) +
                                                x;
                                p->red = static_cast<A_u_short>(clampf(resR * 32768.0f + 0.5f, 0.0f, 32768.0f));
                                p->green = static_cast<A_u_short>(clampf(resG * 32768.0f + 0.5f, 0.0f, 32768.0f));
                                p->blue = static_cast<A_u_short>(clampf(resB * 32768.0f + 0.5f, 0.0f, 32768.0f));
                                p->alpha = 32768;
                                break;
                            }
                            default:
                            {
                                PF_PixelFloat* p = reinterpret_cast<PF_PixelFloat*>(
                                                       reinterpret_cast<char*>(dst->data) +
                                                       static_cast<size_t>(y) * static_cast<size_t>(dst->rowbytes)) +
                                                   x;
                                p->red = clampf(resR, 0.0f, 1.0f);
                                p->green = clampf(resG, 0.0f, 1.0f);
                                p->blue = clampf(resB, 0.0f, 1.0f);
                                p->alpha = 1.0f;
                                break;
                            }
                        }
                    }
                }
            }
        }
        if (shapeCheckedOut)
        {
            PF_CHECKIN_PARAM(in_data, &shapeDef);
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
                                          "%s v%d.%d.%d\r%s",
                                          STR(StrID_Name),
                                          MAJOR_VERSION,
                                          MINOR_VERSION,
                                          BUG_VERSION,
                                          STR(StrID_Description));
    return PF_Err_NONE;
}

static PF_Err GlobalSetup(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output)
{
    out_data->my_version = PF_VERSION(MAJOR_VERSION, MINOR_VERSION, BUG_VERSION, STAGE_VERSION, BUILD_VERSION);
    out_data->out_flags |= PF_OutFlag_DEEP_COLOR_AWARE | PF_OutFlag_SEND_UPDATE_PARAMS_UI;
    out_data->out_flags2 |= PF_OutFlag2_SUPPORTS_THREADED_RENDERING;
    out_data->out_flags2 |= PF_OutFlag2_STRINGS_ARE_UTF8;
    return PF_Err_NONE;
}

static PF_Err ParamsSetup(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output)
{
    PF_Err err = PF_Err_NONE;
    PF_ParamDef def;

    // The mode popup is supervised so that switching between uniform and
    // progressive blurs can immediately enable/disable the unused parameters.
    AEFX_CLR_STRUCT(def);
    def.param_type = PF_Param_POPUP;
    PF_STRNNCPY(def.PF_DEF_NAME, STR(StrID_Mode_Param_Name), sizeof(def.PF_DEF_NAME));
    def.u.pd.num_choices = 2;
    def.u.pd.dephault = 1;
    def.u.pd.value = def.u.pd.dephault;
    def.u.pd.u.PF_DEF_NAMESPTR = STR(StrID_Mode_Choices);
    def.uu.id = FGB_MODE_DISK_ID;
    def.flags = PF_ParamFlag_SUPERVISE;
    ERR(PF_ADD_PARAM(in_data, -1, &def));

    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_Radius_Param_Name),
                         FGB_RADIUS_MIN,
                         FGB_RADIUS_MAX,
                         FGB_RADIUS_MIN,
                         200.0,
                         FGB_RADIUS_DFLT,
                         PF_Precision_HUNDREDTHS,
                         0,
                         0,
                         FGB_RADIUS_DISK_ID);

    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_StartRadius_Param_Name),
                         FGB_RADIUS_MIN,
                         FGB_RADIUS_MAX,
                         FGB_RADIUS_MIN,
                         200.0,
                         0.0,
                         PF_Precision_HUNDREDTHS,
                         0,
                         0,
                         FGB_START_RADIUS_DISK_ID);

    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_EndRadius_Param_Name),
                         FGB_RADIUS_MIN,
                         FGB_RADIUS_MAX,
                         FGB_RADIUS_MIN,
                         200.0,
                         FGB_RADIUS_DFLT,
                         PF_Precision_HUNDREDTHS,
                         0,
                         0,
                         FGB_END_RADIUS_DISK_ID);

    // Ramp endpoints, in PERCENT of the blur bounds (Figma's node-normalised
    // blurStartOffset/blurEndOffset). Percent values keep the ramp attached to
    // the region, so it follows the shape layer / mask without keyframes.
    // Defaults: vertical line through the middle, top -> bottom.
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_GradStartX_Param_Name),
                         0.0,
                         100.0,
                         0.0,
                         100.0,
                         50.0,
                         PF_Precision_TENTHS,
                         0,
                         0,
                         FGB_GRAD_SX_DISK_ID);

    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_GradStartY_Param_Name),
                         0.0,
                         100.0,
                         0.0,
                         100.0,
                         0.0,
                         PF_Precision_TENTHS,
                         0,
                         0,
                         FGB_GRAD_SY_DISK_ID);

    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_GradEndX_Param_Name),
                         0.0,
                         100.0,
                         0.0,
                         100.0,
                         50.0,
                         PF_Precision_TENTHS,
                         0,
                         0,
                         FGB_GRAD_EX_DISK_ID);

    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_GradEndY_Param_Name),
                         0.0,
                         100.0,
                         0.0,
                         100.0,
                         100.0,
                         PF_Precision_TENTHS,
                         0,
                         0,
                         FGB_GRAD_EY_DISK_ID);

    // Hide the retired controls while retaining their disk IDs and behavior
    // for existing projects. New effects use the adjustment layer's masks.
    AEFX_CLR_STRUCT(def);
    def.ui_flags = PF_PUI_INVISIBLE;
    PF_ADD_CHECKBOX(STR(StrID_AAEdge_Param_Name), "", FALSE, 0, FGB_AA_EDGE_DISK_ID);

    AEFX_CLR_STRUCT(def);
    def.param_type = PF_Param_LAYER;
    PF_STRNNCPY(def.PF_DEF_NAME, STR(StrID_MaskLayer_Param_Name), sizeof(def.PF_DEF_NAME));
    def.u.ld.dephault = PF_LayerDefault_NONE;
    def.ui_flags = PF_PUI_INVISIBLE;
    def.uu.id = FGB_MASK_LAYER_DISK_ID;
    ERR(PF_ADD_PARAM(in_data, -1, &def));

    out_data->num_params = FGB_NUM_PARAMS;
    return err;
}

// Gray out (disable) the parameters the current mode does not use.
// PF_UpdateParamUI is cosmetic only - it never enters the undo buffer - so it
// is safe to call from PF_Cmd_UPDATE_PARAMS_UI and PF_Cmd_USER_CHANGED_PARAM.
static PF_Err UpdateParameterUI(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[])
{
    PF_Err err = PF_Err_NONE;

    if (params == nullptr || params[FGB_MODE] == nullptr)
    {
        return err;
    }

    const bool progressive = (params[FGB_MODE]->u.pd.value == 2);

    struct UiRule
    {
        PF_ParamIndex index;
        bool disable;
    };

    const UiRule rules[] = {
        {FGB_RADIUS, progressive},         // uniform only
        {FGB_START_RADIUS, !progressive},  // progressive only
        {FGB_END_RADIUS, !progressive},    // progressive only
        {FGB_GRAD_SX, !progressive},       // progressive only
        {FGB_GRAD_SY, !progressive},       // progressive only
        {FGB_GRAD_EX, !progressive},       // progressive only
        {FGB_GRAD_EY, !progressive},       // progressive only
    };

    AEFX_SuiteScoper<PF_ParamUtilsSuite3> paramUtils(in_data, kPFParamUtilsSuite, kPFParamUtilsSuiteVersion3, out_data);

    for (const UiRule& rule : rules)
    {
        PF_ParamDef copy = *params[rule.index]; // the host hands us read-only params
        copy.ui_flags = (copy.ui_flags & ~PF_PUI_DISABLED) | (rule.disable ? PF_PUI_DISABLED : 0);
        ERR(paramUtils->PF_UpdateParamUI(in_data->effect_ref, rule.index, &copy));
    }

    return err;
}

static PF_Err Render(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output)
{
    return renderBlur(in_data, out_data, params, output);
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
                                     /* "Figma background blur" (UTF-8) */
                                     "Figma \xe8\x83\x8c\xe6\x99\xaf\xe6\xa8\xa1\xe7\xb3\x8a",
                                     "F2A Figma Background Blur",
                                     /* "F2A plug-ins" (UTF-8) */
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
            case PF_Cmd_UPDATE_PARAMS_UI:
                err = UpdateParameterUI(in_data, out_data, params);
                break;
            case PF_Cmd_USER_CHANGED_PARAM:
            {
                const PF_UserChangedParamExtra* which_hitP =
                    reinterpret_cast<const PF_UserChangedParamExtra*>(extra);
                if (which_hitP != nullptr)
                {
                    if (which_hitP->param_index == FGB_MODE)
                    {
                        err = UpdateParameterUI(in_data, out_data, params);
                        out_data->out_flags |= PF_OutFlag_REFRESH_UI;
                    }
                }
                break;
            }
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




