"""Insert temporary per-stage profiling marks into renderBlur (FGB_PROFILE_LOG)."""

import sys

PATH = (
    "sdk/AfterEffectsSDK_27.0_win/Examples/Template/FigmaBackgroundBlur/FigmaBackgroundBlur.cpp"
)

src = open(PATH, encoding="utf-8").read()

subs = [
    (
        """        PF_Err err = PF_Err_NONE;

        PF_EffectWorld* src = &params[FGB_INPUT]->u.ld;""",
        """        PF_Err err = PF_Err_NONE;
        FgbProfile prof;

        PF_EffectWorld* src = &params[FGB_INPUT]->u.ld;""",
    ),
    (
        """                std::memcpy(d, s, bytes);
            }
        }
""",
        """                std::memcpy(d, s, bytes);
            }
        }
        prof.mark();
""",
    ),
    (
        """        const int rw = static_cast<int>(bx1 - bx0 + 1);
        const int rh = static_cast<int>(by1 - by0 + 1);
""",
        """        const int rw = static_cast<int>(bx1 - bx0 + 1);
        const int rh = static_cast<int>(by1 - by0 + 1);
        prof.mark();
""",
    ),
    (
        """            const float c0 = std::max(0.0f, radius) * dsScale;
            for (size_t i = 0; i < area; ++i) Cgrid[i] = c0;
        }
""",
        """            const float c0 = std::max(0.0f, radius) * dsScale;
            for (size_t i = 0; i < area; ++i) Cgrid[i] = c0;
        }
        prof.mark();
""",
    ),
    (
        """                R[o] = r;
                G[o] = g;
                B[o] = b;
                A[o] = a;
            }
        }
""",
        """                R[o] = r;
                G[o] = g;
                B[o] = b;
                A[o] = a;
            }
        }
        prof.mark();
""",
    ),
    (
        """                processLineVar(&R[off], &G[off], &B[off], &hR[off], &hG[off], &hB[off], rw, &Cgrid[off], 1, Kmax, lb);
            }
        }
""",
        """                processLineVar(&R[off], &G[off], &B[off], &hR[off], &hG[off], &hB[off], rw, &Cgrid[off], 1, Kmax, lb);
            }
        }
        prof.mark();
""",
    ),
    (
        """        if (shapeCheckedOut)
        {
            PF_CHECKIN_PARAM(in_data, &shapeDef);
        }

        return err;""",
        """        prof.mark();
        prof.mark();

        if (shapeCheckedOut)
        {
            PF_CHECKIN_PARAM(in_data, &shapeDef);
        }

        if (const char* log_path = std::getenv("FGB_PROFILE_LOG"))
        {
            FILE* fp = nullptr;
            if (fopen_s(&fp, log_path, "a") == 0 && fp != nullptr)
            {
                // t0 copy region alloc+ramp load hpass vpass composite
                std::fprintf(fp,
                             "%.2f %.2f %.2f %.2f %.2f %.2f %.2f %.2f\\n",
                             prof.us(0, 1),
                             prof.us(1, 2),
                             prof.us(2, 3),
                             prof.us(3, 4),
                             prof.us(4, 5),
                             prof.us(5, 6),
                             prof.us(6, 7),
                             prof.us(7, 8));
                std::fclose(fp);
            }
        }

        return err;""",
    ),
]

for old, new in subs:
    if old not in src:
        raise SystemExit("anchor not found:\n" + old[:120])
    src = src.replace(old, new, 1)

open(PATH, "w", encoding="utf-8", newline="\n").write(src)
print("patched, marks:", src.count("prof.mark()"))
