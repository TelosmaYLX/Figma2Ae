import json
import os

import numpy as np
from PIL import Image

BASE = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
OUT = os.path.join(BASE, "rea-work", "ae-plugin-test", "out")
FIGMA = os.path.join(BASE, "rea-work", "figma-ab", "figma_original_1x.png")


def load(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.float64)


def region_stats(ae, fig, mask, name):
    d = ae[mask]
    f = fig[mask]
    ad = np.abs(d - f)
    mse = float(np.mean(ad ** 2))
    psnr = float("inf") if mse == 0 else float(10 * np.log10(255.0 ** 2 / mse))
    return {
        "region": name,
        "pixels": int(d.shape[0]),
        "mean_abs_diff": round(float(ad.mean()), 3),
        "max_abs_diff": round(float(ad.max()), 1),
        "pct_gt2": round(float((ad > 2).mean() * 100), 3),
        "pct_gt8": round(float((ad > 8).mean() * 100), 3),
        "psnr": round(psnr, 2) if np.isfinite(psnr) else None,
    }


def analyze_impulse():
    a = load(os.path.join(OUT, "impulse_r8.png"))
    row = a[100, :, 0]
    base = float(np.median(row[:50]))
    prof = row - base
    peak_idx = int(np.argmax(prof))
    peak = float(prof[peak_idx])
    # binarize to find support
    sup = np.where(prof > max(0.3, peak * 0.01))[0]
    support = int(sup[-1] - sup[0] + 1) if len(sup) else 0
    # estimate count from ratio: prof[k]/peak = (C-k)/C for triangle (1px line -> approx center)
    center = (sup[0] + sup[-1]) / 2.0 if len(sup) else peak_idx
    ests = []
    for k in range(1, 20):
        i = int(round(center)) + k
        if i >= len(prof):
            break
        v = prof[i]
        if v <= 0.2:
            break
        ratio = v / peak
        if ratio < 0.999:
            ests.append(k / (1.0 - ratio))
    C = float(np.median(ests)) if ests else float("nan")
    return {"file": "impulse_r8.png", "baseline": round(base, 2), "peak": round(peak, 2),
            "support_px": support, "triangle_count_est": round(C, 2),
            "profile": [round(float(v), 2) for v in prof[peak_idx - 12:peak_idx + 13]]}


def analyze_step():
    a = load(os.path.join(OUT, "step_r40.png"))
    row = a[100, :, 0]
    dark = float(np.median(row[:100]))
    white = float(np.median(row[320:]))
    norm = (row - dark) / max(1.0, (white - dark))
    # edge at x=250; triangle CDF: value(x) = 1/2 + f((x-250)/C) where C = count
    ests = []
    for x in range(210, 291):
        v = norm[x]
        # invert triangle CDF for C
        for C in np.arange(5.0, 80.0, 0.05):
            t = (x + 0.5 - 250.0) / C
            if t <= -1.0:
                cdf = 0.0
            elif t < 0.0:
                cdf = 0.5 * (t + 1.0) ** 2
            elif t < 1.0:
                cdf = 0.5 - 0.5 * t * (t - 2.0)
            else:
                cdf = 1.0
            if abs(cdf - v) < 0.004:
                ests.append(C)
                break
    C = float(np.median(ests)) if ests else float("nan")
    return {"file": "step_r40.png", "dark": round(dark, 2), "white": round(white, 2),
            "triangle_count_est": round(C, 2),
            "profile_220_280": [round(float(v), 3) for v in norm[220:281:5]]}


def main():
    report = {}
    report["impulse_r8"] = analyze_impulse()
    report["step_r40"] = analyze_step()

    fig = load(FIGMA)
    h, w = fig.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    card = (xx >= 320) & (xx < 880) & (yy >= 230) & (yy < 570)
    card_inner = (xx >= 360) & (xx < 840) & (yy >= 270) & (yy < 530)
    card_band = card & ~card_inner
    control = (xx >= 900) & (xx < 1120) & (yy >= 640) & (yy < 760)
    outside = ~card & ~control
    red_zone = (xx >= 325) & (xx < 425) & (yy >= 325) & (yy < 425)

    report["variants"] = {}
    for name in ["AB_R40_HARD", "AB_R39_HARD", "AB_R385_HARD", "AB_R40_SOFT"]:
        path = os.path.join(OUT, name + ".png")
        if not os.path.exists(path):
            continue
        ae = load(path)
        report["variants"][name] = {
            "ALL": region_stats(ae, fig, np.ones((h, w), bool), "ALL"),
            "outside": region_stats(ae, fig, outside, "outside"),
            "card_inner": region_stats(ae, fig, card_inner, "card_inner"),
            "card_band": region_stats(ae, fig, card_band, "card_band"),
            "control": region_stats(ae, fig, control, "control"),
            "red_zone": region_stats(ae, fig, red_zone, "red_zone"),
        }
        # red clamp check
        inside = ae[red_zone]
        report["variants"][name]["redness_inside_card_near_red"] = {
            "mean_R_minus_G": round(float((inside[..., 0] - inside[..., 1]).mean()), 2),
            "mean_R": round(float(inside[..., 0].mean()), 2),
        }

    # moving comp frames
    for name in ["AB_MOVE_t0.png", "AB_MOVE_t2p5.png"]:
        path = os.path.join(OUT, name)
        if os.path.exists(path):
            ae = load(path)
            # card center at t0: 600; at t2.5: 600 + (820-600)*2.5/3 = 783.3
            report[name] = {
                "size": [ae.shape[1], ae.shape[0]],
                "mean_luma": round(float(ae.mean()), 2),
                "sample_card_center_luma": round(float(ae[400, int(600 if "t0" in name else 783):int(601 if "t0" in name else 784), :].mean()), 2),
            }

    print(json.dumps(report, indent=2, ensure_ascii=False))
    with open(os.path.join(BASE, "rea-work", "ae-plugin-test", "plugin_metrics.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
