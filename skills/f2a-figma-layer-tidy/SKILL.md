---
name: f2a-figma-layer-tidy
description: "基于 F2A 导出 `.aep` 工程规则与动效师工作流的 Figma 图层整理技能。使用 F2A MCP 工具对选中画框做非破坏性结构梳理、冗余套娃展开、语义化命名、可动画层最大化保留、复杂不可导效果最小化合并（`*` 标记或局部隔离）；动手前自动复制整画框为隐藏备份、结构性决策自主判断（仅在目标未选中时引导用户选择）、整理后强制执行像素级零差异校验，通过后再删除备份并清理临时文件。触发场景：整理 Figma 图层准备导出 AE/AEP、优化 F2A 导出结构、清理冗余分组/自动命名、排查特效/混合模式/蒙版合并范围、图层整理前后的视觉一致性校验。"
---

# F2A Figma 图层整理（面向 AEP 导出与动效师工作流）

> **核心原则**：最大化保留可动画图层与可编辑属性，仅对 AE/AEP 无法原生还原的复杂效果做**最小范围合并**；**整理前后设计稿的渲染画面必须像素级完全一致**，绝不允许改变视觉表现。

---

## 硬约束（不可违反）

1. **视觉零偏差硬门禁**：整理前必须导出基准 PNG（`before.png`），整理后必须以同一节点 ID 和相同倍率导出结果 PNG（`after.png`），并用 [`scripts/compare_pixels.py`](scripts/compare_pixels.py) 校验尺寸完全一致且 RGBA 逐像素最大差 `max_abs_diff == 0`。任何尺寸变化或像素差异都必须立即回退/修复，未通过校验禁止宣布完成。
2. **保留图层优先，最小化合并**：凡是 F2A `.aep` 可原生导出或动效师需要独立做关键帧动画的元素（独立卡片、按钮、图标、文字、角色部件、背景元素、独立 `DROP_SHADOW` 层等），**禁止合并**。
3. **仅在最小必要范围内合并复杂效果**：对于无法原生写入 `.aep` 的复杂效果（如 `GLASS`、`BACKGROUND_BLUR`、`INNER_SHADOW`、`LAYER_BLUR`、特殊渐变/图案、多层静态混合叠加纹理等），优先将其隔离在**最小叶子或最小静态局部组**并添加 `*` 前缀（F2A 栅格化标记），避免连带吞噬上方的可动文字或前景元素。
4. **绝不凭猜测改动视觉参数，但结构性决策自行判断**：不擅自修改颜色、透明度、混合模式、效果参数、字体字号、绝对坐标或实际起裁剪作用的 `clipsContent`。合并（`*`）、`flatten_nodes`、拆出背景、删除隐藏层、清理屏外块等**结构性决策由你按 Step 3 决策树自行判断并直接执行，不要逐项询问用户**；判断不确定时选更保守的一侧（保留分层、不合并），把取舍理由写进最终报告即可。**实例（`INSTANCE`）在整理阶段默认自动全部分离**（由外向内递归分离为普通 Frame）。
5. **备份先行、收尾清理**：动手前必须先用 `clone_node` 复制**整个目标画框**，改名为 `_备份_<原名>_<时间戳>` 并 `set_visible(false)` + `set_locked(true)` 隐藏锁定；**只有 Step 5 像素门禁通过后**才允许在 Step 6 删除该备份，并同步清理 `artifacts/tidy-verify/` 下本次产出的全部临时 PNG 与 diff 文件。

---

## 开始前：检查参考资料与工具环境

开始整理前，按需阅读以下随附文档（位于本 Skill 目录）。**本文中的 `<SKILL_DIR>` 一律指本 `SKILL.md` 所在目录**（即 skill 根目录，含 `scripts/`、`references/`），执行命令前替换成实际路径：
- **F2A AEP 兼容性与合并规则**：[`references/f2a-aep-compatibility.md`](references/f2a-aep-compatibility.md) —— 详述 F2A 采集与 `writer.py` 的原生支持清单、自动处理边界、常见失真陷阱（如容器效果吞并子层、多图填充丢图、裁剪圆角降级、混合模式跨蒙版隔离等）。
- **F2A MCP 工具调用手册**：[`references/mcp-tool-playbook.md`](references/mcp-tool-playbook.md) —— 详述 F2A MCP 的读图、搜索、批量重命名、拆组/成组、Z 序、分离实例、`batch` 以及工具降级映射。

