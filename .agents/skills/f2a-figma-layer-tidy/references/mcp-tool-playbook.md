# F2A MCP 图层整理工具手册

F2A 内置了上游 Talk-to-Figma 工具、F2A 自研批量图层整理工具（`mcp/src/layer-tools.ts`）以及 Figwright 完整设计读写工具（`mcp/src/figwright-catalog.ts`）。执行图层整理时请遵循本手册的工具优先级与安全用法。

---

## 1. 会话连接与前置确认

1. `get_f2a_status`：查看当前打开并连接 MCP 中继的 Figma 文档。
2. `join_channel`：仅当同时打开多个文档时，按会话 ID、fileKey 或唯一文档名选定目标。
3. `get_selection`：获取用户当前选中的节点列表。所有破坏性整理只围绕用户指定或选中的根节点子树开展，不跨出目标范围乱改其它画板。

---

## 2. 基准采图与像素对比（硬门禁必备）

### 首选（完整 F2A MCP）：
- `save_screenshots`：将完整 `PNG`（`scale: 1`，必要时另存 `scale: 2`）直接写入本地校验目录（无视觉模型分辨率缩放失真，最适合逐像素比对）。
  ```json
  {
    "nodeIds": ["123:456"],
    "outDir": "D:/Tools/F2A/artifacts/tidy-verify/123-456-before",
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
只有当 `passed == true` 且 `max_abs_diff == 0` 时，才允许认定视觉无变化。

---

## 3. 只读扫描与属性诊断

| 目标 | 首选工具 | 降级工具（基础版） | 说明 |
| --- | --- | --- | --- |
| 获取整棵树结构、布局、填充、描边、效果、混合模式 | `get_design_context` | `get_node_info` / `get_nodes_info` | 大画框先传 `detail: "compact"` 或拿 `sectionPlan`，再分段读 `detail: "full"` |
| 按名称/类型快速定位垃圾命名、隐藏层、实例、TEXT | `search_nodes` | `scan_nodes_by_types` + `scan_text_nodes` | `search_nodes` 返回 `{id, name, type, depth, parentId, visible, locked}`，省大量 token |
| 检查缺失字体或字体列表 | `get_fonts` | `get_node_info` | 排查可编辑文字导出风险 |
| 读取精确矢量网络（检查多 region、路径） | `get_vector` | `get_node_info` | 排查复杂矢量或镂空布尔 |

---

## 4. 安全编辑工具与批处理规范

### 核心图层整理工具（F2A 专用）

1. **`detach_instances`（实例分离）**：
   - `nodeIds`: 实例 ID 数组；`recursive: true`（默认，从外向内递归分离）。
   - **关键**：分离后实例和所有子孙节点 ID 都会变成新 ID！必须使用返回的 `detached: [{nodeId, newId}]` 或对 `newId` 重新 `search_nodes` / `get_design_context`。
2. **`ungroup_nodes`（解散组）**：
   - 仅用于安全可展开的 `GROUP`（非实例、无裁剪、无特效、无混合隔离、非 Auto Layout、无蒙版边界冲突）。子层会被提升到原父级并保持视觉坐标。
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
   - 传 `renames: [{nodeId, name}]`，一次性清理所有自动命名及添加经确认的 `*` 前缀。
8. **`set_visible` / `set_locked`**：
   - 批量设置显隐或锁定静态底图。
9. **`batch`（顺序批处理）**：
   - 可将多条写指令打包在一次往返中执行，支持用 `"$N"` 引用第 N 条指令创建的节点 ID。
   - **安全警告**：`batch` **没有自动回滚**（`rolledBack: false`）。把“结构重排/删节点”与“批量改名”分批执行；每完成一个高风险结构阶段，建议立刻做一次快速截图或 `save_screenshots` + `compare_pixels.py` 校验，发现异常马上撤销。

### 矢量与精细属性工具（Figwright，按需慎用）

- `outline_stroke`：仅在散点/复杂笔刷描边无法被 F2A 自动轮廓化时使用；执行后注意原节点仍保留，确认描边轮廓视觉一致后再决定删除原描边或原节点。
- `flatten_nodes`：不可逆，会丢失文字编辑性与布尔结构，**绝不用于可动层或带渐变/多色/特效的层**，仅限纯静态单色碎矢量合并，且必须通过像素对比。
- `set_layout_props` / `set_mask` / `set_fills` / `set_effects` / `delete_nodes`：用于抽离容器背景（如把容器的 `GLASS` / `BACKGROUND_BLUR` 移到新建独立底层 `*bg` 矩形上，再清空容器自身的 `fills` 和 `effects`）。
