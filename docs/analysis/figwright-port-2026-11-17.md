# Figwright 移植记录

2026-11-17。来源为 [awdr74100/figwright](https://github.com/awdr74100/figwright)，
0.7.0，提交 `031df6a01e103c7adcc01e63d6d8aab0990001e8`，MIT 许可。

F2A 从 56 个 MCP 工具扩展到 165 个，新增 109 个：20 个读取、85 个写入、4 个本地文件导出。
原有工具的参数格式保留。六个同名增强工具的映射和使用方法见 [MCP 文档](../../mcp/README.md)。

直接移植上游工具 schema、Figma API handler、序列化、设计树去重、协作遍历、文件保存和
图片路径读取代码。273 个依赖源码文件及 SHA-256 存在 `mcp/vendor/figwright/UPSTREAM.json`。
F2A 适配集中在 `mcp/src/figwright-*.ts`；上游源码保持原样。

实现要点：

- 使用 F2A 现有中继和固定文档选择；继续与导出互斥。
- 文件导出经由 F2A 的 JSON 链路传输 base64，再交给上游文件写入器落盘。
- 新写命令加入现有 `batch`，可与旧命令混用；`$N` 增加样式、变量、集合及模式 ID。
  保持原有顺序执行和失败不自动回滚的约定。
- 每次 MCP 写调用关闭一个 Figma 撤销步骤，批处理的全部写入归为同一步。
- 长读取通过面板消息让出主线程，恢复时报告进度，避免计时器在后台标签页被限速。
- 构建同时更新 `mcp/server.cjs` 和 `figma-plugin/code.js`，收集 Node 与插件依赖许可；
  固定构建工作目录，支持从仓库根目录或 `mcp` 目录执行。

未移植独立 UI、中继、选主、msgpack、网页代码扫描及项目组件/Token/Icon 映射和 design-diff 存储。
这些部分依赖 Figwright 的独立运行方式或网站代码生成流程。Motion/视频工具在 Figma API 支持时使用，
此次没有添加 Motion 到 AE 关键帧的转换。

验证通过：

- `node scripts/build-mcp.cjs`。
- `tests/mcp.cjs`、`mcp-start.cjs`、`mcp-layer.cjs`、`mcp-figwright.cjs`：实际打包后的 stdio 服务、
  HTTP/WebSocket 中继、真实 F2A iframe 脚本和嵌入命令，配合模拟 Figma API；包括无 node_modules 的迁移目录。
- 新增链路覆盖完整设计上下文、渐变/效果/布局、样式、变量/绑定、混合批处理与撤销、矢量读写、
  本地图片导入、原始图片去重保存、截图、PDF/视频字节保存、参数与操作错误、协作读取消息往返。
  PDF/视频编码由测试替身返回，未实际调用 Figma 编码器。
- `export-options.cjs`、`export-fidelity.cjs`、`figma-node-api.cjs`、`layer-tools.cjs`、
  `direct-aep-ui.cjs`、`export-copy.cjs`：现有导出与面板回归通过。

当前在线 MCP 状态返回 `sessions:[]`，没有打开中的 F2A 文档。本次没有真实 Figma 画布或
After Effects 导出验收。重新运行 Figma 中的 F2A 并重连 MCP 后才能加载新增工具。