### 第 0 步：确认文档连接与 MCP 能力

1. 调用 `get_f2a_status`（若多个 Figma 文档打开，用 `join_channel` 选中目标文档）。
2. 调用 `get_selection` 确认目标根节点：已有选区就用选区（多选时取其共同顶层祖先）；**若用户未选中，先引导用户选中目标画框再继续**——说明需要选中哪个层级的画框（要导出 AEP 的那个顶层画框或弹窗 Frame），等待期间只做只读准备（读文档结构、列候选画框并报给用户确认），**不要自行猜测目标就动手改造**。
3. 确认当前会话可用的 `f2a` MCP 工具集：
   - **完整版工具**：具备 `get_design_context`、`search_nodes`、`save_screenshots`、`get_screenshot`、`batch_rename_nodes`、`group_nodes`、`ungroup_nodes`、`reorder_nodes`、`reparent_nodes`、`set_clips_content`、`set_visible`、`set_locked`、`detach_instances`、`batch`、`flatten_nodes`、`outline_stroke` 等。
   - **基础版降级**：若当前客户端未重载到扩展工具，可降级使用 `get_node_info`、`scan_nodes_by_types`、`export_node_as_image`、`rename_node`、`set_parent`、`create_frame` 等（详见 [`references/mcp-tool-playbook.md`](references/mcp-tool-playbook.md)）。

---

## 标准六步工作流

### Step 1：备份画框 + 基准采图（硬门禁起点）

在执行**任何**写操作之前，按顺序完成以下四件事：

1. **复制整个画框为隐藏备份（必须，先做）**
   - 记录目标根节点的 `rootId`、名称、精确尺寸（`width × height`）与画布位置（`x, y`）。
   - 用 `clone_node({ nodeId: rootId, x: root.x + root.width + 200, y: root.y })` 复制**整个画框及全部子层**，得到 `backupId`（偏移到画框右侧，避免与原稿重叠）。
   - 立即改名、隐藏、锁定，作为唯一回退依据：
     - `batch_rename_nodes([{ nodeId: backupId, name: "_备份_" + 原名 + "_" + yyyyMMdd-HHmmss }])`
     - `set_visible({ nodeIds: [backupId], visible: false })`
     - `set_locked({ nodeIds: [backupId], locked: true })`
   - 备份名**不得以 `*` 开头**（`*` 会被 F2A 当作强制合图标记），统一使用 `_备份_` 前缀。
   - 备份是**页面级兄弟节点**，不在 `rootId` 的导出范围内，因此不会污染 `before.png` / `after.png`；但**后续所有扫描必须限定 `root: rootId`**，禁止整页搜索，以免把备份算进整理范围或被清理规则误删。
   - 把 `backupId` 记录到全程上下文，**直到 Step 6 才允许删除**。

2. **基准采图 `before.png`**
   - 使用 `save_screenshots`（`nodeIds: [rootId]`、`format: "PNG"`、`scale: 1`，高精细稿可同时存 `scale: 2`，`outDir: "artifacts/tidy-verify/<nodeId-clean>"`）保存基准图。**注意：`outDir` 的相对路径是相对 MCP server 进程的工作目录，未必等于你的 shell 目录**，所以一律以返回的 `saved[].path`（绝对路径）为准，把它作为本次的 `<dir>/before.png` 记录（需要时把保存出的 `<nodeId>.png` 重命名）；若无 `save_screenshots`，则用 `export_node_as_image` 导出并落盘保存为 `before.png`。

3. **查看设计稿**
   - 可同时调用 `get_screenshot` 直观查看设计稿视觉，结合图层树判断哪些是前景交互/动效主体、哪些是背景/氛围光效/纹理。

4. **回退与快检**
   - 回退靠 Step 1.1 的隐藏备份（解锁 + 恢复可见即可还原整稿），不必再额外复制页面。
   - F2A MCP 每次写操作后都会执行 `figma.commitUndo()`，但 `batch` 在中途失败时**不会自动回滚**（`rolledBack: false`）；因此每完成一个高风险结构阶段，立即 `save_screenshots` + `compare_pixels.py` 快检一次，尽早发现漂移。

---

### Step 2：全局只读诊断与动效结构分析

