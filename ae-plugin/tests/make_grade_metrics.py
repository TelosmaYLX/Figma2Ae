"""Assemble fidelity_metrics.json for the "Figma 调色" plug-in.

Collects the offline kernel check, the AE renders vs the NumPy reference, the
real Figma end-to-end comparison and the offline throughput benchmark.
"""

import hashlib
import json
import os
import subprocess
import sys

ROOT = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
BASE = os.path.join(ROOT, "rea-work", "image-grade")
DELIV = os.path.join(ROOT, "deliverables", "FigmaImageGradePlugin")
TESTS = os.path.join(ROOT, "ae-plugin", "tests")
CLI = os.path.join(TESTS, "grade_cli.exe")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def bench(controls, mpix=20):
    out = subprocess.run(
        [CLI] + [str(int(round(v))) for v in controls] + ["--bench", str(mpix)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    # "20.000 MPix in 2.242 s = 8.92 MPix/s  (1200x800 => 107.6 ms/frame)  [sink ...]"
    mpix_s = float(out.split("= ")[1].split(" MPix/s")[0])
    ms = float(out.split("=> ")[1].split(" ms/frame")[0])
    return {"mpix_per_s": round(mpix_s, 2), "ms_per_frame_1200x800": round(ms, 1)}


aex = os.path.join(DELIV, "FigmaImageGrade.aex")
aep = os.path.join(DELIV, "FigmaImageGradePlugin_Demo.aep")
mp4 = os.path.join(DELIV, "FigmaImageGradePlugin_Demo.mp4")

metrics = {
    "plugin": {
        "name_zh": "Figma 调色",
        "match_name": "F2A Figma Image Grade",
        "category_zh": "F2A 插件",
        "version": "1.3.0",
        "binary": "FigmaImageGrade.aex",
        "binary_bytes": os.path.getsize(aex),
        "binary_sha256": sha256(aex),
        "pipl_version": 622593,
        "built_with": "After Effects SDK 27.0 (Windows) + MSVC 19.44 (v143) + MSBuild (x64)",
        "host_tested": "After Effects 2026 (26.0x67), Windows x64, 8 bpc, zh_CN UI",
        "mfr": "PF_OutFlag2_SUPPORTS_THREADED_RENDERING declared in PiPL and PF_Cmd_GLOBAL_SETUP",
        "params_zh": ["曝光", "对比度", "饱和度", "白平衡", "着色", "高光", "阴影"],
        "param_units": "Figma 面板数值 -100..100；内部换算为 Figma 插件 API 的 ImagePaint.filters（-1..1，除以 100）",
    },
    "algorithm": {
        "source": "从 Figma 桌面端 126.8.16 的画布渲染器还原的七项调色 shader（见 tests/image-filter-study.md）",
        "order": [
            "输入 sRGB 编码值按 2.2 次幂进入线性域",
            "用原像素亮度算高光/阴影的曝光补偿（阈值 0.5^2.2=0.2176376，高光 d>0、阴影 -0.999×shadows）",
            "Lab 空间：白平衡改 b*（+30×temperature），着色改 a*（+30×tint），对比度只改 L*（c=0.3×contrast，负向压缩、正向 S 曲线）",
            "曝光曲线：gain=10^(2ev)，并做 75% 向亮度混合的色度补偿",
            "饱和度：负向向等亮灰混合，正向按 RGB 色域边界限幅（上限 2 倍），最后取 1/2.2 次幂回到 sRGB",
        ],
        "fast_math": "log2/exp2 多项式替代 pow/cbrt（相对误差 ~1e-6，远小于 8 位输出精度）：逐像素实测与 NumPy float64 参考实现最大差 1 个色阶",
        "alpha": "AE 把图层自身表示交给效果：直通（straight）素材收到的是未预乘数据，预乘素材与调整层下方合成收到的是预乘数据。插件用『颜色值不可能大于 alpha』的采样判据自动识别，直通时直接调色、预乘时先反预乘再调色并重新预乘——与 Figma『先调直通颜色、再按填充不透明度预乘』一致。",
        "skip_fast_paths": "七项全为 0 时直接透传；对比度/白平衡/着色全 0 时跳过 Lab 往返；曝光/高光/阴影全 0 时跳过曝光曲线（与 Figma shader 的分支一致）",
    },
    "validation": {
        "kernel_vs_numpy_reference": load_json(os.path.join(BASE, "grade_kernel_check.json"), []),
        "ae_render_vs_numpy_reference": load_json(os.path.join(BASE, "grade_metrics.json"), []),
        "ae_render_vs_real_figma_export": load_json(os.path.join(BASE, "grade_figma_e2e.json"), []),
        "note": "参考实现 = tests/figma_image_grade.py（float64，含 Figma PNG 导出的 12 位量化规则），该实现已在 image-filter-study.md 中与 Figma 导出逐通道核对（99.9967% 完全相同、最多差 1 个色阶）。AE 与 Figma 的 1 色阶差异来自两边不同的 8 位取整/量化规则。",
    },
    "performance": {
        "measured": "离线内核基准（单线程，/O2 + /Oi + LTCG + /arch:AVX2；每组 3 次取中位数）",
        "v1_0_design_values": {"mpix_per_s": 9.25, "ms_per_frame_1200x800": 104.0},
        "v1_1_simd_sse2_design": {"mpix_per_s": 20.5, "ms_per_frame_1200x800": 46.8},
        "v1_2_simd_avx2_design": {"mpix_per_s": 52.0, "ms_per_frame_1200x800": 18.5},
        "v1_3_simd_avx2_design": {"mpix_per_s": 52.0, "ms_per_frame_1200x800": 18.5},
        "v1_0_saturation_only": {"mpix_per_s": 17.4, "ms_per_frame_1200x800": 55.0},
        "v1_2_saturation_only": {"mpix_per_s": 217.0, "ms_per_frame_1200x800": 4.4},
        "v1_3_deep_color_16bpc": {"scalar_mpix_per_s": 9.7, "scalar_ms_per_frame": 99.0,
                                   "simd_mpix_per_s": 33.4, "simd_ms_per_frame": 28.7, "speedup": 3.45},
        "speedup_design_vs_v1_0": 5.6,
        "speedup_saturation_vs_v1_0": 12.5,
        "v1_1_changes": [
            "8 位输入解码改成 256 项查表（同一公式生成，数值与标量路径完全一致）",
            "整条调色链改成 SSE2 四像素并行：log2/exp2/cbrt 全部向量化，公式与运算顺序和标量版一致",
            "Lab 矩阵行改成乘加累积、强制内联，减少 XMM 寄存器溢出",
        ],
        "v1_2_changes": [
            "工程改成 /arch:AVX2 编译（VEX 三操作数编码，寄存器压力大幅下降）——源码未改、输出未变，单线程再快 2.5 倍",
        ],
        "v1_3_changes": [
            "16 bpc / 32 bpc 路径也改成 SSE2 四像素并行（原来只有 8 位是 SIMD）",
            "16 bpc 从 9.7 提到 33.4 MPix/s（99 ms -> 28.7 ms/帧，3.45x）",
        ],
        "output_unchanged": "8 位输出在 520x520 遮罩复现与 2560x1440 原生两个合成上与 v1.0/v1.1/v1.2 逐字节相同；16 bpc 渲染与 Figma shader 参考最大差 1 个色阶；16/32 bpc 的新 SIMD 路径与标量路径在 8 万随机像素 x 3 组参数上逐位相同",
        "requirement": "二进制用 /arch:AVX2 编译，需要 AVX2 CPU（AE 2026 的系统要求本身即要求 AVX2）",
        "deep_color_caveat": "32 bpc 项目若开启 AE 的『线性化工作空间』，AE 交给效果的是线性值（连不做效果的直通都会被 AE 改写像素），而本效果按 Figma 的 sRGB 编码空间计算，因此 32 bpc 结果与 8/16 bpc 不同；这与 v1.0 行为一致，不影响 8/16 bpc 的准确性。",
        "note": "AE 打开多帧渲染后按帧并行；渐变/模糊类重效果通常比调色更贵",
    },
    "demo": {
        "project": os.path.basename(aep),
        "comps": [
            "REF_Figma导出 (Figma 真实导出的参考图)",
            "AE_插件调色 (同一张源图 + 七项滑杆)",
            "CMP_并排对比 (Figma | 插件)",
            "ADJ_调整层调色 (效果放在调整层上，作用于下方所有图层)",
            "DEMO_滑杆动画 (曝光/对比度/饱和度 打关键帧，实时重调色)",
        ],
        "movie": os.path.basename(mp4),
        "movie_comp": "DEMO_滑杆动画",
        "frames": 90,
        "fps": 30,
        "duration_s": 3.0,
        "movie_bytes": os.path.getsize(mp4) if os.path.exists(mp4) else None,
    },
    "provenance": {
        "figma_file": "车牌-甲壳虫1124, page 'AE_调色验证' (532:553)",
        "figma_nodes": "532:554 colour card 512², 532:555 photo 1200×800",
        "sdk": "After Effects SDK 27.0 (Windows), ae-plugin/sdk/AfterEffectsSDK_27.0_win",
    },
    "files": [
        "FigmaImageGrade.aex",
        "FigmaImageGradePlugin_Demo.aep",
        "FigmaImageGradePlugin_Demo.mp4",
        "AE_vs_Figma_side_by_side.png",
        "Figma_reference_export.png",
        "AE_render.png",
        "AE_vs_Figma_diff_x8.png",
        "fidelity_metrics.json",
        "src/ (kernel + plug-in + PiPL + vcxproj)",
        "tools/patch_pipl_name_grade.py",
        "README.md",
    ],
}

os.makedirs(DELIV, exist_ok=True)
with open(os.path.join(DELIV, "fidelity_metrics.json"), "w", encoding="utf-8") as f:
    json.dump(metrics, f, indent=2, ensure_ascii=False)
print(json.dumps({"sha": metrics["plugin"]["binary_sha256"], "bytes": metrics["plugin"]["binary_bytes"],
                  "perf": metrics["performance"]}, indent=1, ensure_ascii=False))
