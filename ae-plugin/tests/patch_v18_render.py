"""v1.8 performance rewrite of the render core:

- load the backdrop once, no unused alpha plane, no full-frame Cgrid for uniform
- vertical pass processed in 16-column blocks (contiguous access) instead of
  column-strided, and the final blend/composite fused into the write-back
  (removes a whole full-frame pass and three intermediate planes)

The numeric path is unchanged: the same processLineVar()/processLine() calls with
the same per-pixel kernel counts, so the output should stay bit-identical.
"""

PATH = "sdk/AfterEffectsSDK_27.0_win/Examples/Template/FigmaBackgroundBlur/FigmaBackgroundBlur.cpp"

NEW_BLOCK = r'''        const size_t area = static_cast<size_t>(rw) * static_cast<size_t>(rh);
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
        prof.mark();

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
        prof.mark();

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
        prof.mark();

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
        prof.mark();
'''

src = open(PATH, encoding="utf-8").read()

start_anchor = "        const size_t area = static_cast<size_t>(rw) * static_cast<size_t>(rh);"
i0 = src.index(start_anchor)

end_anchor = "        if (shapeCheckedOut)"
i1 = src.index(end_anchor)
# keep the last prof.mark() before the checkin
j = src.rindex("        prof.mark();", i0, i1)
new_src = src[:i0] + NEW_BLOCK + "\n" + src[i1:]

# rewrite the profiling log line (6 intervals: copy/region/ramp/load/h/v+comp)
old_log = '''                // copy region alloc+ramp load hpass vpass composite
                std::fprintf(fp,
                             "%.2f %.2f %.2f %.2f %.2f %.2f %.2f %.2f\\n",
                             prof.us(0, 1),
                             prof.us(1, 2),
                             prof.us(2, 3),
                             prof.us(3, 4),
                             prof.us(4, 5),
                             prof.us(5, 6),
                             prof.us(6, 7),
                             prof.us(7, 8));'''
new_log = '''                // copy region ramp load hpass vpass+composite
                std::fprintf(fp,
                             "%.2f %.2f %.2f %.2f %.2f %.2f\\n",
                             prof.us(0, 1),
                             prof.us(1, 2),
                             prof.us(2, 3),
                             prof.us(3, 4),
                             prof.us(4, 5),
                             prof.us(5, 6));'''
if old_log in new_src:
    new_src = new_src.replace(old_log, new_log)
else:
    print("WARNING: log block not found, leaving as is")

open(PATH, "w", encoding="utf-8", newline="\n").write(new_src)
print("patched, size", len(new_src), "marks", new_src.count("prof.mark()"))
