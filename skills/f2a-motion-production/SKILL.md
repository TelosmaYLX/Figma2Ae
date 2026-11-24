---
name: f2a-motion-production
description: "基于 F2A MCP 的 Figma 导出 AEP 工程与 After Effects 动画全流程制作技能。覆盖导出前自动衔接 f2a-figma-layer-tidy 图层整理、默认 vector 导出与原画框命名、AE 任何 dirty 现场保护询问、帧率与参考工程同步、导出后静态保真度门禁、单元素独立预合成强制封装（严禁直接对裸文本/形状/图片层加动画）、复用参考工程（含 AE 27 等高版本 .aep 离线 py_aep 解析与横屏→竖屏居中方向适配）/动效库/从零制作、默认 Web/Lottie 友好红线（无表达式无重特效、严禁逐帧关键帧）、终帧落位一致性与 12 帧接触表三重校验、以及精简交付（仅保留 .aep 与同级预览 .mp4，自动清理临时文件并在对话中汇总参数与问题）。触发场景：使用 F2A MCP 导出 Figma 到 AE 并做动画、复用 PC 端或其他 AEP 入场动画到移动端、在 AE 中制作 UI 入场/循环/状态动画并输出预览视频。"
---

# F2A MCP 工程导出与 AE 动画制作全流程

> **核心目标**：用 F2A MCP 将 Figma 设计稿高保真导出为 `.aep` 工程，并在 After Effects 中产出结构规范、Web/Lottie 友好、关键帧精简且**最终静止落位与导出初始画面严格一致**的可编辑动画工程与预览视频。

---

## 硬约束（不可违反）

1. **导出前自动先整理 Figma 图层**：执行 `export_aep` 之前，必须先检查当前选中画框；只要存在未整理迹象（默认命名、未分离实例、深层套娃、屏外冗余、未隔离复杂效果等），**自动先加载并执行 `f2a-figma-layer-tidy`** 完成整理并通过其像素零差异门禁，再导出 `.aep`。
2. **AE 现场保护（任何 `dirty: true` 必须先询问）**：调用 `ae_open_project` 切换工程前，必须先查 `ae_status`。只要当前 AE 打开的工程 `dirty: true`（无论何种原因，包括仅渲染队列变动），**一律先停下来询问用户**是保存、另存还是放弃更改，**严禁擅自传 `discardChanges: true`**。
3. **单元素独立预合成铁律（禁止对裸图层直接加动画）**：**每个需要做动画的独立元素都必须拥有属于自己的单个预合成**，动画关键帧打在外部父合成的该预合成层上。例如：单个文本层不能直接在文本层本身打关键帧，必须先嵌套独立预合成再对预合成做动画；一个按钮包含底框与文字两层且需独立动画时，底框与文字必须各自打成独立预合成，再由外层按钮预合成组合。
4. **严禁逐帧关键帧**：必须使用少量干净的关键帧（常规单段动作 2 个关键帧，带回弹/变速最多 3 个）配合精确时间缓动曲线（`KeyframeEase`），**绝不允许逐帧采样或烘焙关键帧**；位置关键帧空间切线必须为 `[0, 0, 0]`。
5. **默认遵守 Web / Lottie 友好红线**：除非用户明确表示“仅输出视频”，默认只用纯关键帧驱动 `Transform`（Position / Scale / Rotation / Anchor Point）、`Opacity`、简单矢量 Mask / Trim Paths；**禁止使用表达式**（含 `ae_animate` 的 `spring`/`bounce` 表达式模式）、禁止使用第三方/重型特效、避免复杂 Parenting。
6. **帧率默认跟随参考工程**：有参考 `.aep` 时，目标工程帧率默认与参考工程完全一致（如参考 60fps 则直接在 `export_aep` 传入 `frameRate: 60`；若导入已有工程或仍存在不同帧率预合成，打开 `.aep` 后在加动画前立即统一核对并修正全部合成的 `frameRate`）。
7. **双重视觉门禁（导出静态保真 + 动画落位一致）**：
   - 导出后、加动画前，必须渲染初始静态帧并与 Figma 原图对照做像素比对；超阈值的结构性偏差按“可局部修补则回 Figma 重导 / 疑难则中止汇报”处理。
   - 动画完成后，必须保证**最终画面停止位置与导出 `.aep` 初始静态位置一致**（宽松允许抗锯齿/极微浮点舍入），并强制通过 **12 帧过程接触表肉眼审校** 与 **关键帧规范回读**。
