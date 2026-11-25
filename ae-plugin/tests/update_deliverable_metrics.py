import json
import os

DELIV = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\deliverables\FigmaBackgroundBlurPlugin"
p = os.path.join(DELIV, "fidelity_metrics.json")
with open(p, encoding="utf-8") as f:
    m = json.load(f)

m["demo_video"] = {
    "file": "FigmaBackgroundBlurPlugin_Demo.mp4",
    "comp": "DEMO_Realtime_MovingGlassCard",
    "codec": "H.264 (libx264, yuv420p, crf16, faststart)",
    "size": "1200x800",
    "fps": 30,
    "frames": 150,
    "duration_s": 5.0,
    "file_bytes": 211923,
    "source": "150 帧由 AE 通过 CompItem.saveFrameToPng() 逐帧渲染（插件逐帧重算），再由 ffmpeg 编码",
    "render_span_s": 13.44,
    "render_ms_per_frame_approx": 90,
    "note": "150 帧 PNG 写盘总跨度约 13.4 s（≈11 fps @1200x800，含 AE 整场景合成与 PNG 写盘）；"
            "效果本身为逐帧计算，播放/拖时间轴时模糊随形状与背景实时更新。",
}

m["provenance"] = {
    "figma_ab_scene": "Figma 文件（车牌-甲壳虫1124）页面 'AE_背景模糊对照'，画框 505:1200 'BGBlur_AB_1200x800'（保留未删除）",
    "figma_export": "1200x800 PNG，背景模糊 radius=40",
    "ae_project": "FigmaBackgroundBlurPlugin_Demo.aep（01_Demo / 02_Reference / 03_Compare / 04_Calibration）",
    "plugin_source": "src/（FigmaBackgroundBlur.cpp/.h/_Strings/PiPL.r/Win vcxproj）",
    "sdk": "After Effects SDK 27.0 (Windows)，工作区内副本 ae-plugin/sdk/AfterEffectsSDK_27.0_win",
}

with open(p, "w", encoding="utf-8") as f:
    json.dump(m, f, indent=2, ensure_ascii=False)
print("updated", p)
print(json.dumps(m["demo_video"], ensure_ascii=False, indent=2))