优先用 `get_design_context`（大图先用 `detail: "compact"` 或 `sectionPlan`，再逐段拉 `detail: "full"`）配合 `search_nodes` 扫描全树，梳理以下 6 类信息：

1. **动效单元与层级深度**：
   - 识别可独立做动画的逻辑模块（如 `BG`、`Header`、`Card`、`Icon`、`CTA_Button`、`Badge`、`FX`）。
   - 检查是否存在 **4 层以上的冗余套娃容器**（每多一个容器，F2A `organize: true` 就会多一个 AE Precomp，显著降低动效师操作效率）。
   - 注意：F2A 会**自动跳过「纯文字透明容器」**（无裁剪、无填充/描边/效果、透明度 100%、无混合隔离、仅含文字），这类包裹无需为了减 Precomp 而强行拆掉；但包含图形/图片/多组嵌套的冗余空容器应当清理。
2. **垃圾命名与危险 `*` 前缀**：
   - 统计 `Frame 123456`、`Group 8`、`Rectangle 12`、`Vector 3`、`image 64` 等自动生成名称。
   - **高危检查**：排查名称以 `*` 开头的图层——在 F2A 中 `*` 会强制整层转成单张 PNG 并丢弃所有内部子层！确认哪些 `*` 是有意合图，哪些是误标。注意：`search_nodes(name: "*")` 是子串匹配（会误命中 `sam*ple@163.com` 这类中间带星号的文本），排查时必须二次过滤 `name.startsWith('*')`。
3. **实例（`INSTANCE`）统计**：
   - 实例内部只读，无法改名、拆组、调序或编辑内部蒙版/特效。整理阶段会**自动将目标范围内的全部实例由外向内递归分离为普通 Frame**（再进入后续层级精简与命名），诊断时先统计全部 `INSTANCE` 数量与嵌套情况即可。
   - **整页背景实例警报**：弹窗/浮层稿常直接嵌入整张长页面的组件实例作暗色背景；分离后会带入大量 `visible: false` 图层以及完全在当前画框裁剪区域之外的屏外区块（F2A 导 `.aep` 不会跳过子容器内被裁掉的屏外节点，仍会切图和建层）。**自行判断处理，不要停下来问用户**：若这些屏外/隐藏块在当前视口内完全不可见，直接删除（删后必须过像素门禁）；若删除会改变画面或存在滚动展示的可能，则把整块背景收口为 `*背景_xxx` 合图。取舍理由写进最终报告。
4. **隐藏图层（`visible: false`）、屏外裁剪与空节点**：
   - 区分“废弃草稿/空容器”与“可能用于切换状态的隐藏图层”。默认绝不武断删除有内容的状态层。
   - **屏外判定（防翻转/旋转坐标系踩坑）**：判断节点是否完全在根视口外时，**绝不可仅用 `x, y, width, height` 计算**！带 `flipped: true`（`scaleY(-1)` / `scaleX(-1)`）或旋转的节点，其 `(x, y)` 是变换原点而非包围盒左上角（例如 `scaleY(-1)` 会向上延伸进入视口）。必须用 `boundingBox` / `absoluteBoundingBox`（再叠加阴影/模糊外扩范围）判断是否真正与视口完全不相交，并在删除后立刻用 `compare_pixels.py` 校验 `max_abs_diff == 0`。
5. **Auto Layout 与裁剪（`clipsContent`）陷阱**：
   - 标记所有开启了 Auto Layout（`layoutMode !== 'NONE'`）的容器：内部增删、重排 Z 序或提取元素前必须注意绝对位置与重排风险。
   - 标记所有 `clipsContent: true` 的 `FRAME`：判断它是否真的在裁剪溢出内容（看子节点边界是否超出该 Frame）。无溢出且无裁剪意图的 Frame 可关掉 `clipsContent` 或转为 `GROUP` 以防误切阴影；有真实溢出的 Frame 严禁关闭裁剪。
   - 检查「开启裁剪 + 四角圆角不一致（mixed radii）」的 Frame：F2A AEP 写入器对 Frame 裁剪只读取 `topLeftRadius`，若四角圆角不同需特别记录提醒或改用独立圆角遮罩层。