8. **精简交付、清理临时文件**：默认仅交付保存好的 `.aep` 与**同级目录**的预览 `.mp4`；校验通过后**自动删除 `_qa/` 等全部临时校验图与过程接触表**，**不在磁盘额外写入 `.md` 说明文档**，将制作规格、校验数据与遇到的问题直接汇报在最终对话回复中。

---

## 随附参考与脚本（`<SKILL_DIR>` 为本 `SKILL.md` 所在目录）

开始前按需查阅：
- **AE MCP 工具手册与 ExtendScript 模板**：[`references/ae-mcp-playbook.md`](references/ae-mcp-playbook.md) —— 工具速查、6 大已知踩坑边界、批量改帧率 / 单元素紧凑预合成封装 / 精确关键帧脚本模板。
- **动画规范与跨端适配规则**：[`references/motion-adaptation-rules.md`](references/motion-adaptation-rules.md) —— 单元素预合成拆解规则、PC→移动端换算与“竖屏居中改水平滑入为垂直上浮”规则、动效库与从零制作默认语汇、各类型动画校验标准。
- **React Bits 动效词汇与 F2A 映射**：[`references/reactbits-motion-vocabulary.md`](references/reactbits-motion-vocabulary.md) —— reactbits.dev 全站动画的可移植性分类、源码运动参数、F2A `RB` 文字预设与内容片段映射、不可移植清单；文字预设依赖 AE 文字动画器＋表达式，Web/Lottie 交付优先用 `rb-content-*` 等两键片段。
- **Aceternity UI 动效词汇与 F2A 映射**：[`references/aceternity-motion-vocabulary.md`](references/aceternity-motion-vocabulary.md) —— Framer Motion 的入场/弹簧/循环/滚动/指针交互组件盘点、源码参数、F2A `AC` 文字预设与内容片段映射，以及循环、滚动驱动、指针交互类组件的 AE 复刻配方与不可移植边界。
- **Animate UI 动效词汇与 F2A 映射**：[`references/animate-ui-motion-vocabulary.md`](references/animate-ui-motion-vocabulary.md) —— Motion 令牌体系（ease/spring/transition/scale/blur/shift/stagger）、Fade/Slide/Zoom/Effect 入场原语、Splitting/Typing 等文字原语的源码参数、F2A `AU` 预设与片段映射，以及数字滚动/循环/交互类组件的 AE 复刻配方。
- **像素校验脚本**：[`scripts/verify_resting_frame.py`](scripts/verify_resting_frame.py) —— 支持 `--mode static`（含 `clipsContent: false` 溢出对照图对齐）与 `--mode resting`（动画终帧 vs 导出静态基线）。
- **高版本 `.aep` 离线解析脚本**：[`scripts/dump_aep_motion.py`](scripts/dump_aep_motion.py) —— 使用 F2A `.venv-aep` 的 `py_aep` 离线读取任意版本（含 AE 27）参考工程的合成、入出点、关键帧与缓动。

---

## 标准七步工作流

### Step 0：连接检查、目标确认与参考解析

1. **检查 Figma 与 AE 状态**：
   - 调用 `get_f2a_status`（多文档时用 `join_channel` 选中目标）与 `get_selection`。若未选中目标画框，先引导用户选中再动手。
   - 调用 `ae_status`，记录 `appVersion`（决定 `export_aep` 的 `aeVersion`）以及当前工程的 `dirty` 状态。
   - **硬规则**：若当前 AE 工程 `dirty: true`，必须立即通过 `ask_user_question` 询问用户如何处理（先保存 / 另存备份 / 放弃修改），未获答复前不得调用 `ae_open_project`。
