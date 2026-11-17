# F2A MCP

F2A 内置 [Cursor Talk to Figma MCP](https://github.com/grab/cursor-talk-to-figma-mcp)
的工具和 Figma 命令。打开 Figma 中的 F2A，agent 即可读写当前文档；不需要另开
Cursor MCP 插件、启动 Bun 服务或复制频道。

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
中检查 `f2a` 的连接；连接后提供 56 个工具。需要 F2A 时，请 agent 使用 `f2a` 服务。

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

分发包可将 `command` 指向随包提供的 `runtime/node/node.exe`，无需安装依赖或联网。

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

本地中继只监听 `127.0.0.1:7367`。agent 调用工具或打开 AE 的 F2A 面板时自动启动，
没有插件连接和请求后空闲一分钟退出。Figma 插件自动重连。原 AE 导入和 AEP 导出
继续使用 7365 / 7366。上游源码、版本和 MIT 许可见 `vendor/cursor-talk-to-figma-mcp`。

## 开发

```powershell
cd D:\Tools\F2A\mcp
npm ci --ignore-scripts
npm run build
npm test
```

`server.cjs`、`relay.cjs` 和嵌入 `figma-plugin/code.js` 的命令代码均已提交，运行时
不依赖 `node_modules`。构建保留上游工具，替换传输与连接管理，不加载上游独立 UI 和分析统计。
`THIRD_PARTY_LICENSES.txt` 保留打包依赖的许可证。
