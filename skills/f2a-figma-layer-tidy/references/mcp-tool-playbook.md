# F2A MCP 图层整理工具手册

F2A 内置了上游 Talk-to-Figma 工具、F2A 自研批量图层整理工具（`mcp/src/layer-tools.ts`）以及 Figwright 完整设计读写工具（`mcp/src/figwright-catalog.ts`）。执行图层整理时请遵循本手册的工具优先级与安全用法。

---

## 1. 会话连接与前置确认

1. `get_f2a_status`：查看当前打开并连接 MCP 中继的 Figma 文档。
2. `join_channel`：仅当同时打开多个文档时，按会话 ID、fileKey 或唯一文档名选定目标。
3. `get_selection`：获取当前选中的节点列表。已有选区就锁定它；**若用户未选中，先引导用户选中目标画框再继续**（说明需要哪个层级的画框，列出候选并等确认），等待期间只做只读准备，不要自行猜测目标就动手改造。所有破坏性整理只围绕该根节点子树开展，不跨出目标范围乱改其它画板。

---

## 1.5 整画框备份（动手前必做，Step 6 才删）

**目的**：给整次整理留一个可一键还原的隐藏副本，避免误操作无法回退。

```text
# 1) 复制整个画框，偏移到原稿右侧 200px，避免重叠
clone_node({ nodeId: rootId, x: root.x + root.width + 200, y: root.y })  -> backupId

# 2) 改名（不得以 * 开头，否则会被 F2A 当作强制合图标记）
batch_rename_nodes([{ nodeId: backupId, name: "_备份_" + 原名 + "_" + yyyyMMdd-HHmmss }])

# 3) 隐藏 + 锁定
set_visible({ nodeIds: [backupId], visible: false })
set_locked({ nodeIds: [backupId], locked: true })
```

关键约束：

- **`backupId` 必须全程保留**，只有 Step 5 像素门禁 `max_abs_diff == 0` 通过后才能在 Step 6 删除。
- 备份是**页面级兄弟节点**，不在 `rootId` 的导出范围内，因此不会污染 `before.png` / `after.png`。
- 备份存在期间，**所有扫描/搜索都必须带 `root: rootId`**；禁止整页 `search_nodes` 或整页清理，否则可能把备份算进范围或被隐藏层清理规则误删。
- 回退方式：`set_locked(false)` + `set_visible(true)` 把备份还原为可见画框，即可与整理后的画框对照或整稿替换。
- 降级环境没有 `clone_node` 时，用 `create_frame` + `set_parent` 手动搬入，但仍必须完成“复制 + `_备份_` 改名 + 隐藏 + 锁定”四件事。

---

## 2. 基准采图与像素对比（硬门禁必备）

### 首选（完整 F2A MCP）：
- `save_screenshots`：将完整 `PNG`（`scale: 1`，必要时另存 `scale: 2`）直接写入本地校验目录（无视觉模型分辨率缩放失真，最适合逐像素比对）。`outDir` 不要写死本机绝对路径；同时注意**相对的 `outDir` 是相对 MCP server 进程的工作目录**，可能与你的 shell 目录不同，因此**以返回的 `saved[].path` 绝对路径为准**去跑后续比对：
  ```json
  {
    "nodeIds": ["123:456"],
    "outDir": "artifacts/tidy-verify/123-456-before",
    "format": "PNG",
    "scale": 1
  }
  ```
- `get_screenshot`：在需要人工/模型直视设计稿外观时使用，直接返回图像块。

### 降级方案（当会话未加载 `save_screenshots` 时）：
- 调用 `export_node_as_image`（`format: "PNG", scale: 1`），将返回的图像字节/base64 保存为 `before.png` / `after.png` 后再跑对比脚本。

### 运行确定性像素校验：
```powershell
python "<SKILL_DIR>/scripts/compare_pixels.py" "<dir>/before.png" "<dir>/after.png" --diff "<dir>/diff.png"
```
其中 `<SKILL_DIR>` 指 skill 根目录（本手册同级 `SKILL.md` 所在目录），执行前替换为实际路径；`python` 环境需装好 `numpy` 与 `Pillow`。

只有当 `passed == true` 且 `max_abs_diff == 0` 时，才允许认定视觉无变化。

---

## 3. 只读扫描与属性诊断

| 目标 | 首选工具 | 降级工具（基础版） | 说明 |
| --- | --- | --- | --- |
| 获取整棵树结构、布局、填充、描边、效果、混合模式 | `get_design_context` | `get_node_info` / `get_nodes_info` | 大画框先传 `detail: "compact"` 或拿 `sectionPlan`，再分段读 `detail: "full"` |
| 按名称/类型快速定位垃圾命名、隐藏层、实例、TEXT | `search_nodes` | `scan_nodes_by_types` + `scan_text_nodes` | `search_nodes` 为子串匹配并返 `{id, name, type, depth, parentId, visible, locked}`；查 `*` 标记时务必再按 `name.startsWith('*')` 过滤，避免误抓 `sam*ple@163.com` 这类中间带星号的文本 |
| 检查缺失字体或字体列表 | `get_fonts` | `get_node_info` | 排查可编辑文字导出风险 |
| 读取精确矢量网络（检查多 region、路径） | `get_vector` | `get_node_info` | 排查复杂矢量或镂空布尔 |