6. **AEP 导出兼容性与合并判定（核心决策）**：
   依据 [`references/f2a-aep-compatibility.md`](references/f2a-aep-compatibility.md) 对照检查每一层的 `fills`、`strokes`、`effects`、`blendMode`、`isMask`、`type`：
   - **可原生保留** vs **建议拆出背景** vs **建议局部标 `*` 合并**。

---

### Step 3：制定整理方案（保留 vs 合并决策树）

诊断完成后**直接按以下三层策略规划并执行，不要先向用户汇报等确认**；诊断摘要与取舍理由统一写进最终报告。

#### 策略 A：坚决保留原生可编辑层（不合并）
以下内容 F2A 可高保真写入 `.aep`，动效师也常需单独调整，**保留原样**（只做命名与清晰分组）：
- 基础形状（`RECTANGLE`、`ELLIPSE`、`VECTOR`、`STAR`、`POLYGON`、`LINE`）
- 纯色、线性渐变（`GRADIENT_LINEAR`）、径向渐变（`GRADIENT_RADIAL`）
- 常规纯色描边（含 Inside/Center/Outside）；虚线或 `< 1px` 细描边（F2A 导出时会自动在副本轮廓化，无需破坏原稿）
- 普通 `TEXT`（含富文本、段落属性、渐变文字；若后续选“可编辑文字”导出，需用 `get_fonts` 或 `hasMissingFont` 检查字体是否缺失）
- 带有 `fillGeometry` 的 `BOOLEAN_OPERATION`（仅静态矢量，无需在原稿打散）
- 普通 `FIT`/`FILL` `IMAGE` 填充（无调色滤镜、非多图叠在同一节点内）
- 仅含 `DROP_SHADOW` 的图层/文字（F2A 默认会自动单独提取投影 PNG `*_投影`，前景依然保持矢量/可编辑）
- 纯色填充、无描边无复杂效果的常规 Alpha/Luma 矢量蒙版（F2A 原生转 AE Track Matte）

#### 策略 B：拆分隔离（保留前景可动，只合背景效果）
当**容器本身**挂了以下属性，且内部包含**需要动画的子图层**（如文字、按钮图标、主体元素）时：
- 容器有 `BACKGROUND_BLUR`、`GLASS`、`LAYER_BLUR`、`INNER_SHADOW`、`NOISE`、`TEXTURE`、`SHADER`；
- 容器自身填充了 `GRADIENT_ANGULAR`、`GRADIENT_DIAMOND`、`PATTERN`、`VIDEO` 等。

**做法**：
- 若当前容器直接带着这些样式会导致 F2A 把整个容器或组内文字连带栅格化，**将容器的背景绘制抽离成底层独立矩形节点（保持完全相同的坐标/圆角/填充/效果），仅给该底板节点加 `*` 前缀**（例如 `*bg_glass`），原容器保留为纯粹的分组容器（`fills: [], effects: []`），前景文字与图标即可 100% 保留为独立 AE 图层！
- 注意：`BACKGROUND_BLUR` / `GLASS` 在同父级中的**层序位置**决定它采样哪些背景，抽离后必须位于原位置紧邻其原先子节点之下，并用像素对比确认 0 误差。

#### 策略 C：推荐局部合并 / 标记 `*`（复杂且无法原生导 AEP 的情况）
当满足以下条件，且经评估合并**不会阻碍动效师的预期动画**时，推荐收敛为一个局部组并加 `*` 前缀（或给该单层加 `*`）：
1. **复杂效果无法写入 AEP**：`INNER_SHADOW`、`LAYER_BLUR`、`BACKGROUND_BLUR`、`GLASS`、`NOISE`、`TEXTURE`、`SHADER`，或带曝光/对比度/饱和度等调色滤镜的图片。
2. **特殊渐变与填充**：`GRADIENT_ANGULAR`（角度渐变）、`GRADIENT_DIAMOND`（菱形渐变）、`PATTERN`、`VIDEO`。
3. **同一节点多重冲突填充**：单节点同时叠了多张 `IMAGE` 填充（F2A `collectImages` 只取第一张可见 `IMAGE`！若一个形状里叠了 2 张图，必须拆成两个独立重叠节点，或将该静态合图节点标 `*`）。
4. **纯静态的多层混合模式堆栈**：由多个 `COLOR_BURN`、`LINEAR_BURN`、`SOFT_LIGHT`、`HARD_LIGHT`、`OVERLAY` 等叠加而成的静态纹理/光影底纹。将这几层纯装饰纹理归入同一局部组（如 `*tex_card_grain`），可避免跨遮罩/8-bpc 混合色偏，且大幅减少 AE 图层数。
5. **复杂共享渐变/效果蒙版下的重叠混合层**：当一个半透明渐变蒙版或效果蒙版下有多个彼此重叠的静态纹理层时，AE 逐层应用蒙版会导致半透明区域 alpha 累积偏差，归组标 `*` 可保证 100% 还原原稿。
6. **无动画价值的超碎静态矢量群**：例如纯静态装饰花纹/复杂纹理/插画背景由几十上百个零碎 `VECTOR` 组成且只需整体运动，可归组标 `*`（若确属纯同色平涂且无特效/渐变/混合模式，才考虑 `flatten_nodes`）。
7. **路径文字（`TEXT_PATH`）**或**含多图/倾斜 `CROP` 变换的图片**（倾斜裁剪无法用 AE 简单缩放+旋转表达，标 `*` 固定裁剪结果）。

