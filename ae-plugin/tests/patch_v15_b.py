import re

BASE = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\ae-plugin\sdk\AfterEffectsSDK_27.0_win\Examples\Template\FigmaBackgroundBlur"
path = BASE + "\\FigmaBackgroundBlur.cpp"
text = open(path, encoding="utf-8").read()


def sub(old, new, count=1):
    global text
    if old not in text:
        raise SystemExit("anchor not found: " + old[:80])
    text = text.replace(old, new, count)


# 1) add the variable-count line processor right after processLine()
sub(
    """            else
            {
                outR[x] = inR[x];
                outG[x] = inG[x];
                outB[x] = inB[x];
            }
        }
    }

} // namespace""",
    """            else
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

} // namespace""",
)

# 2) read the new parameters
sub(
    "        const bool aaEdge = params[FGB_AA_EDGE]->u.bd.value != 0;\n",
    """        const bool aaEdge = params[FGB_AA_EDGE]->u.bd.value != 0;
        const int mode = static_cast<int>(params[FGB_MODE]->u.pd.value); // 1 = uniform, 2 = progressive
        const float startRadius = static_cast<float>(params[FGB_START_RADIUS]->u.fs_d.value);
        const float endRadius = static_cast<float>(params[FGB_END_RADIUS]->u.fs_d.value);
        const float gradStartX = FIX_2_FLOAT(params[FGB_GRAD_START]->u.td.x_value);
        const float gradStartY = FIX_2_FLOAT(params[FGB_GRAD_START]->u.td.y_value);
        const float gradEndX = FIX_2_FLOAT(params[FGB_GRAD_END]->u.td.x_value);
        const float gradEndY = FIX_2_FLOAT(params[FGB_GRAD_END]->u.td.y_value);
        const bool progressive = (mode == 2);
""",
)

# 3) replace the single-count / K computation
old_ds = re.search(
    r"        // Effect input downsampling \(draft previews\)\..*?const int K = static_cast<int>\(std::ceil\(static_cast<double>\(C\)\)\);",
    text,
    re.S,
)
if not old_ds:
    raise SystemExit("downsample block not found")
new_ds = """        // Effect input downsampling (draft previews).
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
        const int Kmax = static_cast<int>(std::ceil(static_cast<double>(CMax)));"""
text = text[: old_ds.start()] + new_ds + text[old_ds.end():]

# 4) per-pixel count grid
sub(
    "        std::vector<float> vR(area), vG(area), vB(area);\n",
    """        std::vector<float> vR(area), vG(area), vB(area);
        std::vector<float> Cgrid(area, 0.0f);

        // Per-pixel kernel count: constant for uniform mode, linearly interpolated
        // between the start/end radius along the gradient segment for progressive mode.
        if (progressive)
        {
            const float sx = static_cast<float>(bx0) + gradStartX * static_cast<float>(rw);
            const float sy = static_cast<float>(by0) + gradStartY * static_cast<float>(rh);
            const float ex = static_cast<float>(bx0) + gradEndX * static_cast<float>(rw);
            const float ey = static_cast<float>(by0) + gradEndY * static_cast<float>(rh);
            const float dx = ex - sx;
            const float dy = ey - sy;
            const float len2 = dx * dx + dy * dy;
            const float countCap = 64.0f * dsScale; // Figma caps the progressive count at 64
            for (int ry = 0; ry < rh; ++ry)
            {
                const float py = static_cast<float>(by0 + ry) + 0.5f;
                for (int rx = 0; rx < rw; ++rx)
                {
                    const float px = static_cast<float>(bx0 + rx) + 0.5f;
                    float t = 0.0f;
                    if (len2 > 1.0e-9f)
                    {
                        t = clampf(((px - sx) * dx + (py - sy) * dy) / len2, 0.0f, 1.0f);
                    }
                    float c = startRadius + (endRadius - startRadius) * t;
                    if (c < 0.0f) c = 0.0f;
                    c *= dsScale;
                    if (c > countCap) c = countCap;
                    Cgrid[static_cast<size_t>(ry) * rw + static_cast<size_t>(rx)] = c;
                }
            }
        }
        else
        {
            const float c0 = std::max(0.0f, radius) * dsScale;
            for (size_t i = 0; i < area; ++i) Cgrid[i] = c0;
        }
""",
)

