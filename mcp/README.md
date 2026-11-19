# F2A MCP

打开 Figma 中的 F2A，agent 即可读写当前文档、导出选区，并通过同一个 `f2a` MCP 在 After Effects 中制作动画。 [Cursor Talk to Figma MCP](https://github.com/grab/cursor-talk-to-figma-mcp) · [Figwright](https://github.com/awdr74100/figwright) · [Surehand v1.4.1](https://github.com/ConformLabs/surehand-mcp/releases/tag/v1.4.1) · [AE Motion v2.26.0](https://github.com/dha-aa/ae-motion/tree/42e14e8350473ea4b246f0b4aa20f250fe168dd6)

## 本机配置

首次在 Codex 中配置一次：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Tools\F2A\scripts\install-mcp.ps1
```

配置后重连 MCP 或重新启动 Codex。F2A 单独注册为 `f2a`，已有 `figma` 和其他 MCP
保持不变；配置备份保存在 Codex 配置目录的 `backups/f2a`。后续只需打开 Figma 中的
F2A，看到“MCP 已就绪”后即可调用工具。MCP 本身不要求启动 After Effects。

DSH Desktop 使用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Tools\F2A\scripts\install-mcp.ps1 -Client DshDesktop
```

使用本机已有的 `dsh-skill-mcp-panel` 管理模块，在 desktop profile 中单独添加 `f2a`
入口；已有 `figma` 和其他 MCP 保持不变。原配置备份到 DSH 目录的
`backups/f2a`，支持 `DSH_HOME`。DSH 在线时由现有配置监听热加载，可在“Skill / MCP”
中检查 `f2a` 的连接。需要 F2A 时，请 agent 使用 `f2a` 服务。

其他支持 stdio 的 MCP 客户端可使用：

```json
{
  "mcpServers": {
    "f2a": {
      "command": "node",
      "args": ["D:/Tools/F2A/mcp/server.cjs"]
    }
  }
}
```

Windows 分发包使用本机的 Node.js 20+，MCP 依赖已打包。

## 从 Figma 选区制作和导出动画

更新 F2A 后重连 `f2a`。首次调用 `ae_status` 会安装随包提供的 Surehand 扩展。按提示重启 AE 后再次调用。开着多个 AE 实例时，可用 `ae_status` 的 `instance` 参数选择目标版本或桥接端口。

1. 在 Figma 打开 F2A 并选中画框或图层。调用 `export_aep`，传入 `.aep` 的绝对路径 `destination`。F2A 会创建同名目录，附带 `Assets` 和 `report.json`。遇到同名目录时自动编号。工具沿用面板设置，可用 `textMode` 和 `aeVersion` 指定文字模式和工程版本。
2. 将返回的 `project` 路径交给 `ae_open_project`，用 `compositionId` 查看主合成的图层。通过 `ae_get_comp_info` 查看预合成图层的 `source.id`，可继续查找其中的文字、形状和素材层。已有的 AE 工程可用 `ae_list_comps` 查找合成 ID。
3. 用下面的工具添加动画，并通过 `ae_render_frame` 预览。对于逐字动画，在导出时指定 `textMode: "editable"`，并确认目标在 AE 中是原生文字层。
4. 用 `ae_save_project` 保存可编辑的 AEP。调用 `ae_render_mp4`，传入主合成 ID、MP4 路径和帧范围。省略帧范围时使用工作区。工具使用本机 H.264 模板，可用 `ae_render_jobs` 查看进度。

F2A 会把生成的 AEP 文件名中的半角 `%` 替换为 `_`。通过 MCP 打开或另存 AEP 时，请选择各级目录名均不含半角 `%` 的路径。

| 工具 | 动效 |
| --- | --- |
| `ae_animate` | 淡入淡出、缩放弹出、滑入滑出、下落、旋转、缓慢推近或漂移 |
| `ae_stagger` | 按顺序错开多个图层已有的关键帧，保留插值和空间切线 |
| `ae_text_reveal` | 按字、词或行揭示文字，可用打字机、淡入、位移等样式 |
| `ae_transition` | 擦除、多条遮挡或圆形开合转场，生成 AE 形状层 |

可以对 agent 说：“用 F2A 把当前选区导出到 `D:/Exports/启动页.aep`，让标题逐字上浮、卡片依次弹入。预览后保存可编辑的 AEP，再输出一段 2 秒的 H.264 MP4。”

用 `ae_tools` 查找更多 Surehand 工具，例如文字动画器、交付预检和像素比对，用 `ae_call` 调用。

## 复用手调动效

在 AE 中选中参考图层。已有动效可以直接用 `ae_motion_save` 保存。如果要带着 agent 手调，先用 `ae_motion_record`，调完将 `recording_id` 传给 `ae_motion_save`。F2A 比较前后两次状态，只保存改过的轨道。 [Mark Watch](https://github.com/transversal-tools/mark-ae/blob/c73ed4ee8d74f48cd3da7b235018cbb30764af31/docs/TOOLS.md#watch-mode)

用 `ae_motion_list` 按名称或标签找配方，再用 `ae_motion_apply` 套到当前选区或传入 `layer_ids`。多层配方按库里显示的顺序匹配图层，单层配方可一次套到多个图层。默认从播放头开始，保留目标图层的落点，记录的静态位移按相对距离应用。可以用 `time_scale` 改时长，用 `position_anchor` 改对齐方式。目标属性已含动画时，确认要替换后传 `replace: true`。

配方保留可编辑的关键帧、缓动、空间切线及表达式。目标需要有相应的效果、路径或文字动画器，表达式引用的图层和控制器也需要存在。只想复用变换时可在采集时传 `scope: "transform"`。

配方保存在 `%LOCALAPPDATA%/F2A/motion-library`。保存结果和库列表会返回配方 JSON 路径，另一台机器可用 `ae_motion_import` 导入。 [JUNKDOGE Tool Library](https://github.com/JUNKDOGE-JOE/after-effects-mcp/blob/10b0154ca64f5ed15096b367f160129ee9ffe503/docs/TOOL_LIBRARY.md)

## 使用

- 只有一个 F2A 文档时，`get_selection`、`get_document_info`、`create_frame`、
  `create_text` 等工具自动连接。
- `get_f2a_status` 列出打开的 F2A 文档。多个文档同时打开时，用
  `join_channel({"channel":"文档 ID"})` 选择目标；也可使用文件 key 或唯一文档名称。
- 文档关闭后，原 agent 的目标保持固定并提示断开；重开后用 `join_channel` 重新选择。
- MCP 操作与导出互斥。命令按顺序执行，进度消息延长操作等待时间，关闭文档立即结束等待。

## 图层整理

上游工具只能逐节点改名、逐节点改父子关系，做不了整页整理。F2A 另外提供 11 个工具，
实现在 `src/layer-commands.js`（随插件打包）和 `src/layer-tools.ts`（MCP 侧）：

- `search_nodes`：按名称片段和/或类型在整页或子树里找图层，返回 id、深度和父级，
  用来批量收集待整理对象，不必逐层拉 `get_node_info`。
- `batch_rename_nodes`：一次改多个名字，清理 `Frame 1321318046` 这类自动命名。
- `group_nodes` / `ungroup_nodes`：成组与解散。组不带裁剪，需要保留溢出和投影时用组，
  需要裁剪或自动布局时用 `create_frame` + `reparent_nodes` + `set_clips_content`。
- `reorder_nodes`：改层内叠放顺序；`reparent_nodes`：批量移入新父级，默认保持画布位置。
- `set_visible` / `set_locked`：显隐与锁定，批量生效，可逆。
- `set_clips_content`：开关 Frame 的裁剪。新建 Frame 默认裁剪，当分组容器用时要关掉。
- `detach_instances`：把组件实例分离成普通 Frame，面板「图层工具 → 分离实例」的 MCP 版本。
  实例内部图层在分离前不能改名、锁定或移出，所以整理组件副本内部前先分离；递归默认开，
  分离后实例 id 和整棵子树的 id 都会变，用返回的 `newId`。实例套实例时先分离外层，
  直接分离内层会作为错误返回。
- `batch`：一次调用顺序执行多条写命令，`"$N"` 表示第 N 条命令创建的节点 id。

`batch` 没有回滚：Figma 插件 API 没有事务，失败时已生效的命令保持生效，返回值里
`rolledBack:false` 并逐条列出结果和 `failedIndex`。需要一次性回退时用 Figma 自己的撤销。
插件代码随 `figma-plugin/code.js` 更新，改完需在 Figma 里重新运行 F2A 才会加载新命令。

## Figwright 能力

移植自 Figwright 0.7.0，增加 109 个工具，复用 F2A 的连接、文档选择和批处理。

| 用途 | 主要工具 |
| --- | --- |
| 设计数据 | `get_design_context`、`get_node`、`get_document`、`get_metadata`、`get_pages` |
| 矢量与外观 | `create_vector`、`get_vector`、`set_vector`、`boolean_nodes`、`set_fills`、`set_strokes`、`set_effects` |
| 布局 | `set_auto_layout`、`set_layout_props`、`set_layout_grids`、`align_nodes`、`set_constraints` |
| 样式与变量 | 创建、修改、导入样式和变量，设置模式，绑定图层、填充和渐变 |
| 组件与页面 | 组件属性、变体、实例替换，页面创建、重命名和切换 |
| 原型与动画 | 原型交互、Motion 预设、关键帧、时间线时长 |
| 素材 | `import_image`、`import_svg`、`get_screenshot`、`save_screenshots`、`save_image_fills`、`export_pdf`、`export_video` |

`get_design_context` 默认读取完整样式、布局、文字和组件覆盖；可用 `detail:"compact"`
只查看结构。多次出现的组件会去重，大树返回分段列表。新工具的节点 ID 支持粘贴 Figma 链接。
`save_image_fills` 保存原始图片，`save_screenshots` 保存渲染结果；`import_image` 支持本地 `path`。
Motion 和视频导出取决于当前 Figma 提供的动画 API；动画暂不转换成 AE 关键帧。

已有同名工具保留原有参数；Figwright 的增强版本使用这些名称：

| Figwright 原名 | F2A 中的名称 |
| --- | --- |
| `get_styles` | `get_design_styles` |
| `get_local_components` | `get_design_components` |
| `get_annotations` | `get_design_annotations` |
| `get_reactions` | `get_prototype_reactions` |
| `get_nodes_info` | `get_design_nodes` |
| `set_image_fill` | `set_design_image_fill` |

新写命令也可放进 `batch`，与原有命令混用。`$N` 除节点 ID 外，也可引用之前创建的
样式、变量和集合 ID。一次 MCP 写调用或一次批处理对应一个 Figma 撤销步骤；批处理仍按顺序
执行，失败保留已完成的操作并返回 `rolledBack:false`。批处理中的本地图片在发往 Figma 前读取。

更新后，在 Figma 里重新运行 F2A，并重连 MCP，工具列表才会刷新。

本地中继只监听 `127.0.0.1:7367`。agent 调用工具或打开 AE 的 F2A 面板时自动启动，
没有插件连接和请求后空闲一分钟退出。Figma 插件自动重连。原 AE 导入和 AEP 导出
继续使用 7365 / 7366。上游源码、版本和 MIT 许可见 `vendor/cursor-talk-to-figma-mcp`
和 `vendor/figwright`。

## 开发

运行 MCP 测试前，按 F2A 安装流程准备 AEP 导出的 Python 依赖。

```powershell
cd D:\Tools\F2A\mcp
npm ci --ignore-scripts
npm run build
npm test
```

`server.cjs`、`relay.cjs` 和嵌入 `figma-plugin/code.js` 的命令代码均已提交，运行时
不依赖 `node_modules`。构建复用上游工具与命令，使用 F2A 的传输与面板。
`vendor/surehand` 包含基于 Surehand v1.4.1 构建的服务文件、工具清单和许可证。`f2a-unicode.patch` 修正 CEP 的 Unicode 传输，`f2a-paths.patch` 处理 AEP 打开、另存和 MP4 渲染的路径编码。清单记录上游提交和 SHA-256，构建时会校验服务文件。
`vendor/ae-motion` 保存 AE Motion v2.26.0 的预设代码和 MIT 许可证。预设通过 Surehand 执行。
手调动效复用参考 Mark v0.3.0 的图层捕获和 JUNKDOGE v0.11.1 的工具库。对应许可证存放在 `vendor/mark-ae` 和 `vendor/junkdoge`。
`THIRD_PARTY_LICENSES.txt` 保留打包依赖的许可证。