> **自主决策规则（不要为这些判断中断流程去问用户）**：遇到“某个带模糊/混合模式的组，既不能原生导出、又可能包含未来要动的元素”时，按以下优先级自行判断并直接执行：
> 1. **能拆就拆（首选）**：把特效底板抽离成 `*背景` 独立层，让内部文字/图标保持独立可动，兼顾可动性与保真度。
> 2. **拆不动、或拆了会改变视觉效果**（例如共享蒙版下的重叠混合层、跨层依赖的混合上下文）→ 整组标 `*` 合图，保证 100% 还原。
> 3. **两者都不确定** → 选**更保守**的一侧（保留分层、不合并），并在最终报告里标注该处可继续优化。
>
> 判断依据只有两条：**是否会影响动效师的预期动画能力**，以及**能否通过像素门禁做到 0 误差**。取舍理由写进最终报告即可。

---

### Step 4：安全执行整理（分阶段、可验证、防错乱）

严格按以下顺序分批执行，每阶段可使用 `batch`（注意记住 `batch` 无自动回滚，重要节点先留底）并注意 Auto Layout 限制：

1. **阶段 1：自动全部分离目标范围内的实例**
   - 用 `search_nodes(type: "INSTANCE", root: rootId)`（或诊断结果）找出所有顶层/最外层 `INSTANCE`（注意：只传最外层实例 ID，或利用 `recursive: true` 由外向内自动递归分离，**切勿直接对嵌套在内层的实例单独调用分离**）。
   - 调用 `detach_instances({ nodeIds: outerInstanceIds, recursive: true })` **自动全部分离**目标范围内的全部实例（如果根选区本身就是 `INSTANCE`，先分离根并记录返回的新 `newId` 作为新的 `rootId`）。
   - 分离后所有原实例及其子孙节点的 ID 均会变更为普通 Frame/子节点新 ID，**必须用返回的 `detached: [{nodeId, newId}]` 更新 `rootId` 并重新扫描节点树（`search_nodes` / `get_design_context`），切勿继续使用旧 ID**！
2. **阶段 2：清理无效空容器与可安全删除的废弃隐藏层（自行判断，不必询问）**
   - 先用 `search_nodes` 核查 `visible: false` 与空容器。
   - **安全展开冗余嵌套（完全等价 `code.js` 的 `_canExpand` 条件）**：
     只有当容器同时满足以下条件时才可 `ungroup_nodes` 或 `reparent_nodes` 提级后删空壳：
     - 类型为 `GROUP` 或 `FRAME`（非实例、非布尔）
     - `clipsContent === false`
     - `fills` / `strokes` / `effects` 均无可见项
     - `opacity === 1` 且 `blendMode === 'PASS_THROUGH'`
     - 自身与父级均非 Auto Layout（`layoutMode === 'NONE'`）
     - 自身不是蒙版，且内部和直接兄弟中无蒙版干扰作用域
     - **先 `reparent_nodes(..., keepPosition: true)` 并保持原始 Z 序位置，再删除空壳**；若为 `GROUP`，可直接 `ungroup_nodes`。