2. **明确输出路径与重名检查**：
   - 若用户未指定工程存放目录，先询问用户。
   - 若用户只给了父目录未给文件名，默认使用**清洗非法字符后的原画框名**（如 `06 / 开服时间` → `06_开服时间.aep`）。
   - **重名检查**：检查目标父目录下是否已存在同名工程目录或 `.aep`。若已存在，**先询问用户**是覆盖、新建编号还是改名，不要静默覆盖或盲目建 `(2)`。
3. **解析动画参考来源（按优先级）**：
   - **有参考工程**（如用户提到复用 PC 端或其他 `.aep`）：优先使用 `scripts/dump_aep_motion.py`（以 F2A `.venv-aep\Scripts\python.exe` 执行）离线只读提取参考工程的全部合成帧率、工作区、图层入出点、关键帧与缓动参数（既兼容 AE 27 高版本工程，又不干扰当前 AE 现场）。若目录下有多个冲突参考且无法确定以哪个为准，先询问用户。
   - **无参考工程**：调用 `ae_motion_list` 查询是否有可复用的 F2A 动效库片段；无匹配则走从零制作。

---

### Step 1：导出前自动整理 Figma 图层

1. 用 `get_design_context(detail: "compact")` 快速检查当前选中画框。
2. 若存在未分离实例、垃圾命名、冗余套娃、屏外无用区块、未局部隔离的复杂效果或零贡献效果，**自动调用 `f2a-figma-layer-tidy` 技能**完成整理并跑通其像素零差异门禁（`max_abs_diff == 0`），并确认原目标画框保持选中状态。
3. 若画框本身已干净整齐（语义命名规范、无未分离实例、无屏外垃圾与导出高危结构），简述检查通过并直接进入 Step 2。

---

### Step 2：导出 `.aep`、打开工程并同步帧率

1. **确定 `textMode`**：
   - 默认使用 `textMode: "vector"`（矢量轮廓，不依赖本机字库、视觉保真度最高，且与多数 Web/PC 导出工程一致）。
   - 仅当需要逐字/逐词文本动效（如 `ae_text_reveal`）或用户明确要求后期改文案时，改用 `textMode: "editable"`；极少数复杂排版静态图文字可选 `png`。
2. **执行导出**：
   - 调用 `export_aep({ destination: "<绝对路径>/<清洗后原画框名>.aep", textMode, aeVersion: "<匹配 ae_status>", duration, frameRate })`（`duration`、`frameRate` 可按需指定，省略时沿用 Figma 面板当前记住的时长与帧率；有参考工程时可直接传入匹配的 `frameRate` 与所需 `duration`），记录返回的 `project` 路径与主合成 `compositionId`。
3. **打开工程并同步帧率**：
   - 在已妥善处理完旧工程 `dirty` 状态后，调用 `ae_open_project` 打开新导出的 `.aep`。
   - 调用 `ae_list_comps` 和 `ae_get_comp_map(comp: compositionId)` 摸清所有合成数字 ID（后续一律按数字 ID 引用，避免同名合成混淆）。
   - **帧率复核**：若导出前未指定或仍有合成与参考帧率（如 `60fps`）不一致，**立刻在加动画前**用 `ae_run_script`（见手册模板 1）把项目中所有 `CompItem` 的 `frameRate` 统一改为参考帧率。

---

### Step 3：导出后静态保真度门禁（加动画前必过）

1. 在工程目录下临时创建 `_qa` 文件夹（避免 `ae_render_frame` 因父目录不存在报错）。
2. 调用 `ae_render_frame({ comp: rootCompId, time: 0, maxSize: <≥合成长边>, outputPath: "...\\_qa\\00_static_baseline.png", overwrite: true })` 渲染 1:1 原分辨率静态基线帧。
3. 从 `ae_get_comp_info(rootCompId)` 读取第 1 层（`*_原图对照`，默认禁用）的 `source.name`（即 `Assets\XXXX.png`）及其 `position` / `anchorPoint`，计算参考图相对根合成左上角的整数偏移 `offsetX = round(pos[0] - anchor[0])`、`offsetY = round(pos[1] - anchor[1])`（专门兼容 `clipsContent: false` 导致对照图大于主合成的情况）。
4. 运行像素门禁脚本（使用装有 `Pillow` 与 `numpy` 的 Python）：
   ```powershell
   python "<SKILL_DIR>\scripts\verify_resting_frame.py" "<project_dir>\Assets\<ref.png>" "<project_dir>\_qa\00_static_baseline.png" --mode static --ref-offset-x <offsetX> --ref-offset-y <offsetY> --diff "<project_dir>\_qa\00_static_diff.png"
   ```
