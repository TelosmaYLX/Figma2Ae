# AE plug-ins for Figma fidelity

Two After Effects effects that reproduce Figma's own renderer:

| Plug-in | What it does | Source, binary and docs |
|---|---|---|
| `Figma 背景模糊` (`FigmaBackgroundBlur`) | Figma's background-blur algorithm (uniform triangular kernel, progressive count ramp), applied on an adjustment layer whose mask (or Alpha source) defines the node's fill silhouette | `FigmaBackgroundBlurPlugin/` |
| `Figma 调色` (`FigmaImageGrade`) | Figma's seven image-fill filters (exposure, contrast, saturation, temperature, tint, highlights, shadows) at Figma's exact control scale | `FigmaImageGradePlugin/` |

Both are x64 `.aex` plug-ins built with the After Effects SDK 27, support multi-frame
rendering, use Chinese UI names, and are validated against Figma's own PNG exports
(see each plug-in's `fidelity_metrics.json`).

## Figma 调色 in the F2A export

`FigmaImageGrade.aex` is the default path for **保留图片调色属性**:

1. The Figma → AE import and the direct AEP writer put `Figma 调色` on the image
   element's **outer precomp layer** (the same-named minimal precomp created by
   「单图层嵌套预合成」) and restore Figma's seven values, instead of building the
   LUT grade composition graph.
2. Installing or pulling an F2A update already copies `FigmaImageGrade.aex` into
   `…/Adobe After Effects <version>/Support Files/Plug-ins/F2A/` for every AE CC 2019+
   install (`scripts/install-ae-plugins.ps1`). If the plug-in is still missing — for
   example the AE folder is read-only — the panel retries the copy on first use.
   After Effects only loads new plug-ins on start, so the panel tells the user to
   restart AE and uses the LUT fallback for the running session.
3. The effect only uses long-standing effect APIs and was verified in **AE CC 2019
   (16.1.3)** as well as AE 2026, so every AE release F2A exports for (2024–2026)
   loads it. Only when the copy fails (read-only install, missing AE, …) does the
   export fall back to the embedded LUT grade ("图片调色" compositions); AEP targets
   older than CC 2019 — which F2A never writes — also stay on LUT.

The packaged Windows build ships the binary at `ae-plugins/FigmaImageGrade.aex`;
`scripts/aep/figma_grade.py` carries the serialized effect definition used by the
direct AEP writer.

## Figma 背景模糊 in the F2A export

`FigmaBackgroundBlur.aex` is the default path for **保留背景模糊**:

1. The Figma → AE import and the direct AEP writer replace the baked Figma PNG with a
   **same-size adjustment layer**: a mask built from the source layer's fill path, the
   `Figma 背景模糊` effect restoring Figma's uniform radius or progressive start/end
   radii and offsets, placed directly under the source layer and parented to it so the
   blurred region follows every transform. The full data contract is
   `scripts/aep/background-blur-export.md`.
2. Install/update copies `FigmaBackgroundBlur.aex` next to `FigmaImageGrade.aex` into
   `…/Support Files/Plug-ins/F2A/` (AE CC 2019+). The live import probes the running
   host before exporting; when the effect is not loaded the panel retries the copy,
   tells the user to restart AE and bakes the blurred layers as PNG for this session.
   The offline AEP writer always embeds the effect, so opening that project needs the
   plug-in installed (the packaged build ships it and the installer copies it).
3. Nodes without a visible fill, with a holed silhouette, a sheared/flipped matrix or
   another effect that still forces rasterisation keep the old PNG path.

The packaged Windows build ships the binary at `ae-plugins/FigmaBackgroundBlur.aex`;
`scripts/aep/figma_blur.py` + `scripts/aep/figma-background-blur-effect.bin` carry the
serialized effect definition used by the direct AEP writer.

## Layout

```
ae-plugin/
  README.md                      this file
  FigmaBackgroundBlurPlugin/     .aex, src/, tools/, metrics, README
  FigmaImageGradePlugin/         .aex, src/, tools/, metrics, README, user_pick/*.json
  tests/                         build hooks, validation and benchmark tooling
  sdk/                           local copy of the AE SDK - NOT committed
  build/                         MSBuild output - NOT committed
```

The repository keeps **sources, build/validation scripts, docs, metric JSON and the
compiled `.aex` plug-ins**. Demo `.aep` / `.mp4` files and the PNG comparison renders
are validation artifacts: they are not distributed with the repo and can be
regenerated with the scripts in `tests/` (see `build_demo*.jsx`,
`render_demo_frames.jsx`, `build_grade_demo.jsx`, `check_*.py`). Each plug-in
README records the binary size / SHA256 it was built from, so a rebuild can be
verified against the shipped file.

To build, copy the sources over the SDK template:

```powershell
# 1. copy the SDK into the workspace (it is not committed)
#    the user keeps it at D:\AfterEffectsSDK_27.0_win
robocopy D:\AfterEffectsSDK_27.0_win ae-plugin\sdk\AfterEffectsSDK_27.0_win /E

# 2. copy the plug-in source into the SDK template folder
$tpl = "ae-plugin\sdk\AfterEffectsSDK_27.0_win\Examples\Template"
Copy-Item ae-plugin\FigmaImageGradePlugin\src\* "$tpl\FigmaImageGrade\" -Recurse -Force
Copy-Item ae-plugin\FigmaBackgroundBlurPlugin\src\* "$tpl\FigmaBackgroundBlur\" -Recurse -Force

# 3. build with MSBuild (VsDevCmd for x64), then patch the localized PiPL strings
#    see tests\patch_pipl_name_grade.py / tests\patch_pipl_name.py and the
#    "构建" section of each plug-in README
```

## Tooling (`tests/`)

* `grade_cli.cpp` - standalone harness for the grade kernel: stdin pixel pipe,
  `--bench8 / --bench16 / --bench32` throughput benchmarks, `--check-simd*` and
  `--check-math` bit-exactness checks against the scalar reference.
* `check_grade*.py` - compare AE renders with the NumPy reference implementation of
  Figma's shader and with Figma's real PNG exports.
* `bench_*.jsx` / `probe_*.jsx` - in-AE benchmarks and structural probes.
* `patch_pipl_name*.py` - post-build GBK patch of the localized PiPL name/category
  (the compiler cannot emit GBK string literals).
* `extract_figma_grade_effect.py` - dump the `Figma 调色` effect definition from a
  saved AEP into `scripts/aep/figma-image-grade-effect.bin` (the direct AEP writer
  uses it to add the effect without AE).

The `.aex`, `.obj`, `__pycache__` and local SDK copies are ignored by git; the
renders used for validation live outside the repository.
