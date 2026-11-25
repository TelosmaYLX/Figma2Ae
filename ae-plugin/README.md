# AE plug-ins for Figma fidelity

Two After Effects effects that reproduce Figma's own renderer:

| Plug-in | What it does | Deliverable |
|---|---|---|
| `Figma 背景模糊` (`FigmaBackgroundBlur`) | Figma's background-blur algorithm (uniform triangular kernel, progressive count ramp), applied to the layer below via an adjustment layer bound to a shape layer | `deliverables/FigmaBackgroundBlurPlugin/` |
| `Figma 调色` (`FigmaImageGrade`) | Figma's seven image-fill filters (exposure, contrast, saturation, temperature, tint, highlights, shadows) at Figma's exact control scale | `deliverables/FigmaImageGradePlugin/` |

Both are x64 `.aex` plug-ins built with the After Effects SDK 27, support multi-frame
rendering, use Chinese UI names, and are validated against Figma's own PNG exports
(see each deliverable's `fidelity_metrics.json`).

## Layout

```
ae-plugin/
  README.md          this file
  tests/             build hooks, validation and benchmark tooling
  sdk/               local copy of the AE SDK - NOT committed (see below)
  build/             MSBuild output - NOT committed
deliverables/
  FigmaBackgroundBlurPlugin/   FigmaBackgroundBlur.aex, src/, tools/, build.ps1, metrics, README
  FigmaImageGradePlugin/       FigmaImageGrade.aex, src/, tools/, metrics, README, user_pick/*.json
  FigmaVsAE/                   fidelity_metrics.json (first blur study, numbers only)
```

The repository keeps **sources, build/validation scripts, docs, metric JSON and the
compiled `.aex` plug-ins**. Demo `.aep` / `.mp4` files and the PNG comparison renders
are validation artifacts: they are not distributed with the repo and can be
regenerated with the scripts in `tests/` (see `build_demo*.jsx`,
`render_demo_frames.jsx`, `build_grade_demo.jsx`, `check_*.py`). Each deliverable
README records the binary size / SHA256 it was built from, so a rebuild can be
verified against the shipped file.

The plug-in sources live in each deliverable's `src/` folder - that is the copy to
keep. To build, copy them over the SDK template:

```powershell
# 1. copy the SDK into the workspace (it is not committed)
#    the user keeps it at D:\AfterEffectsSDK_27.0_win
robocopy D:\AfterEffectsSDK_27.0_win ae-plugin\sdk\AfterEffectsSDK_27.0_win /E

# 2. copy the plug-in source into the SDK template folder
$tpl = "ae-plugin\sdk\AfterEffectsSDK_27.0_win\Examples\Template"
Copy-Item deliverables\FigmaImageGradePlugin\src\* "$tpl\FigmaImageGrade\" -Recurse -Force
Copy-Item deliverables\FigmaBackgroundBlurPlugin\src\* "$tpl\FigmaBackgroundBlur\" -Recurse -Force

# 3. build with MSBuild (VsDevCmd for x64), then patch the localized PiPL strings
#    see tests\patch_pipl_name_grade.py / tests\patch_pipl_name.py and the
#    "构建" section of each deliverable README
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

The `.aex`, `.obj`, `__pycache__` and local SDK copies are ignored by git; the
renders used for validation live in the deliverable folders, not in `tests/`.