5. **偏差处置决策**：
   - **通过**（仅矢量文字抗锯齿级微小差异）：继续 Step 4。
   - **失败**（出现明显色彩/位置/模糊/混合模式/圆角裁剪失真）：
     - 先用 `read_image` 查看 `00_static_diff.png` 定位异常层；
     - 若属**可局部无损修补**的问题（如 Figma 中漏标 `*` 栅格化的复杂效果/混合层、异常蒙版），回 Figma 做最小修补 → 重新 `export_aep` → 重新过 Step 3 静态门禁；
     - 若属 **F2A 引擎边界或无法无损修补** 的问题，**中止加动画**，向用户清晰汇报定位结果、差异截图与替代方案。

---

### Step 4：单元素独立预合成封装（强制前置）

在打任何关键帧之前，逐一核对**所有准备做动画的目标图层**：
1. 若目标元素本身已经是一个独立的单元素预合成（`type === "precomp"` 且内部只承载该元素），直接使用，无需重复套娃。
2. 若目标元素是**裸图层**（单个 `text`、单个 `shape` 如文字轮廓/线段/圆点/底框、单个 `footage` 图片），**必须先用 `ae_run_script`（见手册模板 2）为其创建紧贴边界的独立预合成**（归档至 `Precomps` 文件夹，保持父合成内原 Z 序、混合模式与精确视觉位置）。
3. 若复合组件（如按钮 = 底框 + 文字）需要内部子元素各自做动画，则底框和文字各自先封成独立预合成，外层再保留按钮预合成。
4. 封装完成后，快速渲染一帧并对比 `00_static_baseline.png`，确认预合成封装引入的像素偏差为 **0**，再进入 Step 5。

---

### Step 5：制作动画（严控关键帧数量 + 锁定终值）

严格参照 [`references/motion-adaptation-rules.md`](references/motion-adaptation-rules.md) 执行：
1. **复用参考工程（场景 A）**：
   - 1:1 沿用参考工程的时间节拍与缓动曲线（含嵌套预合成的 `startTime` 偏移）；
   - 垂直位移按画幅高度比换算；**横屏非对称水平滑入到了竖屏居中布局时，自动转为垂直上浮**；
   - 父子→兄弟层级差异折算等效复合位移与延迟淡入；
   - 自动修正参考工程中的终值瑕疵（如 `100.7% → 100%`）与漏改硬切（如 `100→100` 改为 `0→100` 淡入）。
2. **动效库复用（场景 B）**：
   - 无参考工程但 `ae_motion_list` 命中合适片段时，用 `ae_motion_apply({ position_anchor: "end", ... })` 应用并核查无表达式残留。
3. **从零制作（场景 C）**：
   - 遵循默认精致 UI 语汇（位移 `BEZIER out 33% / in 75%`、透明度 `LINEAR`、错帧 `0.05s`、位移屏高 `1.5%–3.5%`）；
   - 简单动作可用 `ae_animate`（仅限 `snappy`/`smooth`/`linear`）或 `ae_stagger`；精细编排统一用 `ae_run_script`（单 Undo Group）写入。
4. **终值锁定铁律**：
   - 任何入场动画写关键帧时，终点值必须直接读取该预合成层的原始 `prop.value`（不得手抄四舍五入值）；
   - 线段/进度条单端缩放生长时，先将预合成锚点移至起点边缘并同步补偿等量 `Position`，保证 `Scale = [100, 100]` 时几何位置 0 偏差。
5. **设置工作区（Work Area）**：
   - 将根合成与主内容合成的 `workAreaStart = 0`，`workAreaDuration` 设为全片最后一个关键帧结束后再留 `0.2s–0.3s` 静止余韵（可凑整到 `0.5s` 档位）。

---

