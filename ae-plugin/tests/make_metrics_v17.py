"""Write fidelity_metrics.json + the progressive difference image for v1.7."""

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
        "version": "1.7.0",
        "binary": "FigmaBackgroundBlur.aex",
        "binary_bytes": os.path.getsize(aex),
        "binary_sha256": sha256(aex),
        "pipl_version": 753665,
        "built_with": "After Effects SDK 27.0 (Windows) + MSVC 19.44 (v143) + MSBuild (x64)",
        "host_tested": "After Effects 2026 (26.0x67), Windows x64, 8 bpc, zh_CN UI",
        "mfr": "PF_OutFlag2_SUPPORTS_THREADED_RENDERING (0x08000000) declared in PiPL (AE_Effect_Global_OutFlags_2) and in PF_Cmd_GLOBAL_SETUP",
    },
    "parameters_zh": [
        "模式 (均匀/渐变)",
        "背景模糊半径 (px)",
        "开始半径 (px)",
        "结束半径 (px)",
        "渐变起点 X (%)",
        "渐变起点 Y (%)",
        "渐变终点 X (%)",
        "渐变终点 Y (%)",
        "柔化边缘 (AA)",
        "Alpha源 (可选)",
    ],
    "region_models": {
        "host_mask": "Alpha源 = 无：模糊区域 = 调整层自己的遮罩（AE 用图层 alpha 裁剪效果输出）。插件通过 AEGP 查询遮罩包围盒（AEGP_GetLayerMaskedBounds，图层空间）× layer-to-world 矩阵得到 comp 空间包围盒，作为 Figma 的 clamp 矩形。遮罩可动画、可加羽化，调整层可直接父级到形状层，区域自动跟随。",
        "alpha_source": "Alpha源 = 某图层：用该图层的 alpha 轮廓作区域（逐像素轮廓，支持任意形状/带洞/文字），与其 alpha 包围盒作 clamp。适合无法用遮罩表达的区域。",
        "clamp": "两种模式都按 Figma 语义把三角核采样限制在包围盒内并重归一化（因此卡片边缘不会吸进外面的颜色）。",
    },
    "ramp_model": {
        "units": "渐变起点/终点 = 模糊区域包围盒的百分比（0–100），对应 Figma 的 blurStartOffset/blurEndOffset（0–1 归一化）",
        "follow": "百分比相对包围盒，所以区域（遮罩/Alpha源 的位移动画、缩放）怎么动，渐变都自动跟随，无需给效果参数打关键帧",
        "default": "起点 (50%, 0%) -> 终点 (50%, 100%)，即包围盒上中 -> 下中（Figma 默认竖直渐变）",
        "note": "AE 的点参数是图层绝对坐标，无法既所见即所得又相对跟随（实测：移动调整层 120/80 px，渲染逐像素不变），所以渐变采用百分比数值而不是可拖点手柄",
    },
    "ui_behavior": {
        "uniform_mode": "只用 背景模糊半径；开始半径/结束半径/渐变四个百分比 通过 PF_PUI_DISABLED 置灰（PF_Cmd_UPDATE_PARAMS_UI + PF_UpdateParamUI，界面性变更，不进撤销栈）",
        "progressive_mode": "只用 开始半径/结束半径/渐变百分比；背景模糊半径 置灰",
    },
    "algorithm": {
        "uniform": "separable triangular (Bartlett) kernel, w(k)=max(0,R-|k|), clamped to the region bounding box and renormalized",
        "progressive": "Figma's GRADIENT_BLUR + UPSAMPLE_AND_BLEND path: per-pixel count = startRadius + (endRadius-startRadius)*t, "
        "t = projection of the pixel onto the ramp segment (percent of the region bounds), separable x/y passes, clamp renormalization, "
        "and blend with the sharp source (w_blur = 4*(b^2-1)^2, w_sharp = b^2, b<1 -> pure sharp); count capped at 64 like Figma",
        "region": "host layer masks (AE clips) or the optional Alpha源 layer's alpha channel",
        "performance": "O(1)/pixel prefix-sum evaluation for both modes",
    },
    "progressive_vs_figma": {
        "figma_source": "Figma frame 505:1200 'BGBlur_AB_1200x800', card node 505:1207 effect: "
        "BACKGROUND_BLUR radius 40, blurType PROGRESSIVE, startRadius 0, startOffset (0.5,0), endOffset (0.5,1)",
        "figma_export": "figma_progressive_reference.png (1200x800 @1x)",
        "ae_render": "demo_stills/AB_vs_Figma_AE_render.png (comp AB_PROG, host-mask region)",
        "regions": prog_stats,
        "diff_image_x8": os.path.basename(diff_path),
    },
    "uniform_vs_figma": {
        "reference": "figma_original.png (uniform R=40)",
        "ae_render": "demo_stills/AB_vs_Figma_AE_render_uniform.png (comp AB_UNI, host-mask region)",
        "regions": uni_stats,
    },
    "demo": {
        "project": os.path.basename(aep),
        "comps": [
            "REF_Figma_Progressive (Figma 导出参考)",
            "AB_PROG (渐变模式 A/B 渲染 - 指标来源)",
            "AB_UNI (均匀模式 A/B 渲染)",
            "DEMO_Progressive (移动卡片：调整层遮罩 + 父级，效果参数零关键帧)",
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
        "render_note": "150 帧实测于同一渲染路径（AE saveFrameToPng 逐帧）；O(1)/像素前缀和算法，单帧成本与半径无关",
    },
    "provenance": {
        "figma_file": "车牌-甲壳虫1124, page 'AE_背景模糊对照'",
        "figma_nodes": "frame 505:1200 / card 505:1207 (kept in the Figma file)",
        "sdk": "After Effects SDK 27.0 (Windows), workspace copy ae-plugin/sdk/AfterEffectsSDK_27.0_win",
    },
    "notes": [
        "图层顺序：背景 -> 调整层（本效果） -> 卡片填充/描边层。调整层在卡片下面，AE 用调整层的遮罩裁剪效果输出，与 Figma「先模糊背景，再画填充和描边」的顺序一致。",
        "推荐工作流：画一个与卡片一致的遮罩（圆角矩形）→ 把调整层父级到卡片 → 卡片怎么动，模糊区域和渐变都跟着走（实测 t=2.5s 卡片右移 280px，区域与渐变同时跟随，效果参数零关键帧）。",
        "v1.7 参数顺序变了（渐变点参数改为 4 个百分比），旧工程需重新设置 Alpha源/半径：旧工程打开后 Alpha源 会变成 0（即遮罩模式），按需重选即可。",
        "撤销：插件不调用任何撤销组 API（AEGP_StartUndoGroup 等）；AE 报「撤消组不匹配，将尝试修复」属于宿主撤销栈的自我修复提示。",
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