# 5) passes
sub(
    "                processLine(&R[off], &G[off], &B[off], &hR[off], &hG[off], &hB[off], rw, C, K, lb);",
    "                processLineVar(&R[off], &G[off], &B[off], &hR[off], &hG[off], &hB[off], rw, &Cgrid[off], 1, Kmax, lb);",
)
sub(
    "                processLine(lb.inR.data(), lb.inG.data(), lb.inB.data(), lb.oR.data(), lb.oG.data(), lb.oB.data(), rh, C, K, lb);",
    "                processLineVar(lb.inR.data(), lb.inG.data(), lb.inB.data(), lb.oR.data(), lb.oG.data(), lb.oB.data(), rh, &Cgrid[static_cast<size_t>(rx)], rw, Kmax, lb);",
)

# 6) composite: progressive blend with the sharp source
sub(
    """                float outR = R[o], outG = G[o], outB = B[o];
                if (cover > 0.0f)
                {
                    if (aaEdge)
                    {
                        outR = outR + (vR[o] - outR) * cover;
                        outG = outG + (vG[o] - outG) * cover;
                        outB = outB + (vB[o] - outB) * cover;
                    }
                    else
                    {
                        outR = vR[o];
                        outG = vG[o];
                        outB = vB[o];
                    }
                }""",
    """                // Blurred colour. Progressive mode blends towards the sharp source
                // at the low-radius end, using Figma's upscale/blend weights
                // (w_blur = 4*(b^2-1)^2, w_sharp = b^2; pure sharp when b < 1).
                float blurR = vR[o], blurG = vG[o], blurB = vB[o];
                if (progressive)
                {
                    const float b = Cgrid[o];
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
                        blurR = (wBlur * vR[o] + wSharp * R[o]) * inv;
                        blurG = (wBlur * vG[o] + wSharp * G[o]) * inv;
                        blurB = (wBlur * vB[o] + wSharp * B[o]) * inv;
                    }
                }

                float outR = R[o], outG = G[o], outB = B[o];
                if (cover > 0.0f)
                {
                    if (aaEdge)
                    {
                        outR = outR + (blurR - outR) * cover;
                        outG = outG + (blurG - outG) * cover;
                        outB = outB + (blurB - outB) * cover;
                    }
                    else
                    {
                        outR = blurR;
                        outG = blurG;
                        outB = blurB;
                    }
                }""",
)

# 7) ParamsSetup
old_ps = re.search(r"static PF_Err ParamsSetup\(PF_InData\* in_data.*?\n\}", text, re.S)
if not old_ps:
    raise SystemExit("ParamsSetup not found")
new_ps = """static PF_Err ParamsSetup(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output)
{
    PF_Err err = PF_Err_NONE;
    PF_ParamDef def;

    AEFX_CLR_STRUCT(def);
    PF_ADD_POPUP(STR(StrID_Mode_Param_Name), 2, 1, STR(StrID_Mode_Choices), FGB_MODE_DISK_ID);

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

    AEFX_CLR_STRUCT(def);
    PF_ADD_POINT(STR(StrID_GradStart_Param_Name), 0.5, 0.0, FALSE, FGB_GRAD_START_DISK_ID);

    AEFX_CLR_STRUCT(def);
    PF_ADD_POINT(STR(StrID_GradEnd_Param_Name), 0.5, 1.0, FALSE, FGB_GRAD_END_DISK_ID);

    AEFX_CLR_STRUCT(def);
    PF_ADD_CHECKBOXX(STR(StrID_AAEdge_Param_Name), FALSE, 0, FGB_AA_EDGE_DISK_ID);

    AEFX_CLR_STRUCT(def);
    PF_ADD_LAYER(STR(StrID_MaskLayer_Param_Name), PF_LayerDefault_NONE, FGB_MASK_LAYER_DISK_ID);

    out_data->num_params = FGB_NUM_PARAMS;
    return err;
}"""
text = text[: old_ps.start()] + new_ps + text[old_ps.end():]

open(path, "w", encoding="utf-8", newline="\n").write(text)
print("cpp patched, lines:", text.count("\n"))