3. **阶段 3：语义化重构分组与裁剪修正**
   - 将平铺过散且属于同一动画单元的兄弟图层用 `group_nodes` 收口到清晰模块组（如 `card_header`、`icon_badge`）。
   - **组 vs 画框**：
     - 纯逻辑分组容器优先用 `GROUP`（不裁剪溢出与阴影）；
     - 若原容器是 `FRAME` 且无填充/描边/裁剪需求（内部完全不超出边界），可关闭 `clipsContent`；**凡有内容超出边界且原本被裁剪的 `FRAME`，绝对保留 `clipsContent: true`**！
   - 对非 Auto Layout 父级下需要微调叠放秩序的层，用 `reorder_nodes` 整理为直觉的底→顶序列（**注意：严禁改变任何有像素重叠区域的层之间的相对前后关系**！只有互不重叠、或纯移动进对应逻辑组的层才调整树序，否则视觉会变化）。
4. **阶段 4：拆分复杂效果背景 & 添加 `*` 合并标记**
   - 按 Step 3 的自主决策规则，直接执行“保前合后”的背景拆分或局部组 `*` 标记。
   - **检查同节点多张 `IMAGE` 填充**：若发现单节点有 ≥2 个可见 `IMAGE` 填充，复制拆分为独立图层分别保留单张图（按原始堆叠顺序），或按方案标 `*`。
5. **阶段 5：动效师规范批量命名（`batch_rename_nodes`）**
   - 清理所有 `Frame xxx`、`Group xxx`、`Rectangle xxx`、`Vector xxx`、`image xxx`。
   - 命名风格与原稿语言/团队习惯保持一致，推荐简洁的 `模块_角色[_序号]`（如 `card_bg`、`card_border`、`icon_star`、`title_main`、`*fx_glow_bg`、`*tex_overlay`）。
   - **混合模式显式后缀（强制规则）**：凡是使用了非默认混合模式（`blendMode` 不是叶层默认 `NORMAL` 且不是容器默认 `PASS_THROUGH`，或填充/描边自身带混合模式）的图层，**必须在语义名称末尾加上 `（混合模式名）`**，例如 `装饰1` 使用了柔光（`SOFT_LIGHT`），则命名为 `装饰1（柔光）`；若已有对应括号后缀则避免重复追加；中文混合模式对照表见 [`references/f2a-aep-compatibility.md`](references/f2a-aep-compatibility.md)。普通默认 `NORMAL` / `PASS_THROUGH` 不加括号。
   - **最后检查一遍所有名字**：确保没有任何**未打算合并**的图层以 `*` 开头！
   - 可对纯静态参考背景层用 `set_locked` 锁定防误触（可选，锁定不影响 F2A 导出）。

---

### Step 5：强制像素级一致性验证

1. **导出整理后图像**：
   - 使用与 Step 1 对应的根节点 ID（若原 `rootId` 本身就是 `INSTANCE` 并在阶段 1 被分离，则使用其返回的 `newId`）、相同的 `format: "PNG"` 和 `scale`、相同的 `outDir`，调用 `save_screenshots` 保存到 `before.png` 同目录下的 `after.png`（同样以返回的 `saved[].path` 为准；或 `export_node_as_image`）。
2. **运行像素对比硬门禁**：
   ```powershell
   python "<SKILL_DIR>/scripts/compare_pixels.py" "<dir>/before.png" "<dir>/after.png" --diff "<dir>/diff.png"
   ```
   - 通过标准：`same_size == true` 且 `max_abs_diff == 0`（RGBA 四个通道零偏差）。
   - 若失败（退出码非 0）：
     1. 查看脚本输出的 `changed_pixels`、`max_abs_diff`、`changed_bbox`；
     2. 用当前环境可用的看图工具检查 `diff.png` 定位出错区域（DSH 下为 `read_image`；其他 runtime 用对应的图片读取/预览能力，或直接把图片文件交给模型查看）；
     3. 立即排查并修复（撤销错改的裁剪/透明组/Z 序/Auto Layout 位置），**必须重新跑通 `max_abs_diff == 0` 才能结束**。