---

## 4. 安全编辑工具与批处理规范

### 核心图层整理工具（F2A 专用）

1. **`detach_instances`（自动全部分离实例）**：
   - 整理阶段默认**对目标范围内的全部 `INSTANCE` 自动全部分离**：先用 `search_nodes(type: "INSTANCE", root: rootId)` 找到最外层实例（如果 `rootId` 自身也是 `INSTANCE`，先单独分离它并更新 `rootId = newId`），再传 `nodeIds` 并开启 `recursive: true`（默认，从外向内递归分离）。
   - **关键**：分离后实例和所有子孙节点 ID 都会变成新 ID！必须使用返回的 `detached: [{nodeId, newId}]` 更新 `rootId`（若根节点被分离），并在分离完成后重新执行 `search_nodes` / `get_design_context` 获取最新节点树。
   - **降级方案**：若当前环境无 `detach_instances`，可调用 `detach_instance` 逐个由外向内分离。
2. **`ungroup_nodes`（解散组）**：
   - 仅用于安全可展开的 `GROUP`（非实例、无裁剪、无特效、无混合隔离、非 Auto Layout、无蒙版边界冲突）。子层会被提升到原父级并保持视觉坐标。
   - **返回值去重**：一次性传入多层嵌套组（如由内向外依次解包 3 层空组）时，`affected` 会按每次解包重复列出晋升的子节点 ID；统计影响图层数或继续处理前必须先去重。
3. **`reparent_nodes`（批量改父级）**：
   - 始终默认 `keepPosition: true`（保持画布绝对坐标不变）。
   - 支持传 `index` 精确控制新父级内的 Z 序位置。
   - 展开无视觉作用的空 `FRAME` 时：先用 `reparent_nodes` 把子节点按原次序移至祖父级，校验无误后再删除空壳 `FRAME`。
4. **`group_nodes`（成组）**：
   - 仅限**同一个父级下的兄弟节点**；非同父级先用 `reparent_nodes` 移到一起。
   - 不能在 Auto Layout 容器内直接成组；如确需成组，先评估 Auto Layout 影响或用 `create_frame` + `set_clips_content(false)` + `set_layout_props`。
5. **`reorder_nodes`（调整 Z 序）**：
   - `index` 为 0-based（`0` = 最底层）。
   - **禁止**改变有像素交集图层之间的前后遮挡顺序！
6. **`set_clips_content`（开关裁剪）**：
   - 新建 `FRAME` 默认 `clipsContent: true`。作为逻辑容器使用时关闭；原本用来裁剪溢出内容（且确实有内容超出边界）的 `FRAME` 严禁关闭。
7. **`batch_rename_nodes`（批量改名）**：
   - 传 `renames: [{nodeId, name}]`，一次性清理所有自动命名，并按 Step 3 决策树自行判定的 `*` 前缀。
8. **`set_visible` / `set_locked`**：
   - 批量设置显隐或锁定静态底图。
9. **`batch`（顺序批处理）**：
   - 可将多条写指令打包在一次往返中执行，支持用 `"$N"` 引用第 N 条指令创建的节点 ID。
   - **安全警告**：`batch` **没有自动回滚**（`rolledBack: false`）。把“结构重排/删节点”与“批量改名”分批执行；每完成一个高风险结构阶段，建议立刻做一次快速截图或 `save_screenshots` + `compare_pixels.py` 校验，发现异常马上撤销。

### 矢量与精细属性工具（Figwright，按需慎用）

- `outline_stroke`：仅在散点/复杂笔刷描边无法被 F2A 自动轮廓化时使用；执行后注意原节点仍保留，确认描边轮廓视觉一致后再决定删除原描边或原节点。
- `flatten_nodes`：不可逆，会丢失文字编辑性与布尔结构，**绝不用于可动层或带渐变/多色/特效的层**，仅限纯静态单色碎矢量合并，且必须通过像素对比。
- `set_layout_props` / `set_mask` / `set_fills` / `set_effects` / `delete_nodes`：用于抽离容器背景（如把容器的 `GLASS` / `BACKGROUND_BLUR` 移到新建独立底层 `*bg` 矩形上，再清空容器自身的 `fills` 和 `effects`）。

---

## 5. 收尾清理（Step 6，门禁通过后才执行）

1. **删备份**：`delete_nodes({ nodeIds: [backupId] })`，随后 `search_nodes({ name: "_备份_" })` 确认无残留。
2. **复查**：再导 `after-clean.png` 与 `after.png` 比对，必须仍为 `max_abs_diff == 0`。
3. **清临时文件**：删除 `artifacts/tidy-verify/<nodeId-clean>/` 整个目录（`before.png`、`after.png`、`after-clean.png`、阶段快照、`diff.png`），用 `Test-Path` 确认已不存在。
4. **复原临时状态**：本次为比对而临时加过的锁/显隐/临时画框一并复原或删除。

> 校验未通过时**不要**执行本节任何一步，保留备份以便回退。