### Step 6：三重质量校验门禁（未通过禁止交付）

1. **门禁 1 — 最终落位一致性校验**：
   - 在动画完全结束后的静止时刻（如 `workAreaEnd`）调用 `ae_render_frame`（原分辨率 `maxSize` ≥ 长边）输出 `_qa\01_final_resting.png`。
   - 运行确定性比对脚本：
     ```powershell
     python "<SKILL_DIR>\scripts\verify_resting_frame.py" "<project_dir>\_qa\00_static_baseline.png" "<project_dir>\_qa\01_final_resting.png" --mode resting --diff "<project_dir>\_qa\01_resting_diff.png"
     ```
   - 核验最终画面停止位置与导出 `.aep` 初始画面一致（允许极微浮点抗锯齿舍入，无结构/坐标偏移）；循环/退场/状态切换类动画按手册第 3 节核验首尾衔接或目标态。
2. **门禁 2 — 过程接触表肉眼审校（强制）**：
   - 调用 `ae_render_contact_sheet({ comp: rootCompId, start: 0, end: workAreaEnd, frames: 12, columns: 4, outputPath: "...\\_qa\\02_contact_sheet.png", overwrite: true })` 生成 12 帧网格并亲自查看：
     - 核查入场顺序、方向（竖屏居中不违和）、线条生长起点、节点与文字卡点、预合成边界无裁切、无穿帮闪烁；
     - 发现任何视觉瑕疵，直接自主修改并重新跑门禁 1 & 2，直至全部通过。
3. **门禁 3 — 关键帧与结构规范回读**：
   - 调用 `ae_get_keyframes` 回读所有动画合成，逐项核查：
     - **无逐帧关键帧**（单段动作仅 2–3 个关键帧）；
     - **无表达式残留**（Web/Lottie 友好模式）；
     - **空间切线全为 `[0, 0, 0]`**；
     - **全部被动画图层均为独立预合成**（无裸文本/裸形状/裸图片层直接挂关键帧）。

---

### Step 7：精简交付与现场清理

1. **保存工程**：调用 `ae_save_project` 保存最终 `.aep`（先确认原图对照层保持禁用 `enabled: false`）。
2. **渲染同级预览 MP4**：调用 `ae_render_mp4({ comp_id: rootCompId, outputPath: "<project_dir>\\<工程名>.mp4", startFrame: 0, endFrame: <workArea末帧> })`，并用 `ae_render_jobs` 等待渲染 `status: "done"` 且确认 MP4 文件落盘非空。
3. **清理临时校验文件**：校验与渲染全部完成后，**自动删除 `<project_dir>\_qa\` 整个目录**，不在磁盘遗留过程截图或 `.md` 文档，保持工程目录仅保留规范交付物（`.aep`、`Assets/`、`report.json`、同级预览 `.mp4`）。
4. **对话内完整汇报**：在最终回复中清晰列出：
   - 交付文件路径（`.aep` 与同级预览 `.mp4`）；
   - 动画方案摘要（帧率、工作区时长、单元素预合成清单、各模块起止时间/位移/缓动、跨端适配说明）；
   - 三重校验结果（静态保真数据、最终落位 diff 数据、关键帧回读结果）；
   - 制作过程中遇到的问题与处理总结。

---

## 自主判断 vs 必须询问用户边界

| 情况 | 处理方式 |
|---|---|
| Figma 未选中目标画框 / 目标保存目录未给出 | **必须询问用户** |
| AE 当前打开工程为 `dirty: true`（无论原因） | **必须询问用户**（保存 / 另存 / 放弃） |
| 目标目录已存在同名工程文件夹或 `.aep` | **必须询问用户**（覆盖 / 编号新建 / 改名） |
| 存在多个冲突参考工程无法确定版本 | **必须询问用户** |
| 静态导出出现无法无损修补的严重失真 | **中止并汇报用户** |
| Figma 导出前整理、单元素独立预合成封装、锚点修正、同步参考帧率、竖屏居中方向转换、参考工程终值/硬切瑕疵修正、Work Area 设定、三重门禁迭代修正、清理 `_qa/` | **自主执行**，把决策与理由写入最终对话汇报 |