3. **门禁通过后才进入 Step 6**；报告要素（下述 3.1–3.5）在 Step 6 清理完成后与清理结果一起输出。
   3.1 **视觉一致性校验**：`before.png` vs `after.png` 尺寸、像素总差（`max_abs_diff = 0`）、`changed_pixels = 0`。
   3.2 **图层与预合成结构对比**：整理前 vs 整理后（总节点数、容器/预期 AE Precomp 数、展开的冗余套娃数、分离的实例数、重命名数）。
   3.3 **保留的可动画/可编辑资产**：矢量形状、文字层、独立图片层、原生遮罩清单。
   3.4 **已合并的 `*` 项清单**：每个标 `*` 图层的名称、节点 ID、合并原因（对应哪条 AEP 限制），以及合并后如何保持了周围图层可动。
   3.5 **推荐 F2A AEP 导出面板参数**：
   - 「保留分组层级」：开启（与整理好的 Precomp 层级一一对应）
   - 「保留画框裁剪」：开启
   - 「忽略隐藏图层」：开启
   - 「文字导出方式」：若动效师无需改字或本机缺字体，推荐「矢量形状（无需字体）」；若需在 AE 内改文案或做文字动画器，且已验证字体齐全，选「可编辑文字」
   - 「图片蒙版」：默认「原图 + 独立蒙版」
   - 「高级选项 → 允许自动转为图片」5 项及「合并混合模式与底图」：默认全部开启

---

### Step 6：收尾清理（仅在像素校验通过后执行）

> **进入本步的唯一前置条件：Step 5 的 `compare_pixels.py` 已返回 `passed: true` 且 `max_abs_diff == 0`。校验未通过时严禁执行本步任何操作，必须保留隐藏备份继续排查。**

按以下顺序收尾，四个动作全部做完才算结束：

1. **删除隐藏备份画框**
   - `delete_nodes({ nodeIds: [backupId] })`。
   - 用 `search_nodes({ name: "_备份_" })`（限定页面范围）确认没有残留的备份节点，避免留下垃圾画框。

2. **复查主画框未受备份删除影响**
   - 再导一次 `after-clean.png`（同一 `rootId`、同一 `scale`），与 `after.png` 比对：
     ```powershell
     python "<SKILL_DIR>/scripts/compare_pixels.py" "<dir>/after.png" "<dir>/after-clean.png"
     ```
   - 必须仍为 `max_abs_diff == 0`。若非 0，说明备份删除牵连了原稿结构（例如误删了仍被引用的父级），立即停止并排查。

3. **清理本次产出的临时文件**
   - 删除临时校验目录 `artifacts/tidy-verify/<nodeId-clean>/`，含 `before.png`、`after.png`、`after-clean.png`、各阶段快照与 `diff.png`。
   - 确认目录已不存在（`Test-Path` 返回 `False`）。`artifacts/` 虽被 `.gitignore` 忽略，但仍属本次任务产出的临时物，不要留在仓库里。
   - 若本次创建过任何临时副本画框、临时校验节点或临时锁/显隐状态，一并复原或删除。

4. **只把结论写进回复**
   - 临时图已删，最终报告直接写数字：尺寸、`max_abs_diff = 0`、`changed_pixels = 0`、备份已删除、临时目录已清理。
   - 若用户在整理过程中明确要求保留证据图，本步 3 改为「把 `before/after/diff` 移到用户指定目录并说明路径」，其余步骤不变。

---

## 常见误区自检清单（提交前必核）

- [ ] 是否在动手**之前**就完成了整画框备份（`_备份_` 前缀 + 隐藏 + 锁定），并全程保留了 `backupId`？
- [ ] 是否存在非合并意图的图层名以 `*` 开头？（会导致整个图层被栅格化）
- [ ] 是否为所有使用非默认混合模式的图层在名称末尾加上了 `（混合模式名）`？（如 `装饰1（柔光）`）
- [ ] 是否误展开了 `opacity < 1`、`blendMode !== 'PASS_THROUGH'`、带 `effects`、或 `clipsContent: true` 的容器？
- [ ] 是否在 Auto Layout 容器内直接 `ungroup`/`reorder` 而导致子图层漂移？
- [ ] 是否给需要单独动效的文字/图标加了 `*` 或把它们留在了带 `LAYER_BLUR`/`INNER_SHADOW` 的父组内？
- [ ] 是否存在单节点多个可见 `IMAGE` 填充未处理？（F2A 只读取第一张）
- [ ] `compare_pixels.py` 是否明确返回 `passed: true` 且 `max_abs_diff == 0`？
- [ ] 是否只在门禁通过**之后**才删除备份，并复核了删除备份后仍为 0 差异？
- [ ] 临时校验目录是否已删除干净，没有把 `before/after/diff` 留在 `artifacts/` 里？
