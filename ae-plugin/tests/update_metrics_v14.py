import json
import os

DELIV = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\deliverables\FigmaBackgroundBlurPlugin"
p = os.path.join(DELIV, "fidelity_metrics.json")
with open(p, encoding="utf-8") as f:
    d = json.load(f)

aex = os.path.join(DELIV, "FigmaBackgroundBlur.aex")
import hashlib


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fp:
        for chunk in iter(lambda: fp.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


d["plugin"]["version"] = "1.4.0"
d["plugin"]["binary_bytes"] = os.path.getsize(aex)
d["plugin"]["binary_sha256"] = sha256(aex)
d["plugin"]["workflow"] = "effect on an adjustment layer; the Alpha源 (layer param) alpha channel defines the blur region"
d["algorithm"]["parameters_zh"] = ["背景模糊半径 (px)", "柔化边缘 (AA)", "Alpha源"]
d["notes"] = [
    "v1.4: 参数“形状图层（Alpha）”更名为“Alpha源”；移除“显示遮罩 (调试)”参数（画面输出与 v1.3 完全一致）。",
    "AE gives adjustment-layer effects the composite below with alpha=1, so the host layer's own mask is not visible to the effect; the Alpha源 layer's alpha drives the region and its bounding box drives the Figma clamp.",
    "Animated masks, track mattes and transforms on the Alpha源 layer all animate the blur region.",
    "Multi-Frame Rendering: PF_OutFlag2_SUPPORTS_THREADED_RENDERING (0x08000000) is set both in the PiPL (AE_Effect_Global_OutFlags_2) and at runtime (PF_Cmd_GLOBAL_SETUP).",
    "Hard edge = Figma-faithful discard; Soft AA blends by coverage.",
    "Figma internally downsamples for radii > 4 texels (~2-4% narrower measured kernel); this plug-in computes the exact kernel.",
]

with open(p, "w", encoding="utf-8") as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print(d["plugin"]["version"], d["plugin"]["binary_bytes"], d["plugin"]["binary_sha256"])
