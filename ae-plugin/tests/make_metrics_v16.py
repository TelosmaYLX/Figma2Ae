"""Write fidelity_metrics.json + the progressive difference image for v1.6."""

import hashlib
import json
import os
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
DELIV = os.path.join(BASE, "deliverables", "FigmaBackgroundBlurPlugin")


def load(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.float64)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def regions(ae, fig):
    h, w = fig.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    card = (xx >= 320) & (xx < 880) & (yy >= 230) & (yy < 570)
    inner = (xx >= 360) & (xx < 840) & (yy >= 270) & (yy < 530)
    band = card & ~inner
    ctrl = (xx >= 900) & (xx < 1120) & (yy >= 640) & (yy < 760)
    outside = ~card & ~ctrl
    out = {}
    for name, mask in (
        ("ALL", np.ones((h, w), bool)),
        ("card_inner", inner),
        ("card_band", band),
        ("control", ctrl),
        ("outside", outside),
    ):
        d = np.abs(ae[mask] - fig[mask])
        mse = float((d**2).mean())
        out[name] = {
            "pixels": int(mask.sum()),
            "mean_abs_diff": round(float(d.mean()), 3),
            "max_abs_diff": round(float(d.max()), 1),
            "psnr": round(float(10 * np.log10(255.0**2 / mse)), 2) if mse > 0 else None,
        }
    return out


aex = os.path.join(DELIV, "FigmaBackgroundBlur.aex")
aep = os.path.join(DELIV, "FigmaBackgroundBlurPlugin_Demo.aep")
mp4 = os.path.join(DELIV, "FigmaBackgroundBlurPlugin_Demo.mp4")

fig_prog = load(os.path.join(DELIV, "figma_progressive_reference.png"))
ae_prog = load(os.path.join(DELIV, "demo_stills", "AB_vs_Figma_AE_render.png"))
fig_uni = load(os.path.join(DELIV, "figma_original.png"))
ae_uni = load(os.path.join(DELIV, "demo_stills", "AB_vs_Figma_AE_render_uniform.png"))

prog_stats = regions(ae_prog, fig_prog)
uni_stats = regions(ae_uni, fig_uni)

diff = np.abs(ae_prog - fig_prog).mean(axis=2)
diff_path = os.path.join(DELIV, "AE_plugin_vs_Figma_progressive_diff_x8.png")
Image.fromarray(np.clip(diff * 8, 0, 255).astype(np.uint8)).save(diff_path)

out = {
    "plugin": {
        "name_zh": "Figma 背景模糊",
        "match_name": "F2A Figma Background Blur",
        "category_zh": "F2A 插件",
        "version": "1.6.0",
        "binary": "FigmaBackgroundBlur.aex",
        "binary_bytes": os.path.getsize(aex),
        "binary_sha256": sha256(aex),
        "pipl_version": 720897,
        "built_with": "After Effects SDK 27.0 (Windows) + MSVC 19.44 (v143) + MSBuild (x64)",
        "host_tested": "After Effects 2026 (26.0x67), Windows x64, 8 bpc, zh_CN UI",
        "mfr": "PF_OutFlag2_SUPPORTS_THREADED_RENDERING (0x08000000) declared in PiPL (AE_Effect_Global_OutFlags_2) and in PF_Cmd_GLOBAL_SETUP",
    },
    "parameters_zh": [
        "模式 (均匀/渐变)",
        "背景模糊半径 (px)",
        "开始半径 (px)",
        "结束半径 (px)",
        "渐变起点 (px)",
        "渐变终点 (px)",
        "柔化边缘 (AA)",
        "Alpha源",
    ],
    "ui_behavior": {
        "uniform_mode": "只用 背景模糊半径；开始半径/结束半径/渐变起点/渐变终点 通过 PF_PUI_DISABLED 置灰（PF_Cmd_UPDATE_PARAMS_UI + PF_UpdateParamUI，界面性变更，不进撤销栈）",
        "progressive_mode": "只用 开始半径/结束半径/渐变起点/渐变终点；背景模糊半径 置灰",
        "ramp_units": "渐变起点/终点 = 效果图层空间的像素坐标（AE 点控件的坐标系），与图层预览中的两个控制点一一对应",
        "ramp_default": "默认值 = 穿过效果图层中间的竖线 (宽/2, 0) -> (宽/2, 高)",
        "ramp_auto_place": "当渐变线仍是默认值（或旧版 0–1 值）时，选择 Alpha源 或切到渐变模式会把两个控制点自动落到 Alpha源 轮廓包围盒的上中/下中，之后不再自动改（PF_ChangeFlag_CHANGED_VALUE，与触发它的操作同撤销组）",
    },
    "algorithm": {
        "uniform": "separable triangular (Bartlett) kernel, w(k)=max(0,R-|k|), clamped to the Alpha源 alpha bbox and renormalized",
        "progressive": "Figma's GRADIENT_BLUR + UPSAMPLE_AND_BLEND path: per-pixel count = startRadius + (endRadius-startRadius)*t, "
        "t = projection of the pixel onto the ramp segment, separable x/y passes, clamp renormalization, and blend with the sharp source "
        "(w_blur = 4*(b^2-1)^2, w_sharp = b^2, b<1 -> pure sharp); count capped at 64 like Figma",
        "region": "Alpha源 layer's alpha channel (silhouette decides where the blurred backdrop is composited)",
        "performance": "O(1)/pixel prefix-sum evaluation for both modes",
    },
    "progressive_vs_figma": {
        "figma_source": "Figma frame 505:1200 'BGBlur_AB_1200x800', card node 505:1207 effect: "
        "BACKGROUND_BLUR radius 40, blurType PROGRESSIVE, startRadius 0, startOffset (0.5,0), endOffset (0.5,1)",
        "figma_export": "figma_progressive_reference.png (1200x800 @1x)",
        "ae_render": "demo_stills/AB_vs_Figma_AE_render.png (comp AB_PROG)",
        "regions": prog_stats,
        "diff_image_x8": os.path.basename(diff_path),
    },
    "uniform_vs_figma": {
        "reference": "figma_original.png (uniform R=40)",
        "ae_render": "demo_stills/AB_vs_Figma_AE_render_uniform.png (comp AB_UNI)",
        "regions": uni_stats,
    },
    "demo": {
        "project": os.path.basename(aep),
        "comps": [
            "REF_Figma_Progressive (Figma 导出参考)",
            "AB_PROG (渐变模式 A/B 渲染)",
            "AB_UNI (均匀模式 A/B 渲染)",
            "DEMO_Progressive (移动卡片实时渐变模糊 / 渐变控制点跟随关键帧)",
            "DEMO_Uniform (均匀模式，展示参数置灰)",
            "CMP_Progressive (Figma | 插件 并排对照)",
        ],
        "movie": os.path.basename(mp4),
        "movie_comp": "DEMO_Progressive",
        "frames": 150,
        "fps": 30,
        "duration_s": 5.0,
        "movie_bytes": os.path.getsize(mp4),
        "render_span_s": 7.29,
        "ms_per_frame_approx": 49,
        "render_note": "150 帧渲染耗时实测于同一渲染路径（AE saveFrameToPng 逐帧）；O(1)/像素前缀和算法，单帧成本与半径无关",
    },
    "provenance": {
        "figma_file": "车牌-甲壳虫1124, page 'AE_背景模糊对照'",
        "figma_nodes": "frame 505:1200 / card 505:1207 (kept in the Figma file)",
        "sdk": "After Effects SDK 27.0 (Windows), workspace copy ae-plugin/sdk/AfterEffectsSDK_27.0_win",
        "screenshots": "demo_stills/EC_params_uniform_mode.png, EC_params_progressive_mode.png (参数置灰效果)",
    },
    "notes": [
        "图层顺序：背景 -> 调整层（本效果） -> 卡片填充/描边层；Alpha源 选卡片填充层。这与 Figma 的绘制顺序一致（先模糊背景，再画半透明填充和描边）。",
        "渐变模式的渐变线现在是图层像素坐标，可直接在合成窗口里拖动两个控制点；旧工程里的 0–1 归一化值会被识别为默认值并自动换算。",
        "参数可用性随模式切换实时更新（置灰），切换本身不会产生额外撤销步骤。",
        "撤销：插件不调用任何撤销组 API（AEGP_StartUndoGroup 等）；AE 的『撤消组不匹配，将尝试修复』属于宿主撤销栈内部提示。",
    ],
}

with open(os.path.join(DELIV, "fidelity_metrics.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)

print(
    json.dumps(
        {
            "sha": out["plugin"]["binary_sha256"],
            "bytes": out["plugin"]["binary_bytes"],
            "progressive": prog_stats,
            "uniform": uni_stats,
        },
        indent=2,
        ensure_ascii=False,
    )
)
